'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseService } = require('./database.cjs');
require('./table-edit.cjs').installTableEditing(DatabaseService);

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-ez-grid-'));
  const db = new DatabaseService({ dataDir });
  t.after(async () => { await db.close(); assert.ok(path.basename(dataDir).startsWith('work-ez-grid-')); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await db.connect({ mode: 'sqlite', filePath: path.join(dataDir, 'fixture.db') });
  await db.query({ sql: 'CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL UNIQUE, amount NUMERIC, active BOOLEAN NOT NULL DEFAULT 1, note TEXT, generated TEXT GENERATED ALWAYS AS (title || title) STORED)' });
  await db.query({ sql: "INSERT INTO items (id,title,amount,note) VALUES (1,'first',10.25,'original'),(2,'second',20,NULL)" });
  return { db, dataDir };
}
test('table snapshots expose metadata, bound preview and atomic typed updates to a real SQLite file', async t => {
  const { db } = await fixture(t);
  const table = await db.tableData({ table: 'items' });
  assert.equal(table.editable, true); assert.equal(table.canInsert, true); assert.equal(table.canDelete, true);
  assert.equal(table.columns.find(c => c.name === 'id').editable, false);
  assert.equal(table.columns.find(c => c.name === 'generated').editable, false);
  assert.equal(table.columns.find(c => c.name === 'generated').generated, true);
  const attack = "don't'; DROP TABLE items; --";
  const changes = [{ rowIndex: 0, values: { title: attack, amount: '12.345', active: false, note: null } }];
  const preview = await db.previewChanges({ token: table.token, changes });
  assert.equal(preview.changeCount, 1);
  assert.equal(preview.statements[0].sql.includes(attack), false);
  assert.match(preview.statements[0].sql, /^UPDATE `main`\.`items` SET `title`=\?/);
  assert.deepEqual(preview.statements[0].parameters, [attack, '12.345', 0, null, 1]);
  assert.deepEqual(await db.applyChanges({ token: table.token, changes }), { applied: 1, schema: 'main', table: 'items' });
  const persisted = (await db.query({ sql: 'SELECT * FROM items WHERE id=1' })).rows[0];
  assert.equal(persisted.title, attack); assert.equal(persisted.amount, 12.345); assert.equal(persisted.active, 0); assert.equal(persisted.note, null);
  assert.equal(persisted.generated, attack + attack);
  await assert.rejects(db.applyChanges({ token: table.token, changes }), /expired/);
});
test('insert defaults and delete work in one transaction, then persist on reopen', async t => {
  const { db, dataDir } = await fixture(t);
  const table = await db.tableData({ table: 'items' });
  const changes = [{ type: 'insert', values: { title: 'new row', amount: '15.8', note: '' } }, { type: 'delete', rowIndex: 0 }];
  assert.equal((await db.applyChanges({ token: table.token, changes })).applied, 2);
  await db.disconnect();
  await db.connect({ mode: 'sqlite', filePath: path.join(dataDir, 'fixture.db') });
  const result = await db.query({ sql: 'SELECT title,active,note FROM items ORDER BY id' });
  assert.deepEqual(result.rows, [{ title: 'second', active: 1, note: null }, { title: 'new row', active: 1, note: '' }]);
});

test('applying one table tab keeps other snapshots usable and still detects changed rows', async t => {
  const { db } = await fixture(t);
  const first = await db.tableData({ table: 'items' });
  const second = await db.tableData({ table: 'items' });
  await db.applyChanges({ token: first.token, changes: [{ rowIndex: 0, values: { note: 'first tab' } }] });
  await db.applyChanges({ token: second.token, changes: [{ rowIndex: 1, values: { note: 'second tab' } }] });
  const values = (await db.query({ sql: 'SELECT note FROM items ORDER BY id' })).rows;
  assert.deepEqual(values, [{ note: 'first tab' }, { note: 'second tab' }]);
});
test('all changes roll back when any row violates a constraint', async t => {
  const { db } = await fixture(t);
  const table = await db.tableData({ table: 'items' });
  await assert.rejects(db.applyChanges({ token: table.token, changes: [{ rowIndex: 0, values: { note: 'must roll back' } }, { rowIndex: 1, values: { title: 'first' } }] }), /UNIQUE constraint/);
  assert.equal((await db.query({ sql: 'SELECT note FROM items WHERE id=1' })).rows[0].note, 'original');
  assert.equal((await db.info()).transaction, false);
});
test('optimistic concurrency compares complete server snapshots and rejects external updates and deletes', async t => {
  const { db, dataDir } = await fixture(t);
  const { DatabaseSync } = require('node:sqlite');
  const other = new DatabaseSync(path.join(dataDir, 'fixture.db'));
  try {
  let table = await db.tableData({ table: 'items' });
  other.exec("UPDATE items SET note='changed elsewhere' WHERE id=2");
  await assert.rejects(db.applyChanges({ token: table.token, changes: [{ rowIndex: 0, values: { note: 'must not save' } }, { rowIndex: 1, values: { title: 'different' } }] }), /changed in the database/);
  assert.equal((await db.query({ sql: 'SELECT note FROM items WHERE id=1' })).rows[0].note, 'original');
  table = await db.tableData({ table: 'items' }); other.exec('DELETE FROM items WHERE id=1');
  await assert.rejects(db.applyChanges({ token: table.token, changes: [{ type: 'delete', rowIndex: 0 }] }), /changed in the database/);
  } finally { other.close(); }
});
test('view, no primary key, binary and generated cells are read-only; unsafe input is rejected before SQL', async t => {
  const { db } = await fixture(t);
  await db.query({ sql: 'CREATE VIEW item_view AS SELECT * FROM items' });
  await db.query({ sql: 'CREATE TABLE no_key (title TEXT)' });
  await db.query({ sql: 'CREATE TABLE binary_data (id INTEGER PRIMARY KEY, bytes BLOB)' });
  for (const tableName of ['item_view', 'no_key']) {
    const table = await db.tableData({ table: tableName });
    assert.equal(table.editable, false); assert.ok(table.readOnlyReason);
    await assert.rejects(db.previewChanges({ token: table.token, changes: [{ type: 'insert', values: { title: 'x' } }] }), /read-only|primary key/);
  }
  const binary = await db.tableData({ table: 'binary_data' });
  assert.equal(binary.columns.find(c => c.name === 'bytes').editable, false);
  const table = await db.tableData({ table: 'items' });
  for (const changes of [
    [{ rowIndex: -1, values: { title: 'x' } }],
    [{ rowIndex: 0, values: { id: 200 } }],
    [{ rowIndex: 0, values: { generated: 'x' } }],
    [{ rowIndex: 0, values: { title: null } }],
    [{ rowIndex: 0, values: { amount: '12oops' } }],
    [{ rowIndex: 0, values: { active: 'maybe' } }],
    [{ rowIndex: 0, values: { unknown: 'x' } }],
    [{ rowIndex: 0, values: {} }],
    [{ rowIndex: 0, values: { title: 'x' } }, { type: 'delete', rowIndex: 0 }],
    [{ type: 'insert', values: { note: 'missing title' } }],
  ]) await assert.rejects(db.previewChanges({ token: table.token, changes }));
  await assert.rejects(db.tableData({ table: 'items', limit: 1001 }), /1000/);
  await assert.rejects(db.tableData({ table: "items'; DROP TABLE items; --" }), /unavailable/);
  assert.equal((await db.query({ sql: 'SELECT COUNT(*) AS n FROM items' })).rows[0].n, 2);
});
test('existing SQL transactions are not committed by grid editing and stale connection tokens cannot write', async t => {
  const { db, dataDir } = await fixture(t);
  const table = await db.tableData({ table: 'items' });
  await db.query({ sql: 'BEGIN' });
  await db.query({ sql: "UPDATE items SET note='pending SQL' WHERE id=1" });
  await assert.rejects(db.applyChanges({ token: table.token, changes: [{ rowIndex: 1, values: { note: 'grid' } }] }), /Commit or roll back/);
  assert.equal((await db.info()).transaction, true);
  await db.query({ sql: 'ROLLBACK' });
  assert.equal((await db.query({ sql: 'SELECT note FROM items WHERE id=1' })).rows[0].note, 'original');
  await db.connect({ mode: 'sqlite', filePath: path.join(dataDir, 'fixture.db') });
  await assert.rejects(db.applyChanges({ token: table.token, changes: [{ type: 'delete', rowIndex: 0 }] }), /expired/);
});
test('composite and quoted identifiers target one row while bigint precision is preserved', async t => {
  const { db } = await fixture(t);
  await db.query({ sql: 'CREATE TABLE "odd`table" (part INTEGER NOT NULL, "strange`key" TEXT NOT NULL, value TEXT, PRIMARY KEY(part,"strange`key"))' });
  await db.query({ sql: 'INSERT INTO "odd`table" VALUES (9223372036854775807,\'a\',\'old\'),(9223372036854775807,\'b\',\'keep\')' });
  const table = await db.tableData({ table: 'odd`table', limit: 1 });
  assert.equal(table.truncated, true); assert.equal(table.rows[0].part, '9223372036854775807');
  const changes = [{ rowIndex: 0, values: { value: 'new' } }];
  const preview = await db.previewChanges({ token: table.token, changes });
  assert.deepEqual(preview.statements[0].parameters, ['new', '9223372036854775807', 'a']);
  await db.applyChanges({ token: table.token, changes });
  assert.deepEqual((await db.query({ sql: 'SELECT value FROM "odd`table" ORDER BY "strange`key"' })).rows, [{ value: 'new' }, { value: 'keep' }]);
});

function fakeSnapshotDb(t, mode) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-ez-grid-mock-'));
  const db = new DatabaseService({ dataDir });
  const calls = [];
  const meta = [
    { name: 'id', type: 'integer', pk: ['mysql', 'mariadb'].includes(mode) ? 'PRI' : true, nullable: 'NO', is_nullable: 'NO', is_generated: 'NEVER', is_identity: 'NO', column_default: null, default_value: null, extra: '' },
    { name: 'title', type: 'text', pk: ['mysql', 'mariadb'].includes(mode) ? '' : false, nullable: 'YES', is_nullable: 'YES', is_generated: 'NEVER', is_identity: 'NO', column_default: null, default_value: null, extra: '' },
  ];
  const row = { id: 1, title: 'old' };
  const answer = (sql, parameters, transaction) => {
    calls.push({ sql, parameters, transaction });
    if (sql.includes('@@autocommit')) return { rows: [{ enabled: 1 }], affectedRows: 0 };
    if (/information_schema\.tables/i.test(sql)) return { rows: [{ type: 'BASE TABLE', engine: 'InnoDB' }], affectedRows: 0 };
    if (/information_schema\.COLUMNS|information_schema\.columns|sys\.columns/.test(sql)) return { rows: meta, affectedRows: 0 };
    if (sql.startsWith('SELECT')) return { rows: [{ ...row }], affectedRows: 0 };
    if (sql.startsWith('UPDATE')) { row.title = parameters[0]; return { rows: [], affectedRows: 1 }; }
    return { rows: [], affectedRows: 0 };
  };
  if (mode === 'mysql' || mode === 'mariadb') db.connection = { async query(sql, parameters) { const result = answer(typeof sql === 'object' ? sql.sql : sql, parameters, false); return [result.rows.length ? result.rows : { affectedRows: result.affectedRows }]; }, async end() {} };
  else if (mode === 'postgres') db.connection = { async query(sql, values) { const result = answer(typeof sql === 'object' ? sql.text : sql, typeof sql === 'object' ? sql.values : values, false); return { rows: result.rows, rowCount: result.affectedRows, fields: [] }; }, async end() {} };
  else {
    meta[0].pk = true; meta[0].is_nullable = false; meta[0].is_identity = false; meta[1].pk = false; meta[1].is_nullable = true; meta[1].is_identity = false;
    const request = transaction => ({ values: [], input(name, value) { this.values.push(value); }, async query(sql) { const result = answer(sql, this.values, transaction); return { recordset: result.rows, rowsAffected: [result.affectedRows] }; } });
    db.connection = { request: () => request(false), async close() {} };
    db._drivers.mssql = { Transaction: class { async begin() { calls.push({ begin: true }); } async commit() { calls.push({ commit: true }); } async rollback() { calls.push({ rollback: true }); } request() { return request(true); } } };
  }
  db.mode = mode; db.database = 'app'; db.schema = mode === 'mssql' ? 'dbo' : mode === 'postgres' ? 'public' : 'app';
  t.after(async () => { await db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { db, calls };
}
for (const mode of ['mysql', 'mariadb', 'postgres', 'mssql']) test(mode + ' uses dialect placeholders, safe identifiers and a locked transaction', async t => {
  const { db, calls } = fakeSnapshotDb(t, mode);
  const table = await db.tableData({ table: 'quoted]"`table' });
  assert.equal(table.editable, true);
  const changes = [{ rowIndex: 0, values: { title: "O'Reilly" } }];
  const preview = await db.previewChanges({ token: table.token, changes });
  assert.deepEqual(preview.statements[0].parameters, ["O'Reilly", 1]);
  assert.match(preview.statements[0].sql, mode === 'postgres' ? /"title"=\$1.*"id"=\$2/ : mode === 'mssql' ? /\[title\]=@p1.*\[id\]=@p2/ : /`title`=\?.*`id`=\?/);
  assert.equal((await db.applyChanges({ token: table.token, changes })).applied, 1);
  const locked = calls.find(call => call.sql?.includes('WHERE') && (call.sql.endsWith(' FOR UPDATE') || call.sql.includes('UPDLOCK')));
  assert.ok(locked);
  if (mode === 'mssql') {
    assert.equal(locked.transaction, true);
    assert.equal(calls.find(call => call.sql?.startsWith('UPDATE')).transaction, true);
    assert.ok(calls.find(call => call.commit));
  } else {
    assert.ok(calls.find(call => call.sql === 'BEGIN'));
    assert.ok(calls.find(call => call.sql === 'COMMIT'));
  }
});

for (const mode of ['mysql', 'mariadb', 'postgres', 'mssql']) test(mode + ' table browser sends bound filters through its adapter boundary', async t => {
  const { db, calls } = fakeSnapshotDb(t, mode);
  const value = "x' OR 1=1--";
  const table = await db.tableData({ table: 'items', browse: { filter: { column: 'title', operator: 'eq', value }, order: { column: 'id', direction: 'desc' } } });
  assert.equal(table.browse.filter.value, value);
  const selected = calls.find(call => call.sql?.startsWith('SELECT') && call.sql.includes('WHERE') && call.sql.includes('DESC'));
  assert.ok(selected); assert.equal(selected.sql.includes(value), false); assert.deepEqual(selected.parameters, [value]);
});
