'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {_electron}=require('playwright');
const executablePath=process.env.WORK_EZ_BENCH_EXECUTABLE||path.join(__dirname,'node_modules/electron/dist/electron.exe');
test('editor runs current statements, completes names, pages tables and preserves full values without saving private SQL',{timeout:120000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ezbench-editor-ui-'));let app,page;
 try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({executablePath,args:[__dirname,'--data-dir='+directory],env});page=await app.firstWindow();page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.locator('#demo-connect').click();await page.locator('#schema-tree .table-row').first().waitFor();
  const run=async(sql,position)=>{await page.locator('#results-tab').click();await page.locator('#sql-editor').fill(sql);if(position!==undefined)await page.locator('#sql-editor').evaluate((node,offset)=>node.setSelectionRange(offset,offset),position);await page.locator('#run-query').click();await page.waitForFunction(()=>!document.querySelector('#run-query').disabled);assert.equal((await page.locator('#result-message').getAttribute('class')).includes('error'),false,await page.locator('#result-message').innerText());};
  await run('SELECT 11 AS first_value; SELECT 22 AS second_value;',4);assert.match(await page.locator('#result-table').innerText(),/11/);assert.doesNotMatch(await page.locator('#result-table').innerText(),/22/);
  await run('SELECT 11 AS first_value; SELECT 22 AS second_value;',40);assert.match(await page.locator('#result-table').innerText(),/22/);
  await page.locator('#sql-editor').fill('SEL');await page.locator('#sql-complete').click();await page.locator('#sql-completions button').filter({hasText:/^SELECT /}).click();assert.equal(await page.locator('#sql-editor').inputValue(),'SELECT');
  await run('CREATE TABLE page_fixture (id INTEGER PRIMARY KEY, value TEXT)');
  await run("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<205) INSERT INTO page_fixture SELECT x, printf('value %d',x) FROM n");
  await page.locator('#schema-tree .table-row').filter({hasText:/^page_fixture$/}).locator('button').first().click();await page.waitForFunction(()=>!document.querySelector('#run-query').disabled);
  assert.equal(await page.locator('#result-table tbody tr').count(),100);
  await page.locator('#table-next').click();await page.waitForFunction(()=>!document.querySelector('#run-query').disabled);assert.equal(await page.locator('#result-table tbody tr').first().locator('td[data-column="id"]').textContent(),'101');
  await page.locator('#table-next').click();await page.waitForFunction(()=>!document.querySelector('#run-query').disabled);assert.equal(await page.locator('#result-table tbody tr').count(),5);assert.equal(await page.locator('#table-next').isDisabled(),true);
  const full='Full value '+('long text '.repeat(1000))+' END';await run('SELECT '+"'"+full+"' AS long_value");await page.locator('#result-table tbody tr td').last().dblclick();assert.equal(await page.locator('#value-text').inputValue(),full);await page.locator('#value-copy').click();assert.equal(await app.evaluate(({clipboard})=>clipboard.readText()),full);await page.locator('#value-close').click();
  const before=await page.locator('.editor-area').evaluate(node=>node.clientHeight);await page.locator('#editor-resize').focus();await page.locator('#editor-resize').press('ArrowUp');assert.ok(await page.locator('.editor-area').evaluate(node=>node.clientHeight)<before);
  await page.locator('#private-query').check();const secret='PRIVATE-EDITOR-FIXTURE-'+Date.now();await run("SELECT '"+secret+"' AS private_value");await page.evaluate(()=>{saveTab();flushEditorState();});const persisted=await page.evaluate(()=>JSON.stringify({...localStorage}));assert.equal(persisted.includes(secret),false);const history=await page.evaluate(()=>window.querydesk.history({}));assert.equal(JSON.stringify(history).includes(secret),false);
  await page.evaluate(()=>BenchTabs.duplicate());assert.equal(await page.locator('#private-query').isChecked(),true);await page.locator('.query-tab.active .tab-close').click();await page.evaluate(()=>BenchTabs.reopen());assert.equal(await page.locator('#private-query').isChecked(),true);await page.evaluate(()=>{saveTab();flushEditorState();});assert.equal((await page.evaluate(()=>JSON.stringify({...localStorage}))).includes(secret),false);
  await run('SELECT 1 AS resumed_private');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1040,720));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const bounds=await page.locator('#result-table').boundingBox();assert.ok(bounds.height>30);assert.deepEqual(errors,[]);
 }finally{if(app)await app.close();assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(directory).startsWith('ezbench-editor-ui-'));fs.rmSync(directory,{recursive:true,force:true});}
});
