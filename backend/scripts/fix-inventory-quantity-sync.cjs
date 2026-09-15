const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function fix() {
  console.log('=== FIXING INVENTORY QUANTITY SYNC IN DATABASE ===');

  // 1. Specifically fix RUN CAM to quantity: 1, available_quantity: 1
  const { data: runCam, error: rcErr } = await supabase
    .from('inventory')
    .update({ quantity: 1, available_quantity: 1, updated_at: new Date().toISOString() })
    .ilike('name', '%run cam%')
    .select('id, name, quantity, available_quantity');

  if (rcErr) {
    console.error('Failed to update RUN CAM in Supabase:', rcErr);
  } else {
    console.log('✅ Updated RUN CAM in Supabase:', runCam);
  }

  // 2. Scan and clamp any items where available_quantity > quantity across Supabase
  const { data: allItems, error: fetchErr } = await supabase
    .from('inventory')
    .select('id, name, quantity, available_quantity');

  if (fetchErr) {
    console.error('Failed to fetch inventory:', fetchErr);
  } else {
    for (const item of allItems) {
      const q = Number(item.quantity) || 0;
      const a = Number(item.available_quantity) || 0;
      if (a > q) {
        console.log(`Clamping item "${item.name}": available ${a} -> ${q}`);
        await supabase
          .from('inventory')
          .update({ available_quantity: q, updated_at: new Date().toISOString() })
          .eq('id', item.id);
      }
    }
  }

  // 3. Apply identical fixes to Neon DB
  if (process.env.NEON_PRIMARY_HOST) {
    try {
      const neon = new Pool({
        host: process.env.NEON_PRIMARY_HOST,
        user: process.env.NEON_USER,
        password: process.env.NEON_PASSWORD,
        database: process.env.NEON_DATABASE,
        ssl: { rejectUnauthorized: false }
      });

      const neonRes = await neon.query(
        "UPDATE inventory SET quantity = 1, available_quantity = 1, updated_at = NOW() WHERE name ILIKE '%run cam%' RETURNING id, name, quantity, available_quantity"
      );
      console.log('✅ Updated RUN CAM in Neon:', neonRes.rows);

      const neonFixAll = await neon.query(
        "UPDATE inventory SET available_quantity = quantity, updated_at = NOW() WHERE available_quantity > quantity RETURNING id, name, quantity, available_quantity"
      );
      if (neonFixAll.rowCount > 0) {
        console.log(`✅ Clamped ${neonFixAll.rowCount} item(s) in Neon where available_quantity > quantity`);
      }

      await neon.end();
    } catch (e) {
      console.log('Neon error:', e.message);
    }
  }

  // 4. Invalidate Redis cache if available
  if (process.env.REDIS_URL) {
    try {
      const Redis = require('ioredis');
      const redis = new Redis(process.env.REDIS_URL);
      const keys = await redis.keys('cicr:cache:items:*');
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(`✅ Invalidated ${keys.length} item cache keys in Redis`);
      }
      await redis.quit();
    } catch (e) {
      console.log('Redis notice:', e.message);
    }
  }

  console.log('=== DATABASE INVENTORY QUANTITIES SYNCED SUCCESSFULLY ===');
}

fix().catch(console.error);
