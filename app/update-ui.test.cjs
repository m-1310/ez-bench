'use strict';
const {workspaceAction}=require('./ui-actions.cjs');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { _electron } = require('playwright');
const executablePath = process.env.WORK_EZ_BENCH_EXECUTABLE || path.join(__dirname, 'node_modules/electron/dist/electron.exe');

test('desktop update dialog opens the Git guide, verifies signed offers and blocks connected installs', { timeout: 60000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-update-ui-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({ executablePath, args: [__dirname, '--data-dir=' + dataDir], env });
  const errors = [];
  try {
    const { currentVersion, isPackaged } = await application.evaluate(({ app }) => ({ currentVersion: app.getVersion(), isPackaged: app.isPackaged }));
    const nextVersion = (Number(currentVersion.split('.')[0]) + 1) + '.0.0';
    const page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('#demo-connect').waitFor();
    await workspaceAction(page,'check-updates');
    assert.ok((await page.locator('#update-current').innerText()).includes(currentVersion));
    assert.ok((await page.locator('#update-current').innerText()).includes('Windows 10+'));
    const guide = page.getByRole('button', { name: 'View Git update instructions' });
    if (isPackaged) {
      assert.equal(await guide.isVisible(), false);
      assert.equal(await page.locator('#update-check').isVisible(), true);
    } else {
      assert.match(await page.locator('#update-message').innerText(), /update from Git/);
      assert.equal(await page.locator('#update-check').isVisible(), false);
      assert.equal(await page.locator('#update-package-note').isVisible(), false);
      await application.evaluate(({ shell }) => {
        globalThis.openedGitGuide = new Promise(resolve => {
          shell.openExternal = async url => { resolve(url); };
        });
      });
      await guide.click();
      assert.equal(await application.evaluate(() => globalThis.openedGitGuide), 'https://github.com/m-1310/ez-bench#update-a-git-installation');
    }
    await page.locator('#update-close').click();
    // Exercise real IPC, service signature validation and file verification using
    // an isolated test-only transport. Never launch a setup executable.
    await application.evaluate(({ app }, version) => {
      if (!app.isPackaged) Object.defineProperty(app, 'isPackaged', { value: true });
      const require = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json');
      const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
      const module = require(path.join(app.getAppPath(), 'update-service.cjs'));
      const keys = crypto.generateKeyPairSync('ed25519');
      const bytes = Buffer.from('test-only bytes, not a Windows program');
      const data = { schema: 1, product: 'EZ Bench', version, platform: 'win32', arch: 'x64', minimumWindowsBuild: 10240, url: 'https://updates.example.test/setup.exe', bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
      const payload = Buffer.from(JSON.stringify(data));
      const envelope = { payload: payload.toString('base64'), signature: crypto.sign(null, payload, keys.privateKey).toString('base64') };
      const original = module.UpdateService.prototype.check;
      module.UpdateService.prototype.check = function () {
        this.config = module.configuration({ feedUrl: 'https://updates.example.test/update.json', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), downloadHosts: [] });
        this.state.phase = 'idle';
        this.transport = { readManifest: async () => envelope, downloadInstaller: async (_r, file, _hosts, _signal, progress) => { fs.writeFileSync(file, bytes, { flag: 'wx' }); progress(bytes.length); } };
        return original.call(this);
      };
      const originalStatus = module.UpdateService.prototype.status;
      module.UpdateService.prototype.status = function () { const state = originalStatus.call(this); return state.phase === 'disabled' ? { ...state, phase: 'idle' } : state; };
    }, nextVersion);
    await workspaceAction(page,'check-updates');
    await page.locator('#update-check').click();
    await page.locator('#update-download').waitFor({ state: 'visible' });
    assert.ok((await page.locator('#update-version').innerText()).includes(nextVersion));
    await page.locator('#update-download').click();
    await page.locator('#update-install').waitFor({ state: 'visible' });
    assert.ok((await page.locator('#update-message').innerText()).includes('Installer verified'));
    assert.equal(await page.locator('#update-reveal').isVisible(), true);
    await page.locator('#update-close').click();
    await page.locator('#demo-connect').click();
    await page.waitForFunction(() => !document.querySelector('#run-query').disabled && document.querySelector('#connection-status').textContent.includes('Local playground'));
    await workspaceAction(page,'check-updates');
    await page.locator('#update-install').click();
    assert.ok((await page.locator('#update-error').innerText()).includes('disconnect'));
    assert.match(await page.evaluate(async () => { try { await window.querydesk.installUpdate(); return 'unexpected'; } catch (error) { return error.message; } }), /disconnect/);
    await page.locator('#update-close').click();
    // No idle polling is installed after closing the dialog.
    const menu = await application.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => item.label.replace(/&/g, '') === 'Help').submenu.items.map(item => item.label));
    assert.ok(menu.includes('Check for updates…'));
    fs.mkdirSync(path.resolve(__dirname, '../evidence'), { recursive: true });
    await workspaceAction(page,'check-updates');
    await page.screenshot({ path: path.resolve(__dirname, '../evidence/ez-bench-0.6-updates.png') });
    await page.locator('#update-close').click();
    await page.locator('#disconnect').click();
    await page.locator('#demo-connect').waitFor();
    await application.evaluate(({ Menu, BrowserWindow }) => {
      const results = Menu.getApplicationMenu().getMenuItemById('results-tab');
      results.click(results, BrowserWindow.getAllWindows()[0]);
    });
    await page.locator('#private-query').check();
    await page.locator('#sql-editor').fill('SELECT 1 AS private_update_fixture');
    await application.evaluate(({ dialog }) => {
      const { promise, resolve } = Promise.withResolvers();
      globalThis.updatePrompt = promise;
      dialog.showMessageBox = async (_window, options) => { resolve(options); return { response: 0 }; };
    });
    await workspaceAction(page,'check-updates');
    await page.locator('#update-install').click();
    const warning = await application.evaluate(() => globalThis.updatePrompt);
    assert.equal(warning.title, 'Unsaved work');
    assert.match(warning.detail, /Private or credential-bearing SQL/);
    assert.doesNotMatch(fs.readFileSync(path.join(dataDir, 'workspace.json'), 'utf8'), /private_update_fixture/);
    assert.deepEqual(errors, []);
  } finally {
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    await application.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
