'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const { workspaceAction } = require('./ui-actions.cjs');
const catalog = require('./command-catalog.js');

test('shared native commands, real accelerators and searchable shortcut dialog work across themes and sizes', { timeout: 90000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-shortcuts-'));
  const executablePath = process.env.WORK_EZ_BENCH_EXECUTABLE || path.join(__dirname, 'node_modules/electron/dist/electron.exe');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let application;
  try {
    application = await _electron.launch({ executablePath, args: [__dirname, '--data-dir=' + directory], env });
    const page = await application.firstWindow(); page.setDefaultTimeout(10000);
    const press = async combination => {
      await application.evaluate(({ BrowserWindow }, combination) => {
        const parts = combination.split('+'); const keyCode = parts.pop();
        const modifiers = parts.map(key => ({ Control: 'control', Shift: 'shift', Alt: 'alt' }[key]));
        const window = BrowserWindow.getAllWindows()[0]; window.focus();
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      }, combination);
    };
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.locator('#demo-connect').waitFor();
    const version = await application.evaluate(({ app }) => app.getVersion());
    assert.equal(await page.locator('.version').innerText(), version);
    assert.equal(await page.locator('.status-version').innerText(), 'EZ Bench ' + version);
    const capture = async name => {
      await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      const pixels = await application.evaluate(async ({ BrowserWindow }) => {
        const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
        return image.toPNG().toString('base64');
      });
      fs.writeFileSync(path.resolve(__dirname, '../evidence/ui-0.9.4-' + name + '.png'), Buffer.from(pixels, 'base64'));
    };
    const menu = await application.evaluate(({ Menu }, catalog) => {
      const menu = Menu.getApplicationMenu();
      const shortcuts = catalog.all.filter(command => command.accelerator);
      const accelerators = shortcuts.map(command => command.accelerator.toLowerCase());
      if (new Set(accelerators).size !== accelerators.length) throw new Error('Duplicate shortcut');
      const actual = catalog.commands.filter(command => command.accelerator).map(command => {
        const item = menu.getMenuItemById(command.id);
        return { id: command.id, expected: command.accelerator, actual: item?.accelerator };
      });
      return { actual, count: shortcuts.length, labels: menu.items.map(item => item.label), database: menu.items.find(item => item.label === '&Database').submenu.items.map(item => item.label) };
    }, catalog);
    for (const command of menu.actual) assert.equal(command.actual, command.expected, command.id);
    assert.deepEqual(menu.labels, ['&File','&Edit','&View','&Query','&Database','&Window','&Help']);
    assert.ok(menu.database.includes('Open local database…') && menu.database.includes('Back up database…'));
    assert.ok(!menu.database.includes('Test connection…'), 'No duplicate action misleadingly labelled Test');
    await workspaceAction(page, 'shortcuts');
    await page.locator('#shortcuts-dialog').waitFor();
    assert.equal(await page.locator('#workspace-settings').evaluate(node => node.matches(':popover-open')), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'shortcut-search');
    assert.equal(await page.locator('.shortcut-row').count(), menu.count);
    await capture('shortcuts-dark');
    await page.locator('#shortcut-search').fill('history');
    assert.equal(await page.locator('.shortcut-row').count(), 1);
    assert.ok((await page.locator('.shortcut-row').innerText()).includes('Ctrl+Shift+H'));
    await page.locator('#shortcut-search').fill('zznomatch');
    assert.equal(await page.locator('.shortcut-row').count(), 0);
    assert.ok((await page.locator('#shortcut-count').innerText()).includes('No shortcuts match'));
    await page.locator('#shortcut-search').fill('Ctrl+Shift+N');
    assert.equal(await page.locator('.shortcut-row').count(), 1);
    await page.locator('#shortcut-close').click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'workspace-menu');
    await press('F1'); await page.locator('#shortcuts-dialog').waitFor();
    assert.equal(await page.locator('#shortcut-search').inputValue(), '');
    await press('Escape'); await page.locator('#shortcuts-dialog').waitFor({ state: 'hidden' });
    await press('Control+,');
    await page.waitForFunction(() => document.querySelector('#workspace-settings').matches(':popover-open'));
    await capture('settings'); await press('Escape');
    await press('Control+Shift+N'); await page.locator('#connection-dialog').waitFor();
    // A modal owns the keyboard: shortcuts must not replace or stack it.
    await press('F1'); assert.equal(await page.locator('#shortcuts-dialog').isVisible(), false);
    await page.locator('#close-connection').click();
    await page.locator('#demo-connect').click(); await page.locator('#sql-editor').fill('SELECT 12 AS shortcut_result;');
    await press('Control+Enter'); await page.waitForFunction(() => document.querySelector('#result-table').textContent.includes('shortcut_result'));
    await press('Control+Shift+D'); await page.waitForFunction(() => document.querySelectorAll('.query-tab').length === 2);
    assert.equal(await page.locator('#sql-editor').inputValue(), 'SELECT 12 AS shortcut_result;');
    await press('Control+Alt+R'); await page.locator('#rename-tab-dialog').waitFor();
    await page.locator('#rename-tab-cancel').click();
    await press('Control+Shift+H'); await page.locator('#history-panel').waitFor();
    await press('Control+Alt+1'); await page.locator('#result-panel').waitFor();
    await press('Control+Alt+H'); await page.locator('#home-view').waitFor();
    const before = await page.locator('html').getAttribute('data-theme');
    await press('Control+Alt+T'); await page.waitForFunction(theme => document.documentElement.dataset.theme !== theme, before);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040,720));
    await press('F1'); await page.locator('#shortcuts-dialog').waitFor();
    const bounds = await page.locator('#shortcuts-dialog').evaluate(node => ({ rect: node.getBoundingClientRect().toJSON(), width: innerWidth, height: innerHeight, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, listScroll: document.getElementById('shortcut-list').scrollHeight, listHeight: document.getElementById('shortcut-list').clientHeight }));
    assert.ok(bounds.rect.top >= 0 && bounds.rect.bottom <= bounds.height && bounds.rect.right <= bounds.width && bounds.rect.left >= 0, JSON.stringify(bounds));
    assert.ok(bounds.scrollWidth <= bounds.clientWidth && bounds.listScroll > bounds.listHeight, JSON.stringify(bounds));
    await capture('shortcuts-light-minimum');
    await page.locator('#shortcut-list').evaluate(node => node.scrollTop = node.scrollHeight);
    await capture('shortcuts-bottom');
    assert.ok(await page.locator('#shortcut-close').isVisible());
    await press('Escape');
    await press('Control+Alt+T');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await press('F1'); await page.locator('#shortcuts-dialog').waitFor();
    assert.equal(await page.locator('#shortcut-list').evaluate(node => node.scrollTop), 0, 'Reopening the reference starts at its first group');
    await capture('shortcuts-dark-minimum');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25));
    const scaled = await page.locator('#shortcuts-dialog').evaluate(node => ({ rect: node.getBoundingClientRect().toJSON(), width: innerWidth, height: innerHeight, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
    assert.ok(scaled.rect.top >= 0 && scaled.rect.bottom <= scaled.height && scaled.rect.right <= scaled.width && scaled.rect.left >= 0 && scaled.scrollWidth <= scaled.clientWidth, JSON.stringify(scaled));
    await capture('shortcuts-dark-125'); await press('Escape'); assert.deepEqual(errors, []);
  } finally {
    await application?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
