'use strict';
window.BenchEditor=(()=>{
  const node=id=>document.getElementById(id);let entries=[],selected=0,prefixStart=0;
  function dismiss(){node('sql-completions').hidden=true;entries=[];}
  function complete(){
    if(busy)return;const editor=node('sql-editor'),prefix=editor.value.slice(0,editor.selectionStart).match(/[A-Za-z_][A-Za-z_0-9]*$/)?.[0]||'';prefixStart=editor.selectionStart-prefix.length;
    const candidates=new Map(BenchSqlText.KEYWORDS.map(value=>[value.toLowerCase(),{value,kind:'SQL'}]));
    for(const group of schemas)for(const table of group.tables)candidates.set(table.name.toLowerCase(),{value:quoteName(table.name),label:table.name,kind:table.type});
    for(const column of result?.columns||[])candidates.set(column.name.toLowerCase(),{value:quoteName(column.name),label:column.name,kind:'column'});
    entries=[...candidates.values()].filter(item=>(item.label||item.value).toLowerCase().startsWith(prefix.toLowerCase())).slice(0,30);selected=0;
    const panel=node('sql-completions');panel.replaceChildren();if(!entries.length)return dismiss();
    for(const[itemIndex,item]of entries.entries()){const button=document.createElement('button');button.type='button';button.className='completion-item';button.textContent=(item.label||item.value)+'  ·  '+item.kind;button.setAttribute('role','option');button.addEventListener('mousedown',event=>event.preventDefault());button.onclick=()=>accept(itemIndex);panel.append(button);}panel.hidden=false;paint();
  }
  function paint(){[...node('sql-completions').children].forEach((node,index)=>{node.classList.toggle('active',index===selected);node.setAttribute('aria-selected',String(index===selected));});node('sql-completions').children[selected]?.scrollIntoView({block:'nearest'});}
  function accept(index=selected){const item=entries[index];if(!item)return;const editor=node('sql-editor');editor.setRangeText(item.value,prefixStart,editor.selectionStart,'end');dismiss();editor.focus();editorPosition();saveTab();}
  function viewCell(value,column){node('value-title').textContent=column?.name||'Full text';node('value-text').value=value==null?'NULL':typeof value==='object'?JSON.stringify(value,null,2):String(value);node('value-description').textContent=value==null?'SQL NULL':`${node('value-text').value.length.toLocaleString()} characters · ${column?.type||'text'}`;node('value-dialog').showModal();}
  document.addEventListener('DOMContentLoaded',()=>{
    const separator=node('editor-resize');let resizing=false;
    const resize=height=>{const area=document.querySelector('.editor-area'),maximum=Math.max(120,document.getElementById('editor-view').clientHeight-300);area.style.height=Math.min(maximum,Math.max(120,height))+'px';};
    separator.onpointerdown=event=>{resizing=true;separator.setPointerCapture(event.pointerId);event.preventDefault();};separator.onpointermove=event=>{if(resizing)resize(event.clientY-document.querySelector('.editor-area').getBoundingClientRect().top);};separator.onpointerup=()=>{resizing=false;};separator.onpointercancel=()=>{resizing=false;};separator.onkeydown=event=>{if(event.key==='ArrowUp'||event.key==='ArrowDown'){event.preventDefault();resize(document.querySelector('.editor-area').clientHeight+(event.key==='ArrowUp'?-20:20));}};
    const editor=node('sql-editor');editor.addEventListener('keydown',event=>{
      if(event.ctrlKey&&event.code==='Space'){event.preventDefault();complete();return;}
      if(node('sql-completions').hidden)return;
      if(event.ctrlKey||event.metaKey){dismiss();return;}
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();selected=(selected+(event.key==='ArrowDown'?1:-1)+entries.length)%entries.length;paint();}
      else if(event.key==='Enter'||event.key==='Tab'){event.preventDefault();event.stopImmediatePropagation();accept();}
      else if(event.key==='Escape'){event.preventDefault();dismiss();}
    },true);
    editor.addEventListener('input',()=>{if(!node('sql-completions').hidden)complete();});editor.addEventListener('blur',()=>setTimeout(()=>{if(document.activeElement!==editor&&!node('sql-completions').contains(document.activeElement))dismiss();},0));
    node('sql-complete').onclick=()=>{editor.focus();complete();};
    node('value-close').onclick=()=>node('value-dialog').close();node('value-copy').onclick=async()=>{try{await api.copyText(node('value-text').value);toast('Full value copied.');}catch(error){toast(error.message);}};
    node('result-message').addEventListener('dblclick',()=>viewCell(node('result-message').textContent,{name:'Execution details',type:'status'}));
    node('result-message').tabIndex=0;node('result-message').title='Double-click or press Enter for full execution details';node('result-message').addEventListener('keydown',event=>{if(event.key==='Enter')viewCell(node('result-message').textContent,{name:'Execution details',type:'status'});});
    node('private-query').addEventListener('change',()=>{saveTab();flushEditorState();toast(node('private-query').checked?'Private query: history and editor disk storage are disabled for this tab.':'Query capture follows History settings.');});
  });
  return{complete,dismiss,viewCell};
})();
