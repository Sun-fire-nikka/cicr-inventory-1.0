const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// M-7 regression: adminCreateUser validation parity (password length, email
// syntax, protected identity, duplicate/error hygiene) while preserving the
// intentional ADMIN -> ADMIN capability. Real route chain
// (authenticateToken -> requireAdmin -> adminCreateUser), stubbed data layer.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_tests_only';
const SECRET = process.env.JWT_SECRET;

const dbModule = require('../dist/config/database.js');
const { authenticateToken, requireAdmin } = require('../dist/middleware/auth.middleware.js');
const { adminCreateUser } = require('../dist/modules/auth/auth.controller.js');
const { deleteUserApproval, unpurgeEmail } = require('../dist/modules/auth/userApprovalService.js');

const cleanEmail = (email) => { deleteUserApproval(email); unpurgeEmail(email); };

// Programmable fixtures: duplicate-check row and insert outcome.
let duplicateRow = null;
let insertOutcome = { mode: 'ok' };
const capturedInserts = [];

function readChain() {
  const c = {
    select() { return c; },
    eq() { return c; },
    or() { return c; },
    limit() { return c; },
    async single() {
      return { data: { id: 'admin-1', token_version: 1 }, error: null };
    },
    async maybeSingle() {
      return { data: duplicateRow };
    },
  };
  return c;
}

function writeChain() {
  const c = {
    update(data) { capturedInserts.push(data); return c; },
    insert(rows) { capturedInserts.push(rows); return c; },
    eq() { return c; },
    select() { return c; },
    async single() {
      if (insertOutcome.mode === 'ok') {
        return {
          data: {
            id: 'new-m7-user',
            name: 'M Seven',
            email: insertOutcome.email,
            roll_number: null,
            role: insertOutcome.role,
            created_at: new Date().toISOString(),
          },
          error: null,
        };
      }
      return { data: null, error: insertOutcome.error };
    },
    then(resolve) { resolve({ data: [], error: null }); },
  };
  return c;
}

dbModule.dbRead.from = () => readChain();
dbModule.dbWrite.from = () => writeChain();

const sign = (role) =>
  jwt.sign({ id: 'admin-1', email: 'admin@cicr.test', name: 'Admin', role, tv: 1 }, SECRET, { expiresIn: '1h' });

function mockRes() {
  const res = {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function resetFixtures() {
  duplicateRow = null;
  insertOutcome = { mode: 'ok' };
  capturedInserts.length = 0;
}

async function runPost(token, body) {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, body };
  const res = mockRes();
  let authed = false;
  await authenticateToken(req, res, () => { authed = true; });
  if (!authed) return { res, stage: 'authenticate' };
  let authorized = false;
  requireAdmin(req, res, () => { authorized = true; });
  if (!authorized) return { res, stage: 'authorize' };
  await adminCreateUser(req, res);
  return { res, stage: 'handler' };
}

const baseBody = (overrides = {}) => ({
  name: 'M Seven',
  email: 'm7-member@m7-test.local',
  password: 'temp-pass-123',
  ...overrides,
});

test('M-7 unauthenticated request returns 401', async () => {
  resetFixtures();
  const { res, stage } = await runPost(null, baseBody());
  assert.equal(stage, 'authenticate');
  assert.equal(res.statusCode, 401);
});

test('M-7 MEMBER returns 403', async () => {
  resetFixtures();
  const { res, stage } = await runPost(sign('MEMBER'), baseBody());
  assert.equal(stage, 'authorize');
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /Admin access required/);
});

test('M-7 ADMIN creates MEMBER with 201', async () => {
  resetFixtures();
  insertOutcome = { mode: 'ok', email: 'm7-member@m7-test.local', role: 'MEMBER' };
  try {
    const { res, stage } = await runPost(sign('ADMIN'), baseBody());
    assert.equal(stage, 'handler');
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.data.role, 'MEMBER');
    assert.equal(res.body.data.status, 'APPROVED');
  } finally {
    cleanEmail('m7-member@m7-test.local');
  }
});

test('M-7 ADMIN creates ADMIN with 201 (intentionally permitted)', async () => {
  resetFixtures();
  insertOutcome = { mode: 'ok', email: 'm7-admin@m7-test.local', role: 'ADMIN' };
  try {
    const { res } = await runPost(sign('ADMIN'), baseBody({ email: 'm7-admin@m7-test.local', role: 'ADMIN' }));
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.data.role, 'ADMIN');
  } finally {
    cleanEmail('m7-admin@m7-test.local');
  }
});

test('M-7 invalid role falls back to MEMBER', async () => {
  resetFixtures();
  insertOutcome = { mode: 'ok', email: 'm7-weird@m7-test.local', role: 'MEMBER' };
  try {
    const { res } = await runPost(sign('ADMIN'), baseBody({ email: 'm7-weird@m7-test.local', role: 'SUPERADMIN' }));
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.data.role, 'MEMBER');
  } finally {
    cleanEmail('m7-weird@m7-test.local');
  }
});

test('M-7 password shorter than 6 returns 400', async () => {
  resetFixtures();
  const { res } = await runPost(sign('ADMIN'), baseBody({ password: 'abc' }));
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /at least 6 characters/);
});

test('M-7 malformed email returns 400', async () => {
  resetFixtures();
  for (const bad of ['not-an-email', 'a@b', '@x.y', 'a b@c.de']) {
    const { res } = await runPost(sign('ADMIN'), baseBody({ email: bad }));
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /Invalid email format/);
  }
});

test('M-7 protected email with ADMIN role returns 400', async () => {
  resetFixtures();
  const { res } = await runPost(
    sign('ADMIN'),
    baseBody({ email: 'mahakkatahara.mk@gmail.com', role: 'ADMIN' })
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /not permitted to hold an ADMIN role/);
});

test('M-7 duplicate email returns 400', async () => {
  resetFixtures();
  duplicateRow = { id: 'existing', email: 'm7-dup@m7-test.local', roll_number: null };
  const { res } = await runPost(sign('ADMIN'), baseBody({ email: 'm7-dup@m7-test.local' }));
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /already exists/);
});

test('M-7 simulated 23505 insert race returns 400 duplicate', async () => {
  resetFixtures();
  insertOutcome = { mode: 'error', error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
  const { res } = await runPost(sign('ADMIN'), baseBody({ email: 'm7-race@m7-test.local' }));
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /already exists/);
  cleanEmail('m7-race@m7-test.local');
});

test('M-7 generic DB error returns 500 without driver text', async () => {
  resetFixtures();
  insertOutcome = { mode: 'error', error: { code: 'PGRST500', message: 'driver secret text' } };
  const { res } = await runPost(sign('ADMIN'), baseBody({ email: 'm7-err@m7-test.local' }));
  assert.equal(res.statusCode, 500);
  assert.doesNotMatch(JSON.stringify(res.body), /driver secret text/);
  cleanEmail('m7-err@m7-test.local');
});

test('M-7 created password is bcrypt-verifiable and no token is issued', async () => {
  resetFixtures();
  insertOutcome = { mode: 'ok', email: 'm7-verify@m7-test.local', role: 'MEMBER' };
  try {
    const { res } = await runPost(sign('ADMIN'), baseBody({ email: 'm7-verify@m7-test.local', password: 'verify-me-123' }));
    assert.equal(res.statusCode, 201);
    const userRows = capturedInserts.filter((w) => Array.isArray(w) && w[0] && w[0].password_hash);
    assert.equal(userRows.length, 1);
    assert.equal(bcrypt.compareSync('verify-me-123', userRows[0][0].password_hash), true);
    assert.equal(res.body.token, undefined);
    assert.equal(res.body.data && res.body.data.token, undefined);
  } finally {
    cleanEmail('m7-verify@m7-test.local');
  }
});

test('M-7 audit behavior preserved for admin provisioning', async () => {
  resetFixtures();
  insertOutcome = { mode: 'ok', email: 'm7-audit@m7-test.local', role: 'MEMBER' };
  try {
    const { res } = await runPost(sign('ADMIN'), baseBody({ email: 'm7-audit@m7-test.local' }));
    assert.equal(res.statusCode, 201);
    const auditRows = capturedInserts.filter((w) => Array.isArray(w) && w[0] && w[0].action === 'Admin Created User');
    assert.equal(auditRows.length, 1);
    assert.ok(auditRows[0][0].description.includes('m7-audit@m7-test.local'));
  } finally {
    cleanEmail('m7-audit@m7-test.local');
  }
});
