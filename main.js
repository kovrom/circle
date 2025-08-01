const { app, BrowserWindow, BrowserView, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const log = require('electron-log');
const { Moon } = require('lunarphase-js');
const sqlite3 = require('sqlite3').verbose();

// Configure electron-log
log.transports.file.level = 'info';
log.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : 'error';
log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';

// Suppress common harmless warnings
process.on('warning', (warning) => {
  // Suppress MaxListenersExceededWarning for development
  if (warning.name === 'MaxListenersExceededWarning') {
    log.warn('MaxListenersExceededWarning suppressed (development)');
    return;
  }
  log.warn('Process warning:', warning);
});

let mainWindow;
let config = {};
let browserViews = [];
let currentViewIndex = 0;
let screensaverView = null;
let isScreensaverActive = false;
let isModalOpen = false;
let bitcoinFactsDb = null;

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
    const quotesPath = path.join(__dirname, 'Quotes');
    const relativePath = url.substring(8); // Remove '@Quotes/' prefix
    const fullPath = path.join(quotesPath, relativePath);
    
    // Convert to file:// URL for loading in BrowserView
    return `file://${fullPath}`;
  }
  return url;
}

// Load configuration
function loadConfig() {
  try {
    const configPath = getConfigPath();
    const configData = fs.readFileSync(configPath, 'utf8');
    config = JSON.parse(configData);
    log.info('Config loaded from user data directory:', configPath);
  } catch (error) {
    log.info('User config not found, trying default config...');
    try {
      // Try to load default config from app directory
      const defaultConfigPath = getDefaultConfigPath();
      const defaultConfigData = fs.readFileSync(defaultConfigPath, 'utf8');
      config = JSON.parse(defaultConfigData);
      log.info('Default config loaded from app directory');
      
      // Copy default config to user data directory for future edits
      try {
        const userDataPath = app.getPath('userData');
        if (!fs.existsSync(userDataPath)) {
          fs.mkdirSync(userDataPath, { recursive: true });
        }
        fs.writeFileSync(getConfigPath(), defaultConfigData, 'utf8');
        log.info('Default config copied to user data directory');
      } catch (copyError) {
        log.warn('Could not copy default config to user data directory:', copyError);
      }
    } catch (defaultError) {
      log.error('Error loading default config:', defaultError);
      // Default configuration
      config = {
        urls: [
          'https://timechaincalendar.com/en',
          'https://bitfeed.live/'          
        ],
        autoRotate: false,
        autoRotateInterval: 60000, // 1 minute
        fullscreen: true,
        enableDevTools: false
      };
    }
  }
}

// Bitcoin Facts Database Functions
function getBitcoinFactsDbPath() {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'bitcoin_facts.db');
}

function initBitcoinFactsDatabase() {
  const dbPath = getBitcoinFactsDbPath();
  bitcoinFactsDb = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      log.error('Error opening Bitcoin facts database:', err);
      return;
    }
    log.info('Bitcoin facts database connected at:', dbPath);
  });

  bitcoinFactsDb.serialize(() => {
    // Create table if not exists
    bitcoinFactsDb.run(`
      CREATE TABLE IF NOT EXISTS bitcoin_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        month INTEGER,
        day INTEGER,
        year INTEGER,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT,
        importance INTEGER DEFAULT 1,
        source_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes
    bitcoinFactsDb.run(`CREATE INDEX IF NOT EXISTS idx_date ON bitcoin_facts(date)`);
    bitcoinFactsDb.run(`CREATE INDEX IF NOT EXISTS idx_month_day ON bitcoin_facts(month, day)`);
    bitcoinFactsDb.run(`CREATE INDEX IF NOT EXISTS idx_importance ON bitcoin_facts(importance DESC)`);

    // Check if database is empty and seed with initial data
    bitcoinFactsDb.get("SELECT COUNT(*) as count FROM bitcoin_facts", (err, row) => {
      if (err) {
        log.error('Error checking Bitcoin facts count:', err);
        return;
      }
      
      if (row.count === 0) {
        log.info('Seeding Bitcoin facts database with initial data...');
        seedBitcoinFacts();
      } else {
        log.info(`Bitcoin facts database loaded with ${row.count} facts`);
      }
    });
  });
}

function seedBitcoinFacts() {
  const initialFacts = [    
    {
      date: '2008-08-18',
      month: 8,
      day: 18,
      year: 2008,
      title: 'Bitcoin.org Domain Registered',
      description: 'The domain bitcoin.org is registered, marking the first online presence of Bitcoin.',
      category: 'launch',
      importance: 4
    },
    {
      date: '2008-10-31',
      month: 10,
      day: 31,
      year: 2008,
      title: 'Bitcoin Whitepaper Published',
      description: 'Satoshi Nakamoto publishes the Bitcoin whitepaper "Bitcoin: A Peer-to-Peer Electronic Cash System".',
      category: 'launch',
      importance: 5
    },
    {
      date: '2009-01-03',
      month: 1,
      day: 3,
      year: 2009,
      title: 'Genesis Block Mined',
      description: 'The first Bitcoin block (Genesis Block) is mined by Satoshi Nakamoto with the message "The Times 03/Jan/2009 Chancellor on brink of second bailout for banks".',
      category: 'launch',
      importance: 5
    },
    {
      date: '2009-01-12',
      month: 1,
      day: 12,
      year: 2009,
      title: 'First Bitcoin Transaction',
      description: 'The first Bitcoin transaction takes place between Satoshi Nakamoto and Hal Finney.',
      category: 'technology',
      importance: 4
    },
    {
      date: '2010-05-22',
      month: 5,
      day: 22,
      year: 2010,
      title: 'Bitcoin Pizza Day',
      description: 'Laszlo Hanyecz makes the first real-world Bitcoin transaction, buying two pizzas for 10,000 BTC, establishing the first economic value for Bitcoin.',
      category: 'adoption',
      importance: 5
    },
    {
      date: '2010-07-17',
      month: 7,
      day: 17,
      year: 2010,
      title: 'First Bitcoin Exchange Opens',
      description: 'Mt. Gox, originally a Magic: The Gathering trading card exchange, begins trading Bitcoin.',
      category: 'adoption',
      importance: 4
    },
    {
      date: '2012-11-28',
      month: 11,
      day: 28,
      year: 2012,
      title: 'First Bitcoin Halving',
      description: 'The first Bitcoin halving occurs, reducing the block reward from 50 to 25 BTC.',
      category: 'technology',
      importance: 4
    },
    {
      date: '2017-08-01',
      month: 8,
      day: 1,
      year: 2017,
      title: 'Bitcoin Cash Fork',
      description: 'Bitcoin Cash (BCH) forks from Bitcoin, creating a separate cryptocurrency with larger block sizes.',
      category: 'technology',
      importance: 3
    },
    {
      date: '2017-12-17',
      month: 12,
      day: 17,
      year: 2017,
      title: 'Bitcoin Hits $20,000',
      description: 'Bitcoin reaches its then all-time high of nearly $20,000, marking peak mainstream attention during the 2017 bull run.',
      category: 'price',
      importance: 4
    }
  ];

  const stmt = bitcoinFactsDb.prepare(`
    INSERT INTO bitcoin_facts (date, month, day, year, title, description, category, importance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  initialFacts.forEach(fact => {
    stmt.run(fact.date, fact.month, fact.day, fact.year, fact.title, fact.description, fact.category, fact.importance);
  });

  stmt.finalize((err) => {
    if (err) {
      log.error('Error seeding Bitcoin facts:', err);
    } else {
      log.info(`Successfully seeded ${initialFacts.length} Bitcoin facts`);
    }
  });
}

function getTodaysBitcoinFacts(callback) {
  const today = new Date();
  const month = today.getMonth() + 1;
  const day = today.getDate();
  const todayString = today.toISOString().split('T')[0];

  if (!bitcoinFactsDb) {
    callback(null, []);
    return;
  }

  bitcoinFactsDb.all(`
    SELECT * FROM bitcoin_facts 
    WHERE (month = ? AND day = ?) OR date = ?
    ORDER BY importance DESC, year ASC
  `, [month, day, todayString], (err, rows) => {
    if (err) {
      log.error('Error fetching today\'s Bitcoin facts:', err);
      callback(err, null);
    } else {
      callback(null, rows || []);
    }
  });
}

// Create BrowserViews for each URL
function createBrowserViews() {
  // Clear existing views with proper cleanup
  browserViews.forEach(view => {
    // Remove all event listeners to prevent memory leaks
    view.webContents.removeAllListeners();
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.removeBrowserView(view);
    }
    
    // Explicitly destroy the webContents to free memory
    try {
      view.webContents.destroy();
    } catch (error) {
      log.warn('Error destroying view webContents:', error);
    }
  });
  browserViews = [];

  // Create new views
  config.urls.forEach((urlData, index) => {
    // Handle both legacy (string) and new (object) formats
    const url = typeof urlData === 'string' ? urlData : urlData.url;
    
    const view = new BrowserView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true
      }
    });

    // Set up error handling
    view.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
      log.error(`BrowserView ${index} failed to load ${validatedURL}:`, errorDescription);
      mainWindow.webContents.send('webview-error', { index, url: validatedURL, error: errorDescription });
    });

    view.webContents.on('did-finish-load', () => {
      log.info(`BrowserView ${index} loaded:`, url);
      mainWindow.webContents.send('webview-loaded', { index, url });
      
      // Note: Window background color will be set when this view is shown
    });

    // Load the URL
    view.webContents.loadURL(url);
    browserViews.push(view);
  });

  // Show the current view (or first view if invalid)
  const targetIndex = (currentViewIndex >= 0 && currentViewIndex < browserViews.length) ? currentViewIndex : 0;
  showBrowserView(targetIndex);
}

// Show a specific BrowserView
function showBrowserView(index) {
  if (index < 0 || index >= browserViews.length) return;
  
  // Don't switch views if screensaver is active
  if (isScreensaverActive) return;
  
  // Hide current view
  if (mainWindow.getBrowserView()) {
    mainWindow.removeBrowserView(mainWindow.getBrowserView());
  }
  
  // Show new view
  const view = browserViews[index];
  mainWindow.setBrowserView(view);
  
  // Set bounds to leave space for navigation buttons
  const bounds = mainWindow.getBounds();
  view.setBounds({ 
    x: 190, // Leave space for left button
    y: 120, // Leave space for top indicators  
    width: bounds.width - 380, // Leave space for both buttons
    height: bounds.height - 220 // Leave space for top and bottom
  });
  
  // Apply background color
  const urlData = config.urls[index];
  const backgroundColor = typeof urlData === 'string' ? '#000000' : (urlData.backgroundColor || '#000000');
  mainWindow.setBackgroundColor(backgroundColor);
  
  currentViewIndex = index;
  
  // Notify renderer with URL and background color
  const url = typeof urlData === 'string' ? urlData : urlData.url;
  mainWindow.webContents.send('view-changed', { index, url, backgroundColor });
}

// Create screensaver BrowserView
function createScreensaverView() {
  if (screensaverView) {
    // Cleanup existing screensaver view properly
    screensaverView.webContents.removeAllListeners();
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.removeBrowserView(screensaverView);
      } catch (error) {
        log.error('Error removing screensaver view:', error);
      }
    }
    
    // Explicitly destroy the webContents
    try {
      screensaverView.webContents.destroy();
    } catch (error) {
      log.warn('Error destroying screensaver webContents:', error);
    }
    
    screensaverView = null;
  }

  screensaverView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    }
  });

  // Set up error handling
  screensaverView.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    log.error(`Screensaver failed to load ${validatedURL}:`, errorDescription);
    mainWindow.webContents.send('screensaver-error', { url: validatedURL, error: errorDescription });
  });

  screensaverView.webContents.on('did-finish-load', () => {
    log.info('Screensaver loaded successfully');
    mainWindow.webContents.send('screensaver-loaded');
    
    // Inject JavaScript to detect clicks and send them via console message
    screensaverView.webContents.executeJavaScript(`
      (function() {
        const sendHideMessage = () => {
          console.log('SCREENSAVER_HIDE_INTERACTION');
        };
        
        document.addEventListener('click', sendHideMessage, true);
        document.addEventListener('touchstart', sendHideMessage, true);
        document.addEventListener('mousedown', sendHideMessage, true);
        
        // Also add to window and body to catch any missed events
        window.addEventListener('click', sendHideMessage, true);
        if (document.body) {
          document.body.addEventListener('click', sendHideMessage, true);
        }
      })();
    `);
  });

  // Listen for console messages from screensaver
  screensaverView.webContents.on('console-message', (event) => {
    if (event.message === 'SCREENSAVER_HIDE_INTERACTION' && isScreensaverActive) {
      log.info('Mouse/touch interaction detected in screensaver, hiding...');
      hideScreensaver();
    }
  });

  // Add click/touch listeners to screensaver BrowserView
  screensaverView.webContents.on('before-input-event', (event, input) => {
    if (isScreensaverActive) {
      // Any key press hides screensaver
      log.info('Key pressed in screensaver, hiding...');
      hideScreensaver();
    }
  });

  // Listen for mouse events on screensaver
  screensaverView.webContents.on('context-menu', () => {
    if (isScreensaverActive) {
      log.info('Right click in screensaver, hiding...');
      hideScreensaver();
    }
  });

  // Listen for navigation events (clicks) in screensaver
  screensaverView.webContents.on('will-navigate', (event) => {
    if (isScreensaverActive) {
      event.preventDefault();
      log.info('Click interaction in screensaver, hiding...');
      hideScreensaver();
    }
  });
}

// Show screensaver
function showScreensaver() {
  if (isScreensaverActive) return;

  // Create screensaver view if it doesn't exist
  if (!screensaverView) {
    createScreensaverView();
  }

  // Hide current browser view
  if (mainWindow.getBrowserView()) {
    mainWindow.removeBrowserView(mainWindow.getBrowserView());
  }

  // Set screensaver view
  mainWindow.setBrowserView(screensaverView);

  // Set screensaver to cover entire window
  const bounds = mainWindow.getBounds();
  screensaverView.setBounds({
    x: 0,
    y: 0,
    width: bounds.width,
    height: bounds.height
  });

  // Load the screensaver URL from config or use default
  const configUrl = config.screensaverUrl || 'https://lodev09.github.io/web-screensavers/jellyfish/';
  const screensaverUrl = resolveScreensaverUrl(configUrl);
  log.info('Loading screensaver URL:', screensaverUrl);
  screensaverView.webContents.loadURL(screensaverUrl);

  isScreensaverActive = true;
  mainWindow.webContents.send('screensaver-shown');
}

// Hide screensaver
function hideScreensaver() {
  if (!isScreensaverActive) return;

  // Remove screensaver view
  if (screensaverView && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.removeBrowserView(screensaverView);
  }

  // Set screensaver as inactive first so showBrowserView works
  isScreensaverActive = false;

  // Show the current browser view again
  if (browserViews[currentViewIndex]) {
    const view = browserViews[currentViewIndex];
    mainWindow.setBrowserView(view);
    
    // Set bounds to leave space for navigation buttons
    const bounds = mainWindow.getBounds();
    view.setBounds({ 
      x: 190, // Leave space for left button
      y: 120, // Leave space for top indicators  
      width: bounds.width - 380, // Leave space for both buttons
      height: bounds.height - 220 // Leave space for top and bottom
    });
    
    // Apply background color
    const urlData = config.urls[currentViewIndex];
    const backgroundColor = typeof urlData === 'string' ? '#000000' : (urlData.backgroundColor || '#000000');
    mainWindow.setBackgroundColor(backgroundColor);
    
    // Notify renderer with URL and background color
    const url = typeof urlData === 'string' ? urlData : urlData.url;
    mainWindow.webContents.send('view-changed', { index: currentViewIndex, url, backgroundColor });
  }

  mainWindow.webContents.send('screensaver-hidden');
}

// Handle keyboard shortcuts when window is focused
function handleKeyPress(event, input) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  
  // Only handle shortcuts when main window is focused
  if (!mainWindow.isFocused()) return;
  
  // When modal is open, prevent Escape from closing the app but allow other keys
  if (isModalOpen) {
    if (input.key === 'Escape') {
      event.preventDefault();
    }
    return;
  }
  
  switch (input.key) {
    case 'ArrowLeft':
      if (!input.meta && !input.control && !input.alt) {
        event.preventDefault();
        const prevIndex = (currentViewIndex - 1 + browserViews.length) % browserViews.length;
        showBrowserView(prevIndex);
      }
      break;
      
    case 'ArrowRight':
      if (!input.meta && !input.control && !input.alt) {
        event.preventDefault();
        const nextIndex = (currentViewIndex + 1) % browserViews.length;
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
  initBitcoinFactsDatabase();

  mainWindow = new BrowserWindow({
    width: 1080,
    height: 1080,
    fullscreen: config.fullscreen,
    icon: path.join(__dirname, 'icons/icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      spellcheck: true,
      preload: path.join(__dirname, 'preload.js')
    },
    show: true, // Show window immediately
    titleBarStyle: 'hidden',
    frame: false
  });

  // Increase max listeners to prevent warnings during development
  mainWindow.setMaxListeners(20);

  mainWindow.loadFile('index.html');

  // Send config to renderer once content is loaded
  mainWindow.webContents.once('did-finish-load', () => {
    log.info('Main window loaded, sending config:', config);
    mainWindow.webContents.send('config-loaded', config);
    // Create BrowserViews after main window is ready
    createBrowserViews();
  });

  // Handle window resizing
  mainWindow.on('resize', () => {
    const bounds = mainWindow.getBounds();
    if (mainWindow.getBrowserView()) {
      if (isScreensaverActive && screensaverView === mainWindow.getBrowserView()) {
        // Screensaver covers entire window
        screensaverView.setBounds({
          x: 0,
          y: 0,
          width: bounds.width,
          height: bounds.height
        });
      } else {
        // Normal browser view with space for controls
        mainWindow.getBrowserView().setBounds({ 
          x: 190, // Leave space for left button
          y: 120, // Leave space for top indicators  
          width: bounds.width - 380, // Leave space for both buttons
          height: bounds.height - 220 // Leave space for top and bottom
        });
      }
    }
  });

  // Handle window closed
  mainWindow.on('closed', () => {
    // Clean up BrowserViews properly
    browserViews.forEach(view => {
      view.webContents.removeAllListeners();
      try {
        view.webContents.destroy();
      } catch (error) {
        log.warn('Error destroying view on window close:', error);
      }
    });
    browserViews = [];
    
    // Clean up screensaver view
    if (screensaverView) {
      screensaverView.webContents.removeAllListeners();
      try {
        screensaverView.webContents.destroy();
      } catch (error) {
        log.warn('Error destroying screensaver on window close:', error);
      }
      screensaverView = null;
    }
    
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
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  // Close database connection
  if (bitcoinFactsDb) {
    bitcoinFactsDb.close((err) => {
      if (err) {
        log.error('Error closing Bitcoin facts database:', err);
      } else {
        log.info('Bitcoin facts database connection closed');
      }
    });
  }
  
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC handlers
ipcMain.handle('get-config', () => {
  return config;
});

ipcMain.handle('reload-config', () => {
  loadConfig();
  createBrowserViews();
  return config;
});

// Navigation handlers
ipcMain.handle('go-to-slide', (event, index) => {
  showBrowserView(index);
});

ipcMain.handle('next-slide', () => {
  const nextIndex = (currentViewIndex + 1) % browserViews.length;
  showBrowserView(nextIndex);
});

ipcMain.handle('previous-slide', () => {
  const prevIndex = (currentViewIndex - 1 + browserViews.length) % browserViews.length;
  showBrowserView(prevIndex);
});

ipcMain.handle('get-current-slide', () => {
  return currentViewIndex;
});

ipcMain.handle('reload-current-slide', () => {
  if (browserViews[currentViewIndex]) {
    browserViews[currentViewIndex].webContents.reload();
  }
});

// Save config to file
ipcMain.handle('save-config', async (event, newConfig) => {
  try {
    const configPath = getConfigPath();
    const configData = JSON.stringify(newConfig, null, 2);
    
    // Ensure user data directory exists
    const userDataPath = app.getPath('userData');
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true });
    }
    
    fs.writeFileSync(configPath, configData, 'utf8');
    
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

// Hide BrowserView for settings popup
ipcMain.handle('hide-browser-view', () => {
  if (mainWindow && mainWindow.getBrowserView()) {
    mainWindow.removeBrowserView(mainWindow.getBrowserView());
  }
});

// Show BrowserView after settings popup
ipcMain.handle('show-browser-view', () => {
  if (mainWindow && browserViews[currentViewIndex]) {
    const view = browserViews[currentViewIndex];
    mainWindow.setBrowserView(view);
    
    // Reset bounds
    const bounds = mainWindow.getBounds();
    view.setBounds({ 
      x: 190, 
      y: 120, 
      width: bounds.width - 380, 
      height: bounds.height - 220 
    });
  }
});

// Reload with new configuration
ipcMain.handle('reload-with-new-config', () => {
  try {
    // Reload config (it's already updated by save-config)
    log.info('Reloading with new config');
    
    // Recreate BrowserViews with new URLs
    createBrowserViews();
    
    // Send updated config to renderer
    mainWindow.webContents.send('config-reloaded', config);
    
    return { success: true };
  } catch (error) {
    log.error('Failed to reload with new config:', error);
    throw error;
  }
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
  return new Promise((resolve, reject) => {
    getTodaysBitcoinFacts((err, facts) => {
      if (err) {
        reject(err);
      } else {
        resolve(facts);
      }
    });
  });
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
  log.info('Modal state changed:', modalOpen ? 'open' : 'closed');
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

// Handle app protocol for better security
app.setAsDefaultProtocolClient('digital-signage');

// Prevent navigation to external sites in the main window
app.on('web-contents-created', (event, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    // Allow navigation within webviews but not in main window
    if (contents === mainWindow.webContents) {
      event.preventDefault();
    }
  });
});
