'use strict';
window.BenchTabs=(()=>{
  const node=id=>document.getElementById(id);
  const closed=[];let contextId=null,renameId=null;
  function remember(tab){if(tab)closed.push({name:tab.name,sql:tab.sql,privateQuery:Boolean(tab.privateQuery)});while(closed.length>20)closed.shift();}
  function reset(){closed.length=0;hide();}
  function reopen(){if(busy)return;const tab=closed.at(-1);if(!tab)return toast('No closed tabs in this connection.');if(addTab(tab.sql,tab.name,{privateQuery:tab.privateQuery}))closed.pop();}
  function duplicate(id=activeTab){if(busy)return;saveTab();const tab=tabs.find(tab=>tab.id===id);if(tab)addTab(tab.sql,tab.name+' copy',{privateQuery:tab.privateQuery});hide();}
  function rename(id=activeTab){if(busy)return;const tab=tabs.find(tab=>tab.id===id);if(!tab)return;renameId=id;node('rename-tab-name').value=tab.name;hide();node('rename-tab-dialog').showModal();node('rename-tab-name').select();}
  async function closeOthers(id=activeTab){
    if(busy)return;hide();saveTab();const keep=tabs.find(tab=>tab.id===id);if(!keep)return;
    const others=tabs.filter(tab=>tab.id!==id);
    if(!await BenchTables.guard(others.map(tab=>tab.result)))return;
    others.forEach(remember);tabs=[keep];activeTab=id;loadTab();saveTab();
  }
  function cycle(direction){if(busy||tabs.length<2)return;saveTab();const index=tabs.findIndex(tab=>tab.id===activeTab);activeTab=tabs[(index+direction+tabs.length)%tabs.length].id;loadTab();}
  function hide(){node('tab-context-menu').hidden=true;}
  function menu(event,id){
    event.preventDefault();if(busy)return;contextId=id;const menu=node('tab-context-menu');menu.hidden=false;node('tab-menu-reopen').disabled=!closed.length;node('tab-menu-others').disabled=tabs.length<2;node('tab-menu-close').disabled=tabs.length<2;
    menu.style.left=Math.max(8,Math.min(event.clientX,innerWidth-menu.offsetWidth-8))+'px';menu.style.top=Math.max(8,Math.min(event.clientY,innerHeight-menu.offsetHeight-8))+'px';menu.querySelector('button:not(:disabled)')?.focus();
  }
  function bind(button,tab){
    button.dataset.tabId=String(tab.id);button.setAttribute('role','tab');button.setAttribute('aria-selected',String(tab.id===activeTab));button.title=tab.name+(tabs.length<2?' · Last query tab stays open':' · Middle-click to close')+' · Right-click for actions';
    button.addEventListener('mousedown',event=>{if(event.button===1)event.preventDefault();});
    button.addEventListener('auxclick',event=>{if(event.button===1){event.preventDefault();event.stopPropagation();closeTab(tab.id);}});
    button.addEventListener('contextmenu',event=>menu(event,tab.id));
  }
  document.addEventListener('DOMContentLoaded',()=>{
    node('query-tabs').setAttribute('role','tablist');node('query-tabs').setAttribute('aria-label','SQL tabs');
    node('tab-menu-close').onclick=()=>{hide();closeTab(contextId);};node('tab-menu-others').onclick=()=>closeOthers(contextId);node('tab-menu-duplicate').onclick=()=>duplicate(contextId);node('tab-menu-rename').onclick=()=>rename(contextId);node('tab-menu-reopen').onclick=()=>{hide();reopen();};
    node('rename-tab-cancel').onclick=()=>node('rename-tab-dialog').close();node('rename-tab-form').onsubmit=event=>{event.preventDefault();const name=node('rename-tab-name').value.trim(),tab=tabs.find(tab=>tab.id===renameId);if(!name||!tab)return;tab.name=name;node('rename-tab-dialog').close();renderTabs();saveTab();};
    document.addEventListener('pointerdown',event=>{if(!node('tab-context-menu').contains(event.target))hide();});
    document.addEventListener('keydown',event=>{if(event.key==='Escape')hide();});window.addEventListener('blur',hide);
  });
  return{remember,reset,reopen,duplicate,rename,closeOthers,cycle,bind};
})();
