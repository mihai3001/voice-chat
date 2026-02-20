import { app, BrowserWindow, ipcMain, session, desktopCapturer } from 'electron';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import * as path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { settings } from './settings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let pendingRoomLink: string | null = null; // Store room link if app not ready

// Configure auto-updater
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

// Enable verbose logging for auto-updater
(autoUpdater as any).logger = {
  info: (...args: any[]) => logger.info('[AUTO-UPDATE]', ...args),
  warn: (...args: any[]) => logger.warn('[AUTO-UPDATE]', ...args),
  error: (...args: any[]) => logger.error('[AUTO-UPDATE]', ...args),
  debug: (...args: any[]) => logger.debug('[AUTO-UPDATE]', ...args)
};

// Log the feed URL for debugging
logger.info('Auto-updater configuration', {
  appVersion: app.getVersion(),
  feedURL: (autoUpdater as any).getFeedURL?.() || 'Not yet set',
  publishConfig: {
    provider: 'github',
    owner: 'mihai3001',
    repo: 'voice-chat'
  }
});

// Auto-updater event handlers
autoUpdater.on('checking-for-update', () => {
  logger.info('Checking for updates...');
  sendUpdateStatus('checking-for-update');
});

autoUpdater.on('update-available', (info) => {
  logger.info('Update available', info);
  sendUpdateStatus('update-available', info);
});

autoUpdater.on('update-not-available', (info) => {
  logger.info('Update not available', info);
  sendUpdateStatus('update-not-available', info);
});

autoUpdater.on('error', (err) => {
  console.error('Update error:', err);
  console.error('Error details:', {
    message: err.message,
    stack: err.stack,
    feedURL: (autoUpdater as any).getFeedURL?.() || 'Unknown'
  });
  sendUpdateStatus('update-error', { message: err.message });
});

autoUpdater.on('download-progress', (progressObj) => {
  console.log(`Download progress: ${progressObj.percent}%`);
  sendUpdateStatus('download-progress', progressObj);
});

autoUpdater.on('update-downloaded', (info) => {
  logger.info('Update downloaded', info);
  sendUpdateStatus('update-downloaded', info);
});

function sendUpdateStatus(event: string, data?: any) {
  if (mainWindow) {
    mainWindow.webContents.send('update-status', { event, data });
  }
}

function createWindow() {
  // Get saved window bounds
  const bounds = settings.get('windowBounds');
  
  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      devTools: true // Enable developer console
    },
    title: '🎙️ VoiceLink',
    autoHideMenuBar: true, // Hide menu bar (File/Edit/etc)
    fullscreenable: true, // Allow fullscreen mode
    simpleFullscreen: false // Use native fullscreen on macOS
  });

  logger.info('Main window created', { bounds });

  // Load the index.html from the renderer folder
  // __dirname is dist/ after compilation
  // When packaged: __dirname = resources/app.asar/dist, HTML is at resources/app.asar/src/renderer/index.html
  // When not packaged: __dirname = dist, HTML is at src/renderer/index.html
  const rendererPath = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
  
  mainWindow.loadFile(rendererPath);

  // Open DevTools automatically
  mainWindow.webContents.openDevTools();

  // Save window bounds when moved or resized
  const saveBounds = () => {
    if (mainWindow && !mainWindow.isMaximized() && !mainWindow.isMinimized()) {
      const bounds = mainWindow.getBounds();
      settings.set('windowBounds', bounds);
    }
  };

  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  mainWindow.on('closed', () => {
    mainWindow = null;
    logger.info('Main window closed');
  });
  
  // Handle screen capture permissions
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true); // Grant permission for media access
    } else {
      callback(false);
    }
  });
}

// Protocol handler for deep links (voicelink://room/ROOM_ID)
if (process.defaultApp) {
  // Development mode - register protocol
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('voicelink', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  // Production mode
  app.setAsDefaultProtocolClient('voicelink');
}

// Handle protocol URLs (Windows/Linux)
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // Someone tried to run a second instance, focus our window instead
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      
      // Handle room link from second instance
      const url = commandLine.find(arg => arg.startsWith('voicelink://'));
      if (url) {
        handleRoomLink(url);
      }
    }
  });
}

// Handle protocol URLs (macOS)
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleRoomLink(url);
});

function handleRoomLink(url: string) {
  logger.info('Received room link', { url });
  
  // Parse voicelink://room/ROOM_ID or voicelink://ROOM_ID
  const match = url.match(/voicelink:\/\/(?:room\/)?([A-Za-z0-9_-]+)/);
  if (match && match[1]) {
    const roomId = match[1];
    logger.info('Parsed room ID', { roomId });
    
    if (mainWindow && mainWindow.webContents) {
      // Send room ID to renderer
      mainWindow.webContents.send('join-room-from-link', roomId);
    } else {
      // Store for later if window not ready
      pendingRoomLink = roomId;
    }
  }
}

// App ready
app.whenReady().then(() => {
  createWindow();
  
  // Handle pending room link
  if (pendingRoomLink && mainWindow) {
    setTimeout(() => {
      mainWindow!.webContents.send('join-room-from-link', pendingRoomLink);
      pendingRoomLink = null;
    }, 1000); // Wait for renderer to be ready
  }
  
  // Handle command line arguments (Windows/Linux)
  const url = process.argv.find(arg => arg.startsWith('voicelink://'));
  if (url) {
    handleRoomLink(url);
  }

  // Check for updates after a short delay (only in production)
  if (app.isPackaged) {
    setTimeout(() => {
      logger.info('Checking for updates...');
      autoUpdater.checkForUpdates().catch(err => {
        logger.error('Failed to check for updates', err);
      });
    }, 3000);
  }

  app.on('activate', () => {
    // On macOS re-create window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC handlers

// Settings management
ipcMain.handle('settings-get', (event, key: string) => {
  return settings.get(key as any);
});

ipcMain.handle('settings-set', (event, key: string, value: any) => {
  settings.set(key as any, value);
});

ipcMain.handle('settings-get-all', () => {
  return settings.getAll();
});

ipcMain.handle('settings-reset', () => {
  settings.reset();
});

ipcMain.handle('settings-add-recent-room', (event, roomId: string, name?: string) => {
  settings.addRecentRoom(roomId, name);
});

// Logging
ipcMain.handle('log-info', (event, message: string, data?: any) => {
  logger.info(message, data);
});

ipcMain.handle('log-error', (event, message: string, error?: any) => {
  logger.error(message, error);
});

ipcMain.handle('log-debug', (event, message: string, data?: any) => {
  logger.debug(message, data);
});

ipcMain.handle('get-user-data-path', () => {
  return app.getPath('userData');
});

// Update-related IPC handlers
ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged) {
    return { message: 'Updates only available in production builds' };
  }
  try {
    return await autoUpdater.checkForUpdates();
  } catch (err: any) {
    console.error('Error checking for updates:', err);
    throw new Error(err.message);
  }
});

ipcMain.handle('download-update', async () => {
  try {
    return await autoUpdater.downloadUpdate();
  } catch (err: any) {
    console.error('Error downloading update:', err);
    throw new Error(err.message);
  }
});

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

// Handle desktop capturer sources for screen sharing
ipcMain.handle('get-desktop-sources', async () => {
  try {
    console.log('Getting desktop sources...');
    const sources = await desktopCapturer.getSources({ 
      types: ['window', 'screen'],
      thumbnailSize: { width: 150, height: 150 }
    });
    console.log(`Found ${sources.length} sources:`, sources.map(s => ({ id: s.id, name: s.name })));
    return sources.map(source => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL(),
      appIconDataURL: source.appIcon ? source.appIcon.toDataURL() : null
    }));
  } catch (err) {
    console.error('Error getting desktop sources:', err);
    throw err;
  }
});

console.log('Electron app started');
