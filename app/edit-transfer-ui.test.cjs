'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {_electron}=require('playwright');
const executablePath=process.env.WORK_EZ_BENCH_EXECUTABLE||path.join(__dirname,'node_modules/electron/dist/electron.exe');
async function launch(dir){const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const app=await _electron.launch({executablePath,args:[__dirname,'--data-dir='+dir],env});const page=await app.firstWindow();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',error=>errors.push(error.message));if(process.env.WORK_EZ_BENCH_EXECUTABLE)assert.equal(path.resolve(await app.evaluate(({app})=>app.getAppPath())),path.resolve(path.dirname(executablePath),'resources/app'));await page.locator('#demo-connect').click();await page.locator('#schema-tree .table-row').first().waitFor();return{app,page,errors};}
async function openTable(page,name){await page.locator('#schema-tree .table-row').filter({hasText:new RegExp('^'+name+'$')}).locator('button').first().click();await page.waitForFunction(()=>!document.querySelector('#run-query').disabled);await page.locator('#table-edit-toolbar').waitFor();}
async function edit(page,row,column,value){const cell=page.locator(`#result-table tbody tr[data-row-index="${row}"] td[data-column="${column}"]`);await cell.dblclick();await cell.locator('input').fill(value);await cell.locator('input').press('Enter');}
async function apply(page){await page.locator('#table-apply').click();await page.locator('#apply-dialog').waitFor();await page.waitForFunction(()=>!document.querySelector('#apply-confirm').disabled);await page.locator('#apply-confirm').click();await page.locator('#apply-dialog').waitFor({state:'hidden'});await page.waitForFunction(()=>!document.querySelector('#run-query').disabled);}
test('table UI stages direct edits, review/apply, inserts/deletes, conflicts, readonly results and discard guards',{timeout:120000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workez-edit-ui-'));let app,page;
 try{const started=await launch(dir);({app,page}=started);await openTable(page,'products');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1040,720));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const geometry=await page.evaluate(()=>({width:innerWidth,height:innerHeight,apply:document.getElementById('table-apply').getBoundingClientRect().toJSON(),grid:document.getElementById('table-scroll').getBoundingClientRect().toJSON(),disconnect:document.getElementById('disconnect').getBoundingClientRect().toJSON()}));
  assert.ok(geometry.apply.right<=geometry.width&&geometry.apply.top>=0);assert.ok(geometry.grid.height>=70);assert.ok(geometry.disconnect.right<=geometry.width);const sidebarLayout=await page.evaluate(()=>({footer:document.querySelector('.sidebar-bottom').getBoundingClientRect().top,schema:document.querySelector('#schema-section').getBoundingClientRect().bottom}));assert.ok(sidebarLayout.schema<=sidebarLayout.footer);
  await page.screenshot({path:path.resolve(__dirname,'../evidence/work-ez-bench-minimum-grid.png')});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,940));
  assert.equal((await page.locator('td[data-column="id"]').first().getAttribute('class')).includes('grid-cell-editable'),false);
  await page.locator('#result-filter').fill('Wireless');await edit(page,5,'name',"Wireless Mouse's new name");
  await page.screenshot({path:path.resolve(__dirname,'../evidence/work-ez-bench-pending-edit.png')});assert.equal(await page.locator('.grid-cell-changed').count(),1);assert.equal(await page.locator('#table-change-count').innerText(),'1');
  let check=new DatabaseSync(path.join(dir,'demo.db'));assert.equal(check.prepare('SELECT name FROM products WHERE id=6').get().name,'Wireless Mouse');check.close();
  await page.locator('#table-apply').click();await page.waitForFunction(()=>!document.querySelector('#apply-confirm').disabled);
  await page.screenshot({path:path.resolve(__dirname,'../evidence/work-ez-bench-apply-preview.png')});assert.ok((await page.locator('#apply-preview').innerText()).includes('UPDATE'));assert.ok((await page.locator('#apply-preview').innerText()).includes("Mouse's new name"));
  await page.locator('#apply-confirm').click();await page.locator('#apply-dialog').waitFor({state:'hidden'});await page.waitForFunction(()=>!document.querySelector('#run-query').disabled);
  check=new DatabaseSync(path.join(dir,'demo.db'));assert.equal(check.prepare('SELECT name FROM products WHERE id=6').get().name,"Wireless Mouse's new name");check.close();
  await page.locator('#table-add-row').click();for(const[column,value]of Object.entries({name:'Added in grid',category:'Test',price:'35.50',stock:'2'}))await edit(page,6,column,value);
  await apply(page);assert.equal(await page.locator('#result-table tbody tr').count(),7);
  await page.locator('input[aria-label="Select row 7"]').check();await page.locator('#table-delete-rows').click();assert.equal(await page.locator('.grid-row-deleted').count(),1);await apply(page);assert.equal(await page.locator('#result-table tbody tr').count(),6);
  await edit(page,0,'price','invalid');await page.locator('#table-apply').click();await page.waitForFunction(()=>document.querySelector('#apply-error').textContent.length>0);assert.ok((await page.locator('#apply-error').innerText()).includes('number'),await page.locator('#apply-error').innerText());assert.equal(await page.locator('#apply-confirm').isDisabled(),true);await page.locator('#apply-back').click();await page.locator('#table-discard').click();
  await edit(page,0,'stock','99');check=new DatabaseSync(path.join(dir,'demo.db'));check.exec('UPDATE products SET stock=40 WHERE id=1');check.close();
  await page.locator('#table-apply').click();await page.waitForFunction(()=>!document.querySelector('#apply-confirm').disabled);await page.locator('#apply-confirm').click();await page.waitForFunction(()=>document.querySelector('#apply-error').textContent.includes('changed in the database'));assert.equal(await page.locator('.grid-cell-changed').count(),1);await page.locator('#apply-back').click();
  await page.locator('#sql-editor').fill('SELECT 123 AS value');await page.locator('#run-query').click();await page.locator('#discard-dialog').waitFor();await page.locator('#discard-stay').click();assert.equal(await page.locator('.grid-cell-changed').count(),1);
  await page.locator('#run-query').click();await page.locator('#discard-confirm').click();await page.waitForFunction(()=>document.querySelector('#result-table').textContent.includes('123'));assert.equal(await page.locator('#table-edit-toolbar').isVisible(),false);
  await openTable(page,'customers');await page.locator('#result-table tbody tr').first().locator('td[data-column="city"]').press('F2');await page.locator('#cell-dialog').waitFor();await page.locator('#cell-value').fill('New city\nwith notes');await page.locator('#cell-save').click();await apply(page);
  await page.screenshot({path:path.resolve(__dirname,'../evidence/work-ez-bench-editing.png')});
  assert.deepEqual(started.errors,[]);
 }finally{if(page)await page.evaluate(()=>{for(const t of tabs){if(t.result)delete t.result._edit;}if(result)delete result._edit;}).catch(()=>{});if(app)await app.close();assert.ok(path.basename(dir).startsWith('workez-edit-ui-'));fs.rmSync(dir,{recursive:true,force:true});}
});
test('database backup and restore UI uses real SQLite files and opens the restored database',{timeout:90000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workez-transfer-ui-'));let app,page;
 try{const started=await launch(dir);({app,page}=started);const backup=path.join(dir,'full-backup.db'),restored=path.join(dir,'restored.db');
  await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},backup);
  await page.locator('#database-backup').click();await page.waitForFunction(()=>document.querySelector('#transfer-scope').textContent.includes('Complete SQLite'));
  await page.locator('#transfer-choose').click();await page.locator('#transfer-run').click();await page.waitForFunction(()=>document.querySelector('#transfer-progress').textContent.includes('Backup saved'));
  assert.ok(fs.statSync(backup).size>0);let check=new DatabaseSync(backup);assert.equal(check.prepare('SELECT COUNT(*) AS n FROM customers').get().n,6);check.close();await page.locator('#transfer-cancel').click();
  await app.evaluate(({dialog},files)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[files.backup]});dialog.showSaveDialog=async()=>({canceled:false,filePath:files.restored});},{backup,restored});
  await page.locator('#database-restore').click();await page.waitForFunction(()=>document.querySelector('#transfer-progress').textContent==='');await page.locator('#transfer-choose').click();await page.locator('#transfer-review').waitFor();await page.locator('#transfer-destination').click();
  await page.locator('#transfer-confirm-text').fill('wrong');assert.equal(await page.locator('#transfer-run').isDisabled(),true);await page.locator('#transfer-confirm-text').fill('RESTORE');await page.locator('#transfer-run').click();
  await page.locator('#transfer-dialog').waitFor({state:'hidden'});await page.waitForFunction(()=>document.querySelector('#workspace-name').textContent==='restored.db');assert.ok(fs.existsSync(restored));assert.ok(fs.existsSync(path.join(dir,'demo.db')));
  await openTable(page,'customers');assert.equal(await page.locator('#result-table tbody tr').count(),6);assert.equal(await page.locator('#dialect-badge').innerText(),'SQLite');assert.deepEqual(started.errors,[]);
 }finally{if(app)await app.close();assert.ok(path.basename(dir).startsWith('workez-transfer-ui-'));fs.rmSync(dir,{recursive:true,force:true});}
});
