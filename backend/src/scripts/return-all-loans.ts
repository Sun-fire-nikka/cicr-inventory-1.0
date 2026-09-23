import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

// Load backend/.env
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error('❌ Missing SUPABASE_URL or keys in backend/.env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false }
});

async function returnAllLoans() {
  console.log('🔄 Starting process to return all active loans and restock inventory...');

  try {
    // 1. Fetch all active borrow_records
    const { data: activeBorrows, error: fetchErr } = await supabase
      .from('borrow_records')
      .select('id, inventory_id, quantity, borrower_name, status')
      .neq('status', 'RETURNED');

    if (fetchErr) {
      console.warn('⚠️ Error fetching borrow_records:', fetchErr.message);
    } else {
      console.log(`📋 Found ${activeBorrows?.length || 0} active / pending borrow records.`);
    }

    // 2. Mark all borrow_records as RETURNED
    const nowIso = new Date().toISOString();
    const { data: updatedBorrows, error: updateBorrowErr } = await supabase
      .from('borrow_records')
      .update({
        status: 'RETURNED',
        returned_at: nowIso
      })
      .neq('status', 'RETURNED')
      .select('id');

    if (updateBorrowErr) {
      console.error('❌ Failed to update borrow_records:', updateBorrowErr.message);
    } else {
      console.log(`✅ Successfully marked ${updatedBorrows?.length || 0} borrow records as RETURNED.`);
    }

    // 3. Restock all inventory items (set available_quantity = quantity)
    const { data: allItems, error: itemsErr } = await supabase
      .from('inventory')
      .select('id, name, quantity, available_quantity');

    if (itemsErr) {
      console.error('❌ Failed to fetch inventory items:', itemsErr.message);
    } else if (allItems) {
      let restockedCount = 0;
      for (const item of allItems) {
        const total = Number(item.quantity) || 0;
        const currentAvail = Number(item.available_quantity) || 0;
        if (currentAvail !== total) {
          const { error: restockErr } = await supabase
            .from('inventory')
            .update({
              available_quantity: total,
              updated_at: nowIso
            })
            .eq('id', item.id);

          if (!restockErr) {
            restockedCount++;
          }
        }
      }
      console.log(`✅ Restocked ${restockedCount} items to full available capacity (${allItems.length} total items in vault).`);
    }

    // 4. Update hardware_requests.json if it exists
    const possiblePaths = [
      path.resolve(process.cwd(), 'backend', 'hardware_requests.json'),
      path.resolve(process.cwd(), 'hardware_requests.json'),
      path.resolve(__dirname, '..', '..', '..', 'hardware_requests.json')
    ];

    for (const reqPath of possiblePaths) {
      if (fs.existsSync(reqPath)) {
        try {
          const content = fs.readFileSync(reqPath, 'utf8');
          const data = JSON.parse(content);
          if (Array.isArray(data)) {
            data.forEach((r: any) => {
              if (r.status !== 'REJECTED') {
                r.status = 'RETURNED';
                r.returnedAt = nowIso;
                r.reviewedBy = 'Vardaan Saxena';
              }
            });
            fs.writeFileSync(reqPath, JSON.stringify(data, null, 2));
            console.log(`✅ Updated ${data.length} requests in ${reqPath}`);
          }
        } catch (e: any) {
          console.warn(`Could not update ${reqPath}:`, e.message);
        }
      }
    }

    // 5. Insert audit log
    try {
      await supabase.from('audit_logs').insert({
        action: 'All Loans Returned & Restocked',
        description: 'Administrator marked all student active loans as returned and restored 100% component availability in Vault.',
        timestamp: nowIso
      });
      console.log('✅ Created audit log record.');
    } catch (e: any) {
      console.warn('Audit log insert note:', e.message);
    }

    console.log('🎉 Finished! All loans have been returned, and all inventory items are 100% restocked.');
  } catch (err: any) {
    console.error('Fatal error during loan return:', err);
  }
}

returnAllLoans().then(() => process.exit(0));
