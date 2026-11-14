// Pont sécurisé entre l'interface et le processus principal
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (partial) => ipcRenderer.invoke('config:set', partial),
  pickRetroArch: () => ipcRenderer.invoke('dialog:retroarch'),
  pickGamesDir: () => ipcRenderer.invoke('dialog:gamesDir'),
  scanGames: () => ipcRenderer.invoke('games:scan'),
  coresStatus: () => ipcRenderer.invoke('cores:status'),
  launch: (p, system, choice) => ipcRenderer.invoke('game:launch', p, system, choice),
  listSaves: (p) => ipcRenderer.invoke('saves:list', p),
  openRetroArch: () => ipcRenderer.invoke('retroarch:open'),
  openUrl: (url) => ipcRenderer.invoke('shell:open', url),
  showInFolder: (p) => ipcRenderer.invoke('shell:showItem', p),
  onExited: (cb) => ipcRenderer.on('game:exited', (_e, saved) => cb(saved)),
  onError: (cb) => ipcRenderer.on('game:error', (_e, msg) => cb(msg)),
  installAll: () => ipcRenderer.invoke('setup:install'),
  onSetupProgress: (cb) => ipcRenderer.on('setup:progress', (_e, p) => cb(p)),
  version: () => ipcRenderer.invoke('app:version'),
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_e, v) => cb(v)),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, v) => cb(v)),
  onUpdateReady: (cb) => ipcRenderer.on('update:ready', (_e, v) => cb(v)),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
});
