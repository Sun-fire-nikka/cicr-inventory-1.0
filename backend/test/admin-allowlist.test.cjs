const { test } = require('node:test');
const assert = require('node:assert/strict');

// H-1 regression: ADMIN must derive from the exact normalized allow-list
// email only. Name, roll number, or email substrings must NEVER grant ADMIN.
const {
  SUPER_ADMIN_EMAILS,
  isSuperAdminEmail,
  isDesignatedAdmin,
  getUserApproval,
  setUserApproval,
  deleteUserApproval,
} = require('../dist/modules/auth/userApprovalService.js');

const ADMIN_EMAIL = SUPER_ADMIN_EMAILS[0];

test('A. allowed exact admin email is designated ADMIN', () => {
  assert.equal(isSuperAdminEmail(ADMIN_EMAIL), true);
  assert.equal(isDesignatedAdmin(ADMIN_EMAIL), true);
});

test('B. case/whitespace normalization yields the same legitimate result', () => {
  const variant = `  ${ADMIN_EMAIL.toUpperCase()}  `;
  assert.equal(isSuperAdminEmail(variant), true);
  assert.equal(isDesignatedAdmin(variant), true);
});

test('C. normal user whose name contains "Aryan" stays MEMBER', () => {
  assert.equal(isDesignatedAdmin('student123@mail.jiit.ac.in', 'Aryan Sharma'), false);
  assert.equal(isDesignatedAdmin('student123@mail.jiit.ac.in'), false);
});

test('D. normal user whose name contains "Vardaan" stays MEMBER', () => {
  assert.equal(isDesignatedAdmin('student456@mail.jiit.ac.in', 'Vardaan Saxena'), false);
  assert.equal(isDesignatedAdmin('student456@mail.jiit.ac.in'), false);
});

test('E. normal email containing an admin-looking substring stays MEMBER', () => {
  assert.equal(isDesignatedAdmin('myvardaan123@mail.jiit.ac.in', 'Normal Student'), false);
  assert.equal(isDesignatedAdmin('aryan.fan@mail.jiit.ac.in'), false);
  assert.equal(isDesignatedAdmin('gunjanfan@mail.jiit.ac.in', 'Gunjan Fan'), false);
  assert.equal(isDesignatedAdmin('dhruvi123@mail.jiit.ac.in'), false);
});

test('F. approving a user with an admin-looking name must NOT elevate role', () => {
  const email = 'h1-f-case@h1-test.local';
  try {
    const rec = setUserApproval(email, 'APPROVED', 'TEST', { name: 'Aryan Varshney' });
    assert.equal(rec.role, 'MEMBER');
  } finally {
    deleteUserApproval(email);
  }
});

test('G. member email with designated-admin substring name is not elevated', () => {
  const email = 'h1-g-case@h1-test.local';
  try {
    // Mirrors the login effective-role inputs: stored role MEMBER, approval MEMBER,
    // and the (previously exploitable) name-based designated check.
    const approval = getUserApproval(email, 'MEMBER');
    const isDesignated = isDesignatedAdmin(email, 'Vardaan Saxena');
    const effectiveRole =
      isSuperAdminEmail(email) || isDesignated || approval.role === 'ADMIN' ? 'ADMIN' : 'MEMBER';
    assert.equal(isDesignated, false);
    assert.equal(approval.role, 'MEMBER');
    assert.equal(effectiveRole, 'MEMBER');
  } finally {
    deleteUserApproval(email);
  }
});
