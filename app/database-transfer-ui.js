'use strict';

window.BenchTransfer = (() => {

  const node=id=>document.getElementById(id);

  let kind='export',info=null,file=null,destination=null,review=null,working=false,descriptionId=0,descriptionQueue=Promise.resolve();

  const local=()=>['demo','sqlite'].includes(current?.mode);

  const tools=()=>({dump:node('transfer-dump-tool').value.trim()||undefined,restore:node('transfer-restore-tool').value.trim()||undefined});

  function buttons(){

    const toolReady=local()||Boolean(info?.tools?.[kind==='export'?'dump':'restore']?.available);
    node('transfer-run').disabled=working||!file||!info||!toolReady||(kind==='import'&&(!review||local()&&!destination||node('transfer-confirm-text').value!==review.confirmation));

    node('transfer-choose').disabled=working;node('transfer-destination').disabled=working;

    node('transfer-dump-tool').disabled=working;node('transfer-restore-tool').disabled=working;node('transfer-confirm-text').disabled=working;

    node('transfer-close').disabled=working;node('transfer-cancel').textContent=working?'Cancel transfer':'Close';

  }

  function describe(){
    const id=++descriptionId,selectedTools=tools();info=null;buttons();
    // Serialize native tool probes; rapid edits must not race the worker's
    // exclusive operation or replace current tool status with stale results.
    descriptionQueue=descriptionQueue.catch(()=>{}).then(async()=>{
      if(id!==descriptionId)return;
      try{
        const output=await api.transferInfo({tools:selectedTools});if(id!==descriptionId)return;
        info=output;node('transfer-error').textContent='';
        node('transfer-target').textContent=`${ENGINES[current.mode].name} · ${current.name} · Target: ${info.database}`;node('transfer-scope').textContent=info.scope;
        node('transfer-tools').hidden=local();
        if(!local()&&!info.ready)node('transfer-tools').open=true;
        node('transfer-tool-status').textContent=local()?'':Object.entries(info.tools).map(([role,tool])=>`${role==='dump'?'Backup':'Restore'}: ${tool.path||'Not found — choose the executable above'}`).join('\n');
        node('transfer-review').hidden=kind!=='import';node('transfer-warning').textContent=info.warning;
      }catch(error){if(id!==descriptionId)return;info=null;node('transfer-error').textContent=error.message;}
      buttons();
    });
    return descriptionQueue;
  }

  async function open(operation){

    if(busy||!current)return;if(operation==='import'&&!await BenchTables.guard(result,true))return;

    kind=operation;info=null;file=null;destination=null;review=null;working=false;

    node('transfer-title').textContent=kind==='export'?'Export database backup':'Restore database backup';

    node('transfer-target').textContent=`${ENGINES[current.mode].name} · ${current.name} · ${selectedSchema||'connected database'}`;

    node('transfer-file-label').textContent=kind==='export'?'SAVE BACKUP TO':'RESTORE FROM';

    node('transfer-file-name').textContent='No file selected';node('transfer-destination-name').textContent='Choose a new destination file';

    node('transfer-destination-row').hidden=kind!=='import'||!local();

    node('transfer-progress').textContent='Reading connection and backup tools…';node('transfer-error').textContent='';node('transfer-scope').textContent='';node('transfer-warning').textContent='';node('transfer-confirm-text').value='';node('transfer-review').hidden=true;

    node('transfer-run').replaceChildren(icon(kind==='export'?'database-backup':'upload'),document.createTextNode(kind==='export'?'Export backup':'Restore database'));

    node('transfer-dialog').showModal();buttons();await describe();node('transfer-progress').textContent='';

  }

  async function inspect(){

    if(!file||kind!=='import')return;review=null;node('transfer-error').textContent='';node('transfer-progress').textContent='Checking backup file…';buttons();

    try{review=await api.inspectImport({ticket:file.ticket,tools:tools()});node('transfer-warning').textContent=review.warning;node('transfer-review').hidden=false;node('transfer-file-name').textContent=`${file.filePath} · ${(review.bytes/1024).toFixed(1)} KB`;

      const label=node('transfer-confirm-label');label.firstChild.textContent=`Type ${review.confirmation} to confirm${local()?' the restore':' the target database'} `;

    }catch(error){node('transfer-error').textContent=error.message;}

    finally{node('transfer-progress').textContent='';buttons();}

  }

  async function run(){

    if(working||node('transfer-run').disabled)return;

    working=true;setBusy(true);node('transfer-error').textContent='';node('transfer-progress').textContent=kind==='export'?'Exporting the full database…':'Restoring database… Keep the app open until this completes.';buttons();

    try{

      const output=kind==='export'?await api.exportDatabase({ticket:file.ticket,tools:tools(),database:info.database}):await api.importDatabase({token:review.token,confirmation:node('transfer-confirm-text').value,destinationTicket:destination?.ticket});

      node('transfer-progress').textContent=kind==='export'?`Backup saved · ${(output.bytes/1024/1024).toFixed(2)} MB · ${output.filePath}`:(output.message||'Database restored.');

      if(output.warnings)node('transfer-error').textContent=output.warnings;

      file=null;review=null;working=false;setBusy(false);buttons();

      if(kind==='import'&&local()&&output.filePath){

        const profile=await api.saveProfile({mode:'sqlite',name:output.filePath.split(/[\\/]/).at(-1),filePath:output.filePath});profiles=await api.profiles();renderConnections();

        node('transfer-dialog').close();await connect(profile);toast('Restored database opened. The original file was kept.');

      }else if(kind==='import'){

        for(const tab of tabs){tab.result=null;tab.resultSets=[];tab.message='Database restored. Open a table or run SQL to reload results.';}result=null;resultSets=[];renderResultSets();renderResult();await refreshSchemas();status('Database restored. Open a table to inspect the data.');

      }

    }catch(error){node('transfer-error').textContent=error.message;node('transfer-progress').textContent=kind==='import'&&!local()?'Restore failed. Check the target database before retrying; MySQL imports can partially apply.':'Transfer did not complete.';if(/Reconnect to continue|cancelled|closed/.test(error.message))invalidateConnection();}

    finally{working=false;setBusy(false);buttons();}

  }

  async function close(){

    if(working){node('transfer-cancel').disabled=true;try{await api.cancelQuery();invalidateConnection();node('transfer-progress').textContent='Transfer cancelled. Reconnect to continue. Check the target database after an interrupted import.';}catch(error){node('transfer-error').textContent=error.message;}finally{node('transfer-cancel').disabled=false;}return;}

    node('transfer-dialog').close();

  }

  document.addEventListener('DOMContentLoaded',()=>{

    node('transfer-choose').onclick=async()=>{try{const choice=await api.pickTransfer({kind,mode:current?.mode});if(!choice)return;file=choice;review=null;node('transfer-file-name').textContent=file.filePath;node('transfer-confirm-text').value='';if(kind==='import')await inspect();buttons();}catch(error){node('transfer-error').textContent=error.message;}};

    node('transfer-destination').onclick=async()=>{try{const choice=await api.pickTransfer({kind:'destination',mode:current?.mode});if(choice){destination=choice;node('transfer-destination-name').textContent=choice.filePath;buttons();}}catch(error){node('transfer-error').textContent=error.message;}};

    for(const id of ['transfer-dump-tool','transfer-restore-tool'])node(id).onchange=async()=>{review=null;await describe();await inspect();};

    node('transfer-confirm-text').oninput=buttons;node('transfer-run').onclick=run;node('transfer-cancel').onclick=close;node('transfer-close').onclick=close;

    node('transfer-dialog').addEventListener('cancel',event=>{event.preventDefault();if(!working)close();});

  });

  return {open};

})();
