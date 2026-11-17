const { fork } = require('node:child_process');
const path = require('node:path');
const {childEnvironment}=require('./child-env.cjs');

class DatabaseClient {
  constructor(options) { this.options = options; this.pending = new Map(); this.sequence = 0; this.worker = null; }
  _start() {
    if (this.worker) return;
    const worker = fork(path.join(__dirname, 'database-worker.cjs'), [this.options.dataDir], { execPath: process.execPath, execArgv: [], env: childEnvironment({ ELECTRON_RUN_AS_NODE: '1' }), stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    this.worker = worker;
    worker.on('message', ({ id, ok, value, error }) => { const request = this.pending.get(id); if (!request) return; clearTimeout(request.timer); this.pending.delete(id); if (ok) request.resolve(value); else request.reject(new Error(error)); });
    const fail = message => { if (this.worker === worker) this.worker = null; for (const [id, request] of this.pending) { if (request.worker !== worker) continue; clearTimeout(request.timer); request.reject(new Error(message)); this.pending.delete(id); } };
    worker.on('error', () => fail('The database worker stopped unexpectedly. Reconnect to continue.'));
    worker.on('exit', () => fail('The database connection was closed. Reconnect to continue.'));
  }
  _call(method, arg) {
    this._start(); const worker = this.worker; const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const transfer = ['exportDatabase', 'importDatabase'].includes(method);
      const timer = setTimeout(() => { this._stop('The database operation timed out. Reconnect to continue.'); }, transfer ? 15 * 60000 : 30000);
      this.pending.set(id, { resolve, reject, timer, worker });
      worker.send({ id, method, arg });
    });
  }
  async _stop(message) {
    const worker = this.worker; this.worker = null;
    for (const [id, request] of this.pending) { if (request.worker !== worker) continue; clearTimeout(request.timer); request.reject(new Error(message)); this.pending.delete(id); }
    if (worker && worker.exitCode === null) {
      // The worker owns native dump/restore children. Terminate its exact subtree
      // so cancellation cannot leave an import process writing in the background.
      await new Promise(resolve => {
        worker.once('exit', resolve);
        if (process.platform === 'win32') {
          const killer = require('node:child_process').spawn('taskkill.exe', ['/PID', String(worker.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => worker.kill());
          killer.on('exit', code => { if (code && worker.exitCode === null) worker.kill(); });
        } else worker.kill();
      });
    }
  }
  connect(options) { return this._call('connect', options); }
  sshFingerprint(options) { return this._call('sshFingerprint', options); }
  async disconnect() { if(!this.worker)return {connected:false};const value=await this._call('disconnect');await this._stop('Database disconnected.');return value; }
  schemas() { return this._call('schemas'); }
  columns(args) { return this._call('columns', args); }
  info() { return this._call('info'); }
  query(args) { return this._call('query', args); }
  tableData(args) { return this._call('tableData', args); }
  previewChanges(args) { return this._call('previewChanges', args); }
  applyChanges(args) { return this._call('applyChanges', args); }
  transferInfo(args) { return this._call('transferInfo', args); }
  exportDatabase(args) { return this._call('exportDatabase', args); }
  inspectImport(args) { return this._call('inspectImport', args); }
  importDatabase(args) { return this._call('importDatabase', args); }
  cancel() { return this._stop('Query cancelled. Reconnect to continue.'); }
  async close() { await this._stop('The database workspace was closed.'); }
}
module.exports = { DatabaseClient };
