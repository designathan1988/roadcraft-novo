// Minimal, safe bridge between the page and the main process (Steam).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('cidadeSteam', {
  info: () => ipcRenderer.invoke('steam:info'),
  unlock: (id) => ipcRenderer.invoke('steam:unlock', String(id)),
});
// Closing the window: the main process asks the page first (it saves), then the page says it can close.
contextBridge.exposeInMainWorld('roadcraftApp', {
  onClosing: (fn) => { ipcRenderer.on('app:closing', () => fn()); },
  canClose: () => ipcRenderer.send('app:can-close'),
  quit: () => ipcRenderer.send('app:quit'),
});
