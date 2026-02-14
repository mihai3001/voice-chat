import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      preload: path.join(__dirname, 'preload.cjs')
    },
    title: 'Voice Chat P2P'
  });

  // Load the index.html from the renderer folder
  // __dirname is dist/ after compilation, so go back to src/renderer
  const rendererPath = app.isPackaged
    ? path.join(__dirname, 'renderer', 'index.html')
    : path.join(__dirname, '..', 'src', 'renderer', 'index.html');
  
  mainWindow.loadFile(rendererPath);

  // Always open DevTools for debugging
  mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// App ready
app.whenReady().then(() => {
  createWindow();

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

console.log('Electron app started');
