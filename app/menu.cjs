const { Menu, dialog, app } = require('electron');
const { all } = require('./command-catalog.js');

function installMenu(getWindow, preferences) {
  const send = (id, value) => { const window = getWindow(); if (window && !window.isDestroyed()) window.webContents.send('app:action', { id, value }); };
  const action = id => {
    const command = all.find(item => item.id === id);
    if (!command) throw new Error('Unknown menu command: ' + id);
    return { id, label: command.label, accelerator: command.accelerator || undefined, click: () => send(id) };
  };
  const role = id => ({ role: id, accelerator: all.find(item => item.id === id)?.accelerator });
  const separator = () => ({ type: 'separator' });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '&File', submenu: [
      action('new-tab'), action('open-file'), action('save-file'), separator(),
      action('duplicate-tab'), action('rename-tab'), action('close-tab'), action('reopen-tab'), separator(),
      { role: 'quit', label: 'Exit EZ Bench' },
    ] },
    { label: '&Edit', submenu: [
      role('undo'), role('redo'), separator(), role('cut'), role('copy'), role('paste'), role('selectAll'), separator(),
      action('find'), action('replace'), action('format-sql'),
    ] },
    { label: '&View', submenu: [
      action('home-button'), action('results-tab'), action('history-tab'), action('structure-tab'), action('database-tab'), separator(),
      action('open-snippets'), action('sidebar-toggle'), action('wrap-toggle'), separator(),
      action('theme-toggle'), action('settings'), separator(),
      role('resetZoom'), role('zoomIn'), role('zoomOut'), role('togglefullscreen'),
    ] },
    { label: '&Query', submenu: [
      action('run-query'), action('run-script'), action('cancel-query'), separator(), action('explain'), action('save-snippet'),
      { label: 'Stop script on error', type: 'checkbox', checked: preferences?.stopOnError !== false, click: item => send('stop-on-error', item.checked) }, separator(),
      action('begin-transaction'), action('commit-transaction'), action('rollback-transaction'),
    ] },
    { label: '&Database', submenu: [
      action('new-connection'), action('open-local'), action('create-local'), separator(),
      action('refresh-schema'), action('new-table'), separator(),
      action('database-backup'), action('database-restore'), separator(), action('disconnect'),
    ] },
    { label: '&Window', submenu: [
      action('next-tab'), action('previous-tab'), separator(), { role: 'minimize' }, { role: 'close' },
    ] },
    { label: '&Help', submenu: [
      action('shortcuts'), action('check-updates'), separator(),
      { label: 'About EZ Bench', click: () => dialog.showMessageBox(getWindow(), { type: 'info', title: 'EZ Bench', message: 'EZ Bench ' + app.getVersion(), detail: 'A free local SQL workspace.\nMySQL · MariaDB · PostgreSQL · SQL Server · SQLite\nWindows 10 and later · x64\n\nOriginal source: MIT. Lucide icons: ISC/MIT.' }) },
    ] },
  ]));
}

module.exports = { installMenu };
