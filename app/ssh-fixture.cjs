'use strict';
// Test-only in-process SSH server. It permits forwarding solely to owned fixtures;
// it has no shell/session execution, filesystem service, or external listener.
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Server, utils } = require('ssh2');

async function createSshFixture({ directory, ports = [33171, 54371], port = 0 } = {}) {
  if (!directory || !path.isAbsolute(directory)) throw new Error('An owned absolute fixture directory is required.');
  fs.mkdirSync(directory, { recursive: true });
  // Use Node's PEM encoder for fixtures: ssh2's OpenSSH generator occasionally
  // produced a key that its own parser rejected during repeated validation.
  const hostKey = {private:crypto.generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'}}).privateKey};
  const passphrase = 'EZ-Bench-Fixture-Key-Passphrase-Only';
  const userKeys = {private:crypto.generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem',cipher:'aes-256-cbc',passphrase}}).privateKey};
  const publicKey = utils.parseKey(userKeys.private,passphrase);
  const privateKeyPath = path.join(directory, 'fixture-user-key.pem');
  fs.writeFileSync(privateKeyPath, userKeys.private, { flag: 'wx', mode: 0o600 });
  const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(utils.parseKey(hostKey.private).getPublicSSH()).digest('base64').replace(/=+$/, '');
  const clients = new Set(), sockets = new Set();
  const attempts = [], forwards = [];
  const user = 'ezbench_fixture', password = 'EZ-Bench-Fixture-SSH-Password-Only';
  const remoteHost = 'database.fixture.internal';
  const server = new Server({ hostKeys: [hostKey.private] }, client => {
    clients.add(client); client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', context => {
      attempts.push({ method: context.method, user: context.username });
      if (context.username !== user) return context.reject(['password', 'publickey']);
      if (context.method === 'password' && context.password === password) return context.accept();
      if (context.method === 'publickey' && context.key.algo === publicKey.type && context.key.data.length === publicKey.getPublicSSH().length && crypto.timingSafeEqual(context.key.data, publicKey.getPublicSSH()) && (!context.signature || publicKey.verify(context.blob, context.signature, context.hashAlgo) === true)) return context.accept();
      context.reject(['password', 'publickey']);
    });
    client.on('ready', () => {
      client.on('session', (_accept, reject) => reject());
      client.on('tcpip', (accept, reject, info) => {
        if (![remoteHost, '127.0.0.1', 'localhost'].includes(info.destIP) || !ports.includes(info.destPort)) return reject();
        forwards.push({ host: info.destIP, port: info.destPort });
        const socket = net.connect({ host: '127.0.0.1', port: info.destPort }); sockets.add(socket);
        let channel;
        socket.once('connect', () => {
          channel = accept(); channel.on('error', () => socket.destroy());
          channel.on('close', () => socket.destroy());
          channel.pipe(socket); socket.pipe(channel);
        });
        socket.on('error', () => { if (channel) channel.destroy(); else reject(); });
        socket.on('close', () => { sockets.delete(socket); channel?.destroy(); });
        client.once('close', () => socket.destroy());
      });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  server.on('error', () => {});
  let closed = false;
  return {
    host: '127.0.0.1', port: server.address().port, fingerprint, user, password, privateKeyPath, passphrase, remoteHost, attempts, forwards,
    passwordOptions() { return { enabled: true, host: this.host, port: this.port, user, authMethod: 'password', password, hostFingerprint: fingerprint }; },
    keyOptions() { return { enabled: true, host: this.host, port: this.port, user, authMethod: 'key', privateKeyPath, passphrase, hostFingerprint: fingerprint }; },
    activeClients() { return clients.size; },
    async disconnectClients() {
      for (const socket of sockets) socket.destroy();
      for (const client of clients) client.end();
      await new Promise(resolve => setTimeout(resolve, 50));
    },
    async close() {
      if (closed) return; closed = true;
      for (const socket of sockets) socket.destroy();
      for (const client of clients) client.end();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
module.exports = { createSshFixture };
