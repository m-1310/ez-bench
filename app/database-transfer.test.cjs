'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { DatabaseService } = require('./database.cjs');
const { installDatabaseTransfer, findTool } = require('./database-transfer.cjs');
installDatabaseTransfer(DatabaseService);

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-ez-transfer-'));
  const db = new DatabaseService({ dataDir });
  await db.connect({ mode: 'demo' });
  t.after(async () => { await db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { db, dataDir };
}

test('SQLite online backup includes all rows, schema, indexes, triggers, views and exact types with WAL active', async t => {
  const { db, dataDir } = await fixture(t);
  db.connection.exec(`PRAGMA journal_mode=WAL; CREATE TABLE exact (id INTEGER PRIMARY KEY, n INTEGER, b BLOB, t TEXT); CREATE INDEX exact_text ON exact(t); CREATE VIEW exact_view AS SELECT * FROM exact; CREATE TABLE audit (text TEXT); CREATE TRIGGER exact_audit AFTER INSERT ON exact BEGIN INSERT INTO audit VALUES (new.t); END;`);
  const statement = db.connection.prepare('INSERT INTO exact VALUES (?, ?, ?, ?)');
  for (let i = 1; i <= 1501; i++) statement.run(i, 9007199254740993n, Buffer.from([0, 1, 254, 255]), "hello; quote ' and Unicode नमस्ते " + i);
  const filePath = path.join(dataDir, 'full backup.db');
  const result = await db.exportDatabase({ filePath });
  assert.ok(result.bytes > 1000); assert.equal(result.format, 'sqlite');
  const copy = new DatabaseSync(filePath, { readOnly: true });
  try {
    assert.equal(copy.prepare('SELECT count(*) AS n FROM exact').get().n, 1501);
    assert.equal(copy.prepare('SELECT count(*) AS n FROM audit').get().n, 1501);
    const read = copy.prepare('SELECT n, b, t FROM exact WHERE id=1501'); read.setReadBigInts(true);
    const row = read.get(); assert.equal(row.n, 9007199254740993n); assert.deepEqual(Buffer.from(row.b), Buffer.from([0,1,254,255])); assert.match(row.t, /नमस्ते 1501$/);
    assert.equal(copy.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('exact_text','exact_view','exact_audit')").get().n, 3);
    assert.equal(copy.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  } finally { copy.close(); }
  const info = await db.transferInfo(); assert.equal(info.ready, true); assert.match(info.scope, /Complete SQLite/);
});

test('SQLite reviewed restore creates a new usable file and never replaces the open database', async t => {
  const { db, dataDir } = await fixture(t);
  const filePath = path.join(dataDir, 'snapshot.db'); await db.exportDatabase({ filePath });
  await db.query({ sql: "UPDATE customers SET city='Changed after backup' WHERE id=1" });
  const preview = await db.inspectImport({ filePath }); assert.equal(preview.confirmation, 'RESTORE'); assert.match(preview.sha256, /^[a-f0-9]{64}$/);
  const destinationPath = path.join(dataDir, 'restored.db');
  await assert.rejects(db.importDatabase({ token: preview.token, confirmation: 'wrong', destinationPath }), /exact confirmation/);
  const restored = await db.importDatabase({ token: preview.token, confirmation: 'RESTORE', destinationPath });
  assert.equal(restored.restored, true); assert.equal(restored.connected, false);
  assert.equal((await db.query({ sql: 'SELECT city FROM customers WHERE id=1' })).rows[0].city, 'Changed after backup');
  const copy = new DatabaseSync(destinationPath, { readOnly: true });
  try { assert.equal(copy.prepare('SELECT city FROM customers WHERE id=1').get().city, 'Bengaluru'); } finally { copy.close(); }
  await assert.rejects(db.importDatabase({ token: preview.token, confirmation: 'RESTORE', destinationPath }), /preview expired/);
  assert.ok(!fs.readdirSync(dataDir).some(name => name.includes('.partial') || name.includes('.restore-source')));
});

test('backup paths, source integrity, review changes, transaction and overwrite checks fail safely', async t => {
  const { db, dataDir } = await fixture(t);
  await assert.rejects(db.exportDatabase({ filePath: 'relative.db' }), /absolute/);
  await assert.rejects(db.exportDatabase({ filePath: path.join(dataDir, 'demo.db'), overwrite: true }), /different from/);
  const filePath = path.join(dataDir, 'backup.db'); await db.exportDatabase({ filePath });
  await assert.rejects(db.exportDatabase({ filePath }), /already exists/);
  await db.exportDatabase({ filePath, overwrite: true });
  await db.query({ sql: 'BEGIN' });
  await assert.rejects(db.exportDatabase({ filePath: path.join(dataDir, 'uncommitted.db') }), /Commit or roll back/);
  await db.query({ sql: 'ROLLBACK' });
  const preview = await db.inspectImport({ filePath });
  const mutate = new DatabaseSync(filePath); mutate.exec('CREATE TABLE changed_after_review (id INTEGER)'); mutate.close();
  await assert.rejects(db.importDatabase({ token: preview.token, confirmation: 'RESTORE', destinationPath: path.join(dataDir, 'changed.db') }), /changed after preview/);
  assert.ok(!fs.existsSync(path.join(dataDir, 'changed.db')));
  const second = await db.inspectImport({ filePath });
  await assert.rejects(db.importDatabase({ token: second.token, confirmation: 'RESTORE', destinationPath: path.join(dataDir, 'demo.db') }), /different from/);
  const textPath = path.join(dataDir, 'wrong.sql'); fs.writeFileSync(textPath, 'SELECT 1;');
  await assert.rejects(db.inspectImport({ filePath: textPath }), /SQLite database backup/);
  await assert.rejects(db.exportDatabase({ filePath: path.join(dataDir, 'not-a-folder', 'backup.db') }), /unable to open|ENOENT|directory/i);
});

test('import review is tied to the exact connected session', async t => {
  const { db, dataDir } = await fixture(t);
  const filePath = path.join(dataDir, 'backup.db'); await db.exportDatabase({ filePath });
  const review = await db.inspectImport({ filePath });
  await db.connect({ mode: 'demo' });
  await assert.rejects(db.importDatabase({ token: review.token, confirmation: 'RESTORE', destinationPath: path.join(dataDir, 'new.db') }), /connection changed/);
});

test('import rejects an active WAL source and corrupt SQLite contents without creating a destination', async t => {
  const { db, dataDir } = await fixture(t);
  db.connection.exec('PRAGMA journal_mode=WAL; INSERT INTO products(name,category,price,stock) VALUES (\'WAL fixture\',\'Test\',1,1)');
  await assert.rejects(db.inspectImport({ filePath: path.join(dataDir, 'demo.db') }), /active WAL or journal/);
  const broken = path.join(dataDir, 'corrupt.db');
  fs.writeFileSync(broken, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(1000)]));
  const review = await db.inspectImport({ filePath: broken });
  await assert.rejects(db.importDatabase({ token: review.token, confirmation: 'RESTORE', destinationPath: path.join(dataDir, 'must-not-exist.db') }), /not a database|malformed|file is encrypted/);
  assert.equal(fs.existsSync(path.join(dataDir, 'must-not-exist.db')), false);
  assert.ok(!fs.readdirSync(dataDir).some(name => name.includes('.partial') || name.includes('.restore-source')));
});

test('unsupported server backup and invalid client executables report honest actionable errors', async t => {
  const { db, dataDir } = await fixture(t);
  assert.throws(() => findTool('mysql', 'dump', { dump: 'relative.exe' }), /absolute/);
  assert.throws(() => findTool('postgres', 'restore', { restore: path.join(dataDir, 'missing.exe') }), /does not exist/);
  const oldMode = db.mode; db.mode = 'mssql';
  await assert.rejects(db.transferInfo(), /server-side .bak/); db.mode = oldMode;
  const original = db.connectionInfo; db.mode = 'mysql'; db.database = 'example'; db.connectionInfo = { host: 'localhost', port: 3306, user: 'test' };
  await assert.rejects(db.transferInfo({ tools: { dump: process.execPath } }), /does not match/);
  db.mode = oldMode; db.connectionInfo = original;
});
