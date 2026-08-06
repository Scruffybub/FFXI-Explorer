const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('path'); const { promises: fs } = require('fs')
const { execFile } = require('child_process'); const { promisify } = require('util')
const ex = promisify(execFile)
async function detect() {
  try {
    const { stdout } = await ex('reg', ['query','HKLM\SOFTWARE\WOW6432Node\PlayOnlineUS\InstallFolder','/v','0001'])
    const m = stdout.match(/REG_SZ\s+(.+)/); if (m) return m[1].trim().replace(/[\/]+$/,'')
  } catch {}
  return 'C:\FFXI-Data'
}
app.whenReady().then(async () => {
  ipcMain.handle('ffxi:autoDetect', () => detect())
  ipcMain.handle('ffxi:pickDirectory', () => ({ status:'cancelled' }))
  ipcMain.handle('ffxi:readDat', (_e,r,p) => fs.readFile(join(r, ...p.replace(/\/g,'/').split('/'))))
  ipcMain.handle('ffxi:fileExists', async (_e,r,p) => { try { await fs.stat(join(r, ...p.replace(/\/g,'/').split('/'))); return true } catch { return false } })
  const win = new BrowserWindow({ width:1500, height:850, show:false, backgroundColor:'#0b0d12',
    webPreferences:{ preload: join(__dirname,'../out/preload/index.js'), sandbox:false, contextIsolation:true } })
  const logs=[]; win.webContents.on('console-message',(_e,_l,m)=>logs.push(m))
  await win.loadFile(join(__dirname,'../out/renderer/index.html'), { search:`zone=${process.argv[2]||'100'}&preset=0&gotowater=1` })
  await new Promise(r=>setTimeout(r,16000))
  const on = await win.webContents.executeJavaScript(`
    (()=>{const b=[...document.querySelectorAll('.view-tools button')].find(x=>x.textContent.trim()==='Inspect');
      if(!b) return false; b.click(); return true;})()`)
  console.log('inspect enabled: '+on)
  await new Promise(r=>setTimeout(r,500))
  const rect = JSON.parse(await win.webContents.executeJavaScript(
    `(()=>{const c=document.querySelector('canvas');const r=c.getBoundingClientRect();
      return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2});})()`))
  win.webContents.sendInputEvent({type:'mouseDown',x:Math.round(rect.x),y:Math.round(rect.y),button:'left',clickCount:1})
  await new Promise(r=>setTimeout(r,120))
  win.webContents.sendInputEvent({type:'mouseUp',x:Math.round(rect.x),y:Math.round(rect.y),button:'left',clickCount:1})
  await new Promise(r=>setTimeout(r,1500))
  const panel = await win.webContents.executeJavaScript(
    `(()=>{const p=document.querySelector('.inspector');return p?p.innerText:'NO PANEL';})()`)
  console.log('--- PANEL ---\n'+panel)
  const img = await win.webContents.capturePage()
  await fs.writeFile(process.argv[3]||'inspect.png', img.toPNG())
  app.exit(0)
})
