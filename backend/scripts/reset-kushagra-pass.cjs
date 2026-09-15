const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_KEY missing in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function run() {
  console.log('=== RESETTING PASSWORD FOR KUSHAGRA ===');
  const targetPassword = 'CICR_INVENTORY@1234';
  const targetEmail = '992501030406@mail.jiit.ac.in';
  const targetRoll = '992501030406';

  const salt = await bcrypt.genSalt(10);
  const password_hash = await bcrypt.hash(targetPassword, salt);

  console.log(`Generated bcrypt hash for "${targetPassword}"`);

  // Search users table
  const { data: users, error: searchErr } = await supabase
    .from('users')
    .select('id, name, email, role, roll_number')
    .or(`email.ilike.%kushagra%,name.ilike.%kushagra%,roll_number.eq.${targetRoll},email.eq.${targetEmail}`);

  if (searchErr) {
    console.error('Search error in Supabase:', searchErr);
    process.exit(1);
  }

  console.log(`Matching users found:`, users);

  if (!users || users.length === 0) {
    console.log(`Creating user record for Kushagra Garg...`);
    const { data: inserted, error: insErr } = await supabase
      .from('users')
      .insert([{
        name: 'Kushagra Garg',
        email: targetEmail,
        password_hash,
        roll_number: targetRoll,
        role: 'MEMBER'
      }])
      .select('id, name, email, role, roll_number')
      .single();

    if (insErr) {
      console.error('Insert error:', insErr);
      process.exit(1);
    }
    console.log('✅ Created user:', inserted);
  } else {
    for (const u of users) {
      const { data: updated, error: updErr } = await supabase
        .from('users')
        .update({
          password_hash
        })
        .eq('id', u.id)
        .select('id, name, email, role, roll_number')
        .single();

      if (updErr) {
        console.error(`Failed to update ${u.id}:`, updErr);
      } else {
        console.log(`✅ Updated password for ${updated.name} (id: ${updated.id}, email: ${updated.email})`);
      }
    }
  }

  // Also check Neon database if Neon is configured
  if (process.env.NEON_PRIMARY_HOST && process.env.NEON_USER && process.env.NEON_PASSWORD) {
    try {
      const { Pool } = require('pg');
      const neonPool = new Pool({
        host: process.env.NEON_PRIMARY_HOST,
        user: process.env.NEON_USER,
        password: process.env.NEON_PASSWORD,
        database: process.env.NEON_DATABASE || 'neondb',
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 5000
      });
      const neonRes = await neonPool.query(
        `UPDATE users SET password_hash = $1 WHERE email ILIKE '%kushagra%' OR name ILIKE '%kushagra%' OR email = $2 OR roll_number = $3 RETURNING id, name, email`,
        [password_hash, targetEmail, targetRoll]
      );
      console.log(`✅ Updated in Neon database (${neonRes.rowCount} row(s))`);
      await neonPool.end();
    } catch (neonErr) {
      console.log('Note: Neon update skipped/failed:', neonErr.message);
    }
  }

  // Verify from Supabase read
  const { data: verifyUser } = await supabase
    .from('users')
    .select('id, name, email, role, roll_number, password_hash')
    .eq('email', targetEmail)
    .single();

  const isMatch = await bcrypt.compare(targetPassword, verifyUser.password_hash);
  console.log(`\nVerification Check against DB record:`);
  console.log(`  User: ${verifyUser.name} (${verifyUser.email})`);
  console.log(`  Role: ${verifyUser.role}`);
  console.log(`  Password Match: ${isMatch ? 'SUCCESS (Match confirmed ✅)' : 'FAILED ❌'}`);
  console.log(`\n===========================================`);
  console.log(`LOGIN DETAILS FOR KUSHAGRA:`);
  console.log(`  Identifier: ${verifyUser.email} (or "kushagra" / "Kushagra Garg")`);
  console.log(`  Password:   ${targetPassword}`);
  console.log(`===========================================\n`);
}

run().catch(console.error);
