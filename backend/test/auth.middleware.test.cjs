const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

// Set JWT_SECRET before importing the middleware (it reads process.env at load time).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_tests_only';
const SECRET = process.env.JWT_SECRET;

// H-3: authenticateToken is async and performs a server-side token_version
// lookup. Stub dbRead so no test hits a real database.
const dbModule = require('../dist/config/database.js');

let lookupMode = 'missing'; // 'row' | 'missing' | 'throw'
let lookupRow = null;

const chain = {
  select() { return chain; },
  eq() { return chain; },
  async single() {
    if (lookupMode === 'throw') throw new Error('simulated-db-down');
    if (lookupMode === 'missing' || !lookupRow) {
      return { data: null, error: { message: 'Row not found', code: 'PGRST116' } };
    }
    return { data: lookupRow, error: null };
  },
};

dbModule.dbRead.from = () => chain;

const { authenticateToken, requireAdmin } = require('../dist/middleware/auth.middleware.js');

function mockRes() {
  const res = {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

const sign = (payload) => jwt.sign(payload, SECRET, { expiresIn: '1h' });

test('authenticateToken: missing token returns 401', async () => {
  lookupMode = 'missing';
  const res = mockRes();
  await authenticateToken({ headers: {} }, res, () => assert.fail('next should not be called'));
  assert.equal(res.statusCode, 401);
  assert.match(res.body.message, /Token missing/);
});

test('authenticateToken: invalid token returns 403', async () => {
  const res = mockRes();
  await authenticateToken({ headers: { authorization: 'Bearer not-a-real-token' } }, res, () => assert.fail('next should not be called'));
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /Invalid or expired token/);
});

test('authenticateToken: valid token + matching tv calls next and populates req.user', async () => {
  lookupMode = 'row';
  lookupRow = { id: 'u-test', token_version: 5 };
  const token = sign({ id: 'u-test', email: 'a@b.test', role: 'ADMIN', tv: 5 });
  let called = false;
  const req = { headers: { authorization: `Bearer ${token}` } };
  await authenticateToken(req, mockRes(), () => { called = true; });
  assert.equal(called, true);
  assert.equal(req.user.role, 'ADMIN');
  assert.equal(req.user.id, 'u-test');
});

test('authenticateToken: tv mismatch returns 403 without calling next', async () => {
  lookupMode = 'row';
  lookupRow = { id: 'u-test', token_version: 6 };
  const token = sign({ id: 'u-test', email: 'a@b.test', role: 'ADMIN', tv: 5 });
  const res = mockRes();
  await authenticateToken({ headers: { authorization: `Bearer ${token}` } }, res, () => assert.fail('next should not be called'));
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /Invalid or expired token/);
});

test('authenticateToken: token without tv is rejected', async () => {
  lookupMode = 'row';
  lookupRow = { id: 'u-test', token_version: 1 };
  const token = sign({ id: 'u-test', email: 'a@b.test', role: 'ADMIN' });
  const res = mockRes();
  await authenticateToken({ headers: { authorization: `Bearer ${token}` } }, res, () => assert.fail('next should not be called'));
  assert.equal(res.statusCode, 403);
});

test('authenticateToken: deleted/nonexistent user is rejected without leaking internals', async () => {
  lookupMode = 'missing';
  lookupRow = null;
  const token = sign({ id: 'u-gone', email: 'gone@b.test', role: 'ADMIN', tv: 5 });
  const res = mockRes();
  await authenticateToken({ headers: { authorization: `Bearer ${token}` } }, res, () => assert.fail('next should not be called'));
  assert.equal(res.statusCode, 401);
  assert.doesNotMatch(JSON.stringify(res.body), /PGRST116|Row not found/);
});

test('authenticateToken: database lookup failure fails closed without leaking the error', async () => {
  lookupMode = 'throw';
  const token = sign({ id: 'u-test', email: 'a@b.test', role: 'ADMIN', tv: 5 });
  const res = mockRes();
  await authenticateToken({ headers: { authorization: `Bearer ${token}` } }, res, () => assert.fail('next should not be called'));
  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(res.body), /simulated-db-down/);
});

test('authenticateToken: malformed tv values are rejected', async () => {
  lookupMode = 'row';
  lookupRow = { id: 'u-test', token_version: 5 };
  for (const badTv of ['5', 1.5, 0, -2, true, null]) {
    const token = sign({ id: 'u-test', email: 'a@b.test', role: 'ADMIN', tv: badTv });
    const res = mockRes();
    await authenticateToken({ headers: { authorization: `Bearer ${token}` } }, res, () => assert.fail('next should not be called'));
    assert.equal(res.statusCode, 403);
  }
});

test('authenticateToken: expired token returns 403', async () => {
  const token = jwt.sign({ id: 'u-test', role: 'MEMBER', tv: 1 }, SECRET, { expiresIn: '-1s' });
  const res = mockRes();
  await authenticateToken({ headers: { authorization: `Bearer ${token}` } }, res, () => assert.fail('next should not be called'));
  assert.equal(res.statusCode, 403);
});

test('requireAdmin: MEMBER gets 403', () => {
  const res = mockRes();
  requireAdmin({ user: { role: 'MEMBER' } }, res, () => assert.fail('next should not be called'));
  assert.equal(res.statusCode, 403);
});

test('requireAdmin: ADMIN passes through', () => {
  let called = false;
  requireAdmin({ user: { role: 'ADMIN' } }, mockRes(), () => { called = true; });
  assert.equal(called, true);
});
