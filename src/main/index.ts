import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/** Files/folders that must exist for a directory to be a valid FFXI install. */
const VALIDATION_ENTRIES = ['ROM', 'ROM2', 'VTABLE.DAT']

let mainWindow: BrowserWindow | null = null

/** Path of the settings file holding the remembered FFXI directory. */
function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

async function readSettings(): Promise<{ ffxiPath?: string }> {
  try {
    return JSON.parse(await fs.readFile(settingsPath(), 'utf-8'))
  } catch {
    return {}
  }
}

async function writeSettings(settings: { ffxiPath?: string }): Promise<void> {
  try {
    await fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2), 'utf-8')
  } catch {
    /* non-fatal */
  }
}

/** True when the directory looks like an FFXI installation root. */
async function isValidFfxiDir(dir: string): Promise<boolean> {
  for (const entry of VALIDATION_ENTRIES) {
    try {
      await fs.stat(join(dir, entry))
    } catch {
      return false
    }
  }
  return true
}

/**
 * Look for an FFXI install without asking the user. Reads the PlayOnline
 * registry keys first, then falls back to the usual install locations.
 * Unlike the browser, we can read straight out of Program Files.
 */
async function autoDetectFfxiPath(): Promise<string | null> {
  const registryKeys = [
    'HKLM\\SOFTWARE\\WOW6432Node\\PlayOnlineUS\\InstallFolder',
    'HKLM\\SOFTWARE\\WOW6432Node\\PlayOnlineEU\\InstallFolder',
    'HKLM\\SOFTWARE\\WOW6432Node\\PlayOnline\\InstallFolder',
    'HKLM\\SOFTWARE\\PlayOnlineUS\\InstallFolder',
    'HKLM\\SOFTWARE\\PlayOnlineEU\\InstallFolder',
    'HKLM\\SOFTWARE\\PlayOnline\\InstallFolder',
  ]

  for (const key of registryKeys) {
    try {
      const { stdout } = await execFileAsync('reg', ['query', key, '/v', '0001'])
      // Output looks like:  0001    REG_SZ    C:\...\FINAL FANTASY XI\
      const match = stdout.match(/REG_SZ\s+(.+)/)
      if (match) {
        const dir = match[1].trim().replace(/[\\/]+$/, '')
        if (await isValidFfxiDir(dir)) return dir
      }
    } catch {
      /* key absent — try the next one */
    }
  }

  const commonPaths = [
    'C:\\Program Files (x86)\\PlayOnline\\SquareEnix\\FINAL FANTASY XI',
    'C:\\Program Files\\PlayOnline\\SquareEnix\\FINAL FANTASY XI',
    'C:\\PlayOnline\\SquareEnix\\FINAL FANTASY XI',
    'C:\\FFXI-Data',
    'D:\\PlayOnline\\SquareEnix\\FINAL FANTASY XI',
  ]
  for (const dir of commonPaths) {
    if (await isValidFfxiDir(dir)) return dir
  }

  return null
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0b0d12',
    show: false,
    autoHideMenuBar: true,
    title: 'FFXI Zone Viewer',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // ── FFXI directory handling ────────────────────────────────────────────
  ipcMain.handle('ffxi:autoDetect', async () => {
    const saved = (await readSettings()).ffxiPath
    if (saved && (await isValidFfxiDir(saved))) return saved

    const detected = await autoDetectFfxiPath()
    if (detected) await writeSettings({ ffxiPath: detected })
    return detected
  })

  ipcMain.handle('ffxi:pickDirectory', async () => {
    if (!mainWindow) return { status: 'cancelled' as const }

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select your FINAL FANTASY XI folder',
      properties: ['openDirectory'],
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { status: 'cancelled' as const }
    }

    const dir = result.filePaths[0]
    if (!(await isValidFfxiDir(dir))) {
      return { status: 'invalid' as const, path: dir }
    }

    await writeSettings({ ffxiPath: dir })
    return { status: 'ok' as const, path: dir }
  })

  // ── Game file reads ────────────────────────────────────────────────────
  ipcMain.handle('ffxi:readDat', async (_evt, rootPath: string, relativePath: string) => {
    const normalized = relativePath.replace(/\\/g, '/')
    // Refuse anything trying to climb out of the game directory.
    if (normalized.split('/').some(seg => seg === '..')) {
      throw new Error(`Invalid path: ${relativePath}`)
    }
    const full = join(rootPath, ...normalized.split('/'))
    const buffer = await fs.readFile(full)
    // Return the raw bytes; the renderer turns this back into an ArrayBuffer.
    return buffer
  })

  ipcMain.handle('ffxi:fileExists', async (_evt, rootPath: string, relativePath: string) => {
    try {
      await fs.stat(join(rootPath, ...relativePath.replace(/\\/g, '/').split('/')))
      return true
    } catch {
      return false
    }
  })

  // ── Window / capture ───────────────────────────────────────────────────
  ipcMain.handle('window:setFullscreen', (_evt, on: boolean) => {
    mainWindow?.setFullScreen(on)
    return mainWindow?.isFullScreen() ?? false
  })

  ipcMain.handle('window:isFullscreen', () => mainWindow?.isFullScreen() ?? false)

  /** Writes a PNG the renderer captured. Returns the saved path, or null if cancelled. */
  ipcMain.handle('window:saveScreenshot', async (_evt, dataUrl: string, suggestedName: string) => {
    if (!mainWindow) return null

    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save screenshot',
      defaultPath: join(app.getPath('pictures'), suggestedName),
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    })
    if (result.canceled || !result.filePath) return null

    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')
    await fs.writeFile(result.filePath, Buffer.from(base64, 'base64'))
    return result.filePath
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
