const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

// Load backend/.env
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const supabaseUrl = process.env.SUPABASE_URL || '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const anonKey = process.env.SUPABASE_ANON_KEY || '';

if (!supabaseUrl) {
  console.error('❌ Missing SUPABASE_URL in backend/.env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey || anonKey, {
  auth: { persistSession: false },
});

async function clearNotificationsAndRestock() {
  console.log('🔄 ==============================================');
  console.log('🔄 CLEARING ALL NOTIFICATIONS & RESTOCKING VAULT');
  console.log('🔄 Target Supabase:', supabaseUrl);
  console.log('🔄 ==============================================\n');

  // 1. Clear all borrow_records so there are 0 loans or past loan notifications
  console.log('📦 Step 1: Clearing borrow_records...');
  const { data: borrows, error: bErr } = await supabase.from('borrow_records').select('id');
  if (bErr) {
    console.warn('⚠️ Could not select borrow_records:', bErr.message);
  } else if (borrows && borrows.length > 0) {
    const ids = borrows.map(b => b.id);
    const { error: delErr } = await supabase.from('borrow_records').delete().in('id', ids);
    if (delErr) {
      console.error('❌ Failed to clear borrow_records:', delErr.message);
    } else {
      console.log(`✅ Cleared ${ids.length} borrow record(s).`);
    }
  } else {
    console.log('✅ borrow_records already empty.');
  }

  // 2. Clear all audit_logs so there are 0 system audit notifications
  console.log('\n📦 Step 2: Clearing audit_logs...');
  const { data: logs, error: lErr } = await supabase.from('audit_logs').select('id');
  if (lErr) {
    console.warn('⚠️ Could not select audit_logs:', lErr.message);
  } else if (logs && logs.length > 0) {
    const logIds = logs.map(l => l.id);
    // Delete in batches if large
    const batchSize = 100;
    let deletedCount = 0;
    for (let i = 0; i < logIds.length; i += batchSize) {
      const chunk = logIds.slice(i, i + batchSize);
      const { error: delLogErr } = await supabase.from('audit_logs').delete().in('id', chunk);
      if (delLogErr) {
        console.error('❌ Error deleting audit_logs chunk:', delLogErr.message);
      } else {
        deletedCount += chunk.length;
      }
    }
    console.log(`✅ Cleared ${deletedCount} audit log record(s).`);
  } else {
    console.log('✅ audit_logs already empty.');
  }

  // 3. Clear auth_otps if any
  console.log('\n📦 Step 3: Clearing auth_otps...');
  try {
    const { data: otps } = await supabase.from('auth_otps').select('id');
    if (otps && otps.length > 0) {
      await supabase.from('auth_otps').delete().in('id', otps.map(o => o.id));
      console.log(`✅ Cleared ${otps.length} auth OTP record(s).`);
    } else {
      console.log('✅ auth_otps already empty.');
    }
  } catch (err) {
    console.log('ℹ️ auth_otps skipped or empty.');
  }

  // 4. Ensure all inventory items have available_quantity = quantity
  console.log('\n📦 Step 4: Ensuring 100% stock available in inventory vault...');
  const { data: inventoryItems, error: invErr } = await supabase
    .from('inventory')
    .select('id, name, quantity, available_quantity');

  if (invErr) {
    console.error('❌ Failed to fetch inventory:', invErr.message);
  } else if (inventoryItems && inventoryItems.length > 0) {
    let restoredCount = 0;
    let totalStock = 0;
    for (const item of inventoryItems) {
      totalStock += item.quantity;
      if (item.available_quantity !== item.quantity) {
        const { error: updInvErr } = await supabase
          .from('inventory')
          .update({
            available_quantity: item.quantity,
            updated_at: new Date().toISOString(),
          })
          .eq('id', item.id);

        if (updInvErr) {
          console.error(`❌ Failed to restock "${item.name}":`, updInvErr.message);
        } else {
          restoredCount++;
        }
      }
    }
    console.log(`✅ Verified ${inventoryItems.length} vault components (Total units: ${totalStock}). Restocked: ${restoredCount}.`);
  }

  // 5. Reset hardware_requests_data.json
  console.log('\n📦 Step 5: Resetting hardware_requests_data.json...');
  const requestsPath = path.resolve(__dirname, '../../hardware_requests_data.json');
  try {
    fs.writeFileSync(requestsPath, JSON.stringify({}, null, 2), 'utf8');
    console.log('✅ hardware_requests_data.json reset to empty object {}.');
  } catch (err) {
    console.warn('⚠️ Could not reset hardware_requests_data.json:', err.message);
  }

  console.log('\n==============================================');
  console.log('✅ ALL NOTIFICATIONS CLEARED & VAULT FULLY RESTOCKED');
  console.log('==============================================');
}

clearNotificationsAndRestock().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
