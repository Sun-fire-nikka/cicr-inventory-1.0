const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

// M-3 regression: PATCH /api/items/:id must accept only the documented
// fields, validate numerics, and enforce 0 <= available_quantity <= quantity.
// Drives the real route chain (authenticateToken -> requireAdmin -> updateItem)
// with a stubbed data layer (no network, no mutation).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_tests_only';
const SECRET = process.env.JWT_SECRET;

const dbModule = require('../dist/config/database.js');
const { authenticateToken, requireAdmin } = require('../dist/middleware/auth.middleware.js');
const { updateItem } = require('../dist/modules/inventory/inventory.controller.js');

const EXISTING = {
  id: 'item-1',
  name: 'Old Name',
  description: 'Old desc',
  category: 'Tools',
  location: 'Rack A',
  quantity: 10,
  available_quantity: 6,
  created_at: '2026-01-01T00:00:00.000Z',
};

let lastColumns = '';
let capturedUpdate = null;
let updateCalled = false;

const chain = {
  select(cols) { lastColumns = typeof cols === 'string' ? cols : '*'; return chain; },
  eq() { return chain; },
  async single() {
    if (lastColumns.includes('token_version')) {
      return { data: { id: 'u-admin', token_version: 1 }, error: null };
    }
    return { data: { ...EXISTING }, error: null };
  },
  update(data) {
    updateCalled = true;
    capturedUpdate = data;
    return chain;
  },
  insert() { return Promise.resolve({ error: null }); },
  then(resolve) {
    // Awaited write path: resolve the merged row like the real client.
    resolve({ data: { ...EXISTING, ...(capturedUpdate || {}) }, error: null });
  },
};

dbModule.dbRead.from = () => chain;
dbModule.dbWrite.from = () => chain;

const sign = (role) =>
  jwt.sign({ id: 'u-admin', email: 'admin@cicr.test', role, tv: 1 }, SECRET, { expiresIn: '1h' });

function mockRes() {
  const res = {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function resetCapture() {
  capturedUpdate = null;
  updateCalled = false;
}

// Drive the exact route chain with an admin/member/none identity.
async function runPatch(token, body) {
  resetCapture();
  const req = {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    params: { id: 'item-1' },
    body,
  };
  const res = mockRes();
  let authed = false;
  await authenticateToken(req, res, () => { authed = true; });
  if (!authed) return { res, stage: 'authenticate' };
  let authorized = false;
  requireAdmin(req, res, () => { authorized = true; });
  if (!authorized) return { res, stage: 'authorize' };
  await updateItem(req, res);
  return { res, stage: 'handler' };
}

// ---- A. documented fields ----------------------------------------------------

test('M-3 A. admin can update documented scalar fields', async () => {
  const { res, stage } = await runPatch(sign('ADMIN'), {
    name: 'Arduino',
    description: 'New desc',
    category: 'Controllers',
    location: 'Rack B',
  });
  assert.equal(stage, 'handler');
  assert.equal(res.statusCode, 200);
  assert.equal(capturedUpdate.name, 'Arduino');
  assert.equal(capturedUpdate.description, 'New desc');
  assert.equal(capturedUpdate.category, 'Controllers');
  assert.equal(capturedUpdate.location, 'Rack B');
  assert.ok(capturedUpdate.updated_at);
});

test('M-3 A. admin can update quantity with diff recalculation', async () => {
  const { res } = await runPatch(sign('ADMIN'), { quantity: 8 });
  assert.equal(res.statusCode, 200);
  assert.equal(capturedUpdate.quantity, 8);
  assert.equal(capturedUpdate.available_quantity, 4); // 6 + (8 - 10)
});

test('M-3 A. admin can update available_quantity within bounds', async () => {
  const { res } = await runPatch(sign('ADMIN'), { available_quantity: 4 });
  assert.equal(res.statusCode, 200);
  assert.equal(capturedUpdate.available_quantity, 4);
});

// ---- B. mass-assignment protection --------------------------------------------

test('M-3 B. protected and unknown fields are ignored, never stored', async () => {
  const { res } = await runPatch(sign('ADMIN'), {
    name: 'Arduino',
    id: 'attacker-id',
    created_at: 'fake',
    updated_at: 'fake-client-value',
    image: 'should-not-change',
    tags: ['should-not-change'],
    randomField: 'ignored',
  });
  assert.equal(res.statusCode, 200);
  const keys = Object.keys(capturedUpdate).sort();
  assert.deepEqual(keys, ['name', 'updated_at']);
  assert.equal(capturedUpdate.name, 'Arduino');
  assert.notEqual(capturedUpdate.updated_at, 'fake-client-value');
  assert.equal(res.body.data.id, 'item-1');
  assert.equal(res.body.data.created_at, EXISTING.created_at);
});

// ---- C. available_quantity invariant -------------------------------------------

test('M-3 C. negative available_quantity returns 400 with no write', async () => {
  const { res } = await runPatch(sign('ADMIN'), { available_quantity: -1 });
  assert.equal(res.statusCode, 400);
  assert.equal(updateCalled, false);
});

test('M-3 C. available_quantity above 10000 returns 400 with no write', async () => {
  const { res } = await runPatch(sign('ADMIN'), { available_quantity: 10001 });
  assert.equal(res.statusCode, 400);
  assert.equal(updateCalled, false);
});

test('M-3 C. available_quantity above quantity is clamped to quantity', async () => {
  const { res } = await runPatch(sign('ADMIN'), { available_quantity: 20 });
  assert.equal(res.statusCode, 200);
  assert.equal(capturedUpdate.available_quantity, 10); // clamped to existing quantity
});

test('M-3 C. explicit available with new quantity clamps to the new quantity', async () => {
  const { res } = await runPatch(sign('ADMIN'), { quantity: 8, available_quantity: 20 });
  assert.equal(res.statusCode, 200);
  assert.equal(capturedUpdate.quantity, 8);
  assert.equal(capturedUpdate.available_quantity, 8);
});

// ---- D. quantity validation -----------------------------------------------------

test('M-3 D. non-numeric quantity returns 400 with no write', async () => {
  const { res } = await runPatch(sign('ADMIN'), { quantity: 'abc' });
  assert.equal(res.statusCode, 400);
  assert.equal(updateCalled, false);
});

test('M-3 D. NaN and Infinity quantities never reach the database', async () => {
  for (const bad of [NaN, Infinity, -Infinity, 1.5, 0, 10001, null, true]) {
    const { res } = await runPatch(sign('ADMIN'), { quantity: bad });
    assert.equal(res.statusCode, 400);
    assert.equal(updateCalled, false);
  }
});

test('M-3 D. numeric strings that convert cleanly remain accepted', async () => {
  const { res } = await runPatch(sign('ADMIN'), { quantity: '8' });
  assert.equal(res.statusCode, 200);
  assert.equal(capturedUpdate.quantity, 8);
});

// ---- E. existing recalculation preserved ------------------------------------------

test('M-3 E. quantity-only increase shifts availability by the same diff', async () => {
  const { res } = await runPatch(sign('ADMIN'), { quantity: 14 });
  assert.equal(res.statusCode, 200);
  assert.equal(capturedUpdate.quantity, 14);
  assert.equal(capturedUpdate.available_quantity, 10); // 6 + (14 - 10)
});

// ---- F. authorization ---------------------------------------------------------------

test('M-3 F. unauthenticated PATCH returns 401', async () => {
  const { res, stage } = await runPatch(null, { name: 'Arduino' });
  assert.equal(stage, 'authenticate');
  assert.equal(res.statusCode, 401);
  assert.equal(updateCalled, false);
});

test('M-3 F. MEMBER PATCH returns 403', async () => {
  const { res, stage } = await runPatch(sign('MEMBER'), { name: 'Arduino' });
  assert.equal(stage, 'authorize');
  assert.equal(res.statusCode, 403);
  assert.equal(updateCalled, false);
});
