// Minimal, safe bridge between the page and the main process (Steam).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('cidadeSteam', {
  info: () => ipcRenderer.invoke('steam:info'),
  unlock: (id) => ipcRenderer.invoke('steam:unlock', String(id)),
});
