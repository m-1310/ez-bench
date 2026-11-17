'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { generateKeyPairSync, sign, createHash } = require('node:crypto');
const { UpdateService, configuration, secureUrl, verifyManifest, compareVersions, readManifest, downloadInstaller } = require('./update-service.cjs');

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const settings = { feedUrl: 'https://updates.example.test/latest.json', publicKey, downloadHosts: [] };
const bytes = Buffer.from('test-only installer bytes; never executed');
const release = { schema: 1, product: 'EZ Bench', version: '0.7.0', platform: 'win32', arch: 'x64', minimumWindowsBuild: 10240, url: 'https://updates.example.test/EZ-Bench-Setup-0.7.0.exe', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
function envelope(data = release, signer = keys.privateKey) { const payload = Buffer.from(JSON.stringify(data)); return { payload: payload.toString('base64'), signature: sign(null, payload, signer).toString('base64') }; }
function folder(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-update-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function service(t, transport = {}, options = {}) { return new UpdateService({ config: settings, currentVersion: '0.6.0', cacheDir: folder(t), platform: 'win32', arch: 'x64', windowsBuild: 19045, transport: { readManifest: async () => envelope(), downloadInstaller: async (_r, file, _h, _s, progress) => { fs.writeFileSync(file, bytes, { flag: 'wx' }); progress(bytes.length); }, ...transport }, ...options }); }
function fakeResponse(t, responses) {
  const calls = [];
  t.mock.method(https, 'get', (url, options, callback) => {
    calls.push({ url: url.href, options });
    const request = new EventEmitter();
    queueMicrotask(() => {
      const data = responses.shift();
      if (!data) return request.emit('error', new Error('Unexpected network request'));
      const response = Readable.from(data.chunks || [bytes]);
      response.statusCode = data.status || 200; response.headers = data.headers || {};
      callback(response);
    });
    return request;
  });
  return calls;
}

test('update versions compare numerically and reject prerelease, malformed and Windows-overflow versions', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('0.6.0', '0.6.0'), 0);
  assert.equal(compareVersions('0.5.0', '0.6.0'), -1);
  for (const invalid of ['1', '1.0.0-beta', '01.0.0', '65536.0.0', '1.0.0;calc']) assert.throws(() => compareVersions(invalid, '0.6.0'));
});

test('updates are inert until configured and on unsupported Windows/architectures', async t => {
  for (const options of [{ config: {} }, { platform: 'linux' }, { windowsBuild: 9600 }, { windowsBuild: NaN }, { arch: 'ia32' }, { arch: 'arm64' }]) {
    let calls = 0;
    const updater = service(t, { readManifest: async () => { calls++; } }, options);
    assert.equal((await updater.check()).phase, 'disabled'); assert.equal(calls, 0);
  }
  assert.equal(service(t, {}, { config: { feedUrl: settings.feedUrl, publicKey: 'invalid', downloadHosts: [] } }).status().phase, 'disabled');
});

test('HTTPS, host restrictions and Ed25519 key pinning reject unsafe release configuration', () => {
  for (const value of ['http://updates.example.test/x', 'https://user:pass@updates.example.test/x', 'file:///tmp/x', 'https://updates.example.test:8443/x', 'https://updates.example.test/x#secret']) assert.throws(() => secureUrl(value));
  assert.throws(() => secureUrl('https://other.example.test/setup.exe', new Set(['updates.example.test'])));
  const config = configuration({ ...settings, feedUrl: 'https://github.com/owner/repo/releases/latest/download/update.json' });
  assert.ok(config.hosts.has('release-assets.githubusercontent.com'));
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => configuration({ ...settings, publicKey: rsa.publicKey.export({ type: 'spki', format: 'pem' }) }), /Ed25519/);
  assert.throws(() => configuration({ ...settings, publicKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) }), /public key/);
});

test('signed manifests bind product, version, architecture, OS, size, hash and HTTPS download host', () => {
  const config = configuration(settings);
  assert.equal(verifyManifest(envelope(), config, '0.6.0', 19045).version, '0.7.0');
  assert.equal(verifyManifest(envelope(), config, '0.7.0', 19045), null);
  assert.equal(verifyManifest(envelope(), config, '0.8.0', 19045), null);
  const wrongKey = generateKeyPairSync('ed25519');
  assert.throws(() => verifyManifest(envelope(release, wrongKey.privateKey), config, '0.6.0', 19045), /signature/);
  const tampered = envelope(); tampered.payload = Buffer.from(JSON.stringify({ ...release, version: '9.0.0' })).toString('base64');
  assert.throws(() => verifyManifest(tampered, config, '0.6.0', 19045), /signature/);
  for (const fields of [{ product: 'Other' }, { arch: 'arm64' }, { platform: 'linux' }, { schema: 2 }, { bytes: 0 }, { bytes: 513 * 1024 * 1024 }, { sha256: 'wrong' }, { minimumWindowsBuild: 22000 }, { minimumWindowsBuild: 9600 }, { url: 'https://evil.example.test/setup.exe' }, { url: 'http://updates.example.test/setup.exe' }, { url: 'https://updates.example.test/file.zip' }]) assert.throws(() => verifyManifest(envelope({ ...release, ...fields }), config, '0.6.0', 19045));
});

test('manual update check, verified download, pre-install recheck and cleanup work together', async t => {
  const updater = service(t);
  assert.equal(updater.status().phase, 'idle');
  assert.equal((await updater.check()).phase, 'available');
  assert.equal((await updater.download()).phase, 'ready');
  const filename = await updater.installerPath();
  assert.deepEqual(fs.readFileSync(filename), bytes);
  fs.writeFileSync(filename, Buffer.alloc(bytes.length));
  await assert.rejects(updater.installerPath(), /changed/);
  assert.equal(updater.status().phase, 'error');
  assert.equal((await updater.download()).phase, 'ready');
  const replacement = await updater.installerPath();
  await updater.close(); assert.equal(fs.existsSync(replacement), false);
});

test('rechecking removes stale downloads and failed checks cannot install an earlier offer', async t => {
  let fail = false;
  const updater = service(t, { readManifest: async () => { if (fail) throw new Error('offline'); return envelope(); } });
  await updater.check(); await updater.download(); const filename = await updater.installerPath();
  fail = true;
  await assert.rejects(updater.check(), /offline/);
  assert.equal(fs.existsSync(filename), false);
  await assert.rejects(updater.installerPath(), /Download/);
  await assert.rejects(updater.download(), /Check/);
});

test('overlapping checks are rejected and cancellation leaves the updater retryable', async t => {
  let began;
  const ready = new Promise(resolve => { began = resolve; });
  const updater = service(t, { readManifest: (_url, _hosts, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); began(); }) });
  const pending = updater.check(); await ready;
  await assert.rejects(updater.check(), /already running/);
  updater.cancel(); await assert.rejects(pending, /cancelled/);
  assert.equal(updater.active, null); assert.equal(updater.status().phase, 'error');
});

test('failed installer verification removes partial files and a later download succeeds', async t => {
  const updater = service(t, { downloadInstaller: async (_r, file) => { fs.writeFileSync(file, 'bad'); } });
  await updater.check(); await assert.rejects(updater.download(), /changed/);
  assert.deepEqual(fs.readdirSync(updater.cacheDir), []);
  updater.transport.downloadInstaller = async (_r, file) => { fs.writeFileSync(file, bytes); };
  await updater.download(); await updater.close(); assert.deepEqual(fs.readdirSync(updater.cacheDir), []);
});

test('network download streams exact bytes, checks SHA-256 and refuses overwrite', async t => {
  const dir = folder(t), file = path.join(dir, 'setup.exe'), hosts = new Set(['updates.example.test']);
  fakeResponse(t, [{ chunks: [bytes.subarray(0, 5), bytes.subarray(5)] }, {}, {}]);
  await downloadInstaller(release, file, hosts, new AbortController().signal, () => {});
  assert.deepEqual(fs.readFileSync(file), bytes);
  await assert.rejects(downloadInstaller(release, file, hosts, new AbortController().signal, () => {}), /exist/i);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('network download removes truncated, oversized and wrong-hash bodies', async t => {
  const dir = folder(t), hosts = new Set(['updates.example.test']);
  fakeResponse(t, [{ chunks: [bytes.subarray(0, 2)] }, { chunks: [Buffer.concat([bytes, bytes])] }, { chunks: [Buffer.alloc(bytes.length)] }, { headers: { 'content-length': '2' } }]);
  for (let i = 0; i < 4; i++) {
    const file = path.join(dir, i + '.exe');
    await assert.rejects(downloadInstaller(release, file, hosts, new AbortController().signal, () => {}), /size|SHA-256|exceeds/);
    assert.equal(fs.existsSync(file), false);
  }
});

test('manifest requests enforce HTTPS across redirects, success status, encoding and response bound', async t => {
  const hosts = new Set(['updates.example.test']);
  const calls = fakeResponse(t, [{ status: 302, headers: { location: '/stable.json' } }, { chunks: [Buffer.from(JSON.stringify(envelope()))] }, { status: 302, headers: { location: 'http://updates.example.test/file' } }, { status: 302, headers: { location: 'https://evil.example.test/file' } }, { status: 404 }, { headers: { 'content-encoding': 'gzip' } }, { chunks: [Buffer.alloc(65537)] }]);
  assert.ok((await readManifest(settings.feedUrl, hosts, new AbortController().signal)).signature);
  assert.equal(calls[1].url, 'https://updates.example.test/stable.json');
  for (let i = 0; i < 5; i++) await assert.rejects(readManifest(settings.feedUrl, hosts, new AbortController().signal));
  assert.equal(calls.length, 7);
});

test('release signer produces a manifest accepted by the same public key without publishing', async t => {
  const { createManifest, createKey } = require('../scripts/update-release.cjs');
  const dir = folder(t), installer = path.join(dir, 'setup.exe'), key = path.join(dir, 'signer.key'), pub = path.join(dir, 'signer.pub'), output = path.join(dir, 'update.json');
  createKey(key, pub); fs.writeFileSync(installer, bytes);
  await createManifest({ installer, url: release.url, privateKeyPath: key, version: release.version, output });
  const config = configuration({ ...settings, publicKey: fs.readFileSync(pub, 'utf8') });
  assert.equal(verifyManifest(JSON.parse(fs.readFileSync(output, 'utf8')), config, '0.6.0', 19045).sha256, release.sha256);
  assert.ok(fs.existsSync(output + '.sha256'));
  await assert.rejects(createManifest({ installer, url: release.url, privateKeyPath: key, version: release.version, output }), /exists/);
  assert.throws(() => createKey(key, pub), /new/);
});
