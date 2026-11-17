'use strict';
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client, utils } = require('ssh2');

function string(value, label, optional = false) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0')) throw new Error('Enter a valid ' + label + '.');
  return value.trim();
}
function port(value, fallback) {
  const checked = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(checked) || checked < 1 || checked > 65535) throw new Error('SSH port must be an integer from 1 to 65535.');
  return checked;
}
function endpoint(options = {}) {
  return { host: string(options.host, 'SSH host'), port: port(options.port, 22) };
}
function normalizeSsh(options) {
  if (options === undefined || options === null || options.enabled === false) return null;
  if (!options || typeof options !== 'object' || Array.isArray(options) || options.enabled !== true) throw new Error('SSH must be explicitly enabled or disabled.');
  const address = endpoint(options), user = string(options.user, 'SSH user');
  const authMethod = options.authMethod || 'password';
  if (!['password', 'key'].includes(authMethod)) throw new Error('Choose SSH password or private key authentication.');
  const hostFingerprint = string(options.hostFingerprint, 'SSH host fingerprint', true).replace(/=+$/, '');
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(hostFingerprint)) throw new Error('Verify and trust the SSH host key before connecting.');
  const settings = { enabled: true, ...address, user, authMethod, hostFingerprint };
  if (authMethod === 'key') {
    const privateKeyPath = string(options.privateKeyPath, 'SSH private key path');
    if (!path.isAbsolute(privateKeyPath)) throw new Error('Choose an absolute SSH private key file path.');
    settings.privateKeyPath = privateKeyPath;
  }
  return settings;
}
function fingerprint(key) { return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, ''); }
function algorithm(key) {
  if (!Buffer.isBuffer(key) || key.length < 4) return 'unknown';
  const length = key.readUInt32BE(0);
  return length > 0 && length < 100 && length + 4 <= key.length ? key.subarray(4, length + 4).toString('ascii') : 'unknown';
}
function redact(message, secrets = []) {
  let text = String(message || 'SSH connection failed.');
  for (const secret of secrets) if (typeof secret === 'string' && secret) text = text.split(secret).join('[redacted]');
  return text.slice(0, 2000);
}
function inspectHostKey({ ssh } = {}) {
  const address = endpoint(ssh);
  return new Promise((resolve, reject) => {
    const client = new Client(); let observed = null, finished = false;
    const finish = error => {
      if (finished) return; finished = true; clearTimeout(timer); client.destroy();
      if (observed) resolve(observed); else reject(new Error('Could not read SSH host key: ' + (error?.message || 'The connection closed.')));
    };
    const timer = setTimeout(() => finish(new Error('SSH handshake timed out.')), 10000);
    client.on('error', finish); client.on('close', () => finish());
    // Rejecting at host verification prevents authentication or commands. This
    // reports an observation; only the application user can choose to trust it.
    try { client.connect({ ...address, username: 'ezbench-host-key-probe', readyTimeout: 10000, hostVerifier: key => { observed = { ...address, fingerprint: fingerprint(key), algorithm: algorithm(key) }; return false; } }); }
    catch (error) { finish(error); }
  });
}

async function openSshTunnel(options, destination) {
  const settings = normalizeSsh(options);
  if (!settings) throw new Error('Enable SSH tunneling first.');
  const destinationHost = string(destination?.host, 'database host'), destinationPort = port(destination?.port, 3306);
  const secrets = [options.password, options.passphrase];
  let privateKey;
  if (settings.authMethod === 'key') {
    let stat;
    try { stat = fs.statSync(settings.privateKeyPath); } catch { throw new Error('The SSH private key file could not be read.'); }
    if (!stat.isFile() || stat.size > 1024 * 1024 || !stat.size) throw new Error('Choose a private key file smaller than 1 MB.');
    try { privateKey = fs.readFileSync(settings.privateKeyPath); } catch { throw new Error('The SSH private key file could not be read.'); }
    const parsed = utils.parseKey(privateKey, options.passphrase || undefined);
    if (parsed instanceof Error) throw new Error('The SSH private key could not be unlocked. Check its format and passphrase.');
  } else if (typeof options.password !== 'string') throw new Error('Enter the SSH password for this session.');
  if (options.passphrase !== undefined && typeof options.passphrase !== 'string') throw new Error('Enter a valid SSH key passphrase.');

  const client = new Client(), sockets = new Set(), channels = new Set();
  let closing = false, ready = false, observed = null, timer;
  const tunnel = {
    host: '127.0.0.1', port: null, settings, failed: false, failure: null,
    socket(signal) {
      if (closing || tunnel.failed) throw new Error('SSH tunnel closed. Reconnect to continue.');
      return net.connect({ host: tunnel.host, port: tunnel.port, ...(signal ? { signal } : {}) });
    },
    async close() {
      if (closing) return;
      closing = true;
      for (const socket of sockets) socket.destroy();
      for (const channel of channels) channel.destroy();
      sockets.clear(); channels.clear();
      const closed = new Promise(resolve => { if (!server.listening) resolve(); else server.close(resolve); });
      client.destroy();
      await closed;
    },
  };
  const failTransport = error => {
    if (closing) return;
    tunnel.failed = true;
    tunnel.failure = redact(error?.message || 'SSH connection closed.', secrets);
    // Closing a failed transport never silently reconnects or resumes writes.
    tunnel.close().catch(() => {});
  };
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
    if (!ready || closing || tunnel.failed) { socket.destroy(); return; }
    socket.pause();
    client.forwardOut('127.0.0.1', socket.remotePort || 0, destinationHost, destinationPort, (error, channel) => {
      if (error || closing) { if (error) tunnel.forwardFailure = redact(error.message, secrets); channel?.destroy(); socket.destroy(); return; }
      channels.add(channel); channel.on('error', () => socket.destroy());
      channel.once('close', () => { channels.delete(channel); socket.destroy(); });
      socket.once('close', () => channel.destroy());
      socket.pipe(channel).pipe(socket); socket.resume();
    });
  });
  server.on('error', failTransport);
  // An SSH close can race with server.listen() before Node publishes its local
  // address. Never leave a listener behind after that asynchronous transition.
  server.on('listening', () => { if (closing && server.listening) server.close(); });
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (error) reject(new Error(redact(error.message, secrets))); else resolve();
      };
      timer = setTimeout(() => finish(new Error('SSH connection timed out.')), 12000);
      client.on('error', error => { if (!ready) finish(error); else failTransport(error); });
      client.on('close', () => { if (!ready) finish(new Error('SSH connection closed before authentication completed.')); else failTransport(); });
      client.once('ready', () => { ready = true; finish(); });
      const configuration = { host: settings.host, port: settings.port, username: settings.user, readyTimeout: 10000, keepaliveInterval: 15000, keepaliveCountMax: 3,
        hostVerifier: key => { observed = fingerprint(key); return observed === settings.hostFingerprint; },
        ...(settings.authMethod === 'key' ? { privateKey, passphrase: options.passphrase || undefined } : { password: options.password }),
      };
      try { client.connect(configuration); } catch (error) { finish(error); }
    });
    if (closing || tunnel.failed) throw new Error('SSH tunnel closed before opening the local listener.');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => { server.removeListener('error', reject); resolve(); }); });
    const address = server.address();
    if (closing || tunnel.failed || !address) throw new Error('SSH tunnel closed while opening the local listener.');
    tunnel.port = address.port;
    return tunnel;
  } catch (error) {
    clearTimeout(timer); await tunnel.close();
    if (observed && observed !== settings.hostFingerprint) throw new Error('SSH host key does not match the trusted fingerprint. Verify the server identity before updating the trusted key.');
    throw new Error('SSH connection failed: ' + redact(error.message, secrets));
  }
}

module.exports = { normalizeSsh, inspectHostKey, openSshTunnel, fingerprint, redact };
