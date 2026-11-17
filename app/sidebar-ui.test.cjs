'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const { workspaceAction } = require('./ui-actions.cjs');

test('sidebar preserves text, separates scroll areas, wraps long names, exposes collapsed labels and marks only active connections', { timeout: 90000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-sidebar-'));
  const executablePath = process.env.WORK_EZ_BENCH_EXECUTABLE || path.join(__dirname,'node_modules/electron/dist/electron.exe');
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  let application;
  try {
    application = await _electron.launch({executablePath,args:[__dirname,'--data-dir='+directory],env});
    const page = await application.firstWindow(); page.setDefaultTimeout(10000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.locator('#demo-connect').waitFor();
    const capture=async name=>{
      await page.mouse.move(2,2);await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
      const png=await application.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
      fs.writeFileSync(path.resolve(__dirname,'../evidence/sidebar-0.9.5-'+name+'.png'),Buffer.from(png,'base64'));
    };
    assert.equal(await page.locator('.connection-item[aria-pressed=true]').count(),0);
    for(const text of ['WORKSPACE','Overview','CONNECTIONS','Local by design','Your connections. Your data.'])assert.ok((await page.locator('.sidebar').innerText()).includes(text),text+' remains');
    await capture('overview');
    await page.locator('#demo-connect').click(); await page.locator('#schema-tree .table-row').first().waitFor();
    assert.equal(await page.locator('.connection-item[aria-pressed=true]').count(),1);
    assert.ok((await page.locator('#connection-status').innerText()).startsWith('Connected ·'));
    await capture('workspace');
    await page.evaluate(async()=>{
      for(let index=0;index<18;index++)await api.saveProfile({mode:'mysql',name:'Reporting workspace '+String(index).padStart(2,'0')+' — long connection name',host:'127.0.0.1',port:1,user:'fixture',database:''});
      profiles=await api.profiles();renderConnections();
    });
    await page.locator('#sql-editor').fill(Array.from({length:24},(_,index)=>'CREATE TABLE sidebar_'+String(index).padStart(2,'0')+'_a_long_table_name_to_check_wrapping(id INTEGER PRIMARY KEY);').join('\n'));
    await page.locator('#run-script').click();await page.waitForFunction(()=>!document.querySelector('#run-script').disabled);
    await page.locator('#refresh-schema').click();await page.waitForFunction(()=>document.querySelectorAll('#schema-tree .table-row').length===27);
    await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1040,720));
    const measure=()=>page.evaluate(()=>{
      const box=selector=>document.querySelector(selector).getBoundingClientRect().toJSON();
      return{sidebar:box('.sidebar'),footer:box('.sidebar-bottom'),explorer:box('#schema-section'),search:box('#schema-filter'),tree:box('#schema-tree'),connections:box('#connections-list'),nav:box('#home-button'),outerScroll:document.querySelector('.sidebar').scrollHeight,outerHeight:document.querySelector('.sidebar').clientHeight,connectionsScroll:document.querySelector('#connections-list').scrollHeight,connectionsHeight:document.querySelector('#connections-list').clientHeight,treeScroll:document.querySelector('#schema-tree').scrollHeight,treeHeight:document.querySelector('#schema-tree').clientHeight};
    });
    const before=await measure();
    assert.ok(before.outerScroll<=before.outerHeight+1,JSON.stringify(before));
    assert.ok(before.connectionsScroll>before.connectionsHeight&&before.treeScroll>before.treeHeight,JSON.stringify(before));
    assert.ok(before.explorer.bottom<=before.footer.top+1&&before.footer.bottom<=before.sidebar.bottom,JSON.stringify(before));
    assert.ok(before.tree.height>=95,JSON.stringify(before));
    await capture('minimum-many');
    await page.locator('#connections-list').evaluate(node=>node.scrollTop=node.scrollHeight);
    await page.locator('#schema-tree').evaluate(node=>node.scrollTop=node.scrollHeight);
    const after=await measure();
    assert.equal(after.nav.top,before.nav.top);assert.equal(after.search.top,before.search.top);assert.equal(after.footer.top,before.footer.top);
    await capture('scrolled');
    await page.locator('#schema-filter').fill('sidebar_23');
    assert.equal(await page.locator('#schema-tree .table-row').count(),1);
    const name=page.locator('#schema-tree .table-name');
    assert.equal(await name.innerText(),'sidebar_23_a_long_table_name_to_check_wrapping');
    assert.ok(await name.evaluate(node=>node.scrollWidth<=node.clientWidth+1));
    await page.locator('#schema-filter').fill('');
    await page.locator('#sidebar-toggle').click();assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'),'false');
    assert.ok(await page.locator('.sidebar').evaluate(node=>node.getBoundingClientRect().width===64));
    for(const button of await page.locator('#connections-list button').all())assert.ok(await button.getAttribute('aria-label'));
    await capture('collapsed');
    await application.evaluate(({Menu})=>Menu.getApplicationMenu().getMenuItemById('sidebar-toggle').click());
    await page.waitForFunction(()=>document.querySelector('#sidebar-toggle').getAttribute('aria-expanded')==='true');
    await workspaceAction(page,'theme-toggle');await capture('light-minimum');
    await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25));
    const zoom=await measure();assert.ok(zoom.outerScroll<=zoom.outerHeight+1&&zoom.footer.bottom<=zoom.sidebar.bottom,JSON.stringify(zoom));
    await capture('light-125');
    await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
    // Opening saved metadata does not claim a new successful connection.
    await page.locator('#connections-list .connection-item').filter({hasText:'Reporting workspace 00'}).click();await page.locator('#connection-dialog').waitFor();
    assert.equal(await page.locator('.connection-item.selected').count(),1);
    assert.ok((await page.locator('.connection-item.selected').innerText()).includes('Local playground'));
    await page.locator('#connection-form').evaluate(form=>form.requestSubmit());
    await page.waitForFunction(()=>document.querySelector('#connection-error').textContent.length>0);
    assert.equal(await page.locator('.connection-item.selected').count(),0);
    assert.ok(!(await page.locator('#connection-status').innerText()).startsWith('Connected ·'));
    await capture('connection-failed');
    await page.locator('#close-connection').click();assert.deepEqual(errors,[]);
  } finally {await application?.close();fs.rmSync(directory,{recursive:true,force:true});}
});
