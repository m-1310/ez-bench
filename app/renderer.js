'use strict';
const api=window.querydesk;
const $=selector=>document.querySelector(selector);
const icon=name=>window.BenchIcons.icon(name);
const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
window.BenchIcons.hydrate();
const ENGINES={mysql:{name:'MySQL',port:3306},mariadb:{name:'MariaDB',port:3306},postgres:{name:'PostgreSQL',port:5432},mssql:{name:'SQL Server',port:1433},sqlite:{name:'SQLite'},demo:{name:'SQLite'}};
const demoProfile={id:'playground',mode:'demo',name:'Local playground',database:'main'};
const initialSql='-- Explore the sample database\nSELECT\n  c.name, c.city,\n  COUNT(o.id) AS orders,\n  ROUND(SUM(o.total), 2) AS total_spent\nFROM customers AS c\nJOIN orders AS o ON o.customer_id = c.id\nGROUP BY c.id, c.name, c.city\nORDER BY total_spent DESC;';
let profiles=[],current=null,schemas=[],selectedSchema='',result=null,resultSets=[],resultSort=null;
let busy=false,runningQuery=false,stopOnError=true,tabCount=1,activeTab=1;
const collapsedSchemas=new Map();
let tabs=[{id:1,name:'Query 1',sql:initialSql,result:null,message:''}],workspaces=Object.create(null);
let workspaceKey='',workspaceReady=false;
let connectionDraft=false;
function toast(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>{$('#toast').hidden=true;},4500);}
function status(text,type=''){const node=$('#result-message');node.replaceChildren(icon(type==='error'?'circle-alert':type==='working'?'clock-3':'circle-check'),document.createTextNode(text.replace(/^✓\s*/,'')));node.className='result-message '+type;node.title=text+' · Double-click for full details';}
function setBusy(value){busy=value;for(const id of ['run-query','run-script','disconnect','begin-transaction','commit-transaction','rollback-transaction'])$('#'+id).disabled=value;$('#run-query .button-label').textContent=value?'Working…':'Run';window.BenchTables?.updateToolbar(result);}
const MAX_TABS=30,MAX_CACHED_RESULTS=4;
let persistenceTimer=null,lastHighlighted=null;
function protectedSql(tab){return Boolean(tab.sql)&&(tab.privateQuery||BenchSqlPrivacy.redactSql(tab.sql).hasSecrets);}
function fileChanged(tab){return Boolean(tab.file)&&tab.savedSql!==tab.sql;}
function hasPrivateDraft(){return tabs.some(tab=>protectedSql(tab)&&tab.savedSql!==tab.sql);}
function recoveryTab(tab,fileDirty){return {
  id:tab.id,name:BenchSqlPrivacy.redactSql(tab.name).sql,sql:protectedSql(tab)?'':tab.sql,
  privateQuery:Boolean(tab.privateQuery),file:Boolean(tab.file),fileDirty,
};}
function validTab(tab){return tab&&Number.isInteger(tab.id)&&typeof tab.name==='string'&&typeof tab.sql==='string';}
async function flushEditorState(){
  if(persistenceTimer){clearTimeout(persistenceTimer);persistenceTimer=null;}
  if(!workspaceReady)return true;
  workspaces[workspaceKey]={tabs:tabs.map(tab=>recoveryTab(tab,fileChanged(tab))),activeTab,tabCount};
  const preferences={theme:document.documentElement.dataset.theme,sidebar:document.body.classList.contains('sidebar-collapsed'),
    wrap:$('#sql-editor').wrap!=='off',stopOnError,editorHeight:parseInt($('.editor-area').style.height,10)||0};
  try{return await api.saveWorkspace({workspaceKey,workspaces,preferences});}catch{return false;}
}
function restoreTabs(saved){
  if(!Array.isArray(saved?.tabs))return false;
  const recovered=saved.tabs.filter(validTab).slice(0,MAX_TABS);
  if(!recovered.length)return false;
  tabs=recovered.map(tab=>({...tab,savedSql:tab.file&&!tab.fileDirty?tab.sql:null,result:null,resultSets:[],message:''}));
  tabCount=Math.max(tabCount,Number.isSafeInteger(saved.tabCount)?saved.tabCount:0,...tabs.map(tab=>tab.id));
  activeTab=tabs.some(tab=>tab.id===saved.activeTab)?saved.activeTab:tabs[0].id;
  return true;
}
function unsavedWarnings(){
  const warnings=[];
  if(hasPrivateDraft())warnings.push('Private or credential-bearing SQL is not autosaved. Save it as a SQL file before leaving.');
  if(tabs.some(fileChanged))warnings.push('Changes to an opened SQL file have not been saved to that file. Recoverable edits are kept in EZ Bench.');
  if([result,...tabs.map(tab=>tab.result)].some(BenchTables.dirty))warnings.push('Table edits have not been applied. Apply your changes before closing or they will be lost.');
  if(connectionDraft&&$('#connection-dialog').open)warnings.push('The connection form has unsaved changes. Save the connection profile to keep its settings.');
  if(busy)warnings.push('A database operation is still running. Wait for it to finish before closing.');
  return warnings;
}
function saveTab(){const tab=tabs.find(item=>item.id===activeTab);if(!tab)return;tab.sql=$('#sql-editor').value;tab.privateQuery=$('#private-query').checked;tab.result=result;tab.resultSets=resultSets;tab.message=$('#result-message').textContent;tab.touched=Date.now();
  const cached=tabs.filter(tab=>tab.result||tab.resultSets?.length).sort((a,b)=>(b.touched||0)-(a.touched||0));for(const old of cached.slice(MAX_CACHED_RESULTS)){if(old.id!==activeTab&&!BenchTables.dirty(old.result)){old.result=null;old.resultSets=[];old.message='Cached result released to save memory. Run SQL or reload the table.';}}
  if(!persistenceTimer)persistenceTimer=setTimeout(flushEditorState,500);
}
function highlightSql(){
  const text=$('#sql-editor').value;if(text===lastHighlighted)return syncScroll();lastHighlighted=text;const plain=text.length>100000;$('.editor-area').classList.toggle('plain-sql',plain);if(plain){$('#syntax-highlight').replaceChildren();return;}const fragment=document.createDocumentFragment();
  const token=/(--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z_0-9]*\b)/g;
  const keywords=new Set('SELECT FROM WHERE JOIN INNER LEFT RIGHT OUTER ON GROUP BY ORDER ASC DESC LIMIT OFFSET TOP AS AND OR NOT NULL IS IN LIKE BETWEEN HAVING DISTINCT CASE WHEN THEN ELSE END INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE VIEW INDEX DROP ALTER ADD PRIMARY KEY FOREIGN REFERENCES DEFAULT UNIQUE CHECK BEGIN COMMIT ROLLBACK WITH UNION ALL EXISTS RETURNING USE SHOW DATABASES EXPLAIN PRAGMA IF TRANSACTION GENERATED IDENTITY'.split(' '));
  const functions=new Set('COUNT SUM AVG MIN MAX ROUND COALESCE IFNULL CONCAT LENGTH LOWER UPPER DATE DATETIME NOW VERSION'.split(' '));let position=0;
  for(const match of text.matchAll(token)){fragment.append(document.createTextNode(text.slice(position,match.index)));const value=match[0];const type=value.startsWith('--')||value.startsWith('/*')?'comment':/^['"]/.test(value)?'string':/^\d/.test(value)?'number':keywords.has(value.toUpperCase())?'keyword':functions.has(value.toUpperCase())?'function':'';fragment.append(type?el('span','syntax-'+type,value):document.createTextNode(value));position=match.index+value.length;}
  fragment.append(document.createTextNode(text.slice(position)+'\n'));$('#syntax-highlight').replaceChildren(fragment);syncScroll();
}
function syncScroll(){$('#line-numbers').scrollTop=$('#sql-editor').scrollTop;$('#syntax-highlight').scrollTop=$('#sql-editor').scrollTop;$('#syntax-highlight').scrollLeft=$('#sql-editor').scrollLeft;}
function editorPosition(){const editor=$('#sql-editor'),before=editor.value.slice(0,editor.selectionStart).split('\n');$('#editor-position').textContent=`Ln ${before.length}, Col ${before.at(-1).length+1}`;$('#line-numbers').textContent=editor.value.split('\n').map((_,i)=>i+1).join('\n');highlightSql();}
async function closeTab(id=activeTab){
  if(busy||tabs.length<=1)return false;
  saveTab();const closing=tabs.find(tab=>tab.id===id);
  if(!closing||!await BenchTables.guard(closing.result))return false;
  // Another close may finish while the dirty-result confirmation is pending.
  const index=tabs.findIndex(tab=>tab.id===id);
  if(tabs.length<=1||index<0)return false;
  BenchTabs.remember(closing);tabs=tabs.filter(tab=>tab.id!==id);
  if(activeTab===id)activeTab=tabs[Math.max(0,index-1)].id;
  loadTab();saveTab();return true;
}
function renderTabs(){$('#query-tabs').replaceChildren();for(const tab of tabs){const button=el('button','query-tab'+(tab.id===activeTab?' active':''));const mark=el('span','sql-icon');mark.append(icon('file-code-2'));const close=el('span','tab-close');close.append(icon('x'));close.title=tabs.length<=1?'Keep at least one query tab open':'Close query tab';close.addEventListener('click',event=>{event.stopPropagation();closeTab(tab.id);});close.setAttribute('role','button');close.setAttribute('aria-label','Close '+tab.name);close.setAttribute('aria-disabled',String(tabs.length<=1));close.tabIndex=tabs.length<=1?-1:0;close.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();closeTab(tab.id);}});button.append(mark,el('span','',tab.name),close);BenchTabs.bind(button,tab);button.addEventListener('click',()=>{if(busy)return;saveTab();activeTab=tab.id;loadTab();});$('#query-tabs').append(button);}}
function loadTab(){const tab=tabs.find(item=>item.id===activeTab);$('#private-query').checked=Boolean(tab.privateQuery);$('#sql-editor').value=tab.sql;$('#sql-editor').scrollLeft=0;$('#sql-editor').scrollTop=0;result=tab.result;resultSets=tab.resultSets||[];resultSort=null;renderTabs();renderResultSets();renderResult();status(tab.message||'Ready to run SQL.');editorPosition();showPanel('results');}
function addTab(sql='',name,options={}){if(tabs.length>=MAX_TABS){toast('Keep up to 30 SQL tabs open. Close a tab before opening another.');return false;}saveTab();const id=++tabCount;tabs.push({id,name:name||`Query ${id}`,sql,privateQuery:Boolean(options.privateQuery),result:null,message:''});activeTab=id;showWorkspace();loadTab();saveTab();$('#sql-editor').focus();return true;}
function showPanel(name){for(const panel of ['results','history','structure','database']){$('#'+(panel==='results'?'result':panel)+'-panel').hidden=panel!==name;$('#'+panel+'-tab').classList.toggle('active',panel===name);}$('#result-tools').hidden=name!=='results';$('#editor-view').classList.toggle('history-expanded',name==='history');if(name==='history')loadHistory();if(name==='database')loadDatabaseInfo();}
function renderResultSets(){$('#result-sets').replaceChildren();$('#result-sets').hidden=resultSets.length<2;for(const [i,item]of resultSets.entries()){const button=el('button','result-set'+(result===item?' active':'')+(item.error?' error':''));button.append(icon(item.error?'circle-alert':'table-2'),document.createTextNode(`Statement ${item.statementIndex||i+1}`));button.title=item.sql||'';button.addEventListener('click',()=>{result=item;resultSort=null;renderResultSets();renderResult();status(item.error||`${item.rowCount} rows returned · ${item.elapsedMs} ms`,item.error?'error':'');saveTab();});$('#result-sets').append(button);}}
function renderResult(){
  BenchTables.updateToolbar(result);const hasColumns=Boolean(result?.columns?.length);$('#table-scroll').hidden=!hasColumns;$('#result-empty').hidden=hasColumns;$('#rows-badge').textContent=result?.rowCount||0;$('#export-csv').disabled=!hasColumns;$('#export-json').disabled=!hasColumns;$('#result-table').replaceChildren();$('#execution-log')?.remove();
  if(!hasColumns){if(result){$('#result-empty').hidden=true;const log=el('div','execution-log');log.id='execution-log';log.textContent=result.error||(result.resultOmitted?'Result released to keep script memory bounded. Export data with a targeted query or full backup.':`Statement completed. ${result.affectedRows||0} rows affected.\n${result.elapsedMs||0} ms`);if(result.error)log.classList.add('error');$('#result-panel').append(log);}return;}
  const head=el('thead'),header=el('tr');header.append(el('th','row-number','#'));
  for(const column of result.columns){const key=column.key||column.name,th=el('th','sortable',column.name);th.append(icon(resultSort?.name===key?(resultSort.direction===1?'arrow-up':'arrow-down'):'arrow-up-down'));th.tabIndex=0;th.title='Sort displayed rows';const sort=()=>{resultSort={name:key,direction:resultSort?.name===key?-resultSort.direction:1};renderResult();};th.addEventListener('click',sort);th.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' ')sort();});header.append(th);}head.append(header);$('#result-table').append(head);
  const rows=BenchTables.displayRows(result),body=el('tbody'),filter=$('#result-filter').value.toLowerCase();
  if(resultSort)rows.sort((a,b)=>{const x=a.row[resultSort.name],y=b.row[resultSort.name];return resultSort.direction*(x==null?y==null?0:-1:y==null?1:typeof x==='number'&&typeof y==='number'?x-y:String(x).localeCompare(String(y),undefined,{numeric:true}));});
  rows.forEach((entry,i)=>{const row=entry.row;if(filter&&!Object.values(row).some(value=>String(value??'NULL').toLowerCase().includes(filter)))return;const tr=el('tr');tr.append(el('td','row-number',i+1));for(const column of result.columns){const value=row[column.key||column.name],td=el('td',value==null?'null-value':'',value==null?'NULL':typeof value==='object'?JSON.stringify(value):String(value));td.title='Double-click or F2 to view full text';if(!result.table||!result.editable||column.editable===false){td.tabIndex=0;td.addEventListener('dblclick',()=>BenchEditor.viewCell(value,column));td.addEventListener('keydown',event=>{if(event.key==='F2'||event.key==='Enter'){event.preventDefault();BenchEditor.viewCell(value,column);}});}tr.append(td);}BenchTables.decorate(result,tr,entry);body.append(tr);});$('#result-table').append(body);
}
function invalidateConnection(){current=null;$('#schema-section').hidden=true;$('#connection-status').textContent='Disconnected · reconnect to continue';$('#status-indicator').style.background='var(--muted)';renderConnections();}
async function runQuery(overrideSql){
  if(busy)return;if(!await BenchTables.guard()||busy)return;if(!current)return status('Connect to a database first.','error');const editor=$('#sql-editor'),selection=editor.value.slice(editor.selectionStart,editor.selectionEnd).trim();const dialect=['demo','sqlite'].includes(current.mode)?'sqlite':current.mode==='mariadb'?'mysql':current.mode;const sql=typeof overrideSql==='string'?overrideSql:selection||BenchSqlText.statementAt(editor.value,editor.selectionStart,dialect)?.sql.trim()||'';if(!sql)return status('Write a SQL statement first.','error');
  runningQuery=true;$('#cancel-query').hidden=false;setBusy(true);status('Executing query…','working');showPanel('results');$('#result-filter').value='';
  try{result=await api.query({sql,schema:selectedSchema,private:$('#private-query').checked});resultSets=[];renderResultSets();resultSort=null;renderResult();if(result.schema){selectedSchema=result.schema;$('#schema-select').value=selectedSchema;}status(`${result.columns.length?`${result.rowCount} row${result.rowCount===1?'':'s'} returned`:`${result.affectedRows} row${result.affectedRows===1?'':'s'} affected`} · ${result.elapsedMs} ms${result.truncated?(result.limitReason==='bytes'?' · Result reached the 2 MiB display limit':' · Showing the first 1,000 rows'):''}`);if(!result.columns.length)await refreshSchemas();}
  catch(error){result=null;resultSets=[];renderResultSets();renderResult();status(error.message,'error');if(/Reconnect to continue/.test(error.message))invalidateConnection();}
  finally{runningQuery=false;$('#cancel-query').hidden=true;setBusy(false);saveTab();}
}
async function runScript(){if(busy)return;if(!await BenchTables.guard()||busy)return;if(!current)return status('Connect to a database first.','error');const sql=$('#sql-editor').value;if(!sql.trim())return status('Write a SQL script first.','error');runningQuery=true;$('#cancel-query').hidden=false;setBusy(true);status('Running script…','working');showPanel('results');$('#result-filter').value='';try{const output=await api.script({sql,schema:selectedSchema,stopOnError,private:$('#private-query').checked});resultSets=output.results;result=resultSets.at(-1)||null;resultSort=null;renderResultSets();renderResult();const error=output.errors.at(-1);status(error?`Statement ${error.index}: ${error.message}${output.stopped?' · Script stopped':''}`:`${output.results.length} statements completed`,error?'error':'');if(result?.schema)selectedSchema=result.schema;await refreshSchemas();if(error&&/Reconnect to continue/.test(error.message))invalidateConnection();}catch(error){status(error.message,'error');if(/Reconnect to continue/.test(error.message))invalidateConnection();}finally{runningQuery=false;$('#cancel-query').hidden=true;setBusy(false);saveTab();}}
async function loadHistory(){return BenchHistory.load();}
async function refreshSchemas(){if(!current)return;try{schemas=await api.schemas();if(!schemas.some(schema=>schema.name===selectedSchema))selectedSchema=schemas[0]?.name||'';renderSchemas();}catch(error){$('#schema-tree').replaceChildren(el('p','schema-error',error.message));}}
function renderSchemas(){
  $('#schema-select').replaceChildren();for(const schema of schemas){const option=el('option','',schema.name);option.value=schema.name;$('#schema-select').append(option);}$('#schema-select').value=selectedSchema;
  const filter=$('#schema-filter').value.toLowerCase();$('#schema-tree').replaceChildren();
  for(const schema of schemas){const tables=schema.tables.filter(table=>table.name.toLowerCase().includes(filter));if(!tables.length&&filter)continue;const group=el('div','schema-group'),heading=el('div','schema-name'),list=el('div','schema-tables');const collapsed=!filter&&(collapsedSchemas.has(schema.name)?collapsedSchemas.get(schema.name):schema.name!==selectedSchema);list.hidden=collapsed;heading.setAttribute('aria-expanded',String(!collapsed));heading.append(icon(collapsed?'chevron-right':'chevron-down'),el('strong','',schema.name),el('small','',tables.length));heading.tabIndex=0;heading.setAttribute('role','button');heading.setAttribute('aria-label','Toggle schema '+schema.name);const toggle=()=>{list.hidden=!list.hidden;collapsedSchemas.set(schema.name,list.hidden);heading.setAttribute('aria-expanded',String(!list.hidden));heading.firstChild.replaceWith(icon(list.hidden?'chevron-right':'chevron-down'));};heading.addEventListener('click',toggle);heading.addEventListener('keydown',event=>{if(event.key==='Enter')toggle();});group.append(heading,list);
    for(const table of tables){const row=el('div','table-row'),button=el('button');button.append(icon(table.type==='view'?'eye':'table-2'),el('span','table-name',table.name));button.title='Open '+table.name+' rows';button.addEventListener('click',()=>previewTable(schema.name,table.name));const info=el('button','table-info');info.append(icon('info'));info.setAttribute('aria-label',`Inspect ${table.name} columns`);info.addEventListener('click',()=>inspectTable(schema.name,table.name));row.append(button,info);list.append(row);}$('#schema-tree').append(group);
  }$('#schema-tree').append(el('p','schema-hint',schemas.some(schema=>schema.tables.length)?'Click a table to edit rows. Info shows columns and keys.':'No tables yet. Use New table to prepare a CREATE TABLE statement.'));
}
function quoteName(name){if(current?.mode==='postgres')return '"'+name.replaceAll('"','""')+'"';if(current?.mode==='mssql')return '['+name.replaceAll(']',']]')+']';return '`'+name.replaceAll('`','``')+'`';}
async function previewTable(schema,table){await BenchTables.load(schema,table);}
async function inspectTable(schema,table){if(busy)return;try{const columns=await api.columns({schema,table}),title=el('h3','structure-title');title.append(icon('table-2'),document.createTextNode(schema+'.'+table));$('#structure-panel').replaceChildren(title);const grid=el('table'),heading=el('tr');['Column','Type','Nullable','Key'].forEach(text=>heading.append(el('th','',text)));grid.append(heading);for(const column of columns){const row=el('tr');[column.name,column.type,column.nullable?'Yes':'No',column.primaryKey?'PRIMARY':''].forEach(text=>row.append(el('td','',text)));grid.append(row);}$('#structure-panel').append(grid);showPanel('structure');}catch(error){toast(error.message);}}
async function loadDatabaseInfo(){const panel=$('#database-panel');if(!current){panel.replaceChildren(el('p','subtle','Connect to a database to see its details.'));return;}panel.replaceChildren(el('p','subtle','Reading database information…'));try{const info=await api.info(),heading=el('div','info-heading'),text=el('div');text.append(el('h3','',info.engine),el('p','',current.name));heading.append(icon('server'),text);panel.replaceChildren(heading);const grid=el('dl','info-grid');for(const [label,value]of Object.entries({Version:info.version,Database:info.database,Schema:info.schema,Server:info.server,User:info.user,TLS:info.connection?.tls?'Enabled':'Not enabled',Transport:info.connection?.ssh?.enabled?'SSH tunnel':'Direct',...(info.connection?.ssh?.enabled?{'SSH gateway':info.connection.ssh.host+':'+info.connection.ssh.port,'SSH user':info.connection.ssh.user,'SSH host key':info.connection.ssh.hostFingerprint}:{}),Transaction:info.transaction===null?'Not observed':info.transaction?'Active':'No active transaction'})){const item=el('div','info-item');item.append(el('dt','',label),el('dd','',value==null||value===''?'—':typeof value==='object'?JSON.stringify(value):String(value)));grid.append(item);}panel.append(grid,el('p','info-notice','Read from the connected database. Database information does not change your data.'));}catch(error){panel.replaceChildren(el('p','schema-error',error.message));}}
function showHome(){$('#home-view').hidden=false;$('#editor-view').hidden=true;$('#home-button').classList.add('active');updateResumeControl();}
function updateResumeControl(){$('#overview-resume-sql').hidden=!(tabs.length>1||tabs.some(tab=>tab.sql&&tab.sql!==initialSql));}
function showWorkspace(){$('#home-view').hidden=true;$('#editor-view').hidden=false;$('#home-button').classList.remove('active');if(!current){$('#workspace-name').textContent='SQL workspace';$('#dialect-badge').textContent='Not connected';$('#workspace-detail').textContent='Choose a connection to run SQL';}}
async function connect(profile){if(busy||!workspaceReady)return false;if(!await BenchTables.guard(result,true)||busy)return false;saveTab();
  const switching=workspaceKey!==profile.id;
  if(switching&&hasPrivateDraft()){await api.warnUnsavedWork(['Save private or credential-bearing SQL as a SQL file before switching connections.']);return false;}
  const editor=$('#sql-editor');editor.readOnly=true;setBusy(true);try{const connection=await api.connect(profile);BenchTabs.reset();collapsedSchemas.clear();current=connection.profile;selectedSchema=connection.schema||connection.database||'';$('#workspace-name').textContent=profile.name;$('#dialect-badge').textContent=connection.dialect;$('#editor-dialect').textContent=connection.dialect;$('#workspace-detail').textContent=profile.mode==='demo'?'Local sample database':profile.mode==='sqlite'?'Local SQLite file':`${profile.user}@${profile.host}:${profile.port}${profile.ssh?.enabled?' via SSH':''}`;$('#workspace-detail').title=profile.filePath||'';$('#connection-status').textContent=`Connected · ${profile.name}`;$('#status-indicator').style.background='var(--success)';$('#schema-section').hidden=false;
    if(switching){
      flushEditorState();
      const carryDraft=!workspaceKey&&(profile.mode==='demo'||tabs.length>1||tabs[0].sql!==initialSql);
      workspaceKey=profile.id;
      if(!restoreTabs(workspaces[workspaceKey])&&!carryDraft){const sample=profile.mode==='demo'?initialSql:profile.mode==='mssql'?'SELECT @@VERSION AS server_version;':profile.mode==='sqlite'?'SELECT sqlite_version() AS sqlite_version;':'SELECT VERSION() AS server_version;';tabs=[{id:++tabCount,name:'Query '+tabCount,sql:sample,result:null,message:''}];activeTab=tabCount;}
    }
    for(const tab of tabs){tab.result=null;tab.resultSets=[];tab.message='';}
    await refreshSchemas();renderConnections();showWorkspace();loadTab();saveTab();if($('#connection-dialog').open)$('#connection-dialog').close();$('#connection-form').elements.password.value='';BenchSsh.clearSecrets();return true;
  }catch(error){try{await api.disconnect();}catch{}current=null;$('#schema-section').hidden=true;$('#connection-status').textContent='No active connection';$('#status-indicator').style.background='var(--muted)';showHome();renderConnections();if($('#connection-dialog').open)$('#connection-error').textContent=error.message;else toast(error.message);return false;}finally{editor.readOnly=false;setBusy(false);}}
function renderConnections(){
  $('#connections-list').replaceChildren();$('#connection-cards').replaceChildren();$('#connection-count').textContent=profiles.length;const filter=$('#connection-search').value.toLowerCase();
  for(const profile of [demoProfile,...profiles]){const local=['sqlite','demo'].includes(profile.mode),button=el('button','connection-item'+(current?.id===profile.id?' selected':'')),mark=el('span','db-dot');mark.append(icon(local?'hard-drive':'database'));const text=el('div','',profile.name);text.append(el('small','',profile.mode==='demo'?'SQLite · local playground':profile.mode==='sqlite'?'SQLite · local file':ENGINES[profile.mode].name+' · '+profile.host+':'+profile.port+BenchSsh.badge(profile)));button.append(mark,text);button.title=profile.name+' · '+text.querySelector('small').textContent;button.setAttribute('aria-label',button.title);button.setAttribute('aria-pressed',String(current?.id===profile.id));button.addEventListener('click',()=>{if(busy)return;if(current?.id===profile.id)showWorkspace();else if(local)connect(profile);else openConnection(profile);});$('#connections-list').append(button);
    if(profile.mode==='demo'||filter&&!`${profile.name} ${profile.host||''} ${ENGINES[profile.mode].name}`.toLowerCase().includes(filter))continue;
    const card=el('button','connection-card'),top=el('div','connection-card-top'),mark2=el('span','connection-card-icon');mark2.append(icon(local?'hard-drive':'database'));top.append(mark2,el('span','connection-card-badge',ENGINES[profile.mode].name.toUpperCase()));const subtitle=local?profile.filePath:`${profile.user}@${profile.host}:${profile.port}${BenchSsh.badge(profile)}`,sub=el('p','',subtitle);sub.title=subtitle;card.append(top,el('strong','',profile.name),sub);card.addEventListener('click',()=>{if(!busy)local?connect(profile):openConnection(profile);});const wrap=el('div','connection-card-wrap'),remove=el('button','remove-profile');remove.append(icon('trash-2'));remove.title='Remove saved profile (the database is kept)';remove.setAttribute('aria-label','Remove profile '+profile.name);remove.addEventListener('click',async()=>{if(busy)return;try{await api.removeProfile(profile.id);profiles=await api.profiles();renderConnections();toast('Profile removed. The database was kept.');}catch(error){toast(error.message);}});const edit=el('button','edit-profile');edit.append(icon('pencil'));edit.title='Edit connection';edit.setAttribute('aria-label','Edit connection '+profile.name);edit.addEventListener('click',()=>openConnection(profile));wrap.append(card,edit,remove);$('#connection-cards').append(wrap);
  }
  const cards=$('#connection-cards');
  if(!cards.children.length){
    const empty=el('div','connection-empty'),heading=el('h3','',profiles.length?'No matching connections':'No saved connections');
    const detail=el('p','',profiles.length?'Try a different name, host or database engine.':'Your saved servers and local files will appear here.');
    const action=el('button','button'+(profiles.length?'':' primary'));
    empty.append(icon(profiles.length?'search':'plug'),heading,detail);
    if(profiles.length){action.textContent='Clear search';action.addEventListener('click',()=>{$('#connection-search').value='';renderConnections();$('#connection-search').focus();});}
    else{action.append(icon('plus'),document.createTextNode('Add connection'));action.addEventListener('click',()=>openConnection());}
    empty.append(action);cards.append(empty);
  }else{
    const add=el('button','connection-card add-card');add.append(icon('plus'),document.createTextNode('Add connection'));add.addEventListener('click',()=>openConnection());cards.append(add);
  }
}
function configureEngine(resetPort=true){const form=$('#connection-form'),mode=form.elements.mode.value,local=mode==='sqlite';$('#network-fields').hidden=local;$('#sqlite-fields').hidden=!local;for(const name of ['host','port','user'])form.elements[name].required=!local;form.elements.filePath.required=local;form.elements.database.required=mode==='postgres';if(resetPort&&!local){form.elements.port.value=ENGINES[mode].port;form.elements.user.value=mode==='postgres'?'postgres':mode==='mssql'?'sa':'root';}$('#connection-test-result').hidden=true;$('#connection-error').textContent='';BenchSsh.configure();}
function openConnection(profile){if(busy)return;const form=$('#connection-form');form.reset();form.dataset.profileId=profile?.id||'';for(const key of ['mode','name','host','port','user','database','filePath'])if(profile?.[key]!==undefined)form.elements[key].value=profile[key];form.elements.tls.checked=Boolean(profile?.tls);form.elements.password.value='';BenchSsh.load(profile);configureEngine(false);$('#connection-dialog').showModal();}
function readProfile(){const form=$('#connection-form'),profile=Object.fromEntries(new FormData(form));profile.id=form.dataset.profileId||crypto.randomUUID();profile.port=Number(profile.port);profile.tls=form.elements.tls.checked;return BenchSsh.read(profile);}
async function saveConnection(){if(!$('#connection-form').reportValidity())return;try{await api.saveProfile(readProfile());profiles=await api.profiles();renderConnections();$('#connection-dialog').close();toast('Connection profile saved. Password was not stored.');}catch(error){$('#connection-error').textContent=error.message;}}
async function testConnection(){if(!$('#connection-form').reportValidity())return;const node=$('#connection-test-result');node.hidden=false;node.className='';node.textContent='Testing connection…';$('#test-connection').disabled=true;try{const output=await api.testConnection(readProfile());node.textContent=`Connected successfully · ${output.info.engine} ${output.info.version}${readProfile().ssh?.enabled?' · SSH tunnel verified':''}`;}catch(error){node.className='error';node.textContent='Connection failed: '+error.message;}finally{$('#test-connection').disabled=false;}}
async function openLocal(create){if(busy)return;try{const profile=await api.pickLocalDatabase({create});if(!profile)return;const existing=profiles.find(item=>item.mode==='sqlite'&&item.filePath===profile.filePath),saved=await api.saveProfile({...profile,...(existing?{id:existing.id}:{})});profiles=await api.profiles();renderConnections();await connect(saved);}catch(error){toast(error.message);}}
async function formatSql(){if(busy)return;try{$('#sql-editor').value=await api.formatSql({sql:$('#sql-editor').value,dialect:current?.mode||$('#connection-engine').value});$('#sql-editor').scrollLeft=0;$('#sql-editor').scrollTop=0;editorPosition();saveTab();}catch(error){toast('Could not format this SQL: '+error.message);}}
function renderThemeControl(){const dark=document.documentElement.dataset.theme==='dark',control=$('#theme-toggle');control.replaceChildren(icon(dark?'sun':'moon'),el('span','utility-label',dark?'Use light theme':'Use dark theme'));const hint=el('kbd','',BenchCommands.commands.find(command=>command.id==='theme-toggle').accelerator.replace('CmdOrCtrl','Ctrl'));control.append(hint);control.title=(dark?'Switch to light theme':'Switch to dark theme')+' · '+hint.textContent;}
function toggleTheme(){const next=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=next;renderThemeControl();flushEditorState();}
function setSidebarCollapsed(collapsed){document.body.classList.toggle('sidebar-collapsed',collapsed);$('#sidebar-toggle').setAttribute('aria-expanded',String(!collapsed));}
function setWordWrap(wrap){$('#sql-editor').wrap=wrap?'soft':'off';$('.editor-area').classList.toggle('wrapped',wrap);$('#wrap-toggle').setAttribute('aria-pressed',String(wrap));highlightSql();}
function newTable(){if(busy||!current)return;const id=current.mode==='mssql'?'BIGINT IDENTITY(1,1) PRIMARY KEY':current.mode==='postgres'?'BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY':['mysql','mariadb'].includes(current.mode)?'BIGINT AUTO_INCREMENT PRIMARY KEY':'INTEGER PRIMARY KEY';const type=['sqlite','demo'].includes(current.mode)?'TEXT':'VARCHAR(255)';addTab(`CREATE TABLE new_table (\n  id ${id},\n  name ${type} NOT NULL\n);`,'New table');}
async function disconnect(){if(busy)return;if(!await BenchTables.guard(result,true))return;try{saveTab();await api.disconnect();current=null;schemas=[];$('#schema-section').hidden=true;$('#connection-status').textContent='No active connection';$('#status-indicator').style.background='var(--muted)';showHome();renderConnections();}catch(error){toast(error.message);}}
async function transaction(command){if(busy||!current)return;await runQuery(command==='begin'?(current.mode==='mssql'?'BEGIN TRANSACTION':'BEGIN'):command==='commit'?'COMMIT':'ROLLBACK');}
$('#demo-connect').addEventListener('click',()=>connect(demoProfile));
for(const id of ['new-connection','sidebar-new','quick-new'])$('#'+id).addEventListener('click',()=>openConnection());
for(const id of ['open-local','home-open-local'])$('#'+id).addEventListener('click',()=>openLocal(false));$('#create-local').addEventListener('click',()=>openLocal(true));
$('#close-connection').addEventListener('click',()=>$('#connection-dialog').close());$('#connection-dialog').addEventListener('close',()=>{connectionDraft=false;$('#connection-form').elements.password.value='';});$('#connection-engine').addEventListener('change',()=>configureEngine());
$('#connection-form').addEventListener('input',()=>{connectionDraft=true;});
$('#choose-sqlite').addEventListener('click',async()=>{try{const file=await api.pickLocalDatabase({create:false});if(file){$('#connection-form').elements.filePath.value=file.filePath;if(!$('#connection-form').elements.name.value)$('#connection-form').elements.name.value=file.name;}}catch(error){$('#connection-error').textContent=error.message;}});
$('#save-connection').addEventListener('click',saveConnection);$('#test-connection').addEventListener('click',testConnection);
$('#connection-form').addEventListener('submit',async event=>{event.preventDefault();if(!$('#connection-form').reportValidity())return;$('#connect-submit').disabled=true;$('#connection-error').textContent='';try{const profile=readProfile();if(await connect(profile)){await api.saveProfile(profile);profiles=await api.profiles();renderConnections();}}catch(error){$('#connection-error').textContent=error.message;}finally{$('#connect-submit').disabled=false;}});
$('#database-backup').addEventListener('click',()=>BenchTransfer.open('export'));$('#database-restore').addEventListener('click',()=>BenchTransfer.open('import'));
$('#home-button').addEventListener('click',()=>{if(!busy)showHome();});$('#disconnect').addEventListener('click',disconnect);$('#run-query').addEventListener('click',()=>runQuery());$('#run-script').addEventListener('click',runScript);$('#new-tab').addEventListener('click',()=>{if(!busy)addTab();});$('#format-sql').addEventListener('click',formatSql);$('#new-table').addEventListener('click',newTable);
$('#cancel-query').addEventListener('click',async()=>{if(!runningQuery)return;$('#cancel-query').disabled=true;try{await api.cancelQuery();}catch(error){toast(error.message);}finally{$('#cancel-query').disabled=false;}});
$('#theme-toggle').addEventListener('click',toggleTheme);renderThemeControl();$('#sidebar-toggle').addEventListener('click',()=>{setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));flushEditorState();});
$('#wrap-toggle').addEventListener('click',()=>{setWordWrap($('#sql-editor').wrap==='off');flushEditorState();});
for(const command of ['begin','commit','rollback'])$('#'+command+'-transaction').addEventListener('click',()=>transaction(command));
$('#sql-editor').addEventListener('input',()=>{editorPosition();saveTab();});$('#sql-editor').addEventListener('click',editorPosition);$('#sql-editor').addEventListener('keyup',editorPosition);$('#sql-editor').addEventListener('scroll',syncScroll);
$('#sql-editor').addEventListener('keydown',event=>{if(event.key==='Tab'&&$('#sql-completions').hidden){event.preventDefault();event.target.setRangeText('  ',event.target.selectionStart,event.target.selectionEnd,'end');editorPosition();saveTab();}});
for(const panel of ['results','history','structure','database'])$('#'+panel+'-tab').addEventListener('click',()=>showPanel(panel));
$('#schema-filter').addEventListener('input',renderSchemas);$('#result-filter').addEventListener('input',renderResult);$('#connection-search').addEventListener('input',renderConnections);$('#refresh-schema').addEventListener('click',()=>{if(!busy)refreshSchemas();});$('#schema-select').addEventListener('change',event=>{selectedSchema=event.target.value;});
async function openSqlFile(){if(busy)return;try{const file=await api.openFile();if(file&&addTab(file.sql,file.name)){const tab=tabs.find(item=>item.id===activeTab);tab.file=true;tab.savedSql=file.sql;}}catch(error){toast(error.message);}}
$('#open-file').addEventListener('click',openSqlFile);$('#overview-open-sql').addEventListener('click',openSqlFile);
$('#overview-resume-sql').addEventListener('click',()=>{showWorkspace();$('#sql-editor').focus();});
$('#save-file').addEventListener('click',async()=>{try{const tab=tabs.find(item=>item.id===activeTab),sql=$('#sql-editor').value,name=await api.saveFile({name:tab.name.endsWith('.sql')?tab.name:tab.name+'.sql',sql});if(name){tab.name=name;tab.file=true;tab.savedSql=sql;renderTabs();saveTab();toast('SQL file saved.');}}catch(error){toast(error.message);}});
for(const format of ['csv','json'])$('#export-'+format).addEventListener('click',async()=>{if(!result)return;try{if(await api.exportCsv({...result,format}))toast('Results exported to '+format.toUpperCase()+'.');}catch(error){toast(error.message);}});

api.onAction(({id,value})=>{BenchWorkspaceMenu.hide();if(id==='stop-on-error'){stopOnError=Boolean(value);flushEditorState();toast('Stop script on error: '+(stopOnError?'on':'off'));return;}if(document.querySelector('dialog[open]')&&id!=='cancel-query')return;if(id==='new-tab'){if(!busy)addTab();return;}if(id==='close-tab'){closeTab();return;}if(id==='reopen-tab'){BenchTabs.reopen();return;}if(id==='next-tab'){BenchTabs.cycle(1);return;}if(id==='previous-tab'){BenchTabs.cycle(-1);return;}if(id==='duplicate-tab'){BenchTabs.duplicate();return;}if(id==='rename-tab'){BenchTabs.rename();return;}if(id==='replace'){$('#find-dialog').showModal();$('#replace-text').focus();return;}if(id==='find'){$('#find-dialog').showModal();$('#find-text').focus();return;}if(id==='explain'){if(!current||busy)return;const editor=$('#sql-editor'),sql=editor.value.slice(editor.selectionStart,editor.selectionEnd).trim()||editor.value.trim();if(current.mode==='mssql')return toast('Text EXPLAIN is available for MySQL, MariaDB, PostgreSQL and SQLite.');runQuery((['demo','sqlite'].includes(current.mode)?'EXPLAIN QUERY PLAN ':'EXPLAIN ')+sql);return;}if(id==='shortcuts'){BenchShortcuts.open();return;}if(id==='settings'){document.getElementById('workspace-settings').showPopover();return;}if(['database-tab','history-tab','results-tab','structure-tab'].includes(id))showWorkspace();$('#'+id)?.click();});
async function restoreWorkspace(){
  const saved=api.loadWorkspace();
  if(saved){
    workspaceKey=typeof saved.workspaceKey==='string'?saved.workspaceKey:'';
    Object.assign(workspaces,saved.workspaces);
    restoreTabs(workspaces[workspaceKey]);
    const preferences=saved.preferences||{};
    document.documentElement.dataset.theme=preferences.theme==='light'?'light':'dark';
    renderThemeControl();
    setSidebarCollapsed(preferences.sidebar===true);
    setWordWrap(preferences.wrap===true);
    stopOnError=preferences.stopOnError!==false;
    if(Number.isInteger(preferences.editorHeight)&&preferences.editorHeight>=120)$('.editor-area').style.height=preferences.editorHeight+'px';
  }else{
    try{
      const legacy=JSON.parse(localStorage.getItem('work-ez-bench.workspaces'))||{};
      for(const [key,value] of Object.entries(legacy)){
        if(!Array.isArray(value?.tabs))continue;
        workspaces[key]={activeTab:value.activeTab,tabCount:value.tabCount,tabs:value.tabs.filter(validTab).slice(0,MAX_TABS).map(tab=>recoveryTab(tab,false))};
      }
    }catch{}
    try{restoreTabs(JSON.parse(localStorage.getItem('work-ez-bench.tabs')));}catch{}
  }
  loadTab();
  updateResumeControl();
  workspaceReady=true;
  if(!saved&&await flushEditorState()){
    try{localStorage.removeItem('work-ez-bench.tabs');localStorage.removeItem('work-ez-bench.workspaces');}catch{}
  }
}
(async()=>{try{await restoreWorkspace();profiles=await api.profiles();renderConnections();}catch(error){toast(error.message);}})();

api.onPrepareClose(async()=>{
  saveTab();
  const warnings=unsavedWarnings();
  if(!await flushEditorState())warnings.push('Workspace recovery could not be saved. Save important SQL as files before closing.');
  api.finishClose(warnings).catch(error=>toast(error.message));
});

installUpdates({api,toast,canInstall:async()=>{
  if(!workspaceReady)return false;
  saveTab();
  const warnings=unsavedWarnings();
  if(!await flushEditorState())warnings.push('Workspace recovery could not be saved. Save important SQL as files before updating.');
  if(warnings.length)await api.warnUnsavedWork(warnings);
  return !warnings.length&&!current;
}});

installSnippets({api,editor:()=>$('#sql-editor'),isPrivate:()=>$('#private-query').checked,dialect:()=>['demo','sqlite'].includes(current?.mode)?'sqlite':current?.mode||'any',addTab,changed:()=>{editorPosition();saveTab();},busy:()=>busy,toast});
installSearch({editor:()=>$('#sql-editor'),changed:()=>{editorPosition();saveTab();},busy:()=>busy});
