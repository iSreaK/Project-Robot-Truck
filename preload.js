// Pont sécurisé entre le renderer et le main process.
// Le renderer ne voit que l'API exposée ici (contextIsolation).

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('robotApi', {
  listPorts: () => ipcRenderer.invoke('serial:list'),
  openPort: (opts) => ipcRenderer.invoke('serial:open', opts),
  closePort: () => ipcRenderer.invoke('serial:close'),
  writeBytes: (bytes) => ipcRenderer.invoke('serial:write', bytes),

  // Abonnements (événements série venant du main).
  onData: (cb) => {
    const listener = (_evt, bytes) => cb(bytes);
    ipcRenderer.on('serial:data', listener);
    return () => ipcRenderer.removeListener('serial:data', listener);
  },
  onError: (cb) => {
    const listener = (_evt, msg) => cb(msg);
    ipcRenderer.on('serial:error', listener);
    return () => ipcRenderer.removeListener('serial:error', listener);
  },
  onClosed: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('serial:closed', listener);
    return () => ipcRenderer.removeListener('serial:closed', listener);
  },
});
