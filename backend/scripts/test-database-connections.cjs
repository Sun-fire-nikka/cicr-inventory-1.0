const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');

async function testConnections() {
  console.log('====================================================');
  console.log('🔍 CICR DUAL-DATABASE CONNECTIVITY & HEALTH AUDIT');
  console.log('====================================================\n');

  let supabaseOk = false;
  let neonPrimaryOk = false;
  let neonReplicaOk = false;

  // 1. SUPABASE (PRIMARY)
  console.log('--- [1/3] SUPABASE POSTGRESQL (PRIMARY) ---');
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!sbUrl || !sbKey) {
    console.error('❌ Supabase credentials missing in backend/.env');
  } else {
    try {
      const t0 = Date.now();
      const supabase = createClient(sbUrl, sbKey);
      const { data: inv, count, error } = await supabase
        .from('inventory')
        .select('id, name, quantity, available_quantity', { count: 'exact' });

      const latency = Date.now() - t0;

      if (error) {
        console.error('❌ Supabase query failed:', error.message);
      } else {
        supabaseOk = true;
        const runCam = (inv || []).find(i => i.name.toLowerCase().includes('run cam'));
        console.log(`✅ Connection: SUCCESS (${latency}ms round-trip)`);
        console.log(`✅ Project URL: ${sbUrl}`);
        console.log(`✅ Total Inventory Items: ${inv.length}`);
        console.log(`✅ RUN CAM state: quantity=${runCam?.quantity}, available=${runCam?.available_quantity}`);
        
        // Also check other tables
        const { count: borrowCount } = await supabase.from('borrow_records').select('*', { count: 'exact', head: true });
        const { count: auditCount } = await supabase.from('audit_logs').select('*', { count: 'exact', head: true });
        console.log(`✅ Borrow Records Count: ${borrowCount ?? 'N/A'}`);
        console.log(`✅ Audit Logs Count: ${auditCount ?? 'N/A'}`);
      }
    } catch (e) {
      console.error('❌ Supabase connection error:', e.message);
    }
  }

  // 2. NEON (PRIMARY)
  console.log('\n--- [2/3] NEON POSTGRESQL (PRIMARY WRITER) ---');
  if (!process.env.NEON_PRIMARY_HOST) {
    console.error('❌ Neon primary host not configured');
  } else {
    try {
      const t0 = Date.now();
      const neonPrimary = new Pool({
        host: process.env.NEON_PRIMARY_HOST,
        user: process.env.NEON_USER,
        password: process.env.NEON_PASSWORD,
        database: process.env.NEON_DATABASE,
        port: 5432,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 5000
      });

      const res = await neonPrimary.query('SELECT NOW() as server_time, version()');
      const invRes = await neonPrimary.query('SELECT COUNT(*) as count FROM inventory');
      const rcRes = await neonPrimary.query("SELECT id, name, quantity, available_quantity FROM inventory WHERE name ILIKE '%run cam%'");
      const latency = Date.now() - t0;

      neonPrimaryOk = true;
      console.log(`✅ Connection: SUCCESS (${latency}ms round-trip)`);
      console.log(`✅ Host: ${process.env.NEON_PRIMARY_HOST}`);
      console.log(`✅ Database: ${process.env.NEON_DATABASE}`);
      console.log(`✅ Total Inventory Items: ${invRes.rows[0].count}`);
      console.log(`✅ RUN CAM state: quantity=${rcRes.rows[0]?.quantity}, available=${rcRes.rows[0]?.available_quantity}`);
      await neonPrimary.end();
    } catch (e) {
      console.error('❌ Neon Primary connection error:', e.message);
    }
  }

  // 3. NEON (READ REPLICA)
  console.log('\n--- [3/3] NEON POSTGRESQL (READ REPLICA) ---');
  if (!process.env.NEON_REPLICA_HOST) {
    console.log('ℹ️ No distinct read replica host specified');
  } else {
    try {
      const t0 = Date.now();
      const neonReplica = new Pool({
        host: process.env.NEON_REPLICA_HOST,
        user: process.env.NEON_USER,
        password: process.env.NEON_PASSWORD,
        database: process.env.NEON_DATABASE,
        port: 5432,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 5000
      });

      const res = await neonReplica.query('SELECT NOW() as server_time');
      const invRes = await neonReplica.query('SELECT COUNT(*) as count FROM inventory');
      const latency = Date.now() - t0;

      neonReplicaOk = true;
      console.log(`✅ Connection: SUCCESS (${latency}ms round-trip)`);
      console.log(`✅ Host: ${process.env.NEON_REPLICA_HOST}`);
      console.log(`✅ Total Inventory Items: ${invRes.rows[0].count}`);
      await neonReplica.end();
    } catch (e) {
      console.error('❌ Neon Replica connection error:', e.message);
    }
  }

  // Summary
  console.log('\n====================================================');
  console.log('📊 DATABASE STATUS SUMMARY');
  console.log('====================================================');
  console.log(`Supabase (Primary DB):    ${supabaseOk ? '🟢 CONNECTED & OPERATIONAL' : '🔴 FAILED'}`);
  console.log(`Neon Primary (Backup DB):  ${neonPrimaryOk ? '🟢 CONNECTED & OPERATIONAL' : '🔴 FAILED'}`);
  console.log(`Neon Read Replica:        ${neonReplicaOk ? '🟢 CONNECTED & OPERATIONAL' : '⚪ NOT CONFIGURED / SKIPPED'}`);
  console.log('====================================================\n');
}

testConnections().catch(console.error);
