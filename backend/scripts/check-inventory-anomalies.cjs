const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function check() {
  console.log('--- SUPABASE INVENTORY CHECK ---');
  const { data: items, error } = await supabase.from('inventory').select('*');
  if (error) {
    console.error('Supabase error:', error);
    return;
  }

  const { data: borrows } = await supabase.from('borrow_records').select('*');
  console.log(`Total inventory items in Supabase: ${items.length}`);
  console.log(`Total borrow records in Supabase: ${borrows ? borrows.length : 0}`);

  for (const item of items) {
    const itemBorrows = (borrows || []).filter(b => b.item_id === item.id && b.status !== 'RETURNED');
    const borrowedQty = itemBorrows.reduce((sum, b) => sum + (Number(b.quantity) || 0), 0);
    
    if (Number(item.available_quantity) > Number(item.quantity)) {
      console.log(`\n🚨 ANOMALY: "${item.name}" (ID: ${item.id})`);
      console.log(`   quantity (total): ${item.quantity}`);
      console.log(`   available_quantity: ${item.available_quantity}`);
      console.log(`   active unreturned borrows: ${borrowedQty}`);
    }
  }

  // Also check Neon
  if (process.env.NEON_PRIMARY_HOST) {
    try {
      const neon = new Pool({
        host: process.env.NEON_PRIMARY_HOST,
        user: process.env.NEON_USER,
        password: process.env.NEON_PASSWORD,
        database: process.env.NEON_DATABASE,
        ssl: { rejectUnauthorized: false }
      });
      const res = await neon.query('SELECT id, name, quantity, available_quantity FROM inventory');
      console.log(`\n--- NEON INVENTORY CHECK --- (${res.rows.length} items)`);
      for (const item of res.rows) {
        if (Number(item.available_quantity) > Number(item.quantity)) {
          console.log(`🚨 NEON ANOMALY: "${item.name}" -> quantity: ${item.quantity}, available: ${item.available_quantity}`);
        }
      }
      await neon.end();
    } catch (e) {
      console.log('Neon error:', e.message);
    }
  }
}

check().catch(console.error);
