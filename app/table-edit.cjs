'use strict';

// Grid writes use a server-held snapshot, bound values and a single transaction.
// Arbitrary query results are deliberately not accepted as update targets.
const { randomUUID } = require('node:crypto');
const { compileBrowse } = require('./table-browse.cjs');
const SNAPSHOTS = new WeakMap();
const STATES = new WeakMap();
const MAX_ROWS = 1000;
const {collector,readMysql,readPostgres,readMssql}=require('./result-reader.cjs');
const MAX_CHANGES = 500;
const SNAPSHOT_TTL = 30 * 60 * 1000;
const local = db => db.mode === 'demo' || db.mode === 'sqlite';
const mysql = db => db.mode === 'mysql' || db.mode === 'mariadb';

function quote(name, mode) {
  if (typeof name !== 'string' || !name || name.length > 256 || name.includes('\0')) throw new Error('Choose a valid schema and table.');
  if (mode === 'postgres') return '"' + name.replaceAll('"', '""') + '"';
  if (mode === 'mssql') return '[' + name.replaceAll(']', ']]') + ']';
  return '`' + name.replaceAll('`', '``') + '`';
}
function placeholder(mode, index) { return mode === 'postgres' ? '$' + index : mode === 'mssql' ? '@p' + index : '?'; }
function projection(db, columns) {
  return columns.map(column => {
    const name = quote(column.name, db.mode);
    // Timestamp parsers commonly drop sub-millisecond digits; SQL Server decimal
    // parsing also uses JS numbers. Compare and display exact server text instead.
    if (db.mode === 'postgres' && (['date', 'json'].includes(column.valueType) || !column.valueType)) return 'CAST(' + name + ' AS text) AS ' + name;
    if (mysql(db) && column.valueType === 'json') return 'CAST(' + name + ' AS CHAR) AS ' + name;
    if (db.mode === 'mssql' && /^(?:decimal|numeric|money|smallmoney|bigint)$/i.test(column.type)) return 'CAST(' + name + ' AS varchar(100)) AS ' + name;
    if (db.mode === 'mssql' && column.valueType === 'date') return 'CONVERT(varchar(100), ' + name + ', 127) AS ' + name;
    return name;
  }).join(', ');
}
function safe(value) {
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (Array.isArray(value)) return value.map(safe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, safe(entry)]));
  return value;
}
function canonical(value) {
  if (value === null) return 'null';
  if (value instanceof Date) return 'date:' + value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return 'bytes:' + Buffer.from(value).toString('hex');
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return typeof value + ':' + String(value);
}
function family(type) {
  const value = String(type || '').toLowerCase().replace(/\(.*/, '').replace(/\s+unsigned$/, '').trim();
  if (/^(?:tinyint|smallint|mediumint|integer|int|bigint|int2|int4|int8|serial|bigserial)$/.test(value)) return 'integer';
  if (/^(?:decimal|numeric|real|double|double precision|float|float4|float8|money|smallmoney)$/.test(value)) return 'number';
  if (/^(?:boolean|bool|bit)$/.test(value)) return 'boolean';
  if (/^(?:date|datetime|datetime2|datetimeoffset|smalldatetime|time|time without time zone|time with time zone|timestamp|timestamp without time zone|timestamp with time zone|year)$/.test(value)) return 'date';
  if (/^(?:json|jsonb)$/.test(value)) return 'json';
  if (!value || /(?:char|text|clob|enum|set|uuid|uniqueidentifier|citext|varchar)/.test(value)) return 'text';
  return null;
}

async function execute(db, sql, parameters = [], transaction = null) {
  if (local(db)) {
    const statement = db.connection.prepare(sql);
    statement.setReadBigInts(true);
    if (statement.columns().length) return { rows: statement.all(...parameters), affectedRows: 0 };
    return { rows: [], affectedRows: Number(statement.run(...parameters).changes) };
  }
  if (mysql(db)) {
    const [rows] = await db.connection.query({ sql, timeout: 30000 }, parameters);
    return { rows: Array.isArray(rows) ? rows : [], affectedRows: Number(rows?.affectedRows || 0), status: rows?.serverStatus };
  }
  if (db.mode === 'postgres') {
    const result = await db.connection.query({ text: sql, values: parameters, query_timeout: 30000 });
    return { rows: result.rows || [], affectedRows: Number(result.rowCount || 0) };
  }
  const request = (transaction || db._transaction || db.connection).request();
  parameters.forEach((value, index) => request.input('p' + (index + 1), typeof value === 'bigint' ? String(value) : value));
  const result = await request.query(sql);
  return { rows: result.recordset || [], affectedRows: (result.rowsAffected || []).reduce((sum, value) => sum + Number(value), 0) };
}

async function boundedTableRows(db,sql,parameters=[]){
  if(local(db)){const kept=collector(),statement=db.connection.prepare(sql);statement.setReadBigInts(true);for(const row of statement.iterate(...parameters)){kept.add(row);if(kept.result.truncated)break;}return kept.result;}
  let output;
  if(mysql(db)&&db.connection.connection?.query)output=await readMysql(db.connection,sql,parameters);
  else if(db.mode==='postgres'&&db.connection.connection?.on&&(db._drivers.postgres||require('pg')).Query)output=await readPostgres(db.connection,sql,(db._drivers.postgres||require('pg')).Query,parameters);
  else if(db.mode==='mssql'){const request=db._mssqlRequest();parameters.forEach((value,index)=>request.input('p'+(index+1),value));if(typeof request.on==='function')output=await readMssql(request,sql);}
  if(output)return {...output,rows:output.rows.map(row=>Object.fromEntries(output.fields.map((field,index)=>[field.name,row[index]])))};
  const kept=collector();for(const row of (await execute(db,sql,parameters)).rows)kept.add(row);return kept.result;
}

async function metadata(db, schema, table) {
  let columns, tableInfo;
  if (local(db)) {
    if (schema !== 'main') throw new Error('The SQLite database schema is main.');
    tableInfo = (await execute(db, "SELECT type FROM sqlite_master WHERE name=? AND type IN ('table','view')", [table])).rows[0];
    columns = (await execute(db, 'SELECT name,type,"notnull" AS required,pk,hidden,dflt_value FROM pragma_table_xinfo(?)', [table])).rows.map(row => ({ name: row.name, type: row.type, nullable: !row.required && !row.pk, primaryKey: Boolean(row.pk), generated: Number(row.hidden) !== 0, identity: false, hasDefault: row.dflt_value !== null }));
  } else if (mysql(db)) {
    tableInfo = (await execute(db, 'SELECT TABLE_TYPE AS type, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?', [schema, table])).rows[0];
    columns = (await execute(db, 'SELECT COLUMN_NAME AS name,COLUMN_TYPE AS type,IS_NULLABLE AS nullable,COLUMN_KEY AS pk,EXTRA AS extra,COLUMN_DEFAULT AS default_value FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [schema, table])).rows.map(row => ({ name: row.name, type: row.type, nullable: row.nullable === 'YES', primaryKey: row.pk === 'PRI', generated: /(?:VIRTUAL|STORED) GENERATED/i.test(row.extra || ''), identity: /auto_increment/i.test(row.extra || ''), hasDefault: row.default_value !== null }));
  } else if (db.mode === 'postgres') {
    tableInfo = (await execute(db, 'SELECT table_type AS type FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2', [schema, table])).rows[0];
    columns = (await execute(db, `SELECT c.column_name AS name,c.data_type AS type,c.is_nullable,c.is_generated,c.is_identity,c.column_default,
      EXISTS(SELECT 1 FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage k ON tc.constraint_name=k.constraint_name AND tc.constraint_schema=k.constraint_schema AND tc.table_name=k.table_name WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema=c.table_schema AND tc.table_name=c.table_name AND k.column_name=c.column_name) AS pk
      FROM information_schema.columns c WHERE c.table_schema=$1 AND c.table_name=$2 ORDER BY c.ordinal_position`, [schema, table])).rows.map(row => ({ name: row.name, type: row.type, nullable: row.is_nullable === 'YES', primaryKey: Boolean(row.pk), generated: row.is_generated !== 'NEVER' && row.is_generated !== undefined, identity: row.is_identity === 'YES', hasDefault: row.column_default !== null && row.column_default !== undefined }));
  } else {
    tableInfo = (await execute(db, 'SELECT TABLE_TYPE AS type FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@p1 AND TABLE_NAME=@p2', [schema, table])).rows[0];
    columns = (await execute(db, `SELECT c.name,t.name AS type,c.is_nullable,c.is_computed,c.is_identity,c.default_object_id,
      CASE WHEN EXISTS(SELECT 1 FROM sys.indexes i JOIN sys.index_columns ic ON i.object_id=ic.object_id AND i.index_id=ic.index_id WHERE i.is_primary_key=1 AND i.object_id=c.object_id AND ic.column_id=c.column_id) THEN 1 ELSE 0 END AS pk
      FROM sys.columns c JOIN sys.types t ON c.user_type_id=t.user_type_id JOIN sys.objects o ON c.object_id=o.object_id JOIN sys.schemas s ON o.schema_id=s.schema_id WHERE s.name=@p1 AND o.name=@p2 ORDER BY c.column_id`, [schema, table])).rows.map(row => ({ name: row.name, type: row.type, nullable: Boolean(row.is_nullable), primaryKey: Boolean(row.pk), generated: Boolean(row.is_computed) || /^(timestamp|rowversion)$/i.test(row.type), identity: Boolean(row.is_identity), hasDefault: Boolean(row.default_object_id) }));
  }
  if (!tableInfo || !columns.length) throw new Error('The selected table is unavailable or you do not have permission to read it.');
  const isTable = tableInfo.type === 'table' || tableInfo.type === 'BASE TABLE';
  const transactional = !mysql(db) || String(tableInfo.engine).toUpperCase() === 'INNODB';
  for (const column of columns) {
    column.key = column.name;
    column.valueType = family(column.type);
    column.editable = Boolean(column.valueType) && !column.generated && !column.primaryKey && !column.identity;
    column.insertable = Boolean(column.valueType) && !column.generated && !column.identity;
    // SQLite INTEGER PRIMARY KEY can be omitted to generate a rowid.
    if (local(db) && column.primaryKey && /^integer$/i.test(column.type) && columns.filter(item => item.primaryKey).length === 1) column.hasDefault = true;
  }
  return { columns, isTable, transactional };
}

function currentSnapshot(db, token) {
  db._requireConnection();
  const snapshot = SNAPSHOTS.get(db)?.get(token);
  if (!snapshot || snapshot.connection !== db.connection || snapshot.mode !== db.mode || snapshot.database !== db.database || Date.now() - snapshot.created > SNAPSHOT_TTL) throw new Error('This table preview has expired. Reload the table before applying changes.');
  if (!snapshot.editable) throw new Error(snapshot.readOnlyReason || 'This table is read-only.');
  return snapshot;
}
function checkedValue(value, column) {
  if (value === null) {
    if (!column.nullable) throw new Error(column.name + ' does not allow NULL.');
    return null;
  }
  if (!['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) throw new Error('Enter a valid value for ' + column.name + '.');
  if (String(value).length > 1000000 || String(value).includes('\0')) throw new Error(column.name + ' must be at most 1 MB and cannot contain a zero byte.');
  if (column.valueType === 'integer') {
    if (!/^[+-]?\d+$/.test(String(value))) throw new Error(column.name + ' requires a whole number.');
    return String(value);
  }
  if (column.valueType === 'number') {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(String(value)) || !Number.isFinite(Number(value))) throw new Error(column.name + ' requires a finite number.');
    return String(value);
  }
  if (column.valueType === 'boolean') {
    if (value === true || value === 1 || /^(true|1)$/i.test(String(value))) return true;
    if (value === false || value === 0 || /^(false|0)$/i.test(String(value))) return false;
    throw new Error(column.name + ' requires true or false.');
  }
  if (column.valueType === 'json') {
    try { JSON.parse(String(value)); } catch { throw new Error(column.name + ' requires valid JSON.'); }
  }
  return String(value);
}
function plan(db, snapshot, changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > MAX_CHANGES) throw new Error('Stage between 1 and ' + MAX_CHANGES + ' row changes.');
  const seen = new Set(), statements = [];
  const target = quote(snapshot.schema, db.mode) + '.' + quote(snapshot.table, db.mode);
  for (const change of changes) {
    if (!change || typeof change !== 'object') throw new Error('Invalid table change.');
    const type = change.type || 'update';
    if (!['update', 'delete', 'insert'].includes(type)) throw new Error('Unknown table change type.');
    let original;
    if (type !== 'insert') {
      if (!Number.isInteger(change.rowIndex) || change.rowIndex < 0 || change.rowIndex >= snapshot.rows.length || seen.has(change.rowIndex)) throw new Error('Each existing row can be changed only once per Apply Changes operation.');
      seen.add(change.rowIndex); original = snapshot.rows[change.rowIndex];
    }
    const parameters = [], values = [];
    if (type !== 'delete') {
      if (!change.values || typeof change.values !== 'object' || Array.isArray(change.values)) throw new Error('Choose the cells to change.');
      for (const name of Object.keys(change.values)) {
        const column = snapshot.columns.find(item => item.name === name);
        if (!column || !(type === 'insert' ? column.insertable : column.editable)) throw new Error(name + ' is read-only in the table editor.');
        const value = checkedValue(change.values[name], column);
        parameters.push(local(db) && typeof value === 'boolean' ? Number(value) : value);
        values.push({ name, placeholder: placeholder(db.mode, parameters.length) });
      }
      if (type === 'insert') for (const column of snapshot.columns) {
        if (!Object.hasOwn(change.values, column.name) && !column.nullable && !column.hasDefault && !column.generated && !column.identity) throw new Error('Enter ' + column.name + ' for the new row.');
      }
      if (type === 'update' && !values.length) throw new Error('Choose at least one editable cell.');
    }
    const keyParameters = [];
    const where = type === 'insert' ? null : snapshot.columns.filter(column => column.primaryKey).map(column => {
      const value = original[column.name];
      if (value === null || value === undefined || typeof value === 'object') throw new Error('This row has an unsupported primary key and cannot be edited.');
      parameters.push(value); keyParameters.push(value);
      return quote(column.name, db.mode) + '=' + placeholder(db.mode, parameters.length);
    }).join(' AND ');
    let sql;
    if (type === 'delete') sql = 'DELETE FROM ' + target + ' WHERE ' + where;
    else if (type === 'update') sql = 'UPDATE ' + target + ' SET ' + values.map(value => quote(value.name, db.mode) + '=' + value.placeholder).join(', ') + ' WHERE ' + where;
    else if (values.length) sql = 'INSERT INTO ' + target + ' (' + values.map(value => quote(value.name, db.mode)).join(', ') + ') VALUES (' + values.map(value => value.placeholder).join(', ') + ')';
    else sql = mysql(db) ? 'INSERT INTO ' + target + ' () VALUES ()' : 'INSERT INTO ' + target + ' DEFAULT VALUES';
    statements.push({ type, rowIndex: change.rowIndex, sql, parameters, original, keyParameters });
  }
  return { target, statements };
}
async function assertIdle(db) {
  const state = STATES.get(db);
  if (local(db) ? db.connection.isTransaction : db.mode === 'mssql' ? Boolean(db._transaction) : state?.transaction === true || state?.pgStatus === 'T' || state?.pgStatus === 'E') throw new Error('Commit or roll back the open SQL transaction before applying table changes.');
  if (mysql(db)) {
    const row = (await execute(db, 'SELECT @@autocommit AS enabled')).rows[0];
    if (!Number(row?.enabled)) throw new Error('Enable autocommit and finish the open SQL transaction before applying table changes.');
  }
}

function installTableEditing(DatabaseService) {
  if (DatabaseService.prototype.tableData) return;
  DatabaseService.prototype._assertNoUserTransaction = function() { return assertIdle(this); };
  DatabaseService.prototype.assertNoUserTransaction = function() { return assertIdle(this); };
  DatabaseService.prototype.clearTableSnapshots = function() { SNAPSHOTS.delete(this); };
  const originalConnect = DatabaseService.prototype.connect;
  const originalQuery = DatabaseService.prototype.query;
  DatabaseService.prototype.connect = async function(...args) {
    const result = await originalConnect.apply(this, args);
    const state = { transaction: false, pgStatus: 'I' };
    STATES.set(this, state); SNAPSHOTS.delete(this);
    this._observeServerStatus=status=>{if(typeof status==='number')state.transaction=Boolean(status&1);};
    if (this.mode === 'postgres') this.connection.connection?.on?.('readyForQuery', message => { state.pgStatus = message.status; });
    if (mysql(this)) {
      // MySQL reports SERVER_STATUS_IN_TRANS on OK packets, including CALLs and
      // implicit commits. Preserve that real driver status instead of assuming
      // transaction changes can only come from a literal BEGIN in the editor.
      const connection = this.connection, query = connection.query;
      connection.query = async function(...queryArgs) {
        const result = await query.apply(this, queryArgs);
        const observe = value => {
          if (Array.isArray(value)) { for (const item of value) observe(item); }
          else if (value?.constructor?.name === 'ResultSetHeader' && typeof value.serverStatus === 'number') state.transaction = Boolean(value.serverStatus & 1);
        };
        observe(result[0]);
        return result;
      };
    }
    return result;
  };
  DatabaseService.prototype.query = async function(args) {
    const result = await originalQuery.call(this, args);
    const state = STATES.get(this) || { transaction: false };
    STATES.set(this, state);
    const statements = require('./database.cjs').splitStatements(args.sql, this.mode === 'postgres' ? 'postgres' : this.mode === 'mssql' ? 'mssql' : local(this) ? 'sqlite' : 'mysql');
    const command = statements[0]?.trim() || '';
    if (/^(?:BEGIN|START\s+TRANSACTION|SAVEPOINT)\b/i.test(command)) state.transaction = true;
    else if (/^(?:COMMIT|END|ROLLBACK(?!\s+TO\b))\b/i.test(command)) state.transaction = /\bAND\s+CHAIN\b/i.test(command) && !/\bNO\s+CHAIN\b/i.test(command);
    return result;
  };
  DatabaseService.prototype.tableData = function({ schema, table, limit = MAX_ROWS, offset = 0, browse } = {}) {
    return this._exclusive(async () => {
      this._requireConnection();
      schema ||= this.schema || this.database || (local(this) ? 'main' : null);
      quote(schema, this.mode); quote(table, this.mode);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS) throw new Error('Table preview limit must be between 1 and 1000.');
      if(!Number.isInteger(offset)||offset<0||offset>1000000000)throw new Error('Table offset must be a nonnegative integer up to 1,000,000,000.');
      const meta = await metadata(this, schema, table);
      const target = quote(schema, this.mode) + '.' + quote(table, this.mode);
      const keys = meta.columns.filter(column => column.primaryKey);
      const criteria = compileBrowse(browse, meta.columns, this.mode, quote, placeholder);
      const order = criteria.order;
      const selected = projection(this, meta.columns);
      const sql = this.mode === 'mssql' ? 'SELECT ' + selected + ' FROM ' + target + criteria.where + (order||' ORDER BY (SELECT NULL)') + ' OFFSET '+offset+' ROWS FETCH NEXT '+(limit+1)+' ROWS ONLY' : 'SELECT ' + selected + ' FROM ' + target + criteria.where + order + ' LIMIT ' + (limit + 1)+' OFFSET '+offset;
      const bounded=await boundedTableRows(this,sql,criteria.parameters);const raw=bounded.rows;
      const rows = raw.slice(0, limit);
      // Objects (JSON, binary, driver-specific types) can be previewed but never used as a key.
      const usableKeys = keys.length && keys.every(column => column.valueType) && rows.every(row => keys.every(column => row[column.name] !== null && row[column.name] !== undefined && typeof row[column.name] !== 'object'));
      const editable = Boolean(meta.isTable && meta.transactional && usableKeys);
      const readOnlyReason = !meta.isTable ? 'Views are read-only. Open the underlying table to edit rows.' : !meta.transactional ? 'Grid changes require an InnoDB table for atomic Apply Changes.' : !keys.length ? 'This table has no primary key. Add a primary key to edit rows safely.' : !usableKeys ? 'This table uses an unsupported or nullable primary key. Use SQL to make changes.' : null;
      const token = randomUUID();
      const snapshots = SNAPSHOTS.get(this) || new Map();
      for (const [key, snapshot] of snapshots) if (Date.now() - snapshot.created > SNAPSHOT_TTL || snapshot.connection !== this.connection) snapshots.delete(key);
      while (snapshots.size >= 8) snapshots.delete(snapshots.keys().next().value);
      snapshots.set(token, { connection: this.connection, mode: this.mode, database: this.database, schema, table, columns: meta.columns, rows, editable, readOnlyReason, created: Date.now() });
      SNAPSHOTS.set(this, snapshots);
      const canInsert = editable && meta.columns.every(column => column.insertable || column.nullable || column.generated || column.identity || column.hasDefault);
      return { columns: meta.columns, rows: rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, safe(value)]))), rowCount: rows.length, truncated: raw.length > limit||bounded.truncated, hasMore:raw.length>limit||bounded.truncated, offset, limit, browse:criteria.browse, resultBytes:bounded.resultBytes, limitReason:bounded.limitReason, mode: this.mode, database: this.database, schema, table, token, editable, readOnlyReason, canInsert, canDelete: editable, elapsedMs: 0 };
    });
  };
  DatabaseService.prototype.previewChanges = function({ token, changes } = {}) {
    return this._exclusive(async () => {
      const snapshot = currentSnapshot(this, token);
      const result = plan(this, snapshot, changes);
      return { statements: result.statements.map(({ type, rowIndex, sql, parameters }) => ({ type, rowIndex, sql, parameters: parameters.map(safe) })), changeCount: result.statements.length, table: snapshot.table, schema: snapshot.schema };
    });
  };
  DatabaseService.prototype.applyChanges = function({ token, changes } = {}) {
    return this._exclusive(async () => {
      const snapshot = currentSnapshot(this, token);
      const result = plan(this, snapshot, changes);
      await assertIdle(this);
      let transaction = null, begun = false;
      try {
        if (this.mode === 'mssql') {
          const driver = this._drivers.mssql || require('mssql');
          transaction = new driver.Transaction(this.connection); await transaction.begin();
        } else await execute(this, local(this) ? 'BEGIN IMMEDIATE' : 'BEGIN');
        begun = true;
        // Lock and compare all old values before writing anything. Only the server-held
        // originals are authoritative, including columns that are read-only in the UI.
        for (const statement of result.statements) {
          if (statement.type === 'insert') continue;
          const where = snapshot.columns.filter(column => column.primaryKey).map((column, index) => quote(column.name, this.mode) + '=' + placeholder(this.mode, index + 1)).join(' AND ');
          const hints = this.mode === 'mssql' ? ' WITH (UPDLOCK, HOLDLOCK)' : '';
          const lock = !local(this) && this.mode !== 'mssql' ? ' FOR UPDATE' : '';
          const current = (await execute(this, 'SELECT ' + projection(this, snapshot.columns) + ' FROM ' + result.target + hints + ' WHERE ' + where + lock, statement.keyParameters, transaction)).rows;
          if (current.length !== 1 || canonical(current[0]) !== canonical(statement.original)) throw new Error('Row ' + (statement.rowIndex + 1) + ' changed in the database after it was loaded. Nothing was applied. Reload the table and try again.');
        }
        for (const statement of result.statements) {
          const outcome = await execute(this, statement.sql, statement.parameters, transaction);
          if (outcome.affectedRows !== 1) throw new Error('The database did not change exactly one row. All staged changes were rolled back. Reload the table.');
        }
        if (transaction) await transaction.commit(); else await execute(this, 'COMMIT');
        begun = false; SNAPSHOTS.get(this)?.delete(token);
        return { applied: result.statements.length, table: snapshot.table, schema: snapshot.schema };
      } catch (error) {
        if (begun) { try { if (transaction) await transaction.rollback(); else await execute(this, 'ROLLBACK'); } catch {} }
        throw error;
      }
    });
  };
}

module.exports = { installTableEditing };
