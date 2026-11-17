'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { normalizeSsh, inspectHostKey, openSshTunnel } = require('./ssh-tunnel.cjs');
const { createSshFixture } = require('./ssh-fixture.cjs');
const { DatabaseService } = require('./database.cjs');

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ezbench-ssh-unit-'));
  const targetSockets = new Set();
  const echo = net.createServer(socket => { targetSockets.add(socket); socket.on('error', () => {}); socket.once('close', () => targetSockets.delete(socket)); socket.pipe(socket); });
  await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
  const targetPort = echo.address().port;
  const fixture = await createSshFixture({ directory, ports: [targetPort] });
  const tunnels = [], services = [];
  t.after(async () => {
    for (const service of services) await service.close();
    for (const tunnel of tunnels) await tunnel.close();
    await fixture.close();
    for (const socket of targetSockets) socket.destroy();
    await new Promise(resolve => echo.close(resolve));
    assert.ok(path.basename(directory).startsWith('ezbench-ssh-unit-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, fixture, targetPort, tunnels, services };
}
async function echoMessage(socket, message) {
  let timer;
  try {
    return await Promise.race([
      new Promise((resolve, reject) => { socket.once('error', reject); socket.once('data', data => { socket.end(); resolve(data.toString()); }); socket.write(message); }),
      new Promise((resolve, reject) => { timer = setTimeout(() => { socket.destroy(); reject(new Error('Echo timed out')); }, 5000); }),
    ]);
  } finally { clearTimeout(timer); socket.destroy(); }
}

test('SSH settings require explicit enablement, valid endpoints, auth method and a SHA256 pin', () => {
  assert.equal(normalizeSsh(undefined), null);
  assert.equal(normalizeSsh({ enabled: false }), null);
  const base = { enabled: true, host: '::1', port: 22, user: 'fixture', hostFingerprint: 'SHA256:' + 'a'.repeat(43), authMethod: 'password', password: 'do-not-return' };
  assert.equal(normalizeSsh(base).host, '::1');
  assert.equal(Object.hasOwn(normalizeSsh(base), 'password'), false);
  assert.throws(() => normalizeSsh({ ...base, hostFingerprint: '' }), /Verify and trust/);
  assert.throws(() => normalizeSsh({ ...base, authMethod: 'agent' }), /password or private key/);
  assert.throws(() => normalizeSsh({ ...base, port: 0 }), /SSH port/);
  assert.throws(() => normalizeSsh({ ...base, host: 'host\0invalid' }), /SSH host/);
});

test('host key probing reports the real key without authenticating or opening a forwarding channel', async t => {
  const { fixture } = await setup(t);
  const info = await inspectHostKey({ ssh: { host: fixture.host, port: fixture.port } });
  assert.equal(info.fingerprint, fixture.fingerprint);
  assert.equal(info.algorithm, 'ssh-rsa');
  assert.deepEqual(fixture.attempts, []);
  assert.deepEqual(fixture.forwards, []);
});

test('password tunnel binds only ephemeral IPv4 loopback and resolves database hosts on the SSH endpoint', async t => {
  const { fixture, targetPort, tunnels } = await setup(t);
  const tunnel = await openSshTunnel(fixture.passwordOptions(), { host: fixture.remoteHost, port: targetPort }); tunnels.push(tunnel);
  assert.equal(tunnel.host, '127.0.0.1'); assert.ok(tunnel.port > 0);
  assert.equal(await echoMessage(tunnel.socket(), "quote ' ; नमस्ते"), "quote ' ; नमस्ते");
  assert.equal(await echoMessage(tunnel.socket(), 'second connection'), 'second connection');
  assert.equal(fixture.forwards.length, 2);
  assert.ok(fixture.forwards.every(item => item.host === fixture.remoteHost && item.port === targetPort));
  const oldPort = tunnel.port;
  await tunnel.close();
  await assert.rejects(new Promise((resolve, reject) => { const socket = net.connect(oldPort, '127.0.0.1'); socket.once('error', reject); socket.once('connect', () => { socket.destroy(); resolve(); }); }), /ECONNREFUSED/);
});

test('encrypted private key authentication forwards real bytes and never returns its passphrase', async t => {
  const { fixture, targetPort, tunnels } = await setup(t);
  const options = fixture.keyOptions();
  const tunnel = await openSshTunnel(options, { host: fixture.remoteHost, port: targetPort }); tunnels.push(tunnel);
  assert.equal(await echoMessage(tunnel.socket(), 'key authenticated'), 'key authenticated');
  assert.equal(Object.hasOwn(tunnel.settings, 'passphrase'), false);
  assert.equal(Object.hasOwn(tunnel.settings, 'privateKey'), false);
  assert.ok(fixture.attempts.some(item => item.method === 'publickey'));
});

test('untrusted and changed keys fail before auth, bad credentials are redacted, and invalid key files fail clearly', async t => {
  const { fixture, targetPort, directory } = await setup(t);
  const destination = { host: fixture.remoteHost, port: targetPort };
  await assert.rejects(openSshTunnel({ ...fixture.passwordOptions(), hostFingerprint: '' }, destination), /Verify and trust/);
  await assert.rejects(openSshTunnel({ ...fixture.passwordOptions(), hostFingerprint: 'SHA256:' + 'A'.repeat(43) }, destination), /does not match/);
  assert.equal(fixture.attempts.length, 0);
  const bad = 'private-ssh-password-do-not-log';
  await assert.rejects(openSshTunnel({ ...fixture.passwordOptions(), password: bad }, destination), error => /authentication|Authentication/.test(error.message) && !error.message.includes(bad));
  const invalidKey = path.join(directory, 'invalid.key'); fs.writeFileSync(invalidKey, 'not a private key');
  await assert.rejects(openSshTunnel({ ...fixture.keyOptions(), privateKeyPath: invalidKey }, destination), /could not be unlocked/);
});

test('unexpected SSH shutdown marks the tunnel failed and tears down its listener and sockets', async t => {
  const { fixture, targetPort, tunnels } = await setup(t);
  const tunnel = await openSshTunnel(fixture.passwordOptions(), { host: fixture.remoteHost, port: targetPort }); tunnels.push(tunnel);
  assert.equal(await echoMessage(tunnel.socket(), 'alive'), 'alive');
  fixture.disconnectClients();
  await new Promise((resolve, reject) => { const deadline = Date.now() + 3000; const check = () => tunnel.failed ? resolve() : Date.now() > deadline ? reject(new Error('Failed transport was not detected')) : setTimeout(check, 10); check(); });
  assert.throws(() => tunnel.socket(), /Reconnect/);
});

test('MySQL SSH socket routing retains the original TLS hostname and sanitized connection metadata', async t => {
  const { fixture, targetPort, directory, services } = await setup(t);
  let configuration;
  const db = new DatabaseService({ dataDir: directory, drivers: { mysql: { async createConnection(options) { configuration = options; return { query: async () => [[], []], on() {}, end: async () => {} }; } } } }); services.push(db);
  await db.connect({ mode: 'mysql', host: fixture.remoteHost, port: targetPort, user: 'db-fixture', password: 'db-only-password', database: 'fixture', tls: true, ssh: fixture.passwordOptions() });
  assert.equal(configuration.host, fixture.remoteHost);
  assert.equal(configuration.ssl.rejectUnauthorized, true);
  assert.equal(configuration.ssl.verifyIdentity, true);
  assert.equal(await echoMessage(configuration.stream(), 'driver route'), 'driver route');
  assert.equal(db.connectionInfo.host, fixture.remoteHost);
  assert.equal(db.connectionInfo.ssh.hostFingerprint, fixture.fingerprint);
  assert.equal(JSON.stringify(db.connectionInfo).includes(fixture.passwordOptions().password), false);
  await assert.rejects(db.transferInfo(), /cannot preserve database TLS hostname/);
});

test('PostgreSQL SSH stream preserves the real TLS hostname while connecting only to the local tunnel', async t => {
  const { fixture, targetPort, directory, services } = await setup(t);
  let configuration;
  class MockClient { constructor(options) { configuration = options; } on() {} async connect() {} async end() {} }
  const db = new DatabaseService({ dataDir: directory, drivers: { postgres: { Client: MockClient } } }); services.push(db);
  await db.connect({ mode: 'postgres', host: fixture.remoteHost, port: targetPort, user: 'db-fixture', password: 'db-only-password', database: 'fixture', tls: true, ssh: fixture.passwordOptions() });
  assert.equal(configuration.host, fixture.remoteHost);
  assert.equal(configuration.ssl.rejectUnauthorized, true);
  const stream = configuration.stream(); stream.connect(targetPort, fixture.remoteHost);
  assert.equal(await echoMessage(stream, 'pg route'), 'pg route');
});

test('SQL Server SSH connector retains TLS identity and rejects unexpected redirected endpoints', async t => {
  const { fixture, targetPort, directory, services } = await setup(t);
  let configuration;
  class MockPool { constructor(options) { configuration = options; } on() {} async connect() {} async close() {} }
  const db = new DatabaseService({ dataDir: directory, drivers: { mssql: { ConnectionPool: MockPool } } }); services.push(db);
  await db.connect({ mode: 'mssql', host: fixture.remoteHost, port: targetPort, user: 'db-fixture', database: 'fixture', tls: true, ssh: fixture.passwordOptions() });
  assert.equal(configuration.server, fixture.remoteHost);
  assert.equal(configuration.options.serverName, fixture.remoteHost);
  assert.equal(configuration.options.trustServerCertificate, false);
  const stream = await configuration.options.connector({ host: fixture.remoteHost, port: targetPort });
  assert.equal(await echoMessage(stream, 'tds route'), 'tds route');
  await assert.rejects(configuration.options.connector({ host: 'redirected.example', port: targetPort }), /redirected/);
});

test('failed SSH forwarding closes the failed database workspace and listener', async t => {
  const { fixture, targetPort, directory, services } = await setup(t);
  const db = new DatabaseService({ dataDir: directory }); services.push(db);
  await assert.rejects(db.connect({ mode: 'mysql', host: 'forbidden.fixture', port: targetPort, user: 'fixture', ssh: fixture.passwordOptions() }), /SSH|prohibited|denied|failure/i);
  assert.equal(db.connection, null); assert.equal(db._tunnel, null);
  await assert.rejects(db.query({ sql: 'SELECT 1' }), /Connect to a database/);
});
