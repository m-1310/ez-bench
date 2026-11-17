'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {_electron}=require('playwright');
const executablePath=process.env.WORK_EZ_BENCH_EXECUTABLE||path.join(__dirname,'node_modules/electron/dist/electron.exe');
async function launch(dir){const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const app=await _electron.launch({executablePath,args:[__dirname,'--data-dir='+dir],env});const page=await app.firstWindow();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',error=>errors.push(error.message));if(process.env.WORK_EZ_BENCH_EXECUTABLE)assert.equal(path.resolve(await app.evaluate(({app})=>app.getAppPath())),path.resolve(path.dirname(executablePath),'resources/app'));await page.locator('#demo-connect').click();await page.locator('#schema-tree .table-row').first().waitFor();return{app,page,errors};}
async function menu(app,section,label){await app.evaluate(({Menu},{section,label})=>{const item=Menu.getApplicationMenu().items.find(item=>item.label.replace(/&/g,'')===section).submenu.items.find(item=>item.label===label);if(!item)throw new Error('Missing native action '+label);item.click();},{section,label});}
async function cleanup(app,page,dir){if(page)await page.evaluate(()=>{if(result)delete result._edit;for(const tab of tabs)if(tab.result)delete tab.result._edit;}).catch(()=>{});if(app){await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});});await app.close();}assert.ok(path.basename(dir).startsWith('ezbench-tabs-ui-'));fs.rmSync(dir,{recursive:true,force:true});}
test('middle-click closes inactive tabs, reopens buffers, and context actions rename/duplicate/close others',{timeout:60000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ezbench-tabs-ui-'));let app,page;
 try{const started=await launch(dir);({app,page}=started);await page.locator('#new-tab').click();await page.locator('#sql-editor').fill("SELECT 'second tab buffer'");const second=await page.locator('.query-tab.active').getAttribute('data-tab-id');await page.locator('#new-tab').click();await page.locator('#sql-editor').fill("SELECT 'active third'");const active=await page.locator('.query-tab.active').getAttribute('data-tab-id');
  await page.locator(`.query-tab[data-tab-id="${second}"]`).click({button:'middle'});assert.equal(await page.locator('.query-tab').count(),2);assert.equal(await page.locator('.query-tab.active').getAttribute('data-tab-id'),active);assert.equal(await page.locator('#sql-editor').inputValue(),"SELECT 'active third'");
  await menu(app,'File','Reopen closed tab');await page.waitForFunction(()=>document.querySelectorAll('.query-tab').length===3);assert.equal(await page.locator('#sql-editor').inputValue(),"SELECT 'second tab buffer'");
  await page.locator('.query-tab.active').click({button:'right'});await page.locator('#tab-menu-rename').click();await page.locator('#rename-tab-name').fill('Customer report');await page.locator('#rename-tab-form button[type="submit"]').click();assert.ok((await page.locator('.query-tab.active').innerText()).includes('Customer report'));
  await page.locator('.query-tab.active').click({button:'right'});await page.locator('#tab-menu-duplicate').click();assert.equal(await page.locator('.query-tab').count(),4);assert.equal(await page.locator('#sql-editor').inputValue(),"SELECT 'second tab buffer'");assert.ok((await page.locator('.query-tab.active').innerText()).includes('copy'));
  const beforeCycle=await page.locator('.query-tab.active').getAttribute('data-tab-id');await menu(app,'Window','Next SQL tab');await page.waitForFunction(id=>document.querySelector('.query-tab.active').dataset.tabId!==id,beforeCycle);await menu(app,'Window','Previous SQL tab');await page.waitForFunction(id=>document.querySelector('.query-tab.active').dataset.tabId===id,beforeCycle);
  await page.locator('.query-tab.active').click({button:'right'});await page.locator('#tab-menu-others').click();await page.waitForFunction(()=>document.querySelectorAll('.query-tab').length===1);
  const lastId=await page.locator('.query-tab.active').getAttribute('data-tab-id');await page.locator('.query-tab.active').click({button:'middle'});assert.equal(await page.locator('#sql-editor').inputValue(),"SELECT 'second tab buffer'");assert.equal(await page.locator('.query-tab.active').getAttribute('data-tab-id'),lastId);assert.equal(await page.locator('.query-tab').count(),1);assert.deepEqual(started.errors,[]);
 }finally{await cleanup(app,page,dir);}
});
test('middle-click and close-other tabs preserve pending grid changes until discard is explicit',{timeout:60000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ezbench-tabs-ui-'));let app,page;
 try{const started=await launch(dir);({app,page}=started);await page.locator('#schema-tree .table-row').filter({hasText:/^products$/}).locator('button').first().click();await page.waitForFunction(()=>!document.querySelector('#run-query').disabled);const editedId=await page.locator('.query-tab.active').getAttribute('data-tab-id');
  const cell=page.locator('tr[data-row-index="0"] td[data-column="stock"]');await cell.dblclick();await cell.locator('input').fill('99');await cell.locator('input').press('Enter');await page.locator('.query-tab.active').click({button:'middle'});await page.locator('#discard-dialog').waitFor();await page.locator('#discard-stay').click();assert.equal(await page.locator('.grid-cell-changed').count(),1);assert.equal(await page.locator('.query-tab').count(),2);
  await page.locator('#new-tab').click();await page.locator('.query-tab.active').click({button:'right'});await page.locator('#tab-menu-others').click();await page.locator('#discard-dialog').waitFor();await page.locator('#discard-stay').click();assert.equal(await page.locator('.query-tab').count(),3);
  await page.locator(`.query-tab[data-tab-id="${editedId}"]`).click();assert.equal(await page.locator('.grid-cell-changed').count(),1);
  await page.locator('.query-tab.active').click({button:'middle'});await page.locator('#discard-confirm').click();await page.waitForFunction(()=>document.querySelectorAll('.query-tab').length===2);assert.equal(await page.locator(`.query-tab[data-tab-id="${editedId}"]`).count(),0);assert.deepEqual(started.errors,[]);
 }finally{await cleanup(app,page,dir);}
});

test('last query tab survives every close path without losing SQL, privacy, edits or query numbering',{timeout:60000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ezbench-tabs-ui-'));let app,page;
 try{const started=await launch(dir);({app,page}=started);
  const id=await page.locator('.query-tab.active').getAttribute('data-tab-id');
  const sql="SELECT 'keep the final query' AS preserved";
  await page.locator('#sql-editor').fill(sql);await page.locator('#private-query').check();
  assert.equal(await page.locator('.tab-close').getAttribute('aria-disabled'),'true');
  await page.locator('.tab-close').dispatchEvent('click');
  await page.locator('.query-tab.active').click({button:'middle'});
  await page.locator('#sql-editor').press('Control+w');
  await menu(app,'File','Close SQL tab');
  await page.locator('.query-tab.active').click({button:'right'});
  assert.equal(await page.locator('#tab-menu-close').isDisabled(),true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.query-tab').count(),1);
  assert.equal(await page.locator('.query-tab.active').getAttribute('data-tab-id'),id);
  assert.equal(await page.locator('#sql-editor').inputValue(),sql);
  assert.equal(await page.locator('#private-query').isChecked(),true);
  assert.equal(await page.locator('#discard-dialog').isVisible(),false);
  await page.locator('#new-tab').click();
  assert.ok((await page.locator('.query-tab.active').innerText()).includes('Query 2'),'Blocked closes must not increment the next query number');
  const raced=await page.evaluate(async()=>{const count=tabCount;await Promise.all(tabs.map(tab=>closeTab(tab.id)));return{count,after:tabCount,tabs:tabs.length};});
  assert.equal(raced.tabs,1);assert.equal(raced.after,raced.count);
  await page.locator('#schema-tree .table-row').filter({hasText:/^products$/}).locator('button').first().click();
  await page.waitForFunction(()=>!document.querySelector('#run-query').disabled);
  const cell=page.locator('tr[data-row-index="0"] td[data-column="stock"]');
  await cell.dblclick();await cell.locator('input').fill('99');await cell.locator('input').press('Enter');
  await page.locator('.query-tab.active').click({button:'right'});await page.locator('#tab-menu-others').click();
  await page.waitForFunction(()=>document.querySelectorAll('.query-tab').length===1);
  await page.locator('.query-tab.active').click({button:'middle'});await menu(app,'File','Close SQL tab');
  assert.equal(await page.locator('#discard-dialog').isVisible(),false);
  assert.equal(await page.locator('.grid-cell-changed').count(),1);
  assert.equal(await page.locator('.query-tab').count(),1);
  assert.deepEqual(started.errors,[]);
 }finally{await cleanup(app,page,dir);}
});
