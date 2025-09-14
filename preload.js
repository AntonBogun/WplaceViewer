console.log('=== PRELOAD SCRIPT STARTING ===');
console.log('process.cwd():', process.cwd());

// const { contextBridge, ipcRenderer} = require('electron');
const { contextBridge } = require('electron');
const fs = require('fs').promises;
const path = require('path');

console.log('✅ All modules loaded successfully');

contextBridge.exposeInMainWorld('electronAPI', {
    // File system operations
    readFile: (filePath, options) => fs.readFile(filePath, options),
    writeFile: (filePath, data) => fs.writeFile(filePath, data),
    mkdir: (dirPath, options) => fs.mkdir(dirPath, options),
    
    // Path operations
    join: (...paths) => path.join(...paths),
    dirname: (filePath) => path.dirname(filePath),
    getAppPath: () => {
        // Check if we're in development mode
        const isDev = process.env.NODE_ENV === 'development' || process.defaultApp || /[\\/]electron-prebuilt[\\/]/.test(process.execPath) || /[\\/]electron[\\/]/.test(process.execPath);
        
        if (isDev) {
            // In development, use the project root directory
            return process.cwd();
        } else if (process.env.PORTABLE_EXECUTABLE_DIR) {
            // In portable build, use the real executable directory
            return process.env.PORTABLE_EXECUTABLE_DIR;
        } else {
            // Fallback for other packaged builds
            return path.dirname(process.execPath);
        }
    },
    
    // Process info
    cwd: () => process.cwd(),
    platform: process.platform,
    
    // Buffer operations
    bufferFrom: (data) => Buffer.from(data),
    
    // Shell operations
    openPath: (filePath) => require('electron').shell.showItemInFolder(filePath),

    // Check if running in Electron
    isElectron: true
});

console.log('✅ contextBridge.exposeInMainWorld completed');
console.log('=== PRELOAD SCRIPT COMPLETED ===');