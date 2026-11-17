'use strict';

// Retain bounded UI results while draining each command to completion. Stopping
// midway through DML RETURNING could change transaction/statement semantics.
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_ROWS = 1000;
function portable(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (Array.isArray(value)) return value.map(portable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,value]) => [key,portable(value)]));
  return value;
}
function collector() {
  const result={rows:[],fields:[],affectedRows:0,truncated:false,resultBytes:0,limitReason:null};
  return {result,add(row){
    if(result.truncated)return;
    if(result.rows.length>=MAX_RESULT_ROWS){result.truncated=true;result.limitReason||='rows';return;}
    const bytes=Buffer.byteLength(JSON.stringify(portable(row)),'utf8');
    if(result.resultBytes+bytes>MAX_RESULT_BYTES){result.truncated=true;result.limitReason='bytes';return;}
    // Once any row is omitted, keep a prefix rather than mixing later small rows.
    if(result.truncated)return;
    result.resultBytes+=bytes;result.rows.push(row);
  }};
}
async function readMysql(connection,sql,parameters=[]){
  const kept=collector();let resultSets=0,failure=null;
  await new Promise((resolve,reject)=>{
    let query;
    try{query=connection.connection.query({sql,timeout:30000,rowsAsArray:true},parameters);}catch(error){reject(error);return;}
    query.on('fields',fields=>{if(!Array.isArray(fields))return;resultSets++;if(resultSets>1){failure||=new Error('This query returned multiple result sets. Run a query with one tabular result.');return;}kept.result.fields=fields;});
    query.on('result',row=>{if(Array.isArray(row)){if(resultSets<=1)kept.add(row);}else{kept.result.affectedRows+=Number(row?.affectedRows||0);if(typeof row?.serverStatus==='number')kept.result.serverStatus=row.serverStatus;}});
    query.on('error',reject);query.on('end',()=>failure?reject(failure):resolve());
  });
  return kept.result;
}
async function readPostgres(connection,sql,Query,parameters=[]){
  const kept=collector();
  await new Promise((resolve,reject)=>{
    const query=new Query({text:sql,values:parameters,rowMode:'array',query_timeout:30000});
    query.on('row',(row,result)=>{kept.result.fields=result.fields||[];kept.add(row);});
    const finish=(error,result)=>{if(error){reject(error);return;}if(Array.isArray(result)){reject(new Error('This query returned multiple result sets. Run one statement at a time.'));return;}kept.result.fields=result?.fields||[];kept.result.affectedRows=kept.result.fields.length?0:Number(result?.rowCount||0);resolve();};
    // pg wraps callbacks to enforce query_timeout and then suppresses error
    // events. Supply a callback so SQL errors cannot leave this promise pending.
    query.callback=finish;query.on('error',reject);query.on('end',result=>finish(null,result));
    try{connection.query(query);}catch(error){reject(error);}
  });
  return kept.result;
}
async function readMssql(request,sql){
  const kept=collector();let resultSets=0,failure=null;
  request.stream=true;request.arrayRowMode=true;
  request.on('recordset',fields=>{resultSets++;if(resultSets>1)failure||=new Error('This query returned multiple result sets. Run a query with one tabular result.');else kept.result.fields=Array.isArray(fields)?fields:Object.values(fields).sort((a,b)=>a.index-b.index);});
  request.on('row',row=>{if(resultSets<=1)kept.add(row);});
  request.on('rowsaffected',count=>{kept.result.affectedRows+=Number(count||0);});
  request.on('error',error=>{failure||=error;});
  await request.query(sql);
  if(failure)throw failure;
  if(kept.result.fields.length)kept.result.affectedRows=0;
  return kept.result;
}
module.exports={MAX_RESULT_BYTES,MAX_RESULT_ROWS,collector,readMysql,readPostgres,readMssql};
