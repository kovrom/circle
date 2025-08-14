const { contextBridge, ipcRenderer } = require('electron');

// Expose secure API to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // IPC communication methods
  invoke: (channel, data) => {
    // Whitelist allowed channels for security
    const allowedChannels = [
      'get-config',
      'reload-config',
      'save-config',
      'go-to-slide',
      'next-slide',
      'previous-slide',
      'get-current-slide',
      'reload-current-slide',
      'hide-browser-view',
      'show-browser-view',
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
      'disconnect-wifi',
      'log-info',
      'log-error',
      'log-warn'
    ];
    
    if (allowedChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, data);
    } else {
      throw new Error(`IPC channel '${channel}' is not allowed`);
    }
  },
  
  // Event listeners for IPC
  on: (channel, func) => {
    // Whitelist allowed channels for security
    const allowedChannels = [
      'config-loaded',
      'view-changed',
      'webview-error',
      'webview-loaded',
      'config-reloaded',
      'screensaver-shown',
      'screensaver-hidden',
      'screensaver-error',
      'screensaver-loaded',
      'reload-config'
    ];
    
    if (allowedChannels.includes(channel)) {
      // Remove listener method
      const subscription = (event, ...args) => func(...args);
      ipcRenderer.on(channel, subscription);
      
      // Return unsubscribe function
      return () => {
        ipcRenderer.removeListener(channel, subscription);
      };
    } else {
      throw new Error(`IPC channel '${channel}' is not allowed`);
    }
  },
  
  // Remove specific listener
  removeListener: (channel, func) => {
    const allowedChannels = [
      'config-loaded',
      'view-changed',
      'webview-error',
      'webview-loaded',
      'config-reloaded',
      'screensaver-shown',
      'screensaver-hidden',
      'screensaver-error',
      'screensaver-loaded',
      'reload-config'
    ];
    
    if (allowedChannels.includes(channel)) {
      ipcRenderer.removeListener(channel, func);
    }
  },
  
  // Logging interface (no direct access to electron-log)
  log: {
    info: (message, ...args) => ipcRenderer.invoke('log-info', { message, args }),
    error: (message, ...args) => ipcRenderer.invoke('log-error', { message, args }),
    warn: (message, ...args) => ipcRenderer.invoke('log-warn', { message, args })
  }
});