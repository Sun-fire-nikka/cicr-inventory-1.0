const { test } = require('node:test');
const assert = require('node:assert/strict');

// M-6 regression: PostgREST LIKE/OR escaping helpers.
const { escapeLikePattern, escapeOrSegment } = require('../dist/validators/postgrest.js');

test('M-6 escapeLikePattern leaves ordinary values unchanged', () => {
  assert.equal(escapeLikePattern('arduino'), 'arduino');
  assert.equal(escapeLikePattern('992501030001'), '992501030001');
  assert.equal(escapeLikePattern('student1@mail.jiit.ac.in'), 'student1@mail.jiit.ac.in');
  assert.equal(escapeLikePattern('hello world'), 'hello world');
  assert.equal(escapeLikePattern(''), '');
});

test('M-6 escapeLikePattern escapes LIKE metacharacters', () => {
  assert.equal(escapeLikePattern('100%'), '100\\%');
  assert.equal(escapeLikePattern('a_b'), 'a\\_b');
  assert.equal(escapeLikePattern('a\\b'), 'a\\\\b');
  assert.equal(escapeLikePattern('%_%\\'), '\\%\\_\\%\\\\');
});

test('M-6 escapeOrSegment strips structural OR characters', () => {
  assert.equal(escapeOrSegment('a,b'), 'ab');
  assert.equal(escapeOrSegment('a(b)c'), 'abc');
  assert.equal(escapeOrSegment('a)(b,c'), 'abc');
  assert.equal(escapeOrSegment('%,role.eq.ADMIN'), '\\%role.eq.ADMIN');
  assert.equal(escapeOrSegment(''), '');
});

test('M-6 escapeOrSegment preserves dots and ordinary emails', () => {
  assert.equal(escapeOrSegment('student1@mail.jiit.ac.in'), 'student1@mail.jiit.ac.in');
  assert.equal(escapeOrSegment('vardaansaxena096@gmail.com'), 'vardaansaxena096@gmail.com');
});

test('M-6 escapeOrSegment escapes wildcards inside OR values', () => {
  assert.equal(escapeOrSegment('100%_x'), '100\\%\\_x');
  assert.equal(escapeOrSegment('a\\b,c'), 'a\\\\bc');
});

test('M-6 helpers coerce non-string input without throwing', () => {
  assert.equal(escapeLikePattern(null), '');
  assert.equal(escapeLikePattern(undefined), '');
  assert.equal(escapeOrSegment(123), '123');
});
