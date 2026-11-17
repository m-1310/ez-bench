'use strict';
// Render the repository's vector mark into the PNG/ICO used by Windows builds.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { _electron } = require('playwright');
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-brand-icon-'));
  let application;
  try {
    const entry = path.join(directory, 'main.cjs');
    const svgPath = path.join(__dirname, 'icon.svg');
    fs.writeFileSync(entry, "const {app,BrowserWindow}=require('electron');const path=require('node:path');app.setPath('userData',path.join(__dirname,'data'));app.whenReady().then(()=>{const window=new BrowserWindow({width:256,height:256,frame:false,show:false,skipTaskbar:true,transparent:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});window.once('ready-to-show',()=>window.showInactive());window.loadFile(" + JSON.stringify(svgPath) + ");});app.on('window-all-closed',()=>app.quit());");
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ executablePath: path.join(__dirname, 'node_modules/electron/dist/electron.exe'), args: [entry], env });
    const page = await application.firstWindow(); await page.locator('svg').waitFor();
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: 256, height: 256 } });
    fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
    // ICO permits an embedded PNG. A zero dimension byte denotes 256 pixels.
    const rendered = await application.evaluate(({ nativeImage }, base64) => {
      const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
      return [16, 24, 32, 48, 64, 128, 256].map(size => ({ size, png: image.resize({ width: size, height: size, quality: 'best' }).toPNG().toString('base64') }));
    }, png.toString('base64'));
    const frames = rendered.map(frame => ({ size: frame.size, png: Buffer.from(frame.png, 'base64') }));
    const header = Buffer.alloc(6 + frames.length * 16); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
    let offset = header.length;
    frames.forEach(({ size, png }, index) => { const at = 6 + index * 16; header[at] = header[at + 1] = size === 256 ? 0 : size; header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6); header.writeUInt32LE(png.length, at + 8); header.writeUInt32LE(offset, at + 12); offset += png.length; });
    fs.writeFileSync(path.join(__dirname, 'icon.ico'), Buffer.concat([header, ...frames.map(frame => frame.png)]));
    process.stdout.write('Rendered icon.svg to icon.png and icon.ico.\n');
  } finally {
    await application?.close();
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('ez-brand-icon-')) throw new Error('Unexpected icon fixture path.');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
