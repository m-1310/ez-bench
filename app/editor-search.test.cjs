'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { matches, nextMatch, replaceAll } = require('./editor-search.js');
test('literal find does not interpret regex syntax and preserves Unicode offsets', () => {
  const text = "SELECT '東京.$[]' AS city; select 2;";
  assert.deepEqual(matches(text, '.$[]'), [{ start: 10, end: 14 }]);
  assert.equal(matches(text, 'SELECT').length, 2);
  assert.equal(matches(text, 'SELECT', true).length, 1);
  assert.deepEqual(matches('İx iX', 'x'), [{ start: 1, end: 2 }, { start: 4, end: 5 }]);
});
test('replace-all inserts dollar sequences and multiline SQL literally', () => {
  assert.deepEqual(replaceAll('cat CAT category', 'cat', '$&\n$1'), { value: '$&\n$1 $&\n$1 $&\n$1egory', count: 3 });
  assert.deepEqual(replaceAll('aAa', 'A', '', true), { value: 'aa', count: 1 });
  assert.deepEqual(replaceAll('SELECT 1', 'nothing', 'x'), { value: 'SELECT 1', count: 0 });
});
test('find and replace reject empty patterns and refuse oversized output', () => {
  assert.throws(() => matches('x', ''), /find text/);
  assert.throws(() => matches('x', 'a'.repeat(4097)), /find text/);
  assert.throws(() => replaceAll('a'.repeat(500001), 'a', 'bb'), /1 MB/);
  assert.throws(() => replaceAll('a'.repeat(1000000), 'a', 'x'.repeat(4096)), /1 MB/);
  assert.equal(matches('a'.repeat(1000000), 'a').length, 10000);
  assert.deepEqual(nextMatch('a'.repeat(20000), 'a', 19999), { match: { start: 19999, end: 20000 }, count: 20000, ordinal: 20000 });
});
