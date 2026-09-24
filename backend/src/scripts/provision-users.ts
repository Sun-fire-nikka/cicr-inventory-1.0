import { createClient } from '@supabase/supabase-js';
import * as bcrypt from 'bcryptjs';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { setUserApproval, isDesignatedAdmin } from '../modules/auth/userApprovalService';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_KEY must be set in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export interface UserProvisionData {
  name: string;
  email: string;
  roll_number?: string | null;
  batch?: string | null;
  role?: 'ADMIN' | 'MEMBER';
}

const DEFAULT_TEMP_PASSWORD = process.env.DEFAULT_TEMP_PASSWORD || process.env.TEMP_PASSWORD || '';

const TARGET_USERS: UserProvisionData[] = [
  {
    name: 'Parivisha Midha',
    email: '992501040035@mail.jiit.ac.in',
    roll_number: '992501040035',
    batch: 'H2 IT',
    role: 'MEMBER'
  },
  {
    name: 'Mahak Katahara',
    email: '992501030398@mail.jiit.ac.in',
    roll_number: '992501030398',
    batch: 'F7 CSE',
    role: 'MEMBER'
  },
  {
    name: 'Kushagra Garg',
    email: '992501030406@mail.jiit.ac.in',
    roll_number: '992501030406',
    batch: 'F7 CSE',
    role: 'MEMBER'
  },
  {
    name: 'Tanisha',
    email: '992501040037@mail.jiit.ac.in',
    roll_number: '992501040037',
    batch: 'H2 IT',
    role: 'MEMBER'
  },
  {
    name: 'Utsavi Sinha',
    email: '992501210022@mail.jiit.ac.in',
    roll_number: '992501210022',
    batch: 'E1 ECM',
    role: 'MEMBER'
  },
  {
    name: 'Agamjot Singh',
    email: '992501030404@mail.jiit.ac.in',
    roll_number: '992501030404',
    batch: 'F7 CSE',
    role: 'MEMBER'
  },
  {
    name: 'Tushar Goyal',
    email: '992501210081@mail.jiit.ac.in',
    roll_number: '992501210081',
    batch: 'E3 ECM',
    role: 'MEMBER'
  },
  {
    name: 'Ashutosh Singh',
    email: '992501210030@mail.jiit.ac.in',
    roll_number: '992501210030',
    batch: 'E1 ECM',
    role: 'MEMBER'
  },
  {
    name: 'Kanan Goyal',
    email: '992510170013@mail.jiit.ac.in',
    roll_number: '992510170013',
    batch: 'MCA1',
    role: 'MEMBER'
  },
  {
    name: 'Dhruvi Gupta',
    email: '992401030123@mail.jiit.ac.in',
    roll_number: '992401030123',
    batch: 'Management Head',
    role: 'ADMIN'
  },
  {
    name: 'Aryan Varshney',
    email: '992401030154@mail.jiit.ac.in',
    roll_number: '992401030154',
    batch: 'Coordinator, CICR',
    role: 'ADMIN'
  },
  {
    name: 'Gunjan Pal',
    email: '992401210050@mail.jiit.ac.in',
    roll_number: '992401210050',
    batch: 'Management Head',
    role: 'ADMIN'
  }
];

export async function provisionUsers(userList: UserProvisionData[]) {
  const passwordToUse = DEFAULT_TEMP_PASSWORD;
  const salt = await bcrypt.genSalt(10);
  const password_hash = await bcrypt.hash(passwordToUse, salt);

  console.log(`\n======================================================`);
  console.log(`[PROVISIONING] Creating ${userList.length} accounts in Supabase database`);
  console.log(`Password: "${passwordToUse}" (NO EMAILS OR OTP SENT)`);
  console.log(`======================================================\n`);

  const results: any[] = [];

  for (let i = 0; i < userList.length; i++) {
    const user = userList[i];
    const normEmail = user.email.trim().toLowerCase();
    const cleanName = user.name.trim();

    // Auto extract roll number
    let roll = user.roll_number ? String(user.roll_number).trim() : null;
    if (!roll) {
      const match = normEmail.match(/^(\d+)@mail\.jiit\.ac\.in$/i);
      if (match) roll = match[1];
    }

    // H-1 FIX: Role assignment uses the exact allow-list email only; name never grants ADMIN.
    const isSpecialAdmin = isDesignatedAdmin(normEmail);
    const assignedRole: 'ADMIN' | 'MEMBER' = user.role || (isSpecialAdmin ? 'ADMIN' : 'MEMBER');

    console.log(`[${i + 1}/${userList.length}] Provisioning ${cleanName} (${normEmail}) -> Role: ${assignedRole}`);

    // Check if user exists
    const { data: existing } = await supabase
      .from('users')
      .select('id, name, email, roll_number, role')
      .eq('email', normEmail)
      .maybeSingle();

    let finalUser: any = null;

    if (existing) {
      const { data: updated, error: updErr } = await supabase
        .from('users')
        .update({
          name: cleanName,
          password_hash,
          roll_number: roll,
          role: assignedRole,
          updated_at: new Date().toISOString()
        })
        .eq('id', existing.id)
        .select('id, name, email, roll_number, role')
        .single();

      if (updErr) {
        console.error(`  ❌ Failed to update user in Supabase:`, updErr.message);
        continue;
      }
      finalUser = updated;
      console.log(`  ✅ Updated in Supabase (id: ${existing.id})`);
    } else {
      const { data: inserted, error: insErr } = await supabase
        .from('users')
        .insert([{
          name: cleanName,
          email: normEmail,
          password_hash,
          roll_number: roll,
          role: assignedRole
        }])
        .select('id, name, email, roll_number, role')
        .single();

      if (insErr) {
        console.error(`  ❌ Failed to insert user in Supabase:`, insErr.message);
        continue;
      }
      finalUser = inserted;
      console.log(`  ✅ Created in Supabase (id: ${inserted.id})`);
    }

    // Auto-approve in state
    setUserApproval(normEmail, 'APPROVED', 'SYSTEM (AUTO-APPROVE)', {
      name: cleanName,
      username: cleanName.toLowerCase().replace(/\s+/g, ''),
      roll_number: roll,
      batch: user.batch
    });

    results.push({ ...finalUser, role: assignedRole, status: 'APPROVED' });
  }

  console.log(`\n======================================================`);
  console.log(`[COMPLETE] Successfully provisioned ${results.length} accounts!`);
  console.log(`======================================================\n`);
  return results;
}

if (require.main === module) {
  provisionUsers(TARGET_USERS)
    .then(() => {
      console.log('Finished successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Error:', err);
      process.exit(1);
    });
}
