const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/secrets');

test('hashPassword は scrypt$N$r$p$salt$hash の形で、検証できる', () => {
  const h = S.hashPassword('correct horse');
  assert.match(h, /^scrypt\$\d+\$\d+\$\d+\$[\w-]+\$[\w-]+$/);
  assert.equal(S.verifyPassword('correct horse', h), true);
});

test('違う PW・壊れた hash は false', () => {
  const h = S.hashPassword('correct horse');
  assert.equal(S.verifyPassword('wrong', h), false);
  assert.equal(S.verifyPassword('correct horse', 'garbage'), false);
  assert.equal(S.verifyPassword('correct horse', ''), false);
});

test('同じ PW でもソルトで hash が変わる', () => {
  assert.notEqual(S.hashPassword('same'), S.hashPassword('same'));
});

test('newCode は先頭が 0 でも 6桁', () => {
  for (let i = 0; i < 300; i++) assert.match(S.newCode(), /^\d{6}$/);
});

test('newToken は毎回違い、十分に長い', () => {
  const a = S.newToken();
  assert.notEqual(a, S.newToken());
  assert.ok(a.length >= 43);
});

test('safeEqualHex は長さが違っても例外を出さない', () => {
  assert.equal(S.safeEqualHex(S.sha256('a'), S.sha256('a')), true);
  assert.equal(S.safeEqualHex(S.sha256('a'), S.sha256('b')), false);
  assert.equal(S.safeEqualHex('ab', 'abcd'), false);
});

test('DUMMY_HASH は検証できる形式', () => {
  assert.equal(S.verifyPassword('x', S.DUMMY_HASH), false);
});
