const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// H-3 mutation + issuance coverage: password/role writers must rotate
// token_version, and login must bind the JWT to the row version.
// DB is stubbed (no network, no mutation); real bcrypt is used.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_tests_only';

const dbModule = require('../dist/config/database.js');
const { login, changePassword, changeUserRole, deleteUser } = require('../dist/modules/auth/auth.controller.js');
// Test hygiene: userApprovalService is file-backed global state shared across
// test processes. Approval writers (login auto-approve, setUserRole,
// deleteUserApproval) persist entries that would otherwise leak ADMIN roles
// or purged flags into later runs, so every email used here is cleaned up.
const { deleteUserApproval, unpurgeEmail } = require('../dist/modules/auth/userApprovalService.js');
const cleanTestEmail = (email) => { deleteUserApproval(email); unpurgeEmail(email); };

let readRow = null;
let readTable = null;
const capturedWrites = [];

function makeChain() {
  const c = {
    select() { return c; },
    eq() { return c; },
    ilike() { return c; },
    or() { return c; },
    limit() { return c; },
    delete() { return c; },
    insert() { return c; },
    update(data) { capturedWrites.push(data); return c; },
    async single() {
      return readRow ? { data: readRow, error: null } : { data: null, error: { message: 'Row not found', code: 'PGRST116' } };
    },
    async maybeSingle() {
      return { data: readRow };
    },
    then(resolve) { resolve({ data: [], error: null }); },
  };
  return c;
}

dbModule.dbRead.from = (table) => { readTable = table; return makeChain(); };
dbModule.dbWrite.from = () => makeChain();

function mockRes() {
  const res = {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function resetState(row) {
  readRow = row;
  capturedWrites.length = 0;
}

const memberRow = (overrides = {}) => ({
  id: 'user-h3',
  name: 'H3 Student',
  email: 'h3student@mail.jiit.ac.in',
  roll_number: '992501030077',
  role: 'MEMBER',
  token_version: 7,
  password_hash: bcrypt.hashSync('correct-password', 4),
  ...overrides,
});

test('H-3 issuance: login binds the JWT tv to the row token_version', async () => {
  resetState(memberRow());
  const res = mockRes();
  try {
    await login({ body: { identifier: 'h3student@mail.jiit.ac.in', password: 'correct-password' }, headers: {}, ip: '127.0.0.1' }, res);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.token);
    const decoded = jwt.decode(res.body.token);
    assert.equal(decoded.tv, 7);
    assert.equal(decoded.role, 'MEMBER');
    assert.equal(decoded.id, 'user-h3');
  } finally {
    cleanTestEmail('h3student@mail.jiit.ac.in');
  }
});

test('H-3 writer: resetPassword rotates token_version', async () => {
  resetState(memberRow());
  const { resetPassword } = require('../dist/modules/auth/auth.controller.js');
  const res = mockRes();
  await resetPassword(
    { body: { identifier: 'h3student@mail.jiit.ac.in', current_password: 'correct-password', new_password: 'brand-new-password' } },
    res
  );
  assert.equal(res.statusCode, 200);
  const tvWrites = capturedWrites.filter((w) => 'token_version' in w);
  assert.equal(tvWrites.length, 1);
  assert.equal(typeof tvWrites[0].token_version, 'number');
  assert.notEqual(tvWrites[0].token_version, 7);
  assert.ok('password_hash' in tvWrites[0]);
});

test('H-3 writer: changePassword rotates token_version', async () => {
  resetState(memberRow());
  const res = mockRes();
  await changePassword(
    { user: { id: 'user-h3' }, body: { current_password: 'correct-password', new_password: 'another-new-password' } },
    res
  );
  assert.equal(res.statusCode, 200);
  const tvWrites = capturedWrites.filter((w) => 'token_version' in w);
  assert.equal(tvWrites.length, 1);
  assert.equal(typeof tvWrites[0].token_version, 'number');
  assert.notEqual(tvWrites[0].token_version, 7);
});

test('H-3 writer: changeUserRole rotates token_version', async () => {
  // Distinct identity: the real changeUserRole persists role ADMIN for the
  // email in the shared file-backed approval store.
  const target = memberRow({ id: 'user-h3-role', email: 'h3role@mail.jiit.ac.in' });
  resetState(target);
  const res = mockRes();
  try {
    await changeUserRole(
      { params: { id: 'user-h3-role' }, body: { role: 'ADMIN' }, user: { id: 'admin-1', name: 'Admin' } },
      res
    );
    assert.equal(res.statusCode, 200);
    const tvWrites = capturedWrites.filter((w) => 'token_version' in w);
    assert.equal(tvWrites.length, 1);
    assert.equal(tvWrites[0].role, 'ADMIN');
    assert.equal(typeof tvWrites[0].token_version, 'number');
    assert.notEqual(tvWrites[0].token_version, 7);
  } finally {
    cleanTestEmail(target.email);
  }
});

test('H-3 writer: deleteUser performs no token_version write (row removal invalidates)', async () => {
  // Distinct address: the real deleteUser purges the email from the shared
  // file-backed approval store, so the issuance identity must not be reused.
  const target = memberRow({ id: 'user-h3-del', email: 'h3delete@mail.jiit.ac.in' });
  resetState(target);
  const res = mockRes();
  try {
    await deleteUser({ params: { id: 'user-h3-del' }, user: { id: 'admin-1', name: 'Admin' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(capturedWrites.filter((w) => 'token_version' in w).length, 0);
  } finally {
    unpurgeEmail(target.email);
  }
});
