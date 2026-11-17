const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { HistoryStore }=require('./history-store.cjs');
const { DatabaseClient } = require('./database-client.cjs');
const { ProfileStore } = require('./profiles.cjs');
const { splitStatements } = require('./database.cjs');
const { installMenu } = require('./menu.cjs');
const { UpdateService } = require('./update-service.cjs');
const { SnippetStore } = require('./snippet-store.cjs');
const { childEnvironment } = require('./child-env.cjs');
app.setName('EZ Bench');
// Keep the existing storage location across the product rename.
app.setPath('userData', path.join(app.getPath('appData'), 'Work EZ Bench'));

const profileArg = process.argv.find(arg => arg.startsWith('--data-dir='));
if (profileArg) app.setPath('userData', path.resolve(profileArg.slice('--data-dir='.length)));
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();
let window;
let db;
let profiles;
let currentProfile = null;
let connectionEpoch = 0;
let historyStore;
let updates;
let snippets;
const MAX_WORKSPACE_BYTES = 16 * 1024 * 1024;
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });


function isMainFrame(event) {
  return window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
}

function handle(name, fn) {
  ipcMain.handle(name, async (event, arg) => {
    if (!isMainFrame(event)) {
      throw new Error('Unrecognized application window.');
    }
    try { return { ok: true, value: await fn(arg) }; }
    catch (error) { return { ok: false, error: String(error.message || 'Operation failed') }; }
  });
}

app.whenReady().then(() => {
  if (!isPrimaryInstance) return;
  const dataDir = app.getPath('userData');
  fs.mkdirSync(dataDir, { recursive: true });
  const workspacePath = path.join(dataDir, 'workspace.json');
  let workspace = null;
  let workspaceContents;
  let workspaceUnreadable = false;
  let closeRequested = false;
  let closeApproved = false;
  try {
    if (fs.statSync(workspacePath).size > MAX_WORKSPACE_BYTES) throw new Error('Workspace exceeds recovery limit.');
    workspaceContents = fs.readFileSync(workspacePath, 'utf8');
    workspace = JSON.parse(workspaceContents);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      workspaceUnreadable = true;
      console.warn('EZ Bench could not read workspace recovery.');
    }
  }
  ipcMain.on('workspace:load', event => { event.returnValue = isMainFrame(event) ? workspace : null; });
  handle('workspace:save', state => {
    if (workspaceUnreadable) return false;
    try {
      const contents = JSON.stringify(state);
      if (Buffer.byteLength(contents) > MAX_WORKSPACE_BYTES) throw new Error('Workspace exceeds recovery limit.');
      if (contents !== workspaceContents) {
        const temporary = workspacePath + '.tmp';
        fs.writeFileSync(temporary, contents, 'utf8');
        fs.renameSync(temporary, workspacePath);
        workspaceContents = contents;
        workspace = state;
      }
      return true;
    } catch {
      return false;
    }
  });
  handle('workspace:warn', warnings => dialog.showMessageBox(window, {
    type: 'warning', title: 'Unsaved work', message: 'You have unsaved work.', detail: warnings.join('\n\n'), buttons: ['Keep working'],
  }));
  handle('workspace:finish-close', async warnings => {
    if (!closeRequested || closeApproved) return;
    try {
      if (warnings.length) {
        const choice = await dialog.showMessageBox(window, { type: 'warning', title: 'Unsaved work', message: 'You have unsaved work.',
          detail: warnings.join('\n\n'), buttons: ['Keep working', 'Close anyway'], defaultId: 0, cancelId: 0 });
        if (choice.response !== 1) return;
      }
      closeApproved = true;
      window.close();
    } finally { closeRequested = false; }
  });
  db = new DatabaseClient({ dataDir });
  profiles = new ProfileStore(dataDir);
  historyStore=new HistoryStore(dataDir);
  snippets = new SnippetStore(dataDir);
  handle('snippets:list', () => snippets.list());
  handle('snippets:save', value => snippets.save(value));
  handle('snippets:remove', async id => {
    const entry = snippets.list().entries.find(entry => entry.id === id);
    if (!entry) throw new Error('This snippet no longer exists.');
    const choice = await dialog.showMessageBox(window, { type: 'question', title: 'Delete SQL snippet', message: 'Delete “' + entry.title + '”?', detail: 'This removes only the saved snippet. Open SQL tabs and database data are kept.', buttons: ['Keep snippet', 'Delete snippet'], defaultId: 0, cancelId: 0 });
    return choice.response === 1 ? snippets.remove(id) : false;
  });
  updates = new UpdateService({ config: require('./update-config.json'), currentVersion: app.getVersion(), cacheDir: app.getPath('temp') });
  handle('updates:status', () => {
    const state = updates.status();
    if (app.isPackaged) return state;
    return { ...state, phase: 'source', message: 'To update from Git, save your work, close EZ Bench, and follow the Git update instructions.' };
  });
  handle('updates:open-git-guide', () => shell.openExternal('https://github.com/m-1310/ez-bench#update-a-git-installation'));
  handle('updates:check', () => updates.check());
  handle('updates:download', () => updates.download());
  handle('updates:cancel', () => { updates.cancel(); return true; });
  handle('updates:reveal', async () => { shell.showItemInFolder(await updates.installerPath()); return true; });
  handle('updates:install', async () => {
    if (currentProfile || db.pending.size) throw new Error('Finish transactions and disconnect from the database before installing.');
    if (!app.isPackaged) throw new Error('Install updates from a packaged EZ Bench build.');
    const choice = await dialog.showMessageBox(window, { type: 'question', title: 'Install EZ Bench update', message: 'Close EZ Bench and open the verified Windows installer?', detail: 'Save SQL files first. Private SQL buffers are not recovered. Existing per-user installations update in place; portable copies install separately. Profiles, history and database files are preserved. Windows may block an unsigned installer.', buttons: ['Keep working', 'Close and install'], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return false;
    // Check again after the modal confirmation; no renderer path or URL is accepted.
    if (currentProfile || db.pending.size) throw new Error('Disconnect from the database before installing.');
    const filename = await updates.installerPath();
    const child = require('node:child_process').spawn(filename, ['/UPDATEPID=' + process.pid], { detached: true, windowsHide: false, stdio: 'ignore', env: childEnvironment() });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new Error('Windows could not open the installer. Your app remains open; check Windows application policy.'))); });
    child.unref(); updates.preserveInstaller = true;
    app.quit();
    return true;
  });

  handle('profiles:list', () => profiles.list());
  handle('profiles:save', profile => profiles.save(profile));
  handle('profiles:remove', id => profiles.remove(id));
  handle('db:connect', async options => {
    connectionEpoch++;
    const result = await db.connect(options);
    currentProfile = { id: options.id || options.mode, name: options.name || (options.mode === 'demo' ? 'Local playground' : 'Database connection'), mode: options.mode };
    return { ...result, profile: currentProfile };
  });
  handle('db:disconnect', async () => { connectionEpoch++; await db.disconnect(); currentProfile = null; });
  handle('db:schemas', () => db.schemas());
  handle('db:columns', args => db.columns(args));
  handle('db:tableData', args => db.tableData(args));
  handle('db:previewChanges', args => db.previewChanges(args));
  handle('db:applyChanges', args => db.applyChanges(args));
  handle('db:transferInfo', args => db.transferInfo(args));
  // Paths originate in native pickers; transfer operations use short-lived tickets.
  const transferTickets = new Map();
  handle('transfer:pick', async ({ kind, mode } = {}) => {
    if (!currentProfile) throw new Error('Connect to a database before selecting a backup.');
    mode = currentProfile.mode;
    const sqlite = ['sqlite', 'demo'].includes(mode);
    const extension = sqlite ? 'db' : mode === 'postgres' ? 'dump' : 'sql';
    const filters = [{ name: sqlite ? 'SQLite database' : mode === 'postgres' ? 'PostgreSQL archive' : 'SQL database dump', extensions: [extension, ...(sqlite ? ['sqlite', 'sqlite3'] : [])] }];
    let filePath;
    if (kind === 'import') {
      const choice = await dialog.showOpenDialog(window, { title: 'Select database backup to restore', filters, properties: ['openFile'] });
      if (choice.canceled) return null;
      filePath = choice.filePaths[0];
    } else if (kind === 'export' || kind === 'destination') {
      const choice = await dialog.showSaveDialog(window, { title: kind === 'destination' ? 'Restore into a new SQLite database file' : 'Export database backup', defaultPath: kind === 'destination' ? 'restored-workspace.db' : 'database-backup.' + extension, filters });
      if (choice.canceled) return null;
      filePath = choice.filePath;
      if (fs.existsSync(filePath)) throw new Error('Choose a new file name. Existing database and backup files are preserved.');
    } else throw new Error('Choose an import, export, or destination file.');
    const ticket = randomUUID();
    if (transferTickets.size > 20) transferTickets.delete(transferTickets.keys().next().value);
    transferTickets.set(ticket, { filePath, kind, profileId: currentProfile?.id, epoch: connectionEpoch, expires: Date.now() + 15 * 60000 });
    return { ticket, filePath, name: path.basename(filePath) };
  });
  function transferPath(ticket, kind) {
    const entry = transferTickets.get(ticket);
    if (!entry || entry.kind !== kind || entry.expires < Date.now() || entry.profileId !== currentProfile?.id || entry.epoch !== connectionEpoch) throw new Error('This file selection expired. Choose the file again.');
    return entry.filePath;
  }
  handle('transfer:inspect', args => db.inspectImport({ filePath: transferPath(args.ticket, 'import'), tools: args.tools }));
  handle('transfer:export', async args => {
    const value = await db.exportDatabase({ filePath: transferPath(args.ticket, 'export'), tools: args.tools, expectedDatabase: args.database });
    transferTickets.delete(args.ticket);
    return value;
  });
  handle('transfer:import', async args => {
    const destinationPath = args.destinationTicket ? transferPath(args.destinationTicket, 'destination') : undefined;
    const value = await db.importDatabase({ token: args.token, confirmation: args.confirmation, destinationPath });
    transferTickets.clear();
    return value;
  });
  handle('db:info', () => db.info());
  handle('db:testConnection', async options => {
    const client = new DatabaseClient({ dataDir });
    try { const connection = await client.connect(options); const info = await client.info(); return { ...connection, info }; }
    finally { await client.close(); }
  });
  handle('ssh:fingerprint', async options => {
    const client = new DatabaseClient({ dataDir });
    try { return await client.sshFingerprint(options); }
    finally { await client.close(); }
  });
  handle('ssh:pickKey', async () => {
    const choice = await dialog.showOpenDialog(window, { title: 'Choose SSH private key', filters: [{ name: 'SSH private key', extensions: ['pem', 'key'] }, { name: 'All files', extensions: ['*'] }], properties: ['openFile'] });
    return choice.canceled ? null : choice.filePaths[0];
  });
  handle('db:cancel', async () => { connectionEpoch++; await db.cancel(); currentProfile = null; return { cancelled: true }; });
  handle('sql:format', ({ sql, dialect }) => {
    if (typeof sql !== 'string' || sql.length > 1000000) throw new Error('Enter SQL text to format.');
    const language = ({ mysql: 'mysql', mariadb: 'mariadb', postgres: 'postgresql', mssql: 'transactsql' })[dialect] || 'sqlite';
    return require('sql-formatter').format(sql, { language, keywordCase: 'upper', tabWidth: 2 });
  });
  const executeQuery = async args => {
    if (!args || typeof args.sql !== 'string' || !args.sql.trim()) throw new Error('Enter a SQL statement first.');
    if (args.sql.length > 1000000) throw new Error('This editor supports up to 1 MB of SQL at a time.');
    let result;
    let error;
    const executionProfile = currentProfile;
    try { result = await db.query(args); return result; }
    catch (failure) { error = failure.message; throw failure; }
    finally {
      try { historyStore.record({ profileId: executionProfile?.id, connection: executionProfile?.name, schema:args.schema, sql: args.sql, timestamp: new Date().toISOString(), status: error ? 'error' : 'success', error, private:args.private===true, rowCount: result?.rowCount || 0, affectedRows:result?.affectedRows||0, elapsedMs: result?.elapsedMs || 0 }); } catch { /* A history write must not hide a successful SQL result. */ }
    }
  };
  handle('db:query', executeQuery);
  handle('db:script', async ({ sql, schema, stopOnError = true, private: privateQuery = false }) => {
    if (!currentProfile) throw new Error('Connect to a database first.');
    if (typeof sql !== 'string' || !sql.trim() || sql.length > 1000000) throw new Error('Enter a SQL script up to 1 MB.');
    const dialect = ['demo','sqlite'].includes(currentProfile.mode) ? 'sqlite' : currentProfile.mode === 'mariadb' ? 'mysql' : currentProfile.mode;
    const statements = splitStatements(sql, dialect);
    if (!statements.length) throw new Error('The script contains no SQL statements.');
    if(statements.length>100)throw new Error('Run at most 100 statements per script. Split larger scripts into separate files or use the native restore tools.');
    const results = [], errors = [];let cachedBytes=0;
    for (const [index, statement] of statements.entries()) {
      try { const result = await executeQuery({ sql: statement, schema, private:privateQuery }); const entry={ ...result, statementIndex:index+1, sql:statement };results.push(entry);cachedBytes+=result.resultBytes||0;for(const previous of results){if(cachedBytes<=4*1024*1024)break;if(previous.rows?.length){cachedBytes-=previous.resultBytes||0;previous.rows=[];previous.columns=[];previous.resultBytes=0;previous.resultOmitted=true;}} schema = result.schema || schema; }
      catch (error) { const failure = { statementIndex: index + 1, sql: statement, error: error.message, columns: [], rows: [], rowCount: 0, affectedRows: 0, elapsedMs: 0 }; results.push(failure); errors.push({ index: index + 1, message: error.message }); if (stopOnError || /Reconnect to continue|closed|cancelled/i.test(error.message)) break; }
    }
    return { results, errors, stopped: results.length < statements.length, statementCount: statements.length };
  });
  handle('history:list', options => historyStore.list({...options,profileId:currentProfile?.id}));
  handle('history:update', value => historyStore.update(value,currentProfile?.id));
  handle('history:remove', id => historyStore.remove(id,currentProfile?.id));
  handle('history:clear', () => historyStore.clear(currentProfile?.id));
  handle('history:settings', value => historyStore.settings(value));
  handle('clipboard:write', value => {if(typeof value!=='string'||value.length>1000000)throw new Error('Copy text up to 1 MB.');clipboard.writeText(value);return true;});
  handle('local:pick', async ({ create = false } = {}) => {
    const filters = [{ name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3'] }, { name: 'All files', extensions: ['*'] }];
    let filePath;
    if (create) {
      const choice = await dialog.showSaveDialog(window, { title: 'Create a local SQLite database', defaultPath: 'workspace.db', filters });
      if (choice.canceled) return null;
      filePath = choice.filePath;
    } else {
      const choice = await dialog.showOpenDialog(window, { title: 'Open a local SQLite database', filters, properties: ['openFile'] });
      if (choice.canceled) return null;
      filePath = choice.filePaths[0];
    }
    return { name: path.basename(filePath), mode: 'sqlite', filePath };
  });
  handle('file:open', async () => {
    const choice = await dialog.showOpenDialog(window, { filters: [{ name: 'SQL files', extensions: ['sql'] }], properties: ['openFile'] });
    if (choice.canceled) return null;
    const filename = choice.filePaths[0];
    if (fs.statSync(filename).size > 1000000) throw new Error('Choose a SQL file smaller than 1 MB.');
    return { name: path.basename(filename), sql: fs.readFileSync(filename, 'utf8') };
  });
  handle('file:save', async ({ name, sql }) => {
    if (typeof sql !== 'string') throw new Error('SQL text is required.');
    const choice = await dialog.showSaveDialog(window, { defaultPath: name || 'query.sql', filters: [{ name: 'SQL files', extensions: ['sql'] }] });
    if (choice.canceled) return null;
    fs.writeFileSync(choice.filePath, sql, 'utf8');
    return path.basename(choice.filePath);
  });
  handle('file:export', async ({ columns, rows, format = 'csv' }) => {
    if (!Array.isArray(columns) || !Array.isArray(rows)) throw new Error('No results to export.');
    const json = format === 'json';
    const choice = await dialog.showSaveDialog(window, { defaultPath: json ? 'results.json' : 'results.csv', filters: [{ name: json ? 'JSON' : 'CSV', extensions: [json ? 'json' : 'csv'] }] });
    if (choice.canceled) return null;
    const cell = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
    const names = columns.map(column => column.name);
    const text = json ? JSON.stringify({ columns, rows }, null, 2) : [names.map(cell).join(','), ...rows.map(row => columns.map(column => cell(row[column.key || column.name])).join(','))].join('\r\n');
    fs.writeFileSync(choice.filePath, text, 'utf8');
    return choice.filePath;
  });

  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 1040, minHeight: 720, title: 'EZ Bench', icon: path.join(__dirname, 'icon.png'), backgroundColor: '#141619', show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  installMenu(() => window, workspace?.preferences);
  window.on('close', event => {
    if (closeApproved || window.webContents.isCrashed() || window.webContents.isLoadingMainFrame()) return;
    event.preventDefault();
    if (!closeRequested) {
      closeRequested = true;
      window.webContents.send('workspace:prepare-close');
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.loadFile('index.html');
  window.once('ready-to-show', () => window.show());
});
app.on('window-all-closed', () => app.quit());
let closing = false;
app.on('will-quit', event => {
  if (closing || !db) return;
  event.preventDefault(); closing = true;
  Promise.allSettled([db.close(),historyStore?.close(),updates?.close(),snippets?.close()]).finally(() => app.exit(0));
});
