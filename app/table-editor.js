'use strict';
// The SQL result grid stays read-only. Explorer tables carry a server snapshot.
window.BenchTables = (() => {
  const node = id => document.getElementById(id);
  const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  let editingCell = null;
  const state = data => data?.table ? (data._edit ||= { updates: Object.create(null), deleted: [], inserted: [], selected: [] }) : null;
  function changes(data) {
    const edit = state(data); if (!edit) return [];
    return [...Object.entries(edit.updates).filter(([index]) => !edit.deleted.includes(Number(index))).map(([index, values]) => ({ rowIndex: Number(index), values })), ...edit.deleted.map(rowIndex => ({ type: 'delete', rowIndex })), ...edit.inserted.map(values => ({ type: 'insert', values }))];
  }
  const dirty = data => Boolean(changes(data).length);
  function updateToolbar(data) {
    window.BenchBrowse?.update(data);
    const edit = state(data), count = changes(data).length;
    node('table-edit-toolbar').hidden = !edit;node('table-pagination').hidden=!edit;
    if (!edit) return;
    node('table-page-label').textContent=data.rowCount?`Rows ${(data.offset||0)+1}–${(data.offset||0)+data.rowCount}`:'No rows on this page';node('table-previous').disabled=busy||!data.offset;node('table-next').disabled=busy||!data.hasMore;node('table-page-size').value=String(data.limit||100);
    node('table-edit-name').textContent = data.schema + '.' + data.table;
    node('table-edit-hint').textContent = data.editable ? (count ? `${count} staged change${count===1?'':'s'}` : 'Double-click a cell to edit · Enter to save') : data.readOnlyReason || 'Read-only table';
    node('table-apply').disabled = busy || !data.editable || !count;
    node('table-discard').disabled = busy || !count;
    node('table-refresh').disabled = busy || Boolean(count);
    node('table-delete-rows').hidden = !data.editable;
    node('table-delete-rows').disabled = busy || !edit.selected.length;
    node('table-add-row').hidden = !data.editable || data.canInsert === false;
    node('table-add-row').disabled = busy;
    node('table-change-count').textContent = count ? String(count) : '';
  }
  function displayRows(data) {
    const edit = state(data);
    return data.rows.map((row,index) => ({ row: edit ? { ...row, ...edit.updates[index] } : row, index })).concat(edit ? edit.inserted.map((row,i) => ({ row, index: data.rows.length+i, inserted: true })) : []);
  }
  function selectCell(data, column, index, td, inserted) {
    const edit = state(data);
    if (!data.editable || (inserted ? !column.insertable : column.editable === false) || edit.deleted.includes(index)) return;
    const key = column.key || column.name;
    const old = inserted ? edit.inserted[index-data.rows.length][key] : (edit.updates[index]&&Object.hasOwn(edit.updates[index],key)?edit.updates[index][key]:data.rows[index][key]);
    td.replaceChildren(); const input = document.createElement('input');
    input.className = 'grid-cell-input'; input.value = old == null ? '' : typeof old === 'object' ? JSON.stringify(old) : String(old);
    input.setAttribute('aria-label', `Edit ${column.name} row ${index+1}`);
    td.append(input); input.focus(); input.select();
    let done = false;
    const finish = save => { if (done) return; done = true; if (save) stageValue(data,column,index,input.value===''&&old===null?null:input.value,inserted); renderResult(); saveTab(); };
    input.addEventListener('keydown', event => { if (event.key==='Enter'&&!event.ctrlKey) { event.preventDefault(); finish(true); } else if (event.key==='Escape') { event.preventDefault(); finish(false); } else if (event.key==='F2' || event.key==='Enter'&&event.ctrlKey) { event.preventDefault(); done=true; openCellDialog(data,column,index,inserted,input.value); } else if (event.key==='Delete'&&event.ctrlKey&&column.nullable) { event.preventDefault(); done=true; stageValue(data,column,index,null,inserted); renderResult(); saveTab(); } });
    input.addEventListener('blur', () => finish(true));
  }
  function stageValue(data,column,index,value,inserted) {
    const edit=state(data),key=column.key||column.name;
    if (inserted) edit.inserted[index-data.rows.length][key]=value;
    else {
      const original=data.rows[index][key];
      // Preserve native values if the user did not change the text.
      if (value!==null && value===String(original ?? '') && original!==null) value=original;
      if(equal(value,original)){if(edit.updates[index]){delete edit.updates[index][key];if(!Object.keys(edit.updates[index]).length)delete edit.updates[index];}}
      else (edit.updates[index] ||= Object.create(null))[key]=value;
    }
    updateToolbar(data);
  }
  function openCellDialog(data,column,index,inserted,value) {
    editingCell={data,column,index,inserted};
    node('cell-column').textContent=column.name;
    node('cell-value').value=value==null?'':typeof value==='object'?JSON.stringify(value):String(value);
    node('cell-null').checked=value===null;
    node('cell-null').disabled=!column.nullable;
    node('cell-value').disabled=value===null;
    node('cell-help').textContent=`${column.type} · ${column.nullable?'NULL allowed':'Value required'} · Saved to the pending batch until you apply changes.`;
    node('cell-dialog').showModal();node('cell-value').focus();
  }
  function decorate(data,tr,entry) {
    const edit=state(data); if(!edit)return;
    const {index,row,inserted}=entry;
    tr.dataset.rowIndex=index;
    tr.classList.toggle('grid-row-deleted',edit.deleted.includes(index));
    tr.classList.toggle('grid-row-inserted',Boolean(inserted));
    const first=tr.firstElementChild;
    if(data.editable){
      const select=document.createElement('input');select.type='checkbox';select.checked=edit.selected.includes(index);select.setAttribute('aria-label','Select row '+(index+1));
      select.addEventListener('change',()=>{edit.selected=select.checked?[...new Set([...edit.selected,index])]:edit.selected.filter(value=>value!==index);updateToolbar(data);});
      first.replaceChildren(select);
    }
    data.columns.forEach((column,i)=>{
      const td=tr.children[i+1],key=column.key||column.name;
      td.dataset.column=column.name;
      if(inserted&&!Object.hasOwn(row,key)){td.textContent='DEFAULT';td.classList.add('default-value');}
      if(edit.updates[index]&&Object.hasOwn(edit.updates[index],key))td.classList.add('grid-cell-changed');
      if(data.editable&&(inserted?column.insertable:column.editable!==false)){
        td.classList.add('grid-cell-editable');td.tabIndex=0;
        td.title='Double-click or Enter to edit · F2 for expanded editor · Ctrl+Delete to set NULL';
        td.addEventListener('dblclick',()=>selectCell(data,column,index,td,inserted));
        td.addEventListener('keydown',event=>{if(event.target!==td)return;if(event.key==='Enter'){event.preventDefault();selectCell(data,column,index,td,inserted);}if(event.key==='F2'){event.preventDefault();openCellDialog(data,column,index,inserted,row[key]);}});
      } else {td.classList.add('grid-cell-readonly');td.title=(column.readOnlyReason||'This column is read-only')+' · '+td.textContent;}
    });
  }
  async function guard(data=result,all=false) {
    const candidates=Array.isArray(data)?data:all?[result,...tabs.map(tab=>tab.result)]:[data];
    if(!candidates.some(dirty))return true;
    node('discard-dialog').showModal();
    return new Promise(resolve=>{
      const close=keep=>{node('discard-dialog').close();node('discard-stay').onclick=null;node('discard-confirm').onclick=null;node('discard-dialog').oncancel=null;if(!keep)for(const item of candidates)if(item)delete item._edit;resolve(!keep);};
      node('discard-stay').onclick=()=>close(true);node('discard-confirm').onclick=()=>close(false);node('discard-dialog').oncancel=event=>{event.preventDefault();close(true);};
    });
  }
  async function load(schema,table,reuse=false,offset=0,browse) {
    if(busy||!current)return;
    if(browse===undefined)browse=reuse&&result?.schema===schema&&result?.table===table?result.browse:undefined;
    if(reuse&&!await guard())return;if(busy)return;
    if(!reuse&&tabs.length>=MAX_TABS){toast('Close a SQL tab before opening another table.');return;}if(!reuse){const target=quoteName(schema)+'.'+quoteName(table);addTab('-- Table data: '+schema+'.'+table+'\n'+(current.mode==='mssql'?'SELECT TOP (1000) * FROM '+target+';':'SELECT * FROM '+target+'\nLIMIT 1000;'),table);}
    selectedSchema=schema;node('schema-select').value=schema;setBusy(true);status('Loading table…','working');
    try {
      result=await api.tableData({schema,table,offset,limit:Number(node('table-page-size').value)||100,browse});resultSets=[];resultSort=null;node('result-filter').value='';renderResultSets();renderResult();showPanel('results');
      status(`${result.rowCount} rows loaded${result.truncated?' · First 1,000 rows':''}${result.editable?' · Changes stay pending until applied':' · Read-only'}`);
      return true;
    }catch(error){status(error.message,'error');}
    finally{setBusy(false);updateToolbar(result);saveTab();}
  }
  async function preview() {
    if(busy||!dirty(result))return;
    const data=result,count=changes(data).length;node('apply-error').textContent='';node('apply-preview').textContent='Preparing changes…';node('apply-summary').textContent=`${count} change${count===1?'':'s'} to ${data.schema}.${data.table}`;node('apply-dialog').showModal();node('apply-confirm').disabled=true;
    try{const output=await api.previewChanges({token:data.token,changes:changes(data)});node('apply-preview').textContent=output.statements.map((statement,i)=>`-- Change ${i+1}\n${statement.sql}\n-- Parameters: ${JSON.stringify(statement.parameters)}\n`).join('\n');node('apply-confirm').disabled=false;}
    catch(error){node('apply-error').textContent=error.message;}
  }
  async function apply() {
    const data=result;if(!dirty(data)||busy)return;setBusy(true);node('apply-confirm').disabled=true;node('apply-back').disabled=true;node('apply-close').disabled=true;node('apply-error').textContent='';
    try{const output=await api.applyChanges({token:data.token,changes:changes(data)});delete data._edit;node('apply-dialog').close();setBusy(false);await load(data.schema,data.table,true,data.offset||0);status(`${output.applied} change${output.applied===1?'':'s'} applied successfully.`);}
    catch(error){node('apply-error').textContent=error.message+' Your pending edits are kept. Discard and reload to resolve a conflict.';}
    finally{setBusy(false);node('apply-confirm').disabled=false;node('apply-back').disabled=false;node('apply-close').disabled=false;updateToolbar(result);}
  }
  document.addEventListener('DOMContentLoaded',()=>{
    node('table-apply').onclick=preview;node('apply-confirm').onclick=apply;
    for(const id of ['apply-close','apply-back'])node(id).onclick=()=>{if(!busy)node('apply-dialog').close();};
    node('apply-dialog').addEventListener('cancel',event=>{if(busy)event.preventDefault();});
    node('table-discard').onclick=()=>{if(!busy&&result){delete result._edit;renderResult();saveTab();status('Pending changes discarded.');}};
    node('table-refresh').onclick=()=>{if(result?.table)load(result.schema,result.table,true,result.offset||0);};
    node('table-previous').onclick=()=>{if(result?.table)load(result.schema,result.table,true,Math.max(0,(result.offset||0)-(result.limit||100)));};
    node('table-next').onclick=()=>{if(result?.table)load(result.schema,result.table,true,(result.offset||0)+(result.limit||100));};
    node('table-page-size').onchange=()=>{if(result?.table)load(result.schema,result.table,true,0);};
    node('table-add-row').onclick=()=>{if(busy||!result?.editable)return;state(result).inserted.push(Object.create(null));renderResult();node('table-scroll').scrollTop=node('table-scroll').scrollHeight;saveTab();};
    node('table-delete-rows').onclick=()=>{
      if(busy||!result?.editable)return;const edit=state(result),selected=[...edit.selected];
      edit.deleted=[...new Set([...edit.deleted,...selected.filter(index=>index<result.rows.length)])];
      edit.inserted=edit.inserted.filter((_,i)=>!selected.includes(result.rows.length+i));edit.selected=[];renderResult();saveTab();
    };
    node('cell-null').onchange=()=>{node('cell-value').disabled=node('cell-null').checked;};
    node('cell-save').onclick=()=>{if(!editingCell)return;const {data,column,index,inserted}=editingCell;stageValue(data,column,index,node('cell-null').checked?null:node('cell-value').value,inserted);node('cell-dialog').close();renderResult();saveTab();};
    for(const id of ['cell-close','cell-cancel'])node(id).onclick=()=>node('cell-dialog').close();
  });
  return {state,changes,dirty,updateToolbar,displayRows,decorate,guard,load};
})();
