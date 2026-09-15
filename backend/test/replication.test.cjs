// Replication / failover tests (real Supabase + Neon).
//
// Covers:
//   1. Supabase healthy → supported read/write targets Supabase
//   2. Supabase unavailable → supported table routes to Neon
//   3. Failover write goes ONLY to Neon + durable pending queue (no dual-write)
//   4. Recovery → queued change reaches Supabase
//   5. Queue entry cleared only after successful reconciliation
//   6. Replication is idempotent
//   7. No credentials appear in status/log payloads
//   8. Simulation does not mutate credentials/config
//
// Requires live SUPABASE_* and NEON_* env (same as other integration tests).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const backendDir = path.join(__dirname, '..');
require(path.join(backendDir, 'node_modules', 'dotenv')).config({ path: path.join(backendDir, '.env') });

if (!process.env.SUPABASE_URL || process.env.SUPABASE_URL.includes('placeholder')) {
  console.log('Skipping replication tests (no live Supabase configured).');
  return;
}

const { createClient } = require(path.join(backendDir, 'node_modules', '@supabase', 'supabase-js'));

const health = require('../dist/config/dbHealth.js');
const router = require('../dist/config/databaseRouter.js');
const replication = require('../dist/config/replication.js');
const { dbWrite } = require('../dist/config/database.js');
const { queryWrite } = require('../dist/config/neonPool.js');
const { closeRedis } = require('../dist/config/redis.js');
const { closeNeonPools } = require('../dist/config/neonPool.js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const U = crypto.randomUUID();
const TEMP_IDS = [];
const TEMP_EMAILS = [];

async function cleanup() {
  for (const id of TEMP_IDS) {
    await supabase.from('inventory').delete().eq('id', id);
    await queryWrite('DELETE FROM "inventory" WHERE id = $1', [id]);
  }
  for (const email of TEMP_EMAILS) {
    await supabase.from('users').delete().eq('email', email);
    await queryWrite('DELETE FROM "users" WHERE email = $1', [email]);
  }
}

after(async () => {
  try { await cleanup(); } catch (e) { console.warn('cleanup failed:', e.message); }
  try { await closeRedis(); } catch { /* ignore */ }
  try { await closeNeonPools(); } catch { /* ignore */ }
});

// ------------------------------------------------------------ routing (unit)
test('1. Supabase healthy → replicated table routes to Supabase', () => {
  health.setSupabaseHealthy(true);
  health.setSimulatedOutage(false);
  assert.equal(router.routeToSupabase('inventory'), true);
  assert.equal(router.canUseSupabaseDirect('inventory', 'select', []), true);
});

test('2. Controlled outage → replicated table routes to Neon', () => {
  health.setSupabaseHealthy(true);
  health.setSimulatedOutage(true);
  assert.equal(router.routeToSupabase('inventory'), false);
  assert.equal(router.routeToNeon('inventory'), true);
  health.setSimulatedOutage(false);
});

test('borrow_records routes to Supabase when healthy and Neon on outage', () => {
  health.setSupabaseHealthy(true);
  health.setSimulatedOutage(false);
  assert.equal(router.routeToSupabase('borrow_records'), true);
  assert.equal(router.routeToNeon('borrow_records'), false);

  health.setSimulatedOutage(true);
  assert.equal(router.routeToSupabase('borrow_records'), false);
  assert.equal(router.routeToNeon('borrow_records'), true);
  health.setSimulatedOutage(false);
});

test('Phase 7: conditional inventory stock update stays on ONE path (Supabase)', () => {
  health.setSupabaseHealthy(true);
  health.setSimulatedOutage(false);
  const filters = [
    { type: 'eq', column: 'id', value: U },
    { type: 'gte', column: 'available_quantity', value: 1 },
  ];
  // Previously routed to Neon (split-brain). Now must stay on Supabase.
  assert.equal(router.canUseSupabaseDirect('inventory', 'update', filters), true);
});

// ------------------------------------------------------------ replication (live)
test('6. Replication is idempotent and moves rows Supabase → Neon', async () => {
  const id = crypto.randomUUID();
  TEMP_IDS.push(id);
  const ins = await supabase.from('inventory').insert([
    { id, name: 'REPLICATION_TEST_ITEM', category: 'Tools', location: 'Test Lab', quantity: 7, available_quantity: 7, tags: '[]', status: 'AVAILABLE' },
  ]).select('id').single();
  assert.equal(ins.error, null, ins.error && ins.error.message);

  const first = await replication.syncSupabaseToNeon();
  const invFirst = first.tables.find((t) => t.table === 'inventory');
  assert.ok(invFirst, 'inventory present in sync report');
  assert.ok(invFirst.sourceCount >= 1, 'source has rows');

  const neonRow = await queryWrite('SELECT id, available_quantity FROM "inventory" WHERE id = $1', [id]);
  assert.equal(neonRow.rows.length, 1, 'row replicated to Neon');
  assert.equal(neonRow.rows[0].available_quantity, 7);

  const beforeCount = invFirst.destinationCount;
  const second = await replication.syncSupabaseToNeon();
  const invSecond = second.tables.find((t) => t.table === 'inventory');
  assert.equal(invSecond.inserted, 0, 'second sync inserts nothing (idempotent)');
  assert.equal(invSecond.destinationCount, beforeCount, 'Neon count stable after re-sync');
});

test('3+7. Failover write goes ONLY to Neon + queue (no dual-write)', async () => {
  const id = crypto.randomUUID();
  TEMP_IDS.push(id);

  health.setSupabaseHealthy(true);
  health.setSimulatedOutage(true); // controlled outage

  const queuedBefore = await replication.getPendingCount();

  const res = await dbWrite
    .from('inventory')
    .insert([{ id, name: 'FAILOVER_TEST_ITEM', category: 'Tools', location: 'Neon Lab', quantity: 3, available_quantity: 3, tags: '[]', status: 'AVAILABLE' }])
    .select()
    .single();
  assert.equal(res.error, null, res.error && res.error.message);

  // Present in Neon
  const neon = await queryWrite('SELECT id FROM "inventory" WHERE id = $1', [id]);
  assert.equal(neon.rows.length, 1, 'write landed in Neon');

  // NOT present in Supabase (no dual-write)
  const sb = await supabase.from('inventory').select('id').eq('id', id);
  assert.equal(sb.data.length, 0, 'write must NOT be in Supabase during outage');

  // Pending queue grew
  const queuedAfter = await replication.getPendingCount();
  assert.equal(queuedAfter, queuedBefore + 1, 'one pending change enqueued');

  health.setSimulatedOutage(false);
});

test('4+5. Recovery reconciles pending change to Supabase and clears the queue', async () => {
  // Create a fresh failing-over write while "down"
  const id = crypto.randomUUID();
  TEMP_IDS.push(id);
  health.setSupabaseHealthy(true);
  health.setSimulatedOutage(true);

  await dbWrite
    .from('inventory')
    .insert([{ id, name: 'RECONCILE_TEST_ITEM', category: 'Tools', location: 'Neon Lab', quantity: 2, available_quantity: 2, tags: '[]', status: 'AVAILABLE' }])
    .select()
    .single();

  const beforeReconcile = await replication.getPendingCount();
  assert.ok(beforeReconcile >= 1, 'pending queue has entries');

  // Recover
  health.setSimulatedOutage(false);
  const reconcile = await replication.reconcileNeonToSupabase();
  assert.ok(reconcile.applied >= 1, 'at least one change reconciled');

  // Write reached Supabase
  const sb = await supabase.from('inventory').select('id, available_quantity').eq('id', id);
  assert.equal(sb.data.length, 1, 'reconciled write present in Supabase');
  assert.equal(sb.data[0].available_quantity, 2);

  // Queue entry removed after success
  const afterQueue = await replication.getPendingCount();
  assert.equal(afterQueue, 0, 'queue cleared after successful reconciliation');

  // Re-sync keeps both sides consistent
  const report = await replication.syncSupabaseToNeon();
  assert.equal(report.errors.length, 0, 'sync has no errors: ' + report.errors.join('; '));
});

test('8+9. Simulation does not mutate credentials/config and logs no secrets', async () => {
  const urlBefore = process.env.SUPABASE_URL;
  const keyBefore = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const neonBefore = process.env.NEON_PASSWORD;

  health.setSimulatedOutage(true);
  const status = await replication.getReplicationStatus();
  health.setSimulatedOutage(false);

  assert.equal(process.env.SUPABASE_URL, urlBefore, 'SUPABASE_URL unchanged');
  assert.equal(process.env.SUPABASE_SERVICE_ROLE_KEY, keyBefore, 'service role key unchanged');
  assert.equal(process.env.NEON_PASSWORD, neonBefore, 'NEON_PASSWORD unchanged');

  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes(process.env.SUPABASE_SERVICE_ROLE_KEY), 'no service-role key in status');
  assert.ok(!serialized.includes(process.env.NEON_PASSWORD), 'no Neon password in status');
  if (process.env.REDIS_URL) {
    const tokenMatch = process.env.REDIS_URL.match(/:\/\/[^:]*:([^@]+)@/);
    if (tokenMatch) {
      assert.ok(!serialized.includes(tokenMatch[1]), 'no Redis token in status');
    }
  }
});
