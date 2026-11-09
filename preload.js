const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = new Set([
  'get-config',
  'save-config',
  'go-to-slide',
  'next-slide',
  'previous-slide',
  'reload-current-slide',
  'reload-with-new-config',
  'exit-app',
  'show-screensaver',
  'hide-screensaver',
  'is-screensaver-active',
  'get-moon-phase',
  'get-todays-bitcoin-fact',
  'set-modal-state',
  'get-autostart-status',
  'set-autostart',
  'get-wifi-status',
  'scan-wifi',
  'connect-wifi',
  'disconnect-wifi'
]);

const EVENT_CHANNELS = new Set([
  'config-loaded',
  'view-changed',
  'webview-error',
  'webview-loaded',
  'screensaver-shown',
  'screensaver-hidden',
  'screensaver-error',
  'screensaver-loaded'
]);

// Expose secure API to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel, data) => {
    if (!INVOKE_CHANNELS.has(channel)) {
      throw new Error(`IPC channel '${channel}' is not allowed`);
    }
    return ipcRenderer.invoke(channel, data);
  },

  // Returns a function that removes the listener
  on: (channel, func) => {
    if (!EVENT_CHANNELS.has(channel)) {
      throw new Error(`IPC channel '${channel}' is not allowed`);
    }
    const subscription = (event, ...args) => func(...args);
    ipcRenderer.on(channel, subscription);
    return () => ipcRenderer.removeListener(channel, subscription);
  },

  // Logging interface (no direct access to electron-log)
  log: {
    info: (message, ...args) => ipcRenderer.invoke('log-info', { message, args }),
    error: (message, ...args) => ipcRenderer.invoke('log-error', { message, args }),
    warn: (message, ...args) => ipcRenderer.invoke('log-warn', { message, args })
  }
});
