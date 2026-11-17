'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { generateKeyPairSync, createPrivateKey, createPublicKey, createHash, sign } = require('node:crypto');
const { versionParts, secureUrl } = require('../app/update-service.cjs');

async function createManifest({ installer, url, privateKeyPath, version, output }) {
  versionParts(version);
  secureUrl(url);
  if (!new URL(url).pathname.toLowerCase().endsWith('.exe')) throw new Error('Installer URL must end with .exe.');
  if (fs.existsSync(output) || fs.existsSync(output + '.sha256')) throw new Error('Manifest output exists. Preserve it or choose a new destination.');
  const key = createPrivateKey(fs.readFileSync(privateKeyPath));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Use the release Ed25519 private key.');
  const stat = fs.statSync(installer);
  if (!stat.isFile() || stat.size < 1 || stat.size > 512 * 1024 * 1024) throw new Error('Choose a setup executable smaller than 512 MiB.');
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(installer)) hash.update(chunk);
  const payload = Buffer.from(JSON.stringify({ schema: 1, product: 'EZ Bench', version, platform: 'win32', arch: 'x64', minimumWindowsBuild: 10240, url, bytes: stat.size, sha256: hash.digest('hex') }));
  const envelope = JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') }, null, 2) + '\n';
  fs.writeFileSync(output, envelope, { flag: 'wx' });
  fs.writeFileSync(output + '.sha256', createHash('sha256').update(envelope).digest('hex') + ' *' + path.basename(output) + '\n', { flag: 'wx' });
  return { output, version, bytes: stat.size, publicKey: createPublicKey(key).export({ type: 'spki', format: 'pem' }) };
}

function createKey(privatePath, publicPath) {
  if (path.resolve(privatePath) === path.resolve(publicPath) || fs.existsSync(privatePath) || fs.existsSync(publicPath)) throw new Error('Choose two new, different key files.');
  const keys = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  fs.writeFileSync(privatePath, keys.privateKey, { flag: 'wx', mode: 0o600 });
  try { fs.writeFileSync(publicPath, keys.publicKey, { flag: 'wx' }); }
  catch (error) { fs.unlinkSync(privatePath); throw error; }
  return { publicPath, message: 'Keep the private key outside source, builds and public releases. Restrict its Windows file permissions and retain a secure backup.' };
}

if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);
  Promise.resolve().then(() => {
    if (command === 'keygen' && args.length === 2) return createKey(...args);
    if (command === 'manifest' && args.length === 5) return createManifest({ installer: args[0], url: args[1], privateKeyPath: args[2], version: args[3], output: args[4] });
    throw new Error('Usage: node scripts/update-release.cjs keygen PRIVATE_PATH PUBLIC_PATH\n       node scripts/update-release.cjs manifest INSTALLER HTTPS_URL PRIVATE_KEY VERSION OUTPUT_JSON');
  }).then(value => process.stdout.write(JSON.stringify(value, null, 2) + '\n')).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}

module.exports = { createManifest, createKey };
