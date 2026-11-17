'use strict';

const fs = require('node:fs');
const { isIP } = require('node:net');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { normalizeSsh, inspectHostKey, openSshTunnel, redact: redactSsh } = require('./ssh-tunnel.cjs');

const MAX_ROWS = 1000;
const {collector,readMysql,readPostgres,readMssql}=require('./result-reader.cjs');
const ENGINES = Object.freeze({
  mysql: { name: 'MySQL', port: 3306, dialect: 'mysql' },
  mariadb: { name: 'MariaDB', port: 3306, dialect: 'mysql' },
  postgres: { name: 'PostgreSQL', port: 5432, dialect: 'postgres', schema: 'public' },
  mssql: { name: 'SQL Server', port: 1433, dialect: 'mssql', schema: 'dbo' },
  sqlite: { name: 'SQLite', dialect: 'sqlite', schema: 'main' },
  demo: { name: 'SQLite', dialect: 'sqlite', schema: 'main' },
});
const isLocal = mode => mode === 'sqlite' || mode === 'demo';
const isMySql = mode => mode === 'mysql' || mode === 'mariadb';

function safeValue(value) {
  if (typeof value === 'bigint') {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (Array.isArray(value)) return value.map(safeValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, safeValue(entry)]));
  return value;
}

function keyedColumns(columns) {
  const counts = new Map();
  for (const column of columns) counts.set(column.name, (counts.get(column.name) || 0) + 1);
  const reserved = new Set(columns.map(column => column.name));
  const used = new Set();
  return columns.map((column, index) => {
    let key = column.name;
    if (counts.get(column.name) > 1) {
      const base = '__column_' + index;
      key = base;
      let suffix = 1;
      while (reserved.has(key) || used.has(key)) key = base + '_' + suffix++;
    }
    used.add(key);
    return { ...column, key };
  });
}

function keyedRow(row, columns) {
  return Object.fromEntries(columns.map((column, index) => [column.key, safeValue(row[index])]));
}

// Count statements without mistaking quoted semicolons or comments for a separator.
function splitStatements(sql, dialect = 'mysql') {
  const statements = [];
  let current = '';
  let quote = null;
  let comment = null;
  let blockDepth = 0;
  let dollarQuote = null;
  let escapeString = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], next = sql[i + 1];
    if (dollarQuote) {
      if (sql.startsWith(dollarQuote, i)) { current += dollarQuote; i += dollarQuote.length - 1; dollarQuote = null; }
      else current += c;
      continue;
    }
    if (comment === 'line') {
      if (c === '\n') { comment = null; current += ' '; }
      continue;
    }
    if (comment === 'block') {
      if ((dialect === 'postgres' || dialect === 'mssql') && c === '/' && next === '*') { blockDepth++; i++; }
      else if (c === '*' && next === '/') { blockDepth--; if (!blockDepth) { comment = null; current += ' '; } i++; }
      continue;
    }
    if (quote) {
      current += c;
      if (c === (quote === '[' ? ']' : quote)) {
        if (next === (quote === '[' ? ']' : quote)) { current += next; i++; } else quote = null;
      } else if ((dialect === 'mysql' || escapeString) && c === '\\' && next) { current += next; i++; }
      continue;
    }
    if (c === '-' && next === '-' && (dialect !== 'mysql' || /\s|$/.test(sql[i + 2] || ''))) { comment = 'line'; i++; continue; }
    if (c === '#' && dialect === 'mysql') { comment = 'line'; continue; }
    if (c === '/' && next === '*') { comment = 'block'; blockDepth = 1; i++; continue; }
    if (dialect === 'postgres' && c === '$') {
      const marker = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/)?.[0];
      if (marker) { dollarQuote = marker; current += marker; i += marker.length - 1; continue; }
    }
    if (c === "'" || c === '"' || c === '`' || (c === '[' && (dialect === 'sqlite' || dialect === 'mssql'))) {
      quote = c;
      escapeString = dialect === 'postgres' && c === "'" && /[eE]/.test(sql[i - 1] || '') && !/[A-Za-z_0-9]/.test(sql[i - 2] || '');
    }
    if (c === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
    } else current += c;
  }
  if (quote || dollarQuote) throw new Error('SQL contains an unterminated quoted string or identifier.');
  if (comment === 'block') throw new Error('SQL contains an unterminated block comment.');
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function checkedString(value, label, { optional = false, maximum = 256 } = {}) {
  if (optional && (value === undefined || value === '')) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) {
    throw new Error(`Enter a valid ${label}.`);
  }
  return value.trim();
}

function identifier(value, dialect = 'mysql') {
  const checked = checkedString(value, 'SQL identifier');
  if (dialect === 'postgres') return '"' + checked.replaceAll('"', '""') + '"';
  if (dialect === 'mssql') return '[' + checked.replaceAll(']', ']]') + ']';
  return '`' + checked.replaceAll('`', '``') + '`';
}

class DatabaseService {
  constructor({ dataDir, drivers = {} }) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new Error('An absolute data directory is required.');
    fs.mkdirSync(dataDir, { recursive: true });
    this.dataDir = dataDir;
    this.connection = null;
    this.mode = null;
    this.database = null;
    this._busy = false;
    this._password = '';
    this.schema = null;
    this.connectionInfo = null;
    this._transaction = null;
    this._drivers = drivers;
    this._tunnel = null;
    this._sshSecrets = [];
  }

  async _exclusive(operation) {
    if (this._busy) throw new Error('Another database operation is running. Wait for it to finish.');
    this._busy = true;
    try { return await operation(); }
    catch (error) {
      let message = error && typeof error.message === 'string' ? error.message : 'The database operation failed.';
      if (this._password) message = message.split(this._password).join('[redacted]');
      message = redactSsh(message, this._sshSecrets);
      throw new Error(message.slice(0, 2000));
    } finally { this._busy = false; }
  }

  _requireConnection() {
    if (!this.connection) throw new Error('Connect to a database first.');
    if (this._tunnel?.failed) throw new Error('SSH tunnel closed. Reconnect to continue.');
  }

  async sshFingerprint(options) { return this._exclusive(() => inspectHostKey(options)); }

  async connect(options = {}) {
    return this._exclusive(async () => {
      if (!options || !Object.hasOwn(ENGINES, options.mode)) throw new Error('Select a supported database connection mode.');
      let networkOptions;
      let sqlitePath;
      const ssh = normalizeSsh(options.ssh);
      if (ssh && isLocal(options.mode)) throw new Error('SSH tunneling is available for server databases, not SQLite files.');
      if (options.mode === 'sqlite') {
        if (typeof options.filePath !== 'string' || !path.isAbsolute(options.filePath) || options.filePath.includes('\0')) throw new Error('Choose an absolute SQLite file path.');
        sqlitePath = options.filePath;
        if (fs.existsSync(sqlitePath) && !fs.statSync(sqlitePath).isFile()) throw new Error('Choose a SQLite database file, not a directory.');
        if (!fs.existsSync(path.dirname(sqlitePath)) || !fs.statSync(path.dirname(sqlitePath)).isDirectory()) throw new Error('Choose an existing folder for the SQLite file.');
      }
      if (!isLocal(options.mode)) {
        const host = checkedString(options.host, 'host');
        const user = checkedString(options.user, 'user');
        const database = checkedString(options.database, 'database', { optional: true });
        const port = options.port === undefined || options.port === '' ? ENGINES[options.mode].port : Number(options.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535.');
        if (options.password !== undefined && typeof options.password !== 'string') throw new Error('Enter a valid password.');
        if (options.tls !== undefined && typeof options.tls !== 'boolean') throw new Error('TLS must be enabled or disabled.');
        // mysql2 only reliably verifies the configured server identity for DNS names.
        if (options.tls && isMySql(options.mode) && isIP(host)) {
          throw new Error(`${ENGINES[options.mode].name} TLS requires a hostname that matches the server certificate. Enter that name in Host.`);
        }
        networkOptions = { host, user, database, port, password: options.password || '', tls: options.tls === true };
      }
      await this._disconnect();
      if (isLocal(options.mode)) {
        const { DatabaseSync } = require('node:sqlite');
        const connection = new DatabaseSync(sqlitePath || path.join(this.dataDir, 'demo.db'));
        try {
          connection.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
          const initialized = connection.prepare('PRAGMA user_version').get().user_version === 1;
          if (options.mode === 'demo' && !initialized) connection.exec(`
            BEGIN;
            CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, city TEXT NOT NULL);
            CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), total REAL NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
            CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, price REAL NOT NULL, stock INTEGER NOT NULL);
            INSERT INTO customers VALUES (1,'Avery Chen','avery@example.test','Bengaluru'),(2,'Jordan Patel','jordan@example.test','Mumbai'),(3,'Morgan Lee','morgan@example.test','Chennai'),(4,'Riley Shah','riley@example.test','Pune'),(5,'Casey Kumar','casey@example.test','Delhi'),(6,'Taylor Rao','taylor@example.test','Hyderabad');
            INSERT INTO orders VALUES (1001,1,249.00,'Completed','2026-10-20'),(1002,2,128.50,'Processing','2026-10-21'),(1003,1,89.00,'Completed','2026-10-22'),(1004,3,420.00,'Shipped','2026-10-23'),(1005,4,75.00,'Completed','2026-10-24'),(1006,5,310.00,'Processing','2026-10-25'),(1007,6,199.00,'Shipped','2026-10-26'),(1008,2,59.50,'Completed','2026-10-27');
            INSERT INTO products VALUES (1,'Mechanical Keyboard','Accessories',129.00,42),(2,'USB-C Hub','Accessories',59.50,85),(3,'Studio Monitor','Displays',249.00,18),(4,'Desk Lamp','Workspace',75.00,36),(5,'Notebook Set','Stationery',19.00,120),(6,'Wireless Mouse','Accessories',89.00,57);
            PRAGMA user_version = 1;
            COMMIT;
          `);
          this.connection = connection;
          this.mode = options.mode;
          this.database = 'main';
          this.schema = 'main';
          this.connectionInfo = { filePath: sqlitePath || path.join(this.dataDir, 'demo.db') };
        } catch (error) { connection.close(); throw error; }
      } else {
        this._password = networkOptions.password;
        this._sshSecrets = [options.ssh?.password, options.ssh?.passphrase].filter(value => typeof value === 'string' && value);
        const { host, user, database, port, password, tls } = networkOptions;
        try {
        if (ssh) this._tunnel = await openSshTunnel(options.ssh, { host, port });
        const tunnel = this._tunnel;
        if (isMySql(options.mode)) {
          const mysql = this._drivers.mysql || require('mysql2/promise');
          this.connection = await mysql.createConnection({ host, user, database, port, password, connectTimeout: 10000, multipleStatements: false, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, ...(tunnel ? { stream: () => tunnel.socket() } : {}), ...(tls ? { ssl: { rejectUnauthorized: true, verifyIdentity: true } } : {}) });
          this.connection.on?.('error', () => {});
        } else if (options.mode === 'postgres') {
          const pg = this._drivers.postgres || require('pg');
          // Keep the actual database hostname in pg's TLS configuration while
          // directing only the underlying TCP socket to our loopback listener.
          const stream = tunnel ? () => { const socket = new (require('node:net').Socket)(); const connect = socket.connect; socket.connect = () => connect.call(socket, tunnel.port, tunnel.host); return socket; } : undefined;
          const connection = new pg.Client({ host, user, database: database || user, port, password, connectionTimeoutMillis: 10000, statement_timeout: 30000, query_timeout: 30000, ssl: tls ? { rejectUnauthorized: true } : false, ...(stream ? { stream } : {}) });
          connection.on?.('error', () => {});
          try { await connection.connect(); this.connection = connection; }
          catch (error) { try { await connection.end(); } catch {} throw error; }
        } else {
          const mssql = this._drivers.mssql || require('mssql');
          const connector = tunnel ? async (target, lookup, signal) => {
            if (target.host !== host || Number(target.port) !== port) throw new Error('SQL Server redirected this connection to a different endpoint. Configure that endpoint explicitly for SSH.');
            const socket = tunnel.socket(signal);
            await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
            return socket;
          } : undefined;
          const connection = new mssql.ConnectionPool({ server: host, user, database: database || 'master', port, password, connectionTimeout: 10000, requestTimeout: 30000, pool: { max: 1, min: 0, idleTimeoutMillis: 300000 }, options: { encrypt: tls, trustServerCertificate: false, enableArithAbort: true, ...(connector ? { connector, serverName: host } : {}) } });
          connection.on?.('error', () => {});
          try { await connection.connect(); this.connection = connection; }
          catch (error) { try { await connection.close(); } catch {} throw error; }
        }
        this.mode = options.mode;
        this.database = database || (options.mode === 'postgres' ? user : options.mode === 'mssql' ? 'master' : null);
        this.schema = isMySql(options.mode) ? this.database : ENGINES[options.mode].schema;
        this.connectionInfo = { host, port, user, tls, ...(ssh ? { ssh } : {}) };
        } catch (error) {
          const message = redactSsh(this._tunnel?.forwardFailure || error.message, [password, ...this._sshSecrets]);
          try { await this._disconnect(); } catch {}
          throw new Error(message);
        }
      }
      return { connected: true, mode: this.mode, database: this.database, dialect: ENGINES[this.mode].name, ...(!isLocal(this.mode) ? { schema: this.schema } : {}) };
    });
  }

  async _disconnect() {
    const tunnel = this._tunnel;
    this._tunnel = null;
    try {
    if (this.connection) {
      const previous = this.connection;
      const previousMode = this.mode;
      this.connection = null;
      this.mode = null;
      this.database = null;
      if (this._transaction) { try { await this._transaction.rollback(); } catch {} this._transaction = null; }
      if (isLocal(previousMode)) previous.close();
      else if (previousMode === 'mssql') await previous.close();
      else await previous.end();
    }
    this._password = '';
    this.schema = null;
    this.connectionInfo = null;
    } finally {
      this._password = '';
      this._sshSecrets = [];
      this.schema = null;
      this.connectionInfo = null;
      await tunnel?.close();
    }
    return { connected: false };
  }

  async disconnect() { return this._exclusive(() => this._disconnect()); }
  async close() { return this.disconnect(); }

  async schemas() {
    return this._exclusive(async () => {
      this._requireConnection();
      if (isLocal(this.mode)) {
        const tables = this.connection.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
        return [{ name: 'main', tables: tables.map(({ name, type }) => ({ name, type })) }];
      }
      let rows, names;
      if (isMySql(this.mode)) {
        [rows] = await this.connection.query('SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name, TABLE_TYPE AS table_type FROM information_schema.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME');
        const [databases] = await this.connection.query('SHOW DATABASES');
        names = databases.map(row => String(Object.values(row)[0]));
      } else if (this.mode === 'postgres') {
        rows = (await this.connection.query("SELECT table_schema AS schema_name, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ('information_schema','pg_catalog') ORDER BY table_schema, table_name")).rows;
        names = (await this.connection.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema','pg_catalog') AND schema_name NOT LIKE 'pg_toast%' ORDER BY schema_name")).rows.map(row => row.schema_name);
      } else {
        rows = (await this._mssqlRequest().query('SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name, TABLE_TYPE AS table_type FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME')).recordset;
        names = (await this._mssqlRequest().query("SELECT name AS schema_name FROM sys.schemas WHERE name NOT IN ('sys','INFORMATION_SCHEMA','guest') AND schema_id < 16384 ORDER BY name")).recordset.map(row => row.schema_name);
      }
      const groups = new Map(names.map(name => [name, []]));
      for (const row of rows) {
        if (!groups.has(row.schema_name)) groups.set(row.schema_name, []);
        groups.get(row.schema_name).push({ name: row.table_name, type: row.table_type === 'VIEW' ? 'view' : 'table' });
      }
      return [...groups].map(([name, tables]) => ({ name, tables }));
    });
  }

  async columns({ schema, table } = {}) {
    return this._exclusive(async () => {
      this._requireConnection();
      checkedString(table, 'table');
      if (isLocal(this.mode)) {
        if (schema && schema !== 'main') throw new Error('The SQLite database schema is main.');
        return this.connection.prepare('SELECT name, type, "notnull" AS required, pk AS primaryKey FROM pragma_table_info(?)').all(table).map(row => ({ name: row.name, type: row.type, nullable: !row.required, primaryKey: Boolean(row.primaryKey) }));
      }
      const selectedSchema = checkedString(schema || this.schema || this.database, 'schema');
      let rows;
      if (isMySql(this.mode)) [rows] = await this.connection.query('SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS is_nullable, COLUMN_KEY AS column_key FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [selectedSchema, table]);
      else if (this.mode === 'postgres') rows = (await this.connection.query(`SELECT c.column_name AS name, c.data_type AS type, c.is_nullable,
        CASE WHEN EXISTS (SELECT 1 FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.constraint_schema=kcu.constraint_schema WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema=c.table_schema AND tc.table_name=c.table_name AND kcu.column_name=c.column_name) THEN 'PRI' ELSE '' END AS column_key
        FROM information_schema.columns c WHERE c.table_schema=$1 AND c.table_name=$2 ORDER BY c.ordinal_position`, [selectedSchema, table])).rows;
      else {
        const request = this._mssqlRequest();
        request.input('schema', selectedSchema); request.input('table', table);
        rows = (await request.query(`SELECT c.COLUMN_NAME AS name, c.DATA_TYPE AS type, c.IS_NULLABLE AS is_nullable,
          CASE WHEN EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON tc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME AND tc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA WHERE tc.CONSTRAINT_TYPE='PRIMARY KEY' AND tc.TABLE_SCHEMA=c.TABLE_SCHEMA AND tc.TABLE_NAME=c.TABLE_NAME AND kcu.COLUMN_NAME=c.COLUMN_NAME) THEN 'PRI' ELSE '' END AS column_key
          FROM INFORMATION_SCHEMA.COLUMNS c WHERE c.TABLE_SCHEMA=@schema AND c.TABLE_NAME=@table ORDER BY c.ORDINAL_POSITION`)).recordset;
      }
      return rows.map(row => ({ name: row.name, type: row.type, nullable: row.is_nullable === 'YES', primaryKey: row.column_key === 'PRI' }));
    });
  }

  _mssqlRequest() { return (this._transaction || this.connection).request(); }

  async info() {
    return this._exclusive(async () => {
      this._requireConnection();
      let details;
      if (isLocal(this.mode)) {
        const version = this.connection.prepare('SELECT sqlite_version() AS version').get().version;
        details = { version, database: 'main', server: 'This computer', user: null, schema: 'main' };
      } else if (isMySql(this.mode)) {
        const [rows] = await this.connection.query('SELECT VERSION() AS version, DATABASE() AS database_name, @@hostname AS server, CURRENT_USER() AS authenticated_user');
        const row = rows[0]; this.database = row.database_name; this.schema = row.database_name;
        details = { version: row.version, database: row.database_name, server: row.server, user: row.authenticated_user, schema: row.database_name };
      } else if (this.mode === 'postgres') {
        const row = (await this.connection.query('SELECT version() AS version, current_database() AS database_name, inet_server_addr()::text AS server, current_user AS authenticated_user, current_schema() AS current_schema')).rows[0];
        this.database = row.database_name; this.schema = row.current_schema;
        details = { version: row.version, database: row.database_name, server: row.server, user: row.authenticated_user, schema: row.current_schema };
      } else {
        const row = (await this._mssqlRequest().query("SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version, DB_NAME() AS database_name, CAST(SERVERPROPERTY('ServerName') AS nvarchar(128)) AS server, SUSER_SNAME() AS authenticated_user, SCHEMA_NAME() AS current_schema")).recordset[0];
        this.database = row.database_name;
        details = { version: row.version, database: row.database_name, server: row.server, user: row.authenticated_user, schema: row.current_schema };
      }
      return { engine: ENGINES[this.mode].name, ...details, connection: { ...this.connectionInfo }, transaction: this.mode === 'mssql' ? Boolean(this._transaction) : isLocal(this.mode) && typeof this.connection.isTransaction === 'boolean' ? this.connection.isTransaction : null };
    });
  }

  async query({ sql, schema } = {}) {
    return this._exclusive(async () => {
      this._requireConnection();
      if (typeof sql !== 'string' || !sql.trim() || sql.length > 1000000 || sql.includes('\0')) throw new Error('Enter a SQL statement (up to 1 MB).');
      const statements = splitStatements(sql, ENGINES[this.mode].dialect);
      if (statements.length !== 1) throw new Error('Run one SQL statement at a time. Select the statement you want to execute.');
      const start = performance.now();
      let columns = [], rows = [], affectedRows = 0, truncated = false, resultBytes = 0, limitReason = null;
      if (isLocal(this.mode)) {
        if (schema && schema !== 'main') throw new Error('The SQLite database schema is main.');
        const statement = this.connection.prepare(sql);
        columns = keyedColumns(statement.columns().map(column => ({ name: column.name, type: column.type || 'expression' })));
        statement.setReadBigInts(true);
        statement.setReturnArrays(true);
        if (columns.length) {
          const kept=collector();
          for (const row of statement.iterate()) { kept.add(row); if(kept.result.truncated)break; }
          rows=kept.result.rows.map(row=>keyedRow(row,columns));({truncated,resultBytes,limitReason}=kept.result);
        } else {
          const before = this.connection.prepare('SELECT total_changes() AS count').get().count;
          const outcome = statement.run();
          const after = this.connection.prepare('SELECT total_changes() AS count').get().count;
          affectedRows = after > before ? Number(outcome.changes) : 0;
        }
      } else if (isMySql(this.mode)) {
        if (schema && schema !== this.database) {
          await this.connection.query('USE ' + identifier(schema));
          this.database = schema;
        }
        if(this.connection.connection?.query){
          const output=await readMysql(this.connection,sql);
          columns=keyedColumns(output.fields.map(field=>({name:field.name,type:String(field.type)})));
          rows=output.rows.map(row=>keyedRow(row,columns));affectedRows=columns.length?0:output.affectedRows;
          ({truncated,resultBytes,limitReason}=output);this._observeServerStatus?.(output.serverStatus);
        }else{
        const [result, fields] = await this.connection.query({ sql, timeout: 30000, rowsAsArray: true });
        if (Array.isArray(result)) {
          if (!Array.isArray(fields) || fields.some(field => typeof field.name !== 'string') || result.some(row => !Array.isArray(row))) throw new Error('This query returned multiple or unsupported result sets. Run a query with one tabular result.');
          columns = keyedColumns(fields.map(field => ({ name: field.name, type: String(field.type) })));
          truncated = result.length > MAX_ROWS;
          rows = result.slice(0, MAX_ROWS).map(row => keyedRow(row, columns));
        } else affectedRows = Number(result.affectedRows || 0);
        }
        if (/^USE\s/i.test(statements[0])) {
          const [state] = await this.connection.query('SELECT DATABASE() AS current_database');
          this.database = state[0].current_database;
        }
        this.schema = this.database;
      } else if (this.mode === 'postgres') {
        if (schema && schema !== this.schema) {
          await this.connection.query("SELECT set_config('search_path', $1, false)", [identifier(schema, 'postgres')]);
          this.schema = schema;
        }
        const PgQuery=(this._drivers.postgres||require('pg')).Query;
        if(PgQuery&&this.connection.connection?.on){
          const output=await readPostgres(this.connection,sql,PgQuery);
          columns=keyedColumns(output.fields.map(field=>({name:field.name,type:String(field.dataTypeID)})));
          rows=output.rows.map(row=>keyedRow(row,columns));affectedRows=output.affectedRows;({truncated,resultBytes,limitReason}=output);
        }else{
        const result = await this.connection.query({ text: sql, rowMode: 'array', query_timeout: 30000 });
        if (Array.isArray(result)) throw new Error('This query returned multiple result sets. Run one statement at a time.');
        columns = keyedColumns((result.fields || []).map(field => ({ name: field.name, type: String(field.dataTypeID) })));
        truncated = result.rows.length > MAX_ROWS;
        rows = result.rows.slice(0, MAX_ROWS).map(row => keyedRow(row, columns));
        if (!columns.length) affectedRows = Number(result.rowCount || 0);
        }
        if (/^(SET|RESET)\b/i.test(statements[0])) {
          const state = (await this.connection.query('SELECT current_schema() AS current_schema')).rows[0];
          this.schema = state.current_schema;
        }
      } else {
        const command = statements[0].trim().replace(/;$/, '');
        if (/^(?:BEGIN(?:\s+TRAN(?:SACTION)?)?|START\s+TRANSACTION)$/i.test(command)) {
          if (this._transaction) throw new Error('A transaction is already open. Commit or roll back first.');
          const mssql = this._drivers.mssql || require('mssql');
          const transaction = new mssql.Transaction(this.connection);
          await transaction.begin();
          this._transaction = transaction;
          transaction.on?.('rollback', () => { if (this._transaction === transaction) this._transaction = null; });
        } else if (/^(COMMIT|ROLLBACK)(?:\s+TRAN(?:SACTION)?)?$/i.test(command) && this._transaction) {
          const transaction = this._transaction;
          if (/^COMMIT/i.test(command)) await transaction.commit(); else await transaction.rollback();
          this._transaction = null;
        } else {
          const request = this._mssqlRequest(); request.arrayRowMode = true;
          if(typeof request.on==='function'){
            const output=await readMssql(request,sql);
            columns=keyedColumns(output.fields.map(field=>({name:field.name,type:field.type?.declaration||field.type?.name||'value'})));
            rows=output.rows.map(row=>keyedRow(row,columns));affectedRows=output.affectedRows;({truncated,resultBytes,limitReason}=output);
          }else{
          const result = await request.query(sql);
          if (result.recordsets?.length > 1) throw new Error('This query returned multiple result sets. Run a query with one tabular result.');
          const recordset = result.recordset || [];
          const suppliedColumns = recordset.columns || result.columns?.[0] || [];
          const metadata = Array.isArray(suppliedColumns) ? suppliedColumns : Object.values(suppliedColumns).sort((a,b) => a.index-b.index);
          columns = keyedColumns(metadata.map(field => ({ name: field.name, type: field.type?.declaration || field.type?.name || 'value' })));
          truncated = recordset.length > MAX_ROWS;
          rows = recordset.slice(0, MAX_ROWS).map(row => keyedRow(row, columns));
          if (!columns.length) affectedRows = (result.rowsAffected || []).reduce((sum, count) => sum + Number(count || 0), 0);
          }
          if (/^USE\s/i.test(command)) this.database = (await this._mssqlRequest().query('SELECT DB_NAME() AS current_database')).recordset[0].current_database;
        }
      }
      return { columns, rows, rowCount: rows.length, affectedRows, elapsedMs: Math.round((performance.now() - start) * 100) / 100, truncated, resultBytes, limitReason, mode: this.mode, database: this.database, schema: this.schema };
    });
  }
}

require('./table-edit.cjs').installTableEditing(DatabaseService);
require('./database-transfer.cjs').installDatabaseTransfer(DatabaseService);
module.exports = { DatabaseService, splitStatements, MAX_ROWS, ENGINES };
