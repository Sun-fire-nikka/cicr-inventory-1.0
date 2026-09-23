const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

// M-1 regression: GET /api/audit is admin-only. Exercises the real route
// middleware chain (authenticateToken -> requireAdmin -> getAuditLogs) with a
// stubbed read layer (no network, no mutation).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_tests_only';
const SECRET = process.env.JWT_SECRET;

const dbModule = require('../dist/config/database.js');
const { authenticateToken, requireAdmin } = require('../dist/middleware/auth.middleware.js');
const { getAuditLogs } = require('../dist/modules/dashboard/dashboard.controller.js');

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
