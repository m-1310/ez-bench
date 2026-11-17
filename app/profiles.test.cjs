'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileStore } = require('./profiles.cjs');

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-profiles-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { store: new ProfileStore(dataDir), dataDir };
}

test('profiles persist metadata and never persist credentials or unknown properties', t => {
  const { store, dataDir } = fixture(t);
  const saved = store.save({ name: 'Local MySQL', host: '127.0.0.1', user: 'root', port: '3306', password: 'do-not-store-me', privateKey: 'secret-key', metadata: { password: 'nested-secret' } });
  assert.ok(saved.id);
  assert.equal(saved.mode, 'mysql');
  assert.equal(saved.port, 3306);
  const raw = fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8');
  for (const forbidden of ['do-not-store-me', 'secret-key', 'nested-secret', 'password', 'privateKey', 'metadata']) assert.equal(raw.includes(forbidden), false);
  assert.deepEqual(new ProfileStore(dataDir).list(), [saved]);
  const edited = store.save({ ...saved, name: 'Renamed' });
  assert.equal(store.list().length, 1);
  assert.equal(edited.name, 'Renamed');
  assert.deepEqual(store.remove(saved.id), { removed: true });
  assert.deepEqual(store.list(), []);
});

test('invalid profiles cannot modify valid saved data', t => {
  const { store } = fixture(t);
  const demo = store.save({ name: 'Sandbox', mode: 'demo' });
  assert.throws(() => store.save({ name: 'Bad', host: 'localhost', user: 'root', port: 'text' }), /Port/);
  assert.throws(() => store.save({ name: 'Bad', host: 'localhost', user: '' }), /user/);
  assert.throws(() => store.save({ name: 'Bad', mode: 'unknown' }), /connection mode/);
  assert.deepEqual(store.list(), [demo]);
});

test('local SQLite profiles retain only the selected absolute file path and known metadata', t => {
  const { store, dataDir } = fixture(t);
  const filePath = path.join(dataDir, 'chosen.db');
  const saved = store.save({ name: 'My local file', mode: 'sqlite', filePath, password: 'never-saved', host: 'ignored-host', user: 'ignored-user', untrusted: true });
  assert.equal(saved.filePath, filePath);
  assert.equal(saved.database, 'main');
  assert.equal(saved.host, '');
  assert.equal(saved.user, '');
  assert.deepEqual(store.list(), [saved]);
  assert.equal('password' in saved, false);
  assert.equal('untrusted' in saved, false);
  assert.throws(() => store.save({ name: 'Relative', mode: 'sqlite', filePath: 'relative.db' }), /absolute SQLite file path/);
});

test('MySQL profiles persist optional TLS as a validated boolean', t => {
  const { store } = fixture(t);
  const basic = { name: 'MySQL', host: 'example.test', user: 'developer' };
  const plain = store.save(basic);
  assert.equal(plain.tls, false);
  const secure = store.save({ ...plain, tls: true });
  assert.equal(secure.tls, true);
  assert.equal(store.list()[0].tls, true);
  assert.throws(() => store.save({ ...secure, tls: 'on' }), /TLS/);
  assert.equal(store.list()[0].tls, true);
});

test('server profiles support each advertised engine with correct default ports and no credentials', t => {
  const { store, dataDir } = fixture(t);
  for (const [mode, port] of [['mysql', 3306], ['mariadb', 3306], ['postgres', 5432], ['mssql', 1433]]) {
    const saved = store.save({ name: mode, mode, host: 'localhost', user: 'developer', password: 'secret-never-store', tls: true });
    assert.equal(saved.port, port);
    assert.equal(saved.mode, mode);
    assert.equal(saved.tls, true);
    assert.equal(saved.host, 'localhost');
    assert.equal('password' in saved, false);
  }
  assert.equal(store.list().length, 4);
  assert.equal(fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8').includes('secret-never-store'), false);
});

test('corrupt profile data is preserved and an actionable error is returned', t => {
  const { store, dataDir } = fixture(t);
  const filePath = path.join(dataDir, 'profiles.json');
  fs.writeFileSync(filePath, '{corrupt');
  assert.throws(() => store.list(), /could not be read/);
  assert.throws(() => store.save({ name: 'Demo', mode: 'demo' }), /preserved/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{corrupt');
});

test('loading historical extra fields strips credentials from returned values', t => {
  const { store, dataDir } = fixture(t);
  fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify([{ id: 'known', name: 'Local', host: 'localhost', user: 'root', port: 3306, password: 'old-secret' }]));
  assert.equal('password' in store.list()[0], false);
  store.save({ ...store.list()[0], name: 'Updated' });
  assert.equal(fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8').includes('old-secret'), false);
});

test('SSH profiles retain only connection metadata, key path and verified host pin', t => {
  const { store, dataDir } = fixture(t);
  const ssh = { enabled:true,host:'gateway.example.test',port:22,user:'tunnel-user',authMethod:'key',privateKeyPath:path.join(dataDir,'id_ed25519'),hostFingerprint:'SHA256:'+Buffer.alloc(32,1).toString('base64').replace(/=+$/,''),password:'SSH-SECRET-NOT-SAVED',passphrase:'KEY-PASSPHRASE-NOT-SAVED',privateKey:'PRIVATE-CONTENT-NOT-SAVED',agent:'ignored' };
  const saved = store.save({ name:'Through SSH', mode:'mysql', host:'private-db.internal', user:'database-user', password:'DB-SECRET-NOT-SAVED', ssh });
  assert.equal(saved.ssh.host,'gateway.example.test');assert.equal(saved.ssh.privateKeyPath,ssh.privateKeyPath);assert.equal(saved.ssh.hostFingerprint,ssh.hostFingerprint);assert.equal(saved.host,'private-db.internal');
  const raw = fs.readFileSync(path.join(dataDir,'profiles.json'),'utf8');
  for(const secret of [ssh.password,ssh.passphrase,ssh.privateKey,'DB-SECRET-NOT-SAVED'])assert.equal(raw.includes(secret),false);
  for(const key of ['password','passphrase','privateKey','agent'])assert.equal(Object.hasOwn(saved.ssh,key),false);
  assert.deepEqual(store.list(),[saved]);
});

test('SSH metadata validation preserves stored profiles and direct/local connections omit SSH', t => {
  const { store, dataDir } = fixture(t);
  const options={name:'Gateway',mode:'postgres',host:'db.internal',user:'dbuser',database:'app',ssh:{enabled:true,host:'gateway',user:'sshuser',authMethod:'password'}};
  const saved=store.save(options);assert.equal(saved.ssh.port,22);
  for(const ssh of [{...options.ssh,port:0},{...options.ssh,enabled:'true'},{...options.ssh,hostFingerprint:'not-a-key'},{...options.ssh,authMethod:'key',privateKeyPath:'relative.key'}])assert.throws(()=>store.save({...saved,ssh}));
  assert.deepEqual(store.list(),[saved]);
  const direct=store.save({...saved,ssh:{enabled:false,password:'ignored'}});assert.equal(Object.hasOwn(direct,'ssh'),false);
  const sqlite=store.save({name:'Local',mode:'sqlite',filePath:path.join(dataDir,'database.db'),ssh:options.ssh});assert.equal(Object.hasOwn(sqlite,'ssh'),false);
});
