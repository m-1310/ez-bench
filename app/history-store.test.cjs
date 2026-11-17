'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {HistoryStore,MAX_FILE_BYTES,MAX_SQL_BYTES}=require('./history-store.cjs');
const {redactSql}=require('./sql-privacy.js');
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ezbench-history-'));const store=new HistoryStore(directory);t.after(async()=>{await store.close();assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(directory).startsWith('ezbench-history-'));fs.rmSync(directory,{recursive:true,force:true});});return{directory,store};}
const entry=(sql='SELECT 1',profileId='one',extra={})=>({profileId,connection:'Fixture connection',sql,timestamp:new Date().toISOString(),status:'success',rowCount:1,elapsedMs:1,...extra});
test('query history migrates legacy records, scopes connections and persists metadata without truncating SQL',async t=>{
 const {directory,store}=fixture(t);await store.close();
 const long='SELECT\n'+Array.from({length:120},(_,i)=>`${i} AS column_${i}`).join(',\n')+';';
 fs.writeFileSync(path.join(directory,'history.json'),JSON.stringify([{id:'old',...entry(long)}]));const migrated=new HistoryStore(directory);t.after(()=>migrated.close());
 assert.equal(migrated.list({profileId:'one'}).items[0].sql,long);assert.equal(migrated.list({profileId:'two'}).total,0);
 migrated.record(entry('SELECT 2','two'));await migrated.flush();const stored=JSON.parse(fs.readFileSync(path.join(directory,'history.json'),'utf8'));assert.equal(stored.version,2);assert.equal(stored.entries.length,2);
 const reopened=new HistoryStore(directory);t.after(()=>reopened.close());assert.equal(reopened.list({profileId:'one'}).items[0].sql,long);assert.equal(reopened.settings().maxEntries,500);
});
test('history search, status, dates, favorites and pages stay isolated to the active profile',async t=>{
 const {store}=fixture(t);const now=Date.now();
 for(let i=0;i<13;i++)store.record(entry('SELECT '+i+' AS searchable','one',{id:'query-'+i,status:i%2?'error':'success',timestamp:new Date(now-i*1000).toISOString(),schema:i%2?'public':'main'}));
 store.record(entry('SELECT searchable_secret','two'));
 assert.equal(store.list({profileId:'one',search:'searchable'}).total,13);assert.equal(store.list({profileId:'one',status:'error'}).total,6);
 assert.equal(store.list({profileId:'one',search:'public'}).total,6);assert.equal(store.list({profileId:'one',limit:5,offset:5}).items.length,5);
 assert.equal(store.list({profileId:'one',from:new Date(now-2000).toISOString(),to:new Date(now).toISOString()}).total,3);
 store.update({id:'query-3',favorite:true,title:'Favorite report'},'one');assert.equal(store.list({profileId:'one',favoritesOnly:true}).items[0].title,'Favorite report');
 assert.equal(store.list({profileId:'one',search:'favorite report'}).total,1);assert.throws(()=>store.update({id:'query-3',title:'wrong scope'},'two'),/current connection/);
 assert.equal(store.remove('query-3','two').removed,false);assert.equal(store.remove('query-3','one').removed,true);store.clear('one');assert.equal(store.list({profileId:'one'}).total,0);assert.equal(store.list({profileId:'two'}).total,1);
});
test('capture pause, private queries and count/age/byte bounds prevent unbounded local history',async t=>{
 const {store,directory}=fixture(t);store.settings({paused:true});assert.equal(store.record(entry()).recorded,false);store.settings({paused:false,maxEntries:10,maxAgeDays:1});assert.equal(store.record({...entry(),private:true}).recorded,false);
 store.record(entry('SELECT expired','one',{timestamp:new Date(Date.now()-2*86400000).toISOString()}));assert.equal(store.list({profileId:'one'}).total,0);
 store.record(entry('SELECT pinned','one',{id:'pinned',favorite:true,timestamp:new Date(Date.now()-2*86400000).toISOString()}));for(let i=0;i<20;i++)store.record(entry('SELECT '+i));assert.equal(store.list({profileId:'one'}).total,10);assert.equal(store.list({profileId:'one',favoritesOnly:true}).items[0].id,'pinned');
 const tooLarge=store.record(entry('SELECT '+ 'x'.repeat(MAX_SQL_BYTES)));assert.equal(tooLarge.recorded,false);assert.match(tooLarge.reason,/256 KiB/);
 store.settings({maxEntries:2000});for(let i=0;i<20;i++)store.record(entry('SELECT '+"'"+'न'.repeat(70000)+"'",'large'));
 await store.flush();assert.ok(fs.statSync(path.join(directory,'history.json')).size<=MAX_FILE_BYTES);assert.ok(store.list({profileId:'large'}).total<20);assert.ok(store._timer===null);
});
test('common credential patterns are redacted in shared privacy check and stored history only',async t=>{
 const {store,directory}=fixture(t);
  const bearer = require('node:crypto').randomBytes(16).toString('hex');
 const queries=["ALTER ROLE app PASSWORD 'role-secret'","CREATE USER app IDENTIFIED BY 'mysql-secret'","UPDATE settings SET api_key='api-secret', passphrase='key-secret'", "SELECT 'token-secret' AS access_token", "SELECT PASSWORD('legacy-secret')", "INSERT INTO credentials(password,token,name) VALUES('insert-secret','second-secret','Safe name'),('third-secret','fourth-secret','Other name')", "-- postgres://login:uri-secret@db.internal/app", `-- Authorization: Bearer ${bearer}`];
 for(const sql of queries){const checked=redactSql(sql);assert.equal(checked.hasSecrets,true,sql);assert.ok(checked.sql.includes('[REDACTED]'));store.record(entry(sql));}
 const normal="SELECT password_hint, 'ordinary text' AS description FROM settings WHERE id=$1";assert.deepEqual(redactSql(normal),{sql:normal,redacted:false,hasSecrets:false});
 assert.equal(redactSql('UPDATE users SET password=$1, token=?').redacted,false);
 for(const partial of ["CREATE USER app IDENTIFIED BY 'sec","ALTER USER app PASSWORD='sec","UPDATE users SET token='sec","CREATE USER app IDENTIFIED BY ","UPDATE users SET token="]){assert.equal(redactSql(partial).hasSecrets,true,partial);assert.equal(redactSql(partial).sql.includes("'sec"),false);}
 await store.flush();const content=fs.readFileSync(path.join(directory,'history.json'),'utf8');for(const secret of ['role-secret','mysql-secret','api-secret','key-secret','token-secret','legacy-secret','insert-secret','second-secret','third-secret','fourth-secret','uri-secret',bearer])assert.equal(content.includes(secret),false,secret);assert.ok(store.list({profileId:'one'}).items.every(item=>item.redacted));
 // The input string sent to the database is never changed by checking it.
 assert.equal(queries[0],"ALTER ROLE app PASSWORD 'role-secret'");
 const titleEntry=store.record(entry('SELECT 99','one',{error:"password='ERROR-SECRET'",title:"token='TITLE-SECRET'"})).entry;store.update({id:titleEntry.id,title:"api_key='UPDATED-TITLE-SECRET'"},'one');await store.flush();const metadata=fs.readFileSync(path.join(directory,'history.json'),'utf8');for(const secret of ['ERROR-SECRET','TITLE-SECRET','UPDATED-TITLE-SECRET'])assert.equal(metadata.includes(secret),false);
});
test('corrupt history is preserved read-only and failed writes do not throw through SQL recording',async t=>{
 const {directory,store}=fixture(t);await store.close();const file=path.join(directory,'history.json');fs.writeFileSync(file,'{broken JSON');const corrupt=new HistoryStore(directory);t.after(()=>corrupt.close());assert.equal(corrupt.readOnly,true);assert.equal(corrupt.record(entry()).recorded,false);assert.throws(()=>corrupt.clear('one'),/preserved/);assert.equal(await corrupt.flush(),false);assert.equal(fs.readFileSync(file,'utf8'),'{broken JSON');
 const other=fs.mkdtempSync(path.join(os.tmpdir(),'ezbench-history-'));t.after(()=>fs.rmSync(other,{recursive:true,force:true}));const failed=new HistoryStore(other);fs.mkdirSync(path.join(other,'history.json'));assert.equal(failed.record(entry()).recorded,true);assert.equal(await failed.flush(),false);assert.match(failed.list({profileId:'one'}).warning,/could not be saved/);assert.equal(fs.readdirSync(other).some(name=>name.endsWith('.tmp')),false);fs.rmdirSync(path.join(other,'history.json'));failed.record(entry('SELECT recovered'));assert.equal(await failed.flush(),true);assert.equal(failed.warning,'');await failed.close();
});
test('settings and query metadata reject invalid input without mutating persisted valid history',async t=>{
 const {store}=fixture(t);const first=store.record(entry());assert.equal(first.recorded,true);
 for(const patch of [{maxEntries:0},{maxEntries:2001},{maxAgeDays:-1},{paused:'yes'}])assert.throws(()=>store.settings(patch));
 assert.throws(()=>store.list({profileId:'one',limit:1000}));assert.throws(()=>store.list({profileId:'one',from:'bad-date'}));assert.throws(()=>store.update({id:first.entry.id,favorite:'yes'},'one'));
 assert.equal(store.record({sql:'SELECT 1'}).recorded,false);assert.equal(store.list({profileId:'one'}).total,1);await store.close();assert.equal(store.record(entry()).recorded,false);
});
