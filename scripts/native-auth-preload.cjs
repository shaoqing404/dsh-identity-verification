const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame && location.protocol === 'dsh-app:' && location.host === 'app') {
  contextBridge.exposeInMainWorld('dshTouchId', Object.freeze({
    capabilities: () => ipcRenderer.invoke('dsh-touch-id:capabilities'),
    verify: policy => {
      if (!navigator.userActivation.isActive) {
        return Promise.resolve({ ok: false, code: 'user-gesture-required' });
      }
      return ipcRenderer.invoke('dsh-touch-id:verify', { policy });
    },
    cancel: () => ipcRenderer.invoke('dsh-touch-id:cancel'),
  }));
}
