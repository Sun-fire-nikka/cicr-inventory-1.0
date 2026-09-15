// Neon PostgreSQL connection pools (v2.0.0).
//
// Provides primary (read-write) and replica (read-only) connection pools
// using the standard pg driver. Designed for Neon's shared-storage
// architecture where primary and replica compute nodes share the same
// storage layer — committed writes are immediately visible to both.
//
// Environment variables:
//   NEON_PRIMARY_HOST  — primary compute endpoint hostname
//   NEON_REPLICA_HOST  — read replica endpoint hostname (optional)
//   NEON_DATABASE      — database name (default: neondb)
//   NEON_USER          — PostgreSQL user
//   NEON_PASSWORD      — PostgreSQL password
//   NEON_BRANCH_ID     — Neon branch ID (for API-based promotion)
//   NEON_PROJECT_ID    — Neon project ID (for API-based promotion)
//   NEON_API_KEY       — Neon API key (for promotion/fencing)
//
// This module does NOT replace database.ts. It provides the underlying
// connection pools that database.ts will use after migration (Stage 5).
import dotenv from 'dotenv';
import { Pool, PoolConfig, QueryResult } from 'pg';

dotenv.config();

// ---------------------------------------------------------------- configuration
export interface NeonPoolConfig {
  primaryHost: string;
  replicaHost: string | null;
  database: string;
  user: string;
  password: string;
  branchId: string | null;
  projectId: string | null;
  apiKey: string | null;
}

export const neonConfig: NeonPoolConfig = {
  primaryHost: process.env.NEON_PRIMARY_HOST || '',
  replicaHost: process.env.NEON_REPLICA_HOST || null,
  database: process.env.NEON_DATABASE || 'neondb',
  user: process.env.NEON_USER || '',
  password: process.env.NEON_PASSWORD || '',
  branchId: process.env.NEON_BRANCH_ID || null,
  projectId: process.env.NEON_PROJECT_ID || null,
  apiKey: process.env.NEON_API_KEY || null,
};

export const isNeonConfigured = (): boolean =>
  Boolean(neonConfig.primaryHost && neonConfig.user && neonConfig.password);

export const isReplicaConfigured = (): boolean =>
  Boolean(neonConfig.replicaHost && isNeonConfigured());

// ----------------------------------------------------------- pool construction
const POOL_CONFIG_BASE: Omit<PoolConfig, 'host' | 'application_name'> = {
  database: neonConfig.database,
  user: neonConfig.user,
  password: neonConfig.password,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
};

export const primaryPool: Pool = new Pool({
  ...POOL_CONFIG_BASE,
  host: neonConfig.primaryHost,
  application_name: 'cicr-primary',
});

export const replicaPool: Pool = new Pool({
  ...POOL_CONFIG_BASE,
  host: neonConfig.replicaHost || neonConfig.primaryHost,
  application_name: 'cicr-replica',
});

// Prevent unhandled idle-connection errors (e.g. ECONNRESET) from crashing
// the process.  The pool will evict the broken connection and continue.
primaryPool.on('error', (err: any) => {
  console.error('[NEON] Primary pool idle client error:', err?.message || err);
});
replicaPool.on('error', (err: any) => {
  console.error('[NEON] Replica pool idle client error:', err?.message || err);
});

// ----------------------------------------------------------- health tracking
export type EndpointStatus = 'unknown' | 'healthy' | 'unhealthy';

export interface HealthState {
  primary: EndpointStatus;
  replica: EndpointStatus;
  failoverState: FailoverState;
  lastPrimaryCheck: Date | null;
  lastReplicaCheck: Date | null;
  primaryConsecutiveFailures: number;
  currentPrimaryHost: string;
  currentReplicaHost: string;
}

export type FailoverState =
  | 'HEALTHY'
  | 'DEGRADED'
  | 'PROMOTING'
  | 'FENCING'
  | 'RECOVERED'
  | 'BOTH_DOWN'
  | 'API_FAILURE';

export const healthState: HealthState = {
  primary: 'unknown',
  replica: 'unknown',
  failoverState: 'HEALTHY',
  lastPrimaryCheck: null,
  lastReplicaCheck: null,
  primaryConsecutiveFailures: 0,
  currentPrimaryHost: neonConfig.primaryHost,
  currentReplicaHost: neonConfig.replicaHost || neonConfig.primaryHost,
};

// ---------------------------------------------------------- health check query
const HEALTH_CHECK_SQL = 'SELECT 1 AS ok';

export async function checkPoolHealth(pool: Pool): Promise<boolean> {
  try {
    const result: QueryResult = await pool.query(HEALTH_CHECK_SQL);
    return result.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}

export async function checkPrimaryHealth(): Promise<boolean> {
  const ok = await checkPoolHealth(primaryPool);
  healthState.primary = ok ? 'healthy' : 'unhealthy';
  healthState.lastPrimaryCheck = new Date();
  if (ok) {
    healthState.primaryConsecutiveFailures = 0;
  } else {
    healthState.primaryConsecutiveFailures++;
  }
  return ok;
}

export async function checkReplicaHealth(): Promise<boolean> {
  if (!isReplicaConfigured()) {
    healthState.replica = 'unknown';
    return false;
  }
  const ok = await checkPoolHealth(replicaPool);
  healthState.replica = ok ? 'healthy' : 'unhealthy';
  healthState.lastReplicaCheck = new Date();
  return ok;
}

// --------------------------------------------------- query helpers with routing
export interface QueryOptions {
  useReplica?: boolean;
  timeoutMs?: number;
}

async function queryWithTimeout(
  pool: Pool,
  text: string,
  values?: unknown[],
  timeoutMs?: number,
): Promise<QueryResult> {
  if (timeoutMs && timeoutMs > 0) {
    const client = await pool.connect();
    try {
      const timer = setTimeout(() => {
        client.release(new Error('Query timeout'));
      }, timeoutMs);
      try {
        const result = await client.query(text, values);
        clearTimeout(timer);
        return result;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      client.release();
      throw err;
    }
  }
  return pool.query(text, values);
}

export async function queryRead(
  text: string,
  values?: unknown[],
  options?: QueryOptions,
): Promise<QueryResult> {
  const pool = options?.useReplica !== false && isReplicaConfigured()
    ? replicaPool
    : primaryPool;
  return queryWithTimeout(pool, text, values, options?.timeoutMs);
}

export async function queryWrite(
  text: string,
  values?: unknown[],
  timeoutMs?: number,
): Promise<QueryResult> {
  return queryWithTimeout(primaryPool, text, values, timeoutMs);
}

// ------------------------------------------------- transaction helper
export async function withTransaction<T>(
  fn: (client: { query: (text: string, values?: unknown[]) => Promise<QueryResult> }) => Promise<T>,
): Promise<T> {
  const client = await primaryPool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// --------------------------------------------------- graceful shutdown
export async function closeNeonPools(): Promise<void> {
  await Promise.all([
    primaryPool.end().catch(() => {}),
    replicaPool.end().catch(() => {}),
  ]);
}
