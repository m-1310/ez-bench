'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SnippetStore } = require('./snippet-store.cjs');
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-snippets-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return { dir, store: new SnippetStore(dir) }; }
const input = { title: 'Customers by city', sql: 'SELECT * FROM customers WHERE city = :city;', dialect: 'any' };

test('snippets persist exact Unicode SQL, edit titles/dialects and delete independently of databases', async t => {
  const { store, dir } = fixture(t);
  const sql = "-- reusable café SQL\nSELECT '東京' AS city;\n";
  const saved = await store.save({ ...input, sql });
  assert.deepEqual(new SnippetStore(dir).list().entries, [saved]);
  const copy = store.list().entries; copy[0].sql = 'mutated';
  assert.equal(store.list().entries[0].sql, sql);
  const edited = await store.save({ ...saved, title: 'A new title', dialect: 'postgres' });
  assert.equal(edited.id, saved.id); assert.equal(edited.dialect, 'postgres');
  assert.equal(await store.remove(saved.id), true);
  assert.deepEqual(new SnippetStore(dir).list().entries, []);
});
test('private, detected credentials and malformed values never enter snippet storage', async t => {
  const { store, dir } = fixture(t);
  await store.save(input); const before = fs.readFileSync(path.join(dir, 'snippets.json'), 'utf8');
  for (const invalid of [{ ...input, private: true }, { ...input, sql: "ALTER USER bob IDENTIFIED BY 'never-save-this';" }, { ...input, title: '' }, { ...input, dialect: 'oracle' }, { ...input, sql: 'x'.repeat(128 * 1024 + 1) }, { ...input, sql: 'SELECT\0' }, { ...input, id: 'missing' }]) await assert.rejects(store.save(invalid));
  assert.equal(fs.readFileSync(path.join(dir, 'snippets.json'), 'utf8'), before);
});
test('overlapping snippet writes serialize without losing updates or poisoning later writes', async t => {
  const { store, dir } = fixture(t);
  await Promise.all(Array.from({ length: 20 }, (_, index) => store.save({ ...input, title: 'Snippet ' + index })));
  assert.equal(new SnippetStore(dir).list().entries.length, 20);
  await assert.rejects(store.save({ ...input, title: '' }));
  await store.save({ ...input, title: 'After error' }); await store.close();
  assert.equal(new SnippetStore(dir).list().entries.length, 21);
  assert.deepEqual(fs.readdirSync(dir), ['snippets.json']);
});
test('corrupt, oversized and duplicate-ID snippet files remain preserved and block writes', async t => {
  const { dir } = fixture(t), file = path.join(dir, 'snippets.json');
  for (const text of ['{broken', ' '.repeat(2 * 1024 * 1024 + 1), JSON.stringify({ version: 1, entries: [{ id: 'invalid' }] })]) {
    fs.writeFileSync(file, text);
    const store = new SnippetStore(dir); assert.ok(store.list().warning);
    await assert.rejects(store.save(input)); assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});
test('snippet count and total-byte limits preserve the previous valid library', async t => {
  const { store, dir } = fixture(t);
  await Promise.all(Array.from({ length: 100 }, (_, i) => store.save({ ...input, title: 'Query ' + i })));
  await assert.rejects(store.save(input), /100 snippets/);
  assert.equal(new SnippetStore(dir).list().entries.length, 100);
  const first = store.list().entries[0]; await store.remove(first.id); await assert.rejects(store.remove(first.id), /no longer/);
  let rejected = false;
  for (const entry of store.list().entries) {
    try { await store.save({ ...entry, sql: '-- ' + 'a'.repeat(120 * 1024) }); }
    catch (error) { assert.match(error.message, /2 MiB/); rejected = true; break; }
  }
  assert.ok(rejected); assert.ok(fs.statSync(path.join(dir, 'snippets.json')).size <= 2 * 1024 * 1024);
});
test('failed atomic snippet writes preserve memory and the previous on-disk library', async t => {
  const { store, dir } = fixture(t), previous = await store.save(input);
  t.mock.method(fs.promises, 'rename', async () => { throw new Error('simulated disk failure'); });
  await assert.rejects(store.save({ ...previous, title: 'Unsaved' }), /disk failure/);
  assert.equal(store.list().entries[0].title, input.title);
  assert.equal(new SnippetStore(dir).list().entries[0].title, input.title);
  assert.deepEqual(fs.readdirSync(dir), ['snippets.json']);
});
