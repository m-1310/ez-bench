'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ENGINES } = require('./database.cjs');

function text(value, name, { optional = false, limit = 256 } = {}) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) throw new Error(`Enter a valid ${name}.`);
  return value.trim();
}

function sshMetadata(input) {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object' || Array.isArray(input) || typeof input.enabled !== 'boolean') throw new Error('SSH settings must include an enabled or disabled state.');
  if (!input.enabled) return undefined;
  const host = text(input.host, 'SSH host');
  const user = text(input.user, 'SSH user');
  const port = input.port === undefined || input.port === '' ? 22 : Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH port must be an integer from 1 to 65535.');
  if (!['password', 'key'].includes(input.authMethod)) throw new Error('Select password or private key SSH authentication.');
  const privateKeyPath = input.authMethod === 'key' ? text(input.privateKeyPath, 'SSH private key file', { limit: 32768 }) : '';
  if (privateKeyPath && !path.isAbsolute(privateKeyPath)) throw new Error('Choose an absolute SSH private key file path.');
  const hostFingerprint = text(input.hostFingerprint, 'SSH host fingerprint', { optional: true, limit: 100 });
  if (hostFingerprint && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(hostFingerprint)) throw new Error('Use a valid SHA256 SSH host fingerprint.');
  return { enabled: true, host, port, user, authMethod: input.authMethod, privateKeyPath, hostFingerprint };
}

function sanitize(input, { allowMissingId = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Enter a connection profile.');
  const mode = input.mode || 'mysql';
  if (!Object.hasOwn(ENGINES, mode)) throw new Error('Select a supported database connection mode.');
  const local = mode === 'demo' || mode === 'sqlite';
  const name = text(input.name, 'connection name', { limit: 80 });
  const id = input.id === undefined && allowMissingId ? randomUUID() : text(input.id, 'profile ID', { limit: 100 });
  const host = local ? '' : text(input.host, 'host');
  const user = local ? '' : text(input.user, 'user');
  const database = local ? 'main' : text(input.database, 'database', { optional: true });
  const port = local ? 3306 : Number(input.port === undefined || input.port === '' ? ENGINES[mode].port : input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535.');
  if (mode === 'sqlite') {
    const filePath = text(input.filePath, 'SQLite file path', { limit: 32768 });
    if (!path.isAbsolute(filePath)) throw new Error('Choose an absolute SQLite file path.');
    return { id, name, mode, host, port, user, database, filePath };
  }
  if (!local) {
    if (input.tls !== undefined && typeof input.tls !== 'boolean') throw new Error('TLS must be enabled or disabled.');
    const ssh = sshMetadata(input.ssh);
    return { id, name, mode, host, port, user, database, tls: input.tls === true, ...(ssh ? { ssh } : {}) };
  }
  return { id, name, mode, host, port, user, database };
}

class ProfileStore {
  constructor(dataDir) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new Error('An absolute data directory is required.');
    fs.mkdirSync(dataDir, { recursive: true });
    this.filePath = path.join(dataDir, 'profiles.json');
  }

  list() {
    if (!fs.existsSync(this.filePath)) return [];
    if(fs.statSync(this.filePath).size>1024*1024)throw new Error('Saved profiles exceed the 1 MiB limit. The existing file is preserved.');
    let stored;
    try { stored = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); }
    catch { throw new Error('Saved connection profiles could not be read. The existing file has been preserved.'); }
    if (!Array.isArray(stored)||stored.length>500) throw new Error('Saved connection profiles have an invalid format or exceed 500 entries. The existing file has been preserved.');
    return stored.map(profile => sanitize(profile));
  }

  save(profile) {
    const clean = sanitize(profile, { allowMissingId: true });
    const profiles = this.list();
    const index = profiles.findIndex(item => item.id === clean.id);
    if (index < 0) profiles.push(clean); else profiles[index] = clean;
    this._write(profiles);
    return clean;
  }

  remove(id) {
    text(id, 'profile ID', { limit: 100 });
    const existing = this.list();
    const remaining = existing.filter(profile => profile.id !== id);
    this._write(remaining);
    return { removed: remaining.length !== existing.length };
  }

  _write(profiles) {
    const text=JSON.stringify(profiles,null,2);
    if(profiles.length>500||Buffer.byteLength(text,'utf8')>1024*1024)throw new Error('Connection profiles must fit within 500 entries and 1 MiB.');
    const temporary = this.filePath + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.filePath);
    } catch {
      try { fs.unlinkSync(temporary); } catch {}
      throw new Error('Connection profiles could not be saved.');
    }
  }
}

module.exports = { ProfileStore };
