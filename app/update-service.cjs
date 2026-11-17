'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const os = require('node:os');
const { createHash, createPublicKey, verify, randomUUID } = require('node:crypto');

const MAX_INSTALLER = 512 * 1024 * 1024;
const GITHUB_HOSTS = ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'];

function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error('Use a stable major.minor.patch version.');
  const parts = value.split('.').map(Number);
  if (parts.some(part => part > 65535)) throw new Error('Version components must be at most 65535.');
  return parts;
}

function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  return 0;
}

function secureUrl(value, hosts) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Update URLs must use HTTPS.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) throw new Error('Update URLs must use HTTPS without credentials, fragments or custom ports.');
  if (hosts && !hosts.has(url.hostname)) throw new Error('Update download host is not trusted by this build.');
  return url;
}

function configuration(config = {}) {
  if (!config.feedUrl && !config.publicKey) return null;
  const url = secureUrl(config.feedUrl);
  if (typeof config.publicKey !== 'string' || !config.publicKey.trim().startsWith('-----BEGIN PUBLIC KEY-----')) throw new Error('Supply only an Ed25519 public key, never a private signing key.');
  const key = createPublicKey(config.publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Updates require an Ed25519 public key.');
  if (!Array.isArray(config.downloadHosts) || config.downloadHosts.some(host => typeof host !== 'string' || !/^[a-z0-9.-]+$/.test(host))) throw new Error('Invalid update download host list.');
  const hosts = new Set([url.hostname, ...config.downloadHosts]);
  if (url.hostname === 'github.com') for (const host of GITHUB_HOSTS) hosts.add(host);
  return { url: url.href, key, hosts };
}

function decode64(value) {
  if (typeof value !== 'string' || !value || value.length > 90000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid update signature envelope.');
  return Buffer.from(value, 'base64');
}

function verifyManifest(envelope, config, currentVersion, windowsBuild = 10240) {
  const payload = decode64(envelope.payload), signature = decode64(envelope.signature);
  if (signature.length !== 64 || !verify(null, payload, config.key, signature)) throw new Error('Update signature verification failed.');
  const data = JSON.parse(payload.toString('utf8'));
  versionParts(data.version);
  if (data.schema !== 1 || data.product !== 'EZ Bench' || data.platform !== 'win32' || data.arch !== 'x64') throw new Error('This update is not an EZ Bench Windows x64 release.');
  if (!Number.isSafeInteger(data.minimumWindowsBuild) || data.minimumWindowsBuild < 10240 || windowsBuild < data.minimumWindowsBuild) throw new Error('This update requires a newer Windows build.');
  if (!Number.isSafeInteger(data.bytes) || data.bytes < 1 || data.bytes > MAX_INSTALLER || !/^[a-f0-9]{64}$/.test(data.sha256)) throw new Error('Invalid update installer size or SHA-256.');
  const url = secureUrl(data.url, config.hosts);
  if (!url.pathname.toLowerCase().endsWith('.exe')) throw new Error('The update must point to a Windows setup executable.');
  return compareVersions(data.version, currentVersion) > 0 ? { ...data, url: url.href } : null;
}

function responseFor(value, hosts, signal, redirects = 0) {
  return new Promise((resolve, reject) => {
    const url = secureUrl(value, hosts);
    const request = https.get(url, { signal, headers: { 'User-Agent': 'EZ-Bench-Updater', 'Accept-Encoding': 'identity' } }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location;
        response.destroy();
        if (!location || redirects >= 5) return reject(new Error('Too many update redirects or a missing redirect URL.'));
        let next;
        try { next = secureUrl(new URL(location, url).href, hosts).href; } catch (error) { reject(error); return; }
        responseFor(next, hosts, signal, redirects + 1).then(resolve, reject);
      } else if (response.statusCode !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
        response.destroy(); reject(new Error('The update server did not return an uncompressed successful response.'));
      } else resolve(response);
    });
    request.on('error', reject);
  });
}

async function readManifest(url, hosts, signal) {
  const response = await responseFor(url, hosts, signal);
  const chunks = []; let bytes = 0;
  try {
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > 65536) throw new Error('Update manifest exceeds 64 KiB.');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { response.destroy(); }
}

async function downloadInstaller(release, destination, hosts, signal, progress) {
  const response = await responseFor(release.url, hosts, signal);
  let file;
  let created = false;
  try {
    if (response.headers['content-length'] && Number(response.headers['content-length']) !== release.bytes) throw new Error('Installer size does not match the signed manifest.');
    file = await fs.promises.open(destination, 'wx', 0o600); created = true;
    const hash = createHash('sha256'); let bytes = 0, lastProgress = 0;
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > release.bytes) throw new Error('Installer exceeds its signed size.');
      hash.update(chunk);
      // FileHandle.write is allowed to write fewer bytes than requested.
      let offset = 0;
      while (offset < chunk.length) { const written = await file.write(chunk, offset, chunk.length - offset); if (!written.bytesWritten) throw new Error('Could not write the update file.'); offset += written.bytesWritten; }
      if (Date.now() - lastProgress > 200) { progress(bytes); lastProgress = Date.now(); }
    }
    if (bytes !== release.bytes || hash.digest('hex') !== release.sha256) throw new Error('Installer SHA-256 or size does not match the signed manifest.');
    await file.sync();
    progress(bytes);
  } catch (error) {
    await file?.close(); file = null;
    if (created) await fs.promises.unlink(destination).catch(() => {});
    throw error;
  } finally { response.destroy(); await file?.close(); }
}

async function verifyInstaller(filename, release) {
  const file = await fs.promises.open(filename, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== release.bytes) throw new Error('Downloaded installer changed. Download it again.');
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    if (hash.digest('hex') !== release.sha256) throw new Error('Downloaded installer changed. Download it again.');
  } finally { await file.close(); }
}

class UpdateService {
  constructor({ config, currentVersion, cacheDir, platform = process.platform, arch = process.arch, windowsBuild = Number(os.release().split('.')[2]), transport = {} }) {
    this.currentVersion = currentVersion; this.cacheDir = cacheDir; this.platform = platform; this.arch = arch; this.windowsBuild = windowsBuild;
    this.transport = { readManifest, downloadInstaller, ...transport };
    this.release = null; this.installer = null; this.active = null;
    try { this.config = configuration(config); } catch { this.configError = 'This build has an invalid update feed or signing key. Contact the release owner.'; }
    this.state = { phase: 'idle', currentVersion, message: 'Check for a newer stable release.' };
    if (platform !== 'win32' || arch !== 'x64' || !Number.isInteger(windowsBuild) || windowsBuild < 10240) this.state = { ...this.state, phase: 'disabled', message: 'In-app updates require Windows 10 or later, x64.' };
    else if (!this.config) this.state = { ...this.state, phase: 'disabled', message: this.configError || 'Updates are not configured for this build. The release owner must set a feed and public signing key.' };
  }
  status() { return { ...this.state }; }
  async _run(fn) {
    if (this.active) throw new Error('An update operation is already running.');
    if (this.state.phase === 'disabled') return this.status();
    const controller = new AbortController(); this.active = controller;
    this.completion = new Promise(resolve => { this.complete = resolve; });
    try { await fn(controller.signal); }
    catch (error) { this.state = { ...this.state, phase: 'error', message: controller.signal.aborted ? 'Update cancelled or timed out. You can retry.' : error.message }; throw new Error(this.state.message); }
    finally { this.active = null; this.complete(); }
    return this.status();
  }
  check() {
    return this._run(async signal => {
      await this._removeInstaller();
      this.release = null; this.installer = null;
      this.state = { phase: 'checking', currentVersion: this.currentVersion, message: 'Checking for updates…' };
      const timer = setTimeout(() => this.active?.abort(), 20000);
      try {
        const envelope = await this.transport.readManifest(this.config.url, this.config.hosts, signal);
        this.release = verifyManifest(envelope, this.config, this.currentVersion, this.windowsBuild);
        this.state = { ...this.state, phase: this.release ? 'available' : 'current', version: this.release?.version, bytes: this.release?.bytes, message: this.release ? 'A verified release is available. Download when you are ready.' : 'You have the latest stable version.' };
      } finally { clearTimeout(timer); }
    });
  }
  download() {
    return this._run(async signal => {
      if (!this.release) throw new Error('Check for a newer release first.');
      await this._removeInstaller();
      const folder = await fs.promises.mkdtemp(path.join(this.cacheDir, 'ez-bench-update-'));
      const destination = path.join(folder, `EZ-Bench-Setup-${this.release.version}.exe`);
      this.installer = null;
      this.state = { ...this.state, phase: 'downloading', downloaded: 0, message: 'Downloading and verifying the Windows installer…' };
      const timer = setTimeout(() => this.active?.abort(), 5 * 60000);
      try {
        await this.transport.downloadInstaller(this.release, destination, this.config.hosts, signal, downloaded => { this.state.downloaded = downloaded; });
        await verifyInstaller(destination, this.release);
        signal.throwIfAborted();
        this.installer = destination;
        this.state = { ...this.state, phase: 'ready', message: 'Installer verified. Save SQL files and finish transactions before installing.' };
      } catch (error) { await fs.promises.unlink(destination).catch(() => {}); await fs.promises.rmdir(folder).catch(() => {}); throw error; }
      finally { clearTimeout(timer); }
    });
  }
  async installerPath() {
    if (this.active || !this.installer || this.state.phase !== 'ready') throw new Error('Download and verify an update first.');
    try { await verifyInstaller(this.installer, this.release); }
    catch (error) { await this._removeInstaller(); this.state = { ...this.state, phase: 'error', message: error.message }; throw error; }
    return this.installer;
  }
  cancel() { this.active?.abort(); }
  async _removeInstaller() {
    if (this.installer && !this.preserveInstaller) { await fs.promises.unlink(this.installer).catch(() => {}); await fs.promises.rmdir(path.dirname(this.installer)).catch(() => {}); this.installer = null; }
  }
  async close() {
    this.cancel();
    await this.completion;
    // Only delete this session's exact installer and its now-empty folder.
    await this._removeInstaller();
  }
}

module.exports = { UpdateService, versionParts, compareVersions, configuration, secureUrl, verifyManifest, responseFor, readManifest, downloadInstaller, verifyInstaller };
