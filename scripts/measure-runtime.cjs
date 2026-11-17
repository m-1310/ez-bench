'use strict';
// Measurement only: isolated app data and owned processes. No user DB is opened.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {execFileSync,spawn}=require('node:child_process');
const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'..');
const {_electron}=createRequire(path.join(root,'app/package.json'))('playwright');
const executablePath=process.env.WORK_EZ_BENCH_EXECUTABLE||path.join(root,'app/node_modules/electron/dist/electron.exe');
const durationSeconds=Number(process.env.EZ_BENCH_IDLE_SECONDS||60);
const iterations=Number(process.env.EZ_BENCH_CYCLE_COUNT||20);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const plain=process.argv.includes('--plain');
function ownedProcesses(rootPid){
  if(!Number.isInteger(rootPid)||rootPid<1)throw new Error('Expected owned app PID.');
  const command=`$rootID=${rootPid};$processes=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId);$ownedIDs=[Collections.Generic.HashSet[int]]::new();[void]$ownedIDs.Add($rootID);do{$added=$false;foreach($item in $processes){if($ownedIDs.Contains([int]$item.ParentProcessId) -and $ownedIDs.Add([int]$item.ProcessId)){$added=$true}}}while($added);$result=@(foreach($ownedID in $ownedIDs){$item=Get-Process -Id $ownedID -ErrorAction SilentlyContinue;if($item){[pscustomobject]@{pid=$item.Id;cpuSeconds=$item.CPU;privateBytes=$item.PrivateMemorySize64;workingSetBytes=$item.WorkingSet64;handles=$item.HandleCount}}});ConvertTo-Json -InputObject $result -Compress`;
  const raw=execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,encoding:'utf8',timeout:15000});
  return JSON.parse(raw||'[]');
}
function aggregate(processes){return processes.reduce((out,p)=>{out.processCount++;out.cpuSeconds+=p.cpuSeconds||0;out.privateBytes+=p.privateBytes||0;out.workingSetBytes+=p.workingSetBytes||0;out.handles+=p.handles||0;return out;},{processCount:0,cpuSeconds:0,privateBytes:0,workingSetBytes:0,handles:0});}
async function measurePlain(){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ezbench-runtime-'));let child,output,result;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const packaged=Boolean(process.env.WORK_EZ_BENCH_EXECUTABLE),args=[...(packaged?[]:[path.join(root,'app')]),'--data-dir='+dataDir];
  child=spawn(executablePath,args,{cwd:path.dirname(executablePath),env,windowsHide:true,stdio:'ignore',shell:false});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  await sleep(3000);const samples=[];let previous=null;
  for(let elapsed=0;elapsed<=durationSeconds;elapsed+=5){
   if(child.exitCode!==null)throw new Error('Plain app exited during idle measurement: '+child.exitCode);
   const at=Date.now(),processes=ownedProcesses(child.pid),totals=aggregate(processes);let cpuPercentOneCore=null;
   if(previous){const old=new Map(previous.processes.map(p=>[p.pid,p.cpuSeconds]));let cpu=0;for(const p of processes)if(old.has(p.pid))cpu+=Math.max(0,(p.cpuSeconds||0)-(old.get(p.pid)||0));cpuPercentOneCore=100*cpu/((at-previous.at)/1000);}
   samples.push({at,elapsedSeconds:elapsed,totals,cpuPercentOneCore});previous={at,processes};if(elapsed<durationSeconds)await sleep(5000);
  }
  const cpu=samples.map(s=>s.cpuPercentOneCore).filter(Number.isFinite),packageRoot=packaged?path.join(path.dirname(executablePath),'resources/app'):path.join(root,'app');
  const version=JSON.parse(fs.readFileSync(path.join(packageRoot,'package.json'),'utf8')).version;
  result={date:new Date().toISOString(),version,mode:'plain',executablePath,idleSeconds:durationSeconds,actualSampleSpanSeconds:(samples.at(-1).at-samples[0].at)/1000,idleCpuPercentOneCore:{mean:cpu.reduce((a,b)=>a+b,0)/cpu.length,max:Math.max(...cpu)},logicalCpuCount:os.cpus().length,idleFirst:samples[0].totals,idleLast:samples.at(-1).totals,samples,batteryLifeMeasured:false,scope:'Normal packaged app, no Inspector or Playwright attached, isolated app data, home-page idle. No database or battery discharge test.'};
  output=path.join(root,'evidence','runtime-'+version+'-'+(process.env.EZ_BENCH_MEASUREMENT_LABEL||'plain')+'.json');fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2));
 }finally{
  if(child&&child.exitCode===null){
   // Only this fixture's exact process tree is terminated; no user app is targeted.
   execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:15000});await sleep(300);
   const remaining=ownedProcesses(child.pid);if(remaining.length)throw new Error('Owned plain measurement processes remain after termination.');
   if(result&&output){result.ownedProcessesAfterCleanup=0;result.shutdownMethod='Exact owned PID subtree terminated after measurement';fs.writeFileSync(output,JSON.stringify(result,null,2));}
  }
  const resolved=path.resolve(dataDir);if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(resolved).startsWith('ezbench-runtime-'))throw new Error('Unexpected fixture cleanup path');fs.rmSync(resolved,{recursive:true,force:true});
 }
 console.log(JSON.stringify({output,mode:'plain',idleCpuPercentOneCore:result.idleCpuPercentOneCore,idleFirst:result.idleFirst,idleLast:result.idleLast},null,2));
}
async function main(){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ezbench-runtime-'));let app,page,rootPid;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const started=Date.now();app=await _electron.launch({executablePath,args:[path.join(root,'app'),'--data-dir='+dataDir],env});page=await app.firstWindow();await page.locator('#demo-connect').waitFor();
  rootPid=await app.evaluate(()=>process.pid);const version=await app.evaluate(({app})=>app.getVersion());const startupMs=Date.now()-started;
  await sleep(3000);const samples=[];let previous=null;
  for(let elapsed=0;elapsed<=durationSeconds;elapsed+=5){
   const at=Date.now(),processes=ownedProcesses(rootPid),metrics=await app.evaluate(({app})=>app.getAppMetrics());const totals=aggregate(processes);
   let cpuPercentOneCore=null;
   if(previous){const old=new Map(previous.processes.map(p=>[p.pid,p.cpuSeconds]));let cpu=0;for(const p of processes)if(old.has(p.pid))cpu+=Math.max(0,(p.cpuSeconds||0)-(old.get(p.pid)||0));cpuPercentOneCore=100*cpu/((at-previous.at)/1000);}
   samples.push({at,elapsedSeconds:elapsed,totals,cpuPercentOneCore,electronMetrics:metrics});previous={at,processes};if(elapsed<durationSeconds)await sleep(5000);
  }
  const cycles=[];
  for(let i=0;i<iterations;i++){
   await page.evaluate(async()=>{await window.querydesk.connect({id:'runtime-playground',name:'Runtime fixture',mode:'demo'});const result=await window.querydesk.query({sql:'SELECT count(*) AS n FROM customers'});if(result.rows[0].n!==6)throw new Error('Unexpected fixture rows');await window.querydesk.disconnect();});
   if(i===0||(i+1)%5===0)cycles.push({iteration:i+1,totals:aggregate(ownedProcesses(rootPid))});
  }
  // A full DOM tab lifecycle through the app's production helpers; no SQL is run.
  await page.locator('#demo-connect').click();await page.locator('#editor-view').waitFor({state:'visible'});
  const tabs=await page.evaluate(async()=>{const before=document.querySelectorAll('.query-tab').length;for(let i=0;i<20;i++)addTab('SELECT '+i,'Lifecycle '+i);for(let i=0;i<20;i++)await closeTab();return{before,after:document.querySelectorAll('.query-tab').length};});
  await page.locator('#disconnect').click();await sleep(1000);const afterCycles=aggregate(ownedProcesses(rootPid));
  const cpu=samples.map(s=>s.cpuPercentOneCore).filter(Number.isFinite);const result={date:new Date().toISOString(),version,executablePath,startupMs,idleSeconds:durationSeconds,idleCpuPercentOneCore:{mean:cpu.reduce((a,b)=>a+b,0)/cpu.length,max:Math.max(...cpu)},logicalCpuCount:os.cpus().length,idleFirst:samples[0].totals,idleLast:samples.at(-1).totals,iterations,cycleSamples:cycles,tabs,afterCycles,samples,batteryLifeMeasured:false,scope:'Controlled loopback SQLite fixture, home-page idle; no user databases, no battery discharge test.'};
  const output=path.join(root,'evidence','runtime-'+version+'-'+(process.env.EZ_BENCH_MEASUREMENT_LABEL||'baseline')+'.json');fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2));
  console.log(JSON.stringify({output,startupMs,idleCpuPercentOneCore:result.idleCpuPercentOneCore,idleFirst:result.idleFirst,idleLast:result.idleLast,afterCycles,tabs},null,2));
 }finally{if(app)await app.close();if(rootPid){await sleep(300);const remaining=ownedProcesses(rootPid);if(remaining.length)throw new Error('Owned app processes remain after close.');}const resolved=path.resolve(dataDir);if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(resolved).startsWith('ezbench-runtime-'))throw new Error('Unexpected fixture cleanup path');fs.rmSync(resolved,{recursive:true,force:true});}
}
(plain?measurePlain():main()).catch(error=>{console.error(error);process.exitCode=1;});
