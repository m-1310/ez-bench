'use strict';
window.BenchHistory = (() => {
  const node=id=>document.getElementById(id);
  const make=(tag,className,text)=>{const element=document.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=text;return element;};
  const icon=name=>window.BenchIcons.icon(name);
  const defaults={paused:false,maxEntries:500,maxAgeDays:30};
  let initialized=false,items=[],selected=null,total=0,connectionTotal=0,offset=0,limit=50,preferences={...defaults},generation=0,searchTimer=null,confirmation=null;
  function button(id,label,iconName,className='button'){const value=make('button',className);value.id=id;value.type='button';if(iconName)value.append(icon(iconName));value.append(document.createTextNode(label));return value;}
  function init(){
    if(initialized)return;const panel=node('history-panel');if(!panel)return;initialized=true;panel.replaceChildren();
    const shell=make('div','history-manager');shell.id='history-manager';
    const heading=make('div','history-heading'),title=make('div');title.append(make('h3','','Query history'),make('p','subtle','Recorded SQL for this connection. Queries are never run by opening history.'));
    const tools=make('div','history-heading-tools');tools.append(button('history-refresh','Refresh','refresh-cw','text-button'),button('history-settings','Retention','settings-2','text-button'),button('history-clear','Clear connection','trash-2','text-button danger'));heading.append(title,tools);
    const filters=make('div','history-filters');const search=make('input');search.id='history-search';search.type='search';search.placeholder='Search SQL, title or schema…';search.setAttribute('aria-label','Search query history');filters.append(search);
    const status=make('select');status.id='history-status';status.setAttribute('aria-label','Filter query history status');for(const[value,label]of[['all','All statuses'],['success','Completed'],['error','Failed']]){const option=make('option','',label);option.value=value;status.append(option);}filters.append(status);
    for(const[id,label]of[['history-from','From date'],['history-to','To date']]){const wrap=make('label','history-date',label),input=make('input');input.id=id;input.type='date';input.setAttribute('aria-label',label);wrap.append(input);filters.append(wrap);}
    for(const[id,label]of[['history-favorites','Favorites only'],['history-paused','Pause capture']]){const wrap=make('label','history-check'),input=make('input');input.id=id;input.type='checkbox';wrap.append(input,document.createTextNode(label));filters.append(wrap);}
    const notice=make('div','history-notice');notice.id='history-notice';notice.setAttribute('role','status');notice.hidden=true;
    const content=make('div','history-content'),list=make('div','history-list');list.id='history-list';list.setAttribute('aria-label','Query history entries');
    const details=make('section','history-detail');details.id='history-detail';details.setAttribute('aria-label','Full query details');content.append(list,details);
    const footer=make('div','history-pagination'),counts=make('span');counts.id='history-count';counts.setAttribute('role','status');footer.append(counts,button('history-previous','Previous','arrow-left'),button('history-next','Next','arrow-right'));
    shell.append(heading,filters,notice,content,footer);panel.append(shell);
    const settings=make('dialog');settings.id='history-settings-dialog';settings.innerHTML='<form id="history-settings-form"><div class="dialog-heading"><h2>Query history retention</h2><button id="history-settings-close" type="button" class="icon-button" aria-label="Close history settings">×</button></div><p class="subtle history-dialog-copy">Settings apply to all connections. Favorites are kept past the age limit, but count and storage limits still apply.</p><label>Maximum entries<input id="history-max-entries" type="number" min="10" max="2000" required></label><label>Maximum age in days<input id="history-max-age" type="number" min="1" max="3650" required></label><p class="subtle history-dialog-copy">History uses at most 2 MiB. Queries larger than 256 KiB are skipped. Known credential patterns are redacted; private SQL should use Pause capture.</p><p id="history-settings-error" class="dialog-error" role="alert"></p><div class="dialog-actions"><button id="history-settings-cancel" type="button" class="button">Cancel</button><button type="submit" class="button primary">Save settings</button></div></form>';
    const confirm=make('dialog');confirm.id='history-confirm-dialog';confirm.innerHTML='<div class="dialog-heading"><h2 id="history-confirm-title">Delete query history?</h2></div><p id="history-confirm-description" class="history-dialog-copy"></p><p id="history-confirm-error" class="dialog-error" role="alert"></p><div class="dialog-actions"><button id="history-confirm-cancel" type="button" class="button">Keep history</button><button id="history-confirm-accept" type="button" class="button danger">Delete history</button></div>';
    panel.append(settings,confirm);
    node('history-settings-close').replaceChildren(icon('x'));
    search.addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{offset=0;load();},180);});
    for(const id of ['history-status','history-from','history-to','history-favorites'])node(id).addEventListener('change',()=>{offset=0;load();});
    node('history-refresh').onclick=()=>load();node('history-previous').onclick=()=>{offset=Math.max(0,offset-limit);load();};node('history-next').onclick=()=>{if(offset+limit<total){offset+=limit;load();}};
    node('history-paused').onchange=async()=>{try{preferences=await api.historySettings({paused:node('history-paused').checked});await load();}catch(error){noticeText(error.message);node('history-paused').checked=preferences.paused;}};
    node('history-settings').onclick=()=>{node('history-max-entries').value=preferences.maxEntries;node('history-max-age').value=preferences.maxAgeDays;node('history-settings-error').textContent='';settings.showModal();};
    for(const id of ['history-settings-close','history-settings-cancel'])node(id).onclick=()=>settings.close();
    node('history-settings-form').onsubmit=async event=>{event.preventDefault();try{preferences=await api.historySettings({maxEntries:Number(node('history-max-entries').value),maxAgeDays:Number(node('history-max-age').value)});settings.close();offset=0;await load();}catch(error){node('history-settings-error').textContent=error.message;}};
    node('history-clear').onclick=()=>confirmDelete('clear');node('history-confirm-cancel').onclick=()=>confirm.close();node('history-confirm-accept').onclick=acceptDelete;
  }
  function noticeText(text){const notice=node('history-notice');if(!notice)return;notice.textContent=text;notice.hidden=!text;}
  function queryOptions(){
    const from=node('history-from').value,to=node('history-to').value;
    return{search:node('history-search').value,status:node('history-status').value,favoritesOnly:node('history-favorites').checked,offset,limit,...(from?{from:new Date(from+'T00:00:00').toISOString()}:{}),...(to?{to:new Date(to+'T23:59:59.999').toISOString()}:{})};
  }
  async function load(){
    init();if(!initialized)return;const request=++generation,profileId=typeof current==='object'?current?.id:null;node('history-refresh').disabled=true;
    try{
      const response=await api.history(queryOptions());if(request!==generation||profileId!==(typeof current==='object'?current?.id:null))return;
      const result=Array.isArray(response)?{items:response,total:response.length,settings:defaults}:response;
      items=result.items||[];total=result.total||0;connectionTotal=result.connectionTotal??total;preferences={...defaults,...result.settings};node('history-paused').checked=preferences.paused;
      if(offset>=total&&offset){offset=Math.max(0,Math.floor(Math.max(0,total-1)/limit)*limit);return load();}
      noticeText(result.warning||(preferences.paused?'History capture is paused for all connections. SQL still executes normally.':''));
      const previous=selected?.id;selected=items.find(entry=>entry.id===previous)||items[0]||null;renderList();renderDetails();
    }catch(error){if(request===generation)noticeText(error.message);}
    finally{if(request===generation)node('history-refresh').disabled=false;}
  }
  function renderList(){
    const list=node('history-list');list.replaceChildren();
    if(!items.length)list.append(make('p','history-empty',total?'No matching queries on this page.':'No matching queries. Run SQL or change the filters.'));
    for(const entry of items){
      const row=make('div','history-record'+(selected?.id===entry.id?' selected':'')),item=make('button','history-item');item.type='button';item.dataset.historyId=entry.id;item.title='Restore SQL in the current editor without executing it. Use Open in new tab to preserve that editor.';item.setAttribute('aria-label','Restore query '+(entry.title||new Date(entry.timestamp).toLocaleString()));
      const title=make('div','history-entry-title');if(entry.favorite)title.append(icon('star'));title.append(document.createTextNode(entry.title||'Untitled query'));
      const preview=entry.sql.length>220?entry.sql.slice(0,220)+'…':entry.sql;item.append(title,make('div','history-sql',preview));
      if(entry.sql.length>220)item.append(make('span','history-preview-note','Preview only · Full SQL shown in details'));
      const meta=make('div','history-meta'),state=make('span',entry.status);state.append(icon(entry.status==='error'?'circle-alert':'circle-check'),document.createTextNode(entry.status==='error'?'Failed':'Completed'));meta.append(state,make('span','',`${entry.rowCount} rows · ${entry.elapsedMs} ms`),make('time','',new Date(entry.timestamp).toLocaleString()));item.append(meta);
      item.onclick=()=>{selected=entry;renderList();renderDetails();restore(entry,false);};row.append(item);list.append(row);
    }
    node('history-count').textContent=total?`${offset+1}–${Math.min(offset+items.length,total)} of ${total} queries`:'0 queries';node('history-previous').disabled=offset===0;node('history-next').disabled=offset+limit>=total;node('history-clear').disabled=connectionTotal===0;
  }
  function renderDetails(){
    const details=node('history-detail');details.replaceChildren();if(!selected){details.append(make('p','history-empty','Select a query to inspect its full SQL and execution details.'));return;}
    const title=make('input');title.id='history-entry-title';title.value=selected.title;title.placeholder='Name this query…';title.maxLength=160;title.setAttribute('aria-label','Query title');
    const heading=make('div','history-detail-heading');heading.append(title,button('history-save-title','Save name','save','text-button'));details.append(heading);
    const actions=make('div','history-detail-actions');actions.append(button('history-open-new','Open in new tab','file-plus-2'),button('history-copy','Copy SQL','copy'),button('history-favorite',selected.favorite?'Unfavorite':'Favorite','star'),button('history-delete','Delete','trash-2','text-button danger'));details.append(actions);
    const meta=make('div','history-detail-meta');for(const[label,value]of Object.entries({Connection:selected.connection,Schema:selected.schema||'Default',Executed:new Date(selected.timestamp).toLocaleString(),Result:selected.status==='error'?'Failed':'Completed',Rows:String(selected.rowCount),Affected:String(selected.affectedRows||0),Duration:selected.elapsedMs+' ms'})){const pair=make('div');pair.append(make('span','',label),make('strong','',value));meta.append(pair);}details.append(meta);
    if(selected.redacted)details.append(make('p','history-redaction-note','Known credential values were redacted before saving. Replace [REDACTED] placeholders before running this SQL.'));
    if(selected.error)details.append(make('pre','history-query-error',selected.error));
    const sql=make('pre','history-full-sql',selected.sql);sql.id='history-full-sql';sql.tabIndex=0;sql.setAttribute('aria-label','Complete recorded SQL');details.append(sql);
    node('history-open-new').onclick=()=>restore(selected,true);
    node('history-copy').onclick=async()=>{try{if(api.copyText)await api.copyText(selected.sql);else await navigator.clipboard.writeText(selected.sql);toast('Query SQL copied.');}catch(error){noticeText('Could not copy SQL: '+error.message);}};
    node('history-save-title').onclick=async()=>{try{await api.historyUpdate({id:selected.id,title:node('history-entry-title').value});await load();}catch(error){noticeText(error.message);}};
    node('history-favorite').onclick=async()=>{try{await api.historyUpdate({id:selected.id,favorite:!selected.favorite});await load();}catch(error){noticeText(error.message);}};
    node('history-delete').onclick=()=>confirmDelete('entry',selected.id);
  }
  function restore(entry,newTab){
    if(busy)return;const sql=entry.sql;
    if(newTab)addTab(sql,entry.title||'History query');
    else{$('#sql-editor').value=sql;saveTab();editorPosition();}
    if(entry.redacted)toast('History SQL contains redacted values. Replace them before running.');
  }
  function confirmDelete(type,id){
    confirmation={type,id,profileId:typeof current==='object'?current?.id:null};node('history-confirm-title').textContent=type==='clear'?'Clear this connection’s query history?':'Delete this query history entry?';node('history-confirm-description').textContent=type==='clear'?'This deletes this connection’s recorded queries, including favorites. Other connections and database contents are kept.':'This deletes only the selected history entry. Database contents and open SQL tabs are kept.';node('history-confirm-error').textContent='';node('history-confirm-dialog').showModal();
  }
  async function acceptDelete(){
    if(!confirmation)return;node('history-confirm-accept').disabled=true;
    try{if(confirmation.profileId!==(typeof current==='object'?current?.id:null))throw new Error('The active connection changed. Reopen its history before deleting entries.');if(confirmation.type==='clear')await api.historyClear();else await api.historyRemove(confirmation.id);confirmation=null;node('history-confirm-dialog').close();selected=null;offset=0;await load();}
    catch(error){node('history-confirm-error').textContent=error.message;}
    finally{node('history-confirm-accept').disabled=false;}
  }
  return{load};
})();
