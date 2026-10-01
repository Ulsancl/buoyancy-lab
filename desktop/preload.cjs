const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('buoyancyDesktop', {
  isDesktop: true,
  openProject: () => ipcRenderer.invoke('buoyancy:open-project'),
  saveProject: payload => ipcRenderer.invoke('buoyancy:save-project', payload),
  setBusy: busy => ipcRenderer.send('buoyancy:busy', busy === true),
  onCommand: callback => {
    if (typeof callback !== 'function') throw new TypeError('A callback is required');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('buoyancy:command', listener);
    return () => ipcRenderer.removeListener('buoyancy:command', listener);
  },
});
