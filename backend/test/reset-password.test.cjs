const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

// H-2 regression: resetPassword must fail closed when the stored credential
// is missing. DB access is stubbed (no network, no state mutation); real
// bcrypt is used so verification semantics are authentic.
const dbModule = require('../dist/config/database.js');
const { resetPassword } = require('../dist/modules/auth/auth.controller.js');

const WRONG_PASSWORD_MESSAGE =
  'Current password is incorrect. Please verify and re-enter your existing password.';

let stubUser = null;
let updateCalled = false;
let capturedUpdate = null;

const chain = {
  select() { return chain; },
  eq() { return chain; },
  ilike() { return chain; },
  async maybeSingle() { return { data: stubUser }; },
  async insert() { return { error: null }; },
  update(data) {
    updateCalled = true;
    capturedUpdate = data;
    return { eq: async () => ({ error: null }) };
  },
};

dbModule.dbRead.from = () => chain;
dbModule.dbWrite.from = () => chain;

function mockRes() {
  const res = {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function resetStubs(user) {
  stubUser = user;
  updateCalled = false;
  capturedUpdate = null;
}

const baseUser = {
  id: 'user-1',
  name: 'Test Student',
  email: 'student1@mail.jiit.ac.in',
};

const VALID_HASH = bcrypt.hashSync('correct-password', 4);

test('A+D. valid hash + correct current password updates to a working new hash', async () => {
  resetStubs({ ...baseUser, password_hash: VALID_HASH });
  const res = mockRes();
  await resetPassword(
    { body: { identifier: baseUser.email, new_password: 'brand-new-password', current_password: 'correct-password' } },
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(updateCalled, true);
  assert.ok(capturedUpdate && typeof capturedUpdate.password_hash === 'string');
  assert.equal(bcrypt.compareSync('brand-new-password', capturedUpdate.password_hash), true);
  assert.equal(bcrypt.compareSync('correct-password', capturedUpdate.password_hash), false);
});

test('B. valid hash + wrong current password is rejected without update', async () => {
  resetStubs({ ...baseUser, password_hash: VALID_HASH });
  const res = mockRes();
  await resetPassword(
    { body: { identifier: baseUser.email, new_password: 'brand-new-password', current_password: 'wrong-password' } },
    res
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, WRONG_PASSWORD_MESSAGE);
  assert.equal(updateCalled, false);
});

test('C1. NULL password_hash cannot reach the password update', async () => {
  resetStubs({ ...baseUser, password_hash: null });
  const res = mockRes();
  await resetPassword(
    { body: { identifier: baseUser.email, new_password: 'attacker-chosen', current_password: 'anything-at-all' } },
    res
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, WRONG_PASSWORD_MESSAGE);
  assert.equal(updateCalled, false);
});

test('C2. empty password_hash cannot reach the password update', async () => {
  resetStubs({ ...baseUser, password_hash: '' });
  const res = mockRes();
  await resetPassword(
    { body: { identifier: baseUser.email, new_password: 'attacker-chosen', current_password: 'anything-at-all' } },
    res
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, WRONG_PASSWORD_MESSAGE);
  assert.equal(updateCalled, false);
});

test('C3. missing current_password is rejected without update', async () => {
  resetStubs({ ...baseUser, password_hash: VALID_HASH });
  const res = mockRes();
  await resetPassword(
    { body: { identifier: baseUser.email, new_password: 'brand-new-password' } },
    res
  );
  assert.equal(res.statusCode, 400);
  assert.equal(updateCalled, false);
});
