'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseService } = require('./database.cjs');
const { compileBrowse } = require('./table-browse.cjs');
const columns = [{ name: 'id', valueType: 'integer', primaryKey: true }, { name: 'title', valueType: 'text' }, { name: 'flag', valueType: 'boolean' }, { name: 'payload', valueType: null }];
const quote = (name, mode) => mode === 'mssql' ? '[' + name.replaceAll(']', ']]') + ']' : '"' + name.replaceAll('"', '""') + '"';
const placeholder = (mode, n) => mode === 'postgres' ? '$' + n : mode === 'mssql' ? '@p' + n : '?';

for (const mode of ['sqlite', 'mysql', 'mariadb', 'postgres', 'mssql']) test(mode + ' table criteria bind attack strings and add deterministic primary-key tie ordering', () => {
  const attack = "x' OR 1=1; DROP TABLE items;--";
  const plan = compileBrowse({ filter: { column: 'title', operator: 'eq', value: attack }, order: { column: 'title', direction: 'desc' } }, columns, mode, quote, placeholder);
  assert.equal(plan.where.includes(attack), false); assert.deepEqual(plan.parameters, [attack]);
  assert.match(plan.where, mode === 'postgres' ? /\$1/ : mode === 'mssql' ? /@p1/ : /\?/);
  assert.match(plan.order, /DESC, .*id.* ASC/);
  assert.deepEqual(compileBrowse({ filter: { column: 'title', operator: 'contains', value: '50%_[' } }, columns, mode, quote, placeholder).parameters, ['%50!%!_![%']);
  assert.match(compileBrowse({ filter: { column: 'title', operator: 'isnull' } }, columns, mode, quote, placeholder).where, /IS NULL$/);
});
test('invalid columns, operators, directions and values fail before any table SQL is constructed', () => {
  for (const input of [{ filter: { column: 'title; DROP', operator: 'eq', value: 'x' } }, { filter: { column: 'id', operator: 'OR 1=1', value: '1' } }, { filter: { column: 'id', operator: 'eq', value: '1 OR 1=1' } }, { filter: { column: 'flag', operator: 'eq', value: 'maybe' } }, { filter: { column: 'id', operator: 'contains', value: '1' } }, { filter: { column: 'payload', operator: 'eq', value: 'x' } }, { order: { column: 'id', direction: 'desc; DROP' } }, { order: { column: 'payload', direction: 'asc' } }]) assert.throws(() => compileBrowse(input, columns, 'mysql', quote, placeholder));
});
test('real SQLite filters find rows beyond page one and preserve exact filtered edit snapshots', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-browse-'));
  const db = new DatabaseService({ dataDir: dir });
  t.after(async () => { await db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await db.connect({ mode: 'sqlite', filePath: path.join(dir, 'browse.db') });
  await db.query({ sql: 'CREATE TABLE items(id INTEGER PRIMARY KEY, title TEXT, amount REAL)' });
  await db.query({ sql: "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<250) INSERT INTO items SELECT x, CASE WHEN x=231 THEN '50%_[literal' ELSE 'same' END, x*1.5 FROM n" });
  const first = await db.tableData({ table: 'items', limit: 100 }); assert.equal(first.rowCount, 100); assert.equal(first.hasMore, true);
  const browse = { filter: { column: 'id', operator: 'gte', value: '125' }, order: { column: 'id', direction: 'desc' } };
  const page = await db.tableData({ table: 'items', limit: 100, browse }); assert.equal(page.rows[0].id, 250); assert.equal(page.hasMore, true);
  const second = await db.tableData({ table: 'items', limit: 100, offset: 100, browse }); assert.equal(second.rows[0].id, 150); assert.equal(second.rows.at(-1).id, 125); assert.equal(second.hasMore, false);
  const literal = await db.tableData({ table: 'items', browse: { filter: { column: 'title', operator: 'contains', value: '50%_[' } } }); assert.equal(literal.rows.length, 1); assert.equal(literal.rows[0].id, 231);
  const attack = await db.tableData({ table: 'items', browse: { filter: { column: 'title', operator: 'eq', value: "' OR 1=1--" } } }); assert.equal(attack.rowCount, 0);
  await db.applyChanges({ token: second.token, changes: [{ rowIndex: 0, values: { title: 'Edited filtered row' } }] });
  assert.equal((await db.query({ sql: 'SELECT title FROM items WHERE id=150' })).rows[0].title, 'Edited filtered row');
  assert.equal((await db.query({ sql: 'SELECT title FROM items WHERE id=1' })).rows[0].title, 'same');
});
