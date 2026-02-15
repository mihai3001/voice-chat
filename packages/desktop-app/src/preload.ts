// Preload script for Electron context bridge
// Currently minimal - can be expanded for IPC communication

import { contextBridge, ipcRenderer } from 'electron';

// Expose electron APIs to renderer using contextBridge (secure way)
contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: {
    invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args),
    on: (channel: string, callback: (...args: any[]) => void) => {
      ipcRenderer.on(channel, (event, ...args) => callback(...args));
    },
    removeAllListeners: (channel: string) => {
      ipcRenderer.removeAllListeners(channel);
    }
  }
});

console.log('Preload script loaded with contextBridge');
