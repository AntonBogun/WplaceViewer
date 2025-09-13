// console.log('=== MAIN SCRIPT STARTING ===');
// console.log('Current __dirname:', __dirname);
// console.log('process.cwd():', process.cwd());

// const { app, ipcMain, BrowserWindow, Menu } = require('electron');
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

let mainWindow;

// ipcMain.handle('get-app-path', () => {
//   // For packaged apps, use the directory where the executable is
//   // For development, use the app path
//   if (app.isPackaged) {
//     return path.dirname(process.execPath);
//   } else {
//     return app.getAppPath();
//   }
// });

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1800,
    height: 1200,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      webSecurity: true,
      sandbox: false,
      devTools: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'assets/icon.png'),
    title: 'wplace Viewer'
  });

  // Load the app
  mainWindow.loadFile('index.html');

  // Open DevTools in development
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// This method will be called when Electron has finished initialization
app.whenReady().then(createWindow);

// Quit when all windows are closed
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Create application menu
const template = [
  {
    label: 'File',
    submenu: [
      {
        label: 'Reload',
        accelerator: 'CmdOrCtrl+R',
        click: () => {
          if (mainWindow) {
            mainWindow.reload();
          }
        }
      },
      {
        label: 'Toggle DevTools',
        accelerator: 'CmdOrCtrl+Shift+I',
        click: () => {
          if (mainWindow) {
            mainWindow.webContents.toggleDevTools();
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
        click: () => {
          app.quit();
        }
      }
    ]
  },
  {
    label: 'View',
    submenu: [
      {
        label: 'Zoom In',
        accelerator: 'CmdOrCtrl+Plus',
        click: () => {
          if (mainWindow) {
            mainWindow.webContents.executeJavaScript('map.zoomIn()');
          }
        }
      },
      {
        label: 'Zoom Out',
        accelerator: 'CmdOrCtrl+-',
        click: () => {
          if (mainWindow) {
            mainWindow.webContents.executeJavaScript('map.zoomOut()');
          }
        }
      }
    ]
  }
];

Menu.setApplicationMenu(Menu.buildFromTemplate(template));