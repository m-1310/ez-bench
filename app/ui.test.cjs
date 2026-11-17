'use strict';
const {workspaceAction}=require('./ui-actions.cjs');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { _electron } = require('playwright');

const appDir = __dirname;
const executablePath = process.env.WORK_EZ_BENCH_EXECUTABLE || path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const screenshotPath = path.resolve(appDir, '..', 'evidence', 'work-ez-bench-preview.png');
const homeScreenshotPath = path.resolve(appDir, '..', 'evidence', 'work-ez-bench-home.png');

async function launch(dataDir) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({ executablePath, args: [appDir, '--data-dir=' + dataDir], env, timeout: 30000 });
  try {
    const page = await application.firstWindow();
    page.setDefaultTimeout(10000);
    await page.locator('#demo-connect').waitFor({ state: 'visible' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (process.env.WORK_EZ_BENCH_EXECUTABLE) {
      const installedRoot = await application.evaluate(({ app }) => app.getAppPath());
      assert.equal(path.resolve(installedRoot), path.resolve(path.dirname(executablePath), 'resources', 'app'));
    }
    return { application, page };
  } catch (error) {
    await application.close();
    throw error;
  }
}

async function runSql(page, sql, expectedMessage) {
  await page.locator('#results-tab').click();
  await page.locator('#sql-editor').fill(sql);
  await page.locator('#run-query').click();
  if (expectedMessage) {
    await page.waitForFunction(message => document.querySelector('#result-message')?.textContent.includes(message), expectedMessage).catch(async error => { console.log('SQL diagnostic', await page.evaluate(() => ({sql:document.querySelector('#sql-editor').value, status:document.querySelector('#result-message').textContent, busy:document.querySelector('#run-query').disabled}))); throw error; });
  }
  await page.waitForFunction(() => !document.querySelector('#run-query').disabled);
}

test('restart restores pending SQL and settings after warning about unsaved file and private edits', { timeout: 60000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezbench-recovery-ui-'));
  const sqlFile = path.join(dataDir, 'report.sql');
  const original = 'SELECT 1 AS saved_report;';
  const draft = 'SELECT 2 AS unexecuted_draft;';
  const fileEdit = 'SELECT 3 AS unexported_edit;';
  const privateSql = 'SELECT 4 AS private_fixture;';
  fs.writeFileSync(sqlFile, original);
  let application, page;
  try {
    ({ application, page } = await launch(dataDir));
    await application.evaluate(({ dialog, Menu, BrowserWindow }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      const query = Menu.getApplicationMenu().items.find(item => item.label === '&Query');
      const stop = query.submenu.items.find(item => item.label === 'Stop script on error');
      stop.click(stop, BrowserWindow.getAllWindows()[0]);
      const { promise, resolve } = Promise.withResolvers();
      globalThis.unsavedPrompt = promise;
      dialog.showMessageBox = async (_window, options) => { resolve(options); return { response: 0 }; };
    }, sqlFile);
    await page.waitForFunction(() => stopOnError === false);
    await workspaceAction(page, 'theme-toggle');
    await page.locator('#sidebar-toggle').click();
    await page.locator('#overview-open-sql').click();
    await page.getByRole('tab', { name: /^report\.sql/ }).waitFor();
    await page.locator('#wrap-toggle').click();
    await page.locator('#sql-editor').fill(fileEdit);
    await page.locator('#new-tab').click();
    await page.locator('#private-query').check();
    await page.locator('#sql-editor').fill(privateSql);
    await page.locator('#new-tab').click();
    await page.locator('#sql-editor').fill(draft);
    await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
    const prompt = await application.evaluate(() => globalThis.unsavedPrompt);
    assert.match(prompt.message, /unsaved work/i);
    assert.match(prompt.detail, /Private or credential-bearing SQL/);
    assert.match(prompt.detail, /opened SQL file/);
    assert.equal(prompt.buttons[prompt.defaultId], 'Keep working');
    assert.equal(await page.locator('#sql-editor').inputValue(), draft);
    assert.equal(fs.readFileSync(sqlFile, 'utf8'), original);

    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    await application.close();
    application = null;
    const recovery = fs.readFileSync(path.join(dataDir, 'workspace.json'), 'utf8');
    assert.ok(recovery.includes(draft) && recovery.includes(fileEdit));
    assert.equal(recovery.includes(privateSql), false);

    ({ application, page } = await launch(dataDir));
    await page.locator('#overview-resume-sql').click();
    assert.equal(await page.locator('#sql-editor').inputValue(), draft);
    assert.equal(await page.locator('#connection-status').textContent(), 'No active connection');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#wrap-toggle').getAttribute('aria-pressed'), 'true');
    assert.equal(await application.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => item.label === '&Query').submenu.items.find(item => item.label === 'Stop script on error').checked), false);
    await page.getByRole('tab', { name: /^report\.sql/ }).click();
    assert.equal(await page.locator('#sql-editor').inputValue(), fileEdit);
    await page.getByRole('tab', { name: /^Query 3/ }).click();
    assert.equal(await page.locator('#private-query').isChecked(), true);
    assert.equal(await page.locator('#sql-editor').inputValue(), '');
  } finally {
    if (application) {
      await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
      await application.close();
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('existing local storage editor recovery migrates to the version-independent workspace file', { timeout: 60000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezbench-existing-recovery-'));
  const draft = 'SELECT 20 AS legacy_draft;';
  let application, page;
  try {
    ({ application, page } = await launch(dataDir));
    await page.evaluate(sql => {
      const state = { tabs: [{ id: 3, name: 'Legacy draft', sql }], activeTab: 3, tabCount: 3 };
      localStorage.setItem('work-ez-bench.tabs', JSON.stringify(state));
      localStorage.setItem('work-ez-bench.workspaces', JSON.stringify({ playground: state }));
      localStorage.setItem('work-ez-bench.theme', 'light');
    }, draft);
    await application.close();
    application = null;
    fs.unlinkSync(path.join(dataDir, 'workspace.json'));

    ({ application, page } = await launch(dataDir));
    await page.locator('#overview-resume-sql').click();
    assert.equal(await page.locator('#sql-editor').inputValue(), draft);
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await page.waitForFunction(() => localStorage.getItem('work-ez-bench.tabs') === null);
    const recovery = JSON.parse(fs.readFileSync(path.join(dataDir, 'workspace.json'), 'utf8'));
    assert.equal(recovery.workspaces.playground.tabs[0].sql, draft);
  } finally {
    await application?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('desktop UI executes real SQL, restores editor/history, and persists credential-free profiles', { timeout: 120000 }, async () => {
  assert.ok(fs.existsSync(executablePath), 'Electron must be installed before running the UI test.');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'querydesk-ui-test-'));
  let application;
  let page;
  try {
    ({ application, page } = await launch(dataDir));
    assert.equal(await page.title(), 'EZ Bench');
    assert.ok((await page.locator('.brand').innerText()).includes('EZ Bench'));
    fs.mkdirSync(path.dirname(homeScreenshotPath), { recursive: true });
    await page.screenshot({ path: homeScreenshotPath });
    await page.locator('#demo-connect').click();
    await page.waitForFunction(() => document.querySelectorAll('#schema-tree .table-row').length === 3);
    assert.equal(await page.locator('#schema-tree .table-row').count(), 3);

    const join = 'SELECT c.name, COUNT(o.id) AS order_count, SUM(o.total) AS total FROM customers c JOIN orders o ON c.id = o.customer_id GROUP BY c.id ORDER BY total DESC';
    await runSql(page, join, '6');
    assert.equal(await page.locator('#result-table tbody tr').count(), 6);
    assert.ok((await page.locator('#result-table').innerText()).includes('Morgan Lee'));
    assert.ok((await page.locator('#result-table').innerText()).includes('420'));

    await page.locator('#result-table th').filter({ hasText: /^total(?:\s|$)/ }).click();
    assert.equal(await page.locator('#result-table tbody tr').first().locator('td').last().innerText(), '75');
    await page.locator('#result-table th').filter({ hasText: /^total(?:\s|$)/ }).click();
    assert.equal(await page.locator('#result-table tbody tr').first().locator('td').last().innerText(), '420');
    await page.locator('#result-filter').fill('Morgan');
    assert.equal(await page.locator('#result-table tbody tr').count(), 1);
    assert.ok((await page.locator('#result-table tbody tr').innerText()).includes('Morgan Lee'));
    await page.locator('#result-filter').fill('');
    assert.equal(await page.locator('#result-table tbody tr').count(), 6);

    await runSql(page, 'SELECT 1 AS x, 2 AS x', '1');
    assert.deepEqual(await page.locator('#result-table th').allTextContents(), ['#', 'x', 'x']);
    assert.deepEqual(await page.locator('#result-table tbody tr td').allTextContents(), ['1', '1', '2']);

    // These statements must reach the real SQLite sandbox rather than canned result data.
    await runSql(page, 'CREATE TABLE ui_check (id INTEGER PRIMARY KEY, note TEXT)', '0');
    await runSql(page, "INSERT INTO ui_check(note) VALUES ('first')", '1');
    await runSql(page, "UPDATE ui_check SET note='persisted' WHERE id=1", '1');
    await runSql(page, 'SELECT note FROM ui_check', '1');
    assert.ok((await page.locator('#result-table').innerText()).includes('persisted'));

    await runSql(page, 'SELECT * FROM missing_ui_test_table', 'no such table');
    assert.ok((await page.locator('#result-message').innerText()).includes('missing_ui_test_table'));
    const recoverySql = "SELECT 'recovered' AS status";
    await runSql(page, recoverySql, '1');
    assert.ok((await page.locator('#result-table').innerText()).includes('recovered'));

    await page.locator('#history-tab').click();
    await page.locator('#history-list .history-item').first().waitFor({ state: 'visible' });
    assert.ok(await page.locator('#history-list .history-item').count() >= 7);
    await page.locator('#history-list .history-item').first().click();
    assert.equal(await page.locator('#sql-editor').inputValue(), recoverySql);

    await page.locator('#results-tab').click();
    const beforeTabs = await page.locator('.query-tab').count();
    const firstTabSql = "SELECT 'tab-one' AS value";
    await page.locator('.query-tab').first().click();
    await page.locator('#sql-editor').fill(firstTabSql);
    await page.locator('#new-tab').click();
    assert.equal(await page.locator('.query-tab').count(), beforeTabs + 1);
    await page.locator('#sql-editor').fill("SELECT 'tab-two' AS value");
    await page.locator('.query-tab').first().click();
    assert.equal(await page.locator('#sql-editor').inputValue(), firstTabSql);

    const products = page.locator('#schema-tree .table-row').filter({ hasText: 'products' });
    await products.locator('button').first().click();
    await page.waitForFunction(() => document.querySelector('#sql-editor')?.value.toLowerCase().includes('products'));
    await page.waitForFunction(() => document.querySelectorAll('#result-table tbody tr').length === 6);
    assert.ok((await page.locator('#result-table').innerText()).includes('Mechanical Keyboard'));
    await products.locator('.table-info').click();
    await page.locator('#structure-panel').waitFor({ state: 'visible' });
    assert.ok((await page.locator('#structure-panel').innerText()).includes('category'));
    assert.ok((await page.locator('#structure-panel').innerText()).includes('PRIMARY'));
    assert.equal(await page.locator('#structure-panel tr').count(), 6);

    await page.locator('#results-tab').click();
    await page.locator('#sql-editor').fill('WITH RECURSIVE counter(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM counter) SELECT sum(x) FROM counter');
    await page.locator('#run-query').click();
    await page.locator('#cancel-query').waitFor({ state: 'visible' });
    await page.waitForTimeout(150);
    assert.equal(await application.evaluate(() => 2 + 2), 4, 'The Electron main process must remain responsive during the query.');
    await page.locator('#cancel-query').click();
    await page.waitForFunction(() => document.querySelector('#result-message')?.textContent.toLowerCase().includes('cancelled'));
    assert.ok((await page.locator('#connection-status').innerText()).includes('reconnect'));
    await page.locator('#cancel-query').waitFor({ state: 'hidden' });
    await page.locator('#connections-list .connection-item').filter({ hasText: 'Local playground' }).click();
    await page.waitForFunction(() => document.querySelector('#connection-status')?.textContent.startsWith('Connected'));
    await runSql(page, 'SELECT 7 AS recovered_after_cancel', '1');
    assert.equal(await page.locator('#result-table tbody tr td').last().innerText(), '7');

    await page.locator('#results-tab').click();
    const previewSql = 'select c.name as customer, c.city, count(o.id) as orders, sum(o.total) as total_spent from customers c join orders o on c.id = o.customer_id group by c.id order by total_spent desc';
    await page.locator('#sql-editor').fill(previewSql);
    await page.locator('#format-sql').click();
    const formatted = await page.locator('#sql-editor').inputValue();
    assert.ok(formatted.includes('\n'), 'Format SQL should create a readable multiline query.');
    assert.ok((await page.locator('#syntax-highlight').textContent()).trim().length > 0);
    assert.ok(await page.locator('#syntax-highlight span').count() > 0, 'SQL syntax should be highlighted.');
    await page.locator('#run-query').click();
    await page.waitForFunction(() => document.querySelector('#result-message')?.textContent.includes('6 rows returned'));

    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 720));
    const smallWindow = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      controls: ['#run-query', '#format-sql', '#workspace-menu', '#results-tab', '#result-message'].map(selector => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { selector, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      }),
    }));
    assert.ok(smallWindow.documentWidth <= smallWindow.width + 1, 'Minimum window must not overflow horizontally.');
    assert.ok(smallWindow.documentHeight <= smallWindow.height + 1, 'Minimum window must not overflow vertically.');
    for (const control of smallWindow.controls) assert.ok(control.left >= 0 && control.right <= smallWindow.width + 1 && control.top >= 0 && control.bottom <= smallWindow.height + 1, `Control should fit the minimum window: ${control.selector}`);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 940));
    await page.locator('#sql-editor').evaluate(editor => { editor.scrollLeft = 0; editor.scrollTop = 0; });
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath });

    await workspaceAction(page,'new-connection');
    const connectionDialog = page.locator('#connection-dialog');
    await connectionDialog.waitFor({ state: 'visible' });
    await connectionDialog.locator('[name="name"]').fill('Integration local');
    await connectionDialog.locator('[name="host"]').fill('127.0.0.1');
    await connectionDialog.locator('[name="port"]').fill('3306');
    await connectionDialog.locator('[name="user"]').fill('tester');
    await connectionDialog.locator('[name="password"]').fill('ui-test-secret-never-persist');
    await connectionDialog.locator('[name="database"]').fill('test_db');
    await connectionDialog.locator('[name="tls"]').check();
    await page.locator('#save-connection').click();
    await connectionDialog.waitFor({ state: 'hidden' });
    const storedProfiles = fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8');
    assert.equal(storedProfiles.includes('ui-test-secret-never-persist'), false);
    assert.equal(storedProfiles.includes('password'), false);
    assert.equal(JSON.parse(storedProfiles)[0].name, 'Integration local');
    assert.equal(JSON.parse(storedProfiles)[0].tls, true);

    await application.close();
    application = null;
    ({ application, page } = await launch(dataDir));
    await page.locator('#demo-connect').click();
    await page.waitForFunction(() => document.querySelectorAll('#schema-tree .table-row').length >= 4);
    await runSql(page, 'SELECT note FROM ui_check WHERE id=1', '1');
    assert.ok((await page.locator('#result-table').innerText()).includes('persisted'));
    await page.locator('#history-tab').click();
    await page.locator('#history-list .history-item').first().waitFor({ state: 'visible' });
    assert.ok(await page.locator('#history-list .history-item').count() >= 9);
    const persistedProfiles = JSON.parse(fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8'));
    assert.equal(persistedProfiles[0].name, 'Integration local');
    assert.equal(persistedProfiles[0].tls, true);
    assert.ok(fs.existsSync(screenshotPath));
  } finally {
    if (application) await application.close();
    const resolvedDir = path.resolve(dataDir);
    const resolvedTemp = path.resolve(os.tmpdir());
    assert.ok(resolvedDir.startsWith(resolvedTemp + path.sep) && path.basename(resolvedDir).startsWith('querydesk-ui-test-'));
    fs.rmSync(resolvedDir, { recursive: true, force: true });
  }
});

test('local database UI creates and reopens real files and reports refused MySQL connections', { timeout: 120000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'querydesk-ui-test-'));
  const filePath = path.join(dataDir, 'notes.sqlite');
  let application;
  try {
    const launched = await launch(dataDir);
    application = launched.application;
    const page = launched.page;
    await application.evaluate(({ dialog }, selectedPath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: selectedPath });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
    }, filePath);

    // Only the native picker is substituted. Profile save, connection and SQL use production handlers.
    await page.locator('#create-local').click();
    await page.locator('#editor-view').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#run-query').disabled);
    assert.equal(await page.locator('#schema-tree .table-row').count(), 0);
    assert.equal(await page.locator('#dialect-badge').innerText(), 'SQLite');
    assert.ok(fs.existsSync(filePath));
    await runSql(page, 'CREATE TABLE notes (id INTEGER PRIMARY KEY, message TEXT)', '0');
    await runSql(page, "INSERT INTO notes VALUES (1, 'Saved to my local file')", '1');
    await runSql(page, 'SELECT * FROM notes', '1');
    assert.ok((await page.locator('#result-table').innerText()).includes('Saved to my local file'));
    assert.ok(fs.readFileSync(filePath).subarray(0, 16).equals(Buffer.from('SQLite format 3\0')));

    await page.locator('#disconnect').click();
    await page.locator('#home-view').waitFor({ state: 'visible' });
    await page.locator('.connection-card').filter({ hasText: 'notes.sqlite' }).click();
    await page.locator('#editor-view').waitFor({ state: 'visible' });
    await runSql(page, 'SELECT message FROM notes WHERE id=1', '1');
    assert.ok((await page.locator('#result-table').innerText()).includes('Saved to my local file'));
    await page.locator('#disconnect').click();
    await page.locator('#home-view').waitFor({ state: 'visible' });
    await page.locator('#home-open-local').click();
    await page.locator('#editor-view').waitFor({ state: 'visible' });
    await runSql(page, 'SELECT COUNT(*) AS note_count FROM notes', '1');
    assert.equal(await page.locator('#result-table tbody tr td').last().innerText(), '1');
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8'));
    assert.ok(stored.some(profile => profile.mode === 'sqlite' && profile.filePath === filePath));

    await page.locator('#disconnect').click();
    await page.locator('#home-view').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Remove profile notes.sqlite', exact: true }).click();
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('.remove-profile')).some(button => button.getAttribute('aria-label') === 'Remove profile notes.sqlite'));
    assert.ok(fs.existsSync(filePath), 'Removing a saved profile must preserve the SQLite database.');
    assert.ok(!JSON.parse(fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8')).some(profile => profile.filePath === filePath));
    await workspaceAction(page,'open-local');
    await page.locator('#editor-view').waitFor({ state: 'visible' });
    await runSql(page, 'SELECT message FROM notes WHERE id=1', '1');
    assert.ok((await page.locator('#result-table').innerText()).includes('Saved to my local file'));

    await workspaceAction(page,'new-connection');
    const connectionDialog = page.locator('#connection-dialog');
    await connectionDialog.locator('[name="name"]').fill('Refused local MySQL test');
    await connectionDialog.locator('[name="host"]').fill('127.0.0.1');
    await connectionDialog.locator('[name="port"]').fill('65534');
    await connectionDialog.locator('[name="user"]').fill('test_user');
    await connectionDialog.locator('[name="password"]').fill('refusal-test-password');
    await page.locator('#connect-submit').click();
    await page.waitForFunction(() => document.querySelector('#connection-error')?.textContent.includes('ECONNREFUSED'));
    assert.equal((await page.locator('#connection-error').innerText()).includes('refusal-test-password'), false);
    assert.equal(fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8').includes('refusal-test-password'), false);
    await page.locator('#close-connection').click();
  } finally {
    if (application) await application.close();
    const resolvedDir = path.resolve(dataDir);
    const resolvedTemp = path.resolve(os.tmpdir());
    assert.ok(resolvedDir.startsWith(resolvedTemp + path.sep) && path.basename(resolvedDir).startsWith('querydesk-ui-test-'));
    fs.rmSync(resolvedDir, { recursive: true, force: true });
  }
});

test('first launch uses aligned SVG icons, graphite/copper themes, engine choices and working native menus', { timeout: 120000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'querydesk-ui-test-'));
  let application;
  try {
    const launched = await launch(dataDir);
    application = launched.application;
    const page = launched.page;
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    const logo=await page.locator('.brand-logo').evaluate(image=>({source:image.getAttribute('src'),loaded:image.complete&&image.naturalWidth>0,width:image.getBoundingClientRect().width,height:image.getBoundingClientRect().height}));
    assert.equal(logo.source,'icon.svg');assert.ok(logo.loaded);assert.equal(logo.width,34);assert.equal(logo.height,34);
    await page.locator('#workspace-menu').click();
    const visual = await page.evaluate(() => {
      const rgb = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g).slice(0, 3).map(Number);
      const icons = Array.from(document.querySelectorAll('.topbar button svg.icon, .settings-menu button svg.icon, .section-heading button svg.icon, .sidebar-home svg.icon, #theme-toggle svg.icon')).map(icon => {
        const rect = icon.getBoundingClientRect();
        const button = icon.closest('button').getBoundingClientRect();
        return { width: rect.width, height: rect.height, centerOffset: Math.abs(rect.top + rect.height / 2 - button.top - button.height / 2) };
      }).filter(icon => icon.width > 0 && icon.height > 0);
      return { rgb, icons, text: document.body.innerText };
    });
    assert.ok(Math.max(...visual.rgb) < 30, 'The default theme should be graphite dark.');
    assert.ok(visual.rgb[2] > visual.rgb[0], 'Midnight surfaces should carry a restrained blue tint.');
    assert.ok(visual.icons.length >= 6, 'The first launch should use real SVG control icons.');
    for (const icon of visual.icons) {
      assert.ok(icon.width >= 12 && icon.width <= 28 && Math.abs(icon.width - icon.height) < 1, 'Control icons should have consistent square boxes.');
      assert.ok(icon.centerOffset <= 3, 'Control icons should be vertically centered.');
    }
    assert.equal(/release notes|take a tour/i.test(visual.text), false);

    await page.keyboard.press('Escape');
    await workspaceAction(page,'theme-toggle');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await workspaceAction(page,'theme-toggle');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');

    await workspaceAction(page,'new-connection');
    const dialog = page.locator('#connection-dialog');
    const engine = page.locator('#connection-engine');
    assert.deepEqual(await engine.locator('option').evaluateAll(options => options.map(option => option.value)), ['mysql', 'mariadb', 'postgres', 'mssql', 'sqlite']);
    for (const [mode, port] of [['mysql', '3306'], ['mariadb', '3306'], ['postgres', '5432'], ['mssql', '1433']]) {
      await engine.selectOption(mode);
      assert.equal(await dialog.locator('[name="port"]').inputValue(), port);
      assert.equal(await page.locator('#network-fields').isVisible(), true);
    }
    await engine.selectOption('sqlite');
    assert.equal(await page.locator('#sqlite-fields').isVisible(), true);
    assert.equal(await page.locator('#network-fields').isVisible(), false);
    await page.locator('#close-connection').click();

    const menuLabels = await application.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map(item => item.label.replace(/&/g, '')));
    for (const label of ['File', 'Edit', 'View', 'Query', 'Database', 'Window', 'Help']) assert.ok(menuLabels.includes(label), 'Native menu should include ' + label);
    await page.locator('#demo-connect').click();
    await page.locator('#editor-view').waitFor({ state: 'visible' });
    const editorIcons = await page.evaluate(() => Array.from(document.querySelectorAll('.query-toolbar button svg.icon, .workspace-heading button svg.icon, .results-heading button svg.icon, .tabbar > button svg.icon')).map(icon => {
      const rect = icon.getBoundingClientRect();
      const button = icon.closest('button').getBoundingClientRect();
      return { width: rect.width, height: rect.height, centerOffset: Math.abs(rect.top + rect.height / 2 - button.top - button.height / 2) };
    }).filter(icon => icon.width > 0 && icon.height > 0));
    assert.ok(editorIcons.length >= 6, 'Editor controls should use the same SVG icon system.');
    for (const icon of editorIcons) {
      assert.ok(icon.width >= 12 && icon.width <= 28 && Math.abs(icon.width - icon.height) < 1);
      assert.ok(icon.centerOffset <= 3, 'Editor control icons should be vertically centered.');
    }
    const tabCount = await page.locator('.query-tab').count();
    await application.evaluate(({ Menu, BrowserWindow }) => {
      function find(menu) { for (const item of menu.items) { if (/new.*(?:query|sql|tab)/i.test(item.label)) return item; if (item.submenu) { const found = find(item.submenu); if (found) return found; } } }
      const item = find(Menu.getApplicationMenu());
      if (!item) throw new Error('Native new-query action is missing.');
      item.click(item, BrowserWindow.getAllWindows()[0], {});
    });
    await page.waitForFunction(expected => document.querySelectorAll('.query-tab').length === expected, tabCount + 1);
    assert.equal(await page.locator('.query-tab').count(), tabCount + 1);
    await workspaceAction(page,'theme-toggle');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await application.close();
    application = null;
    const restarted = await launch(dataDir);
    application = restarted.application;
    assert.equal(await restarted.page.locator('html').getAttribute('data-theme'), 'light', 'An explicitly selected theme should survive restart.');
  } finally {
    if (application) await application.close();
    const resolvedDir = path.resolve(dataDir);
    assert.ok(resolvedDir.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolvedDir).startsWith('querydesk-ui-test-'));
    fs.rmSync(resolvedDir, { recursive: true, force: true });
  }
});

test('database overview, scripts, rollback and connection tests work without disrupting the workspace', { timeout: 120000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'querydesk-ui-test-'));
  let application;
  try {
    const launched = await launch(dataDir);
    application = launched.application;
    const page = launched.page;
    await page.locator('#demo-connect').click();
    await page.locator('#editor-view').waitFor({ state: 'visible' });
    await page.locator('#database-tab').click();
    await page.locator('#database-panel').waitFor({ state: 'visible' });
    await page.waitForFunction(() => /sqlite/i.test(document.querySelector('#database-panel')?.textContent || ''));
    const info = await page.locator('#database-panel').innerText();
    assert.ok(/version/i.test(info));
    assert.ok(/3\.\d+/.test(info), 'Database overview should include a real SQLite version.');

    await page.locator('#results-tab').click();
    await page.locator('#sql-editor').fill("CREATE TABLE script_check (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO script_check VALUES (1, 'first'), (2, 'second'); SELECT COUNT(*) AS count FROM script_check;");
    await page.locator('#run-script').click();
    await page.waitForFunction(() => !document.querySelector('#run-script').disabled && document.querySelectorAll('#result-sets .result-set').length >= 3);
    await page.locator('#result-sets .result-set').last().click();
    assert.equal(await page.locator('#result-table tbody tr td').last().innerText(), '2');

    await page.locator('#begin-transaction').click();
    await page.waitForFunction(() => !document.querySelector('#run-query').disabled);
    await runSql(page, "INSERT INTO script_check VALUES (3, 'rolled back')", '1');
    await page.locator('#rollback-transaction').click();
    await page.waitForFunction(() => !document.querySelector('#run-query').disabled);
    await runSql(page, 'SELECT COUNT(*) AS count FROM script_check', '1');
    assert.equal(await page.locator('#result-table tbody tr td').last().innerText(), '2');

    await page.locator('#sql-editor').fill("INSERT INTO script_check VALUES (3, 'before failure'); SELECT * FROM missing_script_check; INSERT INTO script_check VALUES (4, 'must not run');");
    await page.locator('#run-script').click();
    await page.waitForFunction(() => !document.querySelector('#run-script').disabled && /missing_script_check|no such table/i.test(document.querySelector('#execution-log')?.textContent || document.querySelector('#result-message')?.textContent || ''));
    await runSql(page, 'SELECT COUNT(*) AS count FROM script_check', '1');
    assert.equal(await page.locator('#result-table tbody tr td').last().innerText(), '3', 'Stop-on-error must prevent later script statements from executing.');

    await workspaceAction(page,'new-connection');
    const dialog = page.locator('#connection-dialog');
    await page.locator('#connection-engine').selectOption('mysql');
    await dialog.locator('[name="name"]').fill('Connection test only');
    await dialog.locator('[name="host"]').fill('127.0.0.1');
    await dialog.locator('[name="port"]').fill('65534');
    await dialog.locator('[name="user"]').fill('test_user');
    await dialog.locator('[name="password"]').fill('connection-test-secret');
    await page.locator('#test-connection').click();
    await page.waitForFunction(() => /refused|failed|ECONNREFUSED/i.test(document.querySelector('#connection-test-result')?.textContent || document.querySelector('#connection-error')?.textContent || ''));
    assert.equal((await dialog.innerText()).includes('connection-test-secret'), false);
    await page.locator('#close-connection').click();
    assert.ok((await page.locator('#connection-status').innerText()).includes('Local playground'));
    await runSql(page, 'SELECT 9 AS still_connected', '1');
    assert.equal(await page.locator('#result-table tbody tr td').last().innerText(), '9');
    assert.equal(fs.existsSync(path.join(dataDir, 'profiles.json')), false, 'Testing alone should not persist a connection profile.');
  } finally {
    if (application) await application.close();
    const resolvedDir = path.resolve(dataDir);
    assert.ok(resolvedDir.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolvedDir).startsWith('querydesk-ui-test-'));
    fs.rmSync(resolvedDir, { recursive: true, force: true });
  }
});
