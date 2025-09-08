// Initialize the map
let map;
let currentBaseLayer;
let gridLayer;
let pixelLayer;
let baseLayers = {};
let selectedPixel = null;
let selectionHighlight = null;



// wplace coordinate conversion constants
const mapSize = 2048000; // Total pixels in Web Mercator at max zoom (2048 tiles * 1000 pixels each)
const tileSize = 1000; // Each wplace tile is 1000x1000 pixels
const WORLD_MIN = { x: -180, y: -85.05112878 }; // Web Mercator bounds
const WORLD_MAX = { x: 180, y: 85.05112878 };
let wplaceTileLayer;
let loadedTiles = new Map(); // Cache for loaded tile images
const MIN_PIXEL_SIZE = 1/4; // Minimum pixel size in screen pixels before we hide tiles


let downloadQueue = [];
let downloadingTiles = new Set();
let downloadedTiles = new Set();


let tileTimestamps = new Map(); // Track when tiles were downloaded
let autoRefreshEnabled = true; // Whether to auto-redownload old tiles
const TILE_REFRESH_HOURS = 1; // Hours before considering a tile stale

let emptyTiles = new Set();
let lastDownloadTime = 0;
const DOWNLOAD_RATE_LIMIT = 200; // milliseconds between downloads
const MAX_CONCURRENT_DOWNLOADS = 3;
let activeDownloads = 0;
let tileStatusOverlays = new Map(); // For showing download status

let downloadsPaused = false; // Whether to pause automatic downloading

let favoritePixels = new Map(); // Store favorite pixels: key -> {tileX, tileY, pixelX, pixelY, name, timestamp}
let favoriteMarkers = new Map(); // Visual markers for favorites
let favoriteLayer; // Layer group for favorite markers
let favoritesVisible = true; // Whether favorites are currently shown


//make tiles available
window.loadedTiles = loadedTiles;
window.downloadedTiles = downloadedTiles;
window.emptyTiles = emptyTiles;
window.downloadingTiles = downloadingTiles;
window.tileStatusOverlays = tileStatusOverlays;
window.tileTimestamps = tileTimestamps;
window.favoritePixels = favoritePixels;
window.favoriteMarkers = favoriteMarkers;

// Check if we're running in Electron
function isElectron() {
    return typeof window.electronAPI !== 'undefined' && window.electronAPI.isElectron;
}

async function loadDownloadedTilesList() {
    if (isElectron()) {
        try {
            const filePath = window.electronAPI.join(window.electronAPI.cwd(), 'downloaded_tiles.json');
            const data = await window.electronAPI.readFile(filePath, 'utf8');
            const parsed = JSON.parse(data);
            
            // Handle both old format (array) and new format (object)
            if (Array.isArray(parsed)) {
                downloadedTiles = new Set(parsed);
                emptyTiles = new Set();
                tileTimestamps = new Map(); // No timestamps for old data
                favoritePixels = new Map(); // No favorites for old data
                window.downloadedTiles = downloadedTiles;
                window.emptyTiles = emptyTiles;
                window.tileTimestamps = tileTimestamps;
                window.favoritePixels = favoritePixels;
            } else {
                downloadedTiles = new Set(parsed.downloaded || []);
                emptyTiles = new Set(parsed.empty || []);
                // Load timestamps
                tileTimestamps = new Map(Object.entries(parsed.timestamps || {}));
                favoritePixels = new Map(Object.entries(parsed.favorites || {}));
                window.downloadedTiles = downloadedTiles;
                window.emptyTiles = emptyTiles;
                window.tileTimestamps = tileTimestamps;
                window.favoritePixels = favoritePixels;
            }
            
            updateStatus(`Loaded ${downloadedTiles.size} downloaded tiles (${emptyTiles.size} empty) from cache`);
        } catch (error) {
            console.log('No existing downloaded tiles cache found');
            downloadedTiles = new Set();
            emptyTiles = new Set();
            tileTimestamps = new Map();
            window.downloadedTiles = downloadedTiles;
            window.emptyTiles = emptyTiles;
            window.tileTimestamps = tileTimestamps;
        }
    } else {
        console.log("Not running in Electron, skipping loading downloaded tiles list");
    }
}
function updateVisibleTiles() {
    const pixelSize = calculatePixelSizeOnScreen();
    if (pixelSize < MIN_PIXEL_SIZE) {
        // Remove all tile overlays when zoomed out too far
        wplaceTileLayer.clearLayers();
        loadedTiles.clear();
        return;
    }
    
    const viewInfo = getWplaceViewInfo();
    if (!viewInfo.visibleTiles) {
        wplaceTileLayer.clearLayers();
        loadedTiles.clear();
        return;
    }
    
    const visibleTiles = viewInfo.visibleTiles;
    const currentlyVisible = new Set();
    
    // Load visible downloaded tiles
    for (let tileX = visibleTiles.startX; tileX <= visibleTiles.endX; tileX++) {
        for (let tileY = visibleTiles.startY; tileY <= visibleTiles.endY; tileY++) {
            if (tileX >= 0 && tileX < 2048 && tileY >= 0 && tileY < 2048) {
                const tileKey = `${tileX}-${tileY}`;
                currentlyVisible.add(tileKey);
                
                // Only load if downloaded and not already loaded
                if (downloadedTiles.has(tileKey) && !loadedTiles.has(tileKey) && !emptyTiles.has(tileKey)) {
                    loadWplaceTile(tileX, tileY);
                }
            }
        }
    }
    
    // Remove tiles that are no longer visible
    const tilesToRemove = [];
    loadedTiles.forEach((overlay, tileKey) => {
        if (!currentlyVisible.has(tileKey)) {
            wplaceTileLayer.removeLayer(overlay);
            tilesToRemove.push(tileKey);
        }
    });
    
    // Clean up the loadedTiles map
    tilesToRemove.forEach(tileKey => {
        loadedTiles.delete(tileKey);
    });
    
    updateStatus(`Showing ${loadedTiles.size} tiles, ${tilesToRemove.length} removed`);
}

async function saveDownloadedTilesList() {
    if (isElectron()) {
        try {
            const data = {
                downloaded: Array.from(downloadedTiles),
                empty: Array.from(emptyTiles),
                timestamps: Object.fromEntries(tileTimestamps),
                favorites: Object.fromEntries(favoritePixels)
            };
            
            const filePath = window.electronAPI.join(window.electronAPI.cwd(), 'downloaded_tiles.json');
            await window.electronAPI.writeFile(filePath, JSON.stringify(data, null, 2));
        } catch (error) {
            console.error('Failed to save downloaded tiles list:', error);
        }
    }
}
function createFavoriteKey(tileX, tileY, pixelX, pixelY) {
    return `${tileX}-${tileY}-${pixelX}-${pixelY}`;
}
function createFavoriteLayer() {
    favoriteLayer = L.layerGroup();
    favoriteLayer.addTo(map);
    window.favoriteLayer = favoriteLayer;
}

function addFavorite(wplaceCoords, name = null) {
    const key = createFavoriteKey(wplaceCoords.tileX, wplaceCoords.tileY, wplaceCoords.pixelX, wplaceCoords.pixelY);
    
    if (!name) {
        // name = prompt(`Name for favorite at Tile(${wplaceCoords.tileX},${wplaceCoords.tileY}) Pixel(${wplaceCoords.pixelX},${wplaceCoords.pixelY}):`);
        const latlong = wplaceToLatLng(wplaceCoords.tileX, wplaceCoords.tileY, wplaceCoords.pixelX, wplaceCoords.pixelY);
        name=`Lat ${latlong[0].toFixed(5)}, Lng ${latlong[1].toFixed(5)}, Tile(${wplaceCoords.tileX},${wplaceCoords.tileY}) Pixel(${wplaceCoords.pixelX},${wplaceCoords.pixelY})`;
        if (!name) return; // User cancelled
    }
    
    const favorite = {
        tileX: wplaceCoords.tileX,
        tileY: wplaceCoords.tileY,
        pixelX: wplaceCoords.pixelX,
        pixelY: wplaceCoords.pixelY,
        name: name,
        timestamp: Date.now()
    };
    
    favoritePixels.set(key, favorite);
    createFavoriteMarker(favorite);
    saveDownloadedTilesList();
    updateStatus(`Added favorite: ${name}`);
    updateFavoriteButton();
}

function removeFavorite(wplaceCoords) {
    const key = createFavoriteKey(wplaceCoords.tileX, wplaceCoords.tileY, wplaceCoords.pixelX, wplaceCoords.pixelY);
    
    if (favoritePixels.has(key)) {
        const favorite = favoritePixels.get(key);
        favoritePixels.delete(key);
        
        // Remove marker
        if (favoriteMarkers.has(key)) {
            favoriteLayer.removeLayer(favoriteMarkers.get(key)); // Changed from map.removeLayer()
            favoriteMarkers.delete(key);
        }
        
        saveDownloadedTilesList();
        updateStatus(`Removed favorite: ${favorite.name}`);
        updateFavoriteButton();
    }
}

function isFavorite(wplaceCoords) {
    const key = createFavoriteKey(wplaceCoords.tileX, wplaceCoords.tileY, wplaceCoords.pixelX, wplaceCoords.pixelY);
    return favoritePixels.has(key);
}

function createFavoriteMarker(favorite) {
    const key = createFavoriteKey(favorite.tileX, favorite.tileY, favorite.pixelX, favorite.pixelY);
    
    // Remove existing marker if any
    if (favoriteMarkers.has(key)) {
        favoriteLayer.removeLayer(favoriteMarkers.get(key));
    }
    
    const [lat, lng] = wplaceToLatLng(favorite.tileX, favorite.tileY, favorite.pixelX, favorite.pixelY);
    
    const marker = L.marker([lat, lng], {
        icon: L.divIcon({
            className: 'favorite-marker',
            html: '★',
            iconSize: [20, 20],
            iconAnchor: [10, 10]
        }),
        title: favorite.name
    });
    
    // Click to zoom to this favorite
    marker.on('click', function() {
        const coords = wplaceToLatLng(favorite.tileX, favorite.tileY, favorite.pixelX, favorite.pixelY);
        map.setView(coords, 15);
        selectPixel(favorite, { lat: coords[0], lng: coords[1] });
        updateStatus(`Zoomed to favorite: ${favorite.name}`);
    });
    
    favoriteLayer.addLayer(marker); // Changed from map.addTo()
    favoriteMarkers.set(key, marker);
}

function loadAllFavorites() {
    favoritePixels.forEach(favorite => {
        createFavoriteMarker(favorite);
    });
    updateStatus(`Loaded ${favoritePixels.size} favorites`);
}

function updateFavoriteButton() {
    const favoriteBtn = document.getElementById('favoritePixel');
    
    if (!selectedPixel) {
        favoriteBtn.disabled = true;
        favoriteBtn.textContent = '★ Favorite';
        return;
    }
    
    favoriteBtn.disabled = false;
    
    if (isFavorite(selectedPixel)) {
        favoriteBtn.textContent = '★ Unfavorite';
    } else {
        favoriteBtn.textContent = '★ Favorite';
    }
}
function isTileStale(tileKey) {
    if (!autoRefreshEnabled) return false;
    
    const timestamp = tileTimestamps.get(tileKey);
    if (!timestamp) return true; // No timestamp = needs download
    
    const now = Date.now();
    const ageHours = (now - timestamp) / (1000 * 60 * 60);
    return ageHours > TILE_REFRESH_HOURS;
}

// Create distributed directory structure
function getTileFilePath(tileX, tileY) {
    if (isElectron()) {
        // Distribute tiles across subdirectories to avoid filesystem slowdown
        const subDir1 = Math.floor(tileX / 64);
        const subDir2 = Math.floor(tileY / 64);
        return window.electronAPI.join(window.electronAPI.cwd(), 'tiles', `${subDir1}`, `${subDir2}`, `${tileX}_${tileY}.png`);
    }
    return `tiles/${tileX}_${tileY}.png`;
}

async function ensureDirectoryExists(filePath) {
    if (isElectron()) {
        const dir = window.electronAPI.dirname(filePath);
        try {
            await window.electronAPI.mkdir(dir, { recursive: true });
        } catch (error) {
            // Directory might already exist
        }
    }
}

function calculateTileDistance(tileX, tileY, centerTileX, centerTileY) {
    return Math.sqrt(Math.pow(tileX - centerTileX, 2) + Math.pow(tileY - centerTileY, 2));
}

function prioritizeTiles(visibleTiles) {
    const bounds = map.getBounds();
    const center = map.getCenter();
    const centerWplace = latLngToWplace(center.lat, center.lng);
    
    if (!centerWplace) return [];
    
    const tiles = [];
    for (let tileX = visibleTiles.startX; tileX <= visibleTiles.endX; tileX++) {
        for (let tileY = visibleTiles.startY; tileY <= visibleTiles.endY; tileY++) {
            if (tileX >= 0 && tileX < 2048 && tileY >= 0 && tileY < 2048) {
                const distance = calculateTileDistance(tileX, tileY, centerWplace.tileX, centerWplace.tileY);
                tiles.push({ tileX, tileY, distance });
            }
        }
    }
    
    // Sort by distance from center
    tiles.sort((a, b) => a.distance - b.distance);
    return tiles;
}

async function downloadTile(tileX, tileY) {
    const tileKey = `${tileX}-${tileY}`;
    
    if ((downloadedTiles.has(tileKey) || downloadingTiles.has(tileKey)) && !isTileStale(tileKey)) {
        return false; // Already downloaded or downloading
    }
    // return false; // TEMP DISABLE

    downloadingTiles.add(tileKey);
    activeDownloads++;
    
    // Show downloading status
    showTileStatus(tileX, tileY, 'downloading');
    
    try {
        const url = `https://backend.wplace.live/files/s0/tiles/${tileX}/${tileY}.png`;
        const response = await fetch(url);
        
        if (response.status === 404) {
            // Tile is empty, mark as downloaded but don't save file
            downloadedTiles.add(tileKey);
            tileTimestamps.set(tileKey, Date.now()); // Add this line
            emptyTiles.add(tileKey);
            downloadingTiles.delete(tileKey);
            activeDownloads--;
            
            // Remove status overlay (no visual indication needed for empty tiles)
            const statusOverlay = tileStatusOverlays.get(tileKey);
            if (statusOverlay) {
                map.removeLayer(statusOverlay);
                tileStatusOverlays.delete(tileKey);
            }
            
            updateStatus(`Tile ${tileX},${tileY} is empty (404) - marked as complete`);
            return true;
        }
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const blob = await response.blob();
        
        if (isElectron()) {
            // Save to file system
            const filePath = getTileFilePath(tileX, tileY);
            await ensureDirectoryExists(filePath);
            
            const buffer = await blob.arrayBuffer();
            await window.electronAPI.writeFile(filePath, window.electronAPI.bufferFrom(buffer));
        }
        
        // Mark as downloaded
        downloadedTiles.add(tileKey);
        tileTimestamps.set(tileKey, Date.now()); // Add this line
        downloadingTiles.delete(tileKey);
        activeDownloads--;
        
        // Update status display
        showTileStatus(tileX, tileY, 'downloaded');
        
        // Load the tile into the map only if currently visible
        const viewInfo = getWplaceViewInfo();
        if (viewInfo.visibleTiles && 
            tileX >= viewInfo.visibleTiles.startX && tileX <= viewInfo.visibleTiles.endX &&
            tileY >= viewInfo.visibleTiles.startY && tileY <= viewInfo.visibleTiles.endY) {
            loadWplaceTile(tileX, tileY);
        }
        
        updateStatus(`Downloaded tile ${tileX},${tileY} (${downloadedTiles.size} total)`);
        
        // Save updated list periodically
        if (downloadedTiles.size % 10 === 0) {
            await saveDownloadedTilesList();
        }
        
        return true;
        
    } catch (error) {
        console.error(`Failed to download tile ${tileX},${tileY}:`, error);
        downloadingTiles.delete(tileKey);
        activeDownloads--;
        showTileStatus(tileX, tileY, 'failed');
        return false;
    }
}
function showTileStatus(tileX, tileY, status) {
    const pixelSize = calculatePixelSizeOnScreen();
    if (pixelSize < MIN_PIXEL_SIZE) return; // Don't show status if tiles are too small
    
    const tileKey = `${tileX}-${tileY}`;
    
    // Remove existing status overlay
    if (tileStatusOverlays.has(tileKey)) {
        map.removeLayer(tileStatusOverlays.get(tileKey));
        tileStatusOverlays.delete(tileKey);
    }
    
    // Choose color based on status
    let color, opacity;
    switch (status) {
        case 'downloading':
            color = '#8000ff'; // Purple
            opacity = 0.6;
            break;
        case 'downloaded':
            // Remove the overlay for downloaded tiles
            return;
        case 'failed':
            color = '#ff0000'; // Red
            opacity = 0.4;
            break;
        case 'needed':
            color = '#808080'; // Gray
            opacity = 0.3;
            break;
        default:
            return;
    }
    
    // Calculate tile bounds
    const [topLat, leftLng] = wplaceToLatLng(tileX, tileY, 0, 0);
    const [bottomLat, rightLng] = wplaceToLatLng(tileX + 1, tileY + 1, 0, 0);
    
    const overlay = L.rectangle([
        [bottomLat, leftLng],
        [topLat, rightLng]
    ], {
        color: color,
        fillColor: color,
        fillOpacity: opacity,
        weight: 1,
        opacity: 0.8
    });
    
    overlay.addTo(map);
    tileStatusOverlays.set(tileKey, overlay);
}

function updateTileStatusDisplay() {
    const pixelSize = calculatePixelSizeOnScreen();
    if (pixelSize < MIN_PIXEL_SIZE) {
        // Clear all status overlays when zoomed out
        tileStatusOverlays.forEach(overlay => map.removeLayer(overlay));
        tileStatusOverlays.clear();
        return;
    }
    
    const viewInfo = getWplaceViewInfo();
    if (!viewInfo.visibleTiles) return;
    
    const visibleTiles = viewInfo.visibleTiles;
    
    // Show status for all visible tiles
    for (let tileX = visibleTiles.startX; tileX <= visibleTiles.endX; tileX++) {
        for (let tileY = visibleTiles.startY; tileY <= visibleTiles.endY; tileY++) {
            const tileKey = `${tileX}-${tileY}`;
            
            if (downloadingTiles.has(tileKey)) {
                showTileStatus(tileX, tileY, 'downloading');
            } else if (!downloadedTiles.has(tileKey)) {
                showTileStatus(tileX, tileY, 'needed');
            }
        }
    }
}

async function processDownloadQueue() {
    if (downloadQueue.length === 0 || activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
        return;
    }
    
    const now = Date.now();
    if (now - lastDownloadTime < DOWNLOAD_RATE_LIMIT) {
        // Schedule next attempt
        setTimeout(processDownloadQueue, DOWNLOAD_RATE_LIMIT - (now - lastDownloadTime));
        return;
    }
    
    const tile = downloadQueue.shift();
    if (tile) {
        lastDownloadTime = now;
        await downloadTile(tile.tileX, tile.tileY);
        
        // Continue processing queue
        setTimeout(processDownloadQueue, DOWNLOAD_RATE_LIMIT);
    }
}

function queueTileDownloads() {
    if (downloadsPaused) {
        return; // Don't queue anything if downloads are paused
    }

    const pixelSize = calculatePixelSizeOnScreen();
    if (pixelSize < MIN_PIXEL_SIZE) {
        // Clear queue if pixels are too small
        downloadQueue = [];
        return;
    }
    
    const viewInfo = getWplaceViewInfo();
    if (!viewInfo.visibleTiles) return;
    
    const prioritizedTiles = prioritizeTiles(viewInfo.visibleTiles);
    
    // Add undownloaded tiles to queue
    prioritizedTiles.forEach(tile => {
        const tileKey = `${tile.tileX}-${tile.tileY}`;
        if ((!downloadedTiles.has(tileKey) || isTileStale(tileKey)) && !downloadingTiles.has(tileKey)) {
            // Check if already in queue
            const alreadyQueued = downloadQueue.some(queuedTile => 
                queuedTile.tileX === tile.tileX && queuedTile.tileY === tile.tileY
            );
            
            if (!alreadyQueued) {
                downloadQueue.push(tile);
            }
        }
    });
    
    // Start processing if not already running
    processDownloadQueue();
}

function createWplaceTileLayer() {
    wplaceTileLayer = L.layerGroup();
    window.wplaceTileLayer = wplaceTileLayer;
    wplaceTileLayer.addTo(map);
}
function loadWplaceTile(tileX, tileY) {
    const tileKey = `${tileX}-${tileY}`;
    
    // Check if already loaded
    if (loadedTiles.has(tileKey)) {
        return loadedTiles.get(tileKey);
    }
    
    // Skip if we know this tile is empty
    if (emptyTiles && emptyTiles.has(tileKey)) {
        return null;
    }
    
    // Skip if not downloaded yet
    if (!downloadedTiles.has(tileKey)) {
        return null;
    }
    
    // Calculate tile bounds
    const [topLat, leftLng] = wplaceToLatLng(tileX, tileY, 0, 0);
    const [bottomLat, rightLng] = wplaceToLatLng(tileX + 1, tileY + 1, 0, 0);
    
    // Use the correct file path (distributed structure)
    const tilePath = getTileFilePath(tileX, tileY);
    
    // Convert to file:// URL for Electron
    const fileUrl = isElectron() ? `file://${tilePath}` : tilePath;
    
    const imageOverlay = L.imageOverlay(fileUrl, [
        [bottomLat, leftLng], // southwest corner
        [topLat, rightLng]    // northeast corner
    ], {
        opacity: 1.0,
        interactive: false,
        crossOrigin: 'anonymous'
    });
    
    // Handle load events
    imageOverlay.on('load', function() {
        console.log(`Loaded tile ${tileX},${tileY} from file`);
    });
    
    imageOverlay.on('error', function() {
        console.log(`Failed to load tile ${tileX},${tileY} from file`);
        loadedTiles.delete(tileKey);
    });
    
    // Store and add to layer
    loadedTiles.set(tileKey, imageOverlay);
    wplaceTileLayer.addLayer(imageOverlay);
    
    return imageOverlay;
}

// Load image from file system (for Electron)
function loadImageFromFile(filePath) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = filePath;
    });
}

// Load image from URL/blob
function loadImageFromUrl(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.crossOrigin = 'anonymous'; // For CORS if needed
        img.src = url;
    });
}


// Get current map view
function getCurrentMapState() {
    const center = map.getCenter();
    const zoom = map.getZoom();
    const bounds = map.getBounds();
    const pixelWorldBounds = map.getPixelWorldBounds();
    return {
        centerLat: center.lat,
        centerLng: center.lng,
        zoom: zoom,
        worldPixels: pixelWorldBounds.max,
        northEast: bounds.getNorthEast(),
        southWest: bounds.getSouthWest()
    };
}

// Convert between coordinate systems
function getWplaceViewInfo() {
    const bounds = map.getBounds();
    const topLeft = latLngToWplace(bounds.getNorth(), bounds.getWest());
    const bottomRight = latLngToWplace(bounds.getSouth(), bounds.getEast());
    
    return {
        topLeft: topLeft,
        bottomRight: bottomRight,
        visibleTiles: topLeft && bottomRight ? {
            startX: Math.floor(topLeft.tileX),
            endX: Math.ceil(bottomRight.tileX),
            startY: Math.floor(topLeft.tileY),
            endY: Math.ceil(bottomRight.tileY)
        } : null
    };
}

// Initialize map when page loads
document.addEventListener('DOMContentLoaded', function() {
    initializeMap();
    setupControls();
    setupEventListeners();
});


function createPixelLayer() {
    pixelLayer = L.layerGroup();
    
    // Add some test pixels to see if our coordinate conversion works
    addTestPixels();
}



function latLonToPixel(lat, lon) {
    // Clamp latitude to Web Mercator bounds
    lat = Math.max(-85.05112878, Math.min(85.05112878, lat));
    
    // Convert to radians
    const latRad = lat * Math.PI / 180;
    const lonRad = lon * Math.PI / 180;
    
    // X coordinate (longitude is linear)
    const x = (lonRad + Math.PI) / (2 * Math.PI) * mapSize;
    
    // Y coordinate (latitude uses Mercator projection)
    const y = (1 - (Math.log(Math.tan(latRad) + 1/Math.cos(latRad)) / Math.PI)) / 2 * mapSize;

    return [Math.floor(x), Math.floor(y)];
}
function latLngToWplace(lat, lon) {
    const [x, y] = latLonToPixel(lat, lon);
    if (x < 0 || x > mapSize || y < 0 || y > mapSize) {
        return null; // Out of bounds
    }
    const tileX = Math.floor(x / tileSize);
    const tileY = Math.floor(y / tileSize);
    const pixelX = x % tileSize;
    const pixelY = y % tileSize;
    return { tileX, tileY, pixelX, pixelY };
}


function pixelToLatLon(x, y) {
    // Convert pixel to normalized coordinates (0-1)
    const xNorm = x / mapSize;
    const yNorm = y / mapSize;
    
    // Longitude (linear conversion)
    const lon = (xNorm * 2 - 1) * 180;
    
    // Latitude (inverse Mercator projection)
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * yNorm)));
    const lat = latRad * 180 / Math.PI;
    
    return [lat, lon];
}

function wplaceToLatLng(tileX, tileY, pixelX, pixelY) {
    return pixelToLatLon(
        tileX * tileSize + pixelX,
        tileY * tileSize + pixelY
    );
}
function getContainerMapPixels() {
    const worldBounds = map.getPixelWorldBounds();
    if (!worldBounds) return null;
    if(worldBounds.min.x >1 || worldBounds.min.y >1) {
        console.warn("Unexpected world bounds:", worldBounds);
    }
    return {
        width:worldBounds.max.x,
        height:worldBounds.max.y
    };
}
function containerToWplace(containerX, containerY) {
    const scale = getContainerMapPixels();
    const wplaceX = Math.floor(containerX / scale.width*mapSize);
    const wplaceY = Math.floor(containerY / scale.height*mapSize);
    const tileX = Math.floor(wplaceX / tileSize);
    const tileY = Math.floor(wplaceY / tileSize);
    const pixelX = wplaceX % tileSize;
    const pixelY = wplaceY % tileSize;
    return { tileX, tileY, pixelX, pixelY };
}
function wplaceToContainer(tileX, tileY, pixelX, pixelY) {
    const wplaceX = tileX * tileSize + pixelX;
    const wplaceY = tileY * tileSize + pixelY;
    const scale = getContainerMapPixels();
    const containerX = (wplaceX / mapSize) * scale.width;
    const containerY = (wplaceY / mapSize) * scale.height;
    return { containerX, containerY };
}

function addTestPixels() {
    // Test pixels to verify the coordinate system
    const centerTileX = 1024;
    const centerTileY = 1024;
    
    const testPixels = [
        // Corner pixels of the center tile
        { x: centerTileX, y: centerTileY, z: 0, w: 0, color: '#ff0000' },      // top-left
        { x: centerTileX, y: centerTileY, z: 999, w: 0, color: '#00ff00' },    // top-right
        { x: centerTileX, y: centerTileY, z: 0, w: 999, color: '#0000ff' },    // bottom-left
        { x: centerTileX, y: centerTileY, z: 999, w: 999, color: '#ffff00' },  // bottom-right
        // Center pixel
        { x: centerTileX, y: centerTileY, z: 500, w: 500, color: '#ff00ff' },
    ];
    
    testPixels.forEach(pixel => {
        // Get the top-left corner of this pixel
        const [lat, lng] = wplaceToLatLng(pixel.x, pixel.y, pixel.z, pixel.w);
        
        // Very small marker just to see where pixels are
        const circle = L.circleMarker([lat, lng], {
            color: pixel.color,
            fillColor: pixel.color,
            fillOpacity: 1.0,
            radius: 3,
            weight: 1
        });
        
        pixelLayer.addLayer(circle);
    });
    
    pixelLayer.addTo(map);
    
    const centerCoords = wplaceToLatLng(centerTileX, centerTileY, 500, 500);
    map.setView(centerCoords, 12);
    
    updateStatus(`Added ${testPixels.length} test pixels`);
}

function updateGrid() {
    if (gridLayer && map.hasLayer(gridLayer)) {
        addGridToCurrentView();
    }
}
// Set up map bounds and zoom limits
function setupMapLimits() {
    // wplace world bounds
    const worldBounds = L.latLngBounds(
        [WORLD_MAX.y, WORLD_MIN.x], // southwest
        [WORLD_MIN.y, WORLD_MAX.x]  // northeast
    );
    
    // Restrict panning to wplace area
    map.setMaxBounds(worldBounds);
    map.options.maxBoundsViscosity = 1.0; // Hard boundary
    
    // Set zoom limits
    map.setMinZoom(3);  // Can't zoom out too far
    map.setMaxZoom(26); // Can zoom in very close
}
function initializeMap() {
    // Create map centered on world view
    map = L.map('map', {
        center: [0, 0],
        zoom: 2,
        zoomControl: false, // We'll add custom controls
        attributionControl: true
    });
    //add to window
    window.map = map;

    // Add zoom control in bottom right
    L.control.zoom({
        position: 'bottomright'
    }).addTo(map);

    // Define base layers
    baseLayers = {
        osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors',
            maxZoom: 19
        }),
        satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            attribution: '© Esri, Maxar, Earthstar Geographics',
            maxZoom: 18
        }),
        topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenTopoMap contributors',
            maxZoom: 17
        }),
        dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '© CARTO, © OpenStreetMap contributors',
            maxZoom: 19
        })
    };

    // Set initial base layer
    currentBaseLayer = baseLayers.osm;
    currentBaseLayer.addTo(map);

    // Create a grid overlay for tile boundaries (useful for debugging)
    createGridLayer();
    createPixelLayer();
    setupMapLimits();
    createWplaceTileLayer();
    createFavoriteLayer();

    updateStatus('Map initialized');
}

function calculatePixelSizeOnScreen() {
    // Calculate how big one wplace pixel is on screen
    const mapState = getCurrentMapState();
    if (mapState.worldPixels.x !== mapState.worldPixels.y) {
        console.warn("Unexpected: worldPixels x and y differ:", mapState);
    }
    return (mapState.worldPixels.x / mapSize);
}


function createGridLayer() {
    gridLayer = L.layerGroup();
    
    // This will show tile boundaries - useful for understanding tile structure
    // We'll add this when user clicks "Toggle Grid"
}

function setupControls() {
    const baseLayerSelect = document.getElementById('baseLayer');
    const resetViewBtn = document.getElementById('resetView');
    const toggleGridBtn = document.getElementById('toggleGrid');

    // Base layer switcher
    baseLayerSelect.addEventListener('change', function() {
        const selectedLayer = this.value;
        
        // Remove current layer
        map.removeLayer(currentBaseLayer);
        
        // Add new layer
        currentBaseLayer = baseLayers[selectedLayer];
        currentBaseLayer.addTo(map);
        
        updateStatus(`Switched to ${selectedLayer} layer`);
    });

    // Reset view
    resetViewBtn.addEventListener('click', function() {
        map.setView([0, 0], 2);
        updateStatus('View reset');
    });

// Toggle grid
    let gridVisible = false;
    toggleGridBtn.addEventListener('click', function() {
        if (gridVisible) {
            map.removeLayer(gridLayer);
            gridVisible = false;
            this.textContent = 'Toggle Grid';
            // Remove the moveend listener when hiding grid
            map.off('moveend zoomend', updateGrid);
        } else {
            addGridToCurrentView();
            map.addLayer(gridLayer);
            gridVisible = true;
            this.textContent = 'Hide Grid';
            // Add listener to update grid when map moves
            map.on('moveend zoomend', updateGrid);
        }
    });
    const togglePixelsBtn = document.getElementById('togglePixels');
    const centerOnPixelsBtn = document.getElementById('centerOnPixels');
    const toggleImageBtn = document.getElementById('toggleImage');
    // Toggle pixels
    let pixelsVisible = true;
    togglePixelsBtn.addEventListener('click', function() {
        if (pixelsVisible) {
            map.removeLayer(pixelLayer);
            pixelsVisible = false;
            this.textContent = 'Show Pixels';
        } else {
            map.addLayer(pixelLayer);
            pixelsVisible = true;
            this.textContent = 'Hide Pixels';
        }
    });
    // Toggle image layer
    let imageVisible = true;
    toggleImageBtn.addEventListener('click', function() {
        if (imageVisible) {
            map.removeLayer(wplaceTileLayer);
            imageVisible = false;
            this.textContent = 'Show Image';
        } else {
            map.addLayer(wplaceTileLayer);
            imageVisible = true;
            this.textContent = 'Hide Image';
        }
    });
    loadWplaceTile(1024, 1024); // Load center tile as initial test
    
    // Center on test pixels
    centerOnPixelsBtn.addEventListener('click', function() {
        const centerCoords = wplaceToLatLng(1024, 1024, 500, 500);
        map.setView(centerCoords, 15);
        updateStatus('Centered on test pixels');
    });
    // Auto-refresh toggle
    const toggleAutoRefreshBtn = document.getElementById('toggleAutoRefresh');
    toggleAutoRefreshBtn.addEventListener('click', function() {
        autoRefreshEnabled = !autoRefreshEnabled;
        this.textContent = `Auto-Refresh: ${autoRefreshEnabled ? 'ON' : 'OFF'}`;
        updateStatus(`Auto-refresh ${autoRefreshEnabled ? 'enabled' : 'disabled'}`);
        
        if (autoRefreshEnabled) {
            queueTileDownloads(); // Re-queue stale tiles
        }
    });

    // Pause/Resume downloads
    const cancelDownloadsBtn = document.getElementById('cancelDownloads');
    cancelDownloadsBtn.addEventListener('click', function() {
        downloadsPaused = !downloadsPaused;
        
        if (downloadsPaused) {
            // Clear current queue and stop future downloads
            downloadQueue = [];
            this.textContent = 'Resume Downloads';
            updateStatus('Downloads paused - map movements will not trigger new downloads');
        } else {
            // Resume downloads and queue current view
            this.textContent = 'Pause Downloads';
            updateStatus('Downloads resumed');
            queueTileDownloads(); // Start downloading current view
        }
        
        updateMapInfo();
    });
    // Favorite pixel button
    const favoriteBtn = document.getElementById('favoritePixel');
    favoriteBtn.addEventListener('click', function() {
        if (!selectedPixel) return;
        
        if (isFavorite(selectedPixel)) {
            removeFavorite(selectedPixel);
        } else {
            addFavorite(selectedPixel);
        }
    });
    // Toggle favorites
    const toggleFavoritesBtn = document.getElementById('toggleFavorites');
    toggleFavoritesBtn.addEventListener('click', function() {
        if (favoritesVisible) {
            map.removeLayer(favoriteLayer);
            favoritesVisible = false;
            this.textContent = 'Show Favorites';
            updateStatus('Favorites hidden');
        } else {
            map.addLayer(favoriteLayer);
            favoritesVisible = true;
            this.textContent = 'Hide Favorites';
            updateStatus('Favorites shown');
        }
    });

}

function addGridToCurrentView() {
    // Clear existing grid
    gridLayer.clearLayers();
    
    const bounds = map.getBounds();
    const zoom = map.getZoom();
    
    // Convert map bounds to wplace coordinates to see which tiles are visible
    const topLeft = latLngToWplace(bounds.getNorth(), bounds.getWest());
    const bottomRight = latLngToWplace(bounds.getSouth(), bounds.getEast());
    
    if (!topLeft || !bottomRight) {
        // We're outside wplace bounds, don't draw grid
        return;
    }
    
    // Determine grid spacing based on zoom level
    let gridSpacing = 1; // tiles
    if (zoom > 8) gridSpacing = 1;      // Show every tile
    else if (zoom > 6) gridSpacing = 4;  // Show every 10th tile
    else if (zoom > 4) gridSpacing = 16; // Show every 100th tile
    else gridSpacing = 64;               // Show every 500th tile
    
    // Draw tile boundaries
    const startTileX = Math.floor(topLeft.tileX / gridSpacing) * gridSpacing;
    const endTileX = Math.ceil(bottomRight.tileX / gridSpacing) * gridSpacing;
    const startTileY = Math.floor(topLeft.tileY / gridSpacing) * gridSpacing;
    const endTileY = Math.ceil(bottomRight.tileY / gridSpacing) * gridSpacing;
    
    // Vertical lines (tile boundaries)
    for (let tileX = startTileX; tileX <= endTileX; tileX += gridSpacing) {
        if (tileX < 0 || tileX > 2048) continue;
        
        // Top and bottom of this tile column
        const [topLat, topLng] = wplaceToLatLng(tileX, 0, 0, 0);
        const [bottomLat, bottomLng] = wplaceToLatLng(tileX, 2047, 0, 999);
        
        const line = L.polyline([
            [topLat, topLng],
            [bottomLat, bottomLng]
        ], {
            color: '#000000',
            weight: 1,
            opacity: 0.5
        });
        gridLayer.addLayer(line);
    }
    
    // Horizontal lines (tile boundaries)
    for (let tileY = startTileY; tileY <= endTileY; tileY += gridSpacing) {
        if (tileY < 0 || tileY > 2048) continue;
        
        // Left and right of this tile row
        const [leftLat, leftLng] = wplaceToLatLng(0, tileY, 0, 0);
        const [rightLat, rightLng] = wplaceToLatLng(2047, tileY, 999, 0);
        
        const line = L.polyline([
            [leftLat, leftLng],
            [rightLat, rightLng]
        ], {
            color: '#000000',
            weight: 1,
            opacity: 0.5
        });
        gridLayer.addLayer(line);
    }
}

function setupEventListeners() {
    // Update info panel on map events
    map.on('zoomend moveend', function() {
        updateMapInfo();
        updateTileStatusDisplay();
        updateVisibleTiles(); // Manage visible tiles efficiently
        loadAllFavorites(); // Add this line
        queueTileDownloads();
    });
    
    map.on('mousemove', updateMouseInfo);
    
    // Handle map clicks for pixel selection
    map.on('click', function(e) {
        const lat = e.latlng.lat.toFixed(6);
        const lng = e.latlng.lng.toFixed(6);
        console.log(`Clicked at: ${lat}, ${lng}`);
        
        // Get wplace coordinates
        const wplaceCoords = latLngToWplace(e.latlng.lat, e.latlng.lng);
        if (wplaceCoords) {
            selectPixel(wplaceCoords, e.latlng);
            updateStatus(`Selected pixel: Tile(${wplaceCoords.tileX},${wplaceCoords.tileY}) Pixel(${wplaceCoords.pixelX},${wplaceCoords.pixelY})`);
        } else {
            updateStatus(`Clicked: ${lat}, ${lng} (out of bounds)`);
        }
    });
    
    // Initial setup
    loadDownloadedTilesList().then(() => {
        console.log(`Loaded ${downloadedTiles.size} downloaded tiles from storage`);
        updateVisibleTiles(); // Load only visible tiles
        queueTileDownloads(); // Then queue new downloads
    });
}

function selectPixel(wplaceCoords, latlng) {
    selectedPixel = wplaceCoords;
    
    // Remove previous selection highlight
    if (selectionHighlight) {
        map.removeLayer(selectionHighlight);
    }
    
    // Calculate the exact bounds of this pixel
    // Top-left corner of the pixel
    const [lat1, lng1] = wplaceToLatLng(wplaceCoords.tileX, wplaceCoords.tileY, wplaceCoords.pixelX, wplaceCoords.pixelY);
    // Bottom-right corner of the pixel (next pixel position)
    const [lat2, lng2] = wplaceToLatLng(wplaceCoords.tileX, wplaceCoords.tileY, wplaceCoords.pixelX + 1, wplaceCoords.pixelY + 1);
    
    // Create selection highlight as exact pixel boundaries
    selectionHighlight = L.rectangle([
        [lat2, lng1], // bottom-left  
        [lat1, lng2]  // top-right
    ], {
        color: '#ffffff',
        fillColor: 'transparent',
        weight: 2,
        opacity: 1.0,
        dashArray: '5, 5'
    });
    
    selectionHighlight.addTo(map);
    
    // Update selection info
    updateSelectionInfo();
    updateFavoriteButton(); // Add this line
}

function updateSelectionInfo() {
    if (selectedPixel) {
        const info = `Selected: Tile(${selectedPixel.tileX},${selectedPixel.tileY}) Pixel(${selectedPixel.pixelX},${selectedPixel.pixelY})`;
        document.getElementById('loadStatus').textContent = info;
    }
}

function updateMapInfo() {
    const zoom = map.getZoom();
    const center = map.getCenter();
    const pixelBounds = map.getPixelWorldBounds();
    const containerBounds = map.getPixelBounds();
    const wplaceBounds = {
        topLeft: containerToWplace(containerBounds.min.x, containerBounds.min.y),
        bottomRight: containerToWplace(containerBounds.max.x, containerBounds.max.y)
    }

    document.getElementById('zoomLevel').textContent = `${zoom.toFixed(1)} (${pixelBounds.max.x}, ${pixelBounds.max.y})`;
    document.getElementById('centerCoords').textContent = `${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}`;
    document.getElementById('wplaceSpanInfo').textContent = wplaceBounds.topLeft && wplaceBounds.bottomRight ?
        `(${wplaceBounds.topLeft.tileX},${wplaceBounds.topLeft.tileY},${wplaceBounds.topLeft.pixelX},${wplaceBounds.topLeft.pixelY}) to (${wplaceBounds.bottomRight.tileX},${wplaceBounds.bottomRight.tileY},${wplaceBounds.bottomRight.pixelX},${wplaceBounds.bottomRight.pixelY})` :
        'Out of bounds';
    document.getElementById('containerPixelInfo').textContent = `(${containerBounds.min.x}, ${containerBounds.min.y}) to (${containerBounds.max.x}, ${containerBounds.max.y})`;
    const staleCount = Array.from(downloadedTiles).filter(tileKey => isTileStale(tileKey)).length;
    document.getElementById('downloadInfo').textContent = `${downloadedTiles.size} downloaded (${staleCount} stale), ${activeDownloads} active`;
    document.getElementById('queueInfo').textContent = `${downloadQueue.length} queued`;
}

function updateMouseInfo(e) {
    const lat = e.latlng.lat.toFixed(6);
    const lng = e.latlng.lng.toFixed(6);
    
    document.getElementById('mouseCoords').textContent = `${lat}, ${lng}`;
    
    // Calculate which tile this would be (for future wplace integration)
    const zoom = map.getZoom();
    const tileX = Math.floor((e.latlng.lng + 180) / 360 * Math.pow(2, zoom));
    const tileY = Math.floor((1 - Math.log(Math.tan(e.latlng.lat * Math.PI / 180) + 1 / Math.cos(e.latlng.lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom));
    
    // Convert to wplace coordinates
    const wplaceCoords = latLngToWplace(e.latlng.lat, e.latlng.lng);
    if (wplaceCoords) {
        document.getElementById('wplaceTileInfo').textContent = `(${wplaceCoords.tileX}, ${wplaceCoords.tileY})`;
        document.getElementById('wplacePixelInfo').textContent = `(${wplaceCoords.pixelX}, ${wplaceCoords.pixelY})`;
    } else {
        document.getElementById('wplaceTileInfo').textContent = 'Out of bounds';
        document.getElementById('wplacePixelInfo').textContent = 'Out of bounds';
    }
}


function updateStatus(message) {
    document.getElementById('loadStatus').textContent = message;
    console.log(`Status: ${message}`);
}