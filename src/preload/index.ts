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
}

contextBridge.exposeInMainWorld('ffxi', api)

export type FfxiApi = typeof api
