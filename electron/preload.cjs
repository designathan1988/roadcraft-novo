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
  // the save files, real files kept by the main process (electron/files.mjs)
  files: {
    read: (folder, name) => ipcRenderer.invoke('files:read', folder, name),
    write: (folder, name, data) => ipcRenderer.invoke('files:write', folder, name, data),
    list: (folder) => ipcRenderer.invoke('files:list', folder),
    remove: (folder, name) => ipcRenderer.invoke('files:remove', folder, name),
    folders: () => ipcRenderer.invoke('files:folders'),
    removeFolder: (folder) => ipcRenderer.invoke('files:removeFolder', folder),
  },
});
