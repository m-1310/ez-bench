const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseClient } = require('./database-client.cjs');

test('database subprocess executes real SQL and cancellation recovers without losing data', { timeout: 15000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-ez-bench-worker-'));
  const db = new DatabaseClient({ dataDir });
  try {
    await db.connect({ mode: 'demo' });
    const result = await db.query({ sql: 'SELECT COUNT(*) AS count FROM customers', schema: 'main' });
    assert.equal(result.rows[0].count, 6);
    await db.query({ sql: 'CREATE TABLE retained (id INTEGER PRIMARY KEY, value TEXT)' });
    await db.query({ sql: "INSERT INTO retained VALUES (1, 'still here')" });
    const pending = db.query({ sql: 'WITH RECURSIVE counter(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM counter) SELECT sum(x) FROM counter' });
    const rejection = assert.rejects(pending, /Query cancelled/);
    await new Promise(resolve => setTimeout(resolve, 150));
    const began = Date.now();
    await db.cancel();
    await rejection;
    assert.ok(Date.now() - began < 5000, 'Cancellation must terminate a native SQLite operation promptly.');
    await db.connect({ mode: 'demo' });
    const recovered = await db.query({ sql: 'SELECT value FROM retained WHERE id=1' });
    assert.equal(recovered.rows[0].value, 'still here');
    await db.disconnect();
  } finally {
    await db.close();
    const resolved = path.resolve(dataDir);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('work-ez-bench-worker-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
