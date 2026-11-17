const { DatabaseService } = require('./database.cjs');
const service = new DatabaseService({ dataDir: process.argv[2] });
const methods = new Set(['connect', 'sshFingerprint', 'disconnect', 'schemas', 'columns', 'query', 'info', 'close', 'tableData', 'previewChanges', 'applyChanges', 'transferInfo', 'exportDatabase', 'inspectImport', 'importDatabase', 'cancelTransfer']);
process.on('message', async ({ id, method, arg }) => {
  try {
    if (!methods.has(method)) throw new Error('Unknown database operation.');
    const value = await service[method](arg);
    if (process.connected) process.send({ id, ok: true, value });
  } catch (error) { if (process.connected) process.send({ id, ok: false, error: String(error.message || 'Database operation failed.') }); }
});
process.on('disconnect', () => process.exit(0));
