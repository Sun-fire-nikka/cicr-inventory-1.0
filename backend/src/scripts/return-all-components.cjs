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

async function returnAllComponents() {
  console.log('🔄 ==============================================');
  console.log('🔄 RETURNING ALL COMPONENTS & RESTORING INVENTORY');
  console.log('🔄 Target Supabase:', supabaseUrl);
  console.log('🔄 ==============================================\n');

  // 1. Update borrow_records
  console.log('📦 Step 1: Checking borrow_records table...');
  const { data: activeBorrows, error: borrowErr } = await supabase
    .from('borrow_records')
    .select('id, inventory_id, borrower_name, quantity, status, user_id')
    .neq('status', 'RETURNED');

  if (borrowErr) {
    console.warn('⚠️ Could not query borrow_records:', borrowErr.message);
  } else if (activeBorrows && activeBorrows.length > 0) {
    console.log(`Found ${activeBorrows.length} unreturned borrow records. Marking all as RETURNED...`);
    const now = new Date().toISOString();
    for (const record of activeBorrows) {
      const { error: updErr } = await supabase
        .from('borrow_records')
        .update({
          status: 'RETURNED',
          returned_at: now,
        })
        .eq('id', record.id);

      if (updErr) {
        console.error(`❌ Failed to update borrow record ${record.id}:`, updErr.message);
      } else {
        console.log(`✅ Returned borrow record ${record.id}: ${record.quantity}x (borrower: ${record.borrower_name})`);
      }
    }
  } else {
    console.log('✅ All borrow_records are already marked RETURNED (or no unreturned records found).');
  }

  // 2. Restore available_quantity on inventory table
  console.log('\n📦 Step 2: Restoring available_quantity = quantity on inventory table...');
  const { data: inventoryItems, error: invErr } = await supabase
    .from('inventory')
    .select('id, name, quantity, available_quantity');

  if (invErr) {
    console.error('❌ Failed to fetch inventory:', invErr.message);
  } else if (inventoryItems && inventoryItems.length > 0) {
    let restoredCount = 0;
    for (const item of inventoryItems) {
      if (item.available_quantity !== item.quantity) {
        const { error: updInvErr } = await supabase
          .from('inventory')
          .update({
            available_quantity: item.quantity,
            updated_at: new Date().toISOString(),
          })
          .eq('id', item.id);

        if (updInvErr) {
          console.error(`❌ Failed to restore "${item.name}":`, updInvErr.message);
        } else {
          console.log(`✅ Restored "${item.name}": available_quantity ${item.available_quantity} -> ${item.quantity}`);
          restoredCount++;
        }
      }
    }
    if (restoredCount === 0) {
      console.log(`✅ All ${inventoryItems.length} inventory items already have full available stock!`);
    } else {
      console.log(`🎉 Successfully restored stock for ${restoredCount} inventory items.`);
    }
  } else {
    console.log('⚠️ No inventory items found in database.');
  }

  // 3. Update hardware_requests_data.json
  console.log('\n📦 Step 3: Syncing hardware_requests_data.json...');
  const requestsFilePath = path.resolve(__dirname, '../../hardware_requests_data.json');
  if (fs.existsSync(requestsFilePath)) {
    try {
      const raw = fs.readFileSync(requestsFilePath, 'utf8');
      const requests = JSON.parse(raw);
      let updatedLocalCount = 0;
      const now = new Date().toISOString();

      for (const [key, req] of Object.entries(requests)) {
        if (req && req.status !== 'RETURNED' && req.status !== 'REJECTED') {
          req.status = 'RETURNED';
          req.returnedAt = now;
          updatedLocalCount++;
        }
      }

      fs.writeFileSync(requestsFilePath, JSON.stringify(requests, null, 2), 'utf8');
      console.log(`✅ hardware_requests_data.json updated: ${updatedLocalCount} requests marked RETURNED.`);
    } catch (err) {
      console.error('❌ Error updating hardware_requests_data.json:', err.message);
    }
  } else {
    console.log('ℹ️ hardware_requests_data.json does not exist.');
  }

  // 4. Update Neon secondary (if configured)
  if (process.env.NEON_PRIMARY_HOST && process.env.NEON_USER && process.env.NEON_PASSWORD) {
    console.log('\n📦 Step 4: Syncing Neon PostgreSQL secondary...');
    const { Pool } = require('pg');
    const pool = new Pool({
      host: process.env.NEON_PRIMARY_HOST,
      database: process.env.NEON_DATABASE || 'PostgreSQL',
      user: process.env.NEON_USER,
      password: process.env.NEON_PASSWORD,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 5000,
    });
    try {
      const resBorrows = await pool.query("UPDATE public.borrow_records SET status = 'RETURNED', returned_at = NOW() WHERE status <> 'RETURNED';");
      console.log(`   ✅ Marked ${resBorrows.rowCount || 0} Neon borrow records as RETURNED.`);
      const resInv = await pool.query('UPDATE public.inventory SET available_quantity = quantity WHERE available_quantity <> quantity;');
      console.log(`   ✅ Restocked ${resInv.rowCount || 0} Neon inventory items to 100% capacity.`);
    } catch (neonErr) {
      console.warn('   ℹ️ Neon secondary note:', neonErr.message);
    } finally {
      await pool.end().catch(() => {});
    }
  }

  console.log('\n==============================================');
  console.log('✅ ALL COMPONENTS SUCCESSFULLY RETURNED & RESTOCKED');
  console.log('==============================================');
}

returnAllComponents().catch((err) => {
  console.error('❌ Fatal error in returnAllComponents:', err);
  process.exit(1);
});
