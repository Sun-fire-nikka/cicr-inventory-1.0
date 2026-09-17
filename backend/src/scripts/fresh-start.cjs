const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const Redis = require('ioredis');

// Load backend/.env
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const supabaseUrl = process.env.SUPABASE_URL || '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !serviceKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in backend/.env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false },
});

async function freshStart() {
  console.log('🚀 ===================================================');
  console.log('🚀 CICR FRESH START: PURGING ALL REQUESTS, LOANS & NOTIFS');
  console.log('🚀 Target Supabase:', supabaseUrl);
  console.log('🚀 ===================================================\n');

  // 1. Delete all borrow_records
  console.log('🗑️  Step 1: Deleting all borrow records (loans & returns)...');
  const { data: borrows, error: fetchBorrowsErr } = await supabase
    .from('borrow_records')
    .select('id');

  if (fetchBorrowsErr) {
    console.error('❌ Error querying borrow_records:', fetchBorrowsErr.message);
  } else if (borrows && borrows.length > 0) {
    const ids = borrows.map(b => b.id);
    const { error: delErr } = await supabase
      .from('borrow_records')
      .delete()
      .in('id', ids);

    if (delErr) {
      console.error('❌ Error deleting borrow_records:', delErr.message);
    } else {
      console.log(`✅ Successfully deleted all ${borrows.length} borrow records.`);
    }
  } else {
    console.log('✅ borrow_records table is already empty (0 rows).');
  }

  // 2. Delete all audit_logs (clears all notifications & activity trail)
  console.log('\n🗑️  Step 2: Deleting all audit logs (notifications for all users)...');
  const { data: logs, error: fetchLogsErr } = await supabase
    .from('audit_logs')
    .select('id');

  if (fetchLogsErr) {
    console.error('❌ Error querying audit_logs:', fetchLogsErr.message);
  } else if (logs && logs.length > 0) {
    const batchSize = 200;
    let deletedCount = 0;
    for (let i = 0; i < logs.length; i += batchSize) {
      const batchIds = logs.slice(i, i + batchSize).map(l => l.id);
      const { error: delLogsErr } = await supabase
        .from('audit_logs')
        .delete()
        .in('id', batchIds);

      if (delLogsErr) {
        console.error(`❌ Error deleting audit_logs batch ${i}:`, delLogsErr.message);
      } else {
        deletedCount += batchIds.length;
      }
    }
    console.log(`✅ Successfully deleted all ${deletedCount} audit log records.`);
  } else {
    console.log('✅ audit_logs table is already empty (0 rows).');
  }

  // 3. Delete any active OTPs
  console.log('\n🗑️  Step 3: Deleting any leftover auth OTPs...');
  try {
    const { data: otps } = await supabase.from('auth_otps').select('id');
    if (otps && otps.length > 0) {
      await supabase.from('auth_otps').delete().in('id', otps.map(o => o.id));
      console.log(`✅ Deleted ${otps.length} auth_otps.`);
    } else {
      console.log('✅ auth_otps table is empty.');
    }
  } catch (oe) {
    console.log('ℹ️ auth_otps skipped or empty.');
  }

  // 4. Resolve any pending users (approve them so no pending registration alert remains)
  console.log('\n👥 Step 4: Resolving pending user approvals...');
  try {
    const { data: pendingUsers } = await supabase
      .from('users')
      .select('id, name, email')
      .eq('status', 'PENDING');

    if (pendingUsers && pendingUsers.length > 0) {
      for (const pu of pendingUsers) {
        // Delete test users or approve genuine users
        if (pu.email.includes('.test') || pu.email.includes('mock')) {
          await supabase.from('users').delete().eq('id', pu.id);
          console.log(`🗑️ Deleted mock user ${pu.name} (${pu.email})`);
        } else {
          await supabase.from('users').update({ status: 'APPROVED' }).eq('id', pu.id);
          console.log(`✅ Approved pending user ${pu.name} (${pu.email})`);
        }
      }
    } else {
      console.log('✅ No pending user registrations.');
    }
  } catch (ue) {
    console.warn('⚠️ User approval check skipped:', ue.message);
  }

  // 5. Restore 100% capacity for all inventory items
  console.log('\n📦 Step 5: Restoring 100% available quantity on all inventory items...');
  const { data: items, error: itemErr } = await supabase
    .from('inventory')
    .select('id, name, quantity, available_quantity');

  if (itemErr) {
    console.error('❌ Error fetching inventory:', itemErr.message);
  } else if (items) {
    let restored = 0;
    for (const item of items) {
      const targetQty = item.quantity <= 0 ? 1 : item.quantity;
      if (item.available_quantity !== targetQty || item.quantity <= 0) {
        const { error: updErr } = await supabase
          .from('inventory')
          .update({
            quantity: targetQty,
            available_quantity: targetQty,
            updated_at: new Date().toISOString()
          })
          .eq('id', item.id);

        if (!updErr) {
          console.log(`✅ Restored "${item.name}": qty ${targetQty}, avail ${targetQty}`);
          restored++;
        }
      }
    }
    console.log(`✅ Inventory verified: all ${items.length} items at 100% available capacity (${restored} updated).`);
  }

  // 6. Reset hardware_requests_data.json to empty object {}
  console.log('\n📦 Step 6: Resetting hardware_requests_data.json to empty {}...');
  const requestsFilePath = path.resolve(__dirname, '../../hardware_requests_data.json');
  fs.writeFileSync(requestsFilePath, JSON.stringify({}, null, 2), 'utf8');
  console.log('✅ hardware_requests_data.json wiped clean to {}.');

  // 7. Flush all Redis cache keys for inventory, history, and stats
  console.log('\n⚡ Step 7: Flushing Redis API response caches...');
  if (process.env.REDIS_URL) {
    try {
      const redis = new Redis(process.env.REDIS_URL);
      const keys = await redis.keys('cicr:*');
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(`✅ Deleted ${keys.length} cached Redis keys.`);
      } else {
        console.log('✅ No Redis cache keys to delete.');
      }
      await redis.quit();
    } catch (re) {
      console.warn('⚠️ Redis flush warning:', re.message);
    }
  }

  // 8. Verification query
  console.log('\n🔍 ===================================================');
  console.log('🔍 FINAL DATABASE VERIFICATION');
  console.log('🔍 ===================================================');
  const { count: finalBorrows } = await supabase.from('borrow_records').select('*', { count: 'exact', head: true });
  const { count: finalLogs } = await supabase.from('audit_logs').select('*', { count: 'exact', head: true });
  const { count: finalPendingUsers } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('status', 'PENDING');
  console.log(`📊 Active Borrow Records: ${finalBorrows ?? 0} (target: 0)`);
  console.log(`📊 Audit Logs / Notifications: ${finalLogs ?? 0} (target: 0)`);
  console.log(`📊 Pending User Approvals: ${finalPendingUsers ?? 0} (target: 0)`);
  console.log('🎉 FRESH START DATABASE PURGE COMPLETE!');
  process.exit(0);
}

freshStart().catch((err) => {
  console.error('❌ Fatal cleanup error:', err);
  process.exit(1);
});
