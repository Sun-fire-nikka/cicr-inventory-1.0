/**
 * CICR Comprehensive Log & Request Purge Script
 * 
 * Safely purges:
 * 1. Supabase: borrow_records, audit_logs, auth_otps
 * 2. Neon PostgreSQL: borrow_records, audit_logs (if tables exist)
 * 3. Restores 100% stock on all inventory items (available_quantity = quantity)
 * 4. Flushes Redis cache keys (cicr:*)
 * 5. Resets hardware_requests_data.json
 */

const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const Redis = require('ioredis');
const { Pool } = require('pg');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !serviceKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in backend/.env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false },
});

async function purgeAllLogs() {
  console.log('════════════════════════════════════════════════════════');
  console.log('🗑️  CICR: PURGING ALL LOGS & BORROW REQUESTS');
  console.log('📍 Supabase Target:', supabaseUrl);
  console.log('════════════════════════════════════════════════════════\n');

  // 1. Delete all borrow_records in Supabase
  console.log('1️⃣  Purging borrow_records in Supabase...');
  try {
    const { data: borrows, error: bErr } = await supabase.from('borrow_records').select('id');
    if (bErr) {
      console.warn('   ⚠️ Could not query borrow_records:', bErr.message);
    } else if (borrows && borrows.length > 0) {
      const ids = borrows.map(b => b.id);
      const { error: delErr } = await supabase.from('borrow_records').delete().in('id', ids);
      if (delErr) {
        console.error('   ❌ Failed to delete borrow_records:', delErr.message);
      } else {
        console.log(`   ✅ Successfully deleted ${ids.length} borrow/return record(s).`);
      }
    } else {
      console.log('   ✅ borrow_records table is already empty (0 rows).');
    }
  } catch (err) {
    console.error('   ❌ Error in borrow_records step:', err.message);
  }

  // 2. Delete all audit_logs in Supabase
  console.log('\n2️⃣  Purging audit_logs in Supabase...');
  try {
    const { data: logs, error: lErr } = await supabase.from('audit_logs').select('id');
    if (lErr) {
      console.warn('   ⚠️ Could not query audit_logs:', lErr.message);
    } else if (logs && logs.length > 0) {
      const batchSize = 100;
      let deleted = 0;
      for (let i = 0; i < logs.length; i += batchSize) {
        const chunk = logs.slice(i, i + batchSize).map(l => l.id);
        const { error: delLogsErr } = await supabase.from('audit_logs').delete().in('id', chunk);
        if (delLogsErr) {
          console.error('   ❌ Error deleting audit_logs chunk:', delLogsErr.message);
        } else {
          deleted += chunk.length;
        }
      }
      console.log(`   ✅ Successfully deleted ${deleted} audit log entry/entries.`);
    } else {
      console.log('   ✅ audit_logs table is already empty (0 rows).');
    }
  } catch (err) {
    console.error('   ❌ Error in audit_logs step:', err.message);
  }

  // 3. Purge Neon PostgreSQL secondary (if configured)
  if (process.env.NEON_PRIMARY_HOST && process.env.NEON_USER && process.env.NEON_PASSWORD) {
    console.log('\n3️⃣  Purging secondary Neon PostgreSQL tables...');
    const pool = new Pool({
      host: process.env.NEON_PRIMARY_HOST,
      database: process.env.NEON_DATABASE || 'PostgreSQL',
      user: process.env.NEON_USER,
      password: process.env.NEON_PASSWORD,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 5000,
    });
    try {
      await pool.query('DELETE FROM public.borrow_records;');
      console.log('   ✅ Cleared Neon borrow_records.');
      await pool.query('DELETE FROM public.audit_logs;');
      console.log('   ✅ Cleared Neon audit_logs.');
      await pool.query('UPDATE public.inventory SET available_quantity = quantity WHERE available_quantity <> quantity;');
      console.log('   ✅ Restocked Neon inventory.');
    } catch (neonErr) {
      console.warn('   ℹ️ Neon secondary note:', neonErr.message);
    } finally {
      await pool.end().catch(() => {});
    }
  }

  // 4. Ensure all inventory items have 100% stock available
  console.log('\n4️⃣  Restoring 100% capacity on all vault inventory items...');
  try {
    const { data: items, error: invErr } = await supabase.from('inventory').select('id, name, quantity, available_quantity');
    if (invErr) {
      console.error('   ❌ Failed to query inventory:', invErr.message);
    } else if (items) {
      let restored = 0;
      for (const item of items) {
        const target = item.quantity <= 0 ? 1 : item.quantity;
        if (item.available_quantity !== target || item.quantity <= 0) {
          const { error: updErr } = await supabase
            .from('inventory')
            .update({ quantity: target, available_quantity: target, updated_at: new Date().toISOString() })
            .eq('id', item.id);
          if (!updErr) restored++;
        }
      }
      console.log(`   ✅ Checked ${items.length} items. Restocked ${restored} item(s) to full capacity.`);
    }
  } catch (err) {
    console.error('   ❌ Error in inventory restocking:', err.message);
  }

  // 5. Clear auth_otps
  console.log('\n5️⃣  Clearing any pending auth OTPs...');
  try {
    const { data: otps } = await supabase.from('auth_otps').select('id');
    if (otps && otps.length > 0) {
      await supabase.from('auth_otps').delete().in('id', otps.map(o => o.id));
      console.log(`   ✅ Cleared ${otps.length} auth OTP(s).`);
    } else {
      console.log('   ✅ auth_otps empty.');
    }
  } catch (err) {
    console.log('   ℹ️ auth_otps skipped or empty.');
  }

  // 6. Reset local hardware_requests_data.json
  console.log('\n6️⃣  Resetting local hardware_requests_data.json...');
  const pathsToCheck = [
    path.resolve(__dirname, '../../hardware_requests_data.json'),
    path.resolve(__dirname, '../../../hardware_requests_data.json')
  ];
  for (const p of pathsToCheck) {
    try {
      if (fs.existsSync(p)) {
        fs.writeFileSync(p, JSON.stringify({}, null, 2), 'utf8');
        console.log(`   ✅ Reset ${p} to empty object {}.`);
      }
    } catch {}
  }

  // 7. Flush Redis caches
  if (process.env.REDIS_URL) {
    console.log('\n7️⃣  Flushing Redis API response caches...');
    try {
      const redis = new Redis(process.env.REDIS_URL);
      const keys = await redis.keys('cicr:*');
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(`   ✅ Deleted ${keys.length} cached Redis key(s).`);
      } else {
        console.log('   ✅ No Redis cache keys found.');
      }
      await redis.quit();
    } catch (re) {
      console.warn('   ⚠️ Redis notice:', re.message);
    }
  }

  console.log('\n════════════════════════════════════════════════════════');
  console.log('🎉 ALL LOGS, BORROW REQUESTS & AUDIT TRAILS PURGED!');
  console.log('════════════════════════════════════════════════════════\n');
  process.exit(0);
}

purgeAllLogs().catch(err => {
  console.error('❌ Unexpected purge error:', err);
  process.exit(1);
});
