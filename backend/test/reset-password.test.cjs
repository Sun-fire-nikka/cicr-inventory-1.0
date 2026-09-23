const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

// H-2 + H-2.2 regression: resetPassword must fail closed on a missing stored
// credential AND resolve identifiers by exact email / exact roll_number only.
// DB access is stubbed with exact-match semantics (no network, no mutation);
// real bcrypt is used so verification semantics are authentic.
const dbModule = require('../dist/config/database.js');
const { resetPassword } = require('../dist/modules/auth/auth.controller.js');

const WRONG_PASSWORD_MESSAGE =
  'Current password is incorrect. Please verify and re-enter your existing password.';

let stubUsers = [];
let updateCalled = false;
let capturedUpdate = null;
let eqQueries = [];
let ilikeCalled = false;

const chain = {
  select() { return chain; },
  eq(col, val) { eqQueries.push({ col, val }); return chain; },
  ilike() { ilikeCalled = true; return chain; },
  async maybeSingle() {
    // Emulate exact-match DB semantics: ALL recorded eq filters must match.
    const found =
      stubUsers.find((u) =>
        eqQueries.every(({ col, val }) => {
          if (col === 'email') return (u.email || '').toLowerCase() === val;
          if (col === 'roll_number') return u.roll_number === val;
          return false;
        })
      ) || null;
    eqQueries = [];
    return { data: found };
  },
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

function resetStubs(users) {
  stubUsers = users;
  updateCalled = false;
  capturedUpdate = null;
  eqQueries = [];
  ilikeCalled = false;
}

async function callReset(identifier, extra = {}) {
  const res = mockRes();
  await resetPassword(
    { body: { identifier, new_password: 'brand-new-password', current_password: 'correct-password', ...extra } },
    res
  );
  return res;
}

const baseUser = {
  id: 'user-1',
  name: 'Test Student',
  email: 'student1@mail.jiit.ac.in',
  roll_number: '992501030001',
};

const VALID_HASH = bcrypt.hashSync('correct-password', 4);
const hashedUser = () => ({ ...baseUser, password_hash: VALID_HASH });

// ---- H-2.1 (fail-closed) coverage — must keep passing ---------------------

test('H2.1-A+D. valid hash + correct current password updates to a working new hash', async () => {
  resetStubs([hashedUser()]);
  const res = await callReset(baseUser.email);
  assert.equal(res.statusCode, 200);
  assert.equal(updateCalled, true);
  assert.ok(capturedUpdate && typeof capturedUpdate.password_hash === 'string');
  assert.equal(bcrypt.compareSync('brand-new-password', capturedUpdate.password_hash), true);
  assert.equal(bcrypt.compareSync('correct-password', capturedUpdate.password_hash), false);
});

test('H2.1-B. valid hash + wrong current password is rejected without update', async () => {
  resetStubs([hashedUser()]);
  const res = await callReset(baseUser.email, { current_password: 'wrong-password' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, WRONG_PASSWORD_MESSAGE);
  assert.equal(updateCalled, false);
});

test('H2.1-C1. NULL password_hash cannot reach the password update', async () => {
  resetStubs([{ ...baseUser, password_hash: null }]);
  const res = await callReset(baseUser.email, { current_password: 'anything-at-all', new_password: 'attacker-chosen' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, WRONG_PASSWORD_MESSAGE);
  assert.equal(updateCalled, false);
});

test('H2.1-C2. empty password_hash cannot reach the password update', async () => {
  resetStubs([{ ...baseUser, password_hash: '' }]);
  const res = await callReset(baseUser.email, { current_password: 'anything-at-all', new_password: 'attacker-chosen' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, WRONG_PASSWORD_MESSAGE);
  assert.equal(updateCalled, false);
});

test('H2.1-C3. missing current_password is rejected without update', async () => {
  resetStubs([hashedUser()]);
  const res = mockRes();
  await resetPassword(
    { body: { identifier: baseUser.email, new_password: 'brand-new-password' } },
    res
  );
  assert.equal(res.statusCode, 400);
  assert.equal(updateCalled, false);
});

// ---- H-2.2 (identifier restriction) coverage --------------------------------

test('H2.2-A. exact email resolves and reset succeeds', async () => {
  resetStubs([hashedUser()]);
  const res = await callReset('student1@mail.jiit.ac.in');
  assert.equal(res.statusCode, 200);
  assert.equal(updateCalled, true);
  assert.equal(res.body.data.email, baseUser.email);
});

test('H2.2-B. exact roll number resolves and reset succeeds', async () => {
  resetStubs([hashedUser()]);
  const res = await callReset('992501030001');
  assert.equal(res.statusCode, 200);
  assert.equal(updateCalled, true);
});

test('H2.2-C. name identifier is rejected with no DB write', async () => {
  resetStubs([hashedUser()]);
  const res = await callReset('Test Student');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, WRONG_PASSWORD_MESSAGE);
  assert.equal(res.body.data, undefined);
  assert.equal(updateCalled, false);
  assert.equal(ilikeCalled, false);
});

test('H2.2-D. email prefix is rejected with no DB write', async () => {
  resetStubs([hashedUser()]);
  const res = await callReset('student1');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, WRONG_PASSWORD_MESSAGE);
  assert.equal(res.body.data, undefined);
  assert.equal(updateCalled, false);
  assert.equal(ilikeCalled, false);
});

test('H2.2-E. vardaan alias is rejected with no DB write', async () => {
  resetStubs([hashedUser()]);
  const res = await callReset('vardaan');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, WRONG_PASSWORD_MESSAGE);
  assert.equal(updateCalled, false);
});

test('H2.2-F. cicradmin alias is rejected with no DB write', async () => {
  resetStubs([hashedUser()]);
  const res = await callReset('cicradmin');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, WRONG_PASSWORD_MESSAGE);
  assert.equal(updateCalled, false);
});

test('H2.2-G. username/approval-store identifier is rejected with no DB write', async () => {
  resetStubs([hashedUser()]);
  const res = await callReset('teststudent');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, WRONG_PASSWORD_MESSAGE);
  assert.equal(res.body.data, undefined);
  assert.equal(updateCalled, false);
  assert.equal(ilikeCalled, false);
});

test('H2.2-H. unknown identifier gets the generic error with no email disclosure', async () => {
  resetStubs([hashedUser()]);
  const res = await callReset('nobody-here@mail.jiit.ac.in');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, WRONG_PASSWORD_MESSAGE);
  assert.equal(res.body.data, undefined);
  assert.equal(updateCalled, false);
});

test('H2.2-I. email with surrounding whitespace/case still resolves', async () => {
  resetStubs([hashedUser()]);
  const res = await callReset('  STUDENT1@MAIL.JIIT.AC.IN  ');
  assert.equal(res.statusCode, 200);
  assert.equal(updateCalled, true);
});

test('H2.2-J. roll number with surrounding whitespace still resolves', async () => {
  resetStubs([hashedUser()]);
  const res = await callReset('  992501030001  ');
  assert.equal(res.statusCode, 200);
  assert.equal(updateCalled, true);
});
