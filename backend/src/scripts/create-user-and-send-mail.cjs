/**
 * Provision Juhi Singh account and send interactive responsive onboarding email
 */
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const MEMBER_DATA = {
  name: 'Juhi Singh',
  email: 'jeg262274@mail.jiit.ac.in',
  roll_number: 'JEG262274',
  batch: 'F27',
  branch: 'AI & ML',
  role: 'MEMBER',
  tempPassword: 'Juhi@CICR2026!'
};

async function provisionAndSendMail() {
  console.log('════════════════════════════════════════════════════════');
  console.log('🚀 CICR: PROVISIONING ACCOUNT & SENDING WELCOME EMAIL');
  console.log('👤 Name:', MEMBER_DATA.name);
  console.log('📧 Email:', MEMBER_DATA.email);
  console.log('🎓 Roll/ID:', MEMBER_DATA.roll_number);
  console.log('🏷️  Batch / Dept:', MEMBER_DATA.batch, MEMBER_DATA.branch);
  console.log('════════════════════════════════════════════════════════\n');

  // 1. Hash temporary password
  const salt = bcrypt.genSaltSync(10);
  const password_hash = bcrypt.hashSync(MEMBER_DATA.tempPassword, salt);

  // 2. Check if user exists in Supabase
  console.log('1️⃣  Checking Supabase database...');
  const { data: existingUser, error: checkErr } = await supabase
    .from('users')
    .select('id, name, email, roll_number, role')
    .or(`email.ilike.${MEMBER_DATA.email},roll_number.ilike.${MEMBER_DATA.roll_number}`)
    .maybeSingle();

  if (checkErr) {
    console.error('   ❌ Error querying Supabase:', checkErr.message);
  }

  let finalUserId = null;

  if (existingUser) {
    console.log(`   ℹ️ User already exists (ID: ${existingUser.id}). Updating profile and password hash...`);
    const { data: updated, error: updErr } = await supabase
      .from('users')
      .update({
        name: MEMBER_DATA.name,
        email: MEMBER_DATA.email.toLowerCase(),
        roll_number: MEMBER_DATA.roll_number,
        role: MEMBER_DATA.role,
        password_hash
      })
      .eq('id', existingUser.id)
      .select('id')
      .single();

    if (updErr) {
      console.error('   ❌ Update failed:', updErr.message);
    } else {
      finalUserId = updated.id;
      console.log('   ✅ User profile and password updated in Supabase.');
    }
  } else {
    console.log('   ➕ Creating new user in Supabase...');
    const { data: inserted, error: insErr } = await supabase
      .from('users')
      .insert([{
        name: MEMBER_DATA.name,
        email: MEMBER_DATA.email.toLowerCase(),
        roll_number: MEMBER_DATA.roll_number,
        role: MEMBER_DATA.role,
        password_hash,
        created_at: new Date().toISOString()
      }])
      .select('id')
      .single();

    if (insErr) {
      console.error('   ❌ Insert failed:', insErr.message);
      process.exit(1);
    } else {
      finalUserId = inserted.id;
      console.log(`   ✅ User created successfully in Supabase (ID: ${inserted.id}).`);
    }
  }

  // 3. Update user_approval_data.json
  console.log('\n2️⃣  Syncing user approval cache...');
  const approvalFile = path.resolve(__dirname, '../../user_approval_data.json');
  try {
    let approvalDoc = { approvalState: {}, purgedEmails: [] };
    if (fs.existsSync(approvalFile)) {
      approvalDoc = JSON.parse(fs.readFileSync(approvalFile, 'utf8'));
      if (!approvalDoc.approvalState) approvalDoc.approvalState = {};
    }

    approvalDoc.approvalState[MEMBER_DATA.email.toLowerCase()] = {
      status: 'APPROVED',
      role: 'MEMBER',
      approvedAt: new Date().toISOString(),
      approvedBy: 'ADMINISTRATOR ONBOARDING',
      name: MEMBER_DATA.name,
      roll_number: MEMBER_DATA.roll_number,
      batch: `${MEMBER_DATA.batch} ${MEMBER_DATA.branch}`
    };

    fs.writeFileSync(approvalFile, JSON.stringify(approvalDoc, null, 2), 'utf8');
    console.log('   ✅ user_approval_data.json synchronized.');
  } catch (err) {
    console.warn('   ⚠️ Failed to update user_approval_data.json:', err.message);
  }

  // 4. Send Interactive & Responsive Email via Nodemailer
  console.log('\n3️⃣  Dispatching Interactive Onboarding Email...');

  const smtpUser = process.env.SMTP_USER || 'cicrinventory@gmail.com';
  const smtpPass = (process.env.SMTP_PASS || '').replace(/\s+/g, '');
  const portalUrl = process.env.FRONTEND_URL || process.env.CLIENT_URL || 'https://cicr-inventory.vercel.app/';

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
    tls: {
      rejectUnauthorized: false
    }
  });

  const emailHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to CICR Inventory Vault</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #05070c;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #e2e8f0;
      -webkit-font-smoothing: antialiased;
    }
    .wrapper {
      width: 100%;
      background-color: #05070c;
      padding: 40px 16px;
      box-sizing: border-box;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      background: #0b0f19;
      border: 1px solid #1e293b;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.65), 0 0 30px rgba(0, 240, 255, 0.08);
    }
    .header {
      padding: 32px 32px 24px;
      background: linear-gradient(180deg, #101726 0%, #0b0f19 100%);
      border-bottom: 1px solid #1e293b;
      text-align: center;
    }
    .logo-badge {
      display: inline-block;
      width: 64px;
      height: 64px;
      border-radius: 14px;
      background: #05070c;
      border: 1px solid rgba(0, 240, 255, 0.3);
      padding: 4px;
      box-shadow: 0 0 20px rgba(0, 240, 255, 0.25);
      margin-bottom: 16px;
    }
    .logo-badge img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }
    .brand-title {
      font-family: 'Courier New', Courier, monospace;
      font-size: 20px;
      font-weight: 800;
      letter-spacing: 2px;
      color: #ffffff;
      margin: 0 0 6px;
      text-transform: uppercase;
    }
    .brand-title span {
      color: #00f0ff;
    }
    .brand-sub {
      font-size: 11px;
      color: #94a3b8;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      margin: 0;
      font-family: 'Courier New', Courier, monospace;
    }
    .body-content {
      padding: 32px;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      padding: 5px 12px;
      border-radius: 9999px;
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
      font-family: 'Courier New', Courier, monospace;
      background: rgba(57, 255, 20, 0.1);
      color: #39ff14;
      border: 1px solid rgba(57, 255, 20, 0.3);
      margin-bottom: 20px;
    }
    .hero-title {
      font-size: 22px;
      font-weight: 700;
      color: #ffffff;
      margin: 0 0 10px;
      line-height: 1.3;
    }
    .hero-desc {
      font-size: 14px;
      color: #94a3b8;
      line-height: 1.6;
      margin: 0 0 24px;
    }
    .card-box {
      background: #060810;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 24px;
    }
    .info-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .info-table tr td {
      padding: 8px 4px;
      border-bottom: 1px solid #141c2c;
    }
    .info-table tr:last-child td {
      border-bottom: none;
    }
    .info-label {
      color: #64748b;
      font-family: 'Courier New', Courier, monospace;
      font-weight: 600;
      width: 140px;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.5px;
    }
    .info-value {
      color: #f1f5f9;
      font-weight: 600;
    }
    .credentials-box {
      background: linear-gradient(135deg, rgba(0, 240, 255, 0.08) 0%, rgba(139, 92, 246, 0.08) 100%);
      border: 1px solid rgba(0, 240, 255, 0.35);
      border-radius: 8px;
      padding: 22px;
      text-align: center;
      margin-bottom: 26px;
    }
    .cred-title {
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 1.5px;
      color: #00f0ff;
      text-transform: uppercase;
      font-family: 'Courier New', Courier, monospace;
      margin-bottom: 12px;
    }
    .password-badge {
      font-family: 'Courier New', Courier, monospace;
      font-size: 22px;
      font-weight: 800;
      letter-spacing: 2px;
      color: #ffffff;
      background: #05070e;
      display: inline-block;
      padding: 12px 28px;
      border-radius: 6px;
      border: 1px solid rgba(0, 240, 255, 0.5);
      box-shadow: 0 0 20px rgba(0, 240, 255, 0.25);
      user-select: all;
    }
    .cred-hint {
      font-size: 12px;
      color: #94a3b8;
      margin-top: 12px;
      line-height: 1.5;
    }
    .features-grid {
      display: table;
      width: 100%;
      margin-bottom: 24px;
    }
    .feature-item {
      display: table-cell;
      width: 33.33%;
      padding: 12px;
      background: #090d16;
      border: 1px solid #172133;
      border-radius: 6px;
      text-align: center;
      vertical-align: top;
      box-sizing: border-box;
    }
    .feature-item:not(:last-child) {
      margin-right: 8px;
    }
    .feature-icon {
      font-size: 20px;
      margin-bottom: 6px;
    }
    .feature-name {
      font-size: 12px;
      font-weight: 700;
      color: #ffffff;
      margin-bottom: 4px;
    }
    .feature-desc {
      font-size: 10.5px;
      color: #64748b;
      line-height: 1.4;
    }
    .cta-container {
      text-align: center;
      margin: 32px 0 16px;
    }
    .cta-btn {
      display: inline-block;
      background: linear-gradient(90deg, #00f0ff 0%, #00c8ff 100%);
      color: #060911 !important;
      text-decoration: none;
      font-weight: 800;
      font-size: 13px;
      letter-spacing: 1px;
      text-transform: uppercase;
      padding: 14px 34px;
      border-radius: 6px;
      font-family: 'Courier New', Courier, monospace;
      box-shadow: 0 0 24px rgba(0, 240, 255, 0.45);
    }
    .security-notice {
      background: rgba(250, 204, 21, 0.07);
      border-left: 3px solid #facc15;
      padding: 14px 16px;
      border-radius: 4px;
      font-size: 12px;
      color: #cbd5e1;
      margin-top: 24px;
      line-height: 1.5;
    }
    .footer {
      padding: 24px 32px;
      background: #070a12;
      border-top: 1px solid #1e293b;
      font-family: 'Courier New', Courier, monospace;
      font-size: 10px;
      color: #64748b;
      line-height: 1.6;
      text-align: center;
    }
    .footer strong {
      color: #94a3b8;
    }
    @media only screen and (max-width: 600px) {
      .container { border-radius: 0; }
      .body-content { padding: 20px; }
      .feature-item { display: block; width: 100%; margin-bottom: 8px; }
      .password-badge { font-size: 18px; padding: 10px 18px; }
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      
      <!-- Header -->
      <div class="header">
        <div class="logo-badge">
          <img src="https://cicr-inventory.vercel.app/logo.png" alt="CICR Logo" width="56" height="56">
        </div>
        <h2 class="brand-title">CICR <span>//</span> INVENTORY</h2>
        <p class="brand-sub">Creative & Innovative Cell in Robotics &bull; JIIT-128</p>
      </div>

      <!-- Main Body -->
      <div class="body-content">
        
        <!-- Status Indicator -->
        <div>
          <span class="status-pill">&#9679; MEMBERSHIP ONBOARDING // ACTIVE</span>
        </div>

        <h1 class="hero-title">Welcome to the Vault, Juhi!</h1>
        <p class="hero-desc">
          Your official member account has been provisioned on the <strong>CICR Robotics Inventory Portal</strong>. You now have full access to explore laboratory assets, issue microcontrollers & sensors, and manage component allocations.
        </p>

        <!-- Credentials Spotlight -->
        <div class="credentials-box">
          <div class="cred-title">// YOUR LOGIN CREDENTIALS</div>
          <div style="font-size:13px; color:#cbd5e1; margin-bottom:12px;">
            Portal Login ID: <strong style="color:#00f0ff;">${MEMBER_DATA.email}</strong>
          </div>
          <div class="password-badge">${MEMBER_DATA.tempPassword}</div>
          <div class="cred-hint">
            You can sign in using either your college email (<strong>${MEMBER_DATA.email}</strong>) or enrollment number (<strong>${MEMBER_DATA.roll_number}</strong>).
          </div>
        </div>

        <!-- Member Profile Dossier -->
        <div class="card-box">
          <div style="font-size:11px; font-weight:700; color:#00f0ff; letter-spacing:1px; margin-bottom:12px; font-family:'Courier New', Courier, monospace; text-transform:uppercase;">
            &gt; OFFICIAL OPERATOR DOSSIER
          </div>
          <table class="info-table">
            <tr>
              <td class="info-label">Full Name</td>
              <td class="info-value">${MEMBER_DATA.name}</td>
            </tr>
            <tr>
              <td class="info-label">Enrollment No</td>
              <td class="info-value" style="font-family:'Courier New', Courier, monospace; color:#00f0ff;">${MEMBER_DATA.roll_number}</td>
            </tr>
            <tr>
              <td class="info-label">Batch & Section</td>
              <td class="info-value">${MEMBER_DATA.batch}</td>
            </tr>
            <tr>
              <td class="info-label">Department</td>
              <td class="info-value">${MEMBER_DATA.branch}</td>
            </tr>
            <tr>
              <td class="info-label">Access Role</td>
              <td class="info-value"><span style="color:#39ff14; background:rgba(57,255,20,0.1); padding:2px 8px; border-radius:4px; font-size:11px;">MEMBER (APPROVED)</span></td>
            </tr>
            <tr>
              <td class="info-label">Portal Access</td>
              <td class="info-value"><span style="color:#00f0ff;">Full Hardware Catalog & Requisition</span></td>
            </tr>
          </table>
        </div>

        <!-- Portal Capability Features -->
        <div style="margin-bottom: 24px;">
          <div style="font-size:11px; font-weight:700; color:#94a3b8; letter-spacing:1px; margin-bottom:12px; font-family:'Courier New', Courier, monospace; text-transform:uppercase;">
            &gt; WHAT YOU CAN DO IN THE VAULT
          </div>
          <table style="width:100%; border-collapse:separate; border-spacing:6px 0;">
            <tr>
              <td style="background:#080c14; border:1px solid #1a2436; border-radius:8px; padding:14px; text-align:center; width:33.3%;">
                <div style="font-size:22px; margin-bottom:6px;">⚡</div>
                <div style="font-size:12px; font-weight:700; color:#ffffff; margin-bottom:4px;">Hardware Vault</div>
                <div style="font-size:10.5px; color:#64748b; line-height:1.4;">Browse ESP32, STM32, sensors & actuators.</div>
              </td>
              <td style="background:#080c14; border:1px solid #1a2436; border-radius:8px; padding:14px; text-align:center; width:33.3%;">
                <div style="font-size:22px; margin-bottom:6px;">📋</div>
                <div style="font-size:12px; font-weight:700; color:#ffffff; margin-bottom:4px;">Issue Requests</div>
                <div style="font-size:10.5px; color:#64748b; line-height:1.4;">Request hardware with 1-click admin OTP.</div>
              </td>
              <td style="background:#080c14; border:1px solid #1a2436; border-radius:8px; padding:14px; text-align:center; width:33.3%;">
                <div style="font-size:22px; margin-bottom:6px;">🔐</div>
                <div style="font-size:12px; font-weight:700; color:#ffffff; margin-bottom:4px;">Vault Profile</div>
                <div style="font-size:10.5px; color:#64748b; line-height:1.4;">Track borrowed units & return deadlines.</div>
              </td>
            </tr>
          </table>
        </div>

        <!-- Primary CTA -->
        <div class="cta-container">
          <a href="${portalUrl}" class="cta-btn" target="_blank">
            Sign In to CICR Portal &rarr;
          </a>
        </div>

        <!-- Security Advisory -->
        <div class="security-notice">
          <strong style="color:#facc15;">Security Advisory:</strong> Please log in to the portal and use the key icon in your profile widget at the bottom of the sidebar to <strong>change your password</strong> to a private password immediately.
        </div>

      </div>

      <!-- Footer -->
      <div class="footer">
        <div><strong>CREATIVE & INNOVATIVE CELL IN ROBOTICS (CICR)</strong></div>
        <div style="margin-top:2px;">Robotics Lab &bull; Jaypee Institute of Information Technology, Sector 128 Noida</div>
        <div style="color:#475569; margin-top:6px;">This is an authenticated system notification sent to ${MEMBER_DATA.email}.</div>
      </div>

    </div>
  </div>
</body>
</html>
  `;

  const mailOptions = {
    from: `"CICR Inventory" <${smtpUser}>`,
    replyTo: `"CICR Support" <${smtpUser}>`,
    to: MEMBER_DATA.email,
    subject: `Welcome to CICR Inventory Vault — Your Account & Access Credentials`,
    headers: {
      'X-Entity-Ref-ID': `cicr-welcome-${Date.now()}`,
      'X-Priority': '1 (Highest)',
      'Importance': 'High',
      'X-Mailer': 'CICR-Robotics-MailEngine/v2.0'
    },
    priority: 'high',
    text: [
      `CICR ROBOTICS VAULT // ACCOUNT PROVISIONED`,
      `================================================`,
      `Welcome ${MEMBER_DATA.name},`,
      ``,
      `Your account has been provisioned on the CICR Robotics Inventory Vault.`,
      `Name: ${MEMBER_DATA.name}`,
      `Enrollment / ID: ${MEMBER_DATA.roll_number}`,
      `Batch: ${MEMBER_DATA.batch} (${MEMBER_DATA.branch})`,
      `Email: ${MEMBER_DATA.email}`,
      `Role: MEMBER (APPROVED)`,
      ``,
      `YOUR LOGIN CREDENTIALS:`,
      `Username / Email: ${MEMBER_DATA.email} (or ${MEMBER_DATA.roll_number})`,
      `Temporary Password: ${MEMBER_DATA.tempPassword}`,
      ``,
      `Sign In Portal: ${portalUrl}`,
      ``,
      `Please log in and reset your temporary password immediately from your profile widget.`,
      ``,
      `Regards,`,
      `Creative & Innovative Cell in Robotics (CICR)`,
      `Jaypee Institute of Information Technology, Sector 128`
    ].join('\n'),
    html: emailHtml
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('   ✅ Email successfully dispatched via SMTP!');
    console.log('   📫 Message ID:', info.messageId);
    console.log('   👥 Accepted Recipient(s):', info.accepted);
    console.log('   📬 Response:', info.response);
  } catch (mailErr) {
    console.error('   ❌ SMTP Dispatch failed:', mailErr.message);
  }

  console.log('\n✨ All steps complete for Juhi Singh!');
}

provisionAndSendMail().catch(err => {
  console.error('Fatal error in provision script:', err);
  process.exit(1);
});
