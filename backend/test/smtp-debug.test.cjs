const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

// M-5 regression: GET /api/smtp-debug is admin-only. Exercises the real
// Express route chain (authenticateToken -> requireAdmin -> handler) with a
// stubbed user lookup (no database, no mutation).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_tests_only';
const SECRET = process.env.JWT_SECRET;

const dbModule = require('../dist/config/database.js');

dbModule.dbRead.from = () => {
  const c = {
    select() { return c; },
    eq() { return c; },
    async single() {
      return { data: { id: 'u-admin', token_version: 1 }, error: null };
    },
  };
  return c;
};

const { default: app } = require('../dist/app.js');

let server;
let base;

before(async () => {
  await new Promise((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
});

const sign = (id, role) =>
  jwt.sign({ id, email: `${id}@cicr.test`, role, tv: 1 }, SECRET, { expiresIn: '1h' });

async function get(token) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api/smtp-debug`, { headers });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

test('M-5 unauthenticated GET /api/smtp-debug returns 401', async () => {
  const { status } = await get(null);
  assert.equal(status, 401);
});

test('M-5 MEMBER GET /api/smtp-debug returns 403', async () => {
  const { status, json } = await get(sign('u-member', 'MEMBER'));
  assert.equal(status, 403);
  assert.match(json.message, /Admin access required/);
});

test('M-5 ADMIN GET /api/smtp-debug preserves diagnostic behavior without secret values', async () => {
  const { status, json } = await get(sign('u-admin', 'ADMIN'));
  assert.equal(status, 200);
  // Existing diagnostic shape intact.
  assert.ok('tcp_587' in json);
  assert.ok('tcp_465' in json);
  assert.equal(typeof json.smtp_user_set, 'boolean');
  assert.equal(typeof json.smtp_pass_set, 'boolean');
  // No secret material: only presence booleans, never values.
  const serialized = JSON.stringify(json);
  assert.doesNotMatch(serialized, /"smtp_user"(?!_set)|"smtp_pass"(?!_set)|"password"/);
});
