// Initialize the map
let map;
let currentBaseLayer;
let gridLayer;
let pixelLayer;
let baseLayers = {};
let selectedPixel = null;
let selectionHighlight = null;

// wplace coordinate conversion constants
const WORLD_MIN = { x: -180, y: 85.05112122634179 };
const WORLD_MAX = { x: 180, y: -85.05112122634179 };
const R_x = (2048 * 1000) / (WORLD_MAX.x - WORLD_MIN.x);
const R_y = 325949.48201;
const mapSize = 2048000; // Total pixels in Web Mercator at max zoom (2048 tiles * 1000 pixels each)

// let wplaceTileLayer;
// let currentZoom = 0;
// let loadedTiles = new Map(); // Cache for loaded tile images
// const MIN_PIXEL_SIZE = 2.5; // Minimum pixel size in screen pixels before we hide tiles

// Get current map view
function getCurrentMapState() {
    const center = map.getCenter();
    const zoom = map.getZoom();
    const bounds = map.getBounds();
    
    return {
        centerLat: center.lat,
        centerLng: center.lng,
        zoom: zoom,
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

// wplace coordinate conversion functions
function h(x) {
    return (2 * (Math.atan(Math.exp(x / R_y)) - Math.PI / 4)) * 180 / Math.PI;
}

function wplaceToLatLng(x, y, z, w) {
    // x,y are tile coordinates, z,w are pixel coordinates within the tile
    // This should give us the TOP-LEFT corner of the pixel
    const lng = WORLD_MIN.x + (x * 1000 + z) / R_x;
    const lat = -h(y * 1000 + w - 2048 * (1000 / 2));
    return [lat, lng];
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
    
    return {x: Math.floor(x), y: Math.floor(y)};
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
    
    return {lat: lat, lon: lon};
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

    updateStatus('Map initialized');
}

function calculatePixelSizeOnScreen() {
    // Calculate how big one wplace pixel is on screen
    const zoom = map.getZoom();
    const center = map.getCenter();
    
    // Get two points that are 1 wplace pixel apart
    const wplaceCoords = latLngToWplace(center.lat, center.lng);
    if (!wplaceCoords) return 0;
    
    const [lat1, lng1] = wplaceToLatLng(wplaceCoords.tileX, wplaceCoords.tileY, wplaceCoords.pixelX, wplaceCoords.pixelY);
    const [lat2, lng2] = wplaceToLatLng(wplaceCoords.tileX, wplaceCoords.tileY, wplaceCoords.pixelX + 1, wplaceCoords.pixelY);
    
    // Convert to screen pixels
    const point1 = map.latLngToContainerPoint([lat1, lng1]);
    const point2 = map.latLngToContainerPoint([lat2, lng2]);
    
    // Distance in screen pixels
    const distance = Math.sqrt(Math.pow(point2.x - point1.x, 2) + Math.pow(point2.y - point1.y, 2));
    return distance;
}
// function onZoomChange() {
//     const zoom = map.getZoom();
//     const pixelSize = calculatePixelSizeOnScreen();
    
//     if (pixelSize < MIN_PIXEL_SIZE) {
//         console.log(`Zoom ${zoom}: pixels too small (${pixelSize}px), hiding tiles`);
//         hideAllTiles();
//     } else {
//         console.log(`Zoom ${zoom}: pixels visible (${pixelSize}px), showing tiles`);
//         showRelevantTiles();
//     }
// }

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
    
    // Center on test pixels
    centerOnPixelsBtn.addEventListener('click', function() {
        const centerCoords = wplaceToLatLng(1024, 1024, 500, 500);
        map.setView(centerCoords, 15);
        updateStatus('Centered on test pixels');
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
    // map.on('zoom', onZoomChange);
    map.on('zoomend moveend', updateMapInfo);
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
    
    document.getElementById('zoomLevel').textContent = zoom.toFixed(1);
    document.getElementById('centerCoords').textContent = 
        `${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}`;
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

// Convert lat/lng back to wplace coordinates
function latLngToWplace(lat, lng) {
    // Check if we're within bounds first
    if (lat > WORLD_MIN.y || lat < WORLD_MAX.y || lng < WORLD_MIN.x || lng > WORLD_MAX.x) {
        return null;
    }
    
    // Forward conversion from lng to x_pixel
    const x_pixel = (lng - WORLD_MIN.x) * R_x;
    
    // Forward conversion from lat to y_pixel using inverse of h function
    // lat = -h(y_pixel - 2048 * 500), so h_input = y_pixel - 2048 * 500
    // h(x) = (2 * (atan(exp(x / R_y)) - π/4)) * 180/π
    // So: lat = -(2 * (atan(exp((y_pixel - 1024000) / R_y)) - π/4)) * 180/π
    // Solving for y_pixel:
    const lat_rad = -lat * Math.PI / 180;
    const h_input = R_y * Math.log(Math.tan(Math.PI / 4 + lat_rad / 2));
    const y_pixel = h_input + 2048 * 500;
    
    // Calculate tile and pixel within tile
    const tileX = Math.floor(x_pixel / 1000);
    const tileY = Math.floor(y_pixel / 1000);
    const pixelX = Math.floor(x_pixel % 1000);
    const pixelY = Math.floor(y_pixel % 1000);
    
    // Ensure we're within the 2048x2048 tile grid
    if (tileX < 0 || tileX >= 2048 || tileY < 0 || tileY >= 2048) {
        return null;
    }
    
    return {
        tileX: tileX,
        tileY: tileY,
        pixelX: pixelX,
        pixelY: pixelY
    };
}

function updateStatus(message) {
    document.getElementById('loadStatus').textContent = message;
    console.log(`Status: ${message}`);
}

// Utility function to convert coordinates to wplace tile coordinates
// This will be useful when we add wplace data
function coordsToWplaceTile(lat, lng, zoom) {
    // This is where you'll implement the conversion from lat/lng to wplace tile coordinates
    // For now, just a placeholder
    return {
        x: Math.floor((lng + 180) / 360 * Math.pow(2, zoom)),
        y: Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom)),
        z: zoom
    };
}

// Function to load wplace tiles (placeholder for now)
function loadWplaceTiles() {
    // This is where you'll implement loading your downloaded wplace tiles
    // You could:
    // 1. Load them from local files
    // 2. Create a custom Leaflet layer
    // 3. Overlay them on the base map
    
    updateStatus('Ready to implement wplace tile loading');
}