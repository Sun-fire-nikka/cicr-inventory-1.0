// Supabase → Neon replication, pending-change queue and reconciliation (v1.0.0).
//
// This is REAL snapshot replication: rows are read from Supabase (PostgREST)
// and written to Neon with parameterized SQL (INSERT ... ON CONFLICT (id) DO UPDATE).
// It is NOT native logical replication and does NOT use a generic exec_sql RPC.
//
// Guarantees / limitations:
//   - Conflict handling is LAST-WRITE-WINS by primary key (`id`).
//   - Concurrent conflicting writes to the same row on both sides during an
//     outage are NOT merged (no multi-master resolution).
//   - Only the tables in SUPABASE_REPLICATED_TABLES participate.
//
// No row values, passwords, tokens or credentials are ever logged here.
import crypto from 'crypto';
import { getSupabaseAdmin } from './supabasePool';
import { queryRead, queryWrite } from './neonPool';
import { redisClient, acquireLock, releaseLock } from './redis';
import { SUPABASE_REPLICATED_TABLES } from './databaseRouter';
import { getDbHealthSnapshot, setRecovering, setSupabaseHealthy, isPrimaryAvailable } from './dbHealth';
import { QueryFilter } from './databaseTypes';

// ------------------------------------------------------------ types
export type ReplicatedOperation = 'insert' | 'update' | 'delete';

export interface PendingChange {
  id: string;
  table: string;
  operation: ReplicatedOperation;
  row?: Record<string, unknown>;
  updates?: Record<string, unknown>;
  filters: QueryFilter[];
  createdAt: string;
}

export interface EnqueueInput {
  table: string;
  operation: ReplicatedOperation;
  row?: Record<string, unknown>;
  updates?: Record<string, unknown>;
  filters?: QueryFilter[];
}

export interface TableSyncResult {
  table: string;
  sourceCount: number;
  destinationCount: number;
  inserted: number;
  updated: number;
  deleted: number;
  timestamp: string;
  error?: string;
}

export interface SyncReport {
  startedAt: string;
  finishedAt: string;
  lastSyncAt: string | null;
  tables: TableSyncResult[];
  errors: string[];
}

export interface ReconcileReport {
  applied: number;
  failed: number;
  remaining: number;
  errors: string[];
  reconciledAt: string;
}

// ------------------------------------------------------------ SQL safety
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT_RE.test(name)) {
    throw new Error(`Unsafe SQL identifier rejected: ${name}`);
  }
  return `"${name}"`;
}

// ------------------------------------------------------------ source read (Supabase)
async function fetchAllFromSupabase(table: string): Promise<Record<string, unknown>[]> {
  const sb = getSupabaseAdmin();
  if (!sb) throw new Error('Supabase not configured');

  const pageSize = 1000;
  const rows: Record<string, unknown>[] = [];
  let from = 0;

  for (;;) {
    const { data, error } = await sb.from(table).select('*').range(from, from + pageSize - 1);
    if (error) throw new Error(`Supabase read failed for ${table}: ${error.message}`);
    const batch = (data || []) as Record<string, unknown>[];
    rows.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

// ------------------------------------------------------------ destination write (Neon)
const neonColumnCache: Record<string, Set<string>> = {};

async function getNeonColumns(table: string): Promise<Set<string>> {
  if (neonColumnCache[table]) return neonColumnCache[table];
  const result = await queryRead(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  const set: Set<string> = new Set<string>((result.rows || []).map((r: any) => String(r.column_name)));
  neonColumnCache[table] = set;
  return set;
}

/**
 * Upsert rows into Neon using parameterized SQL. Idempotent by primary key `id`.
 * Returns how many rows were inserted vs updated (via xmax = 0).
 */
export async function upsertRowsToNeon(
  table: string,
  rows: Record<string, unknown>[],
): Promise<{ inserted: number; updated: number }> {
  if (!rows.length) return { inserted: 0, updated: 0 };

  const neonColumns = await getNeonColumns(table);
  const allColumns = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const columns = allColumns.filter((c) => neonColumns.has(c));

  if (!columns.includes('id')) {
    throw new Error(`Replication requires an "id" column on ${table}`);
  }

  const nonId = columns.filter((c) => c !== 'id');
  const CHUNK = 200;
  let inserted = 0;
  let updated = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const tuples: string[] = [];

    for (const row of chunk) {
      const placeholders = columns.map((c) => {
        values.push(row[c] === undefined ? null : row[c]);
        return `$${values.length}`;
      });
      tuples.push(`(${placeholders.join(', ')})`);
    }

    const conflict = nonId.length
      ? `ON CONFLICT (id) DO UPDATE SET ${nonId.map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`).join(', ')}`
      : `ON CONFLICT (id) DO NOTHING`;

    const sql =
      `INSERT INTO ${ident(table)} (${columns.map(ident).join(', ')}) ` +
      `VALUES ${tuples.join(', ')} ${conflict} RETURNING (xmax = 0) AS inserted`;

    const result = await queryWrite(sql, values);
    for (const r of result.rows) {
      if (r.inserted) inserted++;
      else updated++;
    }
  }

  return { inserted, updated };
}

// ------------------------------------------------------------ counts
export async function countNeonRows(table: string): Promise<number> {
  const result = await queryRead(`SELECT COUNT(*)::int AS n FROM ${ident(table)}`);
  return result.rows[0]?.n ?? 0;
}

export async function countSupabaseRows(table: string): Promise<number> {
  const sb = getSupabaseAdmin();
  if (!sb) return 0;
  const { count, error } = await sb.from(table).select('*', { count: 'exact', head: true });
  if (error) throw new Error(error.message);
  return count || 0;
}

// ------------------------------------------------------------ counts cache
// Avoid COUNT(*) on every status request. Counts are cached briefly (shared in
// Redis, or process-local when Redis is unavailable) and invalidated whenever
// data changes via sync/reconcile.
const COUNTS_CACHE_KEY = 'cicr:replication:counts';
const COUNTS_CACHE_TTL_MS = 15000;
let countsCacheLocal: { at: number; tables: any[] } | null = null;

export async function invalidateCountsCache(): Promise<void> {
  countsCacheLocal = null;
  if (redisClient) {
    try { await redisClient.del(COUNTS_CACHE_KEY); } catch { /* ignore */ }
  }
}

async function getTablesWithCounts(): Promise<any[]> {
  if (redisClient) {
    try {
      const raw = await redisClient.get(COUNTS_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Date.now() - parsed.at < COUNTS_CACHE_TTL_MS) return parsed.tables;
      }
    } catch { /* fall through to compute */ }
  } else if (countsCacheLocal && Date.now() - countsCacheLocal.at < COUNTS_CACHE_TTL_MS) {
    return countsCacheLocal.tables;
  }

  const tables: any[] = [];
  for (const table of SUPABASE_REPLICATED_TABLES) {
    let supabaseCount = 0;
    let neonCount = 0;
    const errs: string[] = [];
    try { supabaseCount = await countSupabaseRows(table); } catch (e: any) { errs.push(`supabase:${e?.message}`); }
    try { neonCount = await countNeonRows(table); } catch (e: any) { errs.push(`neon:${e?.message}`); }
    tables.push({
      table,
      supabaseCount,
      neonCount,
      inSync: supabaseCount === neonCount,
      error: errs.length ? errs.join(' ') : undefined,
    });
  }

  if (redisClient) {
    try {
      await redisClient.set(COUNTS_CACHE_KEY, JSON.stringify({ at: Date.now(), tables }), 'EX', Math.ceil(COUNTS_CACHE_TTL_MS / 1000));
    } catch { /* ignore */ }
  } else {
    countsCacheLocal = { at: Date.now(), tables };
  }
  return tables;
}

// ------------------------------------------------------------ snapshot sync
// Delete-propagation helper: remove Neon rows whose id no longer exists in the
// Supabase snapshot. Guarded so it ONLY runs while the primary is available and
// the pending queue is empty (never delete failover-created rows). Per-chunk
// failures are logged and skipped rather than aborting the whole sync.
async function deleteNeonRowsNotInSource(
  table: string,
  source: Record<string, unknown>[],
): Promise<number> {
  const sourceIds = new Set(source.map((r) => String(r.id)).filter(Boolean));
  const neon = await queryRead(`SELECT id FROM ${ident(table)}`);
  const toDelete = neon.rows
    .map((r: any) => String(r.id))
    .filter((id: string) => !sourceIds.has(id));

  if (!toDelete.length) return 0;

  let deleted = 0;
  const CHUNK = 500;
  for (let i = 0; i < toDelete.length; i += CHUNK) {
    const chunk = toDelete.slice(i, i + CHUNK);
    try {
      const res = await queryWrite(`DELETE FROM ${ident(table)} WHERE id = ANY($1::uuid[])`, [chunk]);
      deleted += res.rowCount ?? 0;
    } catch (err: any) {
      console.warn(`[REPLICATION] Delete propagation skipped for ${table} (${chunk.length} rows): ${err?.message}`);
    }
  }
  return deleted;
}

let lastSyncAt: string | null = null;
let syncInFlight: Promise<SyncReport> | null = null;

export const getLastSyncAt = (): string | null => lastSyncAt;

export async function syncSupabaseToNeon(): Promise<SyncReport> {
  // Collapse concurrent calls (also prevents duplicate scheduler work).
  if (syncInFlight) return syncInFlight;

  syncInFlight = (async (): Promise<SyncReport> => {
    const startedAt = new Date().toISOString();
    const tables: TableSyncResult[] = [];
    const errors: string[] = [];

    const allowDeletePropagation = isPrimaryAvailable() && (await getPendingCount()) === 0;

    for (const table of SUPABASE_REPLICATED_TABLES) {
      const timestamp = new Date().toISOString();
      try {
        const source = await fetchAllFromSupabase(table);
        const { inserted, updated } = await upsertRowsToNeon(table, source);
        let deleted = 0;
        if (allowDeletePropagation) {
          deleted = await deleteNeonRowsNotInSource(table, source);
        }
        const destinationCount = await countNeonRows(table);
        tables.push({
          table,
          sourceCount: source.length,
          destinationCount,
          inserted,
          updated,
          deleted,
          timestamp,
        });
      } catch (err: any) {
        const message = err?.message || String(err);
        errors.push(`${table}: ${message}`);
        tables.push({
          table,
          sourceCount: 0,
          destinationCount: 0,
          inserted: 0,
          updated: 0,
          deleted: 0,
          timestamp,
          error: message,
        });
      }
    }

    lastSyncAt = new Date().toISOString();
    await invalidateCountsCache();
    return { startedAt, finishedAt: lastSyncAt, lastSyncAt, tables, errors };
  })();

  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}

// ------------------------------------------------------------ pending-change queue (Redis-backed)
const QUEUE_KEY = 'cicr:replication:pending';

// In-memory fallback only when Redis is unavailable (not durable across restarts).
let memoryQueue: PendingChange[] = [];

export async function enqueuePendingChange(input: EnqueueInput): Promise<PendingChange> {
  const change: PendingChange = {
    id: crypto.randomUUID(),
    table: input.table,
    operation: input.operation,
    row: input.row,
    updates: input.updates,
    filters: input.filters || [],
    createdAt: new Date().toISOString(),
  };

  if (redisClient) {
    try {
      await redisClient.rpush(QUEUE_KEY, JSON.stringify(change));
      return change;
    } catch (err: any) {
      console.warn('[REPLICATION] Redis enqueue failed, using in-memory queue:', err?.message);
    }
  }
  memoryQueue.push(change);
  return change;
}

export async function getPendingChanges(): Promise<PendingChange[]> {
  if (redisClient) {
    try {
      const raw = await redisClient.lrange(QUEUE_KEY, 0, -1);
      return raw.map((s) => JSON.parse(s) as PendingChange);
    } catch (err: any) {
      console.warn('[REPLICATION] Redis read failed, using in-memory queue:', err?.message);
    }
  }
  return [...memoryQueue];
}

export async function getPendingCount(): Promise<number> {
  if (redisClient) {
    try {
      return await redisClient.llen(QUEUE_KEY);
    } catch (err: any) {
      console.warn('[REPLICATION] Redis llen failed, using in-memory queue:', err?.message);
    }
  }
  return memoryQueue.length;
}

async function removePendingChange(id: string): Promise<void> {
  if (redisClient) {
    try {
      const raw = await redisClient.lrange(QUEUE_KEY, 0, -1);
      for (const entry of raw) {
        try {
          if ((JSON.parse(entry) as PendingChange).id === id) {
            await redisClient.lrem(QUEUE_KEY, 1, entry);
            break;
          }
        } catch {
          /* skip malformed entry */
        }
      }
      return;
    } catch (err: any) {
      console.warn('[REPLICATION] Redis lrem failed:', err?.message);
    }
  }
  memoryQueue = memoryQueue.filter((c) => c.id !== id);
}

// ------------------------------------------------------------ WHERE builder (parameterized)
function buildWhere(filters: QueryFilter[], startIdx: number, values: unknown[]): string {
  const clauses: string[] = [];
  let idx = startIdx;

  for (const filter of filters) {
    switch (filter.type) {
      case 'eq':
        values.push(filter.value);
        clauses.push(`${ident(filter.column)} = $${idx++}`);
        break;
      case 'neq':
        values.push(filter.value);
        clauses.push(`${ident(filter.column)} != $${idx++}`);
        break;
      case 'gt':
        values.push(filter.value);
        clauses.push(`${ident(filter.column)} > $${idx++}`);
        break;
      case 'gte':
        values.push(filter.value);
        clauses.push(`${ident(filter.column)} >= $${idx++}`);
        break;
      case 'lt':
        values.push(filter.value);
        clauses.push(`${ident(filter.column)} < $${idx++}`);
        break;
      case 'lte':
        values.push(filter.value);
        clauses.push(`${ident(filter.column)} <= $${idx++}`);
        break;
      case 'ilike':
        values.push(filter.value);
        clauses.push(`${ident(filter.column)} ILIKE $${idx++}`);
        break;
      case 'in': {
        const arr = filter.value as unknown[];
        if (Array.isArray(arr) && arr.length) {
          const placeholders: string[] = [];
          for (const v of arr) {
            values.push(v);
            placeholders.push(`$${idx++}`);
          }
          clauses.push(`${ident(filter.column)} IN (${placeholders.join(', ')})`);
        }
        break;
      }
      case 'is_null':
        clauses.push(`${ident(filter.column)} IS NULL`);
        break;
      default:
        break;
    }
  }

  return clauses.join(' AND ');
}

async function applyChangeToNeon(change: PendingChange): Promise<void> {
  if (change.operation === 'insert' && change.row) {
    await upsertRowsToNeon(change.table, [change.row]);
    return;
  }

  if (change.operation === 'update') {
    const updates = change.updates || {};
    const cols = Object.keys(updates);
    if (!cols.length) return;
    const values: unknown[] = [];
    const sets = cols.map((c) => {
      values.push((updates as any)[c] === undefined ? null : (updates as any)[c]);
      return `${ident(c)} = $${values.length}`;
    });
    const where = buildWhere(change.filters, values.length + 1, values);
    const sql = `UPDATE ${ident(change.table)} SET ${sets.join(', ')}${where ? ` WHERE ${where}` : ''}`;
    await queryWrite(sql, values);
    return;
  }

  if (change.operation === 'delete') {
    const values: unknown[] = [];
    const where = buildWhere(change.filters, 1, values);
    const sql = `DELETE FROM ${ident(change.table)}${where ? ` WHERE ${where}` : ''}`;
    await queryWrite(sql, values);
  }
}

/**
 * Re-apply all queued changes to Neon (idempotent). Useful for robustness if a
 * Neon write failed during the outage window.
 */
export async function applyPendingToNeon(): Promise<{ applied: number; failed: number; errors: string[] }> {
  const changes = await getPendingChanges();
  let applied = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const change of changes) {
    try {
      await applyChangeToNeon(change);
      applied++;
    } catch (err: any) {
      failed++;
      errors.push(`${change.table}/${change.operation}: ${err?.message}`);
    }
  }
  return { applied, failed, errors };
}

// ------------------------------------------------------------ reconcile Neon → Supabase
function applyFiltersToSupabase(query: any, filters: QueryFilter[]): any {
  let q = query;
  for (const filter of filters) {
    switch (filter.type) {
      case 'eq': q = q.eq(filter.column, filter.value); break;
      case 'neq': q = q.neq(filter.column, filter.value); break;
      case 'gt': q = q.gt(filter.column, filter.value); break;
      case 'gte': q = q.gte(filter.column, filter.value); break;
      case 'lt': q = q.lt(filter.column, filter.value); break;
      case 'lte': q = q.lte(filter.column, filter.value); break;
      case 'ilike': q = q.ilike(filter.column, filter.value); break;
      case 'in': q = q.in(filter.column, filter.value as unknown[]); break;
      case 'is_null': q = q.is(filter.column, null); break;
      default: break;
    }
  }
  return q;
}

async function applyChangeToSupabase(sb: any, change: PendingChange): Promise<void> {
  if (change.operation === 'insert' && change.row) {
    const { error } = await sb.from(change.table).upsert([change.row], { onConflict: 'id' });
    if (error) throw new Error(error.message);
    return;
  }

  if (change.operation === 'update') {
    const updates = change.updates || {};
    if (!Object.keys(updates).length) return;
    let q = sb.from(change.table).update(updates);
    q = applyFiltersToSupabase(q, change.filters);
    const { error } = await q;
    if (error) throw new Error(error.message);
    return;
  }

  if (change.operation === 'delete') {
    let q = sb.from(change.table).delete();
    q = applyFiltersToSupabase(q, change.filters);
    const { error } = await q;
    if (error) throw new Error(error.message);
  }
}

/**
 * Apply pending (secondary-side) changes back to Supabase, then remove only the
 * successfully reconciled queue entries. Last-write-wins by primary key.
 */
export async function reconcileNeonToSupabase(): Promise<ReconcileReport> {
  const sb = getSupabaseAdmin();
  if (!sb) throw new Error('Supabase not configured');

  const changes = await getPendingChanges();
  let applied = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const change of changes) {
    try {
      await applyChangeToSupabase(sb, change);
      await removePendingChange(change.id);
      applied++;
    } catch (err: any) {
      failed++;
      errors.push(`${change.table}/${change.operation}: ${err?.message}`);
    }
  }

  await invalidateCountsCache();
  return {
    applied,
    failed,
    remaining: await getPendingCount(),
    errors,
    reconciledAt: new Date().toISOString(),
  };
}

// ------------------------------------------------------------ status
export async function getReplicationStatus() {
  const tables = await getTablesWithCounts();
  return {
    ...getDbHealthSnapshot(),
    replicatedTables: Array.from(SUPABASE_REPLICATED_TABLES),
    tables,
    lastSyncAt,
    pendingQueueLength: await getPendingCount(),
  };
}

// ------------------------------------------------------------ recovery
export interface RecoveryOutcome {
  success: boolean;
  skipped: boolean;
  trigger: 'auto' | 'manual';
  reason?: string;
  appliedPendingToNeon?: { applied: number; failed: number };
  reconcile?: ReconcileReport;
  sync?: SyncReport;
}

const RECOVERY_LOCK_KEY = 'cicr:replication:recovery';
const RECOVERY_LOCK_TTL_MS = 60000;

/**
 * Ordered primary-recovery sequence (shared by the health monitor and the manual
 * /failover/recover endpoint):
 *   1. acquire a cross-instance recovery lock (dedupe concurrent detections)
 *   2. mark RECOVERING so every instance keeps routing to Neon
 *   3. apply pending changes to Neon (if required)
 *   4. reconcile Neon → Supabase
 *   5. verify the queue is empty
 *   6. sync Supabase → Neon
 *   7. only NOW mark the primary healthy (routing returns to PRIMARY)
 *
 * On any reconciliation failure the primary is marked UNHEALTHY again, the queue
 * is left intact, and routing stays on SECONDARY.
 */
export async function performRecovery(trigger: 'auto' | 'manual'): Promise<RecoveryOutcome> {
  const lock = await acquireLock(RECOVERY_LOCK_KEY, RECOVERY_LOCK_TTL_MS);
  if (!lock.acquired) {
    return { success: false, skipped: true, trigger, reason: 'recovery already in progress' };
  }

  try {
    await setRecovering(true);

    const pendingBefore = await getPendingCount();
    const appliedPendingToNeon = pendingBefore > 0 ? await applyPendingToNeon() : { applied: 0, failed: 0 };

    const reconcile = await reconcileNeonToSupabase();
    if (reconcile.failed > 0 || reconcile.remaining > 0) {
      console.error(
        `[RECOVERY] Reconciliation incomplete (applied=${reconcile.applied}, failed=${reconcile.failed}, remaining=${reconcile.remaining}). ` +
        `Staying on SECONDARY; pending changes preserved.`,
      );
      await setSupabaseHealthy(false);
      return { success: false, skipped: false, trigger, reason: 'reconciliation-incomplete', appliedPendingToNeon, reconcile };
    }

    const sync = await syncSupabaseToNeon();

    const pendingAfter = await getPendingCount();
    if (pendingAfter > 0) {
      console.error(`[RECOVERY] Pending queue not empty after reconcile (${pendingAfter}). Staying on SECONDARY.`);
      await setSupabaseHealthy(false);
      return { success: false, skipped: false, trigger, reason: 'queue-not-empty', appliedPendingToNeon, reconcile, sync };
    }

    await setSupabaseHealthy(true);
    console.log(`[RECOVERY] Primary recovery complete (trigger=${trigger}); routing resumed to PRIMARY.`);
    return { success: true, skipped: false, trigger, appliedPendingToNeon, reconcile, sync };
  } catch (err: any) {
    console.error('[RECOVERY] Recovery failed:', err?.message);
    await setSupabaseHealthy(false);
    return { success: false, skipped: false, trigger, reason: err?.message };
  } finally {
    await setRecovering(false);
    await releaseLock(RECOVERY_LOCK_KEY, lock.token);
  }
}

// ------------------------------------------------------------ scheduler
let replicationTimer: ReturnType<typeof setInterval> | null = null;
const DEFAULT_SYNC_INTERVAL_MS = 300000; // 5 minutes
const SCHEDULER_LOCK_KEY = 'cicr:replication:scheduler';

export function resolveSyncIntervalMs(): number {
  const raw = parseInt(process.env.SYNC_INTERVAL_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SYNC_INTERVAL_MS;
}

/**
 * Run one scheduled sync guarded by a Redis lock so only a single backend
 * instance performs it. When Redis is unavailable the lock cannot be acquired,
 * so the scheduled sync is skipped (never run by every instance).
 */
async function runScheduledSyncOnce(label: string, intervalMs: number): Promise<void> {
  const lock = await acquireLock(SCHEDULER_LOCK_KEY, intervalMs);
  if (!lock.acquired) {
    console.log(`[REPLICATION] ${label} skipped — another instance holds the sync lock (or Redis unavailable)`);
    return;
  }
  try {
    await syncSupabaseToNeon();
  } finally {
    await releaseLock(SCHEDULER_LOCK_KEY, lock.token);
  }
}

export function startReplicationScheduler(): void {
  const flag = (process.env.REPLICATION_ENABLED || '').toLowerCase();
  if (flag === 'false' || flag === '0') {
    console.log('[REPLICATION] Disabled via REPLICATION_ENABLED=false');
    return;
  }
  if (replicationTimer) return; // never create multiple scheduler instances per process

  const intervalMs = resolveSyncIntervalMs();

  runScheduledSyncOnce('initial sync', intervalMs).catch((err) =>
    console.error('[REPLICATION] Initial sync failed:', err?.message),
  );

  replicationTimer = setInterval(() => {
    runScheduledSyncOnce('scheduled sync', intervalMs).catch((err) =>
      console.error('[REPLICATION] Scheduled sync failed:', err?.message),
    );
  }, intervalMs);

  if (replicationTimer && typeof replicationTimer === 'object' && 'unref' in replicationTimer) {
    replicationTimer.unref();
  }

  console.log(`[REPLICATION] Scheduler started (interval ${intervalMs}ms, Redis leader lock)`);
}

export function stopReplicationScheduler(): void {
  if (replicationTimer) {
    clearInterval(replicationTimer);
    replicationTimer = null;
  }
}
