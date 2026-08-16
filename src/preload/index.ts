import { contextBridge, ipcRenderer } from 'electron'

export type PickResult =
  | { status: 'ok'; path: string }
  | { status: 'cancelled' }
  | { status: 'invalid'; path: string }

const api = {
  /** Remembered or auto-detected FFXI directory, or null if none found. */
  autoDetect: (): Promise<string | null> => ipcRenderer.invoke('ffxi:autoDetect'),

  /** Open a native folder picker and validate the choice. */
  pickDirectory: (): Promise<PickResult> => ipcRenderer.invoke('ffxi:pickDirectory'),

  /** Read a DAT file relative to the FFXI root, e.g. "ROM3/0/0.DAT". */
  readDat: async (rootPath: string, relativePath: string): Promise<ArrayBuffer> => {
    const bytes: Uint8Array = await ipcRenderer.invoke('ffxi:readDat', rootPath, relativePath)
    // Copy into a plain ArrayBuffer the parsers can consume directly.
    const out = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(out).set(bytes)
    return out
  },

  fileExists: (rootPath: string, relativePath: string): Promise<boolean> =>
    ipcRenderer.invoke('ffxi:fileExists', rootPath, relativePath),

  setFullscreen: (on: boolean): Promise<boolean> =>
    ipcRenderer.invoke('window:setFullscreen', on),

  isFullscreen: (): Promise<boolean> => ipcRenderer.invoke('window:isFullscreen'),

  /** Opens a save dialog for a PNG data URL. Resolves to the path, or null if cancelled. */
  saveScreenshot: (dataUrl: string, suggestedName: string): Promise<string | null> =>
    ipcRenderer.invoke('window:saveScreenshot', dataUrl, suggestedName),

  version: (): Promise<string> => ipcRenderer.invoke('app:version'),
}

export interface UpdateInfo {
  version: string
  name: string
  notes: string
  pageUrl: string
  asset: { name: string; url: string; size: number } | null
  portable: boolean
}

const updates = {
  /** Latest release if it is newer than this build, else null. Never throws. */
  check: (): Promise<UpdateInfo | null> => ipcRenderer.invoke('update:check'),

  download: (url: string, name: string, size: number): Promise<
    { status: 'ok'; path: string } | { status: 'error'; message: string }
  > => ipcRenderer.invoke('update:download', url, name, size),

  /** Runs the installer and quits, or reveals the file for a portable build. */
  install: (path: string): Promise<{ launched: boolean }> =>
    ipcRenderer.invoke('update:install', path),

  openPage: (url?: string): Promise<void> => ipcRenderer.invoke('update:openPage', url),

  /** Download progress. Returns an unsubscribe function. */
  onProgress: (fn: (p: { received: number; total: number }) => void): (() => void) => {
    const listener = (_e: unknown, p: { received: number; total: number }) => fn(p)
    ipcRenderer.on('update:progress', listener)
    return () => { ipcRenderer.removeListener('update:progress', listener) }
  },
}

contextBridge.exposeInMainWorld('ffxi', api)
contextBridge.exposeInMainWorld('updates', updates)

export type FfxiApi = typeof api
export type UpdatesApi = typeof updates
