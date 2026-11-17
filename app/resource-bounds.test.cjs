'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {collector,MAX_RESULT_BYTES,readMysql,readPostgres,readMssql}=require('./result-reader.cjs');
const {childEnvironment}=require('./child-env.cjs');
const {statementAt,statementRanges}=require('./sql-text.js');
const {DatabaseService}=require('./database.cjs');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');

test('result limits retain a prefix and never inspect omitted rows',()=>{
 const kept=collector();kept.add(['first']);kept.add(['x'.repeat(MAX_RESULT_BYTES)]);
 kept.add({toJSON(){throw new Error('Omitted rows must not be serialized');}});
 assert.deepEqual(kept.result.rows,[['first']]);assert.equal(kept.result.limitReason,'bytes');
 const rows=collector();for(let i=0;i<1005;i++)rows.add([i]);
 assert.equal(rows.result.rows.length,1000);assert.equal(rows.result.limitReason,'rows');
});
test('MySQL streams drain through the final status after the display cap',async()=>{
 let completed=false;const connection={connection:{query(){const query=new EventEmitter();queueMicrotask(()=>{query.emit('fields',[{name:'id'}]);for(let i=0;i<3000;i++)query.emit('result',[i]);completed=true;query.emit('result',{affectedRows:3000,serverStatus:3});query.emit('end');});return query;}}};
 const result=await readMysql(connection,'fixture');assert.equal(result.rows.length,1000);assert.equal(result.affectedRows,3000);assert.equal(result.serverStatus,3);assert.equal(completed,true);
});
test('PostgreSQL RETURNING drains all writes without retaining every returned row',async()=>{
 class Query extends EventEmitter{constructor(options){super();assert.equal(options.rowMode,'array');}}
 let writes=0;const connection={query(query){queueMicrotask(()=>{for(let i=0;i<2400;i++){writes++;query.emit('row',[i],{fields:[{name:'id'}]});}query.emit('end',{fields:[{name:'id'}],rowCount:writes});});}};
 const result=await readPostgres(connection,'fixture',Query);assert.equal(writes,2400);assert.equal(result.rows.length,1000);assert.equal(result.truncated,true);
});
test('MySQL non-tabular commands tolerate the driver empty fields event',async()=>{
 const connection={connection:{query(){const query=new EventEmitter();queueMicrotask(()=>{query.emit('fields',undefined);query.emit('result',{affectedRows:2,serverStatus:2});query.emit('end');});return query;}}};
 const result=await readMysql(connection,'fixture');assert.deepEqual(result.fields,[]);assert.equal(result.affectedRows,2);
});
test('PostgreSQL callback-only errors reject instead of leaving the worker busy',async()=>{
 class Query extends EventEmitter{}
 const connection={query(query){queueMicrotask(()=>query.callback(new Error('syntax fixture error')));}};
 await assert.rejects(readPostgres(connection,'fixture',Query),/syntax fixture error/);
});
test('SQL Server streaming drains rows and reports asynchronous errors',async()=>{
 const request=new EventEmitter();let delivered=0;request.query=async()=>{request.emit('recordset',[{name:'id',index:0}]);for(let i=0;i<2000;i++){delivered++;request.emit('row',[i]);}};
 assert.equal((await readMssql(request,'fixture')).rows.length,1000);assert.equal(delivered,2000);
 const failed=new EventEmitter();failed.query=async()=>failed.emit('error',new Error('fixture query failed'));
 await assert.rejects(readMssql(failed,'fixture'),/fixture query failed/);
});
test('child process environments exclude unrelated credentials and instrumentation',()=>{
 const env=childEnvironment({PGPASSWORD:'explicit-fixture'},{Path:'platform-path',TEMP:'temporary',OPENAI_API_KEY:'private-fixture',NODE_OPTIONS:'--inspect',AWS_SECRET_ACCESS_KEY:'private-fixture'});
 assert.deepEqual(env,{Path:'platform-path',TEMP:'temporary',PGPASSWORD:'explicit-fixture'});
});
test('current-statement selection respects quoted delimiters and dialect comments',()=>{
 for(const [dialect,sql]of [['mysql',"SELECT ';' AS value; # ignored ;\nSELECT 2;"],['postgres',"SELECT $$a;b$$; /* outer /* nested; */ */ SELECT E'a\\\';b';"],['mssql',"SELECT [a;b]; /* outer /* nested; */ */ SELECT 2;"],['sqlite',"SELECT 'a;b'; SELECT 2;"]]){
  const ranges=statementRanges(sql,dialect);assert.equal(ranges.length,2,dialect);assert.equal(statementAt(sql,sql.length,dialect).sql,ranges[1].sql);assert.equal(statementAt(sql,0,dialect).sql,ranges[0].sql);
 }
 assert.equal(statementAt('-- comment only',3,'sqlite'),null);
});
test('SQLite RETURNING display cap preserves every intended write',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ezbench-result-bounds-'));const db=new DatabaseService({dataDir:directory});
 try{await db.connect({mode:'demo'});await db.query({sql:'CREATE TABLE returning_fixture(id INTEGER PRIMARY KEY,value INTEGER)'});await db.query({sql:'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2501) INSERT INTO returning_fixture SELECT x,0 FROM n'});
  const result=await db.query({sql:'UPDATE returning_fixture SET value=1 RETURNING id'});assert.equal(result.rowCount,1000);assert.equal(result.truncated,true);assert.equal((await db.query({sql:'SELECT count(*) AS n FROM returning_fixture WHERE value=1'})).rows[0].n,2501);
 }finally{await db.close();assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(directory).startsWith('ezbench-result-bounds-'));fs.rmSync(directory,{recursive:true,force:true});}
});
