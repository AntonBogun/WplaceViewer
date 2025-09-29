// Initialize the map
let map;
let currentBaseLayer;
let gridLayer;
let baseLayers = {};
let selectedPixel = null;
let selectionHighlight = null;

let appPath = null;

let overlayState = 'none'; // 'none', 'following'
let overlayImage = null;
let mouseOverlay = null; // DOM element for mouse following

async function getAppPath() {
  if (!appPath) {
    appPath = await window.electronAPI.getAppPath();
  }
  return appPath;
}
async function loadMapConfig() {
  try {
    const appPath = await getAppPath();
    const configPath = window.electronAPI.join(appPath, 'map_api.json');
    const data = await window.electronAPI.readFile(configPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.log('No map_api.json found, using default free tiles');
    return null;
  }
}

// Initialize immediately when the script loads
let appPathInitialized = false;
(async () => {
  if (typeof window !== 'undefined' && window.electronAPI) {
    await getAppPath();
    appPathInitialized = true;
    console.log('App path initialized:', appPath);
  }
})();

// wplace coordinate conversion constants
const mapSize = 2048000; // Total pixels in Web Mercator at max zoom (2048 tiles * 1000 pixels each)
const tileSize = 1000; // Each wplace tile is 1000x1000 pixels
const WORLD_MIN = { x: -180, y: -85.05112878 }; // Web Mercator bounds
const WORLD_MAX = { x: 180, y: 85.05112878 };
let wplaceTileLayer;
let loadedTiles = new Map(); // Cache for loaded tile images
const MIN_PIXEL_SIZE = 1/4; // Minimum pixel size in screen pixels before we hide tiles


let downloadQueue = [];
//normalized tile keys
let downloadingTiles = new Set();
//normalized tile keys
let downloadedTiles = new Set();
let currentDownloadQueueID = 0;
function stepDownloadQueueID() {
    currentDownloadQueueID=(currentDownloadQueueID+1)%1000000;
    return currentDownloadQueueID;
}


let tileTimestamps = new Map(); // Track when tiles were downloaded
let autoRefreshEnabled = true; // Whether to auto-redownload old tiles
const TILE_REFRESH_HOURS = 1; // Hours before considering a tile stale

let emptyTiles = new Set();
let lastDownloadTime = 0;
// const DOWNLOAD_RATE_LIMIT = 200; // milliseconds between downloads


// const MAX_CONCURRENT_DOWNLOADS = 3;
let activeDownloads = 0;
//expects unnormalized tilekey
let tileStatusOverlays = new Map(); // For showing download status
let getTilesPerSecond = () => 1.8;


let downloadsPaused = false; // Whether to pause automatic downloading

let favoritePixels = new Map(); // Store favorite pixels: key -> {tileX, tileY, pixelX, pixelY, name, timestamp}
let favoriteMarkers = new Map(); // Visual markers for favorites
let favoriteLayer; // Layer group for favorite markers
let favoritesVisible = true; // Whether favorites are currently shown


let cropPreviewLayer;
let cropPreviewVisible = false;

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
    try {
        const filePath = window.electronAPI.join(appPath, 'downloaded_tiles.json');
        const data = await window.electronAPI.readFile(filePath, 'utf8');
        const parsed = JSON.parse(data);
        
        // Handle both old format (array) and new format (object)
        if (Array.isArray(parsed)) {
            downloadedTiles = new Set(parsed);
            emptyTiles = new Set();
            tileTimestamps = new Map(); // No timestamps for old data
            window.downloadedTiles = downloadedTiles;
            window.emptyTiles = emptyTiles;
            window.tileTimestamps = tileTimestamps;
        } else {
            downloadedTiles = new Set(parsed.downloaded || []);
            emptyTiles = new Set(parsed.empty || []);
            tileTimestamps = new Map(Object.entries(parsed.timestamps || {}));
            window.downloadedTiles = downloadedTiles;
            window.emptyTiles = emptyTiles;
            window.tileTimestamps = tileTimestamps;
            
            // Handle migration of favorites from old format
            if (parsed.favorites && Object.keys(parsed.favorites).length > 0) {
                console.log('Migrating favorites from old format to separate file...');
                favoritePixels = new Map(Object.entries(parsed.favorites));
                window.favoritePixels = favoritePixels;
                
                // Save favorites to separate file
                await saveFavorites();
                
                // Remove favorites from the tiles file and resave without them
                const cleanedData = {
                    downloaded: Array.from(downloadedTiles),
                    empty: Array.from(emptyTiles),
                    timestamps: Object.fromEntries(tileTimestamps)
                    // Note: no favorites property
                };
                await window.electronAPI.writeFile(filePath, JSON.stringify(cleanedData, null, 2));
                
                updateStatus(`Migrated ${favoritePixels.size} favorites to separate file`);
            }
        }
        
        // Load favorites from separate file (will create empty if migration didn't happen)
        await loadFavorites();
        
        updateStatus(`Loaded ${downloadedTiles.size} downloaded tiles (${emptyTiles.size} empty) and ${favoritePixels.size} favorites`);
    } catch (error) {
        console.log('No existing downloaded tiles cache found');
        downloadedTiles = new Set();
        emptyTiles = new Set();
        tileTimestamps = new Map();
        window.downloadedTiles = downloadedTiles;
        window.emptyTiles = emptyTiles;
        window.tileTimestamps = tileTimestamps;
        
        // Still try to load favorites
        await loadFavorites();
    }
}
async function saveDownloadedTilesList() {
    try {
        // Save tiles data without favorites
        const data = {
            downloaded: Array.from(downloadedTiles),
            empty: Array.from(emptyTiles),
            timestamps: Object.fromEntries(tileTimestamps)
            // Note: no favorites property anymore
        };
        
        const filePath = window.electronAPI.join(appPath, 'downloaded_tiles.json');
        await window.electronAPI.writeFile(filePath, JSON.stringify(data, null, 2));
        
        // Save favorites separately
        await saveFavorites();
    } catch (error) {
        console.error('Failed to save downloaded tiles list:', error);
    }
}
async function loadFavorites() {
    try {
        const filePath = window.electronAPI.join(appPath, 'favorites.json');
        const data = await window.electronAPI.readFile(filePath, 'utf8');
        const parsed = JSON.parse(data);
        favoritePixels = new Map(Object.entries(parsed));
        window.favoritePixels = favoritePixels;
        console.log(`Loaded ${favoritePixels.size} favorites from separate file`);
    } catch (error) {
        console.log('No existing favorites file found');
        favoritePixels = new Map();
        window.favoritePixels = favoritePixels;
    }
}

async function saveFavorites() {
    try {
        const data = Object.fromEntries(favoritePixels);
        const filePath = window.electronAPI.join(appPath, 'favorites.json');
        await window.electronAPI.writeFile(filePath, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Failed to save favorites:', error);
    }
}
async function getLastLocation(){
    try {
        const filePath = window.electronAPI.join(appPath, 'last_location.json');
        const data = await window.electronAPI.readFile(filePath, 'utf8');
        const location = JSON.parse(data);
        console.log('Loaded last location:', location);
        return location;
    } catch (error) {
        console.log('No last location file found');
        return null;
    }
}
async function loadLastLocation() {
    try {
        const filePath = window.electronAPI.join(appPath, 'last_location.json');
        const data = await window.electronAPI.readFile(filePath, 'utf8');
        const location = JSON.parse(data);
        
        // Validate the location data
        if (location.lat && location.lng && location.zoom) {
            console.log(`Loading last location: ${location.lat}, ${location.lng} at zoom ${location.zoom}`);
            map.setView([location.lat, location.lng], location.zoom);
            updateStatus(`Restored last location: ${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}`);
            return true;
        }
    } catch (error) {
        console.log('No last location file found or invalid data');
    }
    return false;
}

async function saveLastLocation() {
    try {
        const center = map.getCenter();
        const zoom = map.getZoom();
        
        const location = {
            lat: center.lat,
            lng: center.lng,
            zoom: zoom,
            timestamp: Date.now()
        };
        
        const filePath = window.electronAPI.join(appPath, 'last_location.json');
        await window.electronAPI.writeFile(filePath, JSON.stringify(location, null, 2));
    } catch (error) {
        console.error('Failed to save last location:', error);
    }
}
// Throttle location saving to avoid excessive file writes
let saveLocationTimeout;
function throttledSaveLocation() {
    if (saveLocationTimeout) {
        clearTimeout(saveLocationTimeout);
    }
    saveLocationTimeout = setTimeout(saveLastLocation, 1000); // Save 1 second after last movement
}
async function updateVisibleTiles() {
    const pixelSize = calculatePixelSizeOnScreen();
    if (pixelSize < MIN_PIXEL_SIZE) {
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
    
    // Load visible downloaded tiles (including wrapped)
    for (let tileX = visibleTiles.startX; tileX <= visibleTiles.endX; tileX++) {
        for (let tileY = visibleTiles.startY; tileY <= visibleTiles.endY; tileY++) {
            if (tileY >= 0 && tileY < 2048) {
                const tileKey = `${tileX}-${tileY}`;
                currentlyVisible.add(tileKey);
                
                const normalizedTileX = normalizeWplaceTileX(tileX);
                const normalizedTileKey = `${normalizedTileX}-${tileY}`;
                
                // Only load if downloaded and not already loaded
                if (downloadedTiles.has(normalizedTileKey) && 
                    !loadedTiles.has(tileKey) && 
                    !emptyTiles.has(normalizedTileKey)) {
                    await loadWplaceTile(tileX, tileY, false);
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
    
    tilesToRemove.forEach(tileKey => {
        loadedTiles.delete(tileKey);
    });
    
    updateStatus(`Showing ${loadedTiles.size} tiles, ${tilesToRemove.length} removed`);
}


function createFavoriteKey(tileX, tileY, pixelX, pixelY) {
    return `${tileX}-${tileY}-${pixelX}-${pixelY}`;
}
function createFavoriteLayer() {
    favoriteLayer = L.layerGroup();
    favoriteLayer.addTo(map);
    window.favoriteLayer = favoriteLayer;
}
function createWplaceTileLayer() {
    wplaceTileLayer = L.layerGroup();
    window.wplaceTileLayer = wplaceTileLayer;
    wplaceTileLayer.addTo(map);
}
function createGridLayer() {
    gridLayer = L.layerGroup();
    window.gridLayer = gridLayer;
    gridLayer.addTo(map);//!is this even needed?
}
function createCropPreviewLayer() {
    cropPreviewLayer = L.layerGroup();
    window.cropPreviewLayer = cropPreviewLayer;
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
    // saveDownloadedTilesList();
    saveFavorites();
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
        
        // saveDownloadedTilesList();
        saveFavorites();
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
    
    if (favoriteMarkers.has(key)) {
        // favoriteLayer.removeLayer(favoriteMarkers.get(key));
        return; // Already created
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
    let was_empty = favoriteMarkers.size === 0;
    favoritePixels.forEach(favorite => {
        createFavoriteMarker(favorite);
    });
    if (was_empty && favoriteMarkers.size > 0) {
        console.log(`Loaded ${favoriteMarkers.size} favorites`);
        updateStatus(`Loaded ${favoriteMarkers.size} favorites`);
    }
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
    // Handle both normalized and original tile keys
    const normalizedKey = tileKey.includes('-') ? 
        `${normalizeWplaceTileX(parseInt(tileKey.split('-')[0]))}-${tileKey.split('-')[1]}` : 
        tileKey;
    
    const timestamp = tileTimestamps.get(normalizedKey);
    if (!timestamp) return false;
    
    const now = Date.now();
    const ageHours = (now - timestamp) / (1000 * 60 * 60);
    return ageHours > TILE_REFRESH_HOURS;
}

// Create distributed directory structure
function getTileFilePath(tileX, tileY) {
    // Distribute tiles across subdirectories to avoid filesystem slowdown
    const subDir1 = Math.floor(tileX / 64);
    const subDir2 = Math.floor(tileY / 64);
    return window.electronAPI.join(appPath, 'tiles', `${subDir1}`, `${subDir2}`, `${tileX}_${tileY}.png`);
}

async function ensureDirectoryExists(filePath) {
    const dir = window.electronAPI.dirname(filePath);
    try {
        await window.electronAPI.mkdir(dir, { recursive: true });
    } catch (error) {
        // Directory might already exist
    }
}

function calculateTileDistance(tileX, tileY, centerTileX, centerTileY) {
    //order
    let minX=Math.min(tileX,centerTileX);
    let maxX=Math.max(tileX,centerTileX);
    let minY=Math.min(tileY,centerTileY);
    let maxY=Math.max(tileY,centerTileY);
    if(minX+2048 - maxX < maxX - minX) {
        const tmp=minX;
        minX=maxX;
        maxX=tmp+2048;
    }
    return Math.sqrt(Math.pow(maxX - minX, 2) + Math.pow(maxY - minY, 2));
}

function prioritizeTiles(visibleTiles) {
    const bounds = map.getBounds();
    const center = map.getCenter();
    const centerWplace = latLngToWplace(center.lat, center.lng);
    
    if (!centerWplace) return [];
    
    const tiles = [];
    for (let tileX = visibleTiles.startX; tileX <= visibleTiles.endX; tileX++) {
        for (let tileY = visibleTiles.startY; tileY <= visibleTiles.endY; tileY++) {
            if (tileY >= 0 && tileY < 2048) {
                const distance = calculateTileDistance(tileX, tileY, centerWplace.tileX, centerWplace.tileY);
                tiles.push({ tileX, tileY, distance });
            }
        }
    }
    
    // Sort by distance from center
    tiles.sort((a, b) => a.distance - b.distance);
    return tiles;
}

function initDownloadTile(tileX,tileY){
    const normalizedTileX = normalizeWplaceTileX(tileX);
    const normalizedTileY = tileY;

    // const tileKey = `${tileX}-${tileY}`;
    // Skip if out of Y bounds
    if (normalizedTileY < 0 || normalizedTileY >= 2048) {
        return false;
    }
    
    const tileKey = `${normalizedTileX}-${normalizedTileY}`;
    
    if (( (!isTileStale(tileKey) || !autoRefreshEnabled) && downloadedTiles.has(tileKey))
         || downloadingTiles.has(tileKey)) {
        return false;
    }
    if(isTileStale(tileKey) && autoRefreshEnabled){
        console.log(`Tile ${tileX},${tileY} is stale, re-downloading`);
    }
    downloadingTiles.add(tileKey);
    activeDownloads++;
    // Show downloading status, unnormalized
    showTileStatus(tileX, tileY, 'downloading');
    return true;
}

async function downloadTile(tileX, tileY) {
    const normalizedTileX = normalizeWplaceTileX(tileX);
    const normalizedTileY = tileY;

    // const tileKey = `${tileX}-${tileY}`;
    // Skip if out of Y bounds
    if (normalizedTileY < 0 || normalizedTileY >= 2048) {
        return;
    }
    const unnormalized_tileKey = `${tileX}-${tileY}`;
    const tileKey = `${normalizedTileX}-${normalizedTileY}`;
    try {
        const url = `https://backend.wplace.live/files/s0/tiles/${normalizedTileX}/${normalizedTileY}.png`;
        const response = await fetch(url);
        
        if (response.status === 404) {
            // Tile is empty, mark as downloaded but don't save file
            downloadedTiles.add(tileKey);
            tileTimestamps.set(tileKey, Date.now());
            emptyTiles.add(tileKey);
            downloadingTiles.delete(tileKey);
            activeDownloads--;
            
            // Remove status overlay (no visual indication needed for empty tiles)
            const statusOverlay = tileStatusOverlays.get(unnormalized_tileKey);
            if (statusOverlay) {
                map.removeLayer(statusOverlay);
                tileStatusOverlays.delete(unnormalized_tileKey);
            }
            
            updateStatus(`Tile ${tileX},${tileY} is empty (404) - marked as complete`);
            return true;
        }
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const blob = await response.blob();
        
        // Save to file system
        const filePath = getTileFilePath(tileX, tileY);
        await ensureDirectoryExists(filePath);
        
        const buffer = await blob.arrayBuffer();
        await window.electronAPI.writeFile(filePath, window.electronAPI.bufferFrom(buffer));

        
        // Mark as downloaded
        downloadedTiles.add(tileKey);
        tileTimestamps.set(tileKey, Date.now());
        downloadingTiles.delete(tileKey);
        activeDownloads--;
        
        // Update status display
        showTileStatus(tileX, tileY, 'downloaded');
        
        // Load the tile into the map only if currently visible
        const viewInfo = getWplaceViewInfo();
        if (viewInfo.visibleTiles && 
            tileX >= viewInfo.visibleTiles.startX && tileX <= viewInfo.visibleTiles.endX &&
            tileY >= viewInfo.visibleTiles.startY && tileY <= viewInfo.visibleTiles.endY) {
            //force a reload if exists
            await loadWplaceTile(tileX, tileY,true);
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
//expects unnormalized
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
        tileStatusOverlays.forEach(overlay => map.removeLayer(overlay));
        tileStatusOverlays.clear();
        return;
    }
    
    const viewInfo = getWplaceViewInfo();
    if (!viewInfo.visibleTiles) return;
    
    const visibleTiles = viewInfo.visibleTiles;
    
    // Show status for all visible tiles (including wrapped)
    for (let tileX = visibleTiles.startX; tileX <= visibleTiles.endX; tileX++) {
        for (let tileY = visibleTiles.startY; tileY <= visibleTiles.endY; tileY++) {
            if (tileY < 0 || tileY >= 2048) continue;
            
            const normalizedTileX = normalizeWplaceTileX(tileX);
            const normalizedTileKey = `${normalizedTileX}-${tileY}`;
            
            if (downloadingTiles.has(normalizedTileKey)) {
                showTileStatus(tileX, tileY, 'downloading'); // Use original coords for display
            } else if (!downloadedTiles.has(normalizedTileKey)) {
                showTileStatus(tileX, tileY, 'needed');
            }
        }
    }
}

async function processDownloadQueue(queueID) {
    if (queueID !== currentDownloadQueueID) {
        return; // Outdated queue processing
    }
    if(downloadsPaused){
        return;
    }
    if (downloadQueue.length === 0) {
        return;
    }
    //unnormalized
    const tile = downloadQueue.shift();
    if (tile) {
        //unnormalized
        if (initDownloadTile(tile.tileX, tile.tileY)) {
            //send it off
            downloadTile(tile.tileX, tile.tileY);
        }

        // Continue processing queue
        setTimeout(() => processDownloadQueue(queueID), 1000 / Math.min(getTilesPerSecond(), 10));
    }
}

function queueTileDownloads() {
    if (downloadsPaused) {
        return;
    }
    const new_id = stepDownloadQueueID();

    const pixelSize = calculatePixelSizeOnScreen();
    if (pixelSize < MIN_PIXEL_SIZE) {
        downloadQueue = [];
        return;
    }
    
    const viewInfo = getWplaceViewInfo();
    if (!viewInfo.visibleTiles) return;
    
    const visibleTiles = viewInfo.visibleTiles;
    
    // Get current view center for distance calculation - use ACTUAL coordinates
    const center = map.getCenter();
    const centerWplace = latLngToWplace(center.lat, center.lng);
    if (!centerWplace){
        console.warn("Center out of bounds, skipping tile queuing");
        return;
    }
    
    // Use the actual tile coordinates for distance, not normalized
    const centerTileX = centerWplace.tileX;
    const centerTileY = centerWplace.tileY;
    
    // Collect tiles to download
    const tilesToQueue = [];
    
    for (let tileX = visibleTiles.startX; tileX <= visibleTiles.endX; tileX++) {
        for (let tileY = visibleTiles.startY; tileY <= visibleTiles.endY; tileY++) {
            // Skip out of vertical bounds
            if (tileY < 0 || tileY >= 2048) continue;
            
            // Normalize tile coordinates for download checking
            const normalizedTileX = normalizeWplaceTileX(tileX);
            const normalizedTileY = tileY;
            const normalizedTileKey = `${normalizedTileX}-${normalizedTileY}`;
            
            // Check if we need to download this tile
            if ((!downloadedTiles.has(normalizedTileKey)
                ||(isTileStale(normalizedTileKey) && autoRefreshEnabled)
                ) && !downloadingTiles.has(normalizedTileKey)) {
                // Use VISUAL coordinates for distance calculation
                const distance = calculateTileDistance(tileX, tileY, centerTileX, centerTileY);
                tilesToQueue.push({ 
                    tileX: tileX,
                    tileY: tileY,
                    distance // But distance is based on visual position
                });
            }
        }
    }
    
    downloadQueue = tilesToQueue;
    // Sort by distance from center
    downloadQueue.sort((a, b) => a.distance - b.distance);
    
    processDownloadQueue(new_id);
}


async function loadWplaceTile(tileX, tileY, force=false) {
    const tileKey = `${tileX}-${tileY}`;
    
    // Check if already loaded
    if (loadedTiles.has(tileKey) && !force) {
        return loadedTiles.get(tileKey);
    }else if(loadedTiles.has(tileKey) && force){
        //remove old one
        wplaceTileLayer.removeLayer(loadedTiles.get(tileKey));
        loadedTiles.delete(tileKey);
        await new Promise(r => setTimeout(r, 100)); //small delay to ensure removal
        if(loadedTiles.has(tileKey)){
            console.warn(`Tile ${tileKey} still in loadedTiles after removal, skipping reload`);
            return loadedTiles.get(tileKey);
        }
    }
    
    // Normalize coordinates for file access
    const normalizedTileX = normalizeWplaceTileX(tileX);
    const normalizedTileY = tileY;
    
    // Skip if out of Y bounds
    if (normalizedTileY < 0 || normalizedTileY >= 2048) {
        return null;
    }
    
    const normalizedTileKey = `${normalizedTileX}-${normalizedTileY}`;
    
    // Skip if we know this tile is empty
    if (emptyTiles && emptyTiles.has(normalizedTileKey)) {
        return null;
    }
    
    // Skip if not downloaded yet
    if (!downloadedTiles.has(normalizedTileKey)) {
        return null;
    }
    
    // Calculate tile bounds using original (non-normalized) coordinates
    const [topLat, leftLng] = wplaceToLatLng(tileX, tileY, 0, 0);
    const [bottomLat, rightLng] = wplaceToLatLng(tileX + 1, tileY + 1, 0, 0);
    
    // Use normalized coordinates for file path
    const tilePath = getTileFilePath(normalizedTileX, normalizedTileY);
    const timeNow = Date.now();
    const fileUrl = `file://${tilePath}?t=${timeNow}`; // Cache-busting query param
    
    const imageOverlay = L.imageOverlay(fileUrl, [
        [bottomLat, leftLng],
        [topLat, rightLng]
    ], {
        opacity: 1.0,
        interactive: false,
        crossOrigin: 'anonymous'
    });
    
    imageOverlay.on('error', function() {
        console.error(`Failed to load tile ${normalizedTileX},${normalizedTileY} from file`);
        loadedTiles.delete(normalizedTileKey);
    });
    
    // Store and add to layer
    loadedTiles.set(tileKey, imageOverlay);
    wplaceTileLayer.addLayer(imageOverlay);
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

    if (!topLeft || !bottomRight) {
        if(!topLeft){
            console.warn("Top-left corner out of bounds");
        }
        if(!bottomRight){
            console.warn("Bottom-right corner out of bounds");
        }

        return { visibleTiles: null };
    }
    return {
        topLeft: topLeft,
        bottomRight: bottomRight,
        visibleTiles: {
            startX: topLeft.tileX,
            endX: bottomRight.tileX,
            startY: topLeft.tileY,
            endY: bottomRight.tileY
        }
    };
}

// Initialize map when page loads
document.addEventListener('DOMContentLoaded', async function() {
    if(!isElectron()) {
        console.error("This application is intended to run in Electron.");
        alert("This application is intended to run in Electron.");
        return;
    }
    if(!appPathInitialized) {
        await getAppPath();
    }
    const lastLocation = await getLastLocation();
    await initializeMap(lastLocation);
    setupControls();
    setupEventListeners();
});






function latLonToPixel(lat, lon) {
    // Clamp latitude to Web Mercator bounds
    lat = Math.max(-85.05112878, Math.min(85.05112878, lat));
    
    // Convert to radians
    const latRad = lat * Math.PI / 180;
    const lonRad = lon * Math.PI / 180;
    
    // X coordinate (longitude is linear)
    const x = (lonRad + Math.PI) / (2 * Math.PI) * mapSize;
    
    // Y coordinate (latitude uses Mercator projection)
    // Add bounds checking to prevent NaN/Infinity
    const mercatorY = Math.log(Math.tan(latRad) + 1/Math.cos(latRad));
    if (!isFinite(mercatorY)) {
        return [x, lat > 0 ? 0 : mapSize]; // Return edge values for extreme cases
    }
    
    const y = (1 - (mercatorY / Math.PI)) / 2 * mapSize;

    return [x, y];
}
function latLngToWplace(lat, lng) {
    //clamp y to reasonable coords
    const latClamped = Math.max(-85.05111026927486, Math.min(85.05111026927486, lat));
    const [x, y] = latLonToPixel(latClamped, lng);
    
    // Only reject if clearly out of bounds
    if (!isFinite(x) || !isFinite(y)) {
        return null;
    }
    // Allow slight overshoot for edge cases
    if (y < -5 || y > mapSize + 5) {
        return null; 
    }
    
    const tileX = Math.floor(x / tileSize);
    const tileY = Math.floor(y / tileSize);
    const pixelX = Math.floor(x % tileSize);
    const pixelY = Math.floor(y % tileSize);
    
    // Ensure tile coordinates are valid
    if (tileY < 0 || tileY >= 2048) {
        return null;
    }
    
    return { tileX, tileY, pixelX, pixelY };
}
function normalizeWplaceTileX(tileX) {
    // Wrap tile X coordinate to 0-2047 range
    return ((tileX % 2048) + 2048) % 2048;
}


function pixelToLatLon(x, y) {
    // Convert pixel to normalized coordinates (0-1)
    const xNorm = x / mapSize;
    const yNorm = y / mapSize;
    
    // Longitude (linear conversion) - DON'T clamp
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

function updateGrid() {
    if (gridLayer && map.hasLayer(gridLayer)) {
        addGridToCurrentView();
    }
}
async function initializeMap(lastLocation) {
    const mapConfig = await loadMapConfig();
    // Create map centered on world view
    
    map = L.map('map', {
        // center: [0, 0],
        // zoom: 2,
        center: lastLocation ? [lastLocation.lat, lastLocation.lng] : [0, 0],
        zoom: lastLocation ? lastLocation.zoom : 2,
        zoomControl: false, // We'll add custom controls
        attributionControl: true,
        worldCopyJump: true, // Seamless horizontal panning
        maxBoundsViscosity: 1.0 // Keep this for vertical bounds
    });
    const verticalBounds = L.latLngBounds(
        [-85.05112878, -540], // Allow extra longitude range for wrapping
        [85.05112878, 540]
    );
    map.setMaxBounds(verticalBounds);
    map.setMinZoom(3);  // Can't zoom out too far
    map.setMaxZoom(25); // Can zoom in very close
    //add to window
    window.map = map;
    // Add zoom control in bottom right
    L.control.zoom({
        position: 'bottomright'
    }).addTo(map);

    // Define base layers
    if (mapConfig && mapConfig.apiKey) {
        console.log(`Using ${mapConfig.provider} tiles with API key`);
        baseLayers = {
            osm: L.tileLayer(mapConfig.tileUrls.osm.replace('{apiKey}', mapConfig.apiKey), {
                attribution: `© ${mapConfig.provider}, © OpenStreetMap contributors`,
                maxZoom: 19,
                noWrap: false,
                tileSize: 512,        // Set to actual tile size
                zoomOffset: -1        // Correct the coordinate system
            }),
            satellite: L.tileLayer(mapConfig.tileUrls.satellite.replace('{apiKey}', mapConfig.apiKey), {
                attribution: `© ${mapConfig.provider}`,
                maxZoom: 18,
                noWrap: false,
                tileSize: 512,
                zoomOffset: -1
            }),
            topo: L.tileLayer(mapConfig.tileUrls.topo.replace('{apiKey}', mapConfig.apiKey), {
                attribution: `© ${mapConfig.provider}, © OpenStreetMap contributors`,
                maxZoom: 17,
                noWrap: false,
                tileSize: 512,
                zoomOffset: -1
            }),
            dark: L.tileLayer(mapConfig.tileUrls.dark.replace('{apiKey}', mapConfig.apiKey), {
                attribution: `© ${mapConfig.provider}, © OpenStreetMap contributors`,
                maxZoom: 19,
                noWrap: false,
                tileSize: 512,
                zoomOffset: -1
            })
        };
    } else {
        // Fallback to free tiles
        baseLayers = {
            osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap contributors',
                maxZoom: 19,
                noWrap: false
            }),
            satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
                attribution: '© Esri, Maxar, Earthstar Geographics',
                maxZoom: 18,
                noWrap: false
            }),
            topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenTopoMap contributors',
                maxZoom: 17,
                noWrap: false
            }),
            dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
                attribution: '© CARTO, © OpenStreetMap contributors',
                maxZoom: 19,
                noWrap: false
            })
        };
    }

    // Set initial base layer
    currentBaseLayer = baseLayers.osm;
    currentBaseLayer.addTo(map);

    // Create a grid overlay for tile boundaries (useful for debugging)
    createGridLayer();
    // setupMapLimits();
    createWplaceTileLayer();
    createFavoriteLayer();
    createCropPreviewLayer();
    // loadLastLocation();
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


function parseNavigationInput(input) {
    //destroy everything before first questionmark
    const questionMarkIndex = input.indexOf('?');
    if (questionMarkIndex !== -1) {
        input = input.substring(questionMarkIndex + 1);
    }
    
    // Filter to keep only digits, minus, commas, ampersands, and dots
    const filtered = input.replace(/[^0-9.,&-]/g, '');
    
    if (!filtered) {
        throw new Error('No valid characters found');
    }
    
    // Try splitting by comma first, then by ampersand
    let parts;
    let isLatLng = false;
    
    if (filtered.includes(',')) {
        parts = filtered.split(',').map(s => s.trim()).filter(s => s.length > 0);
        isLatLng = false;
    } else if (filtered.includes('&')) {
        parts = filtered.split('&').map(s => s.trim()).filter(s => s.length > 0);
        isLatLng = true;
    } else {
        throw new Error('Input must contain either commas (,) or ampersands (&)');
    }
    
    // Validate number of parts
    if (isLatLng) {
        if (parts.length < 2 || parts.length > 3) {
            throw new Error('Lat/lng input must have 2 or 3 numbers (lat&lng or lat&lng&zoom)');
        }
    } else {
        if (parts.length !== 2 && parts.length !== 4) {
            throw new Error('Tile input must have 2 or 4 numbers (tileX,tileY or tileX,tileY,pixelX,pixelY)');
        }
    }
    
    // Parse and validate all numbers
    const numbers = parts.map(part => {
        const num = parseFloat(part);
        if (isNaN(num)) {
            throw new Error(`Invalid number: "${part}"`);
        }
        return num;
    });
    
    return { numbers, isLatLng };
}

function validateAndNavigate(numbers, isLatLng) {
    if (isLatLng) {
        // Lat/lng input
        const lat = numbers[0];
        const lng = numbers[1];
        const zoom = numbers[2] || map.getZoom(); // Use current zoom if not specified
        
        // Validate latitude and longitude ranges
        if (lat < -85.05112878 || lat > 85.05112878) {
            throw new Error(`Latitude ${lat} out of range (-85.05 to 85.05)`);
        }
        if (lng < -180 || lng > 180) {
            throw new Error(`Longitude ${lng} out of range (-180 to 180)`);
        }
        if (zoom < 3 || zoom > 26) {
            throw new Error(`Zoom ${zoom} out of range (3 to 26)`);
        }
        
        // Navigate to lat/lng
        map.setView([lat, lng], zoom);
        updateStatus(`Navigated to ${lat.toFixed(6)}, ${lng.toFixed(6)} at zoom ${zoom}`);
        
    } else {
        // Tile input
        let tileX, tileY, pixelX = 0, pixelY = 0;
        
        if (numbers.length === 2) {
            [tileX, tileY] = numbers;
        } else {
            [tileX, tileY, pixelX, pixelY] = numbers;
        }
        
        // Validate tile coordinates
        if (tileX < 0 || tileX >= 2048) {
            throw new Error(`Tile X ${tileX} out of range (0 to 2047)`);
        }
        if (tileY < 0 || tileY >= 2048) {
            throw new Error(`Tile Y ${tileY} out of range (0 to 2047)`);
        }
        if (pixelX < 0 || pixelX >= 1000) {
            throw new Error(`Pixel X ${pixelX} out of range (0 to 999)`);
        }
        if (pixelY < 0 || pixelY >= 1000) {
            throw new Error(`Pixel Y ${pixelY} out of range (0 to 999)`);
        }
        
        // Convert to lat/lng and navigate
        const [lat, lng] = wplaceToLatLng(tileX, tileY, pixelX, pixelY);
        map.setView([lat, lng], 15); // Use zoom 15 for tile navigation
        
        // Select the pixel if pixel coordinates were provided
        if (numbers.length === 4) {
            selectPixel({ tileX, tileY, pixelX, pixelY }, { lat, lng });
        }
        
        updateStatus(`Navigated to tile(${tileX},${tileY}) pixel(${pixelX},${pixelY})`);
    }
}

function handleNavigation() {
    const input = document.getElementById('navigationInput').value.trim();
    
    if (!input) {
        updateStatus('Please enter coordinates to navigate');
        return;
    }
    
    try {
        const { numbers, isLatLng } = parseNavigationInput(input);
        validateAndNavigate(numbers, isLatLng);
        
        // Clear the input after successful navigation
        document.getElementById('navigationInput').value = '';
        
    } catch (error) {
        updateStatus(`Navigation error: ${error.message}`);
        console.error('Navigation error:', error);
    }
}


function setupControls() {

    const tilesPerSecondSlider = document.getElementById('tilesPerSecondSlider');
    const tilesPerSecondInput = document.getElementById('tilesPerSecondInput');
    tilesPerSecondSlider.addEventListener('input', () => {
        tilesPerSecondInput.value = tilesPerSecondSlider.value;
        if(downloadQueue.length > 0){
            queueTileDownloads();
        }
    });
    tilesPerSecondInput.addEventListener('input', () => {
        let val = parseFloat(tilesPerSecondInput.value);
        if (isNaN(val) || val < 0.1) val = 0.1;
        if (val > 10) val = 10;
        tilesPerSecondInput.value = val;
        tilesPerSecondSlider.value = val;
        if(downloadQueue.length > 0){
            queueTileDownloads();
        }
    });
    
    // Expose getter for app.js
    getTilesPerSecond = function() {
        return parseFloat(tilesPerSecondInput.value);
    };

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
    const toggleImageBtn = document.getElementById('toggleImage');

    // Toggle image layer
    let imageVisible = true;
    toggleImageBtn.addEventListener('click', function() {
        if (imageVisible) {
            map.removeLayer(wplaceTileLayer);
            imageVisible = false;
            this.textContent = 'Show Tiles';
        } else {
            map.addLayer(wplaceTileLayer);
            imageVisible = true;
            this.textContent = 'Hide Tiles';
        }
    });
    

    // Auto-refresh toggle
    const toggleAutoRefreshBtn = document.getElementById('toggleAutoRefresh');
    toggleAutoRefreshBtn.addEventListener('click', function() {
        autoRefreshEnabled = !autoRefreshEnabled;
        this.textContent = `Auto-Refresh: ${autoRefreshEnabled ? 'ON' : 'OFF'}`;
        updateStatus(`Auto-refresh ${autoRefreshEnabled ? 'enabled' : 'disabled'}`);

        queueTileDownloads(); // Re-queue stale tiles or delete old queue
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

    const toggleMenuBtn = document.getElementById('toggleMenuBtn');
    const controlsMenu = document.querySelector('.controls');
    const infoPanel = document.querySelector('.info-panel');
    let menuVisible = true;

    // Export selected tile
    const showSelectedTileBtn = document.getElementById('showSelectedTile');
    showSelectedTileBtn.addEventListener('click', async function() {
        if (!selectedPixel) {
            updateStatus('No pixel selected. Click on the map to select a tile first.');
            return;
        }
        if(!downloadedTiles.has(`${normalizeWplaceTileX(selectedPixel.tileX)}-${selectedPixel.tileY}`)){
            updateStatus('Selected tile is not downloaded yet. Please download it first.');
            return;
        }
        openTileLocation(selectedPixel.tileX, selectedPixel.tileY);
    });

    // Export crop area
    const exportCropBtn = document.getElementById('exportCropArea');
    exportCropBtn.addEventListener('click', async function() {
        const startTileX = parseInt(document.getElementById('cropStartTileX').value);
        const startTileY = parseInt(document.getElementById('cropStartTileY').value);
        const startPixelX = parseInt(document.getElementById('cropStartPixelX').value);
        const startPixelY = parseInt(document.getElementById('cropStartPixelY').value);
        const endTileX = parseInt(document.getElementById('cropEndTileX').value);
        const endTileY = parseInt(document.getElementById('cropEndTileY').value);
        const endPixelX = parseInt(document.getElementById('cropEndPixelX').value);
        const endPixelY = parseInt(document.getElementById('cropEndPixelY').value);
        
        // Validate inputs
        if (isNaN(startTileX) || isNaN(startTileY) || isNaN(startPixelX) || isNaN(startPixelY) ||
            isNaN(endTileX) || isNaN(endTileY) || isNaN(endPixelX) || isNaN(endPixelY)) {
            updateStatus('Please fill in all crop coordinates');
            return;
        }
        
        this.disabled = true;
        this.textContent = 'Exporting...';
        
        try {
            const dimensions = validateCropArea(startTileX, startTileY, startPixelX, startPixelY, 
                                            endTileX, endTileY, endPixelX, endPixelY);
            
            updateStatus(`Exporting crop area (${dimensions.width}x${dimensions.height} pixels)...`);
            await exportCanvasCrop(startTileX, startTileY, startPixelX, startPixelY,
                                        endTileX, endTileY, endPixelX, endPixelY);
            updateStatus(`Successfully exported crop area`);
        } catch (error) {
            updateStatus(`Export failed: ${error.message}`);
            console.error('Crop export error:', error);
        } finally {
            this.disabled = false;
            this.textContent = 'Export Crop Area';
        }
    });

    // Toggle crop preview
    const toggleCropPreviewBtn = document.getElementById('toggleCropPreview');
    toggleCropPreviewBtn.addEventListener('click', function() {
        cropPreviewVisible = !cropPreviewVisible;
        
        if (cropPreviewVisible) {
            map.addLayer(cropPreviewLayer);
            this.textContent = 'Hide Crop Preview';
            updateCropPreview();
        } else {
            map.removeLayer(cropPreviewLayer);
            this.textContent = 'Show Crop Preview';
        }
    });

    // Add input listeners for real-time preview updates
    ['cropStartTileX', 'cropStartTileY', 'cropStartPixelX', 'cropStartPixelY',
    'cropEndTileX', 'cropEndTileY', 'cropEndPixelX', 'cropEndPixelY'].forEach(id => {
        document.getElementById(id).addEventListener('input', updateCropPreview);
    });
    [[document.getElementById('setCropFromSelectionTL'),"Start"],
    [document.getElementById('setCropFromSelectionBR'),"End"]]
    .forEach(([btn, pos]) => {
        btn.addEventListener('click', function() {
            if (!selectedPixel) {
                updateStatus('No pixel selected. Click on the map to select a tile first.');
                return;
            }
            if (pos === "Start") {
                document.getElementById('cropStartTileX').value = selectedPixel.tileX;
                document.getElementById('cropStartTileY').value = selectedPixel.tileY;
                document.getElementById('cropStartPixelX').value = selectedPixel.pixelX;
                document.getElementById('cropStartPixelY').value = selectedPixel.pixelY;
            } else {
                document.getElementById('cropEndTileX').value = selectedPixel.tileX;
                document.getElementById('cropEndTileY').value = selectedPixel.tileY;
                document.getElementById('cropEndPixelX').value = selectedPixel.pixelX;
                document.getElementById('cropEndPixelY').value = selectedPixel.pixelY;
            }
            updateCropPreview();
        });
    });


    toggleMenuBtn.addEventListener('click', () => {
        menuVisible = !menuVisible;
        controlsMenu.style.display = menuVisible ? 'block' : 'none';
        infoPanel.style.display = menuVisible ? 'block' : 'none';
        toggleMenuBtn.textContent = menuVisible ? 'Hide Menu' : 'Show Menu';
    });
    // Navigation input and button
    const navigationInput = document.getElementById('navigationInput');
    const navigateBtn = document.getElementById('navigateBtn');

    // Handle navigation button click
    navigateBtn.addEventListener('click', handleNavigation);

    // Handle Enter key in navigation input
    navigationInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleNavigation();
        }
    });

    // Handle Ctrl+V paste and auto-navigate
    navigationInput.addEventListener('keydown', function(e) {
        if (e.ctrlKey && e.key === 'v') {
            // Small delay to let paste complete
            setTimeout(() => {
                handleNavigation();
            }, 10);
        }
    });

    // Image overlay controls
    const imageUpload = document.getElementById('imageUpload');
    const clearOverlayBtn = document.getElementById('clearOverlay');

    imageUpload.addEventListener('change', handleImageUpload);
    clearOverlayBtn.addEventListener('click', clearOverlay);
}

function handleImageUpload(event) {
    console.log('Upload triggered, event:', event);
    const file = event.target.files[0];
    console.log('Selected file:', file);
    if (!file){
        console.log('No file selected');
        return;
    }
    console.log('File details:', file.name, file.size, file.type);
    // Clear any existing overlay first
    clearOverlay();
    
    const reader = new FileReader();
    reader.onload = function(e) {
        processOverlayImage(e.target.result);
    };
    
    reader.readAsDataURL(file);
}

function processOverlayImage(dataUrl) {
    const img = new Image();
    img.onload = function() {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        
        // Draw original image
        ctx.drawImage(img, 0, 0);
        
        // Get image data and create red mask from opaque pixels
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        
        for (let i = 0; i < data.length; i += 4) {
            const alpha = data[i + 3];
            if (alpha > 0) {
                // Make opaque pixels red with semi-transparency
                data[i] = 255;     // Red
                data[i + 1] = 0;   // Green
                data[i + 2] = 0;   // Blue
                data[i + 3] = 128; // Semi-transparent
            }
        }
        
        ctx.putImageData(imageData, 0, 0);
        overlayImage = {
            dataUrl: canvas.toDataURL(),
            width: img.width,
            height: img.height
        };

        overlayState = 'following';
        mouseOverlay = document.getElementById('mouseOverlay');
        mouseOverlay.style.display = 'block';
        mouseOverlay.innerHTML = `<img src="${overlayImage.dataUrl}" style="width: 100%; height: 100%;">`;

        
        updateOverlayScale();
        centerOverlay();
        document.getElementById('clearOverlay').disabled = false;
        updateStatus('Overlay following center of screen');
    };
    img.src = dataUrl;
}

function centerOverlay() {
    if (overlayState !== 'following' || !mouseOverlay) return;
    
    // Get map container dimensions
    const mapRect = map.getContainer().getBoundingClientRect();
    const centerX = mapRect.width / 2;
    const centerY = mapRect.height / 2;
    
    // Center overlay
    const offsetX = parseFloat(mouseOverlay.style.width) / 2;
    const offsetY = parseFloat(mouseOverlay.style.height) / 2;
    
    mouseOverlay.style.left = (centerX - offsetX) + 'px';
    mouseOverlay.style.top = (centerY - offsetY) + 'px';
}

function updateOverlayScale() {
    if (overlayState !== 'following' || !overlayImage) return;
    
    // Scale based on current zoom - adjust multiplier as needed
    const pixelSize = calculatePixelSizeOnScreen();
    const scaleFactor = pixelSize; // Adjust this multiplier to control size
    
    const scaledWidth = overlayImage.width * scaleFactor;
    const scaledHeight = overlayImage.height * scaleFactor;
    
    mouseOverlay.style.width = scaledWidth + 'px';
    mouseOverlay.style.height = scaledHeight + 'px';
}

function updateMouseOverlayPosition(e) {
    if (overlayState !== 'following' || !mouseOverlay) return;
    
    // Get mouse position relative to map container
    const mapRect = map.getContainer().getBoundingClientRect();
    const x = e.clientX - mapRect.left;
    const y = e.clientY - mapRect.top;
    
    // Center overlay on mouse cursor
    const offsetX = parseFloat(mouseOverlay.style.width) / 2;
    const offsetY = parseFloat(mouseOverlay.style.height) / 2;
    
    mouseOverlay.style.left = (x - offsetX) + 'px';
    mouseOverlay.style.top = (y - offsetY) + 'px';
}

function clearOverlay() {
    // Clear mouse following overlay
    if (mouseOverlay) {
        mouseOverlay.style.display = 'none';
    }
    
    // Reset state
    overlayState = 'none';
    overlayImage = null;
    document.getElementById('clearOverlay').disabled = true;
    document.getElementById('imageUpload').value = '';
    updateStatus('Overlay cleared');
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

async function openTileLocation(tileX, tileY) {    
    const normalizedTileX = normalizeWplaceTileX(tileX);
    const normalizedTileY = tileY;
    const normalizedTileKey = `${normalizedTileX}-${normalizedTileY}`;
    
    try {
        if (downloadedTiles.has(normalizedTileKey) && !emptyTiles.has(normalizedTileKey)) {
            // Tile exists, open it
            const filePath = getTileFilePath(normalizedTileX, normalizedTileY);
            await window.electronAPI.openPath(filePath);
            updateStatus(`Opened tile ${tileX},${tileY} in file explorer`);
        } else if (emptyTiles.has(normalizedTileKey)) {
            updateStatus(`Tile ${tileX},${tileY} is empty (no file to open)`);
        } else {
            updateStatus(`Tile ${tileX},${tileY} not downloaded yet`);
        }
    } catch (error) {
        console.error('Failed to open tile location:', error);
        updateStatus(`Failed to open tile location: ${error.message}`);
    }
}


function updateCropPreview() {
    if (!cropPreviewLayer) return;
    
    // Clear existing preview
    cropPreviewLayer.clearLayers();
    
    if (!cropPreviewVisible) return;
    
    // Get crop coordinates
    const startTileX = parseInt(document.getElementById('cropStartTileX').value);
    const startTileY = parseInt(document.getElementById('cropStartTileY').value);
    const startPixelX = parseInt(document.getElementById('cropStartPixelX').value);
    const startPixelY = parseInt(document.getElementById('cropStartPixelY').value);
    const endTileX = parseInt(document.getElementById('cropEndTileX').value);
    const endTileY = parseInt(document.getElementById('cropEndTileY').value);
    const endPixelX = parseInt(document.getElementById('cropEndPixelX').value);
    const endPixelY = parseInt(document.getElementById('cropEndPixelY').value);
    // Validate inputs
    if (isNaN(startTileX) || isNaN(startTileY) || isNaN(startPixelX) || isNaN(startPixelY) ||
    isNaN(endTileX) || isNaN(endTileY) || isNaN(endPixelX) || isNaN(endPixelY)) {
        return;
    }
    //ensure Y is sane
    if (startTileY < 0 || startTileY >= 2048 || endTileY < 0 || endTileY >= 2048) {
        return;
    }
    
    // Convert to lat/lng coordinates
    const [startLat, startLng] = wplaceToLatLng(startTileX, startTileY, startPixelX, startPixelY);
    const [endLat, endLng] = wplaceToLatLng(endTileX, endTileY, endPixelX+1, endPixelY+1);
    
    // Create preview rectangle
    const previewRect = L.rectangle([
        [Math.min(startLat, endLat), Math.min(startLng, endLng)],
        [Math.max(startLat, endLat), Math.max(startLng, endLng)]
    ], {
        color: '#ff6b6b',
        fillColor: '#ff6b6b',
        fillOpacity: 0.2,
        weight: 2,
        opacity: 0.8,
        dashArray: '10, 5'
    });
    
    cropPreviewLayer.addLayer(previewRect);
}

function validateCropArea(startTileX, startTileY, startPixelX, startPixelY, endTileX, endTileY, endPixelX, endPixelY) {
    // Calculate total pixel dimensions
    const startGlobalX = startTileX * 1000 + startPixelX;
    const startGlobalY = startTileY * 1000 + startPixelY;
    const endGlobalX = endTileX * 1000 + endPixelX;
    const endGlobalY = endTileY * 1000 + endPixelY;
    
    const width = Math.abs(endGlobalX - startGlobalX) + 1;
    const height = Math.abs(endGlobalY - startGlobalY) + 1;
    
    if (width > 5000 || height > 5000) {
        throw new Error(`Crop area too large: ${width}x${height} pixels. Maximum allowed: 5000x5000`);
    }
    
    return { width, height };
}

// Configuration
const TILE_SIZE = 1000;
const MAX_TILES = 5; 
const WPLACE_SIZE = 2048;

// Utility functions
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Load a single tile from local storage
async function loadLocalTile(x, y) {
    x=normalizeWplaceTileX(x);

    
    const normalizedTileKey = `${x}-${y}`;
    
    try {
        // Check if tile is downloaded
        if (!downloadedTiles.has(normalizedTileKey)) {
            throw new Error(`Tile (${x}, ${y}) not downloaded`);
        }
        
        // Check if tile is empty
        if (emptyTiles && emptyTiles.has(normalizedTileKey)) {
            console.log(`Tile (${x}, ${y}) is empty, creating transparent canvas`);
            const canvas = document.createElement('canvas');
            canvas.width = TILE_SIZE;
            canvas.height = TILE_SIZE;
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
            return canvas;
        }
        
        // Load from file system
        const tilePath = getTileFilePath(x, y);
        const fileUrl = `file://${tilePath}`;
        
        const img = new Image();
        
        return new Promise((resolve, reject) => {
            img.onload = () => {
                console.log(`Loaded local tile (${x}, ${y}) size: ${img.width}x${img.height}`);
                
                const canvas = document.createElement('canvas');
                canvas.width = TILE_SIZE;
                canvas.height = TILE_SIZE;
                const ctx = canvas.getContext('2d');
                
                // Scale the image to fill the full tile size
                ctx.imageSmoothingEnabled = false; // Preserve pixel art
                ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, TILE_SIZE, TILE_SIZE);
                
                resolve(canvas);
            };
            
            img.onerror = (error) => {
                console.error(`Failed to load tile (${x}, ${y}) from file:`, error);
                reject(new Error(`Failed to load tile (${x}, ${y}) from local file`));
            };
            
            img.src = fileUrl;
        });
        
    } catch (error) {
        console.error(`Error loading local tile (${x}, ${y}):`, error);
        throw error; // Re-throw to fail the export
    }
}


/**Core function to download and composite tiles
 * 
 * Note: does not auto-wrap the rect, only individual tiles
*/
async function downloadTileArea(minTileX, minTileY, maxTileX, maxTileY) {

    const tilesWide = maxTileX - minTileX + 1;
    const tilesHigh = maxTileY - minTileY + 1;
    const totalTiles = tilesWide * tilesHigh;
    
    // Check tile limit
    // if (tilesWide > MAX_TILES || tilesHigh > MAX_TILES) {
    if (tilesWide * tilesHigh > MAX_TILES*MAX_TILES) {
        throw new Error(`Requested area spans ${tilesWide}x${tilesHigh} (${tilesWide * tilesHigh}) tiles, but maximum allowed is ${MAX_TILES*MAX_TILES}`);
    }
    console.log("Checking if all required tiles are downloaded...");
    validateTilesDownloaded(minTileX, minTileY, maxTileX, maxTileY);
    
    console.log(`Downloading tile area: (${minTileX}, ${minTileY}) to (${maxTileX}, ${maxTileY})`);
    console.log(`Tiles needed: ${tilesWide}x${tilesHigh} = ${totalTiles} tiles`);
    
    const tiles = new Map();
    
    // Download all required tiles
    const downloadPromises = [];
    for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
        for (let tileY = minTileY; tileY <= maxTileY; tileY++) {
            downloadPromises.push(
                loadLocalTile(tileX, tileY).then(canvas => {
                    tiles.set(`${tileX},${tileY}`, canvas);
                    console.log(`Downloaded tile (${tileX}, ${tileY}) - ${tiles.size}/${totalTiles} complete`);
                })
            );
        }
    }
    
    await Promise.all(downloadPromises);
    console.log('All tiles downloaded, creating composite...');
    
    // Create composite canvas with all tiles
    const compositeCanvas = document.createElement('canvas');
    compositeCanvas.width = tilesWide * TILE_SIZE;
    compositeCanvas.height = tilesHigh * TILE_SIZE;
    const compositeCtx = compositeCanvas.getContext('2d');
    
    // Draw all tiles onto composite canvas
    for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
        for (let tileY = minTileY; tileY <= maxTileY; tileY++) {
            const tileCanvas = tiles.get(`${tileX},${tileY}`);
            if (tileCanvas) {
                const px = (tileX - minTileX) * TILE_SIZE;
                const py = (tileY - minTileY) * TILE_SIZE;
                compositeCtx.drawImage(tileCanvas, px, py);
            }
        }
    }
    
    return {
        canvas: compositeCanvas,
        minTileX,
        minTileY,
        tilesWide,
        tilesHigh
    };
}
// Check if all required tiles are downloaded
function validateTilesDownloaded(minTileX, minTileY, maxTileX, maxTileY) {
    const missingTiles = [];
    
    for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
        for (let tileY = minTileY; tileY <= maxTileY; tileY++) {
            const normalizedX = normalizeWplaceTileX(tileX);
            const normalizedY = tileY;
            const normalizedTileKey = `${normalizedX}-${normalizedY}`;
            
            if (!downloadedTiles.has(normalizedTileKey)) {
                missingTiles.push(`(${normalizedX}, ${normalizedY})`);
            }
        }
    }
    
    if (missingTiles.length > 0) {
        throw new Error(`Missing downloaded tiles: ${missingTiles.join(', ')}. Please download these tiles first.`);
    }
    
    return true;
}

// Function to download a file
function downloadCanvas(canvas, filename) {
    canvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        console.log(`Download complete! File saved as: ${filename}`);
    }, 'image/png');
}
function wrap_tiles(startTileX, startTileY, endTileX, endTileY) {
    if(!(in_range(startTileX, 0, WPLACE_SIZE - 1) && in_range(startTileY, 0, WPLACE_SIZE - 1) &&
        in_range(endTileX, 0, WPLACE_SIZE - 1) && in_range(endTileY, 0, WPLACE_SIZE - 1))) {
        throw new Error(`Tile coordinates must be between 0 and ${WPLACE_SIZE - 1}`);
    }
    let minTileX = Math.min(startTileX, endTileX);
    let maxTileX = Math.max(startTileX, endTileX);
    let minTileY = Math.min(startTileY, endTileY);
    let maxTileY = Math.max(startTileY, endTileY);
    //do wrapping
    if (maxTileX - minTileX + 1 > minTileX - maxTileX + WPLACE_SIZE + 1){
        const temp = minTileX;
        minTileX = maxTileX;
        maxTileX = temp+ WPLACE_SIZE;
    }
    if (maxTileY - minTileY + 1 > minTileY - maxTileY + WPLACE_SIZE + 1){
        const temp = minTileY;
        minTileY = maxTileY;
        maxTileY = temp+ WPLACE_SIZE;
    }
    return { minTileX, minTileY, maxTileX, maxTileY };
}
// Tile-based export function (efficient - no unnecessary cropping)
async function exportCanvas(startTileX, startTileY, endTileX, endTileY) {
    //validate tiles
    if(!(in_range(startTileX, 0, WPLACE_SIZE - 1) && in_range(startTileY, 0, WPLACE_SIZE - 1) &&
        in_range(endTileX, 0, WPLACE_SIZE - 1) && in_range(endTileY, 0, WPLACE_SIZE - 1))) {
        throw new Error(`Tile coordinates must be between 0 and ${WPLACE_SIZE - 1}`);
    }
    let minTileX = Math.min(startTileX, endTileX);
    let maxTileX = Math.max(startTileX, endTileX);
    let minTileY = Math.min(startTileY, endTileY);
    let maxTileY = Math.max(startTileY, endTileY);
    //do wrapping
    if (maxTileX - minTileX + 1 > minTileX - maxTileX + WPLACE_SIZE + 1){
        const temp = minTileX;
        minTileX = maxTileX;
        maxTileX = temp+ WPLACE_SIZE;
    }
    if (maxTileY - minTileY + 1 > minTileY - maxTileY + WPLACE_SIZE + 1){
        const temp = minTileY;
        minTileY = maxTileY;
        maxTileY = temp+ WPLACE_SIZE;
    }
    const result = await downloadTileArea(minTileX, minTileY, maxTileX, maxTileY);
    const filename = `wplace_tiles_${minTileX}_${minTileY}_to_${maxTileX}_${maxTileY}_${Date.now()}.png`;
    
    console.log(`Final image size: ${result.canvas.width}x${result.canvas.height} pixels`);
    downloadCanvas(result.canvas, filename);
    
    return result.canvas;
}
function in_range(value, min, max) {
    return value >= min && value <= max;
}
// Pixel-based export with cropping
async function exportCanvasCrop(startTileX, startTileY, startPixelX, startPixelY, endTileX, endTileY, endPixelX, endPixelY) {
    //validate tiles
    if(!(in_range(startTileX, 0, WPLACE_SIZE - 1) && in_range(startTileY, 0, WPLACE_SIZE - 1) &&
        in_range(endTileX, 0, WPLACE_SIZE - 1) && in_range(endTileY, 0, WPLACE_SIZE - 1))) {
        throw new Error(`Tile coordinates must be between 0 and ${WPLACE_SIZE - 1}`);
    }
    // Validate pixels
    if (!(in_range(startPixelX, 0, TILE_SIZE - 1) && in_range(startPixelY, 0, TILE_SIZE - 1) &&
        in_range(endPixelX, 0, TILE_SIZE - 1) && in_range(endPixelY, 0, TILE_SIZE - 1))) {
        throw new Error(`Pixel coordinates must be between 0 and ${TILE_SIZE - 1}`);
    }
    //compute min and max
    let minTileX, maxTileX, minTileY, maxTileY;
    if( startTileX > endTileX || (startTileX === endTileX && startPixelX > endPixelX)){
        minTileX = endTileX;
        maxTileX = startTileX;
        const tempX = startPixelX;
        startPixelX = endPixelX;
        endPixelX = tempX;
    } else {
        minTileX = startTileX;
        maxTileX = endTileX;
    }
    if( startTileY > endTileY || (startTileY === endTileY && startPixelY > endPixelY)){
        minTileY = endTileY;
        maxTileY = startTileY;
        const tempY = startPixelY;
        startPixelY = endPixelY;
        endPixelY = tempY;
    } else {
        minTileY = startTileY;
        maxTileY = endTileY;
    }
    //do wrapping
    if (maxTileX - minTileX + 1 > minTileX - maxTileX + WPLACE_SIZE + 1){
        let temp = minTileX;
        minTileX = maxTileX;
        maxTileX = temp+ WPLACE_SIZE;
        temp = startPixelX;//have to also swap pixel coordinates
        startPixelX = endPixelX;
        endPixelX = temp;
    }
    if (maxTileY - minTileY + 1 > minTileY - maxTileY + WPLACE_SIZE + 1){
        let temp = minTileY;
        minTileY = maxTileY;
        maxTileY = temp+ WPLACE_SIZE;
        temp = startPixelY;
        startPixelY = endPixelY;
        endPixelY = temp;
    }
    const minPixelX = minTileX * TILE_SIZE + startPixelX;
    const minPixelY = minTileY * TILE_SIZE + startPixelY;
    const maxPixelX = maxTileX * TILE_SIZE + endPixelX;
    const maxPixelY = maxTileY * TILE_SIZE + endPixelY;
    console.log("")
    
    console.log(`Exporting cropped area:`);
    console.log(`  Pixel coordinates: (${minPixelX}, ${minPixelY}) to (${maxPixelX}, ${maxPixelY})`);
    console.log(`  Final cropped size: ${maxPixelX - minPixelX + 1}x${maxPixelY - minPixelY + 1} pixels`);
    
    // Download the tile area containing our crop region
    const result = await downloadTileArea(minTileX, minTileY, maxTileX, maxTileY);
    
    // Calculate crop area relative to composite canvas
    const cropStartX = startPixelX;
    const cropStartY = startPixelY;
    const cropWidth = maxPixelX - minPixelX + 1;
    const cropHeight = maxPixelY - minPixelY + 1;
    
    // Create final cropped canvas
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = cropWidth;
    finalCanvas.height = cropHeight;
    const finalCtx = finalCanvas.getContext('2d');
    
    // Draw the cropped area
    finalCtx.drawImage(
        result.canvas,
        cropStartX, cropStartY, cropWidth, cropHeight,
        0, 0, cropWidth, cropHeight
    );
    
    const filename = `wplace_crop_${minPixelX}_${minPixelY}_to_${maxPixelX}_${maxPixelY}_${Date.now()}.png`;
    console.log(`Cropped image dimensions: ${cropWidth}x${cropHeight} pixels`);
    downloadCanvas(finalCanvas, filename);
    
    return finalCanvas;
}





function setupEventListeners() {
    // Update info panel on map events
    map.on('zoomend moveend', async function() {
        updateMapInfo();
        updateTileStatusDisplay();
        await updateVisibleTiles(); // Manage visible tiles efficiently
        loadAllFavorites();
        queueTileDownloads();
        throttledSaveLocation();
        updateOverlayScale();
        centerOverlay();
    });
    
    map.on('mousemove', function(e) {
    updateMouseInfo(e);
});
    
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
        // loadLastLocation(); // Then restore last location
        updateVisibleTiles(); // Load only visible tiles
        queueTileDownloads(); // Then queue new downloads
        // loadLastLocation();
        // setTimeout(() => {
        //     loadLastLocation();
        // }, 500); // Slight delay to ensure map is ready
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
    updateFavoriteButton();
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
    const pixelRatio = calculatePixelSizeOnScreen();

    document.getElementById('zoomLevel').textContent = `${zoom.toFixed(1)} (${pixelBounds.max.x}, ${pixelBounds.max.y}), pixel ratio: ${pixelRatio.toFixed(3)}`;
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