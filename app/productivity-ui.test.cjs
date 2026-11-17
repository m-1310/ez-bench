'use strict';
const {workspaceAction}=require('./ui-actions.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const executablePath = process.env.WORK_EZ_BENCH_EXECUTABLE || path.join(__dirname, 'node_modules/electron/dist/electron.exe');
async function launch(dir) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath, args: [__dirname, '--data-dir=' + dir], env });
  const page = await app.firstWindow(); page.setDefaultTimeout(10000); await page.locator('#demo-connect').waitFor();
  return { app, page };
}
async function run(page, sql) { await page.locator('#sql-editor').fill(sql); await page.locator('#run-query').click(); await page.waitForFunction(() => !document.querySelector('#run-query').disabled); assert.equal(await page.locator('#result-message').getAttribute('class'), 'result-message '); }
function directory() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ez-productivity-')); }
async function screenshot(page, name) { await page.evaluate(async () => { await document.fonts.ready; await Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))); }); const file = path.resolve(__dirname, '../evidence/' + name); fs.mkdirSync(path.dirname(file), { recursive: true }); await page.screenshot({ path: file }); }

test('snippets preserve full SQL across restart, support insert/search/edit, reject private capture and confirm deletion', { timeout: 60000 }, async () => {
  const dir = directory(); let app, page;
  try {
    ({ app, page } = await launch(dir)); await page.locator('#demo-connect').click();
    const sql = "-- café reusable query\nSELECT '東京' AS city;";
    await page.locator('#sql-editor').fill(sql); await page.locator('#save-snippet').click();
    assert.equal(await page.locator('#snippet-sql').inputValue(), sql);
    await page.locator('#snippet-title').fill('Cities saved SQL'); await page.locator('#snippet-save').click();
    await page.waitForFunction(() => document.querySelector('#snippet-count').textContent === '1/100 saved');
    await screenshot(page, 'ez-bench-0.9.1-snippets.png');
    await page.locator('#snippet-close').click(); await app.close(); app = null;
    ({ app, page } = await launch(dir)); await page.locator('#demo-connect').click(); await workspaceAction(page,'open-snippets');
    assert.equal(await page.locator('#snippet-sql').inputValue(), sql);
    await page.locator('#snippet-search').fill('東京'); assert.equal(await page.locator('.snippet-item').count(), 1);
    await page.locator('#snippet-search').fill('nothing matches'); assert.equal(await page.locator('.snippet-item').count(), 0);
    await page.locator('#snippet-search').fill(''); await page.locator('#snippet-open').click();
    assert.equal(await page.locator('#sql-editor').inputValue(), sql);
    assert.equal(await page.locator('#result-table tbody tr').count(), 0, 'Opening a snippet must not execute it.');
    await page.locator('#sql-editor').fill('SELECT ;'); await page.locator('#sql-editor').evaluate(element => element.setSelectionRange(7, 7));
    await workspaceAction(page,'open-snippets'); await page.locator('#snippet-sql').fill('42'); await page.locator('#snippet-insert').click();
    assert.equal(await page.locator('#sql-editor').inputValue(), 'SELECT 42;');
    await page.locator('#private-query').check(); await page.locator('#save-snippet').click();
    assert.equal(await page.locator('#snippets-dialog').isVisible(), false);
    assert.ok((await page.locator('#toast').innerText()).includes('Private SQL'));
    await assert.rejects(() => page.evaluate(() => window.querydesk.saveSnippet({ title: 'Private', sql: 'SELECT 1', dialect: 'any', private: true })), /Private SQL/);
    await page.locator('#private-query').uncheck(); await workspaceAction(page,'open-snippets');
    await page.locator('#snippet-title').fill('Renamed reusable SQL'); await page.locator('#snippet-save').click();
    await page.waitForFunction(() => document.querySelector('.snippet-item strong').textContent === 'Renamed reusable SQL');
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    await page.locator('#snippet-delete').click(); assert.equal(await page.locator('.snippet-item').count(), 1);
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    await page.locator('#snippet-delete').click(); await page.waitForFunction(() => document.querySelector('#snippet-count').textContent === '0/100 saved');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'snippets.json'), 'utf8')).entries.length, 0);
  } finally { await app?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('database-side table criteria reach later pages, retain sort across navigation and preserve dirty-edit guards', { timeout: 60000 }, async () => {
  const dir = directory(); let app;
  try {
    const launched = await launch(dir); app = launched.app; const page = launched.page;
    await page.locator('#demo-connect').click();
    await run(page, 'CREATE TABLE browse_ui(id INTEGER PRIMARY KEY, title TEXT, amount INTEGER)');
    await run(page, "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<250) INSERT INTO browse_ui SELECT x, 'Row '||x, x FROM n");
    await page.locator('#schema-tree .table-row').filter({ hasText: /^browse_ui$/ }).locator('button').first().click();
    await page.waitForFunction(() => document.querySelector('#table-page-label').textContent.includes('100'));
    await page.locator('#table-browse-open').click(); await page.locator('#browse-column').selectOption('id'); await page.locator('#browse-operator').selectOption('gte'); await page.locator('#browse-value').fill('125');
    await page.locator('#browse-sort').selectOption('id'); await page.locator('#browse-direction').selectOption('desc'); await page.locator('#browse-form button[type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('#run-query').disabled && document.querySelector('#table-browse-summary').textContent.includes('DESC')).catch(async error => { console.log('Browse diagnostic', await page.evaluate(() => ({status:document.querySelector('#result-message').textContent, error:document.querySelector('#browse-error').textContent, summary:document.querySelector('#table-browse-summary').textContent, dialog:document.querySelector('#table-browse-dialog')?.open})));throw error;});
    assert.equal(await page.locator('tbody tr').first().locator('td[data-column=id]').innerText(), '250');
    await page.locator('#table-next').click(); await page.waitForFunction(() => document.querySelector('#table-page-label').textContent.includes('101'));
    assert.equal(await page.locator('tbody tr').first().locator('td[data-column=id]').innerText(), '150');
    const cell = page.locator('tbody tr').first().locator('td[data-column=title]'); await cell.dblclick(); await cell.locator('input').fill('Staged filtered edit'); await cell.locator('input').press('Enter');
    await page.locator('#table-browse-reset').click(); await page.locator('#discard-dialog').waitFor(); await page.locator('#discard-stay').click();
    assert.equal(await page.locator('td.grid-cell-changed').innerText(), 'Staged filtered edit');
    assert.ok((await page.locator('#table-browse-summary').innerText()).includes('DESC'));
    await page.locator('#table-apply').click(); await page.waitForFunction(() => !document.querySelector('#apply-confirm').disabled); await page.locator('#apply-confirm').click();
    await page.locator('#apply-dialog').waitFor({ state: 'hidden' }); await page.waitForFunction(() => !document.querySelector('#run-query').disabled);
    assert.equal(await page.locator('tbody tr').first().locator('td[data-column=title]').innerText(), 'Staged filtered edit');
    await screenshot(page, 'ez-bench-0.9.1-table.png');
    await page.locator('#table-browse-reset').click(); await page.waitForFunction(() => document.querySelector('#table-browse-summary').textContent.startsWith('All rows'));
    assert.equal(await page.locator('tbody tr').first().locator('td[data-column=id]').innerText(), '1');
  } finally { await app?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('find-and-replace handles literal dollars, selected matches, case and full editor recovery without execution', { timeout: 60000 }, async () => {
  const dir = directory(); let app;
  try {
    const launched = await launch(dir); app = launched.app; const page = launched.page;
    await page.locator('#demo-connect').click(); await page.locator('#sql-editor').fill('SELECT cat, CAT, cat;');
    await app.evaluate(({ Menu, BrowserWindow }) => { const menu = Menu.getApplicationMenu().items.find(item => item.label.replace(/&/g, '') === 'Edit'); const action = menu.submenu.items.find(item => item.label.startsWith('Replace in')); action.click(action, BrowserWindow.getAllWindows()[0]); });
    await page.locator('#find-dialog').waitFor(); await page.locator('#find-text').fill('cat'); await page.locator('#replace-text').fill('$1');
    await page.locator('#replace-all').click(); assert.equal(await page.locator('#find-message').innerText(), '3 replacements.');
    assert.equal(await page.locator('#sql-editor').inputValue(), 'SELECT $1, $1, $1;');
    await page.locator('#find-text').fill('$1'); await page.locator('#replace-text').fill('city'); await page.locator('#find-next').click(); await page.locator('#replace-one').click();
    assert.equal(await page.locator('#sql-editor').inputValue(), 'SELECT city, $1, $1;');
    await screenshot(page, 'ez-bench-0.9.1-find.png'); await page.locator('#find-close').click();
    const value = await page.locator('#sql-editor').inputValue(); await app.close(); app = null;
    const restarted = await launch(dir); app = restarted.app; await restarted.page.locator('#demo-connect').click();
    assert.equal(await restarted.page.locator('#sql-editor').inputValue(), value);
  } finally { await app?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('graphite and warm light themes keep readable primary controls and fit new dialogs at minimum window size', { timeout: 60000 }, async () => {
  const dir = directory(); let app;
  try {
    const launched = await launch(dir); app = launched.app; const page = launched.page;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 720));
    const colors = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement), button = getComputedStyle(document.querySelector('#demo-connect'));
      return { accent: style.getPropertyValue('--accent').trim().toLowerCase(), secondary: style.getPropertyValue('--secondary').trim().toLowerCase(), foreground: button.color, background: button.backgroundColor };
    });
    assert.equal(colors.accent, '#f0a56d'); assert.equal(colors.secondary, '#9ebed4');
    function luminance(text) { const rgb = text.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => { const n = value / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }); return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722; }
    const a = luminance(colors.foreground), b = luminance(colors.background);
    assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, 'Primary button text needs at least 4.5:1 contrast.');
    for (const theme of ['dark', 'light']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await workspaceAction(page,'theme-toggle');
      await page.evaluate(async () => { await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))); });
      const samples = await page.evaluate(() => {
        const rgba = text => { const values = text.match(/[\d.]+/g).map(Number); return [...values.slice(0, 3), values[3] ?? 1]; };
        const background = node => {
          const layers = []; for (let parent = node; parent; parent = parent.parentElement) layers.unshift(rgba(getComputedStyle(parent).backgroundColor));
          return layers.reduce((base, layer) => layer.slice(0, 3).map((value, index) => value * layer[3] + base[index] * (1 - layer[3])), [255, 255, 255]);
        };
        return ['.home-title h1', '.home-title p', '.quick-card strong', '#demo-connect', '.sidebar-home.active', '.local-badge', '.playground-code span', '.playground-code b', '.home-footer', '.connection-search input'].map(selector => {
          const node = document.querySelector(selector), style = getComputedStyle(node, selector.endsWith('input') ? '::placeholder' : null);
          return { selector, foreground: style.color, background: 'rgb(' + background(node).join(',') + ')' };
        });
      });
      for (const sample of samples) {
        const x = luminance(sample.foreground), y = luminance(sample.background);
        assert.ok((Math.max(x, y) + .05) / (Math.min(x, y) + .05) >= 4.5, `${theme} ${sample.selector} needs readable text contrast`);
      }
    }
    await workspaceAction(page,'theme-toggle');
    const homePattern = await page.locator('#home-view').evaluate(home => ({ background: getComputedStyle(home).backgroundImage, dots: getComputedStyle(home, '::before').backgroundImage, pointer: getComputedStyle(home, '::before').pointerEvents, animation: getComputedStyle(home, '::before').animationName }));
    assert.ok(homePattern.background === 'none' && homePattern.dots.includes('radial-gradient'));
    assert.equal(homePattern.pointer, 'none'); assert.equal(homePattern.animation, 'none');
    await screenshot(page, 'ez-bench-0.9.1-home.png');
    await page.locator('#demo-connect').click(); await workspaceAction(page,'open-snippets');
    const layout = await page.locator('#snippets-dialog').evaluate(dialog => {
      const rect = dialog.getBoundingClientRect(), actions = dialog.querySelector('.snippet-actions').getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight, actionsBottom: actions.bottom, scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth };
    });
    assert.ok(layout.left >= 0 && layout.right <= layout.width && layout.top >= 0 && layout.bottom <= layout.height);
    assert.ok(layout.actionsBottom <= layout.bottom && layout.scrollWidth <= layout.clientWidth + 1);
    await screenshot(page, 'ez-bench-0.9.1-minimum.png'); await page.locator('#snippet-close').click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await screenshot(page, 'ez-bench-0.9.1-dark.png');
    await workspaceAction(page,'theme-toggle'); assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await screenshot(page, 'ez-bench-0.9.1-light.png');
  } finally { await app?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('workspace home keeps primary tasks visible and recovers from an empty connection search with keyboard focus', { timeout: 60000 }, async () => {
  const dir = directory(); let app;
  try {
    const launched = await launch(dir); app = launched.app; const page = launched.page;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 720));
    await page.locator('.connection-empty h3').waitFor();
    assert.equal(await page.locator('.connection-empty h3').innerText(), 'No saved connections');
    const geometry = await page.evaluate(() => {
      const home = document.querySelector('#home-view').getBoundingClientRect();
      return { home: home.toJSON(), controls: ['#quick-new', '#home-open-local', '#create-local', '#demo-connect', '.home-footer'].map(selector => ({ selector, ...document.querySelector(selector).getBoundingClientRect().toJSON() })) };
    });
    for (const control of geometry.controls) {
      assert.ok(control.left >= geometry.home.left && control.right <= geometry.home.right, control.selector + ' stays within the home width');
      assert.ok(control.top >= geometry.home.top && control.bottom <= geometry.home.bottom, control.selector + ' is visible without scrolling');
    }
    await page.locator('.connection-empty .button').click();
    const dialog = page.locator('#connection-dialog');
    const name = 'Reporting — a long connection name for a local development workspace';
    await dialog.locator('[name="name"]').fill(name);
    await dialog.locator('[name="host"]').fill('127.0.0.1');
    await dialog.locator('[name="user"]').fill('local_fixture');
    await page.locator('#save-connection').click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#connection-count').innerText(), '1');
    const playground = await page.locator('#demo-connect').evaluate(button => ({ bottom: button.getBoundingClientRect().bottom, mainBottom: document.querySelector('#home-view').getBoundingClientRect().bottom }));
    assert.ok(playground.bottom <= playground.mainBottom, 'Saved profiles must not move the playground action below the fold');
    await page.locator('#connection-search').fill('no matching server');
    assert.equal(await page.locator('.connection-empty h3').innerText(), 'No matching connections');
    await page.locator('.connection-empty .button').click();
    assert.equal(await page.locator('#connection-search').inputValue(), '');
    assert.ok(await page.locator('.connection-card strong').filter({ hasText: name }).isVisible());
    assert.equal(await page.evaluate(() => document.activeElement.id), 'connection-search');
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => ({ outlined: getComputedStyle(document.activeElement).outlineStyle !== 'none', button: document.activeElement.tagName === 'BUTTON' }));
    assert.ok(focus.outlined && focus.button, 'Keyboard navigation exposes a visible focus ring');
    await screenshot(page, 'ui-0.9.1-home-populated.png');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Home remains within the window at 125% zoom');
    await workspaceAction(page,'new-connection');
    const scaledDialog = await dialog.evaluate(node => ({ rect: node.getBoundingClientRect().toJSON(), width: innerWidth, height: innerHeight }));
    assert.ok(scaledDialog.rect.left >= 0 && scaledDialog.rect.right <= scaledDialog.width && scaledDialog.rect.top >= 0 && scaledDialog.rect.bottom <= scaledDialog.height);
    await page.locator('#close-connection').click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
    await workspaceAction(page,'theme-toggle');
    await page.locator('#connection-search').fill('no matching server');
    assert.equal(await page.locator('.connection-empty h3').innerText(), 'No matching connections');
    await page.locator('.connection-empty .button').click();
    assert.ok(await page.locator('.connection-card strong').filter({ hasText: name }).isVisible());
  } finally { await app?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Settings groups global actions, Overview opens SQL files, and navigation/code/results have distinct typography', { timeout: 60000 }, async () => {
  const dir=directory();let app;
  try {
    const started=await launch(dir);app=started.app;const page=started.page;
    assert.equal(await page.locator('.topbar button').count(),1);
    assert.ok(await page.locator('#workspace-menu').isVisible());
    assert.ok(await page.locator('#overview-open-sql').isVisible());
    assert.equal(await page.locator('#new-connection').isVisible(),false);
    await page.locator('#workspace-menu').click();
    for(const id of ['new-connection','open-local','open-file','open-snippets','theme-toggle','check-updates'])assert.ok(await page.locator('#'+id).isVisible(),id+' is available in Settings');
    await screenshot(page,'ui-0.9.3-settings.png');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#workspace-settings').evaluate(menu=>menu.matches(':popover-open')),false);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'workspace-menu');
    const sql='SELECT 7 AS opened_from_overview;';const file=path.join(dir,'overview.sql');fs.writeFileSync(file,sql);
    await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);
    await page.locator('#overview-open-sql').click();
    await page.waitForFunction(sql=>document.querySelector('#sql-editor').value===sql,sql);
    assert.equal(await page.locator('#dialect-badge').innerText(),'Not connected');
    await page.locator('#home-button').click();await page.locator('#demo-connect').click();
    await run(page,'SELECT name, city FROM customers;');
    const fonts=await page.evaluate(()=>{
      const style=selector=>{const x=getComputedStyle(document.querySelector(selector));return{family:x.fontFamily,size:parseFloat(x.fontSize),weight:x.fontWeight,line:x.lineHeight};};
      return{sidebar:style('.connection-item'),sql:style('#sql-editor'),highlight:style('#syntax-highlight'),grid:style('#result-table td:not(.row-number)'),heading:style('#result-table th')};
    });
    assert.ok(fonts.sql.family.includes('monospace'));
    assert.equal(fonts.sql.family,fonts.highlight.family);assert.equal(fonts.sql.line,fonts.highlight.line);
    assert.ok(!fonts.grid.family.includes('monospace'),'Result values use proportional UI text');
    assert.ok(fonts.grid.size>=13&&fonts.sql.size>fonts.grid.size,JSON.stringify(fonts));
    assert.ok(Number(fonts.heading.weight)>=600&&Number(fonts.sidebar.weight)<600);
    await screenshot(page,'ui-0.9.3-typography.png');
    await workspaceAction(page,'new-connection');await page.locator('#connection-dialog').waitFor({state:'visible'});
    assert.equal(await page.locator('#workspace-settings').evaluate(menu=>menu.matches(':popover-open')),false);
    await page.locator('#close-connection').click();
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1040,720));
    await page.locator('#workspace-menu').click();
    const bounds=await page.locator('#workspace-settings').evaluate(menu=>({rect:menu.getBoundingClientRect().toJSON(),width:innerWidth,height:innerHeight}));
    assert.ok(bounds.rect.left>=0&&bounds.rect.right<=bounds.width&&bounds.rect.top>=0&&bounds.rect.bottom<=bounds.height);
    await screenshot(page,'ui-0.9.3-settings-minimum.png');await page.keyboard.press('Escape');
  } finally {await app?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
