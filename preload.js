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
    getAppPath:  () => {
        // For portable builds, electron-builder sets this environment variable
        if (process.env.PORTABLE_EXECUTABLE_DIR) {
            return process.env.PORTABLE_EXECUTABLE_DIR;
        }
        
        // Fallback for development or non-portable builds
        return path.dirname(process.execPath);
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