// Ponte mínima e segura entre a página e o processo principal (Steam).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('cidadeSteam', {
  info: () => ipcRenderer.invoke('steam:info'),
  unlock: (id) => ipcRenderer.invoke('steam:unlock', String(id)),
});
