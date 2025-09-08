console.log('=== PRELOAD SCRIPT STARTING ===');
console.log('process.cwd():', process.cwd());

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
    
    // Process info
    cwd: () => process.cwd(),
    platform: process.platform,
    
    // Buffer operations - ADD THIS
    bufferFrom: (data) => Buffer.from(data),
    
    // Check if running in Electron
    isElectron: true
});

console.log('✅ contextBridge.exposeInMainWorld completed');
console.log('=== PRELOAD SCRIPT COMPLETED ===');