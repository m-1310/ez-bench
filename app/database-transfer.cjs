'use strict';
const {childEnvironment}=require('./child-env.cjs');

// Native database tools perform logical backups; SQLite uses its online backup API.
// Passwords stay in the child environment, never in command arguments or saved profiles.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const LOCAL = new Set(['demo', 'sqlite']);
const MYSQL = new Set(['mysql', 'mariadb']);
const TIMEOUT = 15 * 60 * 1000;
const FORMAT = { mysql: 'sql', mariadb: 'sql', postgres: 'pg-custom', sqlite: 'sqlite', demo: 'sqlite' };

function absoluteFile(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error(`Choose an absolute ${label} path.`);
  return path.resolve(value);
}
function redact(service, message) { return service._password ? String(message).split(service._password).join('[redacted]') : String(message); }
function samePath(a, b) { return process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b); }
function requireMode(service) {
  service._requireConnection();
  if (!Object.hasOwn(FORMAT, service.mode)) throw new Error('SQL Server backup/restore uses server-side .bak files and is not available in this local-file workflow. Use your server backup tools.');
  if (!LOCAL.has(service.mode) && !service.database) throw new Error('Select a database before importing or exporting.');
  if (LOCAL.has(service.mode) && service.connection.isTransaction) throw new Error('Commit or roll back the current transaction before transferring the database.');
  if (MYSQL.has(service.mode) && service._tunnel && service.connectionInfo.tls) throw new Error('This MySQL client cannot preserve database TLS hostname verification through a loopback SSH tunnel for backup/restore. Interactive SSH queries remain available. Use a direct verified TLS connection or run the vendor backup on the server; certificate checks are not disabled.');
}
async function hashHandle(handle) {
  const hash = crypto.createHash('sha256');
  for await (const block of fs.createReadStream('', { fd: handle.fd, autoClose: false, start: 0 })) hash.update(block);
  return hash.digest('hex');
}
function candidates(mode, role) {
  const names = mode === 'postgres' ? [role === 'dump' ? 'pg_dump' : 'pg_restore'] : mode === 'mariadb' ? [role === 'dump' ? 'mariadb-dump' : 'mariadb', role === 'dump' ? 'mysqldump' : 'mysql'] : [role === 'dump' ? 'mysqldump' : 'mysql'];
  const executableNames = names.map(name => name + (process.platform === 'win32' ? '.exe' : ''));
  const directories = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  // Official client-only redistributions keep portable backup/restore usable
  // without installing a local database server. Prefer matching installed tools.
  const bundled = mode === 'postgres' ? 'postgres' : mode === 'mysql' ? 'mysql' : null;
  if (process.platform === 'win32') {
    for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
      for (const parent of [path.join(root, 'MySQL'), path.join(root, 'MariaDB'), path.join(root, 'PostgreSQL')]) {
        try { for (const entry of fs.readdirSync(parent, { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a,b) => b.name.localeCompare(a.name, undefined, { numeric: true }))) directories.push(path.join(parent, entry.name, 'bin')); } catch {}
      }
      try { for (const entry of fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^MariaDB\s/i.test(entry.name))) directories.push(path.join(root, entry.name, 'bin')); } catch {}
    }
  }
  if (bundled) directories.push(path.join(__dirname, 'vendor', 'database-tools', bundled, 'bin'));
  return executableNames.flatMap(name => directories.map(directory => path.join(directory, name)));
}
function findTool(mode, role, tools = {}) {
  if (tools[role]) {
    const selected = absoluteFile(tools[role], `${role} executable`);
    if (!fs.existsSync(selected) || !fs.statSync(selected).isFile()) throw new Error(`The selected ${role} executable does not exist.`);
    if (process.platform === 'win32' && path.extname(selected).toLowerCase() !== '.exe') throw new Error('Choose the native .exe tool, not a script or command file.');
    return selected;
  }
  return candidates(mode, role).find(candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } }) || null;
}

async function runTool(service, executable, args, { env = childEnvironment(), inputHandle, outputFd, capture = false, timeout = TIMEOUT } = {}) {
  if (service._transferProcess) throw new Error('Another database transfer is running.');
  return new Promise((resolve, reject) => {
    let child, stdout = '', stderr = '', failure, completed = false;
    const fail = error => { failure ||= error; child?.kill(); };
    try { child = spawn(executable, args, { shell: false, windowsHide: true, env, stdio: [inputHandle ? inputHandle.fd : 'ignore', outputFd ?? 'pipe', 'pipe'] }); }
    catch (error) { reject(new Error(redact(service, error.message))); return; }
    service._transferProcess = child;
    const kill = () => child.kill();
    process.once('exit', kill);
    process.once('disconnect', kill);
    const timer = setTimeout(() => fail(new Error('Database transfer exceeded 15 minutes. Check server state before retrying an import.')), timeout);
    child.on('error', error => { failure = new Error(`Could not start the database tool: ${error.message}`); });
    child.stdout?.on('data', data => { if (capture && stdout.length < 128 * 1024) stdout += data.toString(); });
    child.stderr?.on('data', data => { if (stderr.length < 128 * 1024) stderr += data.toString(); });
    child.on('close', code => {
      if (completed) return;
      completed = true; clearTimeout(timer); process.removeListener('exit', kill); process.removeListener('disconnect', kill);
      if (service._transferProcess === child) service._transferProcess = null;
      if (service._transferCancelled) { service._transferCancelled = false; failure = new Error('Database transfer cancelled. An interrupted MySQL import may have partially applied changes.'); }
      if (failure || code !== 0) reject(new Error(redact(service, failure?.message || `Database tool failed (exit ${code}): ${stderr.trim() || 'No diagnostic output.'}`).slice(0, 4000)));
      else resolve({ stdout, warnings: redact(service, stderr.trim()).slice(0, 4000) });
    });
  });
}
async function toolDescription(service, role, tools) {
  const executable = findTool(service.mode, role, tools);
  if (!executable) return { path: null, available: false, version: null };
  const version = await runTool(service, executable, ['--version'], { capture: true, timeout: 10000 });
  const text = version.stdout.trim();
  if (service.mode === 'postgres' ? !/PostgreSQL/i.test(text) : !/mysql|maria/i.test(text)) throw new Error('The selected tool does not match this database engine.');
  return { path: executable, available: true, version: text.slice(0, 500), maria: /MariaDB/i.test(text) };
}
function networkOptions(service, maria) {
  const info = service.connectionInfo;
  const localPort = service._tunnel?.port || info.port;
  if (service.mode === 'postgres') return {
    args: ['--host=' + info.host, '--port=' + localPort, '--username=' + info.user, "--dbname=dbname='" + service.database.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'", '--no-password'],
    // libpq's hostaddr controls routing while host still identifies the TLS
    // certificate. The database hostname is resolved by the SSH endpoint.
    env: { ...childEnvironment(), PGPASSWORD: service._password || '', PGSSLMODE: info.tls ? 'verify-full' : 'disable', PGCONNECT_TIMEOUT: '10', PGHOSTADDR: service._tunnel?.host || '' },
  };
  return {
    args: ['--no-defaults', '--protocol=TCP', '--host=' + (service._tunnel?.host || info.host), '--port=' + localPort, '--user=' + info.user, '--default-character-set=utf8mb4', ...(maria ? info.tls ? ['--ssl', '--ssl-verify-server-cert'] : ['--skip-ssl'] : ['--ssl-mode=' + (info.tls ? 'VERIFY_IDENTITY' : 'DISABLED')])],
    env: { ...childEnvironment(), MYSQL_PWD: service._password || '', MYSQL_TEST_LOGIN_FILE: path.join(service.dataDir, '.unused-login-path-' + crypto.randomUUID()) },
  };
}
async function assertNoTransaction(service) {
  if (service.assertNoUserTransaction) return service.assertNoUserTransaction();
  if (service._userTransactionOpen || service._transaction) throw new Error('Commit or roll back the current transaction before transferring the database.');
}
function transferDetails(service) {
  return {
    mode: service.mode, database: service.database, format: FORMAT[service.mode],
    scope: LOCAL.has(service.mode) ? 'Complete SQLite file, including schema, data, indexes, views and triggers.' : MYSQL.has(service.mode) ? 'Selected database: schema, all table rows, views, triggers, routines and events. Server users and grants are not included. Consistent for transactional tables; avoid schema changes while exporting.' : 'Selected database: schemas, data, sequences, indexes, views, functions and large objects. Cluster roles and tablespaces are not included. Restore assigns ownership to the connected user and omits grants.',
    warning: LOCAL.has(service.mode) ? 'Import creates a new database file; the open file stays unchanged.' : MYSQL.has(service.mode) ? 'Import executes SQL with the connected user’s privileges. Only import trusted files. Existing objects may be replaced and MySQL DDL cannot be rolled back; failures can leave a partial restore. A SQL file may select another database. Back up first.' : 'Import restores a trusted pg_dump custom archive into the selected database in one transaction. Existing archive objects are replaced; unrelated objects remain. Restored code can execute with the connected user’s privileges. Back up first.',
    confirmation: LOCAL.has(service.mode) ? 'RESTORE' : service.database,
  };
}
async function publish(temp, target, overwrite) {
  if (overwrite) await fsp.rename(temp, target);
  else { await fsp.link(temp, target); await fsp.unlink(temp); }
}

function installDatabaseTransfer(DatabaseService) {
  if (DatabaseService.prototype.exportDatabase) return;
  DatabaseService.prototype.cancelTransfer = async function () {
    if (this._transferProcess) { this._transferCancelled = true; this._transferProcess.kill(); return { cancelled: true }; }
    return { cancelled: false };
  };
  DatabaseService.prototype.transferInfo = function ({ tools = {} } = {}) {
    return this._exclusive(async () => {
      requireMode(this);
      if (LOCAL.has(this.mode)) return { ...transferDetails(this), tools: {}, ready: true };
      const dump = await toolDescription(this, 'dump', tools), restore = await toolDescription(this, 'restore', tools);
      return { ...transferDetails(this), tools: { dump, restore }, ready: dump.available && restore.available };
    });
  };
  DatabaseService.prototype.exportDatabase = function ({ filePath, tools = {}, overwrite = false, expectedDatabase } = {}) {
    return this._exclusive(async () => {
      requireMode(this); await assertNoTransaction(this);
      if (expectedDatabase !== undefined && expectedDatabase !== this.database) throw new Error('The active database changed. Reopen Backup to review the target.');
      const target = absoluteFile(filePath, 'backup file');
      if (this.connectionInfo.filePath && samePath(target, this.connectionInfo.filePath)) throw new Error('Choose a backup path different from the open database.');
      if (fs.existsSync(target) && (!overwrite || !fs.statSync(target).isFile())) throw new Error('The backup destination already exists. Choose another name or explicitly confirm replacement.');
      const temp = path.join(path.dirname(target), '.' + path.basename(target) + '.' + crypto.randomUUID() + '.partial');
      let output;
      try {
        let warnings = '';
        if (LOCAL.has(this.mode)) {
          const { backup } = require('node:sqlite');
          await backup(this.connection, temp, { rate: 100 });
        } else {
          const tool = await toolDescription(this, 'dump', tools);
          if (!tool.available) throw new Error('Backup tool not found. Select mysqldump/mariadb-dump or pg_dump in Database Transfer.');
          const network = networkOptions(this, tool.maria);
          const args = this.mode === 'postgres' ? [...network.args, '--format=custom'] : [...network.args, '--single-transaction', '--quick', '--routines', '--events', '--triggers', '--hex-blob', '--no-tablespaces', ...(tool.maria ? [] : ['--set-gtid-purged=OFF', '--column-statistics=0']), '--', this.database];
          output = await fsp.open(temp, 'wx', 0o600);
          ({ warnings } = await runTool(this, tool.path, args, { env: network.env, outputFd: output.fd }));
          await output.sync(); await output.close(); output = null;
        }
        if (!(await fsp.stat(temp)).size) throw new Error('The database tool produced an empty backup.');
        await publish(temp, target, overwrite === true);
        return { filePath: target, bytes: (await fsp.stat(target)).size, format: FORMAT[this.mode], warnings, ...transferDetails(this) };
      } finally { if (output) await output.close(); await fsp.rm(temp, { force: true }).catch(() => {}); }
    });
  };
  DatabaseService.prototype.inspectImport = function ({ filePath, tools = {} } = {}) {
    return this._exclusive(async () => {
      requireMode(this);
      const source = absoluteFile(filePath, 'backup file');
      if (LOCAL.has(this.mode) && ['-wal', '-journal'].some(suffix => { try { return fs.statSync(source + suffix).size > 0; } catch { return false; } })) throw new Error('This SQLite file has an active WAL or journal. Open it and export a database backup first, then select that standalone backup.');
      const handle = await fsp.open(source, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || !stat.size) throw new Error('Choose a nonempty database backup file.');
        const header = Buffer.alloc(16); await handle.read(header, 0, 16, 0);
        if (LOCAL.has(this.mode) && header.toString('ascii') !== 'SQLite format 3\0') throw new Error('Choose a SQLite database backup (.db or .sqlite).');
        if (this.mode === 'postgres' && header.subarray(0, 5).toString() !== 'PGDMP') throw new Error('Choose a PostgreSQL custom archive created by pg_dump (.dump). Plain SQL files can be opened in the SQL editor.');
        if (MYSQL.has(this.mode) && (header.subarray(0, 5).toString() === 'PGDMP' || header.toString('ascii') === 'SQLite format 3\0' || header.includes(0))) throw new Error('Choose a MySQL/MariaDB SQL dump (.sql), not a binary database file.');
        let tool;
        if (!LOCAL.has(this.mode)) { tool = await toolDescription(this, 'restore', tools); if (!tool.available) throw new Error('Restore tool not found. Select mysql/mariadb or pg_restore in Database Transfer.'); }
        const hash = await hashHandle(handle);
        const token = crypto.randomUUID();
        this._importReviews ||= new Map();
        if (this._importReviews.size >= 10) this._importReviews.delete(this._importReviews.keys().next().value);
        const details = { ...transferDetails(this), filePath: source, bytes: stat.size, sha256: hash, token };
        this._importReviews.set(token, { source, hash, connection: this.connection, database: this.database, mode: this.mode, created: Date.now(), tool });
        return details;
      } finally { await handle.close(); }
    });
  };
  DatabaseService.prototype.importDatabase = function ({ token, confirmation, destinationPath } = {}) {
    return this._exclusive(async () => {
      requireMode(this); await assertNoTransaction(this);
      const review = this._importReviews?.get(token);
      if (!review || review.connection !== this.connection || review.database !== this.database || review.mode !== this.mode || Date.now() - review.created > 10 * 60 * 1000) throw new Error('This import preview expired or the connection changed. Select the backup again.');
      if (confirmation !== transferDetails(this).confirmation) throw new Error('Enter the exact confirmation text shown in the import preview.');
      const handle = await fsp.open(review.source, 'r');
      try {
        if (await hashHandle(handle) !== review.hash) throw new Error('The backup file changed after preview. Select it again.');
        this._importReviews.delete(token);
        let warnings = '';
        if (LOCAL.has(this.mode)) {
          const target = absoluteFile(destinationPath, 'new database');
          if (samePath(target, review.source) || samePath(target, this.connectionInfo.filePath)) throw new Error('Choose a new destination file different from the backup and open database.');
          if (fs.existsSync(target)) throw new Error('The restore destination already exists. Choose a new file; existing databases are never overwritten.');
          const { DatabaseSync, backup } = require('node:sqlite');
          const temp = path.join(path.dirname(target), '.' + path.basename(target) + '.' + crypto.randomUUID() + '.partial');
          const snapshot = path.join(this.dataDir, '.restore-source-' + crypto.randomUUID() + '.db');
          let source;
          try {
            const { pipeline } = require('node:stream/promises');
            await pipeline(fs.createReadStream('', { fd: handle.fd, autoClose: false, start: 0 }), fs.createWriteStream(snapshot, { flags: 'wx', mode: 0o600 }));
            const copied = await fsp.open(snapshot, 'r');
            try { if (await hashHandle(copied) !== review.hash) throw new Error('The backup file changed after preview. Select it again.'); } finally { await copied.close(); }
            source = new DatabaseSync(snapshot, { readOnly: true });
            const integrity = source.prepare('PRAGMA quick_check').all();
            if (integrity.some(row => Object.values(row)[0] !== 'ok')) throw new Error('SQLite integrity check failed. The backup was not restored.');
            await backup(source, temp, { rate: 100 });
            await publish(temp, target, false);
          } finally { source?.close(); await fsp.rm(temp, { force: true }).catch(() => {}); await fsp.rm(snapshot, { force: true }).catch(() => {}); }
          return { restored: true, filePath: target, bytes: (await fsp.stat(target)).size, format: 'sqlite', connected: false, message: 'Database restored to a new file. Open that file to work with it; the current database is unchanged.' };
        }
        const tool = review.tool, network = networkOptions(this, tool.maria);
        const args = this.mode === 'postgres' ? [...network.args, '--single-transaction', '--exit-on-error', '--clean', '--if-exists', '--no-owner', '--no-acl', '--no-tablespaces'] : [...network.args, '--binary-mode=1', '--database=' + this.database];
        try { ({ warnings } = await runTool(this, tool.path, args, { env: network.env, inputHandle: handle })); }
        catch (error) { if (MYSQL.has(this.mode)) throw new Error(error.message + '\nImport stopped; earlier SQL statements may already be committed. Inspect the database before retrying.'); throw error; }
        finally { this.clearTableSnapshots?.(); }
        return { restored: true, database: this.database, format: FORMAT[this.mode], warnings, message: 'Database import completed. Refresh the schema browser to inspect restored objects.' };
      } finally { await handle.close(); }
    });
  };
}

module.exports = { installDatabaseTransfer, findTool };
