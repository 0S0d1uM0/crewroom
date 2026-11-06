const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', { chooseFolder: () => ipcRenderer.invoke('choose-folder'), notify: (title, body) => ipcRenderer.invoke('notify', { title, body }) });
