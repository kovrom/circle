const { app, BrowserWindow, BrowserView, ipcMain, Menu, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { exec } = require('child_process');
const log = require('electron-log');
const { Moon } = require('lunarphase-js');
const { getFactsForDay } = require('./facts');
const wifi = require('./wifi');

// Configure electron-log
log.transports.file.level = 'info';
log.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : 'error';
log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';

process.on('warning', (warning) => {
  log.warn('Process warning:', warning);
});

const ERR_ABORTED = -3; // Chromium's code for a navigation that was replaced or cancelled
const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 60000;

// Space around a slide for the on-screen controls; tuned for the round display.
const SLIDE_INSET = { left: 190, top: 120, horizontal: 380, vertical: 220 };

const BUILT_IN_CONFIG = {
  urls: [
    'https://timechaincalendar.com/en',
    'https://bitfeed.live/'
  ],
  autoRotate: false,
  autoRotateInterval: 60000, // 1 minute
  fullscreen: true,
  enableDevTools: false
};

let mainWindow;
let config = {};
let views = []; // { view, url, backgroundColor, error, loadFailed, retryTimer, retryCount, closed }
let currentViewIndex = 0;
let attachedView = null;
let screensaverView = null;
let isScreensaverActive = false;
let isModalOpen = false;

function sendToRenderer(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

// Get user data directory for config storage
function getConfigPath() {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'config.json');
}

// Get default config path (shipped with app)
function getDefaultConfigPath() {
  return path.join(__dirname, 'config.json');
}

// Resolve screensaver URL, handling @Quotes special path
function resolveScreensaverUrl(url) {
  if (url && url.startsWith('@Quotes/')) {
    const relativePath = url.substring('@Quotes/'.length);
    return pathToFileURL(path.join(__dirname, 'Quotes', relativePath)).href;
  }
  return url;
}

function isUsableConfig(value) {
  return Boolean(value) && Array.isArray(value.urls) && value.urls.length > 0;
}

// Write to a temp file and rename, so a power cut can't leave a truncated file.
function writeFileAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  const fd = fs.openSync(tempPath, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, filePath);
}

function readShippedConfig() {
  try {
    const shipped = JSON.parse(fs.readFileSync(getDefaultConfigPath(), 'utf8'));
    if (isUsableConfig(shipped)) return shipped;
    log.error('Shipped config has no URLs, using built-in defaults');
  } catch (error) {
    log.error('Error loading shipped config:', error);
  }
  return { ...BUILT_IN_CONFIG };
}

function loadConfig() {
  const configPath = getConfigPath();

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    config = readShippedConfig();
    if (error.code === 'ENOENT') {
      log.info('No user config yet, creating one from defaults');
      try {
        writeFileAtomic(configPath, JSON.stringify(config, null, 2));
      } catch (writeError) {
        log.warn('Could not write default config:', writeError);
      }
    } else {
      log.error('Could not read user config, running on defaults:', error);
    }
    return;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!isUsableConfig(parsed)) throw new Error('config has no URLs');
    config = parsed;
    log.info('Config loaded from user data directory:', configPath);
  } catch (error) {
    // Leave the file in place so a typo can be fixed; only run on defaults for now.
    log.error(`User config is invalid (${error.message}), running on defaults. A copy is at ${configPath}.broken`);
    try {
      fs.writeFileSync(`${configPath}.broken`, raw, 'utf8');
    } catch (copyError) {
      log.warn('Could not back up invalid config:', copyError);
    }
    config = readShippedConfig();
  }
}

function normalizeUrlEntry(urlData) {
  if (typeof urlData === 'string') return { url: urlData, backgroundColor: '#000000' };
  return { url: urlData.url, backgroundColor: urlData.backgroundColor || '#000000' };
}

// Decides what is on screen. Every change of state calls this instead of
// attaching views directly: screensaver first, then the current slide unless a
// modal is open or the slide failed to load (so the error overlay can be seen).
function syncAttachedView() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const { width, height } = mainWindow.getBounds();
  const entry = views[currentViewIndex];
  let target = null;
  let bounds = null;

  if (isScreensaverActive) {
    target = screensaverView;
    bounds = { x: 0, y: 0, width, height };
  } else if (!isModalOpen && entry && !entry.error) {
    target = entry.view;
    bounds = {
      x: SLIDE_INSET.left,
      y: SLIDE_INSET.top,
      width: width - SLIDE_INSET.horizontal,
      height: height - SLIDE_INSET.vertical
    };
  }

  if (attachedView !== target) {
    mainWindow.setBrowserView(target);
    attachedView = target;
  }
  if (target) target.setBounds(bounds);
}

function publishCurrentView() {
  const entry = views[currentViewIndex];
  if (!entry || !mainWindow || mainWindow.isDestroyed()) return;

  mainWindow.setBackgroundColor(entry.backgroundColor);
  sendToRenderer('view-changed', {
    index: currentViewIndex,
    url: entry.url,
    backgroundColor: entry.backgroundColor,
    error: entry.error
  });
}

function loadView(entry) {
  entry.loadFailed = false;
  // Failures are reported through did-fail-load.
  entry.view.webContents.loadURL(entry.url).catch(() => {});
}

function scheduleRetry(entry) {
  if (entry.closed) return;
  clearTimeout(entry.retryTimer);
  const delay = Math.min(RETRY_BASE_MS * 2 ** entry.retryCount, RETRY_MAX_MS);
  entry.retryCount++;
  entry.retryTimer = setTimeout(() => loadView(entry), delay);
}

function markViewFailed(entry, message) {
  entry.loadFailed = true;
  entry.error = message;

  const index = views.indexOf(entry);
  if (index === currentViewIndex) {
    syncAttachedView();
    sendToRenderer('webview-error', { index, url: entry.url, error: message });
  }
  scheduleRetry(entry);
}

function createView(url, backgroundColor) {
  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    }
  });
  const entry = { view, url, backgroundColor, error: null, loadFailed: false, retryTimer: null, retryCount: 0, closed: false };

  view.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === ERR_ABORTED) return;
    log.error(`Failed to load ${validatedURL}:`, errorDescription);
    markViewFailed(entry, errorDescription);
  });

  view.webContents.on('did-finish-load', () => {
    // Chromium also reports "finished" for the error page of a failed load.
    if (entry.loadFailed) return;

    log.info('Loaded:', url);
    entry.error = null;
    entry.retryCount = 0;
    const index = views.indexOf(entry);
    if (index === currentViewIndex) {
      syncAttachedView();
      sendToRenderer('webview-loaded', { index, url });
    }
  });

  view.webContents.on('render-process-gone', (event, details) => {
    if (details.reason === 'clean-exit') return;
    log.error(`Page process for ${url} is gone:`, details.reason);
    markViewFailed(entry, `Page stopped unexpectedly (${details.reason})`);
  });

  loadView(entry);
  return entry;
}

function closeWebContents(view) {
  try {
    view.webContents.close();
  } catch (error) {
    log.warn('Error closing view:', error);
  }
}

function closeView(entry) {
  entry.closed = true;
  clearTimeout(entry.retryTimer);
  if (attachedView === entry.view) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBrowserView(null);
    attachedView = null;
  }
  closeWebContents(entry.view);
}

// Match the views to config.urls, keeping any page whose URL is still wanted.
function syncBrowserViews() {
  const current = views[currentViewIndex];
  const reusable = [...views];

  views = config.urls.map((urlData) => {
    const { url, backgroundColor } = normalizeUrlEntry(urlData);
    const match = reusable.findIndex((entry) => entry.url === url);
    if (match === -1) return createView(url, backgroundColor);

    const [entry] = reusable.splice(match, 1);
    entry.backgroundColor = backgroundColor;
    return entry;
  });
  reusable.forEach(closeView);

  currentViewIndex = Math.max(views.indexOf(current), 0);
  syncAttachedView();
  publishCurrentView();
}

function showBrowserView(index) {
  if (!Number.isInteger(index) || index < 0 || index >= views.length) return;
  if (isScreensaverActive) return;

  currentViewIndex = index;
  syncAttachedView();
  publishCurrentView();
}

function retryView(entry) {
  clearTimeout(entry.retryTimer);
  entry.retryCount = 0;
  loadView(entry);
}

function createScreensaverView() {
  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    }
  });
  const contents = view.webContents;

  contents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === ERR_ABORTED) return;
    log.error(`Screensaver failed to load ${validatedURL}:`, errorDescription);
    sendToRenderer('screensaver-error', { url: validatedURL, error: errorDescription });
  });

  contents.on('did-finish-load', () => {
    log.info('Screensaver loaded successfully');
    sendToRenderer('screensaver-loaded');

    // Report clicks and touches through a console message
    contents.executeJavaScript(`
      (function() {
        const sendHideMessage = () => {
          console.log('SCREENSAVER_HIDE_INTERACTION');
        };

        document.addEventListener('click', sendHideMessage, true);
        document.addEventListener('touchstart', sendHideMessage, true);
        document.addEventListener('mousedown', sendHideMessage, true);
      })();
    `).catch((error) => log.warn('Could not add screensaver input listeners:', error));
  });

  contents.on('console-message', (event) => {
    if (event.message === 'SCREENSAVER_HIDE_INTERACTION') hideScreensaver();
  });
  contents.on('before-input-event', () => hideScreensaver());
  contents.on('context-menu', () => hideScreensaver());
  contents.on('will-navigate', (event) => {
    event.preventDefault();
    hideScreensaver();
  });

  return view;
}

function showScreensaver() {
  if (isScreensaverActive) return;

  screensaverView = createScreensaverView();
  isScreensaverActive = true;
  syncAttachedView();

  const configUrl = config.screensaverUrl || 'https://lodev09.github.io/web-screensavers/jellyfish/';
  const screensaverUrl = resolveScreensaverUrl(configUrl);
  log.info('Loading screensaver URL:', screensaverUrl);
  screensaverView.webContents.loadURL(screensaverUrl).catch(() => {});

  sendToRenderer('screensaver-shown');
}

function hideScreensaver() {
  if (!isScreensaverActive) return;

  isScreensaverActive = false;
  syncAttachedView();
  publishCurrentView();
  sendToRenderer('screensaver-hidden');

  // The screensaver's memory is only freed by closing it. This often runs inside
  // one of its own event handlers, where it can't be closed straight away.
  const view = screensaverView;
  screensaverView = null;
  setImmediate(() => closeWebContents(view));
}

// Handle keyboard shortcuts when window is focused
function handleKeyPress(event, input) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (input.type !== 'keyDown') return;

  // Only handle shortcuts when main window is focused
  if (!mainWindow.isFocused()) return;

  // Any key dismisses the screensaver
  if (isScreensaverActive) {
    event.preventDefault();
    hideScreensaver();
    return;
  }

  // An open modal gets all keys, including Escape to close itself
  if (isModalOpen) return;

  switch (input.key) {
    case 'ArrowLeft':
      if (!input.meta && !input.control && !input.alt) {
        event.preventDefault();
        const prevIndex = (currentViewIndex - 1 + views.length) % views.length;
        showBrowserView(prevIndex);
      }
      break;
      
    case 'ArrowRight':
      if (!input.meta && !input.control && !input.alt) {
        event.preventDefault();
        const nextIndex = (currentViewIndex + 1) % views.length;
        showBrowserView(nextIndex);
      }
      break;
      
    case 'F11':
      event.preventDefault();
      const isFullscreen = mainWindow.isFullScreen();
      mainWindow.setFullScreen(!isFullscreen);
      break;
      
    case 'Escape':
      event.preventDefault();
      app.quit();
      break;
  }
}

function createWindow() {
  // Prevent creating multiple windows
  if (mainWindow && !mainWindow.isDestroyed()) {
    log.warn('Window already exists, not creating new one');
    return;
  }

  loadConfig();

  mainWindow = new BrowserWindow({
    width: 1080,
    height: 1080,
    fullscreen: config.fullscreen,
    icon: path.join(__dirname, 'icons/icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js')
    },
    show: true, // Show window immediately
    titleBarStyle: 'hidden',
    frame: false
  });

  mainWindow.loadFile('index.html');

  // Send config to renderer once content is loaded
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send('config-loaded', config);
    // Create BrowserViews after main window is ready
    syncBrowserViews();
  });

  mainWindow.on('resize', syncAttachedView);

  mainWindow.on('closed', () => {
    views.forEach(closeView);
    views = [];

    if (screensaverView) {
      closeWebContents(screensaverView);
      screensaverView = null;
      isScreensaverActive = false;
    }

    attachedView = null;
    mainWindow = null;
  });

  // Create menu for development
  if (config.enableDevTools || process.argv.includes('--dev')) {
    const menu = Menu.buildFromTemplate([
      {
        label: 'Developer',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      }
    ]);
    Menu.setApplicationMenu(menu);
  } else {
    Menu.setApplicationMenu(null);
  }

  // Register keyboard event handler for window-focused shortcuts
  mainWindow.webContents.on('before-input-event', handleKeyPress);

  // Listen for clicks on main window to hide screensaver
  mainWindow.on('focus', () => {
    if (isScreensaverActive) {
      log.info('Window focus detected while screensaver active, hiding...');
      hideScreensaver();
    }
  });

  // Add context menu support for text inputs
  mainWindow.webContents.on('context-menu', (event, params) => {
    // Only show context menu for editable content (text inputs, textareas)
    if (params.isEditable) {
      const contextMenu = Menu.buildFromTemplate([
        { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
        { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
        { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { label: 'Select All', role: 'selectAll', enabled: params.editFlags.canSelectAll }
      ]);
      
      contextMenu.popup({ window: mainWindow });
    }
  });
}

// App event handlers
if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // Displayed web pages get no camera, microphone, location, notifications, etc.
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    createWindow();
  });
} else {
  app.quit();
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (app.isReady() && BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC handlers
ipcMain.handle('get-config', () => {
  return config;
});

// Navigation handlers
ipcMain.handle('go-to-slide', (event, index) => {
  showBrowserView(index);
});

ipcMain.handle('next-slide', () => {
  const nextIndex = (currentViewIndex + 1) % views.length;
  showBrowserView(nextIndex);
});

ipcMain.handle('previous-slide', () => {
  const prevIndex = (currentViewIndex - 1 + views.length) % views.length;
  showBrowserView(prevIndex);
});

ipcMain.handle('reload-current-slide', () => {
  if (views[currentViewIndex]) retryView(views[currentViewIndex]);
});

// Save config to file
ipcMain.handle('save-config', async (event, newConfig) => {
  try {
    const configPath = getConfigPath();
    writeFileAtomic(configPath, JSON.stringify(newConfig, null, 2));

    // Update current config
    config = newConfig;
    
    log.info('Config saved successfully to:', configPath);
    return { success: true, path: configPath };
  } catch (error) {
    log.error('Failed to save config:', error);
    return { 
      success: false, 
      error: error.message,
      details: 'Settings could not be saved. This may happen in read-only environments like AppImage.'
    };
  }
});

// Apply a config that save-config has already stored
ipcMain.handle('reload-with-new-config', () => {
  log.info('Applying new config');
  syncBrowserViews();
  return { success: true };
});

// Exit app handler
ipcMain.handle('exit-app', () => {
  app.quit();
});

// Screensaver handlers
ipcMain.handle('show-screensaver', () => {
  showScreensaver();
});

ipcMain.handle('hide-screensaver', () => {
  hideScreensaver();
});

ipcMain.handle('is-screensaver-active', () => {
  return isScreensaverActive;
});

// Moon phase handler
ipcMain.handle('get-moon-phase', () => {
  try {
    const currentPhase = Moon.lunarPhase();
    const moonEmoji = getMoonPhaseEmoji(currentPhase);
    return { phase: currentPhase, emoji: moonEmoji };
  } catch (error) {
    log.error('Moon phase calculation failed:', error);
    return { phase: 'Unknown', emoji: '🌙' };
  }
});

// Bitcoin fact handler
ipcMain.handle('get-todays-bitcoin-fact', () => {
  const today = new Date();
  try {
    return getFactsForDay(today.getMonth() + 1, today.getDate());
  } catch (error) {
    log.error('Could not read Bitcoin facts:', error);
    return [];
  }
});

// Logging handlers for renderer process
ipcMain.handle('log-info', (event, { message, args }) => {
  log.info(message, ...args);
});

ipcMain.handle('log-error', (event, { message, args }) => {
  log.error(message, ...args);
});

ipcMain.handle('log-warn', (event, { message, args }) => {
  log.warn(message, ...args);
});

// Modal state handlers
ipcMain.handle('set-modal-state', (event, modalOpen) => {
  isModalOpen = modalOpen;
  syncAttachedView();
});

// Autostart functionality (Linux only)
ipcMain.handle('get-autostart-status', async () => {
  const isLinux = os.platform() === 'linux';
  
  if (!isLinux) {
    return { isLinux: false, enabled: false };
  }
  
  try {
    const homeDir = os.homedir();
    const serviceFile = path.join(homeDir, '.config', 'systemd', 'user', 'circle.service');
    
    // Check if service file exists
    const serviceExists = fs.existsSync(serviceFile);
    
    if (!serviceExists) {
      return { isLinux: true, enabled: false };
    }
    
    // Check if service is enabled
    const { stdout } = await execPromise('systemctl --user is-enabled circle.service');
    const isEnabled = stdout.trim() === 'enabled';
    
    return { isLinux: true, enabled: isEnabled };
  } catch (error) {
    log.error('Error checking autostart status:', error);
    return { isLinux: true, enabled: false };
  }
});

ipcMain.handle('set-autostart', async (event, enable) => {
  const isLinux = os.platform() === 'linux';
  
  if (!isLinux) {
    throw new Error('Autostart is only supported on Linux');
  }
  
  try {
    if (enable) {
      await enableAutostart();
    } else {
      await disableAutostart();
    }
    
    log.info(`Autostart ${enable ? 'enabled' : 'disabled'} successfully`);
    return { success: true };
  } catch (error) {
    log.error(`Error ${enable ? 'enabling' : 'disabling'} autostart:`, error);
    throw error;
  }
});

// Helper function to promisify exec
function execPromise(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

// Enable autostart by creating systemd service file and enabling it
async function enableAutostart() {
  const homeDir = os.homedir();
  const configDir = path.join(homeDir, '.config', 'systemd', 'user');
  const serviceFile = path.join(configDir, 'circle.service');
  
  // Get the current executable path
  // For AppImage, use APPIMAGE environment variable, otherwise fallback to execPath
  const execPath = process.env.APPIMAGE || process.execPath;
  
  // Create .config/systemd/user directory if it doesn't exist
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  // systemd unit-file quoting, so paths with spaces or special characters work
  const escapedExecPath = execPath
    .replace(/(["\\])/g, '\\$1')
    .replace(/%/g, '%%')
    .replace(/\$/g, '$$$$');

  // Create service file content
  const serviceContent = `[Unit]
Description=Circle
After=graphical.target
After=network.target
Wants=graphical.target

[Service]
Type=simple
ExecStart="${escapedExecPath}"
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
  
  // Write service file
  fs.writeFileSync(serviceFile, serviceContent, 'utf8');
  log.info('Service file created at:', serviceFile);
  
  // Reload systemd daemon
  await execPromise('systemctl --user daemon-reload');
  
  // Enable the service
  await execPromise('systemctl --user enable circle.service');
  
  // Start the service (optional - just enable for now)
  // await execPromise('systemctl --user start circle.service');
}

// Disable autostart by disabling and removing systemd service
async function disableAutostart() {
  // Only disable, never stop: the app may itself be running under this service.
  try {
    await execPromise('systemctl --user disable circle.service');
  } catch (error) {
    log.warn('Could not disable service (it may not exist):', error.message);
  }

  // Remove service file if it exists
  const homeDir = os.homedir();
  const serviceFile = path.join(homeDir, '.config', 'systemd', 'user', 'circle.service');
  
  if (fs.existsSync(serviceFile)) {
    fs.unlinkSync(serviceFile);
    log.info('Service file removed:', serviceFile);
  }
  
  // Reload systemd daemon
  try {
    await execPromise('systemctl --user daemon-reload');
  } catch (error) {
    log.warn('Error reloading systemd daemon:', error.message);
  }
}

// WiFi functionality (Linux only)
const isLinux = os.platform() === 'linux';

ipcMain.handle('get-wifi-status', async () => {
  if (!isLinux) return { connected: false, networkName: null };

  try {
    const networkName = await wifi.getActiveWifiName();
    return { connected: networkName !== null, networkName };
  } catch (error) {
    log.error('Error getting WiFi status:', error.message);
    return { connected: false, networkName: null };
  }
});

ipcMain.handle('scan-wifi', async () => {
  if (!isLinux) throw new Error('WiFi scanning is only supported on Linux');

  try {
    return await wifi.scanNetworks();
  } catch (error) {
    log.error('Error scanning WiFi networks:', error.message);
    throw new Error(`Failed to scan WiFi networks: ${error.message}`);
  }
});

ipcMain.handle('connect-wifi', async (event, { ssid, password }) => {
  if (!isLinux) throw new Error('WiFi connection is only supported on Linux');

  try {
    await wifi.connect(ssid, password);
    log.info(`Connected to WiFi: ${ssid}`);
    return { success: true, message: `Connected to ${ssid}` };
  } catch (error) {
    log.error('Error connecting to WiFi:', error.message);
    throw error;
  }
});

ipcMain.handle('disconnect-wifi', async () => {
  if (!isLinux) throw new Error('WiFi disconnection is only supported on Linux');

  try {
    const name = await wifi.disconnectActive();
    log.info(`Disconnected from WiFi: ${name}`);
    return { success: true, message: `Disconnected from ${name}` };
  } catch (error) {
    log.error('Error disconnecting from WiFi:', error.message);
    throw new Error(`Failed to disconnect: ${error.message}`);
  }
});

// Helper function for moon phase emojis
function getMoonPhaseEmoji(phase) {
  const phaseNames = {
    'New': '🌑',
    'Waxing Crescent': '🌒',
    'First Quarter': '🌓', 
    'Waxing Gibbous': '🌔',
    'Full': '🌕',
    'Waning Gibbous': '🌖',
    'Last Quarter': '🌗',
    'Waning Crescent': '🌘'
  };
  
  return phaseNames[phase] || '🌑';
}

app.on('web-contents-created', (event, contents) => {
  // New windows would cover the kiosk with no way to close them on a touch screen
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // The main window never navigates away from the app UI
  contents.on('will-navigate', (navigationEvent) => {
    if (mainWindow && !mainWindow.isDestroyed() && contents === mainWindow.webContents) {
      navigationEvent.preventDefault();
    }
  });
});
