import { app, BrowserWindow, ipcMain, session, desktopCapturer } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;

// Configure auto-updater
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

// Auto-updater event handlers
autoUpdater.on('checking-for-update', () => {
  console.log('Checking for updates...');
  sendUpdateStatus('checking-for-update');
});

autoUpdater.on('update-available', (info) => {
  console.log('Update available:', info);
  sendUpdateStatus('update-available', info);
});

autoUpdater.on('update-not-available', (info) => {
  console.log('Update not available:', info);
  sendUpdateStatus('update-not-available', info);
});

autoUpdater.on('error', (err) => {
  console.error('Update error:', err);
  sendUpdateStatus('update-error', { message: err.message });
});

autoUpdater.on('download-progress', (progressObj) => {
  console.log(`Download progress: ${progressObj.percent}%`);
  sendUpdateStatus('download-progress', progressObj);
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('Update downloaded:', info);
  sendUpdateStatus('update-downloaded', info);
});

function sendUpdateStatus(event: string, data?: any) {
  if (mainWindow) {
    mainWindow.webContents.send('update-status', { event, data });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs')
    },
    title: 'Voice Chat P2P',
    fullscreenable: true, // Allow fullscreen mode
    simpleFullscreen: false // Use native fullscreen on macOS
  });

  // Load the index.html from the renderer folder
  // __dirname is dist/ after compilation
  // When packaged: __dirname = resources/app.asar/dist, HTML is at resources/app.asar/src/renderer/index.html
  // When not packaged: __dirname = dist, HTML is at src/renderer/index.html
  const rendererPath = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
  
  mainWindow.loadFile(rendererPath);

  // Open DevTools only in development mode
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
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

// App ready
app.whenReady().then(() => {
  createWindow();

  // Check for updates after a short delay (only in production)
  if (app.isPackaged) {
    setTimeout(() => {
      console.log('Checking for updates...');
      autoUpdater.checkForUpdates().catch(err => {
        console.error('Failed to check for updates:', err);
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
