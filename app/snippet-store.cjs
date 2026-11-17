'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { redactSql } = require('./sql-privacy.js');
const MAX_FILE = 2 * 1024 * 1024;
const DIALECTS = new Set(['any', 'mysql', 'mariadb', 'postgres', 'mssql', 'sqlite']);

function snippetValue(input, previous) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Enter a valid SQL snippet.');
  if (input.private === true) throw new Error('Private SQL cannot be saved to snippets. Save a SQL file explicitly if needed.');
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 80 || /[\0\r\n]/.test(input.title)) throw new Error('Enter a snippet title of 1–80 characters on one line.');
  if (typeof input.sql !== 'string' || !input.sql.trim() || Buffer.byteLength(input.sql) > 128 * 1024 || input.sql.includes('\0')) throw new Error('Enter SQL text up to 128 KiB.');
  if (!DIALECTS.has(input.dialect)) throw new Error('Choose a supported snippet dialect.');
  if (redactSql(input.sql).hasSecrets || redactSql(input.title).hasSecrets) throw new Error('This snippet appears to contain credentials. Remove them before saving.');
  return { id: previous?.id || randomUUID(), title: input.title.trim(), sql: input.sql, dialect: input.dialect, updatedAt: new Date().toISOString() };
}

class SnippetStore {
  constructor(dataDir) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new Error('An absolute snippet data directory is required.');
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'snippets.json'); this.entries = []; this.warning = ''; this.queue = Promise.resolve();
    if (fs.existsSync(this.file)) {
      try {
        if (fs.statSync(this.file).size > MAX_FILE) throw new Error('Snippet file is too large.');
        const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 100) throw new Error('Invalid snippet format.');
        const ids = new Set();
        this.entries = data.entries.map(entry => {
          if (typeof entry?.id !== 'string' || !/^[a-f0-9-]{36}$/.test(entry.id) || ids.has(entry.id) || typeof entry.updatedAt !== 'string' || !Number.isFinite(Date.parse(entry.updatedAt))) throw new Error('Invalid snippet entry.');
          ids.add(entry.id); return { ...snippetValue(entry, entry), updatedAt: entry.updatedAt };
        });
      } catch { this.entries = []; this.warning = 'The local snippets file could not be read safely. It was preserved. Restore a valid copy before saving snippets.'; }
    }
  }
  list() { return { entries: this.entries.map(entry => ({ ...entry })).sort((a, b) => a.title.localeCompare(b.title)), warning: this.warning }; }
  async _write(entries) {
    if (this.warning) throw new Error(this.warning);
    const text = JSON.stringify({ version: 1, entries }, null, 2);
    if (entries.length > 100 || Buffer.byteLength(text) > MAX_FILE) throw new Error('Keep up to 100 snippets and 2 MiB total. Remove or shorten an existing snippet.');
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    let file;
    try {
      file = await fs.promises.open(temporary, 'wx', 0o600);
      await file.writeFile(text, 'utf8'); await file.sync(); await file.close(); file = null;
      await fs.promises.rename(temporary, this.file);
      this.entries = entries;
    } finally { await file?.close(); await fs.promises.unlink(temporary).catch(() => {}); }
  }
  _run(operation) { const next = this.queue.then(operation); this.queue = next.catch(() => {}); return next; }
  save(input) {
    return this._run(async () => {
      const previous = input?.id ? this.entries.find(entry => entry.id === input.id) : null;
      if (input?.id && !previous) throw new Error('This snippet no longer exists. Reload the snippet library.');
      const value = snippetValue(input, previous);
      await this._write(previous ? this.entries.map(entry => entry.id === value.id ? value : entry) : [...this.entries, value]);
      return { ...value };
    });
  }
  remove(id) {
    return this._run(async () => {
      if (typeof id !== 'string' || !this.entries.some(entry => entry.id === id)) throw new Error('This snippet no longer exists.');
      await this._write(this.entries.filter(entry => entry.id !== id)); return true;
    });
  }
  async close() { await this.queue; }
}

module.exports = { SnippetStore, snippetValue };
