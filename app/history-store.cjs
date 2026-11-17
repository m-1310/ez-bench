'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { redactSql } = require('./sql-privacy.js');
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SQL_BYTES = 256 * 1024;
const DEFAULTS = Object.freeze({ paused:false, maxEntries:500, maxAgeDays:30 });
function settingsValue(input, existing=DEFAULTS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Enter valid query history settings.');
  const value = {...existing};
  if (Object.hasOwn(input,'paused')) { if(typeof input.paused!=='boolean')throw new Error('History pause must be enabled or disabled.');value.paused=input.paused; }
  if (Object.hasOwn(input,'maxEntries')) { if(!Number.isInteger(input.maxEntries)||input.maxEntries<10||input.maxEntries>2000)throw new Error('Keep between 10 and 2000 history entries.');value.maxEntries=input.maxEntries; }
  if (Object.hasOwn(input,'maxAgeDays')) { if(!Number.isInteger(input.maxAgeDays)||input.maxAgeDays<1||input.maxAgeDays>3650)throw new Error('Keep history for between 1 and 3650 days.');value.maxAgeDays=input.maxAgeDays; }
  return value;
}
function string(value,maximum) { return typeof value==='string'?value.slice(0,maximum):''; }
function safeNumber(value) { return typeof value==='number'&&Number.isFinite(value)&&value>=0?value:0; }
class HistoryStore {
  constructor(dataDir) {
    if(typeof dataDir!=='string'||!path.isAbsolute(dataDir))throw new Error('An absolute history data directory is required.');
    fs.mkdirSync(dataDir,{recursive:true});
    this.filePath=path.join(dataDir,'history.json');this.entries=[];this.preferences={...DEFAULTS};this.warning='';this.readOnly=false;
    this._dirty=false;this._timer=null;this._writePromise=null;this._closed=false;this._firstDirty=0;
    if(fs.existsSync(this.filePath)){
      try{
        if(fs.statSync(this.filePath).size>8*1024*1024)throw new Error('Too large');
        const stored=JSON.parse(fs.readFileSync(this.filePath,'utf8'));
        const legacy=Array.isArray(stored);
        if(!legacy&&(!stored||stored.version!==2||!Array.isArray(stored.entries)))throw new Error('Invalid format');
        const records=legacy?stored:stored.entries;if(records.length>10000)throw new Error('Too many records');
        this.preferences=legacy?{...DEFAULTS}:settingsValue(stored.settings);
        const seen=new Set();
        this.entries=records.map(entry=>{
          const normalized=this._normalize(entry);if(!normalized)throw new Error('Invalid history entry');
          if(seen.has(normalized.id))normalized.id=randomUUID();seen.add(normalized.id);return normalized;
        }).sort((a,b)=>b.timestamp.localeCompare(a.timestamp));
        this._prune();
        // Legacy history is migrated only after successful validation. Credential
        // redaction also applies to imported entries before a v2 write occurs.
        if(legacy||JSON.stringify(records)!==JSON.stringify(this.entries))this._schedule();
      }catch{
        this.entries=[];this.readOnly=true;this.warning='Saved query history could not be read safely. The original history.json is preserved; back it up and move it aside to reset history.';
      }
    }
  }
  _normalize(input) {
    if(!input||typeof input!=='object'||typeof input.sql!=='string'||!input.sql.trim()||typeof input.profileId!=='string'||!input.profileId||input.profileId.length>100||Buffer.byteLength(input.sql,'utf8')>MAX_SQL_BYTES)return null;
    const result=redactSql(input.sql);if(Buffer.byteLength(result.sql,'utf8')>MAX_SQL_BYTES)return null;const timestamp=new Date(input.timestamp||Date.now());if(!Number.isFinite(timestamp.getTime()))return null;
    const error=input.error?redactSql(string(input.error,2000)):null;
    const title=redactSql(string(input.title,160));
    return {id:typeof input.id==='string'&&input.id&&input.id.length<=100?input.id:randomUUID(),profileId:input.profileId,connection:string(input.connection,120)||'Database connection',schema:string(input.schema,256),sql:result.sql,timestamp:timestamp.toISOString(),status:input.status==='error'?'error':'success',rowCount:safeNumber(input.rowCount),affectedRows:safeNumber(input.affectedRows),elapsedMs:safeNumber(input.elapsedMs),title:title.sql,favorite:input.favorite===true,redacted:result.redacted||title.redacted||Boolean(error?.redacted)||input.redacted===true,...(error?{error:error.sql}:{})};
  }
  _prune(now=Date.now()) {
    const cutoff=now-this.preferences.maxAgeDays*86400000;
    this.entries=this.entries.filter(entry=>entry.favorite||Date.parse(entry.timestamp)>=cutoff);
    const removed=new Set(),order=[];
    for(let i=this.entries.length-1;i>=0;i--)if(!this.entries[i].favorite)order.push(i);
    for(let i=this.entries.length-1;i>=0;i--)if(this.entries[i].favorite)order.push(i);
    let count=this.entries.length,bytes=Buffer.byteLength(JSON.stringify({version:2,settings:this.preferences,entries:[]}),'utf8')+Math.max(0,count-1);
    const sizes=this.entries.map(entry=>Buffer.byteLength(JSON.stringify(entry),'utf8'));bytes+=sizes.reduce((sum,size)=>sum+size,0);
    for(const index of order){if(count<=this.preferences.maxEntries&&bytes<=MAX_FILE_BYTES)break;removed.add(index);bytes-=sizes[index]+(count>1?1:0);count--;}
    if(removed.size)this.entries=this.entries.filter((_,index)=>!removed.has(index));
  }
  _schedule() {
    this._dirty=true;if(this.readOnly||this._closed)return;
    if(!this._firstDirty)this._firstDirty=Date.now();if(this._timer)clearTimeout(this._timer);
    const delay=Math.max(0,Math.min(350,2000-(Date.now()-this._firstDirty)));
    this._timer=setTimeout(()=>{this._timer=null;this.flush().catch(()=>{});},delay);this._timer.unref?.();
  }
  _writable(){if(this._closed)throw new Error('Query history is closed.');if(this.readOnly)throw new Error(this.warning);}
  record(input) {
    if(this._closed)return{recorded:false,reason:'History is closed.'};
    if(this.readOnly)return{recorded:false,reason:this.warning};
    if(this.preferences.paused||input?.private===true)return{recorded:false,reason:'Query history capture is paused.'};
    if(typeof input?.sql==='string'&&Buffer.byteLength(input.sql,'utf8')>MAX_SQL_BYTES)return{recorded:false,reason:'Query exceeds the 256 KiB history limit. SQL executed normally; its text was not stored.'};
    const entry=this._normalize(input);if(!entry)return{recorded:false,reason:'Query history requires a valid connection and SQL text.'};
    if(this.entries.some(previous=>previous.id===entry.id))entry.id=randomUUID();
    this.entries.unshift(entry);this._prune();this._schedule();return this.entries.some(previous=>previous.id===entry.id)?{recorded:true,entry:{...entry}}:{recorded:false,reason:'History retention limits kept existing favorites; this query was not stored.'};
  }
  list({profileId,search='',status='all',favoritesOnly=false,offset=0,limit=50,from,to}={}) {
    if(!this.readOnly&&!this._closed){const previous=this.entries.length;this._prune();if(previous!==this.entries.length)this._schedule();}
    if(typeof profileId!=='string'||!profileId)return{items:[],total:0,offset:0,limit:50,settings:{...this.preferences},warning:this.warning,limits:{maxSqlBytes:MAX_SQL_BYTES,maxFileBytes:MAX_FILE_BYTES}};
    if(typeof search!=='string'||search.length>1000)throw new Error('Search query history with up to 1000 characters.');
    if(!['all','success','error'].includes(status))throw new Error('Choose a valid history status.');
    if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Choose a valid history page.');
    const after=from?Date.parse(from):null,before=to?Date.parse(to):null;
    if(from&&!Number.isFinite(after)||to&&!Number.isFinite(before))throw new Error('Choose valid history dates.');
    const needle=search.toLocaleLowerCase();
    const found=this.entries.filter(entry=>entry.profileId===profileId&&(!favoritesOnly||entry.favorite)&&(status==='all'||entry.status===status)&&(!needle||[entry.sql,entry.title,entry.connection,entry.schema].some(value=>value.toLocaleLowerCase().includes(needle)))&&(after===null||Date.parse(entry.timestamp)>=after)&&(before===null||Date.parse(entry.timestamp)<=before));
    return{items:found.slice(offset,offset+limit).map(entry=>({...entry})),total:found.length,connectionTotal:this.entries.filter(entry=>entry.profileId===profileId).length,offset,limit,settings:{...this.preferences},warning:this.warning,limits:{maxSqlBytes:MAX_SQL_BYTES,maxFileBytes:MAX_FILE_BYTES}};
  }
  update(value,profileId) {
    this._writable();if(!value||typeof value.id!=='string')throw new Error('Choose a history entry.');
    const entry=this.entries.find(entry=>entry.id===value.id&&entry.profileId===profileId);if(!entry)throw new Error('This history entry is unavailable for the current connection.');
    if(Object.hasOwn(value,'title')){if(typeof value.title!=='string'||value.title.length>160)throw new Error('Use a query title up to 160 characters.');const title=redactSql(value.title.trim());entry.title=title.sql;entry.redacted=entry.redacted||title.redacted;}
    if(Object.hasOwn(value,'favorite')){if(typeof value.favorite!=='boolean')throw new Error('Favorite must be enabled or disabled.');entry.favorite=value.favorite;}
    this._prune();this._schedule();return{...entry};
  }
  remove(id,profileId){this._writable();const previous=this.entries.length;this.entries=this.entries.filter(entry=>entry.id!==id||entry.profileId!==profileId);if(previous!==this.entries.length)this._schedule();return{removed:previous!==this.entries.length};}
  clear(profileId){this._writable();if(typeof profileId!=='string'||!profileId)throw new Error('Connect to a database before clearing its history.');const previous=this.entries.length;this.entries=this.entries.filter(entry=>entry.profileId!==profileId);if(previous!==this.entries.length)this._schedule();return{removed:previous-this.entries.length};}
  settings(patch){if(patch!==undefined){this._writable();this.preferences=settingsValue(patch,this.preferences);this._prune();this._schedule();}return{...this.preferences};}
  async flush(){
    if(this._timer){clearTimeout(this._timer);this._timer=null;}
    if(this.readOnly)return false;
    if(this._writePromise){await this._writePromise;if(!this._dirty)return !this.warning;}
    if(!this._dirty)return !this.warning;
    this._writePromise=(async()=>{
      while(this._dirty){
        this._dirty=false;this._firstDirty=0;this._prune();
        const temporary=this.filePath+'.'+randomUUID()+'.tmp';
        try{await fsp.writeFile(temporary,JSON.stringify({version:2,settings:this.preferences,entries:this.entries}),{encoding:'utf8',flag:'wx',mode:0o600});await fsp.rename(temporary,this.filePath);this.warning='';}
        catch{await fsp.rm(temporary,{force:true}).catch(()=>{});this.warning='Query history could not be saved. SQL results are unaffected. Check available disk space and folder permissions.';return false;}
      }
      return true;
    })();
    try{return await this._writePromise;}finally{this._writePromise=null;}
  }
  async close(){if(this._closed)return;this._closed=true;await this.flush();}
}
module.exports={HistoryStore,MAX_FILE_BYTES,MAX_SQL_BYTES,DEFAULTS};
