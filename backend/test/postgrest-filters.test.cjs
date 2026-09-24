const { test } = require('node:test');
const assert = require('node:assert/strict');

// M-6 behavioral regression: hostile filter metacharacters must not reshape
// PostgREST queries. Stubbed data layer capturing the constructed filter
// strings (no network, no mutation); real controllers and real bcrypt.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_tests_only';

const dbModule = require('../dist/config/database.js');
const { login, register } = require('../dist/modules/auth/auth.controller.js');
const { getItems } = require('../dist/modules/inventory/inventory.controller.js');
const { getAuditLogs } = require('../dist/modules/dashboard/dashboard.controller.js');
const { getBorrowHistory } = require('../dist/modules/borrow/borrow.controller.js');
const { getUserHardwareRequests } = require('../dist/modules/borrow/hardwareRequestService.js');
const { deleteUserApproval, unpurgeEmail } = require('../dist/modules/auth/userApprovalService.js');

const captured = { or: [], ilike: [] };
let newUserSeq = 0;

function readChain() {
  const c = {
    select() { return c; },
    eq() { return c; },
    neq() { return c; },
    in() { return c; },
    gte() { return c; },
    lt() { return c; },
    lte() { return c; },
    order() { return c; },
    order() { return c; },
    limit() { return c; },
    ilike(col, val) { captured.ilike.push({ col, val }); return c; },
    or(val) { captured.or.push(val); return c; },
    async single() { return { data: null, error: { message: 'Row not found', code: 'PGRST116' } }; },
    async maybeSingle() { return { data: null }; },
    then(resolve) { resolve({ data: [], error: null }); },
  };
  return c;
}

const capturedWrites = [];
function writeChain() {
  const c = {
    update(data) { capturedWrites.push(data); return c; },
    insert(rows) { capturedWrites.push(rows); return c; },
    eq() { return c; },
    select() { return c; },
    async single() {
      newUserSeq += 1;
      return {
        data: {
          id: `new-user-${newUserSeq}`,
          name: 'M Six',
          email: 'm6reg@mail.jiit.ac.in',
          roll_number: '12,34',
          role: 'MEMBER',
          created_at: new Date().toISOString(),
        },
        error: null,
      };
    },
    then(resolve) { resolve({ data: [], error: null }); },
  };
  return c;
}

dbModule.dbRead.from = () => readChain();
dbModule.dbWrite.from = () => writeChain();

function mockRes() {
  const res = {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.setHeader = () => {};
  return res;
}

function resetCapture() {
  captured.or.length = 0;
  captured.ilike.length = 0;
  capturedWrites.length = 0;
}

test('M-6 hostile login identifier cannot inject OR branches (401, no 500)', async () => {
  resetCapture();
  const res = mockRes();
  await login(
    { body: { identifier: '%,role.eq.ADMIN', password: 'whatever' }, headers: {}, ip: '127.0.0.1' },
    res
  );
  assert.equal(res.statusCode, 401);
  assert.equal(captured.or.length, 1);
  assert.doesNotMatch(captured.or[0], /,role\.eq\./);
  assert.doesNotMatch(captured.or[0], /[()]/);
});

test('M-6 hostile registration roll keeps the duplicate lookup structurally valid', async () => {
  resetCapture();
  const res = mockRes();
  const email = 'm6reg@mail.jiit.ac.in';
  try {
    await register(
      { body: { name: 'M Six', email, password: 'password123', roll_number: '12,34' } },
      res
    );
    assert.equal(res.statusCode, 201);
    assert.equal(captured.or.length, 1);
    // The raw comma must not split the lookup into extra branches.
    assert.equal(captured.or[0].split(',').length, 2);
    assert.ok(captured.or[0].includes('roll_number.eq.1234'));
  } finally {
    deleteUserApproval(email);
    unpurgeEmail(email);
  }
});

test('M-6 hostile inventory search succeeds without parser failure', async () => {
  resetCapture();
  const res = mockRes();
  await getItems({ query: { search: '%=(test)' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(captured.or.length, 1);
  assert.doesNotMatch(captured.or[0], /[()]/);
  assert.ok(captured.or[0].includes('\\%'));
});

test('M-6 hostile inventory category succeeds with escaped wildcard', async () => {
  resetCapture();
  const res = mockRes();
  await getItems({ query: { category: 'a%b,c' } }, res);
  assert.equal(res.statusCode, 200);
  const cat = captured.ilike.find((f) => f.col === 'category');
  assert.ok(cat);
  assert.ok(cat.val.includes('\\%'));
});

test('M-6 hostile admin dashboard search succeeds with sanitized filter', async () => {
  resetCapture();
  const res = mockRes();
  await getAuditLogs(
    { query: { search: 'x),(y' }, user: { id: 'u-admin', role: 'ADMIN' } },
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(captured.or.length, 1);
  assert.doesNotMatch(captured.or[0], /[()]/);
});

test('M-6 member history scoping is unchanged for clean input', async () => {
  resetCapture();
  const res = mockRes();
  await getBorrowHistory(
    {
      user: { id: 'member-1', role: 'MEMBER', email: 'm@cicr.test', name: 'Mem', roll_number: 'r1' },
      query: { force: 'true' },
    },
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(captured.or.length, 1);
  assert.equal(captured.or[0], 'user_id.eq.member-1,roll_number.eq.r1');
});

test('M-6 hardware-request history sanitizes hostile roll input', async () => {
  resetCapture();
  const rows = await getUserHardwareRequests({
    userId: 'm6hwuser',
    email: 'm6hw@mail.jiit.ac.in',
    rollNumber: 'r(1,2',
  });
  assert.ok(Array.isArray(rows));
  assert.equal(captured.or.length, 1);
  assert.equal(captured.or[0], 'user_id.eq.m6hwuser,roll_number.eq.r12');
});
