const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

// M-1 regression: GET /api/audit is admin-only. Exercises the real route
// middleware chain (authenticateToken -> requireAdmin -> getAuditLogs) with a
// stubbed read layer (no network, no mutation).
// M-2 regression: POST /api/audit is admin-only. Exercises the real route
// middleware chain (authenticateToken -> requireAdmin -> createAuditEvent)
// with a stubbed write layer; every insert is captured and counted.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_tests_only';
const SECRET = process.env.JWT_SECRET;

const dbModule = require('../dist/config/database.js');
const { authenticateToken, requireAdmin } = require('../dist/middleware/auth.middleware.js');
const { getAuditLogs, createAuditEvent } = require('../dist/modules/dashboard/dashboard.controller.js');
const { logAuditEvent } = require('../dist/services/auditService.js');

const USER_ROW = { id: 'u-admin', token_version: 1 };

const spectrumRows = [
  { id: 'a1', action: 'Sign In', timestamp: new Date().toISOString() },
];
const listRows = [
  {
    id: 'a1',
    action: 'Sign In',
    description: 'User authenticated: Admin (admin@cicr.test)',
    timestamp: new Date().toISOString(),
    users: { name: 'Admin', email: 'admin@cicr.test', role: 'ADMIN' },
    inventory: null,
  },
];

let thenCount = 0;

const chain = {
  select() { return chain; },
  eq() { return chain; },
  gte() { return chain; },
  lt() { return chain; },
  in() { return chain; },
  or() { return chain; },
  order() { return chain; },
  limit() { return chain; },
  async single() {
    return { data: USER_ROW, error: null };
  },
  then(resolve) {
    thenCount += 1;
    resolve({ data: thenCount % 2 === 1 ? spectrumRows : listRows, error: null });
  },
};

dbModule.dbRead.from = () => chain;

// M-2 write capture: every audit_logs insert is recorded; the audit service
// never throws, so inserts resolve cleanly like the production path.
const capturedInserts = [];
const writeChain = {
  insert(rows) {
    capturedInserts.push(rows);
    return Promise.resolve({ error: null });
  },
};

dbModule.dbWrite.from = () => writeChain;

const sign = (role) => jwt.sign({ id: USER_ROW.id, email: 'admin@cicr.test', role, tv: 1 }, SECRET, { expiresIn: '1h' });

function mockRes() {
  const res = {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

// Drive the exact route chain: authenticateToken -> requireAdmin -> getAuditLogs.
async function runChain(token) {
  thenCount = 0;
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, query: {} };
  const res = mockRes();
  let authed = false;
  await authenticateToken(req, res, () => { authed = true; });
  if (!authed) return { res, stage: 'authenticate', auditReads: thenCount };
  let authorized = false;
  requireAdmin(req, res, () => { authorized = true; });
  if (!authorized) return { res, stage: 'authorize', auditReads: thenCount };
  await getAuditLogs(req, res);
  return { res, stage: 'handler', auditReads: thenCount };
}

test('M-1 unauthenticated GET /api/audit returns 401 with no audit read', async () => {
  const { res, stage, auditReads } = await runChain(null);
  assert.equal(stage, 'authenticate');
  assert.equal(res.statusCode, 401);
  assert.equal(auditReads, 0);
});

test('M-1 MEMBER GET /api/audit returns 403 with no audit read', async () => {
  const { res, stage, auditReads } = await runChain(sign('MEMBER'));
  assert.equal(stage, 'authorize');
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /Admin access required/);
  assert.equal(auditReads, 0);
  assert.equal(res.body.data, undefined);
  assert.equal(res.body.categoryCounts, undefined);
  assert.equal(res.body.dailyCounts, undefined);
});

test('M-1 ADMIN GET /api/audit returns 200 with audit data and joins', async () => {
  const { res, stage } = await runChain(sign('ADMIN'));
  assert.equal(stage, 'handler');
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.data));
  assert.equal(res.body.data[0].users.email, 'admin@cicr.test');
  assert.ok(res.body.categoryCounts);
  assert.ok(Array.isArray(res.body.dailyCounts));
});

// Drive the exact POST route chain: authenticateToken -> requireAdmin -> createAuditEvent.
async function runPostChain(token, body) {
  capturedInserts.length = 0;
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, body };
  const res = mockRes();
  let authed = false;
  await authenticateToken(req, res, () => { authed = true; });
  if (!authed) return { res, stage: 'authenticate', auditWrites: capturedInserts.length };
  let authorized = false;
  requireAdmin(req, res, () => { authorized = true; });
  if (!authorized) return { res, stage: 'authorize', auditWrites: capturedInserts.length };
  await createAuditEvent(req, res);
  return { res, stage: 'handler', auditWrites: capturedInserts.length };
}

test('M-2 unauthenticated POST /api/audit returns 401 with zero writes', async () => {
  const { res, stage, auditWrites } = await runPostChain(null, { action: 'System Event', description: 'anon' });
  assert.equal(stage, 'authenticate');
  assert.equal(res.statusCode, 401);
  assert.equal(auditWrites, 0);
});

test('M-2 MEMBER POST /api/audit returns 403 with zero writes', async () => {
  const { res, stage, auditWrites } = await runPostChain(sign('MEMBER'), {
    action: 'User Approved',
    description: 'forged approval by member',
  });
  assert.equal(stage, 'authorize');
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /Admin access required/);
  assert.equal(auditWrites, 0);
});

test('M-2 ADMIN POST /api/audit returns 201 and forces user_id from the token', async () => {
  const { res, stage, auditWrites } = await runPostChain(sign('ADMIN'), {
    action: 'System Event',
    description: 'admin write check',
    userId: 'spoofed-id',
  });
  assert.equal(stage, 'handler');
  assert.equal(res.statusCode, 201);
  assert.equal(auditWrites, 1);
  const row = capturedInserts[0][0];
  assert.equal(row.user_id, USER_ROW.id);
  assert.equal(row.action, 'System Event');
  assert.equal(row.description, 'admin write check');
});

test('M-2 server-side member audit logging still works via logAuditEvent', async () => {
  capturedInserts.length = 0;
  await logAuditEvent({
    action: 'Borrowed',
    userId: 'member-1',
    itemId: null,
    description: 'Borrowed 1 units of "Sensor" for purpose: testing',
  });
  assert.equal(capturedInserts.length, 1);
  assert.equal(capturedInserts[0][0].user_id, 'member-1');
  assert.equal(capturedInserts[0][0].action, 'Borrowed');
});
