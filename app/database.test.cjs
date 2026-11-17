'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseService, splitStatements, MAX_ROWS } = require('./database.cjs');

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-db-test-'));
  const db = new DatabaseService({ dataDir });
  t.after(async () => { await db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await db.connect({ mode: 'demo' });
  return { db, dataDir };
}

test('demo runs real joins and exposes table/column metadata', async t => {
  const { db } = await fixture(t);
  const schemas = await db.schemas();
  assert.equal(schemas[0].name, 'main');
  assert.deepEqual(schemas[0].tables.map(table => table.name), ['customers', 'orders', 'products']);
  const result = await db.query({ sql: 'SELECT c.name, COUNT(o.id) AS orders, SUM(o.total) AS total FROM customers c JOIN orders o ON c.id=o.customer_id WHERE c.id=1 GROUP BY c.id' });
  assert.deepEqual(result.columns.map(column => column.name), ['name', 'orders', 'total']);
  assert.deepEqual(result.rows, [{ name: 'Avery Chen', orders: 2, total: 338 }]);
  assert.equal(result.mode, 'demo');
  assert.equal(result.truncated, false);
  const columns = await db.columns({ schema: 'main', table: 'customers' });
  assert.equal(columns[0].name, 'id');
  assert.equal(columns[0].primaryKey, true);
  assert.equal(columns.find(column => column.name === 'name').nullable, false);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('scratch SQL supports create, insert, update, delete and persists across reconnect', async t => {
  const { db, dataDir } = await fixture(t);
  assert.equal((await db.query({ sql: 'CREATE TABLE scratch (id INTEGER PRIMARY KEY, value TEXT)' })).affectedRows, 0);
  assert.equal((await db.query({ sql: "INSERT INTO scratch(value) VALUES ('hello; world')" })).affectedRows, 1);
  assert.equal((await db.query({ sql: "UPDATE scratch SET value='changed' WHERE id=1" })).affectedRows, 1);
  await db.disconnect();
  await db.connect({ mode: 'demo' });
  assert.deepEqual((await db.query({ sql: 'SELECT * FROM scratch' })).rows, [{ id: 1, value: 'changed' }]);
  assert.equal((await db.query({ sql: 'DELETE FROM scratch WHERE id=1' })).affectedRows, 1);
  assert.equal((await db.query({ sql: 'SELECT * FROM scratch' })).rowCount, 0);
  assert.ok(fs.existsSync(path.join(dataDir, 'demo.db')));
});

test('SQL errors do not break the session and batches cannot silently execute partially', async t => {
  const { db } = await fixture(t);
  await assert.rejects(db.query({ sql: 'SELECT * FROM nonexistent' }), /no such table/);
  await assert.rejects(db.query({ sql: 'SELECT 1; DELETE FROM customers' }), /one SQL statement/);
  assert.equal((await db.query({ sql: 'SELECT COUNT(*) AS count FROM customers' })).rows[0].count, 6);
  await assert.rejects(db.query({ sql: '-- just a comment' }), /one SQL statement/);
  await assert.rejects(db.query({ sql: 'SELECT 1', schema: 'other' }), /schema is main/);
  assert.equal((await db.query({ sql: "SELECT ';' AS value; --semicolon; in comment" })).rows[0].value, ';');
});

test('intentional sandbox schema changes are preserved rather than reseeded on reconnect', async t => {
  const { db } = await fixture(t);
  await db.query({ sql: 'DROP TABLE orders' });
  await db.query({ sql: 'DROP TABLE customers' });
  await db.disconnect();
  await db.connect({ mode: 'demo' });
  assert.deepEqual((await db.schemas())[0].tables.map(table => table.name), ['products']);
});

test('local SQLite mode creates an empty real file and opens existing data without seeding', async t => {
  const { db, dataDir } = await fixture(t);
  const filePath = path.join(dataDir, 'user-selected.sqlite');
  const connection = await db.connect({ mode: 'sqlite', filePath });
  assert.deepEqual(connection, { connected: true, mode: 'sqlite', database: 'main', dialect: 'SQLite' });
  assert.deepEqual(await db.schemas(), [{ name: 'main', tables: [] }]);
  await db.query({ sql: 'CREATE TABLE personal_notes (id INTEGER PRIMARY KEY, note TEXT)' });
  await db.query({ sql: "INSERT INTO personal_notes VALUES (1, 'A real local file')" });
  await db.disconnect();
  assert.ok(fs.readFileSync(filePath).subarray(0, 16).equals(Buffer.from('SQLite format 3\0')));
  await db.connect({ mode: 'sqlite', filePath });
  assert.deepEqual((await db.schemas())[0].tables.map(table => table.name), ['personal_notes']);
  assert.deepEqual((await db.query({ sql: 'SELECT * FROM personal_notes' })).rows, [{ id: 1, note: 'A real local file' }]);
  assert.equal((await db.columns({ schema: 'main', table: 'personal_notes' }))[0].name, 'id');
});

test('local SQLite validates file choices and leaves the current connection usable on validation errors', async t => {
  const { db, dataDir } = await fixture(t);
  await assert.rejects(db.connect({ mode: 'sqlite', filePath: 'relative.db' }), /absolute SQLite file path/);
  await assert.rejects(db.connect({ mode: 'sqlite', filePath: dataDir }), /not a directory/);
  await assert.rejects(db.connect({ mode: 'sqlite', filePath: path.join(dataDir, 'missing-folder', 'new.db') }), /existing folder/);
  assert.equal((await db.query({ sql: 'SELECT COUNT(*) AS count FROM customers' })).rows[0].count, 6);
  const invalidFile = path.join(dataDir, 'not-a-database.db');
  fs.writeFileSync(invalidFile, 'This is not SQLite.');
  await assert.rejects(db.connect({ mode: 'sqlite', filePath: invalidFile }), /not a database/);
});

test('display cap and integers outside JS safe range are serialized honestly', async t => {
  const { db } = await fixture(t);
  const result = await db.query({ sql: 'WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n<1200) SELECT n FROM nums' });
  assert.equal(result.rows.length, MAX_ROWS);
  assert.equal(result.rowCount, MAX_ROWS);
  assert.equal(result.truncated, true);
  const integers = await db.query({ sql: 'SELECT 9223372036854775807 AS large, 42 AS small' });
  assert.deepEqual(integers.rows, [{ large: '9223372036854775807', small: 42 }]);
  JSON.stringify(integers);
});

test('duplicate SQL column labels retain every value without colliding with user aliases', async t => {
  const { db } = await fixture(t);
  const result = await db.query({ sql: 'SELECT 1 AS x, 2 AS x, 3 AS __column_0, 9223372036854775807 AS x, 5 AS ordinary' });
  assert.deepEqual(result.columns.map(column => column.name), ['x', 'x', '__column_0', 'x', 'ordinary']);
  const keys = result.columns.map(column => column.key);
  assert.equal(new Set(keys).size, 5);
  assert.equal(result.columns[2].key, '__column_0');
  assert.equal(result.columns[4].key, 'ordinary');
  assert.deepEqual(keys.map(key => result.rows[0][key]), [1, 2, 3, '9223372036854775807', 5]);
  assert.deepEqual((await db.query({ sql: 'SELECT 1 AS x, 2 AS x, 3 AS __column_0, 9223372036854775807 AS x, 5 AS ordinary' })).columns, result.columns);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('MySQL result arrays preserve duplicate fields while metadata queries retain object results', async t => {
  const { db } = await fixture(t);
  await db.disconnect();
  const calls = [];
  db.mode = 'mysql';
  db.connection = {
    async query(options) {
      calls.push(options);
      if (typeof options === 'string' && options.startsWith('SELECT TABLE_SCHEMA')) return [[{ schema_name: 'app', table_name: 'customers', table_type: 'BASE TABLE' }]];
      if (options === 'SHOW DATABASES') return [[{ Database: 'app' }]];
      return [[[1, 2, 3, 9007199254740993n]], [{ name: 'x', type: 3 }, { name: 'x', type: 3 }, { name: '__column_0', type: 3 }, { name: 'big', type: 8 }]];
    },
    async end() {},
  };
  const result = await db.query({ sql: 'SELECT duplicate columns' });
  assert.equal(calls[0].rowsAsArray, true);
  assert.equal(new Set(result.columns.map(column => column.key)).size, 4);
  assert.deepEqual(result.columns.map(column => result.rows[0][column.key]), [1, 2, 3, '9007199254740993']);
  assert.deepEqual(await db.schemas(), [{ name: 'app', tables: [{ name: 'customers', type: 'table' }] }]);
});

test('MySQL TLS is optional and enables certificate and hostname verification when selected', async t => {
  const { db } = await fixture(t);
  const mysql = require('mysql2/promise');
  const calls = [];
  t.mock.method(mysql, 'createConnection', async options => {
    calls.push(options);
    return { async end() {} };
  });
  const options = { mode: 'mysql', host: 'example.test', user: 'test' };
  await db.connect(options);
  assert.equal(calls[0].ssl, undefined);
  await db.connect({ ...options, tls: true });
  assert.deepEqual(calls[1].ssl, { rejectUnauthorized: true, verifyIdentity: true });
  await assert.rejects(db.connect({ ...options, tls: 'true' }), /TLS/);
  await db.connect({ ...options, tls: false });
  assert.equal(calls[2].ssl, undefined);
});

test('connection validation happens before attempting a network connection', async t => {
  const { db } = await fixture(t);
  await assert.rejects(db.connect({ mode: 'mysql', host: 'localhost', user: 'root', port: -1 }), /Port/);
  await assert.rejects(db.connect({ mode: 'mysql', host: '', user: 'root' }), /host/);
  await assert.rejects(db.connect({ mode: 'mysql', host: 'localhost', user: 'root', password: {} }), /password/);
  assert.equal((await db.query({ sql: 'SELECT 1 AS ok' })).rows[0].ok, 1);
  await db.disconnect();
  await assert.rejects(db.query({ sql: 'SELECT 1' }), /Connect to a database first/);
});

test('MySQL and MariaDB require a certificate hostname for TLS before opening a connection', async t => {
  const { db } = await fixture(t);
  const mysql = require('mysql2/promise');
  const createConnection = t.mock.method(mysql, 'createConnection', async () => ({ async end() {} }));
  for (const mode of ['mysql', 'mariadb']) {
    for (const host of ['192.0.2.1', '2001:db8::1']) {
      await assert.rejects(db.connect({ mode, host, user: 'test', tls: true }), /TLS requires a hostname/);
    }
  }
  assert.equal(createConnection.mock.callCount(), 0);
  assert.equal((await db.query({ sql: 'SELECT 1 AS ok' })).rows[0].ok, 1);
  await db.connect({ mode: 'mysql', host: '192.0.2.1', user: 'test', tls: false });
  assert.equal(createConnection.mock.calls[0].arguments[0].host, '192.0.2.1');
});

test('concurrent database operations fail clearly instead of crossing sessions', async t => {
  const { db } = await fixture(t);
  let release;
  const pending = db._exclusive(() => new Promise(resolve => { release = resolve; }));
  await assert.rejects(db.schemas(), /Another database operation/);
  release();
  await pending;
  assert.ok((await db.schemas()).length);
});

test('statement boundaries handle quoted strings, escapes and comments', () => {
  assert.equal(splitStatements("SELECT 'a; b'; -- comment;\n").length, 1);
  assert.equal(splitStatements("SELECT 'it''s; fine'; /* ; */").length, 1);
  assert.equal(splitStatements('SELECT 1; SELECT 2').length, 2);
  assert.equal(splitStatements("SELECT 'a\\\';b';", 'mysql').length, 1);
  assert.equal(splitStatements('SELECT 1;--comment;\n', 'sqlite').length, 1);
  assert.equal(splitStatements("DO $body$ BEGIN RAISE NOTICE 'hello;'; END $body$; SELECT 2", 'postgres').length, 2);
  assert.equal(splitStatements("SELECT E'a\\\';b';", 'postgres').length, 1);
  assert.equal(splitStatements('SELECT [name]]with;semicolon]; SELECT 2', 'mssql').length, 2);
  assert.equal(splitStatements('SELECT 1 /* outer /* inner ; */ still outer ; */; SELECT 2', 'postgres').length, 2);
  assert.throws(() => splitStatements("SELECT 1; SELECT 'unfinished", 'postgres'), /unterminated/);
  assert.throws(() => splitStatements('SELECT $$unfinished', 'postgres'), /unterminated/);
  assert.throws(() => splitStatements('SELECT 1 /* unfinished', 'mysql'), /unterminated/);
});

test('SQLite engine information reports the real version and transaction state', async t => {
  const { db, dataDir } = await fixture(t);
  const info = await db.info();
  assert.equal(info.engine, 'SQLite');
  assert.match(info.version, /^\d+\.\d+/);
  assert.equal(info.database, 'main');
  assert.equal(info.connection.filePath, path.join(dataDir, 'demo.db'));
  await db.query({ sql: 'BEGIN' });
  assert.equal((await db.info()).transaction, true);
  await db.query({ sql: 'ROLLBACK' });
  assert.equal((await db.info()).transaction, false);
});

test('MariaDB uses the MySQL protocol and engine identity; USE updates selected database', async t => {
  const { db } = await fixture(t);
  const calls = [];
  db._drivers.mysql = { async createConnection(config) {
    calls.push(config);
    return { async end() {}, async query(options) {
      calls.push(options);
      if (options === 'SELECT DATABASE() AS current_database') return [[{ current_database: 'chosen' }]];
      if (typeof options === 'string' && options.startsWith('SELECT VERSION()')) return [[{ version: '11.8.0', database_name: 'chosen', server: 'local', authenticated_user: 'tester@localhost' }]];
      return [{ affectedRows: 0 }, undefined];
    } };
  } };
  const connection = await db.connect({ mode: 'mariadb', host: 'localhost', user: 'tester', database: 'before' });
  assert.equal(connection.dialect, 'MariaDB');
  assert.equal(calls[0].port, 3306);
  const changed = await db.query({ sql: 'USE `chosen`', schema: 'before' });
  assert.equal(changed.database, 'chosen');
  assert.equal(changed.schema, 'chosen');
  const info = await db.info();
  assert.equal(info.engine, 'MariaDB');
  assert.equal(info.user, 'tester@localhost');
  assert.equal(info.transaction, null);
});

test('PostgreSQL driver configuration, array results, schemas and parameterized columns share a real adapter boundary', async t => {
  const { db } = await fixture(t);
  const calls = [];
  class Client {
    constructor(config) { calls.push({ config }); }
    on() {}
    async connect() {}
    async end() { calls.push({ ended: true }); }
    async query(query, params) {
      calls.push({ query, params });
      if (typeof query === 'object') {
        if (query.text === 'UPDATE sample SET x=1') return { rows: [], fields: [], rowCount: 2 };
        return { rows: [[1, 2, '9007199254740993']], fields: [{ name: 'x', dataTypeID: 23 }, { name: 'x', dataTypeID: 23 }, { name: 'big', dataTypeID: 20 }], rowCount: 1 };
      }
      if (query.startsWith('SELECT table_schema')) return { rows: [{ schema_name: 'public', table_name: 'sample', table_type: 'BASE TABLE' }] };
      if (query.startsWith('SELECT schema_name')) return { rows: [{ schema_name: 'public' }, { schema_name: 'empty' }] };
      if (query.startsWith('SELECT c.column_name')) return { rows: [{ name: 'id', type: 'bigint', is_nullable: 'NO', column_key: 'PRI' }] };
      if (query.startsWith('SELECT version()')) return { rows: [{ version: 'PostgreSQL 18', database_name: 'app', server: '127.0.0.1', authenticated_user: 'tester', current_schema: 'public' }] };
      return { rows: [] };
    }
  }
  db._drivers.postgres = { Client };
  const connected = await db.connect({ mode: 'postgres', host: 'localhost', user: 'tester', password: 'notpersisted', database: 'app', tls: true });
  assert.equal(connected.dialect, 'PostgreSQL');
  assert.equal(connected.schema, 'public');
  assert.equal(calls[0].config.port, 5432);
  assert.deepEqual(calls[0].config.ssl, { rejectUnauthorized: true });
  assert.deepEqual(await db.schemas(), [{ name: 'public', tables: [{ name: 'sample', type: 'table' }] }, { name: 'empty', tables: [] }]);
  assert.deepEqual(await db.columns({ schema: 'public', table: "sample'quoted" }), [{ name: 'id', type: 'bigint', nullable: false, primaryKey: true }]);
  const columnCall = calls.find(call => typeof call.query === 'string' && call.query.startsWith('SELECT c.column_name'));
  assert.deepEqual(columnCall.params, ['public', "sample'quoted"]);
  assert.equal(columnCall.query.includes("sample'quoted"), false);
  const result = await db.query({ sql: 'SELECT 1 AS x, 2 AS x', schema: 'chosen"schema' });
  assert.deepEqual(result.columns.map(column => result.rows[0][column.key]), [1, 2, '9007199254740993']);
  assert.equal(result.schema, 'chosen"schema');
  assert.equal(calls.find(call => call.query?.rowMode).query.rowMode, 'array');
  assert.deepEqual(calls.find(call => typeof call.query === 'string' && call.query.includes('set_config')).params, ['"chosen""schema"']);
  assert.equal((await db.query({ sql: 'UPDATE sample SET x=1' })).affectedRows, 2);
  const info = await db.info();
  assert.equal(info.engine, 'PostgreSQL');
  assert.equal(info.user, 'tester');
  assert.equal('password' in info.connection, false);
});

test('SQL Server adapter keeps transaction requests on the same driver transaction and preserves duplicate columns', async t => {
  const { db } = await fixture(t);
  const calls = [];
  const answer = async (sql, request) => {
    calls.push({ sql, inputs: request.inputs, transaction: request.transaction, arrayRowMode: request.arrayRowMode });
    if (sql.startsWith('SELECT TABLE_SCHEMA')) return { recordset: [{ schema_name: 'dbo', table_name: 'sample', table_type: 'BASE TABLE' }] };
    if (sql.startsWith('SELECT name AS schema_name')) return { recordset: [{ schema_name: 'dbo' }, { schema_name: 'empty' }] };
    if (sql.startsWith('SELECT c.COLUMN_NAME')) return { recordset: [{ name: 'id', type: 'bigint', is_nullable: 'NO', column_key: 'PRI' }] };
    if (sql.startsWith("SELECT CAST(SERVERPROPERTY")) return { recordset: [{ version: '17.0', database_name: 'app', server: 'local', authenticated_user: 'tester', current_schema: 'dbo' }] };
    if (sql === 'UPDATE sample SET x=1') return { recordsets: [], rowsAffected: [2] };
    const recordset = [[1, 2, '9223372036854775807']];
    return { recordsets: [recordset], recordset, columns: [[{ name: 'x', index: 0, type: { declaration: 'int' } }, { name: 'x', index: 1, type: { declaration: 'int' } }, { name: 'large', index: 2, type: { declaration: 'bigint' } }]], rowsAffected: [1] };
  };
  const request = transaction => ({ inputs: {}, transaction, input(name, value) { this.inputs[name] = value; return this; }, query(sql) { return answer(sql, this); } });
  class ConnectionPool {
    constructor(config) { calls.push({ config }); }
    on() {}
    async connect() {}
    async close() { calls.push({ close: true }); }
    request() { return request(false); }
  }
  class Transaction {
    constructor(pool) { this.pool = pool; }
    on() {}
    async begin() { calls.push({ begin: true }); }
    async commit() { calls.push({ commit: true }); }
    async rollback() { calls.push({ rollback: true }); }
    request() { return request(true); }
  }
  db._drivers.mssql = { ConnectionPool, Transaction };
  const connected = await db.connect({ mode: 'mssql', host: 'localhost', user: 'tester', database: 'app', tls: true });
  assert.equal(connected.dialect, 'SQL Server');
  assert.equal(connected.schema, 'dbo');
  assert.equal(calls[0].config.port, 1433);
  assert.deepEqual(calls[0].config.options, { encrypt: true, trustServerCertificate: false, enableArithAbort: true });
  assert.deepEqual(await db.schemas(), [{ name: 'dbo', tables: [{ name: 'sample', type: 'table' }] }, { name: 'empty', tables: [] }]);
  assert.deepEqual(await db.columns({ schema: 'dbo', table: "sample'quoted" }), [{ name: 'id', type: 'bigint', nullable: false, primaryKey: true }]);
  assert.deepEqual(calls.find(call => call.sql?.startsWith('SELECT c.COLUMN_NAME')).inputs, { schema: 'dbo', table: "sample'quoted" });
  await db.query({ sql: 'BEGIN TRANSACTION' });
  const result = await db.query({ sql: 'SELECT 1 AS x, 2 AS x' });
  assert.deepEqual(result.columns.map(column => result.rows[0][column.key]), [1, 2, '9223372036854775807']);
  assert.equal(calls.find(call => call.sql === 'SELECT 1 AS x, 2 AS x').transaction, true);
  assert.equal(calls.find(call => call.sql === 'SELECT 1 AS x, 2 AS x').arrayRowMode, true);
  assert.equal((await db.info()).transaction, true);
  await db.query({ sql: 'COMMIT' });
  assert.ok(calls.some(call => call.commit));
  assert.equal((await db.info()).transaction, false);
  assert.equal((await db.query({ sql: 'UPDATE sample SET x=1' })).affectedRows, 2);
  await db.query({ sql: 'BEGIN' });
  await db.disconnect();
  assert.ok(calls.some(call => call.rollback), 'Disconnect must release the held transaction before its pool closes.');
});

test('failed PostgreSQL and SQL Server connections close resources and redact connection passwords', async t => {
  const { db } = await fixture(t);
  let ended = false, closed = false;
  db._drivers.postgres = { Client: class { on() {} async connect() { throw new Error('rejected connection-secret'); } async end() { ended = true; } } };
  db._drivers.mssql = { ConnectionPool: class { on() {} async connect() { throw new Error('rejected connection-secret'); } async close() { closed = true; } } };
  for (const mode of ['postgres', 'mssql']) await assert.rejects(db.connect({ mode, host: 'localhost', user: 'test', password: 'connection-secret' }), error => error.message.includes('[redacted]') && !error.message.includes('connection-secret'));
  assert.equal(ended, true); assert.equal(closed, true);
});
