const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

// M-4 regression: POST /api/borrow/return admin restock must read a real row
// (.single, not a rows array) and apply the restore through the CAS retry
// loop. Stubbed data layer with honest conditional-write semantics.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_tests_only';
const SECRET = process.env.JWT_SECRET;

const dbModule = require('../dist/config/database.js');
const { authenticateToken, requireAdmin } = require('../dist/middleware/auth.middleware.js');
const { returnItem } = require('../dist/modules/borrow/borrow.controller.js');

let borrowRecord;
let inventoryRow;
let lastEqId = null;
let inventoryWrites;
let borrowUpdateCaptured;
let conditionalQueue;

function resetState() {
  borrowRecord = {
    id: 'b1',
    inventory_id: 'i1',
    quantity: 2,
    status: 'BORROWED',
    borrower_name: 'Stu',
    user_id: null,
    inventory: { name: 'Sensor' },
  };
  inventoryRow = { id: 'i1', quantity: 10, available_quantity: 6 };
  lastEqId = null;
  inventoryWrites = [];
  borrowUpdateCaptured = null;
  conditionalQueue = [];
}

function readChain(table) {
  const c = {
    select() { return c; },
    eq(col, val) { if (col === 'id') lastEqId = val; return c; },
    async single() {
      if (table === 'users') return { data: { id: lastEqId, token_version: 1 }, error: null };
      if (table === 'borrow_records') {
        return borrowRecord
          ? { data: { ...borrowRecord }, error: null }
          : { data: null, error: { message: 'Row not found', code: 'PGRST116' } };
      }
      if (table === 'inventory') return { data: { ...inventoryRow }, error: null };
      return { data: null, error: { message: 'Row not found', code: 'PGRST116' } };
    },
    async maybeSingle() {
      if (table === 'borrow_records') {
        return { data: borrowRecord ? { ...borrowRecord } : null };
      }
      return { data: null };
    },
  };
  return c;
}

function writeChain(table) {
  const c = {
    pendingUpdate: null,
    condAvail: undefined,
    update(data) { c.pendingUpdate = { table, data }; return c; },
    eq(col, val) {
      if (table === 'inventory' && col === 'available_quantity') c.condAvail = val;
      return c;
    },
    select() { return c; },
    insert() { return Promise.resolve({ error: null }); },
    async single() {
      if (table === 'borrow_records') {
        borrowUpdateCaptured = c.pendingUpdate ? c.pendingUpdate.data : null;
        return {
          data: { ...borrowRecord, status: 'RETURNED', returned_at: new Date().toISOString() },
          error: null,
        };
      }
      return { data: null, error: null };
    },
    then(resolve) {
      if (table === 'inventory') {
        inventoryWrites.push({ data: c.pendingUpdate.data, condAvail: c.condAvail });
        if (conditionalQueue.length > 0) {
          resolve(conditionalQueue.shift());
          return;
        }
        // Honest CAS: conditional write succeeds only on a version match.
        if (c.condAvail === undefined || c.condAvail === inventoryRow.available_quantity) {
          Object.assign(inventoryRow, c.pendingUpdate.data);
          resolve({ data: [{ available_quantity: inventoryRow.available_quantity }], error: null });
        } else {
          resolve({ data: [], error: null });
        }
      } else {
        resolve({ data: [], error: null });
      }
    },
  };
  return c;
}

dbModule.dbRead.from = (table) => readChain(table);
dbModule.dbWrite.from = (table) => writeChain(table);

const adminJwt = () =>
  jwt.sign({ id: 'admin-1', email: 'admin@cicr.test', role: 'ADMIN', tv: 1 }, SECRET, { expiresIn: '1h' });
const memberJwt = () =>
  jwt.sign({ id: 'member-1', email: 'member@cicr.test', role: 'MEMBER', tv: 1 }, SECRET, { expiresIn: '1h' });

function mockRes() {
  const res = {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

// Drive POST /api/borrow/return: any authenticated caller, admin gated inside.
async function runReturn(token, body) {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, body };
  const res = mockRes();
  let authed = false;
  await authenticateToken(req, res, () => { authed = true; });
  if (!authed) return { res, stage: 'authenticate' };
  await returnItem(req, res);
  return { res, stage: 'handler' };
}

test('M-4 a. normal restock restores 6 + 2 to 8', async () => {
  resetState();
  const { res, stage } = await runReturn(adminJwt(), { borrow_id: 'b1' });
  assert.equal(stage, 'handler');
  assert.equal(res.statusCode, 200);
  assert.equal(inventoryWrites.length, 1);
  assert.equal(inventoryWrites[0].data.available_quantity, 8);
  assert.equal(inventoryWrites[0].condAvail, 6);
  assert.equal(inventoryRow.available_quantity, 8);
});

test('M-4 b. restock is capped at total stock', async () => {
  resetState();
  inventoryRow.available_quantity = 9;
  const { res } = await runReturn(adminJwt(), { borrow_id: 'b1' });
  assert.equal(res.statusCode, 200);
  assert.equal(inventoryWrites[0].data.available_quantity, 10);
});

test('M-4 c. CAS miss retries once and then succeeds', async () => {
  resetState();
  conditionalQueue.push({ data: [], error: null });
  conditionalQueue.push({ data: [{ available_quantity: 8 }], error: null });
  const { res } = await runReturn(adminJwt(), { borrow_id: 'b1' });
  assert.equal(res.statusCode, 200);
  assert.equal(inventoryWrites.length, 2);
  assert.equal(inventoryWrites[0].condAvail, 6);
  assert.equal(inventoryWrites[1].condAvail, 6);
});

test('M-4 d. CAS contention exhaustion returns 409', async () => {
  resetState();
  for (let i = 0; i < 5; i += 1) conditionalQueue.push({ data: [], error: null });
  const { res } = await runReturn(adminJwt(), { borrow_id: 'b1' });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /contention/i);
  assert.equal(inventoryWrites.length, 5);
});

test('M-4 e. double return remains 400', async () => {
  resetState();
  borrowRecord.status = 'RETURNED';
  const { res } = await runReturn(adminJwt(), { borrow_id: 'b1' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /already been returned/);
  assert.equal(inventoryWrites.length, 0);
});

test('M-4 f. MEMBER remains on the 202 approval workflow', async () => {
  resetState();
  borrowRecord.user_id = 'member-1';
  const { res, stage } = await runReturn(memberJwt(), { borrow_id: 'b1' });
  assert.equal(stage, 'handler');
  assert.equal(res.statusCode, 202);
  assert.match(res.body.message, /Admin approval/);
  assert.equal(inventoryWrites.length, 0);
});

test('M-4 g. partial return decrements the record and restocks the difference', async () => {
  resetState();
  borrowRecord.quantity = 5;
  const { res } = await runReturn(adminJwt(), { borrow_id: 'b1', returnQuantity: 2 });
  assert.equal(res.statusCode, 200);
  assert.equal(borrowUpdateCaptured.quantity, 3);
  assert.equal(inventoryWrites.length, 1);
  assert.equal(inventoryWrites[0].data.available_quantity, 8);
  assert.equal(inventoryRow.available_quantity, 8);
});
