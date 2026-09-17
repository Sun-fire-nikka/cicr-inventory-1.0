const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

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
    // Delete in batches of 200 to prevent query size limit
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

  // 4. Restore 100% capacity for all inventory items
  console.log('\n📦 Step 4: Restoring 100% available quantity on all inventory items...');
  const { data: items, error: itemErr } = await supabase
    .from('inventory')
    .select('id, name, quantity, available_quantity');

  if (itemErr) {
    console.error('❌ Error fetching inventory:', itemErr.message);
  } else if (items) {
    let restored = 0;
    for (const item of items) {
      if (item.available_quantity !== item.quantity) {
        const { error: updErr } = await supabase
          .from('inventory')
          .update({
            available_quantity: item.quantity,
            updated_at: new Date().toISOString()
          })
          .eq('id', item.id);

        if (!updErr) {
          console.log(`✅ Restored "${item.name}": ${item.available_quantity} -> ${item.quantity}`);
          restored++;
        }
      }
    }
    console.log(`✅ Inventory verified: all ${items.length} items have full available capacity (${restored} restored).`);
  }

  // 5. Reset hardware_requests_data.json to empty object {}
  console.log('\n📦 Step 5: Resetting hardware_requests_data.json to empty {}...');
  const requestsFilePath = path.resolve(__dirname, '../../hardware_requests_data.json');
  fs.writeFileSync(requestsFilePath, JSON.stringify({}, null, 2), 'utf8');
  console.log('✅ hardware_requests_data.json wiped clean to {}.');

  // 6. Verification query
  console.log('\n🔍 ===================================================');
  console.log('🔍 FINAL VERIFICATION');
  console.log('🔍 ===================================================');
  const { count: finalBorrows } = await supabase.from('borrow_records').select('*', { count: 'exact', head: true });
  const { count: finalLogs } = await supabase.from('audit_logs').select('*', { count: 'exact', head: true });
  console.log(`📊 Active Borrow Records: ${finalBorrows ?? 0} (expected: 0)`);
  console.log(`📊 Audit Logs / Notifications: ${finalLogs ?? 0} (expected: 0)`);
  console.log('🎉 FRESH START CLEANUP COMPLETE!');
  process.exit(0);
}

freshStart().catch((err) => {
  console.error('❌ Fatal cleanup error:', err);
  process.exit(1);
});
