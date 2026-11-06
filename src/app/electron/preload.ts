import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', { chooseFolder: () => ipcRenderer.invoke('choose-folder'), notify: (title: string, body: string) => ipcRenderer.invoke('notify', { title, body }) });
