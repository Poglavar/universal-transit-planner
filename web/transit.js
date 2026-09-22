const APP_CONFIG = window.__TRANSIT_RUNTIME_CONFIG__ || {};
const CITY_CONFIG = APP_CONFIG.city || {};
const CAPABILITIES = APP_CONFIG.capabilities || {};
const I18N = window.__transitI18n;
const UI_LANGUAGE = I18N?.currentLanguage || 'en';
const UI_LOCALE = I18N?.locale || 'en';
const ui = (english, croatian) => UI_LANGUAGE === 'hr' ? croatian : english;
const DEFAULT_MAP_CENTER = Array.isArray(CITY_CONFIG.center) ? CITY_CONFIG.center : [0, 0];
const DEFAULT_MAP_ZOOM = Number.isFinite(Number(CITY_CONFIG.zoom)) ? Number(CITY_CONFIG.zoom) : 12;

// ─── Map Setup ──────────────────────────────────────────────────────────────
// keyboard:false disables Leaflet's arrow-key map panning. Without this
// flag, when the user has clicked the map (giving its container focus),
// Leaflet attaches a document-level keydown listener that intercepts
// arrow keys for panning. Inside the cab modal that meant the cab's
// switch-steering hotkeys silently no-op — opening DevTools blurred
// the map, which removed Leaflet's listener and "fixed" them. Mouse
// drag still pans, so this just removes a redundant input path.
const map = L.map('map', { zoomControl: false, keyboard: false })
    .setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
if (CAPABILITIES.terrain && CITY_CONFIG.providerLabels?.terrainAttribution) {
    map.attributionControl.addAttribution(CITY_CONFIG.providerLabels.terrainAttribution);
}
// A ?st3d= / cab link opens a 3D world and never shows the planner. Painting
// the map for it cost about five seconds of a map nobody asked for and 29 tile
// requests competing with the world build, so the basemap is not added at all
// on those links — it is created later only if the link fails, or when the
// reader closes the 3D session onto the map.
const station3DDeepLinkBoot = !!(window.__station3dDeepLink
    && window.__station3dDeepLink.isStation3DDeepLink(window.location.search));
let basemapLayer = null;
function ensureBasemapLayer() {
    if (basemapLayer) return basemapLayer;
    const basemap = CITY_CONFIG.providers?.basemap || {};
    basemapLayer = L.tileLayer(basemap.url || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: basemap.attribution
            || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        crossOrigin: true,
    }).addTo(map);
    return basemapLayer;
}
if (!station3DDeepLinkBoot) ensureBasemapLayer();
const TERRAIN_MAP_PANE = 'terrain-map-pane';
const terrainMapPane = map.createPane(TERRAIN_MAP_PANE);
terrainMapPane.style.zIndex = '250';
terrainMapPane.style.pointerEvents = 'none';
const TRACK_LEVEL_PANE = 'track-level-pane';
const trackLevelPane = map.createPane(TRACK_LEVEL_PANE);
trackLevelPane.style.zIndex = '455';
trackLevelPane.style.pointerEvents = 'none';
// Read-only railway projects drawn as context. Below the
// default overlay pane (400) so the user's own tracks always draw over it, and
// click-through so it can never swallow a drawing click.
const REFERENCE_RAIL_PANE = 'reference-rail-pane';
const referenceRailPane = map.createPane(REFERENCE_RAIL_PANE);
referenceRailPane.style.zIndex = '395';
referenceRailPane.style.pointerEvents = 'none';
window.addEventListener('resize', () => map.invalidateSize());
const STATION3D_SUSPEND_CLASS = 'station3d-suspend-map';

// ─── Constants ──────────────────────────────────────────────────────────────
const BASE_PATH = window.location.pathname.replace(/\/[^/]*$/, ''); // e.g. '/transit' or ''
const ISOCHRONE_URL = APP_CONFIG.valhallaIsochroneUrl;
const API_BASE_URL = APP_CONFIG.apiBaseUrl;
const apiEndpoint = path => API_BASE_URL ? `${API_BASE_URL}${path}` : null;
const CATCHMENT_STATS_URL = apiEndpoint('/buildings/catchment-stats');
const STATION_CATCHMENT_URL = apiEndpoint('/transit/station-catchment');
const BUILDINGS_HEATMAP_URL = apiEndpoint('/buildings/heatmap');
const TERRAIN_PROFILE_URL = apiEndpoint('/terrain/profile');
const TERRAIN_MAP_API = window.TerrainMapLayer;
// Was a static file in website/. The API returns the same shape
// ({name, stopType, osmType, osmId, lat, lng}) from public.rail_station, so
// both the station-name lookup and the chainage dialog read one source.
const RAIL_STATIONS_URL = apiEndpoint('/transit/rail-stations');
const TRAM_STOPS_URL = CITY_CONFIG.staticData?.tramStops || null;
const TEST_CONFIG = window.__TRANSIT_TEST_CONFIG ?? window.__TRANSIT_TEST_CONFIG__ ?? {};
// transit-pricing.js is loaded unconditionally before this file (see
// transit.html) and is the single source of the cost model — the duplicate
// price table that used to live here silently implemented the retired
// level-multiplier model whenever it was reached.
const PRICING_API = window.TransitPricing;
const PROJECT_LIFECYCLE_API = window.__plannerProjectLifecycle;
const PLANNER_LOCATION_API = window.__plannerLocationContext;
const TRANSFER_LINK_RADIUS_METERS = 100;
const WALK_TIME_STORAGE_KEY = 'transit-walk-time-v1';
const DEFAULT_WALK_TIME_VALUE = '10';
const ALLOWED_WALK_TIME_VALUES = new Set(['0', '5', '10', '15', '20']);
const valhallaUnavailableMessage = ui(
    'The Valhalla API is unavailable. Check runtime-config.js and the Valhalla service.',
    'Valhalla API nije dostupan. Provjerite website/runtime-config.js i dostupnost Valhalle.',
);
const apiUnavailableMessage = ui(
    'The planner API is unavailable. Check runtime-config.js and the API service.',
    'API planera nije dostupan. Provjerite runtime-config.js i dostupnost API-ja.',
);

function getPostHeaders(url) {
    // Local Valhalla answers CORS preflight OPTIONS with 405, but accepts the same JSON payload as text/plain.
    if (url === ISOCHRONE_URL) {
        return { 'Content-Type': 'text/plain;charset=UTF-8' };
    }

    return { 'Content-Type': 'application/json' };
}

function getPlannerTerrainSource() {
    if (!TERRAIN_MAP_API) return CITY_CONFIG.providers?.terrain?.[0] || null;
    return TERRAIN_MAP_API.simulationSourceForLocation(
        window.__locationRegistry,
        getProjectLocationId(),
    );
}

function getTerrainMapSource() {
    if (!TERRAIN_MAP_API) return CITY_CONFIG.providers?.terrain?.[0] || null;
    return TERRAIN_MAP_API.mapSourceForLocation(
        window.__locationRegistry,
        getProjectLocationId(),
    );
}

function supportsReferenceSimulation(locationId = getProjectLocationId(), mode = null) {
    const simulation = CITY_CONFIG.referenceSimulation || {};
    const locations = Array.isArray(simulation.locationIds) ? simulation.locationIds : [];
    const modes = Array.isArray(simulation.modes) ? simulation.modes : [];
    return locations.includes(locationId) && (!mode || modes.includes(mode));
}

// Track gauges — the physical infrastructure choice. Any gauge can run at any
// level per vertex: -1 underground, 0 surface, +1 elevated (viaduct). Minimum
// curve radii are explicit planner constraints and can be tuned after manual
// route-drawing review without changing the fillet/validation algorithm.
const TRACK_LEVEL_MIN = -1;
const TRACK_LEVEL_MAX = 1;
const LEVEL_HEIGHT_METERS = 10; // vertical separation between adjacent levels
// Keep the Vidi walker's feet on the same paved bed plane rendered by rails.js.
const UNDERGROUND_3D_VIEW_ISLAND_PLATFORM_TOP_OFFSET_METERS = 0.55;
// Starts beyond the elevated station's stair run rather than inside its solid
// stepped support, with enough distance to see the complete platform.
const ELEVATED_3D_VIEW_OFFSET_METERS = 27;
const STATION_RAMP_ENDPOINT_SNAP_M = 1;
const TRACK_TOPOLOGY_API = window.__trackTopology;
const TRACK_CENTER_SPACING_METERS = Object.freeze({
    monorail: 3.4,
    g1000: 2.8,
    g1435: 3.4,
});
// Mirrors PLANNER_UNDERGROUND_TRACK_CENTER_SPACING_M in
// station-3d/world/tram-trackbed-dimensions.js, which is what actually draws
// the rails. The two must agree: this value places the train, its map icon and
// the underground "Vidi" spawn, so a stale copy rides the tram off its own
// rails and through the island platform.
const UNDERGROUND_TRACK_CENTER_SPACING_METERS = 13.2;
const UNDERGROUND_STATION_CORE_HALF_LENGTH_METERS = 30;
const UNDERGROUND_STATION_FLARE_LENGTH_METERS = 55;
const GAUGES = {
    monorail: { label: 'Monorail', icon: '🚝', maxInclinePct: 8, minCurveRadiusM: 50, trackWeight: 3 },
    g1000: { label: ui('Metre gauge (1000 mm)', 'Uskotračna (1000 mm)'), icon: '🚊', maxInclinePct: 6, minCurveRadiusM: 25, trackWeight: 4 },
    g1435: { label: ui('Standard gauge (1435 mm)', 'Normalna (1435 mm)'), icon: '🚇', maxInclinePct: 4, minCurveRadiusM: 100, trackWeight: 5 },
};
const TRACK_LEVEL_LABELS = {
    '-1': ui('underground', 'podzemno'),
    0: ui('surface', 'površina'),
    1: ui('elevated', 'nadvožnjak'),
};
function normalizeGauge(gauge) {
    return GAUGES[gauge] ? gauge : 'g1000';
}
function getTrackCenterSpacingMeters(gauge) {
    return TRACK_CENTER_SPACING_METERS[normalizeGauge(gauge)];
}
function getPlannerCenterlineMinCurveRadiusMeters(gauge) {
    const normalizedGauge = normalizeGauge(gauge);
    return GAUGES[normalizedGauge].minCurveRadiusM
        + getTrackCenterSpacingMeters(normalizedGauge) * 0.5;
}
// Minimum horizontal run needed to change one level at the gauge's max incline.
function getMinLevelChangeMeters(gauge) {
    return LEVEL_HEIGHT_METERS / (GAUGES[normalizeGauge(gauge)].maxInclinePct / 100);
}
const LINE_SPEED_KMH = {
    monorail: TEST_CONFIG.monorailSpeedKmh ?? 50,
    g1000: TEST_CONFIG.g1000SpeedKmh ?? 50,
    g1435: TEST_CONFIG.g1435SpeedKmh ?? 70,
};
const LINE_STOP_DWELL_SECONDS = {
    monorail: TEST_CONFIG.monorailDwellSeconds ?? TEST_CONFIG.lineDwellSeconds ?? 10,
    g1000: TEST_CONFIG.g1000DwellSeconds ?? TEST_CONFIG.lineDwellSeconds ?? 10,
    g1435: TEST_CONFIG.g1435DwellSeconds ?? TEST_CONFIG.lineDwellSeconds ?? 10,
};
const TRAIN_STOP_MATCH_EPSILON_METERS = 0.75;
const TRAIN_STOP_DEPARTURE_EPSILON_METERS = 0.05;
const UNDERGROUND_STATION_ENTRY_BUFFER_METERS = 30;
const UNDERGROUND_CURVE_SAMPLE_SPACING_METERS = 5;
const UNDERGROUND_CURVE_MIN_TURN_DEG = 8;
const UNDERGROUND_CURVE_SPEED_MIN_FACTOR = 0.33;
const UNDERGROUND_CURVE_SPEED_ZONE_BASE_METERS = 12;
const UNDERGROUND_CURVE_SPEED_ZONE_SCALE_METERS = 0.32;
const UNDERGROUND_CURVE_SPEED_ZONE_MAX_METERS = 40;
const UNDERGROUND_CURVE_HEADING_LOOKAHEAD_METERS = 14;
const EARTH_RADIUS_M = 6371000;
const DEG_TO_RAD = Math.PI / 180;

function offsetLatLngRightOfTravel(lat, lon, headingDeg, offsetMeters) {
    const headingRad = headingDeg * DEG_TO_RAD;
    const eastMeters = Math.cos(headingRad) * offsetMeters;
    const northMeters = -Math.sin(headingRad) * offsetMeters;
    const latRadians = lat * DEG_TO_RAD;
    return {
        lat: lat + northMeters / (EARTH_RADIUS_M * DEG_TO_RAD),
        lon: lon + eastMeters / (EARTH_RADIUS_M * Math.cos(latRadians) * DEG_TO_RAD),
    };
}
// Player-drawn trains use the shared sim clock speed multiplier (default 4x).
// At 4x a 7km round trip at 30km/h takes ~3.5 minutes of real time.
const TRAIN_CAPACITY = {
    monorail: 250,
    g1000: 200,
    g1435: 400,
};
let nextTrainId = 1;

// Fare in EUR per boarding passenger
const FARE_EUR = 1;

// Lazy-initialised AudioContext for arrival beeps — only after user gesture
let _audioCtx = null;
let _audioAllowed = false;
function _unlockAudio() {
    _audioAllowed = true;
    document.removeEventListener('click', _unlockAudio);
    document.removeEventListener('keydown', _unlockAudio);
}
document.addEventListener('click', _unlockAudio);
document.addEventListener('keydown', _unlockAudio);
function getAudioCtx() {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return _audioCtx;
}
function playArrivalBeep() {
    if (!_audioAllowed || isStation3DMapSuspended()) return;
    try {
        const ctx = getAudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime);          // A5
        osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.08); // slide down
        gain.gain.setValueAtTime(0.18, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.18);
    } catch (_) { /* audio not available */ }
}
const CHECKER_CATCHMENT_COLOR = '#16a34a';
const STATION_CATCHMENT_COLOR = '#6366f1';
const LINE_COLOR_PALETTE = [
    '#2563eb',
    '#dc2626',
    '#16a34a',
    '#ea580c',
    '#7c3aed',
    '#0891b2',
    '#ca8a04',
    '#db2777',
];
const LINE_STYLES = {
    monorail: { color: '#ef4444', weight: 3, opacity: 0.9 },
    g1000: { color: '#ef4444', weight: 4, opacity: 0.9 },
    g1435: { color: '#3b82f6', weight: 5, opacity: 0.9 },
};
const TRACK_STYLES = {
    monorail: { color: '#6b7280', weight: 3, opacity: 0.7 },
    g1000: { color: '#6b7280', weight: 4, opacity: 0.7 },
    g1435: { color: '#6b7280', weight: 5, opacity: 0.7 },
};
// Level colours for the planner track on the OSM map. Ramps use two dedicated
// solid colours and explicit end ticks so their entire editable span is clear.
const TRACK_LEVEL_RGB = Object.freeze({
    '-1': [17, 24, 39],    // underground — near black
    0: [59, 130, 246],     // surface — clear blue
    1: [22, 163, 74],      // elevated — green
});
const TRACK_RAMP_COLORS = Object.freeze({
    '-1': '#9333ea', // ramp between the surface and −1; violet keeps red exclusive to warnings
    1: '#eab308',    // ramp between the surface and +1
});
// Auto-grade regime colours — IDENTICAL to the elevation strip (profile-render
// REGIME_COLORS) so the map and the strip always agree. The 2D route is now
// coloured by regime, not by the retired ±1 levels.
const REGIME_MAP_COLORS = Object.freeze({
    tunnel: '#26262b',
    cut: '#8a6d3b',
    'at-grade': '#2e7dd1',
    fill: '#c9a227',
    viaduct: '#2e9e4f',
});
// A route with no solved vertical profile has no grades to show. It is drawn
// dashed and neutral rather than flat-coloured: "we do not know" and "it is
// level" are different claims, and only one of them is true here.
const GRADE_UNKNOWN_COLOR = '#b6bac2';
// Which vocabulary the map paints the routes in: what carries the track
// ('structure') or which way it tilts ('grade').
let trackDisplayMode = 'structure';
// Grade is a property of a DIRECTION of travel, not of the track — so the view
// states which way it is being read, and this turns it around.
let gradeViewFlipped = false;
const TRACK_MIN_FULL_LEVEL_LENGTH_M = 50;
const STATION_ORDER_GAP_M = 1;
const HEATMAP_CONFIG = {
    residents: {
        label: 'stanovnika',
        gradient: { 0.1: '#4dabf7', 0.3: '#3b5bdb', 0.6: '#7048e8', 1.0: '#c2255c' },
        max: 300,
    },
    jobs: {
        label: 'radnih mjesta',
        gradient: { 0.1: '#2b8a3e', 0.3: '#f59f00', 0.6: '#e8590c', 1.0: '#c92a2a' },
        max: 200,
    },
};

// ─── State ──────────────────────────────────────────────────────────────────
let currentMode = 'explore'; // 'explore' | 'placeStation' | 'drawLine' | 'edit'
let hoveringObject = false;
let proximityHoveredTrack = null;
let draggingVertex = false;
let catchmentLayer = null;
let snapMarker = null;
let lastSnappedLatLng = null;
let lastSnappedTrackId = null;
let catchmentMarker = null;
let catchmentRequestToken = 0;

// Line drawing state
let currentLinePoints = [];
let currentLineLayer = null;
let currentLineVertexMarkers = [];
let finishLineMarker = null;
let hoveringFinishMarker = false;
let drawingStartJunctionTrackId = null;
let drawingStartReferenceConnection = null;
let drawingTrackLevel = 0;
let extendingTrack = null;       // { track, endpoint: 'start'|'end' } when extending an existing track
let referenceConnectionMode = false;
let referenceRailSnapRequest = null;
let lastReferenceRailSnap = null;
let pendingRailConnectionIntents = [];
let loadedRailJunctions = [];


const drawingToolbarIcon = L.divIcon({
    className: 'drawing-toolbar-icon',
    html: `<div class="drawing-toolbar">
        <button class="draw-tool-btn" data-action="undo" title="Poništi zadnju točku">↩️</button>
        <button class="draw-tool-btn" data-action="cancel" title="Odustani od trase">💥</button>
        <button class="draw-tool-btn" data-action="finish" title="Završi trasu">✅</button>
    </div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
});

function updateFinishLineMarker() {
    syncMapActionButtons();
    if (currentLinePoints.length < 1) {
        if (finishLineMarker) { map.removeLayer(finishLineMarker); finishLineMarker = null; }
        hoveringFinishMarker = false;
        return;
    }
    const last = currentLinePoints[currentLinePoints.length - 1];
    const latlng = L.latLng(last[0], last[1]);
    if (!finishLineMarker) {
        finishLineMarker = L.marker(latlng, { icon: drawingToolbarIcon, zIndexOffset: 1000 }).addTo(map);
        finishLineMarker.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            const btn = e.originalEvent?.target.closest('[data-action]');
            if (!btn || btn.disabled) return;
            const action = btn.dataset.action;
            if (action === 'finish') {
                if (currentLinePoints.length >= 2) finishCurrentTrack();
            } else if (action === 'undo') {
                undoLastVertex();
            } else if (action === 'cancel') {
                cancelCurrentLine();
                setMode('explore');
            }
        });
        finishLineMarker.on('mouseover', () => {
            hoveringFinishMarker = true;
            if (snapMarker) { map.removeLayer(snapMarker); snapMarker = null; }
            updateCurrentLinePreview();
        });
        finishLineMarker.on('mouseout', () => {
            hoveringFinishMarker = false;
        });
    } else {
        finishLineMarker.setLatLng(latlng);
    }
    // Keep ✅ disabled until there are at least 2 points
    const el = finishLineMarker.getElement();
    if (el) {
        const finishBtn = el.querySelector('[data-action="finish"]');
        if (finishBtn) finishBtn.disabled = currentLinePoints.length < 2;
    }
}

function removeFinishLineMarker() {
    if (finishLineMarker) { map.removeLayer(finishLineMarker); finishLineMarker = null; }
    hoveringFinishMarker = false;
}

// Project state
const project = {
    purpose: 'proposal',
    access: 'editable',
    referenceKind: null,
    provenance: null,
    tracks: [],
    lines: [],
    stations: [],
    transferLinks: [],
    totalRevenue: 0,
    // Internal session context, derived from coordinates/geometry. An incoming
    // `loc` may seed an empty legacy URL once, but it is never written back.
    locationId: PLANNER_LOCATION_API.initialLocationId(
        window.location.search,
        window.__locationRegistry,
        CITY_CONFIG.id,
    ),
};

function projectLifecyclePolicy() {
    return PROJECT_LIFECYCLE_API.workingCopyPolicy(project);
}

function projectIsReference() {
    return PROJECT_LIFECYCLE_API.isReferenceProject(project);
}

function rejectProjectMutation() {
    if (projectLifecyclePolicy().canEdit) return false;
    setStatusMessage('Ovaj projekt nije moguće uređivati.', true);
    return true;
}
// Fast station lookup by ID. Call rebuildStationIndex() after adding/removing stations.
let _stationById = new Map();
// Monotonic counter incremented when network topology changes (stations/lines/transfers).
// Used to avoid rebuilding expensive graph structures when topology is stable.
let _topologyVersion = 0;
function rebuildStationIndex() {
    _stationById = new Map(project.stations.map(s => [s.id, s]));
    _topologyVersion++;
    _transferRoutingKey = -1; // invalidate routing table cache
    if (typeof PassengerDemand !== 'undefined') PassengerDemand.invalidateTopologyCache();
}
let nextTransferLinkId = 1;
let nextTrackId = 1;
let nextLineId = 1;
let nextLineNumber = 1;
let nextStationId = 1;
let nextStationSerial = 1;
let nextDepotSerial = 1;
let activePricing = PRICING_API.loadPricing();

function generateDefaultStationName(stationType) {
    if (stationType === 'depot') {
        return `Remiza ${nextDepotSerial++}`;
    }
    return `Stanica ${nextStationSerial++}`;
}

// A station within this many metres of a named road is named after it; beyond
// it no road is "at" the stop, so the generic "Stanica N" serial is kept.
const STATION_ROAD_NAME_MAX_M = 80;

// True for the auto-generated "Stanica N" / "Remiza N" serial names. Used when
// hydrating a saved project (which predates the autoNamed flag): a station
// still carrying its default name is treated as auto-named, a custom one as
// user-owned so a reposition never clobbers it.
function isDefaultStationName(name) {
    return /^(Stanica|Remiza)\s+\d+$/.test(String(name || '').trim());
}

// Nearest named OSM road to a point, or null when none is within
// STATION_ROAD_NAME_MAX_M. Reuses the same /roads bbox endpoint as the track
// road-crossing dots; the distance/threshold selection is the only logic here.
async function nearestNamedRoadName(lat, lng) {
    if (typeof turf === 'undefined' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    // ~180 m half-box around the point (0.0016° lat ≈ 178 m); widen longitude by
    // 1/cos(lat) so it stays roughly square away from the equator.
    const dLat = 0.0016;
    const dLng = dLat / Math.max(0.2, Math.cos(lat * Math.PI / 180));
    const bbox = `${lng - dLng},${lat - dLat},${lng + dLng},${lat + dLat}`;
    let fc;
    // Never let a slow/hung roads endpoint stall station placement — time out
    // and fall back to the generic serial name.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
        const resp = await fetch(`${API_BASE_URL}/roads?bbox=${encodeURIComponent(bbox)}`, { cache: 'no-store', signal: ctrl.signal });
        if (!resp.ok) throw new Error(`roads ${resp.status}`);
        fc = await resp.json();
    } catch (err) {
        console.warn('[stations] road-name lookup failed:', err?.message || err);
        return null;
    } finally {
        clearTimeout(timer);
    }
    const pt = turf.point([lng, lat]);
    let best = null;
    for (const road of (fc?.features || [])) {
        const name = road?.properties?.name;
        if (!name || !road.geometry) continue;
        // Split MultiLineStrings so pointToLineDistance always sees a LineString.
        const geoms = road.geometry.type === 'MultiLineString'
            ? road.geometry.coordinates.map(coords => turf.lineString(coords))
            : [road];
        for (const g of geoms) {
            let dM;
            try { dM = turf.pointToLineDistance(pt, g, { units: 'meters' }); }
            catch (_e) { continue; }
            if (dM <= STATION_ROAD_NAME_MAX_M && (!best || dM < best.dM)) best = { name, dM };
        }
    }
    return best ? best.name : null;
}

// (Re)derives an auto-named station's label from the nearest named road,
// falling back to the generic serial. No-op for depots, and for stations the
// user has manually renamed (autoNamed === false) so a reposition never
// overwrites a chosen name. Repaints the marker + any open title on change.
async function applyAutoStationName(station, requestId = null) {
    if (!station || station.autoNamed === false || station.stationType === 'depot') return;
    const token = Number.isInteger(requestId)
        ? requestId
        : (station._autoNameRequestId || 0) + 1;
    station._autoNameRequestId = token;
    const [lat, lng] = station.latlng || [];
    const roadName = await nearestNamedRoadName(lat, lng);
    if (station._autoNameRequestId !== token) return;
    const nextName = roadName || (isDefaultStationName(station.name) ? station.name : generateDefaultStationName(station.stationType));
    if (nextName === station.name) return;
    station.name = nextName;
    station.autoNamed = true;
    refreshStationMarkerPresentation(station);
    if (selectedObject && selectedObject.type === 'station' && selectedObject.id === station.id) {
        const titleEl = getActiveSelectionRoot()?.querySelector('.sel-popup-title');
        if (titleEl) titleEl.textContent = getStationDisplayName(station);
    }
}

// Station placement state
let previewCatchmentLayer = null;
let previewAbortController = null;
let previewDebounceTimer = null;
let previewStationDistanceLayer = null;
let previewStationDistanceLineId = null;
let previewStationSpacingSummary = null;
let stationCatchmentRefreshToken = 0;
let heatmapLayer = null;
let activeHeatmapField = null;
let heatmapRequestToken = 0;
let heatmapLoadingField = null;
let railStationsLayer = null;
let railStationsLoading = false;
let railStationsVisible = false;
let railStationsDataPromise = null;
let railStationsResolvedData = null;
// Shown by default. Reference projects replaced the OSM-derived legacy rail
// layer in f7dc0dd (2026-07-30) — the right call, projects are the first-class
// source now — but that layer was drawn unconditionally, with no toggle to
// forget, while its replacement defaulted to hidden and persisted nothing. The
// net effect was that every existing railway disappeared from the map and the
// 3D world on every page load. Existing lines are context you almost always
// want; an explicit decision to hide them is remembered below.
const REFERENCE_RAIL_VISIBLE_KEY = 'voznjaReferenceRailVisible';
let referenceRailVisible = (() => {
    try {
        const saved = window.localStorage.getItem(REFERENCE_RAIL_VISIBLE_KEY);
        return saved === null ? true : saved === '1';
    } catch (_error) {
        return true;
    }
})();
let referenceRailLoading = false;

function rememberReferenceRailVisible(visible) {
    try {
        window.localStorage.setItem(REFERENCE_RAIL_VISIBLE_KEY, visible ? '1' : '0');
    } catch (_error) { /* private mode: the default simply applies again next load */ }
}
let tramStopsLayer = null;
let tramStopsLoading = false;
let tramStopsVisible = false;
let tramStopsDataPromise = null;
let tramStopsResolvedData = null;
let terrainMapLayer = null;
let terrainMapVisible = false;
let terrainMapSource = null;
let terrainMapTileErrorShown = false;
let terrainElevationAbortController = null;
let projectSummaryRequestToken = 0;
let selectedObject = null; // { type: 'station'|'line'|'train', id, ref }
let editingStationTitleId = null;
let trackElectrificationEditor = null;
let walkPopup = null;
let walkOpenPending = false;   // freeze map clicks while a 3D walk is building
const animatedLines = new Set();
let trainAnimationFrameId = null;
let lastTrainAnimationTimestamp = null;
// True from the first line on a 3D deep link: the boot screen is the visible
// surface until Station3D's own loading screen replaces it.
let station3DMapSuspended = station3DDeepLinkBoot;

// Line building mode state
let lineBuildingState = null; // { line, depotStation, stationIds: [], pickerMarker }


// ─── DOM Elements ───────────────────────────────────────────────────────────
const controlsDiv = document.getElementById('controls');
const toggleBtn = document.getElementById('toggleControls');
const controlsScrim = document.getElementById('controlsScrim');
const lineControlsDiv = document.getElementById('lineControls');
const walkTimeOptions = Array.from(document.querySelectorAll('input[name="walkTime"]'));
const togglePopulationHeatmapBtn = document.getElementById('togglePopulationHeatmap');
const toggleJobsHeatmapBtn = document.getElementById('toggleJobsHeatmap');
const toggleTrackDrawingBtn = document.getElementById('toggleTrackDrawing');
const toggleStationPlacementBtn = document.getElementById('toggleStationPlacement');
const toggleRouteEditingBtn = document.getElementById('toggleRouteEditing');
const toggleElectrificationEditingBtn = document.getElementById('toggleElectrificationEditing');
const toggleReferenceConnectionBtn = document.getElementById('toggleReferenceConnection');
const toggleMapActionsBtn = document.getElementById('toggleMapActions');
const mapActionPanel = document.getElementById('mapActionPanel');
const mapGaugePicker = document.getElementById('mapGaugePicker');
const toggleRailStationsBtn = document.getElementById('toggleRailStations');
const toggleRailStationsText = document.getElementById('toggleRailStationsText');
const toggleReferenceRailProjectsBtn = document.getElementById('toggleReferenceRailProjects');
const toggleReferenceRailProjectsText = document.getElementById('toggleReferenceRailProjectsText');
const toggleTramStopsBtn = document.getElementById('toggleTramStops');
const toggleTramStopsText = document.getElementById('toggleTramStopsText');
const toggleTerrainMapInput = document.getElementById('toggleTerrainMap');
const toggleTerrainMapText = document.getElementById('toggleTerrainMapText');
const terrainMapLegend = document.getElementById('terrainMapLegend');
const toggleStationDistancesInput = document.getElementById('toggleStationDistances');
const toggleDemandLabelsInput = document.getElementById('toggleDemandLabels');
const openInfoModalBtn = document.getElementById('openInfoModal');
const gaugePriceEls = {
    monorail: document.getElementById('gaugePriceMonorail'),
    g1000: document.getElementById('gaugePriceG1000'),
    g1435: document.getElementById('gaugePriceG1435'),
};
const toastContainer = document.getElementById('toastContainer');
const gameLogModal = document.getElementById('gameLogModal');
const gameLogContent = document.getElementById('gameLogContent');
const openGameLogBtn = document.getElementById('openGameLog');
const openChainageBtn = document.getElementById('openChainage');
const openReliefViewerBtn = document.getElementById('openReliefViewer');
const closeGameLogBtn = document.getElementById('closeGameLog');
const clearGameLogBtn = document.getElementById('clearGameLog');
const gameLog = [];
const loadingDiv = document.getElementById('loading');
const catchmentStatsDiv = document.getElementById('catchmentStats');
const linesListDiv = document.getElementById('linesList');
const linesListContent = document.getElementById('linesListContent');
const routesListContent = document.getElementById('routesListContent');
const projectSummaryDiv = document.getElementById('projectSummary');
let sidebarActiveTab = 'tracks';
let sidebarHighlightLayer = null;
let sidebarSelectedId = null; // { type: 'track'|'line', id }
const selectionSheet = document.getElementById('selectionSheet');
const railConnectionChoiceModal = document.getElementById('railConnectionChoiceModal');
const railConnectionChoices = document.getElementById('railConnectionChoices');
// Collapsed state: the sheet shrinks to a corner chip so the map and the
// elevation strip stay usable while the object remains selected. A NEW
// selection always re-expands. Created here (before any setMode/boot call
// path can reach updateSelectionSheetChip) to keep the const out of TDZ.
let selectionSheetCollapsed = false;
let lastSelectionSheetKey = null;
const selectionSheetChip = document.createElement('button');
selectionSheetChip.type = 'button';
selectionSheetChip.className = 'selection-sheet-chip hidden';
selectionSheetChip.setAttribute('aria-label', 'Otvori panel odabira');
document.body.appendChild(selectionSheetChip);
selectionSheetChip.onclick = () => {
    selectionSheetCollapsed = false;
    renderSelectionSheet();
};
const mapContainer = map.getContainer();

function isStation3DMapSuspended() {
    return station3DMapSuspended;
}

function clearTransitToasts() {
    if (toastContainer) toastContainer.innerHTML = '';
}

function refreshTransitMapAfter3D() {
    updateRevenueDisplay();
    updateSkyAnimation();
    if (toggleDemandLabelsInput?.checked) updateDemandLabels();
    else clearDemandLabels();
    for (const line of animatedLines) {
        if (!line.trains) continue;
        for (const train of line.trains) {
            updateTrainMarker(train, line);
        }
    }
    if (selectedObject?.type === 'train') {
        refreshSelectedTrainPopup(selectedObject.ref.train, selectedObject.ref.line);
    }
    requestAnimationFrame(() => map.invalidateSize());
}

// A 3D deep link boots behind Station3D's one loading screen (the static curtain
// in transit.html, station-3d/ui/loading-curtain.js). The engine adopts it and
// drops it when the world is built, so the reader sees one continuous wait from
// the link to the world rather than a map, a flash, and then a wait.
const LOADING_CURTAIN_SELECTOR = '.station-3d-campaign-curtain';
function plannerBootLoadingVisible() {
    const curtain = document.querySelector(LOADING_CURTAIN_SELECTOR);
    return !!curtain && !curtain.hidden;
}
function hidePlannerBootLoading() {
    document.querySelector(LOADING_CURTAIN_SELECTOR)?.remove();
}
// Give the reader the planner after all: a link that failed, or one that is
// taking so long they would rather go look at the map. Idempotent.
function revealPlannerMap() {
    hidePlannerBootLoading();
    ensureBasemapLayer();
    if (station3DMapSuspended) setStation3DMapSuspended(false);
    else requestAnimationFrame(() => map.invalidateSize());
}
const bootLoadingCurtain = document.querySelector(LOADING_CURTAIN_SELECTOR);
if (station3DDeepLinkBoot && bootLoadingCurtain) {
    bootLoadingCurtain.hidden = false;
    document.body.classList.add(STATION3D_SUSPEND_CLASS);
    const escapeBtn = bootLoadingCurtain.querySelector('.station-3d-campaign-curtain-cancel');
    if (escapeBtn) escapeBtn.addEventListener('click', () => revealPlannerMap());
}

function setStation3DMapSuspended(active) {
    const next = !!active;
    if (station3DMapSuspended === next) return;
    station3DMapSuspended = next;
    document.body.classList.toggle(STATION3D_SUSPEND_CLASS, next);
    if (next) {
        stopDemandClock();
        clearTransitToasts();
        return;
    }
    ensureBasemapLayer();
    startDemandClock();
    refreshTransitMapAfter3D();
}

window.addEventListener('station3d:visibility', (event) => {
    const active = !!event.detail?.active;
    // An open session keeps the loading screen until its world is built (the
    // engine drops it then); a session that closes, even mid-build, takes it away.
    if (!active) hidePlannerBootLoading();
    setStation3DMapSuspended(active);
});

// ─── Sidebar Toggle ─────────────────────────────────────────────────────────
const mobileSidebarMedia = window.matchMedia('(max-width: 768px)');
let sidebarOpen = !mobileSidebarMedia.matches;
let wasMobileSidebar = mobileSidebarMedia.matches;
const navRow = controlsDiv.querySelector('.nav-row');
const rootStyle = document.documentElement.style;

function syncViewportChrome() {
    const viewport = window.visualViewport;
    const layoutWidth = document.documentElement.clientWidth || window.innerWidth;
    const width = viewport ? viewport.width : window.innerWidth;
    const height = viewport ? viewport.height : window.innerHeight;
    const left = viewport ? viewport.offsetLeft : 0;
    const top = viewport ? viewport.offsetTop : 0;
    const right = Math.max(0, layoutWidth - width - left);

    rootStyle.setProperty('--visual-viewport-top', `${Math.max(0, top)}px`);
    rootStyle.setProperty('--visual-viewport-left', `${Math.max(0, left)}px`);
    rootStyle.setProperty('--visual-viewport-right', `${right}px`);
    rootStyle.setProperty('--visual-viewport-width', `${Math.max(0, width)}px`);
    rootStyle.setProperty('--visual-viewport-height', `${Math.max(0, height)}px`);

    // On mobile the map-action toolbar sits above the clock, and it grows a row
    // for every action group. Publish its real height so the clock clears it
    // instead of chasing it with a hardcoded offset.
    const toolbar = document.querySelector('.map-action-toolbar');
    const toolbarHeight = toolbar ? toolbar.getBoundingClientRect().height : 0;
    rootStyle.setProperty('--map-action-toolbar-height', `${Math.round(toolbarHeight)}px`);

    // The elevation strip is a fixed bar across the bottom, and it was burying
    // the map's own bottom-left controls whole — the legend was unreachable
    // (elementFromPoint on it hit the strip's canvas) whenever a track was
    // selected, which is exactly when you want them. Publish its real height so
    // the scale and the legend ride above it instead of under it.
    const dockElement = document.getElementById('elevationDock');
    const dockVisible = dockElement && !dockElement.classList.contains('hidden');
    const dockHeight = dockVisible ? dockElement.getBoundingClientRect().height : 0;
    rootStyle.setProperty('--elevation-dock-height', `${Math.round(dockHeight)}px`);
}

function syncSidebarDom() {
    controlsDiv.classList.toggle('collapsed', !sidebarOpen);
    document.body.classList.toggle('sidebar-open', sidebarOpen);
    controlsDiv.setAttribute('aria-hidden', String(!sidebarOpen && mobileSidebarMedia.matches));
    toggleBtn.textContent = sidebarOpen ? '\u2715' : '\u2630';
    toggleBtn.setAttribute('aria-expanded', String(sidebarOpen));

    // Move toggle out of #controls when collapsed so it escapes the stacking
    // context created by backdrop-filter on the parent (which traps position:fixed).
    if (sidebarOpen) {
        if (toggleBtn.parentElement !== navRow) navRow.appendChild(toggleBtn);
        toggleBtn.classList.remove('floating');
    } else {
        if (toggleBtn.parentElement !== document.body) document.body.appendChild(toggleBtn);
        toggleBtn.classList.add('floating');
    }

    if (controlsScrim) {
        controlsScrim.classList.toggle('hidden', !(sidebarOpen && mobileSidebarMedia.matches));
    }
}

function setSidebarOpen(open) {
    sidebarOpen = open;
    // On mobile, opening the sidebar dismisses ordinary object details so the
    // two stacked panels do not fight for space. The exclusive edit mode keeps
    // its persistent sheet: it is the visible way to leave that mode.
    if (open && mobileSidebarMedia.matches && currentMode !== 'edit'
        && !selectionSheet.classList.contains('hidden')) {
        closeSelectionDisplay();
    }
    syncSidebarDom();
}

function closeSidebarOnMobile() {
    if (mobileSidebarMedia.matches && sidebarOpen) setSidebarOpen(false);
}

const mapLoaderOverlay = document.getElementById('mapLoaderOverlay');
function showMapLoader(text) {
    mapLoaderOverlay.textContent = text || 'Učitavanje...';
    mapLoaderOverlay.style.display = '';
}
function hideMapLoader() {
    mapLoaderOverlay.style.display = 'none';
}

function syncSidebarForViewport(force = false) {
    const isMobileSidebar = mobileSidebarMedia.matches;
    if (force || isMobileSidebar !== wasMobileSidebar) {
        sidebarOpen = !isMobileSidebar;
        wasMobileSidebar = isMobileSidebar;
    }
    syncSidebarDom();
}

toggleBtn.onclick = () => {
    setSidebarOpen(!sidebarOpen);
};

if (controlsScrim) {
    controlsScrim.onclick = () => setSidebarOpen(false);
}

if (typeof mobileSidebarMedia.addEventListener === 'function') {
    mobileSidebarMedia.addEventListener('change', () => syncSidebarForViewport());
} else if (typeof mobileSidebarMedia.addListener === 'function') {
    mobileSidebarMedia.addListener(() => syncSidebarForViewport());
}

window.addEventListener('resize', syncViewportChrome);
window.addEventListener('orientationchange', syncViewportChrome);
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewportChrome);
    window.visualViewport.addEventListener('scroll', syncViewportChrome);
}

syncViewportChrome();
syncSidebarForViewport(true);

// ─── Swipe-to-close for mobile selection sheet ────────────────────────────
(function initSheetSwipe() {
    let startY = 0;
    let currentTranslateY = 0;
    let dragging = false;

    selectionSheet.addEventListener('touchstart', function(e) {
        if (!mobileSidebarMedia.matches || currentMode === 'edit') return;
        if (selectionSheet.scrollTop > 0) return;
        // A touch on the elevation-profile canvas is a PVI drag, not a
        // swipe-to-dismiss — dragging a point downward must not close the sheet.
        if (e.target.closest?.('.sel-profile-canvas')) return;
        startY = e.touches[0].clientY;
        currentTranslateY = 0;
    }, { passive: true });

    selectionSheet.addEventListener('touchmove', function(e) {
        if (!startY) return;
        const deltaY = e.touches[0].clientY - startY;

        if (!dragging) {
            if (deltaY > 0 && selectionSheet.scrollTop <= 0) {
                dragging = true;
                selectionSheet.classList.add('dragging');
            } else {
                return;
            }
        }

        if (dragging) {
            e.preventDefault();
            currentTranslateY = Math.max(0, deltaY);
            selectionSheet.style.transform = `translateY(${currentTranslateY}px)`;
        }
    }, { passive: false });

    selectionSheet.addEventListener('touchend', function() {
        if (dragging) {
            selectionSheet.classList.remove('dragging');
            if (currentTranslateY > 80) {
                selectionSheet.style.transition = 'transform 0.2s ease-out';
                selectionSheet.style.transform = 'translateY(100%)';
                setTimeout(() => {
                    selectionSheet.style.transform = '';
                    selectionSheet.style.transition = '';
                    deselectObject();
                }, 200);
            } else {
                selectionSheet.style.transition = 'transform 0.15s ease-out';
                selectionSheet.style.transform = '';
                setTimeout(() => { selectionSheet.style.transition = ''; }, 150);
            }
        }
        startY = 0;
        dragging = false;
        currentTranslateY = 0;
    }, { passive: true });
})();

function parseWalkTimeValue(value) {
    const parsed = String(parseInt(value, 10));
    return ALLOWED_WALK_TIME_VALUES.has(parsed) ? parsed : null;
}

function normalizeWalkTimeValue(value) {
    return parseWalkTimeValue(value) || DEFAULT_WALK_TIME_VALUE;
}

function loadPersistedWalkTime() {
    try {
        return parseWalkTimeValue(window.localStorage.getItem(WALK_TIME_STORAGE_KEY));
    } catch (error) {
        console.warn('Unable to read saved walk time:', error);
        return null;
    }
}

function persistWalkTime(value) {
    try {
        window.localStorage.setItem(WALK_TIME_STORAGE_KEY, normalizeWalkTimeValue(value));
    } catch (error) {
        console.warn('Unable to persist walk time:', error);
    }
}

function getSelectedWalkTimeValue() {
    return normalizeWalkTimeValue(walkTimeOptions.find(option => option.checked)?.value);
}

function getCurrentWalkMinutes() {
    return parseInt(getSelectedWalkTimeValue(), 10);
}

function syncWalkTimeControls(nextValue, { persist = false } = {}) {
    const walkMinutes = normalizeWalkTimeValue(nextValue);
    walkTimeOptions.forEach(option => {
        option.checked = option.value === walkMinutes;
    });
    if (persist) {
        persistWalkTime(walkMinutes);
    }
}

syncWalkTimeControls(loadPersistedWalkTime() || getSelectedWalkTimeValue());

// ─── Snap Markers ────────────────────────────────────────────────────────────
// Clicks snap only to the planner's own tracks; free map clicks (walk,
// catchment checker, first draft points) use the exact clicked position.
const snapIcon = L.divIcon({ className: 'snap-marker', iconSize: [14, 14], iconAnchor: [7, 7] });
const transferSnapIcon = L.divIcon({ className: 'snap-marker snap-marker-transfer', iconSize: [18, 18], iconAnchor: [9, 9] });
const junctionSnapIcon = L.divIcon({ className: 'snap-marker snap-marker-junction', iconSize: [18, 18], iconAnchor: [9, 9] });
const externalRailSnapIcon = L.divIcon({ className: 'snap-marker snap-marker-external', iconSize: [18, 18], iconAnchor: [9, 9] });
const catchmentOriginIcon = L.divIcon({ className: 'catchment-origin-marker', iconSize: [18, 18], iconAnchor: [9, 9] });

function nearestPointOnSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    const nx = ax + t * dx, ny = ay + t * dy;
    const distSq = (px - nx) * (px - nx) + (py - ny) * (py - ny);
    return { lon: nx, lat: ny, distSq, t };
}

// ─── Track & Line Snapping ───────────────────────────────────────────────
// How far either side of a caller's hint to look before giving up on it. Wide
// enough to absorb a smoothed arc's worth of nodes, narrow enough to be O(1).
const NEAREST_POINT_HINT_WINDOW_SEGMENTS = 48;

// options.nearSegmentIndex: a caller sweeping ALONG the track (building an
// elevation table, walking a profile) already knows roughly where the answer
// is, and rescanning three thousand segments for every one of fourteen thousand
// query points is what made that table cost 300 ms. The hint is only ever an
// optimisation: if the best match lands on the edge of the window the true
// nearest may lie outside it, so the search is redone over the whole track
// rather than returning a plausible wrong answer.
function nearestPointOnTrack(track, lat, lon, options = {}) {
    const pts = track.latlngs;
    const lastSegment = pts.length - 2;
    if (lastSegment < 0) return null;
    const hinted = Number.isInteger(options.nearSegmentIndex);
    const window = options.windowSegments ?? NEAREST_POINT_HINT_WINDOW_SEGMENTS;
    // Clamp the hint itself, not just the window it implies: a hint past either
    // end would otherwise produce from > to, an empty search, and a null where
    // a point exists.
    const hint = hinted ? Math.max(0, Math.min(lastSegment, options.nearSegmentIndex)) : 0;
    const from = hinted ? Math.max(0, hint - window) : 0;
    const to = hinted ? Math.min(lastSegment, hint + window) : lastSegment;

    let best = null;
    for (let i = from; i <= to; i++) {
        const a = pts[i], b = pts[i + 1];
        const p = nearestPointOnSegment(lon, lat, a[1], a[0], b[1], b[0]);
        if (!best || p.distSq < best.distSq) {
            best = { lat: p.lat, lon: p.lon, distSq: p.distSq, segmentIndex: i, t: p.t };
        }
    }
    if (hinted && best
        && ((best.segmentIndex === from && from > 0)
            || (best.segmentIndex === to && to < lastSegment))) {
        return nearestPointOnTrack(track, lat, lon);
    }
    return best;
}

// Nearest point on a chainage interval of a track. Station dragging uses this
// instead of the full-level-only placement helper below: moving a station is a
// profile input, so the grade solver flattens its new footprint after the drop.
// Refusing ramp interiors here made the first node of a ramp behave like a
// one-way wall even though the same solver can make the destination legal.
function nearestPointOnTrackWithinOffsets(track, lat, lon, options = {}) {
    const allowedSegments = options.segmentIndices
        ? new Set(options.segmentIndices)
        : null;
    const chainage = options.chainage || buildTrackChainage(track);
    const minOffsetM = Number.isFinite(options.minOffsetM) ? options.minOffsetM : 0;
    const maxOffsetM = Number.isFinite(options.maxOffsetM) ? options.maxOffsetM : chainage.totalM;
    let best = null;
    for (let segmentIndex = 0; segmentIndex < track.latlngs.length - 1; segmentIndex++) {
        if (allowedSegments && !allowedSegments.has(segmentIndex)) continue;
        const segmentStartM = chainage.offsets[segmentIndex] || 0;
        const segmentEndM = chainage.offsets[segmentIndex + 1] ?? segmentStartM;
        const segmentLengthM = segmentEndM - segmentStartM;
        let fromT = 0;
        let toT = 1;
        if (segmentLengthM > 1e-6) {
            fromT = Math.max(fromT, (minOffsetM - segmentStartM) / segmentLengthM);
            toT = Math.min(toT, (maxOffsetM - segmentStartM) / segmentLengthM);
        } else if (segmentStartM < minOffsetM || segmentStartM > maxOffsetM) {
            continue;
        }
        // A segment wholly outside the permitted chainage interval has no
        // candidate. Clamping first would collapse it onto t=0/1 and let that
        // out-of-bounds node win the distance search — the apparent node wall
        // reported by station dragging.
        if (fromT > 1 + 1e-8 || toT < -1e-8 || toT < fromT - 1e-8) continue;
        fromT = Math.max(0, Math.min(1, fromT));
        toT = Math.max(0, Math.min(1, toT));
        const start = interpolateSegmentPosition(track.latlngs, segmentIndex, fromT);
        const end = interpolateSegmentPosition(track.latlngs, segmentIndex, toT);
        const point = nearestPointOnSegment(lon, lat, start[1], start[0], end[1], end[0]);
        const t = fromT + (toT - fromT) * point.t;
        const candidate = {
            lat: point.lat,
            lon: point.lon,
            distSq: point.distSq,
            segmentIndex,
            t,
            offsetM: segmentStartM + segmentLengthM * t,
            level: getContinuousTrackLevel(track, segmentIndex, t),
        };
        if (!best || candidate.distSq < best.distSq) best = candidate;
    }
    return best;
}

// New-station placement and station reprojection after a route-node edit stay
// on flat full-level segments (or a ramp endpoint). A direct station drag uses
// nearestPointOnTrackWithinOffsets above because the moved platform itself
// becomes a grade-solver constraint at its new chainage.
function nearestFullLevelPointOnTrack(track, lat, lon, options = {}) {
    const allowedSegments = options.segmentIndices
        ? new Set(options.segmentIndices)
        : null;
    // A vertex drag reprojects its stations on every frame, so a caller that
    // already holds the chainage passes it in rather than paying for another
    // whole-track walk.
    const chainage = options.chainage || buildTrackChainage(track);
    const minOffsetM = Number.isFinite(options.minOffsetM) ? options.minOffsetM : 0;
    const maxOffsetM = Number.isFinite(options.maxOffsetM) ? options.maxOffsetM : chainage.totalM;
    let best = null;
    const consider = (candidate) => {
        if (!best || candidate.distSq < best.distSq) best = candidate;
    };
    const considerInterval = (segmentIndex, fromT, toT, level) => {
        if (allowedSegments && !allowedSegments.has(segmentIndex)) return;
        const segmentStartM = chainage.offsets[segmentIndex] || 0;
        const segmentEndM = chainage.offsets[segmentIndex + 1] ?? segmentStartM;
        const segmentLengthM = segmentEndM - segmentStartM;
        let clippedFromT = fromT;
        let clippedToT = toT;
        if (segmentLengthM > 1e-6) {
            clippedFromT = Math.max(clippedFromT, (minOffsetM - segmentStartM) / segmentLengthM);
            clippedToT = Math.min(clippedToT, (maxOffsetM - segmentStartM) / segmentLengthM);
        } else if (segmentStartM < minOffsetM || segmentStartM > maxOffsetM) {
            return;
        }
        if (clippedFromT > 1 + 1e-8
            || clippedToT < -1e-8
            || clippedToT < clippedFromT - 1e-8) return;
        clippedFromT = Math.max(0, Math.min(1, clippedFromT));
        clippedToT = Math.max(0, Math.min(1, clippedToT));
        const start = interpolateSegmentPosition(track.latlngs, segmentIndex, clippedFromT);
        const end = interpolateSegmentPosition(track.latlngs, segmentIndex, clippedToT);
        const p = nearestPointOnSegment(lon, lat, start[1], start[0], end[1], end[0]);
        const t = clippedFromT + (clippedToT - clippedFromT) * p.t;
        consider({
            lat: p.lat,
            lon: p.lon,
            distSq: p.distSq,
            segmentIndex,
            t,
            offsetM: segmentStartM + segmentLengthM * t,
            level,
        });
    };
    for (let i = 0; i < track.latlngs.length - 1; i++) {
        if (allowedSegments && !allowedSegments.has(i)) continue;
        const profile = getTrackSegmentLevelProfile(track, i);
        if (profile.fromLevel === profile.toLevel) {
            if (isFullTrackLevel(profile.fromLevel)) {
                considerInterval(i, 0, 1, Math.round(profile.fromLevel));
            }
            continue;
        }
        if (isFullTrackLevel(profile.fromLevel)) {
            considerInterval(i, 0, profile.rampStartT, Math.round(profile.fromLevel));
        }
        if (isFullTrackLevel(profile.toLevel)) {
            considerInterval(i, profile.rampEndT, 1, Math.round(profile.toLevel));
        }
    }
    return best;
}

function nearestCompatiblePointOnTrack(track, lat, lon, options = {}) {
    const requiredLevel = Number.isInteger(options.requiredLevel)
        ? normalizeTrackLevel(options.requiredLevel)
        : null;
    const fullLevelOnly = !!options.fullLevelOnly;
    const levelTolerance = 0.02;
    let best = null;
    for (let i = 0; i < track.latlngs.length - 1; i++) {
        const a = track.latlngs[i];
        const b = track.latlngs[i + 1];
        const point = nearestPointOnSegment(lon, lat, a[1], a[0], b[1], b[0]);
        const continuousLevel = getContinuousTrackLevel(track, i, point.t);
        const fullLevel = Math.round(continuousLevel);
        if (fullLevelOnly && Math.abs(continuousLevel - fullLevel) > levelTolerance) continue;
        if (requiredLevel != null && Math.abs(continuousLevel - requiredLevel) > levelTolerance) continue;
        if (!best || point.distSq < best.distSq) {
            best = {
                lat: point.lat,
                lon: point.lon,
                distSq: point.distSq,
                segmentIndex: i,
                t: point.t,
                level: Math.abs(continuousLevel - fullLevel) <= levelTolerance
                    ? normalizeTrackLevel(fullLevel)
                    : continuousLevel,
            };
        }
    }
    return best;
}

function snapToTrack(lat, lon, maxScreenPx, options = {}) {
    let best = null;
    const maxDist = maxScreenPx ? pixelsToLatDeg(maxScreenPx) : 0.001;
    for (const track of project.tracks) {
        if (options.excludeTrackId != null && track.id === options.excludeTrackId) continue;
        if (options.gauge && normalizeGauge(track.gauge) !== normalizeGauge(options.gauge)) continue;
        const p = nearestCompatiblePointOnTrack(track, lat, lon, options);
        if (p && (!best || p.distSq < best.distSq)) {
            best = {
                lat: p.lat,
                lon: p.lon,
                distSq: p.distSq,
                trackId: track.id,
                segmentIndex: p.segmentIndex,
                t: p.t,
                level: p.level,
            };
        }
    }
    if (!best) return null;
    const dist = Math.sqrt(best.distSq);
    if (dist > maxDist) return null;
    return {
        latlng: L.latLng(best.lat, best.lon),
        trackId: best.trackId,
        segmentIndex: best.segmentIndex,
        t: best.t,
        level: best.level,
    };
}

// ─── Track Splitting (Junction Support) ─────────────────────────────────
const JUNCTION_ENDPOINT_THRESHOLD_METERS = 10;
const JUNCTION_CONNECTIVITY_THRESHOLD_METERS = 1;
const JUNCTION_EXISTING_VERTEX_THRESHOLD_METERS = 0.25;

function getTrackEndpointLevel(track, endpoint) {
    if (!track?.latlngs?.length) return 0;
    return normalizeTrackLevel(endpoint === 'start'
        ? track.levels?.[0]
        : track.levels?.[track.latlngs.length - 1]);
}

function trackEndpointsAreCompatible(track, endpoint, other, otherEndpoint) {
    return normalizeGauge(track?.gauge) === normalizeGauge(other?.gauge)
        && getTrackEndpointLevel(track, endpoint) === getTrackEndpointLevel(other, otherEndpoint);
}

function isNearTrackEndpoint(track, lat, lng) {
    if (!track.latlngs || track.latlngs.length < 2) return null;
    const first = track.latlngs[0];
    const last = track.latlngs[track.latlngs.length - 1];
    const distToStart = distanceMetersLatLng(lat, lng, first[0], first[1]);
    const distToEnd = distanceMetersLatLng(lat, lng, last[0], last[1]);
    if (distToStart <= JUNCTION_ENDPOINT_THRESHOLD_METERS && distToStart <= distToEnd) return 'start';
    if (distToEnd <= JUNCTION_ENDPOINT_THRESHOLD_METERS) return 'end';
    return null;
}

// Creates a fully initialised runtime track object with layers and handlers.
// levels is a per-vertex array (-1 underground / 0 surface / +1 elevated); defaults to surface.
// Passing savedElectrification suppresses new-track defaults, including when its fields are null.
function createRuntimeTrack(
    gauge,
    latlngs,
    levels,
    savedElectrification = undefined,
    { deferVerticalProfile = false } = {},
) {
    const normalizedGauge = normalizeGauge(gauge);
    const lineGeoJSON = turf.lineString(latlngs.map(p => [p[1], p[0]]));
    const lengthKm = turf.length(lineGeoJSON, { units: 'kilometers' });
    const style = getTrackStyle(normalizedGauge);
    const layer = L.polyline(latlngs, style).addTo(map);
    const electrificationApi = window.__trackElectrification;
    const sourceFields = savedElectrification === undefined
        ? electrificationApi.authoredDefaultFields(normalizedGauge)
        : electrificationApi.normalizeAuthoredFields(savedElectrification || {});
    const electrificationSegments = electrificationApi.normalizeElectrificationSegments(
        savedElectrification?.electrificationSegments,
        lengthKm * 1000,
    );
    const track = {
        id: allocateTrackId(),
        gauge: normalizedGauge,
        ...TRACK_TOPOLOGY_API.normalize(savedElectrification || {}),
        latlngs,
        levels: Array.isArray(levels) && levels.length === latlngs.length
            ? levels.map(normalizeTrackElevationLevel)
            : latlngs.map(() => 0),
        lengthKm,
        electrified: sourceFields.electrified,
        voltage: sourceFields.voltage,
        frequency: sourceFields.frequency,
        electrificationSegments,
        reference: savedElectrification?.reference && typeof savedElectrification.reference === 'object'
            ? { ...savedElectrification.reference }
            : undefined,
        motionProfile: null,
        layer,
    };
    track.cost = computeTrackConstructionCost(track);
    createTrackHitLayer(track);
    attachTrackClickHandler(track);
    buildTrackMotionProfile(track);
    rebuildTrackDecor(track);
    if (!deferVerticalProfile) scheduleTrackVerticalProfile(track);
    return track;
}

// ---------------------------------------------------------------------------
// Vertical profile (project v10): every track carries an auto-solved vertical
// alignment — terrain from POST /api/terrain/profile, grade from
// window.__plannerGrade (planner-grade/grade-solver.js), stored in the shape
// window.__verticalProfile defines. Recomputed (debounced, token-guarded)
// whenever geometry, gauge or station chainages change; keyed by a profile
// input hash so a fresh profile is never recomputed and a stale one is never
// saved. A failed
// compute (API down, route entirely off the DEM) leaves the track without a
// profile — a valid state; the next geometry change retries.
const TERRAIN_PROFILE_STEP_M = 20;
const VERTICAL_PROFILE_DEBOUNCE_MS = 600;
// ─── Three station types, by how the route sits in the ground ───────────────
// A station is a rigid level structure, and how MUCH route it makes rigid
// depends on what has to be built around the platform:
//
//   surface   60 m — the bare platform. A cut, a fill and plain at-grade are
//                    all the same building here: the trackbed is simply level
//                    and the earthworks around it take whatever shape they need.
//   elevated 100 m — platform plus a deck that has to widen for it and taper
//                    back to running width at each end. Shorter than the
//                    underground flare because a deck widens far more cheaply
//                    than a bored throat.
//   tunnel   170 m — platform hall plus two rigid 55 m throats where the tracks
//                    flare to ±6.6 m. The shell clears the flared trackbed by
//                    barely a metre, so the WHOLE box must be straight and level.
//
// The type follows the display vocabulary (tunel / na terenu / vijadukt), so
// lowering a platform past the 8 m tunnel rule lengthens it to 170 m and
// raising it back shortens it again — the structure follows the depth, which is
// what the strip shows you as the bar changes length under the drag.
const STATION_PROFILE_DEFAULT_HALF_SPAN_M = UNDERGROUND_STATION_CORE_HALF_LENGTH_METERS;
const STATION_PROFILE_UNDERGROUND_HALF_SPAN_M =
    UNDERGROUND_STATION_CORE_HALF_LENGTH_METERS + UNDERGROUND_STATION_FLARE_LENGTH_METERS;
const ELEVATED_STATION_FLARE_LENGTH_METERS = 20;
const STATION_PROFILE_ELEVATED_HALF_SPAN_M =
    UNDERGROUND_STATION_CORE_HALF_LENGTH_METERS + ELEVATED_STATION_FLARE_LENGTH_METERS;

// Which of the three structures this station is, read STRAIGHT FROM THE PROFILE
// at its chainage — the same tunel/na terenu/vijadukt call the map colours by.
//
// Not from track.levels. Those are derived from the profile, then quantised, and
// resolveStationFullLevelPlacement additionally demands a 50 m run of one full
// level before it will report anything but 0. Lowering a platform to −8.5 m
// therefore left it reporting "surface" (its −1 run was shorter than 50 m after
// ramp shaping), so the structure that is supposed to follow the depth reported
// the wrong type — and sometimes the type it had one edit ago.
//
// Falls back to the derived level only when there is no solved profile yet.
// NB: guarded on the profile EXISTING, never on trackHasFreshAslProfile —
// freshness folds in currentTrackProfileHash → trackProfileStationInputs →
// stationProfileHalfSpanM → back here, which is an infinite recursion. A
// marginally stale profile still answers this question far better than the
// quantised levels do.
function getStationStructureKind(track, station) {
    if (track?.verticalProfile?.pvis?.length >= 2 && Array.isArray(station?.latlng)) {
        const dM = trackChainageAtLatLng(track, station.latlng[0], station.latlng[1]);
        const elevAslM = window.__verticalProfile.elevAtChainage(track.verticalProfile, dM);
        // Hashing station spans happens both before and after the runtime DGU
        // cache arrives. Prefer the terrain embedded in the solved profile in
        // BOTH phases; switching sources mid-fetch can change full/compact/cut,
        // invalidate the in-flight hash, and leave "Računa se…" forever.
        const profileTerrainAslM = window.__verticalProfile.terrainAtChainage(
            track.verticalProfile,
            dM,
        );
        const terrainAslM = Number.isFinite(profileTerrainAslM)
            ? profileTerrainAslM
            : terrainAslAtChainage(track, dM);
        if (Number.isFinite(elevAslM) && Number.isFinite(terrainAslM)
            && elevAslM < terrainAslM - 0.25) {
            const vertical = window.__stationContract.classifyStationVerticalForm({
                railElevAslM: elevAslM,
                terrainSamplesAslM: [terrainAslM],
            });
            if (vertical.form === window.__stationContract.STATION_VERTICAL_FORM.FULL) return 'tunnel';
            if (vertical.form === window.__stationContract.STATION_VERTICAL_FORM.COMPACT_COVERED) {
                return 'covered';
            }
            return 'cut';
        }
        const state = window.__verticalProfile.displayStateAtChainage(
            track.verticalProfile, dM, (d) => terrainAslAtChainage(track, d),
        );
        if (state === 'viaduct') return 'elevated';
        if (state) return 'surface';
    }
    const level = getStationLevel(station);
    return level < 0 ? 'tunnel' : level > 0 ? 'elevated' : 'surface';
}

function halfSpanForKind(kind) {
    switch (kind) {
        case 'tunnel': return STATION_PROFILE_UNDERGROUND_HALF_SPAN_M;
        case 'covered':
        case 'cut':
            return STATION_PROFILE_DEFAULT_HALF_SPAN_M;
        case 'elevated': return STATION_PROFILE_ELEVATED_HALF_SPAN_M;
        default: return STATION_PROFILE_DEFAULT_HALF_SPAN_M;
    }
}

function stationProfileHalfSpanM(station) {
    const track = station?.trackId != null
        ? project.tracks.find((candidate) => candidate.id === station.trackId)
        : null;
    return halfSpanForKind(getStationStructureKind(track, station));
}

// The structure a platform WILL be once it sits at `elevAslM` — the same three
// display states, but decided from a target elevation instead of the profile as
// it stands. A drag that carries a platform past the tunnel rule changes which
// structure it is, and therefore how long it is; asking the current profile
// would answer with the structure it is leaving.
function stationKindForElevation(track, dM, elevAslM) {
    const profileTerrainAslM = window.__verticalProfile.terrainAtChainage(
        track?.verticalProfile,
        dM,
    );
    const terrainAslM = Number.isFinite(profileTerrainAslM)
        ? profileTerrainAslM
        : terrainAslAtChainage(track, dM);
    if (!Number.isFinite(terrainAslM) || !Number.isFinite(elevAslM)) return null;
    const api = window.__verticalProfile;
    const rel = elevAslM - terrainAslM;
    if (rel >= api.DISPLAY_DEPTH_THRESHOLD_M) return 'elevated';
    if (rel < -0.25) {
        const vertical = window.__stationContract.classifyStationVerticalForm({
            railElevAslM: elevAslM,
            terrainSamplesAslM: [terrainAslM],
        });
        if (vertical.form === window.__stationContract.STATION_VERTICAL_FORM.FULL) return 'tunnel';
        if (vertical.form === window.__stationContract.STATION_VERTICAL_FORM.COMPACT_COVERED) {
            return 'covered';
        }
        return 'cut';
    }
    return 'surface';
}

// The full structure length a station claims along the route.
function stationProfileSpanLengthM(station) {
    return stationProfileHalfSpanM(station) * 2;
}
// v2 fixed overlapping DGU sheets where a NoData pixel in the first tile hid
// valid band data in the second. v3 (2026-07-24) moves the profile onto the
// ROUTE's chainage domain instead of the terrain API's — see
// normalizeTerrainProfileToRoute. Every profile saved before it has PVIs on the
// old, ~0.15 % longer domain; the geometry hash cannot see that, so it goes in
// the revision instead and those profiles are re-solved on load. The author's
// pinned elevations are geo-anchored and survive the re-solve.
// v4 (2026-07-31) makes the solver separate the passes of a self-crossing
// (spiral/loop) route; profiles solved before it could hold a level
// self-intersection and must re-solve.
// v5 (2026-07-31) re-baselines terrain: /terrain/profile now samples the DTM
// bilinearly (matching /terrain/grid's surface), where it used to return the
// nearest cell value — a 20 m staircase whose half-cell-of-slope error was
// baked into every stored terrainAslM. Stored profiles keep their authored
// pvis; on next load the stale hash routes them through
// rederiveTrackProfileFromPvis, which refreshes terrain, regimes and cost
// against the interpolated surface the 3D world already reads.
const TERRAIN_REFERENCE = CITY_CONFIG.terrainReference || {};
const TERRAIN_PROVIDER_STACK_REVISION = Array.isArray(CITY_CONFIG.providers?.terrain)
    ? CITY_CONFIG.providers.terrain.join(',')
    : String(CITY_CONFIG.providers?.terrain || 'none');
const VERTICAL_PROFILE_INPUT_REVISION = [
    window.__verticalProfile.INPUT_REVISION,
    TERRAIN_PROVIDER_STACK_REVISION,
    TERRAIN_REFERENCE.revision || CITY_CONFIG.dataRevision || 'unversioned',
].join('|');

// The geometry hash walks every vertex, and it guards caches that are consulted
// PER POINT — getLineElevationProfile samples one elevation per motion-profile
// vertex, and each sample re-hashed the whole track twice. That is O(n²): the
// 4847-vertex Knin–Zadar reconstruction took 144 s to open, the 2527-vertex M604
// 55 s, which is not "clickable" in any useful sense.
//
// So the hash is memoised for the CURRENT TASK only. A microtask clears it, so a
// synchronous burst of guard calls shares one hash while anything that can
// mutate geometry — always a later task, or an explicit invalidation below —
// starts from a clean memo. The vertex count is checked too, which catches an
// in-task push/splice exactly.
let trackHashMemo = new WeakMap();
let trackHashMemoScheduled = false;

function memoisedTrackHash(track, kind, compute) {
    if (!track) return compute();
    if (!trackHashMemoScheduled) {
        trackHashMemoScheduled = true;
        queueMicrotask(() => {
            trackHashMemoScheduled = false;
            invalidateTrackHashMemo();          // WeakMap has no clear(); swap it
        });
    }
    const vertexCount = track.latlngs?.length ?? -1;
    let entry = trackHashMemo.get(track);
    if (!entry || entry.vertexCount !== vertexCount) {
        entry = { vertexCount };
        trackHashMemo.set(track, entry);
    }
    if (entry[kind] === undefined) entry[kind] = compute();
    return entry[kind];
}

// Belt and braces for a mutation that happens in the SAME task as a guard call:
// every geometry edit path funnels through afterTrackGeometryChange.
function invalidateTrackHashMemo(track = null) {
    if (track) trackHashMemo.delete(track);
    else trackHashMemo = new WeakMap();
}

// The profile itself participates in station-envelope inputs: changing the
// solved depth can turn a 60 m surface stop into a 170 m tunnel station. Never
// assign a profile without dropping the same-task hash memo, or the fixpoint
// loop compares its new profile against the previous profile's cached hash and
// falsely declares convergence.
function setTrackVerticalProfile(track, profile) {
    track.verticalProfile = profile;
    invalidateTrackHashMemo(track);
}

function currentTrackGeomHash(track) {
    return memoisedTrackHash(track, 'geom', () => window.__verticalProfile.trackGeometryHash(
        track.latlngs,
        normalizeGauge(track.gauge),
        VERTICAL_PROFILE_INPUT_REVISION,
    ));
}

// Station spans for the elevation strip, each tagged with whether the structure
// actually fits on the route. A station squeezed off the end has its span
// clamped into a half-length platform — an illegal state the sheet reports, and
// which the strip must paint red too. A fault the strip cannot show is a fault
// the user has to go hunting for.
function trackProfileStationMarks(track) {
    const chainages = trackVertexChainages(track);
    const routeLengthM = chainages[chainages.length - 1] || 0;
    const byChainage = project.stations
        .filter((station) => station.trackId === track.id && Array.isArray(station.latlng))
        .map((station) => ({
            station,
            dM: trackChainageAtLatLng(track, station.latlng[0], station.latlng[1]),
        }))
        .filter((entry) => Number.isFinite(entry.dM));
    const profile = track.verticalProfile;
    const profileStepM = Number(profile?.stepM);
    const profileSampleCount = Array.isArray(profile?.elevAslM) ? profile.elevAslM.length : 0;
    const snapSpanToSolvedGrid = (input) => {
        if (!(profileStepM > 0) || profileSampleCount < 2) return input;
        const requested0 = Number(input.dM0);
        const requested1 = Number(input.dM1);
        if (!Number.isFinite(requested0) || !Number.isFinite(requested1)) return input;
        const lo = Math.min(requested0, requested1);
        const hi = Math.max(requested0, requested1);
        // The grade solver rounds station constraints OUTWARD to its sampled
        // chainage grid. Draw the station to those same boundaries, so its two
        // square edge anchors replace (rather than sit just inside) the
        // structural PVIs that hold the level platform.
        const nearbyPviDM = (target, fallback, side) => {
            let nearest = null;
            let nearestDistance = Infinity;
            for (const pvi of profile.pvis || []) {
                const dM = Number(pvi.dM);
                if ((side < 0 && dM > target + 1e-6) || (side > 0 && dM < target - 1e-6)) continue;
                const distance = Math.abs(dM - target);
                if (distance < nearestDistance) {
                    nearest = dM;
                    nearestDistance = distance;
                }
            }
            return nearestDistance <= profileStepM + 1e-6 ? nearest : fallback;
        };
        const dM0 = nearbyPviDM(lo, Math.max(0, Math.floor(lo / profileStepM) * profileStepM), -1);
        const dM1 = nearbyPviDM(hi, Math.min(routeLengthM, Math.ceil(hi / profileStepM) * profileStepM), 1);
        return { ...input, dM0, dM1 };
    };
    return (trackProfileStationInputs(track) || [])
        .map(snapSpanToSolvedGrid)
        .map((input) => {
            const dM = Number(input.dM);
            if (!Number.isFinite(dM)) return null;
            // Match the span back to its station so the required length is the
            // one that station's structure actually needs.
            let owner = null, bestDistM = Infinity;
            for (const entry of byChainage) {
                const distM = Math.abs(entry.dM - dM);
                if (distM < bestDistM) { bestDistM = distM; owner = entry; }
            }
            const requiredHalfSpanM = owner ? stationProfileHalfSpanM(owner.station) : null;
            const fits = !owner || !Number.isFinite(requiredHalfSpanM)
                || stationFitsOnTrack(track, owner.dM, requiredHalfSpanM);
            // A station is a BOX, not a line on the track. The strip draws it as
            // one so a roof standing out of the ground is visible where it
            // happens, instead of being a number in the station's sheet. The
            // dimensions are the station's own — see station-contract.js.
            const kind = owner ? getStationStructureKind(track, owner.station) : null;
            const box = ['tunnel', 'covered', 'cut'].includes(kind)
                ? window.__stationContract.describeStation(
                    window.__stationContract.UNDERGROUND_STATION_TYPE_ID,
                    { runningTrackSpacingM: getTrackCenterSpacingMeters(track.gauge) },
                )
                : null;
            return {
                dM,
                dM0: Number(input.dM0),
                dM1: Number(input.dM1),
                fits,
                requiredLengthM: Number.isFinite(requiredHalfSpanM) ? requiredHalfSpanM * 2 : null,
                routeLengthM,
                name: owner ? getStationDisplayName(owner.station) : '',
                kind,
                // A depot is priced off its own base, so the object list has to
                // know which of the two this platform is.
                stationType: owner?.station?.stationType === 'depot' ? 'depot' : 'normal',
                box: box ? {
                    heightAboveRailM: box.envelope.heightAboveRailM,
                    requiredCoverM: box.requirements.minDepthBelowGroundM,
                    lengthM: box.envelope.lengthM,
                    compact: {
                        ...window.__stationContract.COMPACT_COVERED_STATION,
                    },
                } : null,
            };
        })
        .filter(Boolean);
}

// Only these semantic inputs alter the vertical solve. A station lives on the
// rounded motion route, while the profile is indexed on the editable control
// line: map the complete rendered footprint back to a raw-chainage envelope.
// Moving/adding/removing a platform then invalidates the solve; renaming it does
// not.
function trackProfileStationInputs(track) {
    if (!track || !Array.isArray(track.latlngs) || track.latlngs.length < 2) return [];
    const stations = project.stations
        .filter((station) => station.trackId === track.id && Array.isArray(station.latlng))
        .map((station) => ({ station, halfSpanM: stationProfileHalfSpanM(station) }))
        .slice()
        .sort((a, b) => a.station.latlng[0] - b.station.latlng[0]
            || a.station.latlng[1] - b.station.latlng[1]);
    const cacheKey = `${currentTrackGeomHash(track)}|${stations.map(({ station, halfSpanM }) => (
        `${Number(station.latlng[0]).toFixed(7)},${Number(station.latlng[1]).toFixed(7)},${halfSpanM}`
    )).join(';')}`;
    if (track._profileStationInputs?.cacheKey === cacheKey) {
        return track._profileStationInputs.inputs;
    }
    const renderedLatLngs = profileToVertexOffsets(track.motionProfile).map((vertex) => [
        vertex.latlng.lat,
        vertex.latlng.lng,
    ]);
    const inputs = stations
        .map(({ station, halfSpanM }) => {
            const renderedSpan = window.__verticalProfile.stationProfileSpanFromRenderedRoute(
                track.latlngs,
                renderedLatLngs,
                station.latlng,
                halfSpanM,
            );
            if (renderedSpan) return renderedSpan;
            const dM = trackChainageAtLatLng(track, station.latlng[0], station.latlng[1]);
            const chainages = trackVertexChainages(track);
            const lengthM = chainages[chainages.length - 1] || 0;
            return {
                dM,
                dM0: Math.max(0, dM - halfSpanM),
                dM1: Math.min(lengthM, dM + halfSpanM),
            };
        })
        .filter((station) => Number.isFinite(station.dM))
        .sort((a, b) => a.dM - b.dM);
    track._profileStationInputs = { cacheKey, inputs };
    return inputs;
}

function currentTrackProfileHash(track) {
    return memoisedTrackHash(track, 'profile', () => window.__verticalProfile.trackGeometryHash(
        track.latlngs,
        normalizeGauge(track.gauge),
        VERTICAL_PROFILE_INPUT_REVISION,
        trackProfileStationInputs(track),
    ));
}

function scheduleTrackVerticalProfile(track) {
    if (!window.__verticalProfile || !window.__plannerGrade) return;
    clearTimeout(track._verticalProfileTimer);
    track._verticalProfileTimer = setTimeout(() => {
        void computeTrackVerticalProfile(track);
    }, VERTICAL_PROFILE_DEBOUNCE_MS);
}

// Clear both halves of profile work. Clearing the debounce prevents a queued
// solve; advancing the token makes an already-running fetch harmless when it
// eventually returns. Saved-project hydration calls this before adopting its
// authoritative profile, so an eager station-less solve can never overwrite it.
function cancelTrackVerticalProfileWork(track) {
    if (!track) return;
    clearTimeout(track._verticalProfileTimer);
    track._verticalProfileTimer = null;
    track._verticalProfileToken = (track._verticalProfileToken || 0) + 1;
}

// Fetches (and caches on the track, keyed by geometry hash) the raw terrain the
// solver and elevation edits need. This dense working cache is runtime-only;
// the solved verticalProfile separately persists terrainAslM for instant display.
// ONE chainage domain for a track.
//
// The terrain API measures the polyline it is handed with its own geodesy and
// returns chainages on THAT length: 6239.03 m where turf, haversine and
// vertexChainagesMeters all agree on 6229.72 m — 9.3 m (0.15 %) apart over 6 km.
// Every profile the solver built then lived on the API's domain while stations,
// the strip's x-axis, the map and the costs lived on the client's, and that
// sliver of profile past the end of the route is where things kept going wrong:
// the route's last node rendered off the plot, a station at the end could not
// reach it, its span stopped short of it, and node deletion needed a special
// case. Four separate workarounds for one disagreement.
//
// So normalise once, at the source. The API's samples are a uniform grid with a
// partial last step, which is exactly the shape stepChainages models, so
// rescaling dM and stepM by the same factor preserves that shape while moving
// the whole profile onto the route's own length. The samples shift by at most
// 9 m over 6 km — well inside the 20 m sampling interval, and against a 20 m DEM.
function normalizeTerrainProfileToRoute(points, stepM, routeLengthM) {
    const rows = Array.isArray(points) ? points : [];
    const apiLengthM = rows.length > 0 ? Number(rows[rows.length - 1]?.dM) : NaN;
    if (!Number.isFinite(apiLengthM) || apiLengthM <= 0
        || !Number.isFinite(routeLengthM) || routeLengthM <= 0) {
        return { points: rows, stepM };
    }
    const scale = routeLengthM / apiLengthM;
    if (Math.abs(scale - 1) < 1e-9) return { points: rows, stepM };
    return {
        points: rows.map((row) => ({ ...row, dM: Number(row.dM) * scale })),
        stepM: Number(stepM) * scale,
    };
}

// /terrain/profile accepts at most 500 vertices per request, so a long route has
// to be asked for in pieces. Without this a 2527-vertex reconstruction just got a
// 400 and silently lost its terrain: no terrain line under the elevation strip,
// and photo rides fall back to the coarse levels because the registration sample
// never arrives. Chunks share their boundary vertex so the seams line up, and the
// duplicated sample is dropped when they are concatenated.
const TERRAIN_PROFILE_MAX_VERTICES = 400;
const TERRAIN_PROFILE_REQUEST_TIMEOUT_MS = 12_000;
const TERRAIN_PROFILE_REQUEST_ATTEMPTS = 2;

async function fetchTerrainProfileChunk(coordinates, source) {
    return window.__terrainProfileFetch.fetchJsonWithRetry(fetch, TERRAIN_PROFILE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coordinates, stepM: TERRAIN_PROFILE_STEP_M, source }),
    }, {
        attempts: TERRAIN_PROFILE_REQUEST_ATTEMPTS,
        timeoutMs: TERRAIN_PROFILE_REQUEST_TIMEOUT_MS,
        onRetry: ({ attempt, attempts, error }) => {
            console.warn(`[terrain] profile request failed (${attempt}/${attempts}); retrying:`,
                error?.message || error);
        },
    });
}

async function fetchTerrainProfilePoints(latlngs) {
    const source = getPlannerTerrainSource();
    const coordinates = latlngs.map(([lat, lng]) => [lng, lat]);
    if (coordinates.length <= TERRAIN_PROFILE_MAX_VERTICES) {
        return fetchTerrainProfileChunk(coordinates, source);
    }
    const points = [];
    const sources = new Map();
    let offsetM = 0;
    let stepM = TERRAIN_PROFILE_STEP_M;
    let datum = null;
    let surfaceType = null;
    let quality = null;
    for (let start = 0; start < coordinates.length - 1; start += TERRAIN_PROFILE_MAX_VERTICES - 1) {
        const chunk = coordinates.slice(start, start + TERRAIN_PROFILE_MAX_VERTICES);
        if (chunk.length < 2) break;
        const profile = await fetchTerrainProfileChunk(chunk, source);
        stepM = Number(profile.stepM) || stepM;
        datum ||= typeof profile.datum === 'string' ? profile.datum : null;
        surfaceType ||= typeof profile.surfaceType === 'string' ? profile.surfaceType : null;
        quality ||= typeof profile.quality === 'string' ? profile.quality : null;
        for (const providerSource of profile.sources || []) {
            if (typeof providerSource?.key === 'string') {
                sources.set(providerSource.key, providerSource);
            }
        }
        for (const point of profile.points || []) {
            if (points.length > 0 && Number(point.dM) === 0) continue;   // shared boundary sample
            points.push({ ...point, dM: offsetM + Number(point.dM) });
        }
        offsetM = points.length ? Number(points[points.length - 1].dM) : offsetM;
    }
    return {
        points,
        stepM,
        source,
        sources: [...sources.values()],
        datum,
        surfaceType,
        quality,
    };
}

function terrainProvenanceFromResponse(profile, requestedSource) {
    const sources = (Array.isArray(profile?.sources) ? profile.sources : [])
        .slice(0, 8)
        .flatMap((source) => {
            if (!source || typeof source !== 'object' || typeof source.key !== 'string') return [];
            const resolutionM = typeof source.resolutionM === 'number'
                && Number.isFinite(source.resolutionM) ? source.resolutionM : null;
            return [{
                key: source.key,
                provider: typeof source.provider === 'string' ? source.provider : null,
                product: typeof source.product === 'string' ? source.product : null,
                revision: typeof source.revision === 'string' ? source.revision : null,
                resolutionM,
                horizontalCrs: typeof source.horizontalCrs === 'string'
                    ? source.horizontalCrs : null,
                verticalReference: typeof source.verticalReference === 'string'
                    ? source.verticalReference : null,
                surfaceType: source.surfaceType === 'terrain' || source.surfaceType === 'surface'
                    ? source.surfaceType : null,
            }];
        });
    return {
        requestedSource: typeof profile?.source === 'string' ? profile.source : requestedSource,
        horizontalCrs: sources[0]?.horizontalCrs || TERRAIN_REFERENCE.horizontalCrs || null,
        verticalReference: typeof profile?.datum === 'string'
            ? profile.datum : TERRAIN_REFERENCE.verticalReference || null,
        surfaceType: profile?.surfaceType === 'terrain' || profile?.surfaceType === 'surface'
            ? profile.surfaceType : TERRAIN_REFERENCE.surfaceType || null,
        unit: TERRAIN_REFERENCE.unit || 'm',
        revision: TERRAIN_REFERENCE.revision || CITY_CONFIG.dataRevision || null,
        quality: typeof profile?.quality === 'string' ? profile.quality : null,
        sources,
    };
}

async function fetchTerrainProfileForTrack(track) {
    const geomHash = currentTrackGeomHash(track);
    const source = getPlannerTerrainSource();
    if (track._terrainProfile?.geomHash === geomHash
        && track._terrainProfile?.source === source) return track._terrainProfile;
    const profile = await fetchTerrainProfilePoints(track.latlngs);
    const chainages = trackVertexChainages(track);
    const normalized = normalizeTerrainProfileToRoute(
        profile.points, profile.stepM, chainages[chainages.length - 1],
    );
    track._terrainProfile = {
        geomHash,
        source,
        stepM: normalized.stepM,
        points: normalized.points,
        provenance: terrainProvenanceFromResponse(profile, source),
    };
    return track._terrainProfile;
}

function hydrateTrackTerrainProfileFromSavedProfile(track) {
    if (!trackHasFreshAslProfile(track)) return false;
    const source = getPlannerTerrainSource();
    const terrain = window.__verticalProfile.runtimeTerrainProfileFromSavedProfile(
        track.verticalProfile,
        {
            geomHash: currentTrackGeomHash(track),
            source,
            inputRevision: VERTICAL_PROFILE_INPUT_REVISION,
        },
    );
    if (!terrain) return false;
    track._terrainProfile = terrain;
    return true;
}

// A loaded project restores the solved verticalProfile but NOT the runtime-only
// terrain sample the grade solver needs. Without it, rederiveTrackProfileFromPvis
// bails (returns false) and every node elevation edit silently no-ops — the grade
// never changes, so the project later saves as "identical". Ensure the terrain is
// cached (fetching on demand) before any edit re-solves the profile.
async function ensureTrackTerrainProfile(track) {
    const source = getPlannerTerrainSource();
    if (track._terrainProfile?.geomHash === currentTrackGeomHash(track)
        && track._terrainProfile?.source === source) return true;
    try {
        await fetchTerrainProfileForTrack(track);
        return track._terrainProfile?.geomHash === currentTrackGeomHash(track)
            && track._terrainProfile?.source === source;
    } catch (err) {
        console.warn('[elevation] terrain profile fetch failed — edit cannot re-solve:', err?.message || err);
        return false;
    }
}

// Solves the vertical alignment from cached terrain and stores it on the
// track. lockedPvis defaults to the locks already on the profile, so a
// recompute (geometry nudge) preserves the user's pinned elevations.
// Levels are derived, never edited: the profile's regimes decide which part
// of the track is which level, and every level consumer — level-based pricing,
// the ±1-keyed underground/elevated station structures, the flat 3D world's
// levels×10 rendering, save format v11 — follows the strip. MUST run at every
// verticalProfile assignment: solves, PVI edits, undo restores AND saved-
// profile adoption (a loaded project never re-solves, so skipping adoption
// left the whole route at level 0 riding the surface).
function applyDerivedTrackLevels(track) {
    if (!track?.verticalProfile || !window.__verticalProfile?.deriveLevelsFromProfile) return;
    // Depth against terrain decides the state; prefer the terrain the profile
    // was solved against (stored on it), fall back to the runtime DGU cache for
    // older saves that carry none.
    const terrainAt = (dM) => terrainAslAtChainage(track, dM);
    const derivedLevels = window.__verticalProfile.deriveLevelsFromProfile(
        track.verticalProfile,
        trackVertexChainages(track),
        terrainAt,
    );
    if (Array.isArray(derivedLevels) && derivedLevels.length === track.latlngs.length) {
        // Quantized levels step at one vertex boundary; the ride and the civil
        // works lerp between vertices, so a hard −1→0 step across a short
        // segment teleported the tram at the portal. Shape every transition
        // over the physical ramp length as fractional levels.
        // …but NOT across a station platform, which is level by definition.
        track.levels = window.__verticalProfile.shapeDerivedLevelRamps
            ? window.__verticalProfile.shapeDerivedLevelRamps(
                derivedLevels,
                trackVertexChainages(track),
                getMinLevelChangeMeters(track.gauge),
                trackProfileStationInputs(track),
            )
            : derivedLevels;
    }
    // Stamp the 3-state display vocabulary (tunel / na terenu / vijadukt) on the
    // profile as a runtime annotation: the strip band, the map decor and the
    // summary label all prefer displayRegimes over the solver's five raw cost
    // regimes, so every surface tells the same story as the ride.
    const display = window.__verticalProfile.displayRegimes?.(track.verticalProfile, terrainAt);
    if (Array.isArray(display)) track.verticalProfile.displayRegimes = display;

    // Deriving levels can flip a STATION's level (e.g. a platform node dragged
    // deep enough to read as a tunnel), which changes trackProfileStationInputs
    // and therefore currentTrackProfileHash. The profile's hash was stamped
    // BEFORE this derivation, so it would now mismatch its own updated station
    // inputs → judged "stale" → the sheet shows "Računa se…" and
    // updateElevationDock HIDES the strip (the reported drag bug). Re-stamp to
    // the post-derivation inputs so the profile stays fresh; the locked PVIs
    // already encode the edited shape and the station-span change is
    // second-order (also breaks any derive↔re-solve oscillation).
    track.verticalProfile.geomHash = currentTrackProfileHash(track);
}

// A vertical profile is stamped with the hash of the inputs it was solved from,
// and trackHasFreshAslProfile() compares that stamp against the inputs as they
// stand. The catch: the station spans in those inputs are sized by each
// station's structure kind, which is read off the solved profile — so stamping
// moves the very hash being stamped. Solved once, a profile is stale on arrival
// and NOTHING downstream will ever accept it. See planner-grade/profile-fixpoint.js.
function warnProfileUnsettled(track, outcome) {
    console.warn(`[profile] track ${track.id}: vertical profile did not settle`
        + ` (${outcome.reason} after ${outcome.rounds} rounds). Stamping the final hash`
        + ' anyway — a profile marked with a hash nothing will ever ask for reads as'
        + ' "no grade", which drops the ride to flat-world track props inside a terrain'
        + ' world and builds its civil works twice, at two different heights.',
        outcome.history);
}

// The invariant every caller depends on: when a solve returns true, the profile
// it wrote is FRESH. The tail of both solvers can move the hash again (station
// levels and costs re-read the new grade), so close that gap explicitly instead
// of trusting the tail to be inert.
function stampSettledProfileHash(track) {
    const settled = currentTrackProfileHash(track);
    if (!track.verticalProfile || track.verticalProfile.geomHash === settled) return;
    console.warn(`[profile] track ${track.id}: hash moved after solve`
        + ` (${track.verticalProfile.geomHash} → ${settled}); re-stamping so the profile`
        + ' is not stale on arrival.');
    track.verticalProfile.geomHash = settled;
}

function resolveTrackVerticalProfile(track, lockedPvis) {
    const terrain = track._terrainProfile;
    if (!terrain || terrain.geomHash !== currentTrackGeomHash(track)) return false;
    const locks = lockedPvis ?? getLockPvisFromEdits(track);
    const outcome = window.__profileFixpoint.solveToStableHash({
        hashNow: () => currentTrackProfileHash(track),
        solveOnce: (geomHash) => {
            const solved = window.__plannerGrade.solveGradeProfileWithStations(terrain.points, {
                maxGradePct: GAUGES[normalizeGauge(track.gauge)].maxInclinePct,
                lockedPvis: locks,
                structureConstraints: track.verticalProfile?.structureConstraints || [],
                structureTerrainPoints: terrain.points,
                // Spiral/loop routes: the solver holds the crossing passes a
                // deck-plus-clearance apart (pure geometry, cached per hash).
                selfCrossings: getTrackSelfCrossings(track),
                // Re-read each round: the previous round's profile decides these
                // spans, and re-solving against the OLD spans would settle on a
                // hash describing inputs nobody used.
                stationCenters: trackProfileStationInputs(track),
                stationHalfSpanM: STATION_PROFILE_DEFAULT_HALF_SPAN_M,
            });
            setTrackVerticalProfile(track, window.__verticalProfile.buildVerticalProfile(solved, {
                stepM: terrain.stepM,
                geomHash,
                inputRevision: VERTICAL_PROFILE_INPUT_REVISION,
                terrainProvenance: terrain.provenance,
            }));
            return true;
        },
    });
    if (!outcome.converged) warnProfileUnsettled(track, outcome);
    snapshotProfileGeoAnchors(track);
    applyDerivedTrackLevels(track);
    invalidateLineElevationCaches(track);
    rebuildTrackDecor(track);   // recolour the 2D route by the new regime
    track.cost = computeTrackConstructionCost(track);   // tunnel/cut premiums shift with the grade
    // Solving the profile is also what reveals a station's structural form — a
    // platform that reads as "surface" from its level can be sitting in a 6 m
    // trench, which costs more. Without this the station prices stayed at their
    // load-time guess and the project total drifted from the object bill.
    refreshTrackStationLevels(track);
    if (selectedObject?.type === 'track' && selectedObject.ref === track) renderSelectionSheet();
    stampSettledProfileHash(track);
    return true;
}

// Every PVI pinned to a lat/lng, not just the user's locks.
//
// The profile is indexed on chainage, so ANY change to the horizontal route
// invalidates it: chainages shift, and the authored shape no longer lines up
// with the ground it was drawn against. Until now the code's answer to that was
// to throw the whole profile away and re-run the global optimizer — which is why
// nudging one route node could return a completely different vertical alignment.
// Anchoring every PVI geographically (the same trick _elevationEdits already
// used for locks) lets a geometry edit CARRY the authored profile onto the new
// route instead: each node stays over the same piece of ground, and the shape
// between them is the straight-line derive, exactly as if the user had drawn it.
function snapshotProfileGeoAnchors(track) {
    const pvis = track.verticalProfile?.pvis;
    if (!Array.isArray(pvis) || pvis.length < 2) { track._profileGeoAnchors = null; return; }
    const anchors = [];
    for (const pvi of pvis) {
        const ll = latLngAtChainage(track, pvi.dM);
        if (ll) anchors.push({ lat: ll[0], lng: ll[1], elevAslM: pvi.elevAslM, locked: !!pvi.locked });
    }
    track._profileGeoAnchors = anchors.length >= 2 ? anchors : null;
}

// Re-project the anchors onto the CURRENT geometry. Returns null when the
// result cannot be trusted — too few survivors, or chainages that no longer
// increase (a route edited so heavily that anchors reorder is a redraw, not a
// nudge, and there the global solve is the honest answer).
function projectProfileGeoAnchors(track) {
    const anchors = track._profileGeoAnchors;
    if (!Array.isArray(anchors) || anchors.length < 2) return null;
    const projected = [];
    for (const anchor of anchors) {
        const dM = trackChainageAtLatLng(track, anchor.lat, anchor.lng);
        if (!Number.isFinite(dM) || !Number.isFinite(anchor.elevAslM)) continue;
        projected.push({ dM, elevAslM: anchor.elevAslM, locked: !!anchor.locked });
    }
    if (projected.length < 2) return null;
    // Order must be preserved, not restored by sorting: sorting a reordered set
    // would silently rearrange the user's profile into something they never drew.
    for (let i = 1; i < projected.length; i++) {
        if (projected[i].dM < projected[i - 1].dM - 1e-6) return null;
    }
    // Collapse anchors that landed on top of each other (a shortened route can
    // squeeze several onto the same metre); a locked one wins its cluster.
    const merged = [];
    for (const pvi of projected) {
        const previous = merged[merged.length - 1];
        if (previous && pvi.dM - previous.dM < 1) {
            if (pvi.locked && !previous.locked) merged[merged.length - 1] = pvi;
            continue;
        }
        merged.push(pvi);
    }
    return merged.length >= 2 ? merged : null;
}

// Both sims resolve elevation through the track's verticalProfile, but each
// line caches a sampled elevation profile that is NOT keyed on it — so drop that
// cache whenever a track's profile changes, or an edit wouldn't reach the ride.
function invalidateLineElevationCaches(track) {
    for (const line of linesUsingTrack(track)) line._elevationProfile = null;
}

async function computeTrackVerticalProfile(track) {
    if (!project.tracks.includes(track)) return; // deleted while debouncing
    const geomHash = currentTrackProfileHash(track);
    if (trackHasFreshAslProfile(track)) {
        // Adopted saved profile — no re-solve needed, but older saves carry no
        // terrainAslM, leaving the depth classifier on its regime fallback.
        // Fetch the runtime terrain, re-derive levels/display states, and
        // refresh everything that showed the fallback classification.
        if (!Array.isArray(track.verticalProfile.terrainAslM)
            && !trackHasFreshTerrainProfile(track)) {
            try {
                await fetchTerrainProfileForTrack(track);
                if (!project.tracks.includes(track)) return;
                if (currentTrackProfileHash(track) !== geomHash) {
                    // Terrain arrival can legitimately refine a station from
                    // the old three-level fallback into full/compact/cut. The
                    // in-flight result is stale, but abandoning it without a
                    // successor leaves the selected track on "Računa se…".
                    scheduleTrackVerticalProfile(track);
                    return;
                }
                applyDerivedTrackLevels(track);
                invalidateLineElevationCaches(track);
                rebuildTrackDecor(track);
                track.cost = computeTrackConstructionCost(track);
                if (selectedObject?.type === 'track' && selectedObject.ref === track) renderSelectionSheet();
                if (elevationDockTrack === track) {
                    elevationDockProfile = null;   // defeat same-profile guard → band redraw
                    updateElevationDock();
                }
            } catch (err) {
                console.warn(`[grade] terrain for adopted profile of track ${track.id} failed:`, err?.message || err);
            }
        }
        return;
    }
    // Station-only change (same geometry+gauge — the cached terrain is still
    // valid): PRESERVE the authored curve. Handing the profile back to the
    // global optimizer on a station move discards the user's shape — it keeps
    // only locked PVIs, carves V-dips between them and emits its own node
    // set. Re-derive the existing PVIs instead (the same straight-line path
    // strip edits use); the station plateaus adjust to the new chainages and
    // everything else keeps its drawn shape.
    if (track.verticalProfile?.pvis?.length >= 2
        && trackHasFreshTerrainProfile(track)) {
        const preservedPvis = track.verticalProfile.pvis.map(p => ({
            dM: p.dM, elevAslM: p.elevAslM, locked: !!p.locked,
        }));
        if (rederiveTrackProfileFromPvis(track, preservedPvis)) return;
    }
    const token = (track._verticalProfileToken || 0) + 1;
    track._verticalProfileToken = token;
    try {
        await fetchTerrainProfileForTrack(track);
        if (track._verticalProfileToken !== token) return;      // superseded
        if (currentTrackProfileHash(track) !== geomHash) {
            // A newer geometry/station/form state needs its own solve. Merely
            // returning strands the UI with a permanently stale profile.
            scheduleTrackVerticalProfile(track);
            return;
        }
        // GEOMETRY changed (the branch above only covers station moves, where
        // the cached terrain is still valid). Carry the authored profile across
        // via its geographic anchors rather than re-optimising: each node keeps
        // the piece of ground it was drawn over. The global solve is reserved
        // for a track that has no profile to carry — and for the explicit
        // "Preračunaj automatski" button. Nudging a route node used to hand the
        // whole vertical alignment back to the optimizer, which returned a
        // different route: pins kept, everything between them re-derived from
        // cost, surfacing out of tunnels the user had drawn.
        const carried = projectProfileGeoAnchors(track);
        if (carried && rederiveTrackProfileFromPvis(track, carried)) return;
        resolveTrackVerticalProfile(track);
    } catch (err) {
        console.warn(`[grade] vertical profile for track ${track.id} failed:`, err?.message || err);
    }
}

// Profile-strip editing. Direct manipulation: a drag moves ONLY that node and
// the profile becomes straight lines between the PVIs (deriveProfileFromPvis) —
// no global re-optimisation. "Recompute automatically" re-runs the solver with
// the touched nodes as pins; "Undo my changes" clears everything back to auto.
// A per-track undo stack backs Cmd-Z.

// Manual elevation edits are anchored GEOGRAPHICALLY (lat/lng), not by chainage:
// re-projected to the current route on every (re)build, so editing the 2D route
// moves the edits with the geometry instead of sliding them along the chainage.
// track._elevationEdits = [{lat, lng, elevAslM}] is the source of truth; the
// solver's lockedPvis are derived from it.
// A loaded project restores verticalProfile (with locked pvis) but not the
// runtime edit list — rebuild the geo-anchors from the locked PVIs once, so
// recomputes/geometry edits after a reload keep the user's pinned elevations.
function ensureElevationEditsFromProfile(track) {
    const pvis = track.verticalProfile?.pvis;
    if (!Array.isArray(pvis)) return;
    // A non-empty list is authoritative: it is the source of truth and may hold
    // anchors the current profile does not show.
    if (track._elevationEdits?.length > 0) return;
    // An EMPTY list is only authoritative once the profile agrees there are no
    // pins. The old guard was `if (track._elevationEdits) return`, and `[]` is
    // truthy — so whichever call ran first latched the empty list forever. On a
    // project load the initial debounced solve (0 pins) beats hydration's
    // adoption of the saved profile (16 pins), so every pin in every loaded
    // project was invisible to "Preračunaj automatski", which then re-solved the
    // whole route as if nothing had been authored. Rebuilding whenever the
    // profile carries pins and the list is empty is self-healing regardless of
    // who wins that race. (resetTrackProfileLocks clears both together, so its
    // deliberate empty state still sticks.)
    const locked = pvis.filter((p) => p.locked);
    if (track._elevationEdits && locked.length === 0) return;
    track._elevationEdits = [];
    for (const p of locked) {
        const ll = latLngAtChainage(track, p.dM);
        if (ll) track._elevationEdits.push({ lat: ll[0], lng: ll[1], elevAslM: p.elevAslM });
    }
}

// Geo-anchor a saved profile's locked PVIs onto a freshly created runtime
// track. Independent of whether the profile itself is adopted: the pins are
// the authored intent and must outlive a stale hash. Safe to call before any
// station exists — chainage → lat/lng only needs the geometry.
function adoptSavedProfilePins(track, savedProfile) {
    const pvis = savedProfile?.pvis;
    if (!Array.isArray(pvis)) return;
    const anchors = [];
    for (const pvi of pvis) {
        if (!pvi?.locked) continue;
        const ll = latLngAtChainage(track, Number(pvi.dM));
        if (ll && Number.isFinite(Number(pvi.elevAslM))) {
            anchors.push({ lat: ll[0], lng: ll[1], elevAslM: Number(pvi.elevAslM) });
        }
    }
    if (anchors.length > 0) track._elevationEdits = anchors;
}

function getLockPvisFromEdits(track) {
    ensureElevationEditsFromProfile(track);
    const out = [];
    for (const e of track._elevationEdits || []) {
        const dM = trackChainageAtLatLng(track, e.lat, e.lng);
        if (Number.isFinite(dM) && Number.isFinite(e.elevAslM)) out.push({ dM, elevAslM: e.elevAslM });
    }
    out.sort((a, b) => a.dM - b.dM);
    return out;
}

// Two nodes closer together than this ARE the same node — a geo-anchor that has
// round-tripped through lat/lng lands within a few centimetres of its chainage,
// so a metre or two of slack identifies it without reaching anything else.
//
// It used to be one terrain step (20 m), which meant an edit "near" a node
// silently retargeted that node instead: inserting a node 15 m from an existing
// one moved the EXISTING one to the new elevation and created nothing where the
// user clicked, and deleting a node took a neighbour's anchor with it. An action
// must only ever change what it was aimed at.
const PVI_SAME_NODE_TOLERANCE_M = 2;

function upsertElevationEdit(track, dM, elevAslM) {
    ensureElevationEditsFromProfile(track);
    const ll = latLngAtChainage(track, dM);
    if (!ll) return;
    for (const e of track._elevationEdits) {
        const eDM = trackChainageAtLatLng(track, e.lat, e.lng);
        if (Number.isFinite(eDM) && Math.abs(eDM - dM) <= PVI_SAME_NODE_TOLERANCE_M) {
            e.lat = ll[0]; e.lng = ll[1]; e.elevAslM = elevAslM;
            return;
        }
    }
    track._elevationEdits.push({ lat: ll[0], lng: ll[1], elevAslM });
}

function removeElevationEditNear(track, dM) {
    ensureElevationEditsFromProfile(track);
    track._elevationEdits = track._elevationEdits.filter((e) => {
        const eDM = trackChainageAtLatLng(track, e.lat, e.lng);
        return !(Number.isFinite(eDM) && Math.abs(eDM - dM) <= PVI_SAME_NODE_TOLERANCE_M);
    });
}

// Snapshot the profile + geo-anchored edits so the edit that follows undoes cleanly.
function pushProfileUndo(track) {
    if (!track || !track.verticalProfile) return;
    if (!track._profileUndo) track._profileUndo = [];
    track._profileUndo.push({
        profile: track.verticalProfile,
        edits: (track._elevationEdits || []).map((e) => ({ ...e })),
    });
    if (track._profileUndo.length > 50) track._profileUndo.shift();
}

function undoTrackProfileEdit(track) {
    if (!track || !track._profileUndo || track._profileUndo.length === 0) return false;
    const snap = track._profileUndo.pop();
    setTrackVerticalProfile(track, snap.profile);
    track._elevationEdits = snap.edits;
    applyDerivedTrackLevels(track);
    invalidateLineElevationCaches(track);
    rebuildTrackDecor(track);
    track.cost = computeTrackConstructionCost(track);   // restore the snapshot's cost too
    if (selectedObject?.type === 'track' && selectedObject.ref === track) renderSelectionSheet();
    markTrackProfileEdited();
    return true;
}

// A committed elevation edit reshapes the built track (grade → tunnels/cuts) and
// its cost, so it must dirty the project and enable Save exactly like moving a
// node in the top-down map does. Cost itself is refreshed inside the profile
// commit; this just flags the change and refreshes the summary/save state.
function markTrackProfileEdited() {
    updateProjectSummary();
}

// The strip is drawn left→right from node 0, so an east→west route mirrors its
// profile. Flip it to always read like the map: west on the left for an
// east–west route, north on the left for a north–south one. Chainage is
// unchanged; only the display axis reverses (see buildLayout's `flip`).
function shouldFlipProfileStrip(track) {
    const pts = track && track.latlngs;
    if (!Array.isArray(pts) || pts.length < 2) return false;
    const a = pts[0], b = pts[pts.length - 1];
    const dLng = Number(b[1]) - Number(a[1]);   // >0: last point is east of node 0
    const dLat = Number(b[0]) - Number(a[0]);   // >0: last point is north of node 0
    if (!Number.isFinite(dLng) || !Number.isFinite(dLat)) return false;
    return Math.abs(dLng) >= Math.abs(dLat) ? dLng < 0 : dLat > 0;
}

// Re-derive the stored profile from an explicit PVI polyline (local edit).
// `stationCenters` may be overridden by a caller that already knows the span a
// station is about to have. trackProfileStationInputs derives each span from the
// profile as it stands, so during an edit that CHANGES a station's structure
// (a platform dragged past the tunnel rule grows from 60 m to 170 m) it returns
// the span the station is leaving — the solver then re-flattens the old
// footprint and leaves the newly-claimed stretch sloping, which the station
// immediately reports as "peron nije ravan". Passing the target span makes the
// edit land in one pass instead of converging over two.
function rederiveTrackProfileFromPvis(track, pvis, stationCenters = null) {
    const terrain = track._terrainProfile;
    if (!terrain || terrain.geomHash !== currentTrackGeomHash(track)) return false;
    // Same self-invalidating stamp as resolveTrackVerticalProfile, same fix.
    const outcome = window.__profileFixpoint.solveToStableHash({
        hashNow: () => currentTrackProfileHash(track),
        solveOnce: (geomHash) => {
            const solved = window.__plannerGrade.deriveProfileFromPvisWithStations(terrain.points, pvis, {
                maxGradePct: GAUGES[normalizeGauge(track.gauge)].maxInclinePct,
                structureConstraints: track.verticalProfile?.structureConstraints || [],
                structureTerrainPoints: terrain.points,
                // Authored PVIs are audited against the loop crossings (red
                // bands), never separated by force on this path.
                selfCrossings: getTrackSelfCrossings(track),
                stationCenters: stationCenters || trackProfileStationInputs(track),
                stationHalfSpanM: STATION_PROFILE_DEFAULT_HALF_SPAN_M,
            });
            setTrackVerticalProfile(
                track,
                window.__verticalProfile.buildVerticalProfile(
                    solved,
                    {
                        stepM: terrain.stepM,
                        geomHash,
                        inputRevision: VERTICAL_PROFILE_INPUT_REVISION,
                        terrainProvenance: terrain.provenance,
                    },
                ),
            );
            return true;
        },
    });
    if (!outcome.converged) warnProfileUnsettled(track, outcome);
    snapshotProfileGeoAnchors(track);
    applyDerivedTrackLevels(track);
    invalidateLineElevationCaches(track);
    rebuildTrackDecor(track);   // recolour the 2D route by the new regime
    track.cost = computeTrackConstructionCost(track);   // tunnel/cut premiums shift with the grade
    // Solving the profile is also what reveals a station's structural form — a
    // platform that reads as "surface" from its level can be sitting in a 6 m
    // trench, which costs more. Without this the station prices stayed at their
    // load-time guess and the project total drifted from the object bill.
    refreshTrackStationLevels(track);
    if (selectedObject?.type === 'track' && selectedObject.ref === track) renderSelectionSheet();
    stampSettledProfileHash(track);
    return true;
}

// Drag-drop a node: move the nearest PVI (or add one) to the dropped elevation
// and mark it a user pin; everything else keeps its shape.
async function applyLocalPviEdit(track, dM, elevAslM) {
    const profile = track.verticalProfile;
    if (!profile || !Array.isArray(profile.pvis)) return;
    if (!await ensureTrackTerrainProfile(track)) {
        setStatusMessage('Ne mogu dohvatiti teren za uređivanje visine.', true);
        return;
    }
    const pvis = profile.pvis.map(p => ({ dM: p.dM, elevAslM: p.elevAslM, locked: !!p.locked }));
    const elev = Math.round(Number(elevAslM) * 100) / 100;
    let nearest = null, bestDist = Infinity;
    for (const p of pvis) { const d = Math.abs(p.dM - dM); if (d < bestDist) { bestDist = d; nearest = p; } }
    // Materialize the geo-anchors BEFORE snapshotting. They are built lazily
    // from the locked PVIs on first edit, so a snapshot taken first captures []
    // — and because [] is truthy, ensureElevationEditsFromProfile then refuses
    // to rebuild it. Undoing the first edit after a load used to silently strip
    // every pin's geographic anchor, leaving "Preračunaj automatski" to re-solve
    // the whole route from scratch as if the user had pinned nothing.
    ensureElevationEditsFromProfile(track);
    pushProfileUndo(track);
    // Retarget an existing node only when this edit IS that node — a drag hands
    // back the handle's own dM, so it matches to the centimetre. A click that
    // inserts a node lands where it was clicked; the old 20 m window made it
    // grab whatever node happened to be nearby and change ITS height instead.
    if (nearest && bestDist <= PVI_SAME_NODE_TOLERANCE_M) {
        nearest.elevAslM = elev;
        nearest.locked = true;
    } else {
        pvis.push({ dM, elevAslM: elev, locked: true });
        pvis.sort((a, b) => a.dM - b.dM);
    }
    upsertElevationEdit(track, dM, elev);   // geo-anchor for future recomputes
    if (rederiveTrackProfileFromPvis(track, pvis)) markTrackProfileEdited();
    else track._profileUndo?.pop();
}

// Drag a station's platform bar: raise or lower the WHOLE level span to one
// elevation. A station is a rigid building, so this is the only elevation edit
// its span accepts — the strip offers no way to move one end alone.
//
// The interior is cleared of pins on purpose. grade-solver's
// stationSpansFromFirstPass abandons a station's level plateau outright when the
// span contains two pins at different elevations ("preserving an authored slope
// is safer than silently moving it"), which is how a station ends up reporting
// "trasa mijenja visinu za N m" with nothing visibly wrong. Pinning exactly the
// two anchors at one elevation is the shape the solver keeps.
async function applyStationPlateauEdit(track, dM0, dM1, elevAslM) {
    const profile = track.verticalProfile;
    if (!profile || !Array.isArray(profile.pvis)) return;
    if (!Number.isFinite(dM0) || !Number.isFinite(dM1) || dM1 <= dM0) return;
    if (!await ensureTrackTerrainProfile(track)) {
        setStatusMessage('Ne mogu dohvatiti teren za uređivanje visine.', true);
        return;
    }
    const elev = Math.round(Number(elevAslM) * 100) / 100;
    if (!Number.isFinite(elev)) return;

    // A platform that reaches a route end OWNS that end. The station is part of
    // the track: the track runs up to it, the station is that stretch, and the
    // track carries on from its far end — so when there is no "carries on", the
    // station's outer anchor IS the route's last node, and editing the platform
    // must move it rather than leave it behind at its old height.
    const chainages = trackVertexChainages(track);
    const routeEndM = chainages[chainages.length - 1] || 0;
    const profileStartM = profile.pvis[0].dM;
    const profileEndM = profile.pvis[profile.pvis.length - 1].dM;
    const END_SNAP_M = TERRAIN_PROFILE_STEP_M;

    // Re-size the span for the depth being dropped TO, not the one being left.
    // Carrying a platform past the 8 m tunnel rule turns a 60 m surface station
    // into a 170 m underground one; pinning only the old 60 m left 110 m of
    // sloping track inside the new structure, and the station reported itself
    // not level the instant it landed.
    let centreDM = (dM0 + dM1) / 2;
    const owner = project.stations.find((station) => {
        if (station.trackId !== track.id || !Array.isArray(station.latlng)) return false;
        const stationDM = trackChainageAtLatLng(track, station.latlng[0], station.latlng[1]);
        return Number.isFinite(stationDM) && stationDM >= dM0 - 1 && stationDM <= dM1 + 1;
    });
    if (owner) {
        const ownerDM = trackChainageAtLatLng(track, owner.latlng[0], owner.latlng[1]);
        if (Number.isFinite(ownerDM)) centreDM = ownerDM;
    }
    const targetKind = stationKindForElevation(track, centreDM, elev);
    const targetHalfSpanM = targetKind ? halfSpanForKind(targetKind) : null;
    const targetFromM = targetHalfSpanM ? Math.max(0, centreDM - targetHalfSpanM) : dM0;
    const targetToM = targetHalfSpanM ? Math.min(routeEndM, centreDM + targetHalfSpanM) : dM1;
    const transition = window.__plannerGrade.planStationSpanTransition(
        dM0,
        dM1,
        targetFromM,
        targetToM,
        { profileStartM, profileEndM, routeEndM, endSnapM: END_SNAP_M },
    );
    if (!transition) return;
    const { targetLo, targetHi, clearLo, clearHi } = transition;
    const insideOldOrNewSpan = (d) => d >= clearLo - 1e-6 && d <= clearHi + 1e-6;
    const pvis = profile.pvis
        .filter((p) => !insideOldOrNewSpan(p.dM))
        .map((p) => ({ dM: p.dM, elevAslM: p.elevAslM, locked: !!p.locked }));
    // Clear both footprints, but pin ONLY the target ends. Pinning the union
    // preserved the old width as two stray, unremovable-looking nodes.
    pvis.push(
        { dM: targetLo, elevAslM: elev, locked: true },
        { dM: targetHi, elevAslM: elev, locked: true },
    );
    pvis.sort((a, b) => a.dM - b.dM);

    // Anchors first, then the snapshot — see applyLocalPviEdit.
    ensureElevationEditsFromProfile(track);
    pushProfileUndo(track);
    // Geo-anchors follow the same rule as the PVIs: drop every edit inside the
    // span, then anchor the two ends, so a later recompute or geometry edit
    // rebuilds the platform level instead of resurrecting a pin that tilts it.
    track._elevationEdits = track._elevationEdits.filter((edit) => {
        const editDM = trackChainageAtLatLng(track, edit.lat, edit.lng);
        return !(Number.isFinite(editDM) && insideOldOrNewSpan(editDM));
    });
    // Anchored directly, not via upsertElevationEdit: that helper absorbs any
    // pin within one terrain step (20 m), which here would drag a neighbouring
    // pin just OUTSIDE the platform onto its edge. Everything inside the span
    // is already gone, so there is nothing left to merge with.
    for (const anchorDM of [targetLo, targetHi]) {
        const ll = latLngAtChainage(track, anchorDM);
        if (ll) track._elevationEdits.push({ lat: ll[0], lng: ll[1], elevAslM: elev });
    }

    // Hand the solver THIS station's target span, so it flattens the footprint
    // the platform is landing on rather than the one it is leaving.
    const stationCenters = (trackProfileStationInputs(track) || []).map((input) => (
        Math.abs(input.dM - centreDM) < 1
            ? { dM: centreDM, dM0: targetLo, dM1: targetHi }
            : input
    ));
    if (rederiveTrackProfileFromPvis(track, pvis, stationCenters)) markTrackProfileEdited();
    else track._profileUndo?.pop();
}

// Double-click a node: delete it (the line joins its neighbours), unless it is
// a route endpoint or the last two points.
async function removeLocalPvi(track, dM) {
    const profile = track.verticalProfile;
    if (!profile || !Array.isArray(profile.pvis) || profile.pvis.length <= 2) return;
    if (!await ensureTrackTerrainProfile(track)) {
        setStatusMessage('Ne mogu dohvatiti teren za uređivanje visine.', true);
        return;
    }
    let idx = -1, bestDist = Infinity;
    for (let i = 0; i < profile.pvis.length; i++) {
        const d = Math.abs(profile.pvis[i].dM - dM);
        if (d < bestDist) { bestDist = d; idx = i; }
    }
    // Never the endpoints — by INDEX, which matches the strip's delete-chip rule
    // exactly (first/last handle). Deliberately not a dM-based guard against the
    // route length: the index is the definition of "endpoint", and it stays
    // correct without depending on two lengths agreeing.
    if (idx <= 0 || idx >= profile.pvis.length - 1) return;
    const removedDM = profile.pvis[idx].dM;
    const pvis = profile.pvis
        .filter((_, i) => i !== idx)
        .map(p => ({ dM: p.dM, elevAslM: p.elevAslM, locked: !!p.locked }));
    ensureElevationEditsFromProfile(track);      // anchors first — see applyLocalPviEdit
    pushProfileUndo(track);
    removeElevationEditNear(track, removedDM);   // drop its geo-anchor too
    if (rederiveTrackProfileFromPvis(track, pvis)) {
        // Some nodes are STRUCTURALLY required — a station's level platform
        // pins PVIs at its span edges, and a hard grade break needs one too.
        // The re-solve re-creates such a node at the same spot, so the removal
        // is silently undone by the solver. Detect that (a PVI still sits where
        // we removed one) and tell the user, instead of leaving a × button that
        // appears to do nothing.
        const regenerated = track.verticalProfile.pvis.some(
            (p) => Math.abs(p.dM - removedDM) <= PVI_SAME_NODE_TOLERANCE_M);
        if (regenerated) {
            track._profileUndo?.pop();
            setStatusMessage('Ovaj čvor drži stanica ili nagib — ne može se ukloniti.', true);
        } else {
            markTrackProfileEdited();
        }
    } else {
        track._profileUndo?.pop();
    }
}

// "Recompute automatically" — two different jobs depending on what is pinned.
//
// NO PINS: the free global optimizer. This is the first-placement solve, and
// the only place it ever runs unprompted.
//
// PINS: keep every pinned elevation exactly, drop the auto nodes between them,
// and join consecutive pins with a straight chord. It does NOT re-optimise the
// spans in between, because the optimizer is answering a different question than
// the user is asking. Its cost model gives a tunnel its discount only past 15 m
// of cover, so an authored −8 m tunnel is priced as a deep open cut — ~256 cost
// units per 20 m sample — while climbing back to the surface between two pins
// costs a one-off ~8. It therefore surfaces in EVERY unpinned gap: a route
// authored as 3.5 km of continuous tunnel came back as 0.4 km with the profile
// sawtoothing between −7.8 m and −0.2 m. That is the optimizer being right about
// cost and wrong about intent. Straight chords are predictable, and a chord that
// breaks the grade limit is reported red rather than silently "fixed" — fixing
// it would mean moving a pin, which is the one thing this must never do.
async function recomputeTrackProfile(track) {
    if (!await ensureTrackTerrainProfile(track)) {
        setStatusMessage('Ne mogu dohvatiti teren za preračun visine.', true);
        return;
    }
    ensureElevationEditsFromProfile(track);      // anchors first — see applyLocalPviEdit
    const pins = getLockPvisFromEdits(track);
    pushProfileUndo(track);

    if (pins.length === 0) {
        if (resolveTrackVerticalProfile(track)) {
            markTrackProfileEdited();
            setStatusMessage('Visinski profil preračunat automatski.');
        } else {
            track._profileUndo?.pop();
        }
        return;
    }

    const existing = track.verticalProfile?.pvis || [];
    const pvis = window.__plannerGrade.pinnedRecomputePvis(
        pins,
        [existing[0], existing[existing.length - 1]],
    );

    if (rederiveTrackProfileFromPvis(track, pvis)) {
        markTrackProfileEdited();
        setStatusMessage(
            `Visinski profil izravnan između ${pins.length} pričvršćenih čvorova `
            + '(ravne dionice; pričvršćene visine nepromijenjene).',
        );
    } else {
        track._profileUndo?.pop();
    }
}

// "Undo my changes": clear every pin → the fully-automatic profile.
async function resetTrackProfileLocks(track) {
    if (!await ensureTrackTerrainProfile(track)) {
        setStatusMessage('Ne mogu dohvatiti teren za preračun visine.', true);
        return;
    }
    pushProfileUndo(track);
    track._elevationEdits = [];
    if (resolveTrackVerticalProfile(track, [])) markTrackProfileEdited();
    else track._profileUndo?.pop();
    track._profileUndo = [];   // a full reset is the new baseline
}

// Cmd/Ctrl-Z steps back through elevation edits — but only while the strip is
// open AND there is edit history, so it never hijacks a global undo otherwise.
let elevationUndoKeyBound = false;
function ensureElevationUndoKey() {
    if (elevationUndoKeyBound) return;
    elevationUndoKeyBound = true;
    document.addEventListener('keydown', (e) => {
        if (!((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey)) return;
        if (window.__routeEditHistory?.isEditableTarget(e.target)) return;
        const dock = document.getElementById('elevationDock');
        if (!dock || dock.classList.contains('hidden')) return;
        const track = elevationDockTrack;
        if (!track || !track._profileUndo || track._profileUndo.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        undoTrackProfileEdit(track);
    }, true);
}

// ---------------------------------------------------------------------------
// Map-docked elevation profile: a persistent strip (top-left of the map) that
// shows the SELECTED track's vertical profile with chainage on the X-axis, and
// links to the map both ways — hovering the strip drops a marker on the route,
// hovering the route drops a cursor on the strip. Reuses the same renderer and
// PVI-edit callbacks as the (removed) popup strip. Everything map-aware lives
// here; the drawing stays pure in profile-strip.js / profile-render.js.
let elevationDockStrip = null;      // handle from __profileStrip.attach
let elevationDockTrack = null;      // track currently shown
let elevationDockProfile = null;    // its verticalProfile ref (rebuild guard)
let elevationDockElectrificationKey = '';
let elevationHoverMarker = null;    // Leaflet marker for strip -> map hover
let elevationDockHitLayer = null;   // route hit path we bound hover to
let elevationDockMove = null;
let elevationDockOut = null;
let elevationDockRenderGeneration = 0;
const elevationDockOverlayLoads = new WeakMap();

function setElevationDockLoading(track, loading) {
    const dock = document.getElementById('elevationDock');
    if (!dock) return;
    // Visibility belongs to having a selected track, not to being busy. The
    // saved-profile fast path calls this with loading=false and must still open
    // the dock before drawing its already-available canvas.
    if (track) {
        dock.classList.remove('hidden');
        dock.setAttribute('aria-hidden', 'false');
    }
    dock.classList.toggle('is-loading', !!loading);
    dock.setAttribute('aria-busy', loading ? 'true' : 'false');
    const host = dock.querySelector('.elevation-dock-canvas-host');
    if (host) host.inert = !!loading;
    dock.querySelectorAll('.elevation-dock-actions button')
        .forEach((button) => { button.disabled = !!loading; });
    if (loading) {
        const title = dock.querySelector('.elevation-dock-title');
        if (title) title.textContent = `Trasa ${track?.id ?? ''} — računanje profila…`;
    }
}

// A saved, current profile is already the complete display model: draw it now.
// Only a genuinely missing/stale solve gets the grey busy state and two frames
// in which to paint it before the heavier terrain + grade work completes.
function scheduleSelectedTrackRender(track) {
    const generation = ++elevationDockRenderGeneration;
    if (trackHasFreshAslProfile(track)) {
        setElevationDockLoading(track, false);
        renderSelectionSheet();
        return;
    }
    setElevationDockLoading(track, true);
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            if (generation !== elevationDockRenderGeneration
                || selectedObject?.type !== 'track'
                || selectedObject.ref !== track) return;
            renderSelectionSheet();
        });
    });
}

// The stripe accepts one chainage-run contract. Mixed reconstructed projects
// already carry exact runs; a uniform authored choice becomes one full run.
function profileElectrificationSegments(track) {
    const lengthM = Math.max(0, Number(track?.lengthKm) * 1000 || 0);
    const api = window.__trackElectrification;
    const exact = api?.normalizeElectrificationSegments(
        track?.electrificationSegments,
        lengthM,
    ) || [];
    if (exact.length) return exact;
    const fields = api?.normalizeAuthoredFields(track || {}) || {};
    if (!fields.electrified || !(lengthM > 0)) return [];
    return [{ fromM: 0, toM: lengthM, ...fields, source: 'authored' }];
}

function profileElectrificationKey(segments) {
    return JSON.stringify((segments || []).map(segment => [
        segment.fromM,
        segment.toM,
        segment.electrified,
        segment.voltage,
        segment.frequency,
    ]));
}

// lat/lng of a point `dM` metres along the track (linear between vertices).
function latLngAtChainage(track, dM) {
    const chainages = trackVertexChainages(track);
    const total = chainages[chainages.length - 1] || 0;
    const target = Math.max(0, Math.min(Number(dM) || 0, total));
    for (let i = 0; i < chainages.length - 1; i++) {
        if (target <= chainages[i + 1] || i === chainages.length - 2) {
            const span = chainages[i + 1] - chainages[i];
            const t = span > 1e-9 ? (target - chainages[i]) / span : 0;
            const [lat0, lng0] = track.latlngs[i];
            const [lat1, lng1] = track.latlngs[i + 1];
            return [lat0 + (lat1 - lat0) * t, lng0 + (lng1 - lng0) * t];
        }
    }
    return track.latlngs[0];
}

// Continuous track LEVEL (−1/0/+1, fractional on ramps) at a chainage. This
// is the coarse fallback for routes that do not yet have an authored profile.
function levelAtChainage(track, dM) {
    const chainages = trackVertexChainages(track);
    for (let i = 0; i < chainages.length - 1; i++) {
        if (dM <= chainages[i + 1] || i === chainages.length - 2) {
            const span = chainages[i + 1] - chainages[i];
            const t = span > 1e-9 ? Math.max(0, Math.min(1, (dM - chainages[i]) / span)) : 0;
            return getContinuousTrackLevel(track, i, t);
        }
    }
    return 0;
}

// chainage of the point on the track nearest a map lat/lng (reverse direction).
function trackChainageAtLatLng(track, lat, lng) {
    const point = nearestPointOnTrack(track, lat, lng);
    if (!point) return null;
    const chainages = trackVertexChainages(track);
    const a = chainages[point.segmentIndex];
    const b = chainages[point.segmentIndex + 1] ?? a;
    return a + (b - a) * point.t;
}

// Accumulate Google-ground a.s.l. samples captured during a photo ride onto the
// line's tracks, keyed by chainage bin. ADDITIVE: batches arrive through the
// whole cab ride AND the walk that follows, and the data lives on the track
// object, so it survives closing the sim (only a page reload clears it, since
// it isn't serialized). Consumed by the elevation strip as the "Google teren" line.
const PHOTO_GROUND_BIN_M = 10;
function accumulateLinePhotoGround(line, samples) {
    if (!Array.isArray(samples) || !samples.length) return;
    const tracks = getTracksUsedByLine(line);
    if (!tracks.length) return;
    let touched = null;
    for (const s of samples) {
        const lat = Number(s?.lat), lng = Number(s?.lng), aslM = Number(s?.aslM);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(aslM)) continue;
        let best = null, bestDistSq = Infinity;
        for (const track of tracks) {
            const pt = nearestPointOnTrack(track, lat, lng);
            if (pt && pt.distSq < bestDistSq) { bestDistSq = pt.distSq; best = { track, pt }; }
        }
        if (!best) continue;
        const chainages = trackVertexChainages(best.track);
        const a = chainages[best.pt.segmentIndex];
        const b = chainages[best.pt.segmentIndex + 1] ?? a;
        const dM = a + (b - a) * best.pt.t;
        if (!best.track._photoGround) best.track._photoGround = new Map();
        best.track._photoGround.set(Math.round(dM / PHOTO_GROUND_BIN_M) * PHOTO_GROUND_BIN_M, aslM);
        touched = best.track;
    }
    // Live-refresh only if the strip is actually visible (it's hidden during the
    // ride; the overlay otherwise appears when the track is next selected).
    if (touched && selectedObject?.type === 'track' && selectedObject.ref === touched
        && !document.getElementById('elevationDock')?.classList.contains('hidden')) {
        elevationDockProfile = null;
        updateElevationDock();
    }
}

// Sorted [{dM, elevAslM}] of a track's captured Google-ground samples (or null).
function photoGroundPointsForTrack(track) {
    if (!track._photoGround || track._photoGround.size === 0) return null;
    return [...track._photoGround.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([dM, elevAslM]) => ({ dM, elevAslM }));
}

// Lines whose geometry includes this track (a track can serve several lines).
function linesUsingTrack(track) {
    if (!track) return [];
    return (project.lines || []).filter(
        line => getTracksUsedByLine(line).some(t => t.id === track.id));
}

// Which way the cab drives when you click the strip, in TRACK-CHAINAGE terms:
// +1 toward increasing chainage, -1 toward decreasing. rideCabToTrackChainage
// drops the line's first train at default direction 1 (forward = increasing
// LINE offset); whether that is increasing or decreasing chainage depends on
// how this track was drawn relative to the line, so measure it. Drives the
// strip's ride-direction arrow so it points where the cab actually goes.
function stripCabRideDirection(track) {
    try {
        const line = linesUsingTrack(track)[0];
        if (!line) return 1;
        const profile = getLineMotionProfile(line);
        if (!profile || profile.totalLengthMeters <= 0) return 1;
        const lengthM = track.lengthKm * 1000;
        const offsetAt = (frac) => {
            const [lat, lng] = latLngAtChainage(track, lengthM * frac);
            return getOffsetOnLine(L.latLng(lat, lng), profile);
        };
        const oa = offsetAt(0.4), ob = offsetAt(0.6);
        if (oa == null || ob == null) return 1;
        return ob >= oa ? 1 : -1;
    } catch (_e) { return 1; }
}

// Click on the elevation strip → drop the line's first train at that track
// chainage and open its cab. The strip is per-track, so map the track chainage
// to a point, then to the line's motion offset. Uses the first line on the
// track and its first train (adds one if the line has none).
function rideCabToTrackChainage(track, dM) {
    if (!track || !Number.isFinite(dM)) return;
    const line = linesUsingTrack(track)[0];
    if (!line) { setStatusMessage('Trasa nije dio linije — nema vozila za kabinu.', true); return; }
    const profile = getLineMotionProfile(line);
    if (!profile || profile.totalLengthMeters <= 0) { setStatusMessage('Linija nema voznu trasu.', true); return; }
    const [lat, lng] = latLngAtChainage(track, dM);
    const offset = getOffsetOnLine(L.latLng(lat, lng), profile);
    if (offset == null) { setStatusMessage('Ne mogu odrediti mjesto na liniji.', true); return; }
    const clampedOffset = Math.max(0, Math.min(profile.totalLengthMeters, offset));
    const train = (line.trains && line.trains[0]) || addTrainToLine(line, clampedOffset);
    if (!train) { setStatusMessage('Ne mogu pripremiti vozilo na liniji.', true); return; }
    train.distanceMeters = clampedOffset;
    train.pendingDirection = null;
    train.pauseRemainingSeconds = 0;
    train.pausedStationId = null;
    updateTrainMarker(train, line);
    train._cabRidden = true;
    train._cabStepMs = null;
    try {
        if (!openPlannerTrainCab(train, line)) train._cabRidden = false;
    } catch (error) {
        train._cabRidden = false;
        throw error;
    }
}

function setElevationHoverMarker(latlng) {
    if (!latlng) {
        if (elevationHoverMarker) { map.removeLayer(elevationHoverMarker); elevationHoverMarker = null; }
        return;
    }
    if (!elevationHoverMarker) {
        elevationHoverMarker = L.circleMarker(latlng, {
            radius: 6, color: '#d64521', weight: 2, fillColor: '#fff', fillOpacity: 1,
            interactive: false, pane: 'markerPane',
        }).addTo(map);
    } else {
        elevationHoverMarker.setLatLng(latlng);
    }
}

// Single click in the strip's empty area → pan the main map so that chainage's
// geographic point lands under the click (aligned to clientX), just below the
// elevation dock so it isn't hidden behind it. Purely a navigation aid — the
// strip and map read as vertically connected at the clicked spot.
function focusMapOnChainage(track, dM, clientX) {
    if (!track || !Number.isFinite(dM)) return;
    const ll = latLngAtChainage(track, dM);
    if (!ll) return;
    const target = L.latLng(ll[0], ll[1]);
    const rect = map.getContainer().getBoundingClientRect();
    const dock = document.getElementById('elevationDock');
    const dockRect = (dock && !dock.classList.contains('hidden')) ? dock.getBoundingClientRect() : null;
    const desiredX = Number.isFinite(clientX)
        ? Math.max(0, Math.min(rect.width, clientX - rect.left))
        : rect.width / 2;
    // The strip docks at the BOTTOM on desktop and the TOP on mobile, so put the
    // point in whichever clear band is larger — above the strip on desktop
    // ("right above where you clicked"), below it on mobile — a comfortable step
    // in from the strip edge so it reads as connected to the click, not tucked
    // behind the strip.
    let desiredY = rect.height * 0.4;
    if (dockRect) {
        const dockTopY = dockRect.top - rect.top;
        const dockBottomY = dockRect.bottom - rect.top;
        const clearAbove = Math.max(0, dockTopY);
        const clearBelow = Math.max(0, rect.height - dockBottomY);
        desiredY = clearAbove >= clearBelow
            ? Math.max(30, dockTopY - Math.max(70, clearAbove * 0.2))
            : Math.min(rect.height - 30, dockBottomY + Math.max(70, clearBelow * 0.2));
    }
    const targetPt = map.latLngToContainerPoint(target);
    const centerPt = map.latLngToContainerPoint(map.getCenter());
    const newCenter = map.containerPointToLatLng(centerPt.add(targetPt.subtract(L.point(desiredX, desiredY))));
    map.panTo(newCenter, { animate: true, duration: 0.3 });
    setElevationHoverMarker(ll);
}

function teardownElevationDock() {
    if (elevationDockStrip) { elevationDockStrip.destroy(); elevationDockStrip = null; }
    setElevationHoverMarker(null);
    if (elevationDockHitLayer) {
        if (elevationDockMove) elevationDockHitLayer.off('mousemove', elevationDockMove);
        if (elevationDockOut) elevationDockHitLayer.off('mouseout', elevationDockOut);
    }
    elevationDockHitLayer = null; elevationDockMove = null; elevationDockOut = null;
    elevationDockTrack = null; elevationDockProfile = null;
    elevationDockElectrificationKey = '';
}

// Show/refresh the dock for the currently selected track (hide otherwise).
// Called from renderSelectionSheet, so it tracks selection and profile changes.
// Dot radius on the strip for a road-crossing, by road class — bigger roads read
// louder, which is what matters when eyeballing where a viaduct or tunnel is
// worth it.
function roadCrossingRadius(highway) {
    switch (highway) {
        case 'motorway': case 'motorway_link': case 'trunk': case 'trunk_link': return 4.5;
        case 'primary': case 'primary_link': return 3.6;
        case 'secondary': case 'secondary_link': return 3.0;
        case 'tertiary': case 'tertiary_link': return 2.5;
        case 'residential': case 'unclassified': case 'living_street': return 2.0;
        default: return 1.5;   // service and the rest
    }
}

let referenceRailCrossingFeaturesPromise = null;

// The bbox `/roads` endpoint is genuinely road-only. A city pack may declare
// static reference tracks; reuse those same sources for profile crossings.
function loadReferenceRailCrossingFeatures() {
    if (referenceRailCrossingFeaturesPromise) return referenceRailCrossingFeaturesPromise;
    const sources = [
        { url: CITY_CONFIG.staticData?.railTracks, railway: 'rail' },
        { url: CITY_CONFIG.staticData?.tramTracks, railway: 'tram' },
    ].filter(source => source.url);
    referenceRailCrossingFeaturesPromise = Promise.all(sources.map(async (source) => {
        try {
            const response = await fetch(source.url, { cache: 'no-store' });
            if (!response.ok) throw new Error(`${source.url} ${response.status}`);
            const collection = await response.json();
            return (collection.features || []).map((feature) => ({
                ...feature,
                properties: { ...(feature.properties || {}), railway_type: source.railway },
            }));
        } catch (error) {
            console.warn('[rails] profile crossing source failed:', error?.message || error);
            return [];
        }
    })).then((groups) => groups.flat());
    return referenceRailCrossingFeaturesPromise;
}

function lineSegmentAtSnap(feature, snapped) {
    const coordinates = feature?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
    const rawIndex = Number(snapped?.properties?.index);
    const index = Number.isInteger(rawIndex)
        ? Math.max(0, Math.min(coordinates.length - 2, rawIndex))
        : 0;
    return [coordinates[index], coordinates[index + 1]];
}

// Where a track crosses roads or OSM train/tram rails, in chainage — for the
// strip's terrain-line dots. The shared road geometry feed carries both feature
// types; cached per track geometry so it runs once.
async function computeTrackRoadCrossings(track) {
    const pts = track && track.latlngs;
    if (!Array.isArray(pts) || pts.length < 2 || typeof turf === 'undefined') return [];
    const geomHash = currentTrackGeomHash(track);
    if (track._roadCrossings?.geomHash === geomHash) return track._roadCrossings.crossings;
    let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
    for (const [lat, lng] of pts) {
        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
        minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
    }
    const m = 0.002;   // ~200 m bbox margin so edge crossings aren't clipped
    const bbox = `${minLng - m},${minLat - m},${maxLng + m},${maxLat + m}`;
    let crossings = [];
    try {
        const resp = await fetch(`${API_BASE_URL}/roads?bbox=${encodeURIComponent(bbox)}`, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`roads ${resp.status}`);
        const fc = await resp.json();
        const trackLine = turf.lineString(pts.map(([lat, lng]) => [lng, lat]));
        for (const road of fc.features || []) {
            if (!road.geometry) continue;
            let hits;
            try { hits = turf.lineIntersect(trackLine, road); } catch (_e) { continue; }
            for (const hit of hits.features || []) {
                const snapped = turf.nearestPointOnLine(trackLine, hit);
                const dM = (Number(snapped?.properties?.location) || 0) * 1000;
                // Retain transport class, name and crossing lat/lng alongside
                // chainage; the strip sizes and colours the dot by class.
                const coords = hit.geometry?.coordinates;
                const hitLng = Number(coords?.[0]);
                const hitLat = Number(coords?.[1]);
                const highway = road.properties?.highway || road.properties?.highway_type || null;
                const railway = road.properties?.railway || road.properties?.railway_type || null;
                crossings.push({
                    dM,
                    r: railway ? (railway === 'rail' ? 3.2 : 2.6) : roadCrossingRadius(highway),
                    kind: railway ? 'rail' : 'road',
                    highway,
                    railway,
                    name: road.properties?.name || null,
                    latlng: (Number.isFinite(hitLat) && Number.isFinite(hitLng)) ? [hitLat, hitLng] : null,
                });
            }
        }
        const referenceRails = await loadReferenceRailCrossingFeatures();
        for (const rail of referenceRails) {
            if (!rail.geometry) continue;
            let hits;
            try { hits = turf.lineIntersect(trackLine, rail); } catch (_e) { continue; }
            for (const hit of hits.features || []) {
                const snapped = turf.nearestPointOnLine(trackLine, hit);
                const railSnap = turf.nearestPointOnLine(rail, hit);
                const trackSegment = lineSegmentAtSnap(trackLine, snapped);
                const railSegment = lineSegmentAtSnap(rail, railSnap);
                if (!window.__roadCrossing?.transverseIntersection(
                    trackSegment,
                    railSegment,
                )) continue;
                const dM = (Number(snapped?.properties?.location) || 0) * 1000;
                const coords = hit.geometry?.coordinates;
                const hitLng = Number(coords?.[0]);
                const hitLat = Number(coords?.[1]);
                const railway = rail.properties?.railway_type || 'rail';
                crossings.push({
                    dM,
                    r: railway === 'rail' ? 3.2 : 2.6,
                    kind: 'rail',
                    highway: null,
                    railway,
                    name: rail.properties?.name || null,
                    latlng: (Number.isFinite(hitLat) && Number.isFinite(hitLng))
                        ? [hitLat, hitLng]
                        : null,
                });
            }
        }
        crossings = window.__roadCrossing?.clusterRailCrossings
            ? window.__roadCrossing.clusterRailCrossings(crossings)
            : crossings.sort((a, b) => a.dM - b.dM);
    } catch (err) {
        console.warn('[roads] crossings failed:', err?.message || err);
        crossings = [];
    }
    track._roadCrossings = { geomHash, crossings };
    return crossings;
}

// Road/rail crossings are a useful overlay, not part of the saved elevation
// profile. Load them after the stripe is usable and add them in place when they
// arrive. Terrain is deliberately absent here: saved profiles already contain
// their display terrain, while editing fetches the raw terrain on demand.
function prepareElevationDockOverlays(track) {
    const geomHash = currentTrackGeomHash(track);
    const existing = elevationDockOverlayLoads.get(track);
    if (existing?.geomHash === geomHash) return existing;
    const needsCrossings = track._roadCrossings?.geomHash !== geomHash;
    const load = {
        geomHash,
        status: needsCrossings ? 'pending' : 'ready',
        refreshScheduled: false,
        promise: null,
    };
    if (needsCrossings) {
        load.promise = computeTrackRoadCrossings(track).then(() => {
            load.status = 'ready';
            return load;
        });
    }
    elevationDockOverlayLoads.set(track, load);
    return load;
}

function refreshElevationDockAfterOverlayLoad(track, load) {
    if (load.status !== 'pending' || load.refreshScheduled) return;
    load.refreshScheduled = true;
    load.promise.then(() => {
        load.refreshScheduled = false;
        if (selectedObject?.type !== 'track' || selectedObject.ref !== track) return;
        if (elevationDockTrack !== track || !elevationDockStrip) return;
        const roadCrossings = track._roadCrossings?.geomHash === currentTrackGeomHash(track)
            ? track._roadCrossings.crossings
            : [];
        elevationDockStrip.update({ roadCrossings });
    });
}

function updateElevationDock() {
    const dock = document.getElementById('elevationDock');
    if (!dock || !window.__profileStrip || !window.__profileRender) return;
    // Whatever this call decides about the strip, the map's bottom-left corner
    // has to be told: it rides above the strip, so its offset is only right if
    // it is recomputed after the strip has appeared or gone.
    queueMicrotask(syncViewportChrome);
    const track = selectedObject?.type === 'track' ? selectedObject.ref : null;
    const fresh = track && trackHasFreshAslProfile(track) && track.verticalProfile;
    if (!fresh) {
        teardownElevationDock();
        if (track) {
            setElevationDockLoading(track, true);
        } else {
            setElevationDockLoading(null, false);
            dock.classList.add('hidden');
            dock.setAttribute('aria-hidden', 'true');
        }
        return;
    }
    setElevationDockLoading(track, false);
    const overlayLoad = prepareElevationDockOverlays(track);
    refreshElevationDockAfterOverlayLoad(track, overlayLoad);
    const electrificationSegments = profileElectrificationSegments(track);
    const electrificationKey = profileElectrificationKey(electrificationSegments);
    const resetBtn = dock.querySelector('.elevation-dock-reset');
    const recomputeBtn = dock.querySelector('.elevation-dock-recompute');
    // Both edit buttons appear only once the user has actually edited the profile.
    const syncDockButtons = () => {
        const edited = (track._elevationEdits?.length > 0) || track.verticalProfile.pvis.some(p => p.locked);
        if (resetBtn) resetBtn.hidden = !edited;
        if (recomputeBtn) recomputeBtn.hidden = !edited;
    };
    // Cheap guard: same track + same profile object => only refresh the buttons,
    // don't rebuild the canvas (renderSelectionSheet fires often).
    if (elevationDockTrack === track && elevationDockProfile === track.verticalProfile
        && !dock.classList.contains('hidden')) {
        if (elevationDockElectrificationKey !== electrificationKey) {
            elevationDockElectrificationKey = electrificationKey;
            elevationDockStrip?.update({ electrificationSegments });
        }
        syncDockButtons();
        return;
    }
    // Elevation edit (node drag / add / remove): the profile object changed but
    // the geometry, terrain and road crossings did NOT. Update the existing
    // strip IN PLACE instead of re-attaching — re-creating the canvas on every
    // commit destroyed the interaction and read as the strip "closing" mid-drag.
    // (Async data arrivals null elevationDockProfile to force a full rebuild, so
    // a null here still falls through to the re-attach below.)
    if (elevationDockTrack === track && elevationDockStrip
        && elevationDockProfile != null
        && elevationDockProfile !== track.verticalProfile
        && !dock.classList.contains('hidden')) {
        elevationDockProfile = track.verticalProfile;
        elevationDockElectrificationKey = electrificationKey;
        elevationDockStrip.update({
            profile: track.verticalProfile,
            stationMarks: trackProfileStationMarks(track),
            electrificationSegments,
        });
        syncDockButtons();
        return;
    }

    // An elevation edit re-solves the profile and rebuilds the strip. Preserve
    // the user's zoom/pan window + legend toggles across that rebuild (same
    // track only) so a node drop doesn't snap the view back to the whole route.
    const preservedView = (elevationDockTrack === track
        && elevationDockStrip && typeof elevationDockStrip.getViewState === 'function')
        ? elevationDockStrip.getViewState()
        : null;
    teardownElevationDock();
    ensureElevationUndoKey();
    elevationDockTrack = track;
    elevationDockProfile = track.verticalProfile;
    elevationDockElectrificationKey = electrificationKey;
    setElevationDockLoading(track, false);

    const title = dock.querySelector('.elevation-dock-title');
    if (title) {
        title.textContent = `Trasa ${track.id} — `
            + window.__profileRender.regimeSummaryLabel(track.verticalProfile, track.lengthKm * 1000);
    }
    if (recomputeBtn) recomputeBtn.onclick = () => recomputeTrackProfile(track);
    if (resetBtn) resetBtn.onclick = () => resetTrackProfileLocks(track);
    // 📋 opens the network-wide bill of structures. It reads every track, not
    // just this one — the strip is only where the button lives.
    const objectsBtn = dock.querySelector('.elevation-dock-objects');
    if (objectsBtn) objectsBtn.onclick = () => (isCivilObjectsPanelOpen()
        ? closeCivilObjectsPanel()
        : openCivilObjectsPanel());
    // ⚙ snap-clearance settings: the two magnet heights (viaduct above /
    // tunnel below terrain) are user-tunable and persisted. Targets are read
    // live at drag time, so no strip rebuild is needed on change.
    const settingsBtn = dock.querySelector('.elevation-dock-settings-btn');
    const settingsPanel = dock.querySelector('.elevation-dock-settings');
    if (settingsBtn && settingsPanel && window.__profileStrip?.getSnapClearances) {
        settingsBtn.onclick = () => settingsPanel.classList.toggle('hidden');
        const settingsClose = settingsPanel.querySelector('.elevation-dock-settings-close');
        if (settingsClose) settingsClose.onclick = () => settingsPanel.classList.add('hidden');
        const overInput = settingsPanel.querySelector('.snap-over-input');
        const underInput = settingsPanel.querySelector('.snap-under-input');
        const clearances = window.__profileStrip.getSnapClearances();
        if (overInput && document.activeElement !== overInput) overInput.value = clearances.overM;
        if (underInput && document.activeElement !== underInput) underInput.value = clearances.underM;
        const applySnapInputs = () => {
            window.__profileStrip.setSnapClearances({
                overM: Number(overInput?.value),
                underM: Number(underInput?.value),
            });
            try {
                localStorage.setItem(
                    SNAP_CLEARANCE_STORAGE_KEY,
                    JSON.stringify(window.__profileStrip.getSnapClearances()),
                );
            } catch (_e) { /* private mode — setting just won't persist */ }
        };
        if (overInput) overInput.onchange = applySnapInputs;
        if (underInput) underInput.onchange = applySnapInputs;
    }
    syncDockButtons();

    const host = dock.querySelector('.elevation-dock-canvas-host');
    const embeddedTerrain = track.verticalProfile?.terrainAslM;
    const embeddedStepM = Number(track.verticalProfile?.stepM);
    const embeddedTerrainPoints = Array.isArray(embeddedTerrain) && embeddedTerrain.length >= 2
        && embeddedStepM > 0
        ? embeddedTerrain.map((elevAslM, index) => ({
            dM: Math.min(track.lengthKm * 1000, index * embeddedStepM),
            elevAslM: Number.isFinite(Number(elevAslM)) ? Number(elevAslM) : null,
        }))
        : null;
    const dockTerrainPoints = trackHasFreshTerrainProfile(track)
        ? track._terrainProfile.points
        : embeddedTerrainPoints;
    const dockRoadCrossings = track._roadCrossings?.geomHash === currentTrackGeomHash(track)
        ? track._roadCrossings.crossings
        : [];
    elevationDockStrip = window.__profileStrip.attach(host, {
        profile: track.verticalProfile,
        terrainPoints: dockTerrainPoints,
        terrainLabel: CITY_CONFIG.providerLabels?.terrain
            ? `${ui('terrain', 'teren')} (${CITY_CONFIG.providerLabels.terrain})`
            : ui('terrain', 'teren'),
        // Both sims now ride this same auto-graded profile, so the old coarse
        // "model (terrain + ±10 m levels)" line is gone — the blue "trasa" line
        // IS the model AND the photo track.
        modelTrackPoints: null,
        // Real Google surface captured during a photo ride (partial coverage).
        photoGroundPoints: photoGroundPointsForTrack(track),
        lengthM: track.lengthKm * 1000,
        // Orient the strip like the map (west/north on the left) regardless of
        // which end was drawn first, so drawing a route east→west no longer
        // mirrors its profile.
        flip: shouldFlipProfileStrip(track),
        // Which way the cab actually drives from a strip click (+1/-1 chainage),
        // so the ride-direction arrow on the tram cursor points correctly.
        rideDirection: stripCabRideDirection(track),
        // Station platforms along the route: their level SPAN [dM0, dM1] is
        // drawn as a band + marker, so the strip shows where the stations are
        // (and why the PVIs bracketing them are un-removable). Chainage from
        // the same solver station inputs.
        stationMarks: trackProfileStationMarks(track),
        // Black dots on the terrain line where the track crosses roads (helps
        // decide viaduct/tunnel). Populated async; empty until the fetch lands.
        roadCrossings: dockRoadCrossings,
        // Rings on the track line where the route crosses ITSELF (spiral/loop):
        // one per pass, green over / black under / red when unseparated.
        selfCrossings: selfCrossingStripMarks(track),
        // Thin yellow/amber system underlay below the civil-regime band.
        electrificationSegments,
        // Restore zoom/pan + legend state after an edit-triggered rebuild.
        initialView: preservedView?.viewWindow || null,
        initialSeries: preservedView?.series || null,
        // Track's max grade (for the live traffic-light legality feedback).
        maxGradePct: GAUGES[normalizeGauge(track.gauge)].maxInclinePct,
        onLockPvi: (dM, elevAslM) => applyLocalPviEdit(track, dM, elevAslM),
        onUnlockPvi: (dM) => removeLocalPvi(track, dM),
        // Whole-platform drag: a station is rigid, so its span moves to one
        // elevation instead of accepting a per-end pin.
        onMoveStationPlateau: (dM0, dM1, elevAslM) =>
            applyStationPlateauEdit(track, dM0, dM1, elevAslM),
        onHoverChainage: (dM) => setElevationHoverMarker(dM == null ? null : latLngAtChainage(track, dM)),
        onSeekCab: (dM) => rideCabToTrackChainage(track, dM),
        onFocusMap: (dM, clientX) => focusMapOnChainage(track, dM, clientX),
    });

    // Map -> strip: hovering the route path moves the strip cursor.
    const hitLayer = track.hitLayer || track.layer;
    if (hitLayer && elevationDockStrip) {
        elevationDockHitLayer = hitLayer;
        elevationDockMove = (e) => {
            const dM = trackChainageAtLatLng(track, e.latlng.lat, e.latlng.lng);
            if (elevationDockStrip) elevationDockStrip.setMapCursor(dM);
        };
        elevationDockOut = () => { if (elevationDockStrip) elevationDockStrip.setMapCursor(null); };
        hitLayer.on('mousemove', elevationDockMove);
        hitLayer.on('mouseout', elevationDockOut);
    }
}

// ─── Bill of civil objects (📋 in the strip header) ─────────────────────────
// The per-kilometre cost view averages a route into one number; this one counts
// what actually gets built — each viaduct, cut, tunnel and embankment as one
// discrete structure, the stations on top of them, and every metre of
// ground-level track summed into a single row. Detection is pure and lives in
// planner-grade/civil-objects.js; this section only gathers the tracks, resolves
// their rates and renders the table.

// A stale profile must not price the track: its geometry no longer matches the
// route, so the objects along it are for an alignment that no longer exists.
// Hiding it makes detection fall back to the per-vertex levels, which are always
// current — three kinds instead of five, never a wrong five.
function pricingTrackView(track) {
    return trackHasFreshAslProfile(track) && track.verticalProfile
        ? track
        : { ...track, verticalProfile: null };
}

// The hand-typed prices in force right now: scoped to the loaded project so one
// proposal's structures cannot inherit another's numbers. Cached because the
// cost model asks for them once per track on every edit.
let objectCostOverrides = null;

function currentObjectCostScope() {
    // Read the URL here rather than via the shared `urlParams` const further
    // down the file: costs are computed during init, before that line runs.
    return PRICING_API.objectCostScope(
        new URLSearchParams(window.location.search).get('project'),
    );
}

function currentObjectCostOverrides() {
    if (!objectCostOverrides) objectCostOverrides = PRICING_API.getObjectCosts(currentObjectCostScope());
    return objectCostOverrides;
}

function invalidateObjectCostOverrides() {
    objectCostOverrides = null;
}

// Every track in the project with its detected objects — the SAME detection the
// cost model runs, so a number in this list can never disagree with the total.
function collectProjectCivilObjects() {
    if (!window.__civilObjects) return [];
    const overrides = currentObjectCostOverrides();
    return project.tracks.map((track) => ({
        track,
        label: `Trasa ${track.id}`,
        gauge: normalizeGauge(track.gauge),
        lengthM: (track.lengthKm || 0) * 1000,
        rates: PRICING_API.getObjectRates(track.gauge, activePricing),
        overrides,
        // A track still waiting for terrain is detected from its levels, so it
        // is coarse (no cuts or embankments) rather than absent.
        coarse: !trackHasFreshAslProfile(track) || !track.verticalProfile,
        objects: PRICING_API.detectTrackObjects(pricingTrackView(track), {
            stationMarks: trackProfileStationMarks(track),
        }),
    }));
}

function civilObjectsEntries() {
    return collectProjectCivilObjects().map((entry) => ({
        label: entry.label,
        gaugeLabel: `${GAUGES[entry.gauge].icon} ${GAUGES[entry.gauge].label}`,
        lengthM: entry.lengthM,
        objects: entry.objects,
        rates: entry.rates,
        overrides: entry.overrides,
        coarse: entry.coarse,
    }));
}

// Transfer links are priced objects too, and leaving them out made the bill
// disagree with the project total by exactly their cost. They belong to no
// track, so they get their own section.
function civilObjectsTransferEntry(overrides) {
    if (project.transferLinks.length === 0) return null;
    return {
        label: 'Presjedanja',
        gaugeLabel: '',
        lengthM: 0,
        objects: project.transferLinks.map((link, index) =>
            window.__civilObjects.transferObject(link, index)),
        rates: PRICING_API.getObjectRates('g1000', activePricing),
        overrides,
    };
}

// Chainage order is what the detector produces and how a railway reads a line,
// so it is also the default the panel opens on.
let civilObjectsSort = { key: 'chainage', direction: 'asc' };
// The entries the panel last rendered, so a clicked row can be resolved back to
// the track and object it came from without re-detecting anything.
let civilObjectsRendered = [];

function toggleCivilObjectsSort(key) {
    if (!window.__civilObjectsView.SORT_KEYS.includes(key)) return;
    civilObjectsSort = civilObjectsSort.key === key
        ? { key, direction: civilObjectsSort.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' };
    renderCivilObjectsPanel();
}

function renderCivilObjectsPanel() {
    const content = document.getElementById('civilObjectsContent');
    if (!content || !window.__civilObjectsView) return;
    const overrides = currentObjectCostOverrides();
    const detailed = collectProjectCivilObjects();
    const entries = civilObjectsEntries();
    const transfers = civilObjectsTransferEntry(overrides);
    if (transfers) entries.push(transfers);
    // Same index space as the rendered sections, so data-entry resolves; the
    // transfer section has no track and is therefore not locatable.
    civilObjectsRendered = entries.map((entry, index) => ({
        entry,
        track: detailed[index] ? detailed[index].track : null,
    }));
    content.innerHTML = window.__civilObjectsView.render(entries, {
        editable: true,
        locatable: true,
        // The panel is a third of the screen: the icon says "viaduct" perfectly
        // well, and the word was spending the width that the numbers need.
        compactNames: true,
        sort: civilObjectsSort,
        formatCost,
        formatDistanceMeters,
    });
    window.__civilObjectsView.attach(content, {
        onSort: toggleCivilObjectsSort,
        onLocate: showCivilObjectOnMap,
        onCommit: (key, costEur) => {
            const scope = currentObjectCostScope();
            if (key && costEur === null) PRICING_API.clearObjectCost(scope, key);
            else if (key && Number.isFinite(costEur)) PRICING_API.setObjectCost(scope, key, costEur);
            invalidateObjectCostOverrides();
            applyPricingOverrides();
            renderCivilObjectsPanel();
        },
    });
}

// The stretch of route an object occupies, as map coordinates. Object chainages
// are measured along the track's own vertices, so they are read back through the
// same chainage the detector used rather than through the smoothed centreline.
function civilObjectLatLngs(track, object) {
    if (!track || !Number.isFinite(object?.dM0)) return [];
    const offsets = trackVertexChainages(track);
    if (!offsets || offsets.length < 2) return [];
    const chainage = { offsets, totalM: offsets[offsets.length - 1] };
    const fromM = Math.max(0, Math.min(chainage.totalM, object.dM0));
    const toM = Math.max(fromM, Math.min(chainage.totalM,
        Number.isFinite(object.dM1) ? object.dM1 : object.dM0));
    const points = [pointAtTrackOffset(track, chainage, fromM)];
    for (let index = 0; index < offsets.length; index++) {
        if (offsets[index] > fromM && offsets[index] < toM) points.push(track.latlngs[index]);
    }
    points.push(pointAtTrackOffset(track, chainage, toM));
    return points;
}

let civilObjectLocateLayer = null;

function clearCivilObjectLocate() {
    if (!civilObjectLocateLayer) return;
    map.removeLayer(civilObjectLocateLayer);
    civilObjectLocateLayer = null;
}

// Put the map on one structure and blink it. A pan alone leaves you hunting for
// which of several viaducts you clicked.
function showCivilObjectOnMap(entryIndex, objectIndex) {
    const rendered = civilObjectsRendered[entryIndex];
    const object = rendered?.entry?.objects?.[objectIndex];
    if (!rendered?.track || !object) return;
    const latlngs = civilObjectLatLngs(rendered.track, object);
    if (latlngs.length < 2) return;

    clearCivilObjectLocate();
    const bounds = L.latLngBounds(latlngs.map(point => L.latLng(point[0], point[1])));
    map.fitBounds(bounds, {
        // Leave room for the panel: fitting to the full viewport would centre
        // the structure underneath it.
        paddingTopLeft: [40, 40],
        paddingBottomRight: [document.body.classList.contains('objects-panel-open') ? 40 : 40, 40],
        maxZoom: 16,
        animate: true,
    });
    civilObjectLocateLayer = L.polyline(latlngs, {
        pane: TRACK_LEVEL_PANE,
        color: '#f59e0b',
        weight: 14,
        opacity: 0.9,
        lineCap: 'round',
        interactive: false,
        className: 'civil-objects-locate-flash',
    }).addTo(map);
    const element = civilObjectLocateLayer.getElement();
    if (element) {
        element.addEventListener('animationend', clearCivilObjectLocate, { once: true });
    } else {
        setTimeout(clearCivilObjectLocate, 3000);
    }
}

function openCivilObjectsPanel() {
    const panel = document.getElementById('civilObjectsPanel');
    if (!panel) return;
    // The panel takes the right third, so everything that would end up fighting
    // it for that space steps out of the way: the sidebar collapses, the map
    // tools fold back behind their 📝 button, and the selection sheet minimises
    // to its ⓘ chip. All three are the app's own existing "get small" gestures
    // rather than a fourth kind of hiding, so one click brings any of them back
    // with the panel still open.
    setSidebarOpen(false);
    // Collapsing the tools also LEAVES whatever mode they armed, which would
    // discard a track being drawn — so a draft in progress keeps them open. A
    // read-only list must not throw away work to make room for itself.
    if (mapActionsOpen && !hasDraftLine()) setMapActionsOpen(false);
    if (selectedObject && currentMode !== 'edit' && !selectionSheetCollapsed) {
        selectionSheetCollapsed = true;
        renderSelectionSheet();
    }
    renderCivilObjectsPanel();
    panel.classList.remove('hidden');
    document.body.classList.add('objects-panel-open');
}

function closeCivilObjectsPanel() {
    const panel = document.getElementById('civilObjectsPanel');
    if (panel) panel.classList.add('hidden');
    document.body.classList.remove('objects-panel-open');
    clearCivilObjectLocate();
}

function isCivilObjectsPanelOpen() {
    const panel = document.getElementById('civilObjectsPanel');
    return !!panel && !panel.classList.contains('hidden');
}

// ─── Generic confirm ────────────────────────────────────────────────────────
// window.confirm() blocks every subsequent browser event (and every automation
// command), so destructive questions get a real dialog. Resolves true/false.
function askConfirm(message, { title = 'Potvrda', confirmLabel = 'Potvrdi', cancelLabel = 'Odustani' } = {}) {
    const modal = document.getElementById('confirmModal');
    if (!modal) return Promise.resolve(false);
    const messageEl = document.getElementById('confirmModalMessage');
    const titleEl = document.getElementById('confirmModalTitle');
    const okButton = document.getElementById('confirmModalOk');
    const cancelButton = document.getElementById('confirmModalCancel');
    titleEl.textContent = title;
    messageEl.textContent = message;
    okButton.textContent = confirmLabel;
    cancelButton.textContent = cancelLabel;
    modal.classList.remove('hidden');
    okButton.focus();

    return new Promise((resolve) => {
        const finish = (answer) => {
            modal.classList.add('hidden');
            okButton.onclick = null;
            cancelButton.onclick = null;
            modal.onclick = null;
            document.removeEventListener('keydown', onKeyDown, true);
            resolve(answer);
        };
        const onKeyDown = (event) => {
            if (event.key === 'Escape') { event.preventDefault(); finish(false); }
            else if (event.key === 'Enter') { event.preventDefault(); finish(true); }
        };
        okButton.onclick = () => finish(true);
        cancelButton.onclick = () => finish(false);
        modal.onclick = (event) => { if (event.target === modal) finish(false); };
        document.addEventListener('keydown', onKeyDown, true);
    });
}


// ---------------------------------------------------------------------------
// ASL elevation mode for photoreal planner rides (M4). When the photoreal
// viewer is requested AND every track a line touches has a fresh solved
// verticalProfile, cab geometry is emitted with c[2] = authored elevation
// above sea level MINUS the boarding-point datum (so the cab starts near sim
// y=0, and sim y=0 corresponds to `plannerCabAslDatumM` metres a.s.l.). Google
// terrain is registered vertically at one point and never changes this shape.
// If ANY used track lacks a profile the whole session falls back to levels x
// 10 m: one datum per session, never a mix.
let plannerCabAslActive = false;
let plannerCabAslDatumM = 0;
// Model world uses the SAME authored grade as photo, but seats it via the rail
// formation's absolute-EVRF2000 path (so the rail geometry follows the grade
// instead of re-draping the terrain). True in a model ride with a full profile.
let plannerCabModelGradeActive = false;
// openCab closes any previous ride synchronously DURING the new open, so the
// old ride's onClose fires after the new session's flags are already set; the
// generation counter stops it from wiping them.
let plannerCabAslGeneration = 0;
// One generation spans EVERY asynchronous 3D-open intent. A later cab, station
// or map walk invalidates all earlier preparation, so no slow terrain/profile
// fetch can reopen an old view over the user's newer choice.
let planner3DOpenGeneration = 0;
// Suppress request invalidation only while Station3D.openCab synchronously
// closes the ride it is replacing. A user-initiated close outside that narrow
// window invalidates even a newer ride that is still preparing asynchronously.
let plannerCabReplacementOpening = false;

function beginPlanner3DOpenIntent() {
    return ++planner3DOpenGeneration;
}

function planner3DOpenIntentIsCurrent(generation) {
    return generation === planner3DOpenGeneration;
}

// Catch 3D opens AND explicit closes initiated outside transit.js (for example
// tram-sim UI). Our own planner cab is wrapped by plannerCabReplacementOpening;
// other synchronous transitions may increment after their final guard because
// no continuation remains.
window.addEventListener('station3d:visibility', (event) => {
    if (!plannerCabReplacementOpening) {
        planner3DOpenGeneration += 1;
    }
    // A successful launch deliberately leaves its map-sheet button busy while
    // the full-screen simulator covers it. Closing the simulator reveals the
    // same sheet node, so restore every surviving launcher at that lifecycle
    // boundary instead of leaving a stale "Učitavam…" button behind.
    if (!event.detail?.active) {
        document.querySelectorAll('.sel-popup-btn-3d.is-loading')
            .forEach(clearPopupButtonBusy);
    }
});

// World mode: `photo` (photorealistic Google 3D Tiles) vs `model` (the modeled
// OSM/GDI/Overture world, the default). The rule lives in world-mode.js so this
// file and station-3d/world/photoreal.js cannot drift apart — they each used to
// carry their own copy.
function isPhotoWorld() {
    return !!(window.__worldMode && window.__worldMode.isPhotoWorld());
}

function trackHasFreshAslProfile(track) {
    return !!window.__verticalProfile
        && track.verticalProfile?.inputRevision === VERTICAL_PROFILE_INPUT_REVISION
        && track.verticalProfile?.geomHash === currentTrackProfileHash(track);
}

// Mirrors station-3d/world/terrain.js isTerrainRequested() via the Station3D
// global (this file is a classic script and cannot import that ESM module).
// False when the API is not yet available — the safe, flat-world answer.
function modelTerrainActive() {
    try {
        return typeof window.Station3D?.isModelTerrainActive === 'function'
            && window.Station3D.isModelTerrainActive() === true;
    } catch (_error) {
        return false;
    }
}

function lineHasFullAslCoverage(line) {
    const tracks = getTracksUsedByLine(line);
    return tracks.length > 0 && tracks.every(trackHasFreshAslProfile);
}

function trackHasFreshTerrainProfile(track) {
    return track?._terrainProfile?.geomHash === currentTrackGeomHash(track)
        && track?._terrainProfile?.source === getPlannerTerrainSource();
}

function lineHasFullTerrainCoverage(line) {
    const tracks = getTracksUsedByLine(line);
    return tracks.length > 0 && tracks.every(trackHasFreshTerrainProfile);
}

// Vertex chainages cached per geometry — the asl elevation of a point on a
// track is the profile sampled at that point's chainage.
function trackVertexChainages(track) {
    const geomHash = currentTrackGeomHash(track);
    if (track._vertexChainages?.geomHash !== geomHash) {
        track._vertexChainages = {
            geomHash,
            values: window.__verticalProfile.vertexChainagesMeters(track.latlngs),
        };
    }
    return track._vertexChainages.values;
}

// Plan self-intersections of one track (a spiral/loop crossing over itself):
// chainage PAIRS {dMa, dMb}, cached per geometry like _roadCrossings. Fed to
// the grade solver so the two passes get separated vertically, and to the
// elevation strip as over/under markers. Injecting the cached chainages keeps
// crossing dM in the exact domain the profile uses.
function getTrackSelfCrossings(track) {
    const geomHash = currentTrackGeomHash(track);
    if (track._selfCrossings?.geomHash !== geomHash) {
        track._selfCrossings = {
            geomHash,
            crossings: window.__selfCrossing.findSelfCrossings(track.latlngs, {
                chainagesM: trackVertexChainages(track),
            }),
        };
    }
    return track._selfCrossings.crossings;
}

// Strip markers for those crossings — each pass gets its own dot carrying its
// relation (over/under/violation) to the other pass, judged on the solved
// profile. Unsolved profile → 'unknown' marks, which paint neutral.
function selfCrossingStripMarks(track) {
    const crossings = getTrackSelfCrossings(track);
    if (crossings.length === 0 || !track.verticalProfile) return [];
    return window.__selfCrossing.stripMarksForSelfCrossings(
        crossings,
        (dM) => window.__verticalProfile.elevAtChainage(track.verticalProfile, dM),
    );
}

function normalizeTrackLevel(level) {
    const value = Number(level);
    if (!Number.isInteger(value)) return 0;
    return Math.max(TRACK_LEVEL_MIN, Math.min(TRACK_LEVEL_MAX, value));
}

// Geometry vertices inside a curved ramp carry fractional levels so the
// horizontal alignment can retain every useful shaping node while elevation
// changes continuously. User-facing targets and stations still use the full
// integer levels normalized above.
function normalizeTrackElevationLevel(level) {
    const value = Number(level);
    if (!Number.isFinite(value)) return 0;
    const normalized = Math.round(Math.max(TRACK_LEVEL_MIN, Math.min(TRACK_LEVEL_MAX, value)) * 1e6) / 1e6;
    return Math.abs(normalized) < 1e-9 ? 0 : normalized;
}

function isExplicitRampSegment(track, segmentIndex) {
    const fromLevel = track?.levels?.[segmentIndex] ?? 0;
    const toLevel = track?.levels?.[segmentIndex + 1] ?? fromLevel;
    if (fromLevel === toLevel) return false;
    // Fractional endpoints are already samples within one materialized ramp;
    // the entire chord between them must interpolate continuously. Treating
    // each chord as a legacy localized ramp creates flat steps and makes a
    // newly inserted ramp node incorrectly inherit level zero.
    if (!isFullTrackLevel(fromLevel) || !isFullTrackLevel(toLevel)) return true;
    const lastVertexIndex = (track?.levels?.length || 1) - 1;
    const fromHasFlatApproach = segmentIndex === 0
        || (track.levels[segmentIndex - 1] ?? fromLevel) === fromLevel;
    const toHasFlatExit = segmentIndex + 1 === lastVertexIndex
        || (track.levels[segmentIndex + 2] ?? toLevel) === toLevel;
    return fromHasFlatApproach && toHasFlatExit;
}

// New level edits create explicit boundary nodes, so the complete segment
// between unlike endpoint levels is the ramp. The localized fallback keeps
// older saved projects usable until their geometry is touched/migrated.
function getTrackSegmentLevelProfile(track, segmentIndex) {
    const fromLevel = track?.levels?.[segmentIndex] ?? 0;
    const toLevel = track?.levels?.[segmentIndex + 1] ?? fromLevel;
    const start = track?.latlngs?.[segmentIndex];
    const end = track?.latlngs?.[segmentIndex + 1];
    const lengthM = start && end
        ? distanceMetersLatLng(start[0], start[1], end[0], end[1])
        : 0;
    const levelDelta = Math.abs(toLevel - fromLevel);
    if (levelDelta === 0 || lengthM <= 0) {
        return {
            fromLevel,
            toLevel,
            lengthM,
            rampLengthM: 0,
            rampStartT: 0,
            rampEndT: 0,
        };
    }

    const requiredRampM = getMinLevelChangeMeters(track.gauge) * levelDelta;
    if (isExplicitRampSegment(track, segmentIndex)) {
        return {
            fromLevel,
            toLevel,
            lengthM,
            rampLengthM: lengthM,
            requiredRampM,
            rampStartT: 0,
            rampEndT: 1,
            explicit: true,
        };
    }
    const rampLengthM = Math.min(lengthM, requiredRampM);
    const rampFraction = rampLengthM / lengthM;
    let rampStartT;
    let rampEndT;
    if (Math.abs(fromLevel) > Math.abs(toLevel)) {
        rampStartT = 0;
        rampEndT = rampFraction;
    } else if (Math.abs(toLevel) > Math.abs(fromLevel)) {
        rampStartT = 1 - rampFraction;
        rampEndT = 1;
    } else {
        rampStartT = (1 - rampFraction) * 0.5;
        rampEndT = rampStartT + rampFraction;
    }
    return { fromLevel, toLevel, lengthM, rampLengthM, requiredRampM, rampStartT, rampEndT, explicit: false };
}

function getContinuousTrackLevel(track, segmentIndex, t) {
    const profile = getTrackSegmentLevelProfile(track, segmentIndex);
    const clampedT = Math.max(0, Math.min(1, Number(t) || 0));
    if (profile.fromLevel === profile.toLevel || profile.rampLengthM <= 0) return profile.fromLevel;
    if (clampedT <= profile.rampStartT) return profile.fromLevel;
    if (clampedT >= profile.rampEndT) return profile.toLevel;
    const rampT = (clampedT - profile.rampStartT) / (profile.rampEndT - profile.rampStartT);
    return profile.fromLevel + (profile.toLevel - profile.fromLevel) * rampT;
}

// Full level at a point, used where the data model needs an integer level.
function getInterpolatedLevel(track, segmentIndex, t) {
    return Math.round(getContinuousTrackLevel(track, segmentIndex, t));
}

function mixTrackLevelRgb(fromRgb, toRgb, t) {
    const ratio = Math.max(0, Math.min(1, t));
    return fromRgb.map((value, index) => Math.round(value + (toRgb[index] - value) * ratio));
}

function getTrackLevelRgb(level) {
    const value = Math.max(TRACK_LEVEL_MIN, Math.min(TRACK_LEVEL_MAX, Number(level) || 0));
    if (value <= 0) return mixTrackLevelRgb(TRACK_LEVEL_RGB['-1'], TRACK_LEVEL_RGB[0], value + 1);
    return mixTrackLevelRgb(TRACK_LEVEL_RGB[0], TRACK_LEVEL_RGB[1], value);
}

function getTrackLevelColor(level) {
    const [r, g, b] = getTrackLevelRgb(level);
    return `rgb(${r}, ${g}, ${b})`;
}

let trackLevelLegendContainer = null;

// The legend is also the switch: the two vocabularies are alternatives, so one
// control both says which one is showing and changes it.
function renderTrackLevelLegend() {
    const container = trackLevelLegendContainer;
    if (!container) return;
    const gradeMode = trackDisplayMode === 'grade';
    const maxPct = GAUGES[normalizeGauge(project.tracks?.[0]?.gauge)].maxInclinePct;
    const gradeApi = window.__gradeView;

    // One user-facing vertical vocabulary: underground / surface / elevated
    // by depth. Usjek/nasip are solver cost details, not display states.
    const structureRows = [
        { label: 'tunel', color: REGIME_MAP_COLORS.tunnel },
        { label: 'na terenu', color: REGIME_MAP_COLORS['at-grade'] },
        { label: 'vijadukt', color: REGIME_MAP_COLORS.viaduct },
    ];
    // Sampled off the real ramp so the swatches cannot drift from the route.
    const gradeRows = [
        { label: `uspon preko ${maxPct}%`, color: gradeApi.bandColor(gradeApi.GRADE_BANDS + 1, maxPct), over: true },
        { label: `uspon (do ${maxPct}%)`, color: gradeApi.bandColor(gradeApi.GRADE_BANDS, maxPct) },
        { label: 'blagi uspon', color: gradeApi.bandColor(2, maxPct) },
        { label: 'ravno', color: gradeApi.bandColor(0, maxPct) },
        { label: 'blagi pad', color: gradeApi.bandColor(-2, maxPct) },
        { label: `pad (do ${maxPct}%)`, color: gradeApi.bandColor(-gradeApi.GRADE_BANDS, maxPct) },
        { label: `pad preko ${maxPct}%`, color: gradeApi.bandColor(-(gradeApi.GRADE_BANDS + 1), maxPct), over: true },
    ];
    const rows = gradeMode ? gradeRows : structureRows;

    const direction = gradeMode
        ? `<button type="button" class="track-level-legend-flip" data-flip
               title="Promijeni smjer čitanja">⇄ ${gradeViewFlipped
                   ? 'prema km 0+000' : 'u smjeru rasta kilometraže'}</button>`
        : '';

    container.innerHTML = `
        <div class="track-level-legend-modes" role="group" aria-label="Prikaz trase">
            <button type="button" data-mode="structure"
                class="${gradeMode ? '' : 'is-active'}">Građevine</button>
            <button type="button" data-mode="grade"
                class="${gradeMode ? 'is-active' : ''}">Nagib</button>
        </div>
        ${direction}
        ${rows.map(row => `
            <div class="track-level-legend-row">
                <span class="track-level-legend-swatch${row.over ? ' is-over-limit' : ''}"
                    style="--swatch:${row.color}; background:${row.color}"></span>
                <span>${escapeHtml(row.label)}</span>
            </div>`).join('')}`;
}

function setTrackDisplayMode(mode) {
    const next = mode === 'grade' ? 'grade' : 'structure';
    if (next === trackDisplayMode) return;
    trackDisplayMode = next;
    renderTrackLevelLegend();
    for (const track of project.tracks || []) rebuildTrackDecor(track);
}

function setGradeViewFlipped(flipped) {
    if (trackDisplayMode !== 'grade' || flipped === gradeViewFlipped) return;
    gradeViewFlipped = flipped;
    renderTrackLevelLegend();
    for (const track of project.tracks || []) rebuildTrackDecor(track);
}

function addTrackLevelLegend() {
    const legend = L.control({ position: 'bottomleft' });
    legend.onAdd = () => {
        const container = L.DomUtil.create('div', 'track-level-legend');
        trackLevelLegendContainer = container;
        renderTrackLevelLegend();
        container.addEventListener('click', (event) => {
            const modeButton = event.target.closest('[data-mode]');
            if (modeButton) { setTrackDisplayMode(modeButton.dataset.mode); return; }
            if (event.target.closest('[data-flip]')) setGradeViewFlipped(!gradeViewFlipped);
        });
        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.disableScrollPropagation(container);
        return container;
    };
    legend.addTo(map);
}

addTrackLevelLegend();

// A map that shows a 58 km reconstruction and a 200 m platform at different
// zooms needs to say which one you are looking at. Leaflet's own control does
// the maths; metric only, because every number in this planner is.
L.control.scale({
    position: 'bottomleft',
    imperial: false,
    maxWidth: 160,
    updateWhenIdle: false,
}).addTo(map);

// Restore the user's snap clearances (dock ⚙) before any strip drag happens.
// v2 key: the tunnel magnet moved from 6 m (a road-underpass clearance that
// classified as an open cut in every world) to the 8 m design rule. A stored v1
// value would have quietly reinstated the old, wrong target, so the old key is
// abandoned rather than migrated.
const SNAP_CLEARANCE_STORAGE_KEY = 'plannerSnapClearances.v2';
try {
    const savedSnapClearances = JSON.parse(localStorage.getItem(SNAP_CLEARANCE_STORAGE_KEY) || 'null');
    if (savedSnapClearances) window.__profileStrip?.setSnapClearances?.(savedSnapClearances);
    localStorage.removeItem('plannerSnapClearances');
} catch (_e) { /* corrupted setting — defaults stand */ }

// Rebuilds the track's elevation decor: the route recoloured by the auto-grade
// REGIME (tunnel/cut/at-grade/fill/viaduct), IDENTICAL to the elevation strip so
// the map and the strip always agree. Elevation is authored in the strip now —
// this is display-only (the old ±1 levels + R ramp markers are retired). Called
// after any geometry OR elevation-profile change. Cheap enough to redo whole.
function rebuildTrackDecor(track) {
    if (track.decorGroup) {
        map.removeLayer(track.decorGroup);
        track.decorGroup = null;
    }
    if (!track.latlngs || track.latlngs.length < 2) return;

    const baseWeight = GAUGES[normalizeGauge(track.gauge)].trackWeight;
    const levelWeight = Math.max(2, baseWeight - 1);
    const layers = [];
    const addRun = (pts, regime, overrides = {}) => {
        if (pts.length < 2) return;
        layers.push(L.polyline(pts, {
            pane: TRACK_LEVEL_PANE,
            color: REGIME_MAP_COLORS[regime] || REGIME_MAP_COLORS['at-grade'],
            weight: levelWeight,
            opacity: 1,
            lineCap: 'round',
            lineJoin: 'round',
            interactive: false,
            ...overrides,
        }));
    };

    const vp = trackHasFreshAslProfile(track) ? track.verticalProfile : null;

    // Grade view: the same route, coloured by whether it climbs or descends in
    // the reading direction rather than by what carries it. One polyline per
    // authored grade tangent (PVI to PVI), so the colour boundaries are exactly
    // where the designed grade actually changes.
    if (trackDisplayMode === 'grade') {
        const spans = vp ? window.__gradeView.gradeSpans(vp, { flipped: gradeViewFlipped }) : [];
        if (spans.length === 0) {
            // No solved profile: the route has no grades to show. Painting it
            // flat would be a claim we cannot make, so it reads as unknown.
            addRun(track.latlngs, 'at-grade', {
                color: GRADE_UNKNOWN_COLOR,
                dashArray: '10, 8',
            });
        } else {
            const maxPct = GAUGES[normalizeGauge(track.gauge)].maxInclinePct;
            // Merged into colour bands first. A solved profile can hold a PVI
            // every 20 m (project 107 has ~2,950), and one polyline per tangent
            // was 2,958 SVG paths for a picture with a dozen readable colours —
            // the same draw-call trap the route itself was fixed for.
            const runs = window.__gradeView.mergeSpansByBand(spans, maxPct);
            const STEP_M = Math.max(20, vp.stepM || 20);
            for (const run of runs) {
                const points = [];
                for (let dM = run.dM0; dM < run.dM1; dM += STEP_M) {
                    const point = latLngAtChainage(track, dM);
                    if (point) points.push(point);
                }
                const endPoint = latLngAtChainage(track, run.dM1);
                if (endPoint) points.push(endPoint);
                addRun(points, 'at-grade', {
                    // The BAND's colour, not the run's exact mean: the legend
                    // shows discrete steps, so the map must draw those same
                    // steps or a swatch means nothing you can find out there.
                    color: window.__gradeView.bandColor(run.band, maxPct),
                    // Over the ruling grade breaks the line, because the colour
                    // ramp is already saturated there and cannot say it.
                    dashArray: window.__gradeView.bandDashArray(run.band),
                });
            }
        }
        if (layers.length > 0) track.decorGroup = L.layerGroup(layers).addTo(map);
        rebuildStationEnvelopes(track);
        return;
    }

    // Colour by the 3-state DISPLAY vocabulary (tunel / na terenu / vijadukt)
    // when stamped — depth-classified, so a 6 m city trench paints as tunnel.
    // Raw solver regimes only as a fallback before derivation has run.
    const decorRegimes = vp ? (vp.displayRegimes || vp.regimes) : null;
    if (vp && Array.isArray(decorRegimes) && decorRegimes.length >= 2) {
        // Walk the route at the profile step, grouping contiguous same-regime
        // runs into one coloured polyline each. Boundary points are shared so
        // the runs join seamlessly.
        const lengthM = track.lengthKm * 1000;
        let runRegime = decorRegimes[0];
        let runPts = [latLngAtChainage(track, 0)];
        for (let i = 1; i < decorRegimes.length; i++) {
            const pt = latLngAtChainage(track, Math.min(i * vp.stepM, lengthM));
            runPts.push(pt);
            if (decorRegimes[i] !== runRegime) {
                addRun(runPts, runRegime);
                runRegime = decorRegimes[i];
                runPts = [pt];
            }
        }
        addRun(runPts, runRegime);
    } else {
        // No fresh profile yet — one neutral line until it computes.
        addRun(track.latlngs, 'at-grade');
    }

    if (layers.length > 0) {
        track.decorGroup = L.layerGroup(layers).addTo(map);
    }
    rebuildStationEnvelopes(track);
}

// A station is not a point. It is a rigid building lying ALONG the route — 60 m
// of platform for a surface stop, 170 m of platform hall plus two throats
// underground — and that whole length has to be straight. A 16 px dot said none
// of this, so the constraint only ever surfaced as a refusal after the fact.
// Draw the real footprint: an emphasized bar over the span with a tick at each
// end, matching the platform bar in the elevation strip.
//
// The bar is display-only. The station still moves by dragging its marker in
// edit mode, which slides the whole envelope along the centreline (route-edit's
// attachStationDrag) — the envelope cannot be stretched or rotated off the
// route, because its axis IS the route's heading where it sits.
const STATION_ENVELOPE_COLOR = '#1d4ed8';
const STATION_ENVELOPE_FAULT_COLOR = '#dc2626';

// Its own layer group, not part of decorGroup: a station drag has to move the
// envelope with the marker on every frame, and rebuilding the whole regime-
// coloured route at that rate is wasted work.
function rebuildStationEnvelopes(track, { live = false } = {}) {
    if (track.stationEnvelopeGroup) {
        map.removeLayer(track.stationEnvelopeGroup);
        track.stationEnvelopeGroup = null;
    }
    const layers = buildStationEnvelopeLayers(track, { live });
    if (layers.length > 0) {
        track.stationEnvelopeGroup = L.layerGroup(layers).addTo(map);
    }
}

// `live` = mid-drag: skip the alignment check (it resamples the whole smoothed
// centreline per station) and draw the envelope neutral. The settled position
// gets the real colour a frame later.
function buildStationEnvelopeLayers(track, { live = false } = {}) {
    if (!trackHasFreshAslProfile(track)) return [];
    const spans = trackProfileStationInputs(track) || [];
    if (spans.length === 0) return [];
    const stations = project.stations
        .filter((station) => station.trackId === track.id && Array.isArray(station.latlng))
        .map((station) => ({
            station,
            dM: trackChainageAtLatLng(track, station.latlng[0], station.latlng[1]),
        }))
        .filter((entry) => Number.isFinite(entry.dM))
        .sort((a, b) => a.dM - b.dM);
    const halfWidth = Math.max(3, GAUGES[normalizeGauge(track.gauge)].trackWeight + 3);
    const layers = [];
    for (const span of spans) {
        if (!Number.isFinite(span.dM0) || !Number.isFinite(span.dM1)) continue;
        // Match each solver span back to its station so a broken one can be
        // drawn red. Spans and stations are both chainage-sorted, so nearest
        // centre is unambiguous.
        let owner = null, bestDistM = Infinity;
        for (const entry of stations) {
            const distM = Math.abs(entry.dM - span.dM);
            if (distM < bestDistM) { bestDistM = distM; owner = entry.station; }
        }
        const alignment = (owner && !live) ? getStationUndergroundAlignment(track, owner) : null;
        const color = alignment && !alignment.ok
            ? STATION_ENVELOPE_FAULT_COLOR
            : STATION_ENVELOPE_COLOR;
        const points = [];
        const STEP_M = 5;
        for (let dM = span.dM0; dM < span.dM1; dM += STEP_M) {
            const point = latLngAtChainage(track, dM);
            if (point) points.push(point);
        }
        const endPoint = latLngAtChainage(track, span.dM1);
        if (endPoint) points.push(endPoint);
        if (points.length < 2) continue;
        layers.push(L.polyline(points, {
            pane: TRACK_LEVEL_PANE,
            color,
            weight: halfWidth * 2,
            opacity: 0.55,
            lineCap: 'butt',
            lineJoin: 'round',
            interactive: false,
        }));
        // End ticks across the route, so the platform reads as an object with
        // ends rather than a thicker piece of track.
        for (const [endDM, neighbourDM] of [[span.dM0, span.dM0 + 2], [span.dM1, span.dM1 - 2]]) {
            const at = latLngAtChainage(track, endDM);
            const toward = latLngAtChainage(track, neighbourDM);
            if (!at || !toward) continue;
            const origin = L.latLng(at[0], at[1]);
            const ahead = latLngToLocalMeters(L.latLng(toward[0], toward[1]), origin);
            const lengthM = Math.hypot(ahead.x, ahead.y);
            if (lengthM < 1e-6) continue;
            // Perpendicular in local metres, converted back through the same
            // tangent frame the envelope check uses.
            const tickM = halfWidth * 1.6;
            const nx = (-ahead.y / lengthM) * tickM;
            const ny = (ahead.x / lengthM) * tickM;
            layers.push(L.polyline([
                localMetersToLatLng({ x: nx, y: ny }, origin),
                localMetersToLatLng({ x: -nx, y: -ny }, origin),
            ], {
                pane: TRACK_LEVEL_PANE,
                color,
                weight: 2,
                opacity: 0.9,
                interactive: false,
            }));
        }
    }
    return layers;
}

// One visual R belongs to one continuous ramp, even when horizontal curve
// shaping splits that ramp across several fractional-level geometry nodes.
function getTrackRampLabelPositions(track) {
    if (!track?.latlngs || track.latlngs.length < 2) return [];
    const pieces = [];
    for (let segmentIndex = 0; segmentIndex < track.latlngs.length - 1; segmentIndex++) {
        const profile = getTrackSegmentLevelProfile(track, segmentIndex);
        const spanT = profile.rampEndT - profile.rampStartT;
        if (spanT <= 1e-9 || profile.fromLevel === profile.toLevel) continue;
        const fromLevel = getContinuousTrackLevel(track, segmentIndex, profile.rampStartT);
        const toLevel = getContinuousTrackLevel(track, segmentIndex, profile.rampEndT);
        const direction = Math.sign(toLevel - fromLevel);
        if (direction === 0) continue;
        pieces.push({
            segmentIndex,
            startT: profile.rampStartT,
            endT: profile.rampEndT,
            fromLevel,
            toLevel,
            direction,
            lengthM: profile.lengthM * spanT,
        });
    }

    const runs = [];
    for (const piece of pieces) {
        const run = runs[runs.length - 1];
        const previous = run?.pieces[run.pieces.length - 1];
        const continuous = previous
            && piece.segmentIndex === previous.segmentIndex + 1
            && previous.endT >= 1 - 1e-9
            && piece.startT <= 1e-9
            && piece.direction === previous.direction
            && Math.abs(piece.fromLevel - previous.toLevel) <= TRACK_LEVEL_FULL_EPSILON;
        if (continuous) {
            run.pieces.push(piece);
            run.lengthM += piece.lengthM;
        } else {
            runs.push({ pieces: [piece], lengthM: piece.lengthM });
        }
    }

    return runs.map(run => {
        const targetM = run.lengthM * 0.5;
        let traversedM = 0;
        let midpoint = run.pieces[run.pieces.length - 1];
        let midpointT = midpoint.endT;
        for (const piece of run.pieces) {
            if (traversedM + piece.lengthM + 1e-9 < targetM) {
                traversedM += piece.lengthM;
                continue;
            }
            midpoint = piece;
            const localRatio = piece.lengthM > 1e-9
                ? Math.max(0, Math.min(1, (targetM - traversedM) / piece.lengthM))
                : 0.5;
            midpointT = piece.startT + (piece.endT - piece.startT) * localRatio;
            break;
        }
        return {
            latlng: interpolateSegmentPosition(track.latlngs, midpoint.segmentIndex, midpointT),
            direction: midpoint.direction,
            level: Math.sign(Math.abs(midpoint.fromLevel) >= Math.abs(midpoint.toLevel)
                ? midpoint.fromLevel
                : midpoint.toLevel),
        };
    });
}

// Length in km of track segments per level category — used for cost breakdowns.
function getTrackLevelBreakdownKm(track) {
    const breakdown = { underground: 0, surface: 0, elevated: 0, ramp: 0 };
    const addFullLevel = (level, lengthKm) => {
        if (lengthKm <= 0) return;
        if (level < 0) breakdown.underground += lengthKm;
        else if (level > 0) breakdown.elevated += lengthKm;
        else breakdown.surface += lengthKm;
    };
    for (let i = 0; i < track.latlngs.length - 1; i++) {
        const profile = getTrackSegmentLevelProfile(track, i);
        const lengthKm = profile.lengthM / 1000;
        if (profile.fromLevel === profile.toLevel) {
            addFullLevel(profile.fromLevel, lengthKm);
            continue;
        }
        addFullLevel(profile.fromLevel, lengthKm * profile.rampStartT);
        breakdown.ramp += lengthKm * (profile.rampEndT - profile.rampStartT);
        addFullLevel(profile.toLevel, lengthKm * (1 - profile.rampEndT));
    }
    return breakdown;
}

// Splits an existing track at the given point, creating two new tracks.
// Reassigns stations and updates lines referencing the old track.
// Returns { trackA, trackB, junctionLatlng } or null if split is not possible.
function splitTrackAtPoint(track, lat, lng) {
    const snap = nearestPointOnTrack(track, lat, lng);
    if (!snap) return null;

    const segIdx = snap.segmentIndex;
    let junctionPt = [snap.lat, snap.lon];
    let existingVertexIndex = null;
    for (const candidateIndex of [segIdx, segIdx + 1]) {
        if (candidateIndex <= 0 || candidateIndex >= track.latlngs.length - 1) continue;
        const candidate = track.latlngs[candidateIndex];
        if (distanceMetersLatLng(junctionPt[0], junctionPt[1], candidate[0], candidate[1])
            <= JUNCTION_EXISTING_VERTEX_THRESHOLD_METERS) {
            existingVertexIndex = candidateIndex;
            junctionPt = [...candidate];
            break;
        }
    }

    // Reuse an existing internal vertex verbatim so all three switch legs
    // share one exact graph node. Otherwise introduce a new split vertex.
    const latlngsA = existingVertexIndex != null
        ? track.latlngs.slice(0, existingVertexIndex + 1)
        : track.latlngs.slice(0, segIdx + 1).concat([junctionPt]);
    const latlngsB = existingVertexIndex != null
        ? track.latlngs.slice(existingVertexIndex)
        : [junctionPt].concat(track.latlngs.slice(segIdx + 1));

    // Need at least 2 points each
    if (latlngsA.length < 2 || latlngsB.length < 2) return null;

    // Junction vertex inherits the interpolated level of the split segment
    const segStart = track.latlngs[segIdx];
    const segEnd = track.latlngs[segIdx + 1];
    const segLenM = distanceMetersLatLng(segStart[0], segStart[1], segEnd[0], segEnd[1]);
    const junctionT = segLenM > 0
        ? distanceMetersLatLng(segStart[0], segStart[1], junctionPt[0], junctionPt[1]) / segLenM
        : 0;
    const junctionLevel = existingVertexIndex != null
        ? normalizeTrackLevel(track.levels?.[existingVertexIndex])
        : getInterpolatedLevel(track, segIdx, junctionT);
    const levelsA = existingVertexIndex != null
        ? track.levels.slice(0, existingVertexIndex + 1)
        : track.levels.slice(0, segIdx + 1).concat([junctionLevel]);
    const levelsB = existingVertexIndex != null
        ? track.levels.slice(existingVertexIndex)
        : [junctionLevel].concat(track.levels.slice(segIdx + 1));

    // Remove old track layers
    if (track.hitLayer) map.removeLayer(track.hitLayer);
    if (track.layer) map.removeLayer(track.layer);
    if (track.decorGroup) map.removeLayer(track.decorGroup);
    if (track.stationEnvelopeGroup) map.removeLayer(track.stationEnvelopeGroup);

    // Deselect if old track is selected
    if (selectedObject && selectedObject.type === 'track' && selectedObject.id === track.id) {
        deselectObject();
    }

    // Create two new tracks
    const splitM = turf.length(turf.lineString(latlngsA.map(([lat, lng]) => [lng, lat])), {
        units: 'kilometers',
    }) * 1000;
    const splitSegments = (fromM, toM) => (track.electrificationSegments || [])
        .map(segment => {
            const start = Math.max(fromM, Number(segment.fromM));
            const end = Math.min(toM, Number(segment.toM));
            if (!(end > start)) return null;
            return { ...segment, fromM: start - fromM, toM: end - fromM };
        })
        .filter(Boolean);
    const sharedElectrification = {
        electrified: track.electrified,
        voltage: track.voltage,
        frequency: track.frequency,
    };
    const trackA = createRuntimeTrack(track.gauge, latlngsA, levelsA, {
        ...sharedElectrification,
        electrificationSegments: splitSegments(0, splitM),
    });
    const trackB = createRuntimeTrack(track.gauge, latlngsB, levelsB, {
        ...sharedElectrification,
        electrificationSegments: splitSegments(splitM, track.lengthKm * 1000),
    });

    // Reassign stations to the correct half based on proximity
    for (const station of project.stations) {
        if (station.trackId !== track.id) continue;
        const distA = nearestPointOnTrack(trackA, station.latlng[0], station.latlng[1]);
        const distB = nearestPointOnTrack(trackB, station.latlng[0], station.latlng[1]);
        station.trackId = (distA && (!distB || distA.distSq <= distB.distSq)) ? trackA.id : trackB.id;
    }

    // Replace old track in project
    const oldIdx = project.tracks.findIndex(t => t.id === track.id);
    if (oldIdx !== -1) {
        project.tracks.splice(oldIdx, 1, trackA, trackB);
    } else {
        project.tracks.push(trackA, trackB);
    }

    // Rebuild motion profiles for any lines that have stations on the split tracks.
    // Lines are station lists — the split doesn't change them, only the underlying track geometry.
    for (const line of project.lines) {
        if (lineUsesTrack(line, trackA.id) || lineUsesTrack(line, trackB.id)) {
            rebuildLineProfilePreservingTrains(line);
        }
    }

    return { trackA, trackB, junctionLatlng: junctionPt };
}

// Handles snapping a drawn track's endpoint to an existing track.
// If near an endpoint of the target track, just returns that endpoint.
// If mid-track, splits the target and returns the junction point.
function connectToTrack(targetTrackId, lat, lng) {
    const target = project.tracks.find(t => t.id === targetTrackId);
    if (!target) return { latlng: [lat, lng] };

    const endpoint = isNearTrackEndpoint(target, lat, lng);
    if (endpoint === 'start') {
        return { latlng: [...target.latlngs[0]] };
    }
    if (endpoint === 'end') {
        return { latlng: [...target.latlngs[target.latlngs.length - 1]] };
    }

    // Mid-track: split
    const result = splitTrackAtPoint(target, lat, lng);
    if (result) {
        return { latlng: result.junctionLatlng, split: result };
    }

    // Fallback: just snap the coordinate
    return { latlng: [lat, lng] };
}

// Checks if a track endpoint is free (not shared with any other track's endpoint)
function isTrackEndpointFree(track, endpointIndex) {
    const pt = endpointIndex === 0 ? track.latlngs[0] : track.latlngs[track.latlngs.length - 1];
    const endpoint = endpointIndex === 0 ? 'start' : 'end';
    for (const other of project.tracks) {
        if (other.id === track.id) continue;
        const otherStart = other.latlngs[0];
        const otherEnd = other.latlngs[other.latlngs.length - 1];
        if (trackEndpointsAreCompatible(track, endpoint, other, 'start')
            && distanceMetersLatLng(pt[0], pt[1], otherStart[0], otherStart[1]) < JUNCTION_CONNECTIVITY_THRESHOLD_METERS) return false;
        if (trackEndpointsAreCompatible(track, endpoint, other, 'end')
            && distanceMetersLatLng(pt[0], pt[1], otherEnd[0], otherEnd[1]) < JUNCTION_CONNECTIVITY_THRESHOLD_METERS) return false;
    }
    return true;
}

function distanceMetersLatLng(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findNearbyStations(latlng, excludeStationId) {
    const results = [];
    for (const station of project.stations) {
        if (station.id === excludeStationId) continue;
        const dist = distanceMetersLatLng(latlng.lat, latlng.lng, station.latlng[0], station.latlng[1]);
        if (dist <= TRANSFER_LINK_RADIUS_METERS) {
            results.push({ station, distance: dist });
        }
    }
    // Also check reference rail stations
    if (railStationsResolvedData) {
        for (const stop of railStationsResolvedData) {
            const dist = distanceMetersLatLng(latlng.lat, latlng.lng, stop.lat, stop.lng);
            if (dist <= TRANSFER_LINK_RADIUS_METERS) {
                results.push({ referenceStop: stop, type: 'rail', distance: dist });
            }
        }
    }
    // Also check reference tram stops
    if (tramStopsResolvedData) {
        for (const stop of tramStopsResolvedData) {
            const dist = distanceMetersLatLng(latlng.lat, latlng.lng, stop.lat, stop.lng);
            if (dist <= TRANSFER_LINK_RADIUS_METERS) {
                results.push({ referenceStop: stop, type: 'tram', distance: dist });
            }
        }
    }
    return results;
}

// Resolves a station position to a full track level. Long level-changing
// segments retain flat margins around their localized ramp; a point just
// inside the incline snaps to the nearest flat/ramp boundary.
function resolveStationFullLevelPlacement(track, latlng, endpointSnapMeters = 0.05) {
    if (!track?.levels?.length || !track.latlngs || track.latlngs.length < 2 || !Array.isArray(latlng)) return null;
    const anchor = getStationSegmentAnchor({ latlng }, track.latlngs);
    const profile = getTrackSegmentLevelProfile(track, anchor.segmentIndex);
    if (profile.fromLevel === profile.toLevel) {
        if (!isFullTrackLevel(profile.fromLevel)) return null;
        return { level: Math.round(profile.fromLevel), latlng: [latlng[0], latlng[1]], ...anchor };
    }

    if (anchor.t <= profile.rampStartT && isFullTrackLevel(profile.fromLevel)) {
        return { level: Math.round(profile.fromLevel), latlng: [latlng[0], latlng[1]], ...anchor };
    }
    if (anchor.t >= profile.rampEndT && isFullTrackLevel(profile.toLevel)) {
        return { level: Math.round(profile.toLevel), latlng: [latlng[0], latlng[1]], ...anchor };
    }

    const distanceFromRampStartM = (anchor.t - profile.rampStartT) * profile.lengthM;
    if (distanceFromRampStartM <= endpointSnapMeters && isFullTrackLevel(profile.fromLevel)) {
        return {
            level: Math.round(profile.fromLevel),
            latlng: interpolateSegmentPosition(track.latlngs, anchor.segmentIndex, profile.rampStartT),
            segmentIndex: anchor.segmentIndex,
            t: profile.rampStartT,
        };
    }
    const distanceFromRampEndM = (profile.rampEndT - anchor.t) * profile.lengthM;
    if (distanceFromRampEndM <= endpointSnapMeters && isFullTrackLevel(profile.toLevel)) {
        return {
            level: Math.round(profile.toLevel),
            latlng: interpolateSegmentPosition(track.latlngs, anchor.segmentIndex, profile.rampEndT),
            segmentIndex: anchor.segmentIndex,
            t: profile.rampEndT,
        };
    }
    return null;
}

// Level of the track at the station's position (-1/0/+1), from its segment anchor.
function getStationLevel(station) {
    const track = station?.trackId != null ? project.tracks.find(t => t.id === station.trackId) : null;
    if (!track?.levels?.length || !track.latlngs || track.latlngs.length < 2) return 0;
    const fullLevel = resolveStationFullLevelPlacement(track, station.latlng);
    if (fullLevel) return fullLevel.level;
    // Invalid ramp-interior stations can only come from external/old data;
    // keep their display stable while all editing paths reject creating them.
    const anchor = getStationSegmentAnchor(station, track.latlngs);
    return getInterpolatedLevel(track, anchor.segmentIndex, anchor.t);
}

function getTransferLinkType(stationA, stationB) {
    // A transfer counts as underground if either end sits below the surface.
    if (getStationLevel(stationA) < 0 || (stationB && getStationLevel(stationB) < 0)) return 'underground';
    return 'overground';
}

function getCurrentTransferLinkPrice(linkType) {
    return PRICING_API.getTransferLinkPrice(linkType, activePricing);
}

// A transfer link is one of the priced objects, so a hand-typed price on it
// counts the same way it does on a viaduct. The gauge is irrelevant to a link
// price — getObjectRates only varies transferEur by link type.
function transferLinkCostEur(link, index) {
    return window.__civilObjects.objectCostEur(
        window.__civilObjects.transferObject(link, index),
        PRICING_API.getObjectRates('g1000', activePricing),
        currentObjectCostOverrides(),
    );
}

function pixelsToLatDeg(px) {
    const bounds = map.getBounds();
    const heightPx = map.getSize().y;
    return (bounds.getNorth() - bounds.getSouth()) / heightPx * px;
}

function hasDraftLine() {
    return currentLinePoints.length > 0;
}


// ─── Mode Switching ─────────────────────────────────────────────────────────
let routeGaugePickerOpen = false;

function setRouteGaugePickerOpen(open) {
    routeGaugePickerOpen = !!open;
    if (mapGaugePicker) mapGaugePicker.classList.toggle('hidden', !routeGaugePickerOpen);
    if (toggleTrackDrawingBtn) {
        toggleTrackDrawingBtn.classList.toggle('pending', routeGaugePickerOpen);
        toggleTrackDrawingBtn.setAttribute('aria-expanded', String(routeGaugePickerOpen));
    }
    syncMapActionButtons();
}

function syncMapActionButtons() {
    const canEdit = projectLifecyclePolicy().canEdit;
    if (toggleTrackDrawingBtn) {
        const active = currentMode === 'drawLine' || routeGaugePickerOpen;
        const hasUnfinishedTrack = currentMode === 'drawLine' && hasDraftLine();
        toggleTrackDrawingBtn.classList.toggle('active', active);
        toggleTrackDrawingBtn.setAttribute('aria-pressed', String(active));
        toggleTrackDrawingBtn.textContent = active ? '✓ Završi' : '＋ Nova trasa';
        toggleTrackDrawingBtn.setAttribute('aria-label', active ? 'Završi novu trasu' : 'Nova trasa');
        toggleTrackDrawingBtn.disabled = !canEdit || hasUnfinishedTrack;
        toggleTrackDrawingBtn.title = hasUnfinishedTrack
            ? 'Završite ili otkažite trasu ikonama uz posljednju točku.'
            : '';
    }
    if (toggleStationPlacementBtn) {
        const active = currentMode === 'placeStation';
        toggleStationPlacementBtn.classList.toggle('active', active);
        toggleStationPlacementBtn.setAttribute('aria-pressed', String(active));
        toggleStationPlacementBtn.textContent = active ? '✓ Završi' : '＋ Nova stanica';
        toggleStationPlacementBtn.setAttribute('aria-label', active ? 'Završi novu stanicu' : 'Nova stanica');
        toggleStationPlacementBtn.disabled = !canEdit;
    }
    if (toggleRouteEditingBtn) {
        const active = currentMode === 'edit';
        toggleRouteEditingBtn.classList.toggle('active', active);
        toggleRouteEditingBtn.setAttribute('aria-pressed', String(active));
        toggleRouteEditingBtn.textContent = active ? '✓ Završi' : '✎ Uredi mrežu';
        toggleRouteEditingBtn.setAttribute(
            'aria-label',
            active ? 'Završi uređivanje mreže' : 'Uredi mrežu',
        );
        toggleRouteEditingBtn.disabled = !canEdit;
    }
    if (toggleElectrificationEditingBtn) {
        const active = !!trackElectrificationEditor;
        const hasSelectedTrack = selectedObject?.type === 'track';
        toggleElectrificationEditingBtn.disabled = !canEdit || (!active && !hasSelectedTrack);
        toggleElectrificationEditingBtn.classList.toggle('active', active);
        toggleElectrificationEditingBtn.setAttribute('aria-pressed', String(active));
        toggleElectrificationEditingBtn.textContent = active
            ? '✓ Završi elektrifikaciju'
            : '⚡ Uredi elektrifikaciju';
        toggleElectrificationEditingBtn.title = hasSelectedTrack || active
            ? ''
            : 'Prvo odaberite trasu na karti.';
    }
    if (toggleReferenceConnectionBtn) {
        toggleReferenceConnectionBtn.disabled = !canEdit
            || !locationSupportsReferenceRail();
        toggleReferenceConnectionBtn.classList.toggle('active', referenceConnectionMode);
        toggleReferenceConnectionBtn.setAttribute('aria-pressed', String(referenceConnectionMode));
    }
}

function setMode(mode) {
    if (!projectLifecyclePolicy().canEdit && mode !== 'explore') {
        setStatusMessage('Ovaj projekt nije moguće uređivati.', true);
        syncMapActionButtons();
        return;
    }
    setRouteGaugePickerOpen(false);
    if (mode === currentMode) {
        syncMapActionButtons();
        return;
    }
    const previousMode = currentMode;
    if (previousMode === 'edit' && mode !== 'edit') {
        clearFreshVertex({ rerender: false });
        removeVertexHandles();
        removePreviewVertex();
        closeVertexLevelPopup();
        selectionSheet.classList.add('hidden');
        selectionSheet.innerHTML = '';
    }
    currentMode = mode;
    updateSelectionSheetChip();
    mapContainer.classList.toggle('edit-mode', mode === 'edit');
    lineControlsDiv.classList.toggle('hidden', mode !== 'drawLine');
    syncMapActionButtons();

    // Cancel any in-progress line drawing when switching away
    if (mode !== 'drawLine' && currentLinePoints.length > 0) {
        cancelCurrentLine();
    }

    // Clear overlays from explore mode
    catchmentRequestToken += 1;
    if (catchmentLayer) { map.removeLayer(catchmentLayer); catchmentLayer = null; }
    if (catchmentMarker) { map.removeLayer(catchmentMarker); catchmentMarker = null; }
    loadingDiv.classList.add('hidden');
    catchmentStatsDiv.classList.add('hidden');
    clearPreviewCatchment();
    clearPreviewStationDistances();
    removeStationPicker();
    if (snapMarker) { map.removeLayer(snapMarker); snapMarker = null; }
    lastSnappedLatLng = null;
    lastSnappedTrackId = null;
    lastReferenceRailSnap = null;
    setMapCursor(mode === 'placeStation'
        ? 'copy'
        : mode === 'drawLine'
            ? 'crosshair'
            : mode === 'edit' ? 'default' : '');

    if (mode === 'edit') closeWalkPopup();
    syncExclusiveEditInteractivity();

    syncAllCommittedStationDistanceLabels();
    updateStatus();
}

if (toggleTrackDrawingBtn) {
    toggleTrackDrawingBtn.addEventListener('click', () => {
        if (currentMode === 'drawLine') {
            if (hasDraftLine()) return;
            setMode('explore');
            setStatusMessage('Crtanje trase isključeno. Pritisnite „Uredi mrežu” za promjenu geometrije ili stanica.');
            return;
        }
        if (currentMode === 'edit') finishEditMode();
        if (currentMode === 'placeStation') setMode('explore');
        const nextOpen = !routeGaugePickerOpen;
        setRouteGaugePickerOpen(nextOpen);
        setStatusMessage(nextOpen
            ? 'Odaberite vrstu kolosijeka, zatim kliknite početak nove trase.'
            : 'Pokretanje nove trase otkazano.');
    });
}

if (mapGaugePicker) {
    mapGaugePicker.addEventListener('click', event => {
        const button = event.target.closest('[data-gauge]');
        if (!button) return;
        const gauge = normalizeGauge(button.dataset.gauge);
        const radio = document.querySelector(`input[name="trackGauge"][value="${gauge}"]`);
        if (radio) radio.checked = true;
        if (selectedObject) deselectObject();
        setMode('drawLine');
        setStatusMessage(`Nova ${GAUGES[gauge].label} trasa: kliknite početnu točku, zatim nastavite trasu.`);
    });
}

if (toggleStationPlacementBtn) {
    toggleStationPlacementBtn.addEventListener('click', () => {
        const enable = currentMode !== 'placeStation';
        setRouteGaugePickerOpen(false);
        if (selectedObject) deselectObject();
        setMode(enable ? 'placeStation' : 'explore');
        setStatusMessage(enable
            ? 'Postavljanje stanica: kliknite željeno mjesto na trasi.'
            : 'Postavljanje stanica isključeno. Odaberite trasu za pregled ili uređivanje.');
    });
}

if (toggleRouteEditingBtn) {
    toggleRouteEditingBtn.addEventListener('click', () => {
        if (currentMode === 'edit') {
            finishEditMode();
            return;
        }
        if (currentMode === 'drawLine' || currentMode === 'placeStation') setMode('explore');
        setRouteGaugePickerOpen(false);
        enterEditMode();
    });
}

if (toggleElectrificationEditingBtn) {
    toggleElectrificationEditingBtn.addEventListener('click', () => {
        if (trackElectrificationEditor) {
            stopTrackElectrificationEditor();
            setStatusMessage('Uređivanje elektrifikacije završeno.');
            return;
        }
        if (selectedObject?.type !== 'track') {
            syncMapActionButtons();
            setStatusMessage('Prvo odaberite trasu na karti.', true);
            return;
        }
        startTrackElectrificationEditor(selectedObject.ref);
    });
}

if (toggleReferenceConnectionBtn) {
    toggleReferenceConnectionBtn.addEventListener('click', async () => {
        if (!locationSupportsReferenceRail() || !projectLifecyclePolicy().canEdit) return;
        referenceConnectionMode = !referenceConnectionMode;
        toggleReferenceConnectionBtn.classList.toggle('active', referenceConnectionMode);
        toggleReferenceConnectionBtn.setAttribute('aria-pressed', String(referenceConnectionMode));
        if (referenceConnectionMode) {
            referenceRailVisible = true;
            updateReferenceRailProjectsButton();
            await Promise.all([
                ensureReferenceRailSnapGeometry(),
                refreshReferenceRailMapLayer(),
            ]);
            setStatusMessage('Spajanje uključeno: završetak nove trase zalijepite na ljubičasti čvor postojeće pruge.');
        } else {
            lastReferenceRailSnap = null;
            setStatusMessage('Spajanje na postojeću prugu isključeno.');
        }
    });
}

// The map tools stay collapsed behind the 📝 button until asked for, so the
// map is unobstructed by default. Collapsing them also leaves whatever mode
// they armed — the panel is the only way back out of it on a touch device.
let mapActionsOpen = false;

function setMapActionsOpen(open) {
    mapActionsOpen = open;
    if (mapActionPanel) mapActionPanel.classList.toggle('hidden', !open);
    if (toggleMapActionsBtn) {
        toggleMapActionsBtn.classList.toggle('active', open);
        toggleMapActionsBtn.setAttribute('aria-expanded', String(open));
    }
    if (!open) {
        setRouteGaugePickerOpen(false);
        if (currentMode !== 'explore') setMode('explore');
        if (trackElectrificationEditor) stopTrackElectrificationEditor();
    }
    syncViewportChrome();
}

if (toggleMapActionsBtn) {
    toggleMapActionsBtn.addEventListener('click', () => setMapActionsOpen(!mapActionsOpen));
}
setMapActionsOpen(false);

function updateStatus() {
    // Draw-mode hints are shown as toasts only on mode transitions, not every update
}

function getIconPopupDimensions(buttonCount = 2) {
    // Compute iconSize and iconAnchor so the rendered box (border-box) matches
    // exactly and the cursor lands on the center of the first button.
    const btnSize = mobileSidebarMedia.matches ? 44 : 28;
    const pad = 4;
    const gap = 4;
    const w = pad + buttonCount * btnSize + (buttonCount - 1) * gap + pad;
    const h = pad + btnSize + pad;
    const anchorX = pad + btnSize / 2;             // center of first button from left
    const anchorY = pad + btnSize / 2;             // center of first button from top
    return { iconSize: [w, h], iconAnchor: [anchorX, anchorY] };
}

// ─── Station type picker popup (map-based) ──────────────────────────────────
let stationPickerMarker = null;

function showStationPicker(latlng) {
    removeStationPicker();
    const { iconSize, iconAnchor } = getIconPopupDimensions();
    stationPickerMarker = L.marker(latlng, {
        icon: L.divIcon({
            className: 'station-picker-popup',
            html: `<button class="station-picker-btn" data-station-type="normal" title="Normalna stanica">🏘️</button>`
                + `<button class="station-picker-btn" data-station-type="depot" title="Remiza">🏠</button>`,
            iconSize,
            // Anchor at center of first button so cursor lands on it when popup appears
            iconAnchor,
        }),
        interactive: true,
        zIndexOffset: 2000,
    }).addTo(map);

    const el = stationPickerMarker.getElement();
    if (el) {
        el.addEventListener('mouseenter', () => { hoveringObject = true; });
        // Auto-dismiss when mouse leaves the popup buttons
        el.addEventListener('mouseleave', () => { removeStationPicker(); });
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const btn = e.target.closest('.station-picker-btn');
            if (!btn) return;
            const stationType = btn.dataset.stationType;
            const placeLatlng = stationPickerMarker.getLatLng();
            removeStationPicker();
            handleStationClick({ latlng: placeLatlng }, stationType);
        });
    }
}

function removeStationPicker() {
    if (stationPickerMarker) {
        hoveringObject = false;
        map.removeLayer(stationPickerMarker);
        stationPickerMarker = null;
    }
}

// ─── Depot popup (map-based + button to add trains) ────────────────────────
let depotPopupMarker = null;
let depotLineHighlightLayer = null;

function highlightLineOnMap(line) {
    removeLineHighlight();
    if (!line || !line.motionProfile) return;
    const latlngs = line.motionProfile.segments.map(seg => [seg.start.lat, seg.start.lng]);
    const lastSeg = line.motionProfile.segments[line.motionProfile.segments.length - 1];
    if (lastSeg) latlngs.push([lastSeg.end.lat, lastSeg.end.lng]);
    if (latlngs.length < 2) return;
    depotLineHighlightLayer = L.polyline(latlngs, {
        color: line.color || '#3b82f6',
        weight: 8,
        opacity: 0.7,
        interactive: false,
    }).addTo(map);
}

function removeLineHighlight() {
    if (depotLineHighlightLayer) {
        map.removeLayer(depotLineHighlightLayer);
        depotLineHighlightLayer = null;
    }
}

function buildDepotPopupHTML(station, side) {
    const track = project.tracks.find(t => t.id === station.trackId);
    const depotLines = project.lines.filter(l => l.depotStationId === station.id);

    let linesHTML = '';
    for (const line of depotLines) {
        const color = line.color || getLineColor(line.number || line.id);
        const trainCount = line.trains ? line.trains.length : 0;
        const stationCount = line.stationIds ? line.stationIds.length : 0;
        const trainHTML = `<div class="train-marker-shell" style="--train-color:${color}"><div class="train-marker-icon"></div></div>`;
        linesHTML += `<div class="depot-line-row" data-line-id="${line.id}">
            <span class="depot-popup-train train-marker train-marker-${normalizeGauge(track?.gauge)}">${trainHTML}</span>
            <span class="depot-line-label">L${line.number}</span>
            <span class="depot-line-info">${stationCount} st. / ${trainCount} vl.</span>
            <button class="depot-popup-add-train" data-line-id="${line.id}" title="Dodaj vlak">+🚆</button>
            <button class="depot-popup-delete-line" data-line-id="${line.id}" title="Ukloni liniju">✕</button>
        </div>`;
    }

    return `<div class="depot-popup depot-popup-${side || 'below'}">
        ${linesHTML}
        <button class="depot-popup-new-line" title="Dodaj liniju">Dodaj liniju</button>
    </div>`;
}

function showDepotPopup(station, placement) {
    removeDepotPopup();
    const side = placement || 'below';
    depotPopupMarker = L.marker(L.latLng(station.latlng[0], station.latlng[1]), {
        icon: L.divIcon({
            className: 'depot-popup-icon',
            html: buildDepotPopupHTML(station, side),
            iconSize: [0, 0],
            iconAnchor: [0, 0],
        }),
        interactive: true,
        zIndexOffset: 2000,
    }).addTo(map);

    const el = depotPopupMarker.getElement();
    if (el) {
        el.addEventListener('click', (e) => {
            e.stopPropagation();

            // Add train to existing line
            const addTrainBtn = e.target.closest('.depot-popup-add-train');
            if (addTrainBtn) {
                const lineId = Number(addTrainBtn.dataset.lineId);
                const line = project.lines.find(l => l.id === lineId);
                if (line) {
                    const lineProfile = line.motionProfile || getTrackForLine(line)?.motionProfile;
                    const depotOffset = lineProfile
                        ? getOffsetOnLine(L.latLng(station.latlng[0], station.latlng[1]), lineProfile)
                        : 0;
                    addTrainToLine(line, depotOffset || 0);
                    refreshDepotPopup(station, side);
                    attachDepotLineRowListeners(el);
                }
                return;
            }

            // Delete line
            const deleteBtn = e.target.closest('.depot-popup-delete-line');
            if (deleteBtn) {
                const lineId = Number(deleteBtn.dataset.lineId);
                removeLineHighlight();
                deleteLine(lineId);
                refreshDepotPopup(station, side);
                attachDepotLineRowListeners(el);
                return;
            }

            // New line
            const newLineBtn = e.target.closest('.depot-popup-new-line');
            if (newLineBtn) {
                removeDepotPopup();
                deselectObject();
                startLineBuildingMode(station);
                return;
            }
        });

        attachDepotLineRowListeners(el);
    }
}

function attachDepotLineRowListeners(popupEl) {
    const rows = popupEl.querySelectorAll('.depot-line-row');
    for (const row of rows) {
        row.addEventListener('mouseenter', () => {
            const lineId = Number(row.dataset.lineId);
            const line = project.lines.find(l => l.id === lineId);
            if (line) highlightLineOnMap(line);
        });
        row.addEventListener('mouseleave', () => {
            removeLineHighlight();
        });
        row.addEventListener('click', (e) => {
            // Don't open line popup if clicking add-train or delete-line buttons
            if (e.target.closest('.depot-popup-add-train') || e.target.closest('.depot-popup-delete-line')) return;
            const lineId = Number(row.dataset.lineId);
            const line = project.lines.find(l => l.id === lineId);
            if (!line) return;
            // Close depot context, open line popup
            removeLineHighlight();
            deselectObject();
            openLinePopup(line);
        });
    }
}

// Opens the shared bottom information sheet for a service line. Geometry
// editing is deliberately a separate action inside that sheet.
function openLinePopup(line) {
    if (!line) return;
    removeDepotPopup();
    const latlngs = getLineProfileLatLngs(line);
    const anchor = latlngs ? L.latLngBounds(latlngs).getCenter() : map.getCenter();
    selectObject('line', line.id, line, anchor);
}

function closeLinePopup() {
    removeLineHighlight();
    if (selectedObject?.type === 'line') deselectObject();
    else closeSelectionDisplay();
    hoveringObject = false;
}

function refreshDepotPopup(station, side) {
    if (!depotPopupMarker) return;
    const el = depotPopupMarker.getElement();
    if (!el) return;
    const container = el.querySelector('.depot-popup');
    if (container) {
        container.outerHTML = buildDepotPopupHTML(station, side);
    }
}

function removeDepotPopup() {
    removeLineHighlight();
    if (depotPopupMarker) {
        map.removeLayer(depotPopupMarker);
        depotPopupMarker = null;
    }
}

// ─── Line Building Mode ─────────────────────────────────────────────────
function startLineBuildingMode(depotStation) {
    const lineNumber = allocateLineNumber();
    const lineColor = getLineColor(lineNumber);
    const line = {
        id: allocateLineId(),
        number: lineNumber,
        color: lineColor,
        gauge: normalizeGauge(project.tracks.find(t => t.id === depotStation.trackId)?.gauge),
        depotStationId: depotStation.id,
        stationIds: [depotStation.id],
        _stationSet: new Set([depotStation.id]),
        motionProfile: null,
        stationStops: [],
        trains: [],
    };

    // Assign the depot to this line
    depotStation.lineId = line.id;

    lineBuildingState = { line, depotStation, pickerMarker: null };
    project.lines.push(line);

    setStatusMessage(`Gradite liniju ${lineNumber} — odaberite sljedeću stanicu.`);
    showNextStationPicker();
}

function showNextStationPicker() {
    if (!lineBuildingState) return;
    removeLineBuildingPicker();

    const { line, depotStation } = lineBuildingState;
    const lastStationId = line.stationIds[line.stationIds.length - 1];
    const lastStation = _stationById.get(lastStationId);
    if (!lastStation) { finishLineBuilding(); return; }

    const candidates = findNextReachableStations(lastStation, line.stationIds);

    // Build picker popup — station names on buttons
    let buttonsHTML = '';
    for (const candidate of candidates) {
        const name = getStationDisplayName(candidate.station);
        buttonsHTML += `<button class="line-picker-btn" data-station-id="${candidate.station.id}" data-via-tracks="${candidate.viaTrackIds.join(',')}">${escapeHtml(name)}</button>`;
    }
    buttonsHTML += `<button class="line-picker-finish">Zavrsi liniju</button>`;
    buttonsHTML += `<button class="line-picker-cancel">Prekini</button>`;

    // Picker stays at depot until a station beyond depot is added, then follows last-added station
    const pickerPosition = line.stationIds.length <= 1 ? depotStation.latlng : lastStation.latlng;

    const pickerMarker = L.marker(pickerPosition, {
        icon: L.divIcon({
            className: 'line-picker-icon',
            html: `<div class="line-picker-popup">${buttonsHTML}</div>`,
            iconSize: [0, 0],
            iconAnchor: [0, -10],
        }),
        interactive: true,
        zIndexOffset: 2500,
    }).addTo(map);

    const el = pickerMarker.getElement();
    if (el) {
        // Capture all mouse events so they don't leak to map layers underneath
        for (const evt of ['mousemove', 'mouseenter', 'mouseleave', 'mousedown', 'mouseup', 'mouseover', 'mouseout']) {
            el.addEventListener(evt, e => L.DomEvent.stopPropagation(e));
        }

        el.addEventListener('click', (e) => {
            e.stopPropagation();

            const stationBtn = e.target.closest('.line-picker-btn');
            if (stationBtn) {
                const stationId = Number(stationBtn.dataset.stationId);
                const viaTrackIds = stationBtn.dataset.viaTracks.split(',').map(Number);
                previewStationCandidate(stationId, viaTrackIds);
                return;
            }

            const finishBtn = e.target.closest('.line-picker-finish');
            if (finishBtn) {
                finishLineBuilding();
                return;
            }

            const cancelBtn = e.target.closest('.line-picker-cancel');
            if (cancelBtn) {
                cancelLineBuilding();
                return;
            }
        });
    }

    lineBuildingState.pickerMarker = pickerMarker;

    // Show permanent tooltips on all stations and highlight candidates
    showLineBuildingStationLabels();
    for (const candidate of candidates) {
        const marker = candidate.station.markerLayer;
        if (marker) {
            const el = marker.getElement();
            if (el) el.classList.add('station-marker-candidate');
        }
    }
}

// Two-step station selection: fly to candidate, show confirm/cancel popup
function previewStationCandidate(stationId, viaTrackIds) {
    if (!lineBuildingState) return;
    const station = _stationById.get(stationId);
    if (!station) return;

    const { line } = lineBuildingState;
    const lastStationId = line.stationIds[line.stationIds.length - 1];
    const lastStation = _stationById.get(lastStationId);

    // Remove current picker
    removeLineBuildingPicker();

    // Highlight the candidate station
    if (station.markerLayer) {
        const el = station.markerLayer.getElement();
        if (el) el.classList.add('station-marker-candidate');
    }

    // Fly to the candidate station
    map.flyTo(station.latlng, Math.max(map.getZoom(), 15), { duration: 0.4 });

    // Show confirm/cancel popup at the candidate station after fly completes
    setTimeout(() => {
        if (!lineBuildingState) return;
        const name = getStationDisplayName(station);
        const confirmHTML = `<div class="line-picker-popup line-picker-confirm">
            <div class="line-picker-confirm-label">${escapeHtml(name)}</div>
            <div class="line-picker-confirm-actions">
                <button class="line-picker-confirm-btn">Dodaj</button>
                <button class="line-picker-cancel-btn">Odustani</button>
            </div>
        </div>`;

        const confirmMarker = L.marker(station.latlng, {
            icon: L.divIcon({
                className: 'line-picker-icon',
                html: confirmHTML,
                iconSize: [0, 0],
                iconAnchor: [0, -10],
            }),
            interactive: true,
            zIndexOffset: 2500,
        }).addTo(map);

        const el = confirmMarker.getElement();
        if (el) {
            for (const evt of ['mousemove', 'mouseenter', 'mouseleave', 'mousedown', 'mouseup', 'mouseover', 'mouseout']) {
                el.addEventListener(evt, e => L.DomEvent.stopPropagation(e));
            }
            function cancelPreview() {
                map.removeLayer(confirmMarker);
                if (station.markerLayer) {
                    const markerEl = station.markerLayer.getElement();
                    if (markerEl) markerEl.classList.remove('station-marker-candidate');
                }
                if (lastStation) {
                    map.flyTo(lastStation.latlng, map.getZoom(), { duration: 0.4 });
                }
                setTimeout(() => { if (lineBuildingState) showNextStationPicker(); }, 450);
                document.removeEventListener('keydown', escapeHandler);
            }

            function escapeHandler(e) {
                if (e.key === 'Escape') { e.preventDefault(); cancelPreview(); }
            }
            document.addEventListener('keydown', escapeHandler);

            el.addEventListener('click', (e) => {
                e.stopPropagation();
                if (e.target.closest('.line-picker-confirm-btn')) {
                    document.removeEventListener('keydown', escapeHandler);
                    map.removeLayer(confirmMarker);
                    addStationToLineBuilding(stationId, viaTrackIds);
                } else if (e.target.closest('.line-picker-cancel-btn')) {
                    cancelPreview();
                }
            });
        }

        lineBuildingState.pickerMarker = confirmMarker;
    }, 450);
}

// Show station name labels during line building mode
function showLineBuildingStationLabels() {
    hideLineBuildingStationLabels();
    for (const station of project.stations) {
        const marker = station.markerLayer;
        if (!marker) continue;
        const name = getStationDisplayName(station);
        // Station names come from anonymous API submissions; Leaflet renders a
        // string tooltip as innerHTML, so escape before binding.
        marker.bindTooltip(escapeHtml(name), {
            permanent: true,
            direction: 'top',
            offset: [0, -10],
            opacity: 0.95,
            className: 'line-building-label',
        });
    }
}

function hideLineBuildingStationLabels() {
    for (const station of project.stations) {
        const marker = station.markerLayer;
        if (!marker) continue;
        // Restore normal (non-permanent) tooltip
        if (marker.getTooltip()) marker.unbindTooltip();
        const tooltipLabel = station.name ? station.name : getStationPlaceholderName(station);
        // Escape: Leaflet renders a string tooltip as innerHTML and the name is API-sourced.
        marker.bindTooltip(escapeHtml(tooltipLabel), {
            direction: 'top',
            offset: [0, -10],
            opacity: 0.95,
        });
    }
}

function addStationToLineBuilding(stationId, viaTrackIds) {
    if (!lineBuildingState) return;
    const { line } = lineBuildingState;
    const station = _stationById.get(stationId);
    if (!station) return;

    line.stationIds.push(stationId);
    line._stationSet = new Set(line.stationIds);
    station.lineId = line.id;

    clearCandidateHighlights();
    setStatusMessage(`Linija ${line.number}: ${line.stationIds.length} stanica. Odaberite sljedeću ili završite.`);

    // Pan map to the newly added station so it's visible
    if (station.latlng) {
        map.panTo(station.latlng, { animate: true, duration: 0.3 });
    }

    showNextStationPicker();
}

function finishLineBuilding() {
    if (!lineBuildingState) return;
    const { line } = lineBuildingState;

    clearCandidateHighlights();
    removeLineBuildingPicker();
    hideLineBuildingStationLabels();

    if (line.stationIds.length < 2) {
        // Not enough stations: remove the line
        setStatusMessage('Linija otkazana — potrebne su barem 2 stanice.', true);
        const idx = project.lines.findIndex(l => l.id === line.id);
        if (idx !== -1) project.lines.splice(idx, 1);
        // Unassign depot
        const depot = _stationById.get(line.depotStationId);
        if (depot && depot.lineId === line.id) depot.lineId = null;
    } else {
        // Build combined motion profile and start trains
        buildLineMotionProfileFromStations(line);
        updateLineStationStopsFromIds(line);
        startLineTrain(line);
        setStatusMessage(`Linija ${line.number} stvorena: ${line.stationIds.length} stanica.`);
    }

    const finishedLine = line.stationIds.length >= 2 ? line : null;
    lineBuildingState = null;
    updateTracksListUI();
    updateProjectSummary();

    // Select and focus the newly created line
    if (finishedLine) {
        flyToLine(finishedLine);
        setTimeout(() => openLinePopup(finishedLine), 550);
    }
}

function cancelLineBuilding() {
    if (!lineBuildingState) return;
    const { line } = lineBuildingState;

    clearCandidateHighlights();
    removeLineBuildingPicker();
    hideLineBuildingStationLabels();

    // Remove the line and unassign stations
    for (const stId of line.stationIds) {
        const st = _stationById.get(stId);
        if (st && st.lineId === line.id) st.lineId = null;
    }
    const idx = project.lines.findIndex(l => l.id === line.id);
    if (idx !== -1) project.lines.splice(idx, 1);

    lineBuildingState = null;
    setStatusMessage('Linija otkazana.');
    updateTracksListUI();
    updateProjectSummary();
}

function removeLineBuildingPicker() {
    if (lineBuildingState?.pickerMarker) {
        map.removeLayer(lineBuildingState.pickerMarker);
        lineBuildingState.pickerMarker = null;
    }
}

function clearCandidateHighlights() {
    for (const station of project.stations) {
        const el = station.markerLayer?.getElement();
        if (el) el.classList.remove('station-marker-candidate');
    }
}

// Starts drawing from a free endpoint of an existing track.
// New points will be appended/prepended to the track when finished.
function startExtendFromEndpoint(track, endpointIndex) {
    const endpoint = endpointIndex === 0 ? 'start' : 'end';
    const pt = endpoint === 'start' ? track.latlngs[0] : track.latlngs[track.latlngs.length - 1];
    const latlng = L.latLng(pt[0], pt[1]);

    deselectObject();

    const radio = document.querySelector(`input[name="trackGauge"][value="${normalizeGauge(track.gauge)}"]`);
    if (radio) radio.checked = true;

    setMode('drawLine');
    extendingTrack = { track, endpoint };
    drawingTrackLevel = normalizeTrackLevel(
        endpoint === 'start'
            ? track.levels?.[0]
            : track.levels?.[track.levels.length - 1],
    );

    currentLinePoints.push([latlng.lat, latlng.lng]);
    const marker = L.circleMarker(latlng, {
        radius: 5, color: '#333', fillColor: '#fff', fillOpacity: 1, weight: 2,
    }).addTo(map);
    currentLineVertexMarkers.push(marker);

    const style = getTrackStyle(track.gauge);
    currentLineLayer = L.polyline(currentLinePoints, style).addTo(map);

    updateFinishLineMarker();
    setStatusMessage('Produžite trasu — kliknite točke, spojite na drugu trasu ili završite.');
    updateStatus();
}

window.addEventListener('beforeunload', event => {
    if (!hasDraftLine() && !projectDirty) return;
    event.preventDefault();
    event.returnValue = '';
});

document.addEventListener('click', event => {
    if ((!hasDraftLine() && !projectDirty) || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const anchor = event.target.closest('a[href]');
    if (!shouldGuardNavigationLink(anchor)) return;

    event.preventDefault();
    requestNavigationGuard(() => {
        window.location.href = anchor.href;
    });
}, true);

// ─── Utility ────────────────────────────────────────────────────────────────
function formatNumber(n) {
    return Math.round(n).toLocaleString(UI_LOCALE);
}

function formatCost(eur) {
    if (eur >= 1_000_000_000) return `${(eur / 1_000_000_000).toFixed(2)} ${ui('B', 'mlrd')} EUR`;
    if (eur >= 1_000_000) return `${(eur / 1_000_000).toFixed(1)} ${ui('M', 'mil.')} EUR`;
    return `${formatNumber(eur)} EUR`;
}

function formatDistanceMeters(distanceMeters) {
    if (distanceMeters >= 1000) {
        const kilometers = distanceMeters / 1000;
        return `${kilometers.toFixed(kilometers >= 10 ? 0 : 1)} km`;
    }

    return `${formatNumber(distanceMeters)} m`;
}

// Per-km price of a gauge for a given object kind ('at-grade' is the base).
function getCurrentTrackUnitPrice(gauge, objectKind = 'at-grade') {
    return PRICING_API.getTrackUnitPricePerKm(gauge, objectKind, activePricing);
}

function getCurrentStationUnitPrice(stationType, gauge, stationKind = 'surface') {
    return PRICING_API.getStationUnitPrice(stationType, gauge, stationKind, activePricing);
}

// Cost of a whole track: the sum of the structures detected along it (viaducts,
// cuts, tunnels, embankments and the ground-level remainder). Stations are NOT
// in here — they are priced individually and would double-count.
function computeTrackConstructionCost(track) {
    return PRICING_API.computeTrackCostEur(
        pricingTrackView(track), activePricing, currentObjectCostOverrides(),
    );
}

// A station is priced as the object it structurally IS — a box under the
// ground, a platform in a trench, a deck on a viaduct — not as a level number.
function computeStationConstructionCost(stationType, gauge, stationKind = 'surface') {
    return getCurrentStationUnitPrice(stationType, gauge, stationKind);
}

function formatUnitPrice(value, suffix = '') {
    return suffix ? `${formatCost(value)}/${suffix}` : formatCost(value);
}

function syncPricingLabels() {
    for (const [gauge, el] of Object.entries(gaugePriceEls)) {
        if (el) el.textContent = formatUnitPrice(getCurrentTrackUnitPrice(gauge, 'at-grade'), 'km');
    }
}

function trackForStation(station) {
    if (station.trackId != null) return project.tracks.find(t => t.id === station.trackId) || null;
    if (station.lineId != null) return getTrackForLine(project.lines.find(l => l.id === station.lineId)) || null;
    return null;
}

function recomputeProjectCostsFromPricing() {
    project.tracks.forEach(track => {
        track.cost = computeTrackConstructionCost(track);
    });
    project.stations.forEach(station => {
        const track = trackForStation(station);
        station.cost = computeStationConstructionCost(
            station.stationType, track?.gauge, getStationStructureKind(track, station),
        );
    });
    recomputeTransferLinkCosts();
}

function refreshSelectedObjectDetails() {
    if (!selectedObject) return;
    renderSelectionSheet();
}

function applyPricingOverrides() {
    recomputeProjectCostsFromPricing();
    syncPricingLabels();
    updateTracksListUI();
    updateProjectSummary();
    refreshSelectedObjectDetails();
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getLineColor(lineNumber) {
    const index = Math.max(0, (lineNumber - 1) % LINE_COLOR_PALETTE.length);
    return LINE_COLOR_PALETTE[index];
}

function getLineStyle(gauge, color) {
    return {
        ...LINE_STYLES[normalizeGauge(gauge)],
        color,
    };
}

function getTrackStyle(gauge) {
    return TRACK_STYLES[normalizeGauge(gauge)];
}

function getStationMarkerClass(gauge, stationType, level = 0) {
    const levelClass = level < 0
        ? 'station-marker-underground'
        : level > 0 ? 'station-marker-elevated' : 'station-marker-surface';
    const shapeClass = stationType === 'depot' ? 'station-marker-square' : 'station-marker-round';
    return `station-marker station-marker-${normalizeGauge(gauge)} ${levelClass} ${shapeClass}`;
}

syncPricingLabels();

if (PRICING_API) {
    window.addEventListener('storage', event => {
        if (event.key && event.key !== PRICING_API.STORAGE_KEY) return;
        activePricing = PRICING_API.loadPricing();
        applyPricingOverrides();
    });
}

function getLineStopDwellSeconds(line) {
    return LINE_STOP_DWELL_SECONDS[normalizeGauge(line.gauge)];
}

function featureFromGeometry(geometry) {
    return geometry ? turf.feature(geometry) : null;
}

function unionPolygonFeatures(firstFeature, secondFeature) {
    if (!firstFeature) return secondFeature;
    if (!secondFeature) return firstFeature;

    const merged = turf.union(turf.featureCollection([firstFeature, secondFeature]));
    return merged || firstFeature;
}

function intersectPolygonFeatures(firstFeature, secondFeature) {
    if (!firstFeature || !secondFeature) return null;
    return turf.intersect(turf.featureCollection([firstFeature, secondFeature]));
}

function buildProjectCoverageGeometries() {
    const stationFeatures = project.stations
        .map(station => featureFromGeometry(station.catchmentPolygon))
        .filter(Boolean);

    if (stationFeatures.length === 0) {
        return { uniqueGeometry: null, multiCoverageGeometry: null };
    }

    let uniqueCoverageFeature = null;
    let multiCoverageFeature = null;

    for (const stationFeature of stationFeatures) {
        if (!uniqueCoverageFeature) {
            uniqueCoverageFeature = stationFeature;
            continue;
        }

        const overlapFeature = intersectPolygonFeatures(uniqueCoverageFeature, stationFeature);
        if (overlapFeature) {
            multiCoverageFeature = unionPolygonFeatures(multiCoverageFeature, overlapFeature);
        }

        uniqueCoverageFeature = unionPolygonFeatures(uniqueCoverageFeature, stationFeature);
    }

    return {
        uniqueGeometry: uniqueCoverageFeature ? uniqueCoverageFeature.geometry : null,
        multiCoverageGeometry: multiCoverageFeature ? multiCoverageFeature.geometry : null,
    };
}

async function computeProjectCoverageStats() {
    const rawPopulation = project.stations.reduce((sum, station) => sum + station.catchmentPopulation, 0);
    const rawJobs = project.stations.reduce((sum, station) => sum + station.catchmentJobs, 0);

    if (project.stations.length <= 1) {
        return {
            uniquePopulation: rawPopulation,
            uniqueJobs: rawJobs,
            multiPopulation: 0,
            multiJobs: 0,
            rawPopulation,
            rawJobs,
        };
    }

    const { uniqueGeometry, multiCoverageGeometry } = buildProjectCoverageGeometries();
    if (!uniqueGeometry) {
        return {
            uniquePopulation: rawPopulation,
            uniqueJobs: rawJobs,
            multiPopulation: 0,
            multiJobs: 0,
            rawPopulation,
            rawJobs,
        };
    }

    try {
        const [uniqueStats, multiStats] = await Promise.all([
            fetchCatchmentStats(uniqueGeometry),
            multiCoverageGeometry ? fetchCatchmentStats(multiCoverageGeometry) : Promise.resolve(null),
        ]);

        return {
            uniquePopulation: uniqueStats.catchment_population ?? rawPopulation,
            uniqueJobs: uniqueStats.catchment_jobs ?? rawJobs,
            multiPopulation: multiStats?.catchment_population ?? 0,
            multiJobs: multiStats?.catchment_jobs ?? 0,
            rawPopulation,
            rawJobs,
        };
    } catch (error) {
        console.error('Project coverage dedupe error:', error);
        return {
            uniquePopulation: rawPopulation,
            uniqueJobs: rawJobs,
            multiPopulation: 0,
            multiJobs: 0,
            rawPopulation,
            rawJobs,
        };
    }
}

function normalizeLatLngTuple(value) {
    if (!Array.isArray(value) || value.length < 2) return null;
    const lat = Number(value[0]);
    const lng = Number(value[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return [lat, lng];
}

function normalizeStationName(value) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, 120);
}

// Adapters that convert saved project formats into the current internal format.
// Current format (v9): separate tracks array with gauge, double-track layout,
// and continuous per-vertex ramp levels; lines are
// station lists (stationIndices + depotStationIndex), stations have trackIndex pointing
// into the tracks array, lineIndex into lines array, a name, and a level.

// Pre-v7 formats stored type underground (metro) / overground (tram); map them onto
// the closest gauge + level combination.
function mapLegacyTrackType(rawType, latlngs) {
    return rawType === 'underground'
        ? { gauge: 'g1435', levels: latlngs.map(() => -1) }
        : { gauge: 'g1000', levels: latlngs.map(() => 0) };
}

function migrateV2ProjectData(rawData) {
    // v2: "lines" contain track geometry (type + latlngs). One line = one track = one route.
    // Stations reference lines via lineIndex. No tracks array, no stationIndices on lines.
    const rawLines = Array.isArray(rawData?.lines) ? rawData.lines : [];

    const tracks = rawLines
        .map(line => {
            const latlngs = Array.isArray(line?.latlngs) ? line.latlngs.map(normalizeLatLngTuple).filter(Boolean) : [];
            if (latlngs.length < 2) return null;
            return { latlngs, ...mapLegacyTrackType(line?.type, latlngs) };
        })
        .filter(Boolean);

    // 1:1 mapping — each original "line" becomes a track and a legacy line referencing it
    const lines = tracks.map((_, i) => ({ trackIndex: i }));

    const rawStations = Array.isArray(rawData?.stations) ? rawData.stations : [];
    const stations = rawStations
        .map(st => {
            const latlng = normalizeLatLngTuple(st?.latlng);
            if (!latlng) return null;
            const lineIndex = Number.isInteger(st?.lineIndex) ? st.lineIndex : -1;
            if (lineIndex < 0 || lineIndex >= lines.length) return null;
            // In v2, lineIndex = trackIndex since they're 1:1
            return {
                trackIndex: lineIndex,
                lineIndex,
                latlng,
                stationType: st?.stationType === 'depot' ? 'depot' : 'normal',
                name: normalizeStationName(st?.name),
            };
        })
        .filter(Boolean);

    const transferLinks = parseTransferLinks(rawData?.transferLinks, stations.length);
    const walkMinutes = parseInt(normalizeWalkTimeValue(rawData?.walkMinutes ?? rawStations[0]?.walkMinutes), 10);

    return {
        version: 'v2->current',
        purpose: 'proposal',
        access: 'editable',
        referenceKind: null,
        provenance: null,
        walkMinutes,
        tracks,
        lines,
        stations,
        transferLinks,
    };
}

function migrateV6ProjectData(rawData) {
    // v6-v10: tracks array separate, lines are station lists with stationIndices + depotStationIndex,
    // stations have trackIndex and lineIndex. v7 added gauge + levels; v8 records
    // the double-track arrangement; v9 preserves fractional ramp levels; v10 adds
    // the optional auto-solved verticalProfile (parsed defensively — a v10 save
    // without one, or with a malformed one, is just a track to re-solve).
    const rawTracks = Array.isArray(rawData?.tracks) ? rawData.tracks : [];
    const tracks = rawTracks
        .map(track => {
            const latlngs = Array.isArray(track?.latlngs) ? track.latlngs.map(normalizeLatLngTuple).filter(Boolean) : [];
            if (latlngs.length < 2) return null;
            if (track?.gauge) {
                const levels = Array.isArray(track?.levels) && track.levels.length === latlngs.length
                    ? track.levels.map(normalizeTrackElevationLevel)
                    : latlngs.map(() => 0);
                return {
                    gauge: normalizeGauge(track.gauge),
                    ...TRACK_TOPOLOGY_API.normalize(track),
                    latlngs,
                    levels,
                    ...window.__trackElectrification.normalizeAuthoredFields(track),
                    electrificationSegments: window.__trackElectrification.normalizeElectrificationSegments(
                        track.electrificationSegments,
                        turf.length(turf.lineString(latlngs.map(([lat, lng]) => [lng, lat])), {
                            units: 'kilometers',
                        }) * 1000,
                    ),
                    reference: track.reference && typeof track.reference === 'object'
                        ? { ...track.reference }
                        : undefined,
                    verticalProfile: window.__verticalProfile
                        ? window.__verticalProfile.parseVerticalProfile(track.verticalProfile)
                        : null,
                };
            }
            return { latlngs, ...mapLegacyTrackType(track?.type, latlngs) };
        })
        .filter(Boolean);

    const rawLines = Array.isArray(rawData?.lines) ? rawData.lines : [];
    const lines = rawLines
        .map(line => {
            if (Array.isArray(line?.stationIndices) && line.stationIndices.length >= 2) {
                return {
                    stationIndices: line.stationIndices.filter(i => Number.isInteger(i) && i >= 0),
                    depotStationIndex: Number.isInteger(line?.depotStationIndex) ? line.depotStationIndex : -1,
                };
            }
            // Fallback: legacy line with trackIndex (shouldn't happen in true v6 data)
            const trackIndex = Number.isInteger(line?.trackIndex) ? line.trackIndex : -1;
            if (trackIndex < 0 || trackIndex >= tracks.length) return null;
            return { trackIndex };
        })
        .filter(Boolean);

    const rawStations = Array.isArray(rawData?.stations) ? rawData.stations : [];
    const stations = rawStations
        .map(st => {
            const latlng = normalizeLatLngTuple(st?.latlng);
            if (!latlng) return null;
            const trackIndex = Number.isInteger(st?.trackIndex) ? st.trackIndex : -1;
            const lineIndex = Number.isInteger(st?.lineIndex) ? st.lineIndex : -1;
            if (trackIndex < 0 && lineIndex < 0) return null;
            return {
                trackIndex: trackIndex >= 0 && trackIndex < tracks.length ? trackIndex : -1,
                lineIndex: lineIndex >= 0 && lineIndex < lines.length ? lineIndex : -1,
                latlng,
                stationType: st?.stationType === 'depot' ? 'depot' : 'normal',
                name: normalizeStationName(st?.name),
            };
        })
        .filter(Boolean);

    const transferLinks = parseTransferLinks(rawData?.transferLinks, stations.length);
    const walkMinutes = parseInt(normalizeWalkTimeValue(rawData?.walkMinutes ?? rawStations[0]?.walkMinutes), 10);
    // v11: the project's prepared-location id (only kept if it's a known one).
    const rawLocation = typeof rawData?.location === 'string' ? rawData.location.trim().toLowerCase() : '';
    const location = window.__locationRegistry?.isKnown(rawLocation) ? rawLocation : null;

    const purpose = rawData?.purpose === 'existing' ? 'existing' : 'proposal';
    const access = rawData?.access === 'reference' ? 'reference' : 'editable';
    const referenceKind = purpose === 'existing' && rawData?.referenceKind === 'rail'
        ? 'rail'
        : null;
    const provenance = rawData?.provenance && typeof rawData.provenance === 'object'
        ? { ...rawData.provenance }
        : null;

    return {
        version: 'v6',
        purpose,
        access,
        referenceKind,
        provenance,
        walkMinutes,
        tracks,
        lines,
        stations,
        transferLinks,
        location,
    };
}

function parseTransferLinks(rawLinks, stationCount) {
    if (!Array.isArray(rawLinks)) return [];
    return rawLinks
        .map(link => {
            const idxA = Number.isInteger(link?.stationAIndex) ? link.stationAIndex : -1;
            const idxB = Number.isInteger(link?.stationBIndex) ? link.stationBIndex : -1;
            if (idxA < 0 || idxA >= stationCount || idxB < 0 || idxB >= stationCount) return null;
            return { stationAIndex: idxA, stationBIndex: idxB, linkType: link?.linkType === 'underground' ? 'underground' : 'overground' };
        })
        .filter(Boolean);
}

function normalizeSavedProjectData(rawData) {
    const version = Number(rawData?.version) || 0;

    // v6+: current format with separate tracks and station-list lines
    if (version >= 6 || (Array.isArray(rawData?.tracks) && rawData.tracks.length > 0)) {
        return migrateV6ProjectData(rawData);
    }

    // v2-v4: geometry embedded in lines, stations reference lines via lineIndex
    if (Array.isArray(rawData?.lines) && rawData.lines.length > 0) {
        return migrateV2ProjectData(rawData);
    }

    // Unrecognized — return empty
    console.error(`[load] Unrecognized project data version: ${version}`);
    return {
        version: 'unknown',
        purpose: 'proposal',
        access: 'editable',
        referenceKind: null,
        provenance: null,
        walkMinutes: 10,
        tracks: [],
        lines: [],
        stations: [],
        transferLinks: [],
    };
}

function buildCanonicalProjectData() {
    const trackIndexById = new Map(project.tracks.map((track, index) => [track.id, index]));
    const lineIndexById = new Map(project.lines.map((line, index) => [line.id, index]));

    // Build stations — stations must be on a valid track (or line for legacy compat)
    const validStations = project.stations
        .map(station => {
            const trackIndex = station.trackId != null ? trackIndexById.get(station.trackId) : undefined;
            const lineIndex = station.lineId != null ? lineIndexById.get(station.lineId) : undefined;
            // Station must belong to at least a track or a line
            if (!Number.isInteger(trackIndex) && !Number.isInteger(lineIndex)) return null;
            return { id: station.id, trackIndex: trackIndex ?? -1, lineIndex: lineIndex ?? -1, station };
        })
        .filter(Boolean);

    const stationIndexById = new Map(validStations.map(({ id }, idx) => [id, idx]));

    const stations = validStations.map(({ trackIndex, lineIndex, station }) => ({
        trackIndex: trackIndex >= 0 ? trackIndex : undefined,
        lineIndex: lineIndex >= 0 ? lineIndex : undefined,
        latlng: [station.latlng[0], station.latlng[1]],
        stationType: station.stationType,
        name: normalizeStationName(station.name),
        autoNamed: station.autoNamed !== false,
        level: getStationLevel(station),
        // v12: the structural form the station was classified as. The level
        // cannot express it — a platform in a 6 m open cut is level 0 but is not
        // a surface station — and it is what prices the station, so anything
        // recomputing this project's cost needs it rather than re-deriving the
        // whole vertical alignment.
        structureKind: getStationStructureKind(trackForStation(station), station),
    }));

    const transferLinks = project.transferLinks
        .map(link => {
            const idxA = stationIndexById.get(link.stationIdA);
            const idxB = stationIndexById.get(link.stationIdB);
            if (!Number.isInteger(idxA) || !Number.isInteger(idxB)) return null;
            return { stationAIndex: idxA, stationBIndex: idxB, linkType: link.linkType };
        })
        .filter(Boolean);
    const authoredIdentity = PROJECT_LIFECYCLE_API.authoredProjectIdentity();

    return {
        // v10 adds track.verticalProfile (auto-solved vertical alignment,
        // absolute a.s.l., PVIs canonical). v11 adds the project's prepared
        // location id (which city/served area it belongs to). v12 adds
        // station.structureKind. v13 adds OSM-compatible track electrification
        // fields and optional chainage segments. v14 unifies existing rail as
        // reference templates. v15 records the terrain/interpolation revision
        // explicitly on each solved profile. Every authored save becomes a new proposal.
        version: 15,
        ...authoredIdentity,
        // Cached planner context for empty/pre-materialized loads. Runtime
        // geometry is authoritative and the 3D renderer uses player position.
        location: resolveProjectLocationId() || undefined,
        walkMinutes: getCurrentWalkMinutes(),
        tracks: project.tracks.map(track => ({
            gauge: track.gauge,
            ...TRACK_TOPOLOGY_API.normalize(track),
            latlngs: track.latlngs.map(([lat, lng]) => [lat, lng]),
            levels: track.levels.map(normalizeTrackElevationLevel),
            // Only a profile solved for EXACTLY this geometry+gauge is worth
            electrified: track.electrified ?? undefined,
            voltage: track.voltage ?? undefined,
            frequency: track.frequency ?? undefined,
            electrificationSegments: track.electrificationSegments?.length ? track.electrificationSegments : undefined,
            // persisting — a stale one would be wrong data with authority.
            // displayRegimes is a runtime display annotation (re-stamped on
            // every load) — keep the saved profile canonical solver output.
            verticalProfile: trackHasFreshAslProfile(track)
                ? { ...track.verticalProfile, displayRegimes: undefined }
                : undefined,
        })),
        lines: project.lines.map(line => ({
            // v6: lines store station path and depot
            stationIndices: (line.stationIds || []).map(id => stationIndexById.get(id)).filter(i => Number.isInteger(i)),
            depotStationIndex: stationIndexById.get(line.depotStationId) ?? -1,
            // v5 compat fallback
            trackIndex: trackIndexById.get(line.trackId),
            trainCount: (line.trains || []).length,
        })),
        stations,
        transferLinks,
    };
}

function getStationTypeLabel(station) {
    return station.stationType === 'depot' ? 'Remiza' : 'Stanica';
}

function getStationDisplayName(station) {
    if (normalizeStationName(station.name)) return station.name;
    return `${getStationTypeLabel(station)} ${station.id}`;
}

function getStationPlaceholderName(station) {
    return getStationDisplayName(station);
}

function refreshStationMarkerPresentation(station) {
    if (!station?.markerLayer) return;

    const tooltipLabel = station.name ? station.name : getStationPlaceholderName(station);
    // Escape: Leaflet renders string tooltip content as innerHTML and the name is API-sourced.
    const safeTooltipLabel = escapeHtml(tooltipLabel);
    if (station.markerLayer.getTooltip()) {
        station.markerLayer.setTooltipContent(safeTooltipLabel);
    } else {
        station.markerLayer.bindTooltip(safeTooltipLabel, {
            direction: 'top',
            offset: [0, -10],
            opacity: 0.95,
        });
    }
}

function getStationTitleEditorValue(station) {
    return normalizeStationName(station.name) || getStationTypeLabel(station);
}

function getActiveSelectionRoot() {
    return selectionSheet.classList.contains('hidden') ? null : selectionSheet;
}

function stopStationTitleEdit(save) {
    if (editingStationTitleId === null) return;

    const root = getActiveSelectionRoot();
    const inputEl = root ? root.querySelector('.sel-popup-title-input') : null;
    const titleEl = root ? root.querySelector('.sel-popup-title') : null;
    const station = project.stations.find(candidate => candidate.id === editingStationTitleId);
    const nextName = normalizeStationName(inputEl ? inputEl.value : '');
    const canSave = save && station && selectedObject && selectedObject.type === 'station' && selectedObject.id === station.id;

    editingStationTitleId = null;
    if (inputEl) inputEl.classList.add('hidden');
    if (titleEl) titleEl.classList.remove('hidden');

    if (!station) return;

    if (canSave) {
        station.name = nextName;
        // A chosen name locks out auto-naming; clearing it reverts to automatic
        // (nearest-road) naming on the next placement/reposition.
        station.autoNamed = !nextName;
        refreshStationMarkerPresentation(station);
        if (titleEl) titleEl.textContent = getStationDisplayName(station);
        setStatusMessage(nextName ? 'Ime stanice spremljeno.' : 'Ime stanice uklonjeno.');
        return;
    }

    if (titleEl) titleEl.textContent = getStationDisplayName(station);
}

function startStationTitleEdit(station) {
    if (!station || !selectedObject || selectedObject.type !== 'station' || selectedObject.id !== station.id) return;

    const root = getActiveSelectionRoot();
    if (!root) return;
    const inputEl = root.querySelector('.sel-popup-title-input');
    const titleEl = root.querySelector('.sel-popup-title');
    if (!inputEl || !titleEl) return;

    editingStationTitleId = station.id;
    inputEl.value = getStationTitleEditorValue(station);
    titleEl.classList.add('hidden');
    inputEl.classList.remove('hidden');
    inputEl.focus();
    inputEl.select();
    // Ensure keyboard does not obscure the popup on mobile
    if (mobileSidebarMedia.matches) syncViewportChrome();
}

function getSavedComputedStationData(saved, index) {
    const cachedStation = saved?.computed_data?.stations?.[index];
    if (cachedStation) {
        return {
            catchmentPolygon: cachedStation.catchmentPolygon || null,
            population: cachedStation.population || 0,
            jobs: cachedStation.jobs || 0,
        };
    }

    const legacyStation = saved?.project_data?.stations?.[index];
    if (!legacyStation) return null;
    if (!legacyStation.catchmentPolygon && !legacyStation.population && !legacyStation.jobs) return null;

    return {
        catchmentPolygon: legacyStation.catchmentPolygon || null,
        population: legacyStation.population || 0,
        jobs: legacyStation.jobs || 0,
    };
}

async function computeStationCatchmentData(latlng, walkMinutes, options = {}) {
    if (walkMinutes <= 0) {
        return {
            catchmentPolygon: null,
            catchmentPopulation: 0,
            catchmentJobs: 0,
        };
    }

    const polygonData = await fetchPedestrianCatchment(latlng.lat, latlng.lng, walkMinutes, options);
    const geometry = getOutermostPolygon(polygonData);

    let stats = { catchment_population: 0, catchment_jobs: 0 };
    if (geometry) {
        stats = await fetchCatchmentStats(geometry, options);
    }

    return {
        catchmentPolygon: geometry,
        catchmentPopulation: stats.catchment_population || 0,
        catchmentJobs: stats.catchment_jobs || 0,
    };
}

function createStationCatchmentLayer(geometry) {
    if (!geometry) return null;
    return L.geoJSON(geometry, {
        style: { color: STATION_CATCHMENT_COLOR, fillColor: STATION_CATCHMENT_COLOR, fillOpacity: 0.15, weight: 1 },
        interactive: false,
    }).addTo(map);
}

// ─── Station Graph Traversal (for line building) ────────────────────────
// Returns stations on a track sorted by their offset along the track.
function getStationsOnTrackSorted(track) {
    if (!track?.motionProfile) return [];
    return project.stations
        .filter(s => s.trackId === track.id)
        .map(s => ({
            station: s,
            offset: getOffsetOnLine(L.latLng(s.latlng[0], s.latlng[1]), track.motionProfile),
        }))
        .filter(e => e.offset !== null)
        .sort((a, b) => a.offset - b.offset);
}

// Finds tracks connected at a junction (shared endpoint within threshold).
// Returns array of { track, fromEnd: 'start'|'end' } — which end of the connected track is at the junction.
function findConnectedTracks(track, trackEnd) {
    const pt = trackEnd === 'start' ? track.latlngs[0] : track.latlngs[track.latlngs.length - 1];
    const results = [];
    for (const other of project.tracks) {
        if (other.id === track.id) continue;
        const otherStart = other.latlngs[0];
        const otherEnd = other.latlngs[other.latlngs.length - 1];
        if (trackEndpointsAreCompatible(track, trackEnd, other, 'start')
            && distanceMetersLatLng(pt[0], pt[1], otherStart[0], otherStart[1]) < JUNCTION_CONNECTIVITY_THRESHOLD_METERS) {
            results.push({ track: other, fromEnd: 'start' });
        }
        if (trackEndpointsAreCompatible(track, trackEnd, other, 'end')
            && distanceMetersLatLng(pt[0], pt[1], otherEnd[0], otherEnd[1]) < JUNCTION_CONNECTIVITY_THRESHOLD_METERS) {
            results.push({ track: other, fromEnd: 'end' });
        }
    }
    return results;
}

// Finds the next reachable stations from a given station, excluding already-visited ones.
// Returns array of { station, viaTrackIds: [trackId, ...] } — the path of tracks to reach each candidate.
function findNextReachableStations(currentStation, visitedStationIds) {
    const visited = new Set(visitedStationIds);
    const currentTrack = project.tracks.find(t => t.id === currentStation.trackId);
    if (!currentTrack?.motionProfile) return [];

    const results = [];
    const sorted = getStationsOnTrackSorted(currentTrack);
    const currentIndex = sorted.findIndex(e => e.station.id === currentStation.id);
    if (currentIndex === -1) return [];

    // Check forward (higher offset) neighbor on same track
    for (let i = currentIndex + 1; i < sorted.length; i++) {
        if (!visited.has(sorted[i].station.id)) {
            results.push({ station: sorted[i].station, viaTrackIds: [currentTrack.id] });
            break;
        }
    }

    // Check backward (lower offset) neighbor on same track
    for (let i = currentIndex - 1; i >= 0; i--) {
        if (!visited.has(sorted[i].station.id)) {
            results.push({ station: sorted[i].station, viaTrackIds: [currentTrack.id] });
            break;
        }
    }

    // Check junction crossings: for each direction, if there's no unvisited station
    // between current and the track endpoint, check connected tracks.
    const currentOffset = sorted[currentIndex].offset;
    const totalLen = currentTrack.motionProfile.totalLengthMeters;

    // Forward direction → track end
    const hasUnvisitedForward = sorted.slice(currentIndex + 1).some(e => !visited.has(e.station.id));
    if (!hasUnvisitedForward) {
        const connected = findConnectedTracks(currentTrack, 'end');
        for (const conn of connected) {
            findFirstStationOnConnectedTrack(conn, visited, [currentTrack.id], results);
        }
    }

    // Backward direction → track start
    const hasUnvisitedBackward = sorted.slice(0, currentIndex).some(e => !visited.has(e.station.id));
    if (!hasUnvisitedBackward) {
        const connected = findConnectedTracks(currentTrack, 'start');
        for (const conn of connected) {
            findFirstStationOnConnectedTrack(conn, visited, [currentTrack.id], results);
        }
    }

    return results;
}

// Helper: find the first unvisited station on a connected track, entering from a specific end.
// Recurse through junction chains (tracks with no stations that just connect to another track).
function findFirstStationOnConnectedTrack(conn, visited, pathTrackIds, results, maxDepth = 10) {
    if (maxDepth <= 0) return;
    const { track, fromEnd } = conn;

    // Avoid revisiting tracks already in the path
    if (pathTrackIds.includes(track.id)) return;

    const sorted = getStationsOnTrackSorted(track);
    const path = [...pathTrackIds, track.id];

    if (fromEnd === 'start') {
        // Entering from start: first unvisited station in forward order
        for (const entry of sorted) {
            if (!visited.has(entry.station.id)) {
                results.push({ station: entry.station, viaTrackIds: path });
                return;
            }
        }
        // No stations on this track: continue through the other end
        const nextConnected = findConnectedTracks(track, 'end');
        for (const next of nextConnected) {
            findFirstStationOnConnectedTrack(next, visited, path, results, maxDepth - 1);
        }
    } else {
        // Entering from end: first unvisited station in reverse order
        for (let i = sorted.length - 1; i >= 0; i--) {
            if (!visited.has(sorted[i].station.id)) {
                results.push({ station: sorted[i].station, viaTrackIds: path });
                return;
            }
        }
        // No stations: continue through the other end
        const nextConnected = findConnectedTracks(track, 'start');
        for (const next of nextConnected) {
            findFirstStationOnConnectedTrack(next, visited, path, results, maxDepth - 1);
        }
    }
}

// Builds a combined motion profile for a line from its ordered stationIds.
// Extracts track geometry between consecutive stations, stitching across tracks at junctions.
function buildLineMotionProfileFromStations(line) {
    if (!line.stationIds || line.stationIds.length < 2) {
        line.motionProfile = null;
        return;
    }

    const allLatlngs = [];

    for (let i = 0; i < line.stationIds.length - 1; i++) {
        const stA = _stationById.get(line.stationIds[i]);
        const stB = _stationById.get(line.stationIds[i + 1]);
        if (!stA || !stB) continue;

        const segLatlngs = extractPathBetweenStations(stA, stB);
        if (segLatlngs.length === 0) continue;

        // Avoid duplicating the junction point between segments
        if (allLatlngs.length > 0 && segLatlngs.length > 0) {
            const last = allLatlngs[allLatlngs.length - 1];
            const first = segLatlngs[0];
            if (distanceMetersLatLng(last[0], last[1], first[0], first[1]) < 1) {
                segLatlngs.shift();
            }
        }
        allLatlngs.push(...segLatlngs);
    }

    if (allLatlngs.length < 2) {
        line.motionProfile = null;
        return;
    }

    line.motionProfile = buildLineMotionProfile(allLatlngs, line.gauge);
}

// Extracts the latlng path along tracks between two stations.
// If they're on the same track, extracts the track segment between them.
// If on different tracks, does a BFS through track junctions to find the shortest path.
function extractPathBetweenStations(stA, stB) {
    const trackA = project.tracks.find(t => t.id === stA.trackId);
    const trackB = project.tracks.find(t => t.id === stB.trackId);
    if (!trackA || !trackB) return [];

    if (trackA.id === trackB.id) {
        return extractTrackSlice(trackA, stA.latlng, stB.latlng);
    }

    // BFS to find track path from trackA to trackB through junctions.
    // Each queue entry: { track, enteredFrom: 'start'|'end'|null, parent }
    const visited = new Set([trackA.id]);
    const queue = [];

    // Seed: from trackA's start and end, find connected tracks
    for (const end of ['start', 'end']) {
        for (const conn of findConnectedTracks(trackA, end)) {
            if (visited.has(conn.track.id)) continue;
            queue.push({
                track: conn.track,
                enteredFrom: conn.fromEnd, // which end of conn.track we entered
                exitEnd: end,              // which end of trackA we left from
                parent: null,
            });
        }
    }

    let found = null;
    const bfsVisited = new Set([trackA.id]);
    for (let i = 0; i < queue.length && !found; i++) {
        const entry = queue[i];
        if (bfsVisited.has(entry.track.id)) continue;
        bfsVisited.add(entry.track.id);

        if (entry.track.id === trackB.id) {
            found = entry;
            break;
        }

        // Continue through the other end of this track
        const otherEnd = entry.enteredFrom === 'start' ? 'end' : 'start';
        for (const conn of findConnectedTracks(entry.track, otherEnd)) {
            if (bfsVisited.has(conn.track.id)) continue;
            queue.push({
                track: conn.track,
                enteredFrom: conn.fromEnd,
                exitEnd: otherEnd,
                parent: entry,
            });
        }
    }

    if (!found) {
        // No track path found — straight line fallback
        return [stA.latlng, stB.latlng];
    }

    // Reconstruct the track chain: trackA → intermediate tracks → trackB
    const chain = [];
    for (let e = found; e; e = e.parent) {
        chain.unshift(e);
    }

    // Build the geometry path
    const allPath = [];

    // First segment: stA → the exit endpoint of trackA
    const firstExitEnd = chain[0].exitEnd; // 'start' or 'end' of trackA
    const firstEndpoint = firstExitEnd === 'end'
        ? trackA.latlngs[trackA.latlngs.length - 1]
        : trackA.latlngs[0];
    allPath.push(...extractTrackSlice(trackA, stA.latlng, firstEndpoint));

    // Intermediate tracks: traverse from entry end to exit end
    for (let i = 0; i < chain.length - 1; i++) {
        const entry = chain[i];
        const entryEndpoint = entry.enteredFrom === 'start'
            ? entry.track.latlngs[0]
            : entry.track.latlngs[entry.track.latlngs.length - 1];
        const exitEnd = entry.enteredFrom === 'start' ? 'end' : 'start';
        const exitEndpoint = exitEnd === 'end'
            ? entry.track.latlngs[entry.track.latlngs.length - 1]
            : entry.track.latlngs[0];
        const seg = extractTrackSlice(entry.track, entryEndpoint, exitEndpoint);
        allPath.push(...seg);
    }

    // Last segment: entry endpoint of trackB → stB
    const lastEntry = chain[chain.length - 1]; // this is the trackB entry
    const lastEntryEndpoint = lastEntry.enteredFrom === 'start'
        ? trackB.latlngs[0]
        : trackB.latlngs[trackB.latlngs.length - 1];
    allPath.push(...extractTrackSlice(trackB, lastEntryEndpoint, stB.latlng));

    // Deduplicate consecutive identical points
    const dedupedPath = [allPath[0]];
    for (let i = 1; i < allPath.length; i++) {
        const prev = dedupedPath[dedupedPath.length - 1];
        const curr = allPath[i];
        if (Math.abs(prev[0] - curr[0]) > 1e-9 || Math.abs(prev[1] - curr[1]) > 1e-9) {
            dedupedPath.push(curr);
        }
    }

    return dedupedPath.length >= 2 ? dedupedPath : [stA.latlng, stB.latlng];
}

// Extracts a slice of a track's latlngs between two points (as [lat,lng] arrays).
// Returns latlngs in the direction from pointA to pointB along the track.
function extractTrackSlice(track, pointA, pointB) {
    if (!track.motionProfile) return [pointA, pointB];

    const offsetA = getOffsetOnLine(L.latLng(pointA[0], pointA[1]), track.motionProfile);
    const offsetB = getOffsetOnLine(L.latLng(pointB[0], pointB[1]), track.motionProfile);
    if (offsetA === null || offsetB === null) return [pointA, pointB];

    const forward = offsetA <= offsetB;
    const startOffset = forward ? offsetA : offsetB;
    const endOffset = forward ? offsetB : offsetA;

    // Stations are saved against the editable tangent/control polyline, while
    // motionProfile is the circular alignment trains and 3D rails actually
    // follow. A control vertex can sit tens of metres outside a tight arc, so
    // never force that raw point back into the service geometry. Both slice
    // ends come from their projected offsets on the rendered alignment.
    const startPoint = sampleMotionProfileLatLng(track.motionProfile, startOffset).latlng;
    const endPoint = sampleMotionProfileLatLng(track.motionProfile, endOffset).latlng;
    const result = [[startPoint.lat, startPoint.lng]];

    // Use vertices from the actual circular motion path. Raw control-polygon
    // distances are longer around a corner and no longer share offsets with
    // the smoothed profile, which could otherwise skip or duplicate a bend.
    for (const vertex of profileToVertexOffsets(track.motionProfile)) {
        if (vertex.offsetMeters <= startOffset || vertex.offsetMeters >= endOffset) continue;
        result.push([vertex.latlng.lat, vertex.latlng.lng]);
    }

    result.push([endPoint.lat, endPoint.lng]);

    return forward ? result : result.reverse();
}

// Route-defining stationIds describe the path, but stations placed later on
// that path belong to the service through lineId without becoming new route
// waypoints. Keep one canonical service-station lookup for map stops, cab
// models, boarding, and saved-project repair.
function getLineServiceStations(line) {
    if (!line) return [];
    const routeStationIds = new Set(line.stationIds || []);
    return project.stations.filter(station => (
        station.lineId === line.id || routeStationIds.has(station.id)
    ));
}

// Updates stationStops for a station-list line using its combined motion
// profile and every station assigned to the service, including intermediate
// stations added after the original route was created.
function updateLineStationStopsFromIds(line) {
    if (!line.motionProfile || !line.stationIds) {
        line.stationStops = [];
        line._stationSet = new Set();
        return;
    }

    line.stationStops = buildLineStationStops(line).map(stop => ({
        stationId: stop.stationId,
        offsetMeters: stop.offsetMeters,
    }));
    line._stationSet = new Set(line.stationStops.map(stop => stop.stationId));
}

// User-drawn vertices are tangent intersections, not places where a rail may
// kink. A valid route reserves R*tan(turn/2) metres on both sides of each
// vertex, then replaces that corner with a circular arc at the gauge's minimum
// radius. Adjacent arcs may share a straight segment but may never overlap.
const TRACK_CURVE_MIN_TURN_DEG = 2;
const TRACK_CURVE_MAX_TURN_DEG = 179.5;
const TRACK_CURVE_SAMPLE_SPACING_M = 0.75;
const TRACK_CURVE_LENGTH_EPSILON_M = 0.2;
// Old saved routes are intentionally not migrated in this change. If one does
// not yet have enough tangent length, retain a small local Bézier softening so
// its train remains stable until the explicit one-off migration is approved.
const LEGACY_CURVE_MAX_FILLET_M = 8;
const LEGACY_CURVE_ADJ_LEN_FRACTION = 0.45;
const LEGACY_CURVE_MIN_ADJ_LEN_M = 2.4;

// Every quantity here is local: a turn reads three consecutive vertices, and a
// segment's violation reads the two turns at its ends. `fromVertex`/`toVertex`
// therefore let a caller that only cares about a few segments — a vertex drag,
// a smoothing chunk rebuild — pay for those instead of walking a 3,000-node
// line. Indices stay global in every returned array; entries outside the
// window are simply absent, and `partial` says so.
function buildTrackCurvePlan(latlngs, gauge, { fromVertex = null, toVertex = null } = {}) {
    if (!Array.isArray(latlngs) || latlngs.length < 2) {
        return { origin: null, points: [], segmentLengths: [], turns: [], violations: [] };
    }
    const lastIndex = latlngs.length - 1;
    const windowFrom = Number.isInteger(fromVertex) ? Math.max(0, Math.min(lastIndex, fromVertex)) : 0;
    const windowTo = Number.isInteger(toVertex) ? Math.max(windowFrom, Math.min(lastIndex, toVertex)) : lastIndex;
    const partial = windowFrom > 0 || windowTo < lastIndex;
    const origin = L.latLng(latlngs[0][0], latlngs[0][1]);
    const pts = new Array(latlngs.length);
    for (let i = windowFrom; i <= windowTo; i++) {
        pts[i] = latLngToLocalMeters(L.latLng(latlngs[i][0], latlngs[i][1]), origin);
    }
    const segmentLengths = new Array(lastIndex);
    for (let i = windowFrom; i < windowTo; i++) {
        segmentLengths[i] = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    }

    // The editable polyline is the midpoint between two tracks. Reserving the
    // vehicle minimum on the tighter inner track therefore requires adding
    // half the centre spacing to the centerline radius.
    const minRadiusM = getPlannerCenterlineMinCurveRadiusMeters(gauge);
    const turns = new Array(pts.length).fill(null);
    const turnsFrom = Math.max(1, windowFrom + 1);
    const turnsTo = Math.min(lastIndex - 1, windowTo - 1);
    for (let i = turnsFrom; i <= turnsTo; i++) {
        const previous = pts[i - 1];
        const current = pts[i];
        const next = pts[i + 1];
        const incomingLength = segmentLengths[i - 1];
        const outgoingLength = segmentLengths[i];
        if (incomingLength < 1e-6 || outgoingLength < 1e-6) continue;
        const incomingX = (current.x - previous.x) / incomingLength;
        const incomingY = (current.y - previous.y) / incomingLength;
        const outgoingX = (next.x - current.x) / outgoingLength;
        const outgoingY = (next.y - current.y) / outgoingLength;
        const dot = Math.max(-1, Math.min(1, incomingX * outgoingX + incomingY * outgoingY));
        const angleRad = Math.acos(dot);
        const angleDeg = angleRad * 180 / Math.PI;
        if (angleDeg < TRACK_CURVE_MIN_TURN_DEG) continue;
        const boundedAngle = Math.min(angleRad, TRACK_CURVE_MAX_TURN_DEG * Math.PI / 180);
        turns[i] = {
            vertexIndex: i,
            angleRad,
            angleDeg,
            cross: incomingX * outgoingY - incomingY * outgoingX,
            incomingX,
            incomingY,
            outgoingX,
            outgoingY,
            incomingLength,
            outgoingLength,
            radiusM: minRadiusM,
            tangentM: minRadiusM * Math.tan(boundedAngle * 0.5),
        };
    }

    const violations = [];
    // A segment's verdict needs the turns at BOTH its ends. Inside a window the
    // outermost segment is missing one of them, so it is left unjudged rather
    // than judged against a turn that was never computed.
    const violationFrom = windowFrom === 0 ? 0 : windowFrom + 1;
    const violationTo = windowTo === lastIndex ? lastIndex - 1 : windowTo - 2;
    for (let segmentIndex = violationFrom; segmentIndex <= violationTo; segmentIndex++) {
        const startTurn = turns[segmentIndex];
        const endTurn = turns[segmentIndex + 1];
        const requiredM = (startTurn?.tangentM || 0) + (endTurn?.tangentM || 0);
        const actualM = segmentLengths[segmentIndex];
        if (requiredM <= actualM + TRACK_CURVE_LENGTH_EPSILON_M) continue;
        violations.push({
            segmentIndex,
            actualM,
            requiredM,
            shortfallM: requiredM - actualM,
            vertexIndices: [startTurn?.vertexIndex, endTurn?.vertexIndex]
                .filter(index => Number.isInteger(index)),
        });
    }
    return { origin, points: pts, segmentLengths, turns, violations, minRadiusM, partial };
}

// The vertex window that makes every segment in `segmentIndices` judgeable:
// one vertex before the first segment, two past the last.
function getCurvePlanWindowForSegments(segmentIndices) {
    let first = Infinity;
    let last = -Infinity;
    for (const segmentIndex of segmentIndices) {
        if (!Number.isInteger(segmentIndex)) continue;
        if (segmentIndex < first) first = segmentIndex;
        if (segmentIndex > last) last = segmentIndex;
    }
    if (!Number.isFinite(first)) return null;
    return { fromVertex: first - 1, toVertex: last + 2 };
}

function getTrackCurveViolations(gauge, latlngs, segmentIndices = null) {
    if (!Array.isArray(segmentIndices)) {
        const plan = buildTrackCurvePlan(latlngs, gauge);
        return { plan, violations: plan.violations };
    }
    const window = getCurvePlanWindowForSegments(segmentIndices);
    if (!window) return { plan: buildTrackCurvePlan(latlngs, gauge, { fromVertex: 0, toVertex: 0 }), violations: [] };
    const plan = buildTrackCurvePlan(latlngs, gauge, window);
    const allowed = new Set(segmentIndices);
    return {
        plan,
        violations: plan.violations.filter(violation => allowed.has(violation.segmentIndex)),
    };
}

function getDraftTrackCurveCheck(drawnLatlngs = currentLinePoints) {
    const gauge = normalizeGauge(extendingTrack?.track?.gauge
        || document.querySelector('input[name="trackGauge"]:checked')?.value);
    if (!extendingTrack) {
        const result = getTrackCurveViolations(gauge, drawnLatlngs);
        return { gauge, latlngs: drawnLatlngs, ...result };
    }

    const track = extendingTrack.track;
    const addedCount = Math.max(0, drawnLatlngs.length - 1);
    if (addedCount === 0) {
        const result = getTrackCurveViolations(gauge, track.latlngs, []);
        return { gauge, latlngs: track.latlngs, ...result };
    }

    let latlngs;
    let affectedSegments;
    if (extendingTrack.endpoint === 'end') {
        latlngs = [...track.latlngs, ...drawnLatlngs.slice(1)];
        const first = Math.max(0, track.latlngs.length - 2);
        affectedSegments = Array.from(
            { length: Math.max(0, latlngs.length - 1 - first) },
            (_, index) => first + index,
        );
    } else {
        latlngs = [...drawnLatlngs.slice(1).reverse(), ...track.latlngs];
        affectedSegments = Array.from(
            { length: Math.min(latlngs.length - 1, addedCount + 1) },
            (_, index) => index,
        );
    }
    const result = getTrackCurveViolations(gauge, latlngs, affectedSegments);
    // Existing saved geometry is deliberately left in place until the later
    // migration. Extension is blocked only when it creates a new violation or
    // makes the old endpoint's existing shortfall worse.
    const baseline = buildTrackCurvePlan(track.latlngs, gauge).violations;
    const baselineBySegment = new Map(baseline.map(violation => [violation.segmentIndex, violation.shortfallM]));
    result.violations = result.violations.filter(violation => {
        const oldSegmentIndex = extendingTrack.endpoint === 'end'
            ? violation.segmentIndex
            : violation.segmentIndex - addedCount;
        const oldShortfallM = baselineBySegment.get(oldSegmentIndex) || 0;
        return violation.shortfallM > oldShortfallM + TRACK_CURVE_LENGTH_EPSILON_M;
    });
    return { gauge, latlngs, ...result };
}

function showTrackCurveViolation(gauge, latlngs, violations) {
    if (!violations || violations.length === 0) return;
    const config = GAUGES[normalizeGauge(gauge)];
    const worstShortfallM = Math.max(...violations.map(violation => violation.shortfallM));
    flashTrackSegments(
        { latlngs },
        violations.map(violation => violation.segmentIndex),
        { gauge, curveViolations: violations },
    );
    const shortfallLabel = violations.length === 1
        ? `Označenom odsjeku nedostaje ${Math.ceil(worstShortfallM)} m`
        : `Na označenim odsjecima nedostaje do ${Math.ceil(worstShortfallM)} m`;
    const angleCount = getCurveViolationVertexIndices(violations).length;
    const anglePointerLabel = angleCount === 1
        ? 'Crveni znak ∠ pokazuje problematični zavoj.'
        : 'Crveni znakovi ∠ pokazuju problematične zavoje.';
    setStatusMessage(
        `Zavoj je preoštar za dvokolosiječnu ${config.label} trasu `
        + `(min unutarnji polumjer ${config.minCurveRadiusM} m; os trase ${Math.ceil(getPlannerCenterlineMinCurveRadiusMeters(gauge))} m). `
        + `${anglePointerLabel} ${shortfallLabel} za neprekinuti luk. `
        + 'Pomaknite točku ili produžite odsjek.',
        true,
    );
}

function validateDraftTrackCurves(drawnLatlngs = currentLinePoints, { warn = true } = {}) {
    const check = getDraftTrackCurveCheck(drawnLatlngs);
    if (check.violations.length === 0) return true;
    if (warn) showTrackCurveViolation(check.gauge, check.latlngs, check.violations);
    return false;
}

function pushUniqueSmoothedPoint(out, point, origin) {
    const ll = localMetersToLatLng(point, origin);
    const candidate = [ll.lat, ll.lng];
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - candidate[0]) > 1e-10 || Math.abs(last[1] - candidate[1]) > 1e-10) {
        out.push(candidate);
    }
}

function appendCircularTrackCurve(out, current, turn, origin) {
    if (!turn || Math.abs(turn.cross) < 1e-7) return false;
    const tangentM = turn.tangentM;
    const entry = {
        x: current.x - turn.incomingX * tangentM,
        y: current.y - turn.incomingY * tangentM,
    };
    const exit = {
        x: current.x + turn.outgoingX * tangentM,
        y: current.y + turn.outgoingY * tangentM,
    };
    const direction = turn.cross > 0 ? 1 : -1;
    const center = {
        x: entry.x - turn.incomingY * direction * turn.radiusM,
        y: entry.y + turn.incomingX * direction * turn.radiusM,
    };
    const startAngle = Math.atan2(entry.y - center.y, entry.x - center.x);
    const endAngle = Math.atan2(exit.y - center.y, exit.x - center.x);
    let sweep = endAngle - startAngle;
    if (direction > 0 && sweep < 0) sweep += Math.PI * 2;
    if (direction < 0 && sweep > 0) sweep -= Math.PI * 2;
    const sampleCount = Math.max(
        4,
        Math.ceil((Math.abs(sweep) * turn.radiusM) / TRACK_CURVE_SAMPLE_SPACING_M),
    );
    for (let sample = 0; sample <= sampleCount; sample++) {
        const angle = startAngle + sweep * (sample / sampleCount);
        pushUniqueSmoothedPoint(out, {
            x: center.x + Math.cos(angle) * turn.radiusM,
            y: center.y + Math.sin(angle) * turn.radiusM,
        }, origin);
    }
    return true;
}

function appendLegacyTrackCurve(out, previous, current, next, origin) {
    const incomingX = current.x - previous.x;
    const incomingY = current.y - previous.y;
    const outgoingX = next.x - current.x;
    const outgoingY = next.y - current.y;
    const incomingLength = Math.hypot(incomingX, incomingY);
    const outgoingLength = Math.hypot(outgoingX, outgoingY);
    if (incomingLength < LEGACY_CURVE_MIN_ADJ_LEN_M || outgoingLength < LEGACY_CURVE_MIN_ADJ_LEN_M) return false;
    const filletM = Math.min(
        LEGACY_CURVE_MAX_FILLET_M,
        incomingLength * LEGACY_CURVE_ADJ_LEN_FRACTION,
        outgoingLength * LEGACY_CURVE_ADJ_LEN_FRACTION,
    );
    const entry = {
        x: current.x - (incomingX / incomingLength) * filletM,
        y: current.y - (incomingY / incomingLength) * filletM,
    };
    const exit = {
        x: current.x + (outgoingX / outgoingLength) * filletM,
        y: current.y + (outgoingY / outgoingLength) * filletM,
    };
    const sampleCount = Math.max(4, Math.ceil((filletM * 2) / TRACK_CURVE_SAMPLE_SPACING_M));
    for (let sample = 0; sample <= sampleCount; sample++) {
        const t = sample / sampleCount;
        const omt = 1 - t;
        pushUniqueSmoothedPoint(out, {
            x: omt * omt * entry.x + 2 * omt * t * current.x + t * t * exit.x,
            y: omt * omt * entry.y + 2 * omt * t * current.y + t * t * exit.y,
        }, origin);
    }
    return true;
}

// The smoothed centreline is the concatenation of one independent chunk per
// source vertex: the vertex itself, or the arc/fillet that replaces its corner.
// `previousPoint` is only there so the chunk can drop a first sample that
// coincides with the tail of the chunk before it, exactly as the single-pass
// loop did.
function buildSmoothedVertexChunk(latlngs, plan, invalidTurnIndices, index, previousPoint) {
    const lastIndex = latlngs.length - 1;
    if (index === 0 || index === lastIndex) return [latlngs[index]];
    const scratch = previousPoint ? [previousPoint] : [];
    const seedLength = scratch.length;
    const turn = plan.turns[index];
    const appended = turn && turn.angleDeg < TRACK_CURVE_MAX_TURN_DEG
        && ((!invalidTurnIndices.has(index)
            && appendCircularTrackCurve(scratch, plan.points[index], turn, plan.origin))
            || appendLegacyTrackCurve(
                scratch, plan.points[index - 1], plan.points[index], plan.points[index + 1], plan.origin,
            ));
    if (!appended) scratch.push(latlngs[index]);
    return scratch.slice(seedLength);
}

// Smoothing a 3,000-node line into ~14,000 arc points costs ~17 ms, and a
// vertex drag asks for it on every frame. Since each chunk depends only on its
// own vertex and the two beside it, the chunks are cached against the vertex
// array they came from: a moved node rebuilds the handful around it and the
// rest is reused untouched. Keyed weakly, so it dies with the track.
const trackSmoothingCache = new WeakMap();
// A moved vertex k changes turns k-1..k+1 and the violations of segments
// k-2..k+1, hence chunks k-2..k+2. One extra chunk of margin on each side.
const SMOOTHING_CHUNK_MARGIN = 3;
// More than a drag's worth of moved vertices is a wholesale edit, not a nudge.
const SMOOTHING_INCREMENTAL_MAX_MOVED_VERTICES = 8;

function snapshotLatLngs(latlngs) {
    const snapshot = new Float64Array(latlngs.length * 2);
    for (let i = 0; i < latlngs.length; i++) {
        snapshot[i * 2] = latlngs[i][0];
        snapshot[i * 2 + 1] = latlngs[i][1];
    }
    return snapshot;
}

function findMovedVertexRange(snapshot, latlngs) {
    let first = -1;
    let last = -1;
    let count = 0;
    for (let i = 0; i < latlngs.length; i++) {
        if (snapshot[i * 2] === latlngs[i][0] && snapshot[i * 2 + 1] === latlngs[i][1]) continue;
        if (first < 0) first = i;
        last = i;
        count++;
    }
    return { first, last, count };
}

function samePointList(left, right) {
    if (!left || !right || left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
        if (left[i][0] !== right[i][0] || left[i][1] !== right[i][1]) return false;
    }
    return true;
}

function buildTrackSmoothingCacheEntry(latlngs, gauge) {
    const plan = buildTrackCurvePlan(latlngs, gauge);
    const invalidTurnIndices = new Set(plan.violations.flatMap(violation => violation.vertexIndices));
    const chunks = new Array(latlngs.length);
    const points = [];
    for (let i = 0; i < latlngs.length; i++) {
        const chunk = buildSmoothedVertexChunk(latlngs, plan, invalidTurnIndices, i, points[points.length - 1]);
        chunks[i] = chunk;
        for (const point of chunk) points.push(point);
    }
    const entry = { gauge, chunks, points, snapshot: snapshotLatLngs(latlngs) };
    trackSmoothingCache.set(latlngs, entry);
    return entry;
}

// Returns false when the cached chunks cannot be patched cheaply and the caller
// should rebuild from scratch.
function patchTrackSmoothingCacheEntry(latlngs, gauge, entry, moved) {
    const lastIndex = latlngs.length - 1;
    // Vertex 0 is the projection origin: moving it perturbs every local
    // coordinate, so nothing downstream is reusable.
    if (moved.first === 0) return false;
    const from = Math.max(1, moved.first - SMOOTHING_CHUNK_MARGIN);
    const to = Math.min(lastIndex, moved.last + SMOOTHING_CHUNK_MARGIN);
    const plan = buildTrackCurvePlan(latlngs, gauge, {
        fromVertex: from - 2,
        toVertex: Math.min(lastIndex, to + 2),
    });
    const invalidTurnIndices = new Set(plan.violations.flatMap(violation => violation.vertexIndices));

    let startOffset = 0;
    for (let i = 0; i < from; i++) startOffset += entry.chunks[i].length;
    let removedLength = 0;
    for (let i = from; i <= to; i++) removedLength += entry.chunks[i].length;

    const rebuilt = [];
    let previousPoint = entry.points[startOffset - 1];
    for (let i = from; i <= to; i++) {
        const chunk = buildSmoothedVertexChunk(latlngs, plan, invalidTurnIndices, i, previousPoint);
        rebuilt.push(chunk);
        if (chunk.length > 0) previousPoint = chunk[chunk.length - 1];
    }
    // The last rebuilt chunk lies outside the moved vertex's reach, so its own
    // inputs are unchanged. If it still came out different, the change is
    // rippling further than the margin allows and only a full rebuild is safe.
    if (to < lastIndex && !samePointList(rebuilt[rebuilt.length - 1], entry.chunks[to])) return false;

    entry.points.splice(startOffset, removedLength, ...rebuilt.flat());
    for (let i = from; i <= to; i++) entry.chunks[i] = rebuilt[i - from];
    for (let i = moved.first; i <= moved.last; i++) {
        entry.snapshot[i * 2] = latlngs[i][0];
        entry.snapshot[i * 2 + 1] = latlngs[i][1];
    }
    return true;
}

function resampleLatLngsSmooth(latlngs, gauge = 'g1000') {
    if (!Array.isArray(latlngs) || latlngs.length < 3) return latlngs;
    const cached = trackSmoothingCache.get(latlngs);
    let entry = null;
    if (cached && cached.gauge === gauge && cached.snapshot.length === latlngs.length * 2) {
        const moved = findMovedVertexRange(cached.snapshot, latlngs);
        if (moved.count === 0) entry = cached;
        else if (moved.count <= SMOOTHING_INCREMENTAL_MAX_MOVED_VERTICES
            && patchTrackSmoothingCacheEntry(latlngs, gauge, cached, moved)) entry = cached;
    }
    if (!entry) entry = buildTrackSmoothingCacheEntry(latlngs, gauge);
    // A fresh array per call: the cached one keeps being patched in place.
    return entry.points.slice();
}

function buildLineMotionProfile(latlngs, gauge = 'g1000') {
    const segments = [];
    let totalLengthMeters = 0;
    latlngs = resampleLatLngsSmooth(latlngs, gauge);

    for (let i = 0; i < latlngs.length - 1; i++) {
        const start = L.latLng(latlngs[i][0], latlngs[i][1]);
        const end = L.latLng(latlngs[i + 1][0], latlngs[i + 1][1]);
        const lengthMeters = start.distanceTo(end);
        if (lengthMeters <= 0) continue;

        segments.push({
            start,
            end,
            startOffsetMeters: totalLengthMeters,
            endOffsetMeters: totalLengthMeters + lengthMeters,
            lengthMeters,
        });
        totalLengthMeters += lengthMeters;
    }

    return { segments, totalLengthMeters };
}

function areLatLngsNearlyEqual(a, b) {
    if (!a || !b) return false;
    return Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lng - b.lng) < 1e-9;
}

function profileToVertexOffsets(profile) {
    if (!profile || !Array.isArray(profile.segments) || profile.segments.length === 0) return [];
    const vertices = [];
    for (const segment of profile.segments) {
        if (!vertices.length || !areLatLngsNearlyEqual(vertices[vertices.length - 1].latlng, segment.start)) {
            vertices.push({
                latlng: segment.start,
                offsetMeters: segment.startOffsetMeters,
            });
        }
        if (!vertices.length || !areLatLngsNearlyEqual(vertices[vertices.length - 1].latlng, segment.end)) {
            vertices.push({
                latlng: segment.end,
                offsetMeters: segment.endOffsetMeters,
            });
        }
    }
    return vertices;
}

function latLngToLocalMeters(latlng, origin) {
    const cosLat = Math.cos(((latlng.lat + origin.lat) * 0.5) * DEG_TO_RAD);
    return {
        x: (latlng.lng - origin.lng) * DEG_TO_RAD * EARTH_RADIUS_M * cosLat,
        y: (latlng.lat - origin.lat) * DEG_TO_RAD * EARTH_RADIUS_M,
    };
}

function localMetersToLatLng(point, origin) {
    const lat = origin.lat + (point.y / EARTH_RADIUS_M) / DEG_TO_RAD;
    const cosLat = Math.max(1e-6, Math.cos(((lat + origin.lat) * 0.5) * DEG_TO_RAD));
    const lng = origin.lng + (point.x / (EARTH_RADIUS_M * cosLat)) / DEG_TO_RAD;
    return L.latLng(lat, lng);
}

function extrapolateControlPoint(current, neighbor) {
    return {
        x: current.x + (current.x - neighbor.x),
        y: current.y + (current.y - neighbor.y),
        offsetMeters: current.offsetMeters + (current.offsetMeters - neighbor.offsetMeters),
    };
}

function distanceBetweenLocalPoints(a, b) {
    return Math.hypot((b.x || 0) - (a.x || 0), (b.y || 0) - (a.y || 0));
}

function interpolatePointBetweenTimes(a, b, ta, tb, t) {
    const denom = tb - ta;
    if (!Number.isFinite(denom) || Math.abs(denom) < 1e-6) return { x: b.x, y: b.y };
    const weightA = (tb - t) / denom;
    const weightB = (t - ta) / denom;
    return {
        x: a.x * weightA + b.x * weightB,
        y: a.y * weightA + b.y * weightB,
    };
}

function interpolateCentripetalCatmullRomPoint(p0, p1, p2, p3, t) {
    const alpha = 0.5;
    const sampleT = Math.max(0, Math.min(1, t));
    let t0 = 0;
    let t1 = t0 + Math.pow(Math.max(distanceBetweenLocalPoints(p0, p1), 1e-6), alpha);
    let t2 = t1 + Math.pow(Math.max(distanceBetweenLocalPoints(p1, p2), 1e-6), alpha);
    let t3 = t2 + Math.pow(Math.max(distanceBetweenLocalPoints(p2, p3), 1e-6), alpha);
    if (t1 <= t0 + 1e-6) t1 = t0 + 1;
    if (t2 <= t1 + 1e-6) t2 = t1 + 1;
    if (t3 <= t2 + 1e-6) t3 = t2 + 1;
    const tt = t1 + (t2 - t1) * sampleT;
    const a1 = interpolatePointBetweenTimes(p0, p1, t0, t1, tt);
    const a2 = interpolatePointBetweenTimes(p1, p2, t1, t2, tt);
    const a3 = interpolatePointBetweenTimes(p2, p3, t2, t3, tt);
    const b1 = interpolatePointBetweenTimes(a1, a2, t0, t2, tt);
    const b2 = interpolatePointBetweenTimes(a2, a3, t1, t3, tt);
    return interpolatePointBetweenTimes(b1, b2, t1, t2, tt);
}

function interpolateUndergroundSample(a, b, offsetMeters) {
    if (!a && !b) return null;
    if (!b) return { ...a };
    if (!a) return { ...b };
    const range = Math.max(1e-6, b.offsetMeters - a.offsetMeters);
    const ratio = Math.max(0, Math.min(1, (offsetMeters - a.offsetMeters) / range));
    return {
        offsetMeters,
        x: a.x + (b.x - a.x) * ratio,
        y: a.y + (b.y - a.y) * ratio,
        latlng: L.latLng(
            a.latlng.lat + (b.latlng.lat - a.latlng.lat) * ratio,
            a.latlng.lng + (b.latlng.lng - a.latlng.lng) * ratio,
        ),
    };
}

function buildUndergroundCurveZones(verticesLocal) {
    const zones = [];
    for (let i = 1; i < verticesLocal.length - 1; i++) {
        const previous = verticesLocal[i - 1];
        const current = verticesLocal[i];
        const next = verticesLocal[i + 1];
        const prevDx = current.x - previous.x;
        const prevDy = current.y - previous.y;
        const nextDx = next.x - current.x;
        const nextDy = next.y - current.y;
        const prevLen = Math.hypot(prevDx, prevDy);
        const nextLen = Math.hypot(nextDx, nextDy);
        if (prevLen < 1 || nextLen < 1) continue;
        const dot = (prevDx * nextDx + prevDy * nextDy) / (prevLen * nextLen);
        const turnDeg = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
        if (!Number.isFinite(turnDeg) || turnDeg < UNDERGROUND_CURVE_MIN_TURN_DEG) continue;
        const radiusMeters = Math.max(
            6,
            Math.min(
                UNDERGROUND_CURVE_SPEED_ZONE_MAX_METERS,
                UNDERGROUND_CURVE_SPEED_ZONE_BASE_METERS + turnDeg * UNDERGROUND_CURVE_SPEED_ZONE_SCALE_METERS,
                prevLen * 0.5,
                nextLen * 0.5,
            ),
        );
        zones.push({
            offsetMeters: current.offsetMeters,
            radiusMeters,
            minSpeedFactor: Math.max(UNDERGROUND_CURVE_SPEED_MIN_FACTOR, 1 - (turnDeg / 110)),
        });
    }
    return zones;
}

// Metro-style running (smoothed cab curves, station entry buffers, realtime cab
// motion) applies to standard-gauge (1435 mm) lines — the metro of this planner.
function isMetroStyleLine(line) {
    return normalizeGauge(line?.gauge) === 'g1435';
}

function buildUndergroundCabProfile(line) {
    if (!isMetroStyleLine(line)) return null;
    const sourceProfile = getLineMotionProfile(line);
    if (!sourceProfile || !Array.isArray(sourceProfile.segments) || sourceProfile.segments.length === 0) return null;
    if (line._undergroundCabProfile && line._undergroundCabProfile.sourceProfile === sourceProfile) {
        return line._undergroundCabProfile;
    }

    const vertices = profileToVertexOffsets(sourceProfile);
    if (vertices.length < 2) return null;

    const origin = vertices[0].latlng;
    const verticesLocal = vertices.map((vertex) => {
        const local = latLngToLocalMeters(vertex.latlng, origin);
        return {
            x: local.x,
            y: local.y,
            latlng: vertex.latlng,
            offsetMeters: vertex.offsetMeters,
        };
    });
    const samples = [];
    const pushSample = (latlng, local, offsetMeters) => {
        if (!latlng || !Number.isFinite(offsetMeters)) return;
        const last = samples[samples.length - 1];
        if (last) {
            if (Math.abs(last.offsetMeters - offsetMeters) < 1e-6) return;
            if (last.latlng.distanceTo(latlng) < 0.05) return;
        }
        samples.push({ latlng, x: local.x, y: local.y, offsetMeters });
    };

    if (verticesLocal.length < 3) {
        for (const vertex of verticesLocal) pushSample(vertex.latlng, vertex, vertex.offsetMeters);
    } else {
        for (let i = 0; i < verticesLocal.length - 1; i++) {
            const p1 = verticesLocal[i];
            const p2 = verticesLocal[i + 1];
            const segmentLengthMeters = Math.max(0, p2.offsetMeters - p1.offsetMeters);
            if (segmentLengthMeters <= 0.01) continue;
            const p0 = i > 0 ? verticesLocal[i - 1] : extrapolateControlPoint(p1, p2);
            const p3 = i + 2 < verticesLocal.length ? verticesLocal[i + 2] : extrapolateControlPoint(p2, p1);
            const sampleCount = Math.max(4, Math.ceil(segmentLengthMeters / UNDERGROUND_CURVE_SAMPLE_SPACING_METERS));
            const segmentSamples = [];
            let smoothedLengthMeters = 0;
            for (let step = 0; step <= sampleCount; step++) {
                const t = step / sampleCount;
                const local = interpolateCentripetalCatmullRomPoint(p0, p1, p2, p3, t);
                const previous = segmentSamples[segmentSamples.length - 1];
                if (previous) smoothedLengthMeters += distanceBetweenLocalPoints(previous.local, local);
                segmentSamples.push({
                    local,
                    latlng: localMetersToLatLng(local, origin),
                    distanceMeters: smoothedLengthMeters,
                });
            }
            // Catmull-Rom's parameter t is not distance-linear. Assigning
            // route offsets directly from t made the cab slow and surge inside
            // bends even with a constant simulation speed. Reparameterise each
            // source segment by its actual smoothed arc length while preserving
            // the original offsets at vertices (and therefore station stops).
            const safeSmoothedLength = Math.max(1e-6, smoothedLengthMeters);
            for (let step = 0; step < segmentSamples.length - 1; step++) {
                const sample = segmentSamples[step];
                const distanceRatio = sample.distanceMeters / safeSmoothedLength;
                const offsetMeters = p1.offsetMeters + segmentLengthMeters * distanceRatio;
                pushSample(sample.latlng, sample.local, offsetMeters);
            }
        }
        pushSample(
            verticesLocal[verticesLocal.length - 1].latlng,
            verticesLocal[verticesLocal.length - 1],
            sourceProfile.totalLengthMeters,
        );
    }

    const featureCoordinates = [];
    for (const sample of samples) {
        const last = featureCoordinates[featureCoordinates.length - 1];
        if (last && Math.abs(last[0] - sample.latlng.lng) < 1e-9 && Math.abs(last[1] - sample.latlng.lat) < 1e-9) continue;
        featureCoordinates.push([sample.latlng.lng, sample.latlng.lat]);
    }

    const result = {
        sourceProfile,
        samples,
        featureCoordinates,
        curveZones: buildUndergroundCurveZones(verticesLocal),
    };
    line._undergroundCabProfile = result;
    return result;
}

function getUndergroundCurveSpeedFactor(line, distanceMeters) {
    const undergroundCabProfile = buildUndergroundCabProfile(line);
    if (!undergroundCabProfile || !Array.isArray(undergroundCabProfile.curveZones)) return 1;
    let factor = 1;
    for (const zone of undergroundCabProfile.curveZones) {
        const deltaMeters = Math.abs(distanceMeters - zone.offsetMeters);
        if (deltaMeters >= zone.radiusMeters) continue;
        const blend = deltaMeters / zone.radiusMeters;
        const zoneFactor = zone.minSpeedFactor + (1 - zone.minSpeedFactor) * blend;
        factor = Math.min(factor, zoneFactor);
    }
    return factor;
}

function getUndergroundCabPosition(undergroundCabProfile, distanceMeters, direction) {
    if (!undergroundCabProfile || !Array.isArray(undergroundCabProfile.samples) || undergroundCabProfile.samples.length === 0) {
        return null;
    }
    const samples = undergroundCabProfile.samples;
    const clampedDistance = Math.max(0, Math.min(
        undergroundCabProfile.sourceProfile?.totalLengthMeters || samples[samples.length - 1].offsetMeters || 0,
        distanceMeters,
    ));

    let hi = samples.findIndex(sample => sample.offsetMeters >= clampedDistance);
    if (hi === -1) hi = samples.length - 1;
    let low = Math.max(0, hi - 1);
    if (hi === 0 && samples.length > 1) hi = 1;
    low = Math.max(0, hi - 1);
    const a = samples[low];
    const b = samples[hi] || a;
    const currentSample = interpolateUndergroundSample(a, b, clampedDistance);
    if (!currentSample) return null;
    const backwardSample = interpolateUndergroundSample(
        samples[Math.max(0, low - 1)] || a,
        a,
        Math.max(0, clampedDistance - UNDERGROUND_CURVE_HEADING_LOOKAHEAD_METERS),
    ) || currentSample;
    const forwardSample = interpolateUndergroundSample(
        b,
        samples[Math.min(samples.length - 1, hi + 1)] || b,
        Math.min(
            undergroundCabProfile.sourceProfile?.totalLengthMeters || clampedDistance,
            clampedDistance + UNDERGROUND_CURVE_HEADING_LOOKAHEAD_METERS,
        ),
    ) || currentSample;
    const headingStart = direction >= 0 ? backwardSample : forwardSample;
    const headingEnd = direction >= 0 ? forwardSample : backwardSample;
    const dx = headingEnd.x - headingStart.x;
    const dy = headingEnd.y - headingStart.y;
    const angleDeg = Math.atan2(-dy, dx) * 180 / Math.PI;

    return {
        latlng: currentSample.latlng,
        angleDeg,
        distanceMeters: clampedDistance,
    };
}

function getOffsetOnLine(latlng, profile) {
    if (!profile || profile.segments.length === 0) return null;

    let best = null;
    for (const segment of profile.segments) {
        const projected = nearestPointOnSegment(
            latlng.lng,
            latlng.lat,
            segment.start.lng,
            segment.start.lat,
            segment.end.lng,
            segment.end.lat
        );
        if (!best || projected.distSq < best.distSq) {
            const projectedLatLng = L.latLng(projected.lat, projected.lon);
            best = {
                distSq: projected.distSq,
                offsetMeters: segment.startOffsetMeters + segment.start.distanceTo(projectedLatLng),
            };
        }
    }

    return best ? Math.max(0, Math.min(profile.totalLengthMeters, best.offsetMeters)) : null;
}

function createTrainIcon(line) {
    return L.divIcon({
        className: `train-marker train-marker-${normalizeGauge(line.gauge)}`,
        html: `<div class="train-marker-shell" style="--train-color:${line.color || getLineColor(line.number || line.id)}">
            <div class="train-marker-icon"></div>
            <div class="train-stop-indicator" aria-hidden="true"></div>
        </div>`,
        // Keep the painted tram small, but give a moving target a forgiving
        // pointer area so the route's wide edit hit-stroke cannot win nearby.
        iconSize: [44, 44],
        iconAnchor: [22, 22],
    });
}

// Leaflet's stock Marker rounds its layer point to whole pixels. At citywide
// zoom levels a planner train can move for several frames before crossing the
// next pixel, then visibly jump. Preserve the floating-point projected point
// for animated trains while retaining normal Marker behavior and events.
const SmoothTrainMarker = L.Marker.extend({
    _update() {
        if (!this._icon || !this._map) return;
        const position = this._map
            .project(this._latlng, this._map.getZoom())
            .subtract(this._map.getPixelOrigin());
        this._setPos(position);
    },
});

function formatTrainCountdown(seconds) {
    return String(Math.max(1, Math.ceil(seconds)));
}

// The 18 m tram is a rigid body, so its yaw should follow the chord beneath
// the whole vehicle rather than whichever short resampled spline segment its
// centre happens to occupy. The latter made a nearly straight hand-drawn
// route look like a rapid left/right weave as the centre crossed each chord.
const TRAIN_HEADING_HALF_SPAN_METERS = 9;

function sampleMotionProfileLatLng(profile, distanceMeters) {
    const clampedDistance = Math.max(0, Math.min(profile.totalLengthMeters, distanceMeters));
    let low = 0;
    let high = profile.segments.length - 1;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (clampedDistance <= profile.segments[mid].endOffsetMeters) high = mid;
        else low = mid + 1;
    }
    const segment = profile.segments[low];
    const distanceIntoSegment = clampedDistance - segment.startOffsetMeters;
    const ratio = segment.lengthMeters > 0
        ? Math.max(0, Math.min(1, distanceIntoSegment / segment.lengthMeters))
        : 0;
    return {
        latlng: L.latLng(
            segment.start.lat + (segment.end.lat - segment.start.lat) * ratio,
            segment.start.lng + (segment.end.lng - segment.start.lng) * ratio,
        ),
        distanceMeters: clampedDistance,
    };
}

function getTrainPosition(profile, distanceMeters, direction) {
    if (!profile || profile.segments.length === 0) return null;

    const current = sampleMotionProfileLatLng(profile, distanceMeters);
    const before = sampleMotionProfileLatLng(
        profile,
        current.distanceMeters - TRAIN_HEADING_HALF_SPAN_METERS,
    );
    const after = sampleMotionProfileLatLng(
        profile,
        current.distanceMeters + TRAIN_HEADING_HALF_SPAN_METERS,
    );
    const headingStart = direction >= 0 ? before.latlng : after.latlng;
    const headingEnd = direction >= 0 ? after.latlng : before.latlng;
    // Do not derive heading from Leaflet layer pixels: they are integer-
    // rounded, and this 18 m chord is only ~1–2 px at normal map zoom. Use
    // continuous local metres so both the map icon and 3D tram receive a
    // stable tangent independent of map zoom.
    const headingDelta = latLngToLocalMeters(headingEnd, headingStart);
    const angleDeg = Math.atan2(-headingDelta.y, headingDelta.x) * 180 / Math.PI;

    return {
        latlng: current.latlng,
        angleDeg,
        distanceMeters: current.distanceMeters,
    };
}

// Returns a closure the cab-view module can poll each frame to get the train's
// current world pose plus a snapshot of its status (paused/at-station, current
// passenger load, last stop's exchange counts). Translates Leaflet's screen-
// space angle into a compass heading (0=N, 90=E).
// ─── Track elevation (feeds the 3D cab/walk scenes) ─────────────────────────
// Continuous elevation in meters on one specific planner track. Keeping this
// track-scoped is important where two proposals overlap at different levels:
// their viaducts, vehicles, and stations must never borrow each other's height.
// DGU terrain a.s.l. at a chainage, interpolated from the track's cached
// terrain profile (used to express the model grade as height above terrain).
function terrainAslAtChainage(track, dM) {
    const tp = track._terrainProfile;
    if (!tp || tp.geomHash !== currentTrackGeomHash(track)) return null;
    const pts = tp.points;
    if (!pts || pts.length === 0) return null;
    if (dM <= pts[0].dM) return pts[0].elevAslM;
    if (dM >= pts[pts.length - 1].dM) return pts[pts.length - 1].elevAslM;
    for (let i = 1; i < pts.length; i++) {
        if (pts[i].dM >= dM) {
            const a = pts[i - 1], b = pts[i];
            if (a.elevAslM == null || b.elevAslM == null) return a.elevAslM ?? b.elevAslM;
            const t = (dM - a.dM) / Math.max(1e-9, b.dM - a.dM);
            return a.elevAslM + (b.elevAslM - a.elevAslM) * t;
        }
    }
    return pts[pts.length - 1].elevAslM;
}

function getTrackElevationAt(track, lat, lng, options = {}) {
    if (!track) return null;
    const point = nearestPointOnTrack(track, lat, lng, options);
    if (!point) return null;
    // The auto-graded verticalProfile is the elevation authority for BOTH sims.
    // Photo/asl expresses its immutable absolute grade against one session
    // datum. Generic relative-height consumers use the same grade above DGU
    // terrain; the model cab's rail builder consumes absolute EVRF2000 through
    // getTrackAbsoluteAslAt(). Only an unavailable profile/terrain falls back
    // to the coarse levels.
    if (trackHasFreshAslProfile(track)) {
        const chainages = trackVertexChainages(track);
        const segStart = chainages[point.segmentIndex];
        const segEnd = chainages[point.segmentIndex + 1] ?? segStart;
        const dM = segStart + (segEnd - segStart) * point.t;
        const asl = window.__verticalProfile.elevAtChainage(track.verticalProfile, dM);
        if (Number.isFinite(asl) && plannerCabAslActive) {
            return { distSq: point.distSq, segmentIndex: point.segmentIndex, elevM: asl - plannerCabAslDatumM };
        }
        // Non-asl worlds fall through to DERIVED levels ×10. Terrain-on model
        // rides get true absolute heights via model-grade/getTrackAbsoluteAslAt;
        // flat worlds must speak levels so tunnels, surface cutouts and the
        // underground station structures engage exactly as they did for manual
        // levels. (The former asl − terrainAsl branch buried flat-world tracks
        // below the ground plane with no tunnel to make them visible.)
    }
    return {
        distSq: point.distSq,
        segmentIndex: point.segmentIndex,
        elevM: getContinuousTrackLevel(track, point.segmentIndex, point.t) * LEVEL_HEIGHT_METERS,
    };
}

// Continuous elevation in meters at a point: nearest track segment across the
// whole project, with endpoint levels lerped only across the localized ramp.
function getProjectElevationAt(lat, lng) {
    let best = null;
    for (const track of project.tracks) {
        const candidate = getTrackElevationAt(track, lat, lng);
        if (!candidate || (best && candidate.distSq >= best.distSq)) continue;
        best = candidate;
    }
    return best ? best.elevM : 0;
}

function getTracksUsedByLine(line) {
    const trackIds = new Set();
    if (line?.trackId != null) trackIds.add(line.trackId);
    for (const stationId of line?.stationIds || []) {
        const station = _stationById.get(stationId);
        if (station?.trackId != null) trackIds.add(station.trackId);
    }
    for (const station of project.stations) {
        if (station.lineId === line?.id && station.trackId != null) trackIds.add(station.trackId);
    }
    return project.tracks.filter(track => trackIds.has(track.id));
}

function getLineTrackElevationAt(line, lat, lng) {
    return sampleLineTrackElevation(line, getTracksUsedByLine(line), lat, lng, null).elevM;
}

// cursors: an optional Map of track -> the segment index the previous sample
// landed on. A caller stepping along the line passes the same map every time so
// each search stays local; anyone else passes null and pays for a full scan.
function sampleLineTrackElevation(line, lineTracks, lat, lng, cursors) {
    let best = null;
    for (const track of lineTracks) {
        const hint = cursors?.has(track) ? { nearSegmentIndex: cursors.get(track) } : {};
        const absolute = plannerCabModelGradeActive
            ? getTrackAbsoluteAslAt(track, lat, lng, hint)
            : null;
        const candidate = absolute
            ? { ...absolute, elevM: absolute.aslM }
            : getTrackElevationAt(track, lat, lng, hint);
        if (!candidate) continue;
        if (cursors && Number.isInteger(candidate.segmentIndex)) cursors.set(track, candidate.segmentIndex);
        if (best && candidate.distSq >= best.distSq) continue;
        best = candidate;
    }
    return { elevM: best ? best.elevM : getProjectElevationAt(lat, lng) };
}

// ABSOLUTE a.s.l. (EVRF2000) of the authored grade at a point — the model world's
// rail formation seats these directly (absoluteSceneYAtHeight), so the rail
// geometry follows the grade instead of re-draping the terrain.
function getTrackAbsoluteAslAt(track, lat, lng, options = {}) {
    if (!track || !trackHasFreshAslProfile(track)) return null;
    const point = nearestPointOnTrack(track, lat, lng, options);
    if (!point) return null;
    const chainages = trackVertexChainages(track);
    const segStart = chainages[point.segmentIndex];
    const segEnd = chainages[point.segmentIndex + 1] ?? segStart;
    const asl = window.__verticalProfile.elevAtChainage(
        track.verticalProfile, segStart + (segEnd - segStart) * point.t);
    return Number.isFinite(asl)
        ? { distSq: point.distSq, segmentIndex: point.segmentIndex, aslM: asl }
        : null;
}

function getLineTrackAbsoluteAslAt(line, lat, lng) {
    let best = null;
    for (const track of getTracksUsedByLine(line)) {
        const candidate = getTrackAbsoluteAslAt(track, lat, lng);
        if (!candidate || (best && candidate.distSq >= best.distSq)) continue;
        best = candidate;
    }
    return best ? best.aslM : null;
}

// Authored track relationship to DGU ground at one registration point:
// authored_asl − DGU_terrain. Photo mode uses this ONE scalar to seat Google's
// world while leaving the complete authored vertical alignment unchanged.
// It is deliberately not emitted point-by-point: doing that and adding Google
// terrain would bend the designed grade around every Google terrain residual.
function getTrackDesignGroundOffsetAt(track, lat, lng) {
    if (!track || !trackHasFreshAslProfile(track)) return null;
    const point = nearestPointOnTrack(track, lat, lng);
    if (!point) return null;
    const chainages = trackVertexChainages(track);
    const segStart = chainages[point.segmentIndex];
    const segEnd = chainages[point.segmentIndex + 1] ?? segStart;
    const dM = segStart + (segEnd - segStart) * point.t;
    const asl = window.__verticalProfile.elevAtChainage(track.verticalProfile, dM);
    const terrainAsl = terrainAslAtChainage(track, dM);
    if (!Number.isFinite(asl) || !Number.isFinite(terrainAsl)) return null;
    return { distSq: point.distSq, groundOffsetM: asl - terrainAsl };
}

function getLineDesignGroundOffsetAt(line, lat, lng, trackId = null) {
    let best = null;
    for (const track of getTracksUsedByLine(line)) {
        if (trackId != null && String(track.id) !== String(trackId)) continue;
        const candidate = getTrackDesignGroundOffsetAt(track, lat, lng);
        if (!candidate) continue;
        const point = nearestPointOnTrack(track, lat, lng);
        const distanceM = pointDistanceMeters(point, lat, lng);
        if (best && distanceM >= best.distanceM) continue;
        best = { ...candidate, distanceM };
    }
    return best ? best.groundOffsetM : null;
}

function pointDistanceMeters(point, lat, lng) {
    if (!point) return Infinity;
    const dLatM = (point.lat - lat) * 111320;
    const dLngM = (point.lon - lng) * 111320 * Math.cos(lat * DEG_TO_RAD);
    return Math.hypot(dLatM, dLngM);
}

function findNearestProjectAuthoredTrackAt(lat, lng) {
    let best = null;
    for (const track of project.tracks || []) {
        const candidate = getTrackAbsoluteAslAt(track, lat, lng);
        if (!candidate) continue;
        const point = nearestPointOnTrack(track, lat, lng);
        const distanceM = pointDistanceMeters(point, lat, lng);
        if (best && distanceM >= best.distanceM) continue;
        best = {
            ...candidate,
            track,
            distanceM,
        };
    }
    return best;
}

function getProjectDesignGroundOffsetAt(lat, lng, trackId = null) {
    let best = null;
    for (const track of project.tracks || []) {
        if (trackId != null && String(track.id) !== String(trackId)) continue;
        const candidate = getTrackDesignGroundOffsetAt(track, lat, lng);
        if (!candidate) continue;
        const distanceM = pointDistanceMeters(nearestPointOnTrack(track, lat, lng), lat, lng);
        if (best && distanceM >= best.distanceM) continue;
        best = { ...candidate, distanceM };
    }
    return best ? best.groundOffsetM : null;
}

function roundElevationMeters(elevM) {
    return Math.round(elevM * 100) / 100;
}

// Elevation sampled at every vertex of the line's motion profile, keyed by
// cumulative offset — lets the pose function look up height/slope by the
// train's distanceMeters. Cached per line, invalidated with the profile.
function getLineElevationProfile(line) {
    const sourceProfile = getLineMotionProfile(line);
    if (!sourceProfile || !Array.isArray(sourceProfile.segments) || sourceProfile.segments.length === 0) return null;
    // Cache key includes the asl-session state: the same horizontal profile
    // yields entirely different elevations in an asl photoreal ride.
    if (line._elevationProfile
        && line._elevationProfile.sourceProfile === sourceProfile
        && line._elevationProfile.aslActive === plannerCabAslActive
        && line._elevationProfile.modelGradeActive === plannerCabModelGradeActive
        && line._elevationProfile.aslDatumM === plannerCabAslDatumM) {
        return line._elevationProfile;
    }
    // A vertex drag rebuilds the motion profile on every frame, and this cache
    // is keyed on that object's identity — so the table was rebuilt every frame
    // too, which is what made dragging a long route crawl. Nothing reads it
    // during a drag except the train icon's flare width, so the previous table
    // is reused for the length of the gesture and rebuilt once on release.
    if (draggingVertex && line._elevationProfile) return line._elevationProfile;
    const points = [];
    // The table holds one point per motion-profile segment — 14,412 of them on a
    // 400 km reconstruction — and each one used to search the whole 2,959-node
    // track for its nearest point: 42 million segment tests, ~300 ms. Since the
    // points march along the line in order, each search now starts where the
    // last one landed.
    const lineTracks = getTracksUsedByLine(line);
    const cursors = new Map();
    const firstSegment = sourceProfile.segments[0];
    points.push({
        offsetMeters: 0,
        elevM: sampleLineTrackElevation(line, lineTracks, firstSegment.start.lat, firstSegment.start.lng, cursors).elevM,
    });
    for (const segment of sourceProfile.segments) {
        points.push({
            offsetMeters: segment.endOffsetMeters,
            elevM: sampleLineTrackElevation(line, lineTracks, segment.end.lat, segment.end.lng, cursors).elevM,
        });
    }
    line._elevationProfile = {
        sourceProfile, points,
        aslActive: plannerCabAslActive,
        modelGradeActive: plannerCabModelGradeActive,
        aslDatumM: plannerCabAslDatumM,
    };
    return line._elevationProfile;
}

// Height + slope of the line at a given offset. slopeDeg is relative to
// increasing offset; multiply by travel direction for the cab pitch.
const LINE_ELEVATION_GRADE_CHORD_M = 60;

function getLineElevationAt(line, distanceMeters) {
    const elevationProfile = getLineElevationProfile(line);
    if (!elevationProfile) return { elevM: 0, slopeDeg: 0 };
    const points = elevationProfile.points;
    if (distanceMeters <= points[0].offsetMeters) return { elevM: points[0].elevM, slopeDeg: 0 };
    const lastIndex = points.length - 1;
    if (distanceMeters > points[lastIndex].offsetMeters) {
        return { elevM: points[lastIndex].elevM, slopeDeg: 0 };
    }
    // Offsets ascend, so each height lookup below is a bisect, not a walk. The
    // table has one entry per motion-profile segment — 14,412 on a 400 km
    // route — and this runs once per train per animation frame.
    const elevationAt = (distance) => {
        if (distance <= points[0].offsetMeters) return points[0].elevM;
        if (distance >= points[lastIndex].offsetMeters) return points[lastIndex].elevM;
        let a = 1, b = lastIndex;
        while (a < b) {
            const mid = (a + b) >> 1;
            if (distance <= points[mid].offsetMeters) b = mid;
            else a = mid + 1;
        }
        const p = points[a - 1], n = points[a];
        const width = n.offsetMeters - p.offsetMeters;
        const t = width > 0 ? (distance - p.offsetMeters) / width : 0;
        return p.elevM + (n.elevM - p.elevM) * t;
    };
    const elevM = elevationAt(distanceMeters);
    // A train body spans several 20 m terrain/profile samples. Using the one
    // segment directly under the cab made its gaze chase every small DTM
    // residual and change pitch roughly once per second at 70 km/h. Measure a
    // centred rail chord instead, while retaining the exact authored height.
    const halfChordM = LINE_ELEVATION_GRADE_CHORD_M / 2;
    const behindM = Math.max(points[0].offsetMeters, distanceMeters - halfChordM);
    const aheadM = Math.min(points[lastIndex].offsetMeters, distanceMeters + halfChordM);
    const gradeRunM = aheadM - behindM;
    return {
        elevM,
        slopeDeg: gradeRunM > 0
            ? Math.atan2(elevationAt(aheadM) - elevationAt(behindM), gradeRunM) * 180 / Math.PI
            : 0,
    };
}

// This remains useful for metro-specific motion smoothing and driver messaging,
// but it no longer selects a separate 3D world. Every planner line now uses the
// same elevation-aware scene so an all-underground proposal cannot fall back to
// the obsolete side-platform station model.
function isLineFullyUnderground(line) {
    const elevationProfile = getLineElevationProfile(line);
    if (!elevationProfile) return false;
    return elevationProfile.points.every(p => p.elevM < -LEVEL_HEIGHT_METERS * 0.5);
}

// ─── Underground station alignment ──────────────────────────────────────────
// An underground station is a straight, level box: a 60 m platform hall with a
// 55 m throat at each end, and the tracks flare out to ±6.6 m inside it. The
// shell clears the flared trackbed by barely a metre, so the route through the
// whole 170 m envelope has to be straight and stay at station level — a curve
// or a ramp inside it drives the track through the platform and out through the
// station wall. Real metro stations are built on a tangent for exactly this
// reason; the planner holds new builds to that standard instead of bending the
// station around a route that cannot carry one.
const UNDERGROUND_STATION_ENVELOPE_HALF_LENGTH_METERS =
    UNDERGROUND_STATION_CORE_HALF_LENGTH_METERS + UNDERGROUND_STATION_FLARE_LENGTH_METERS;
const UNDERGROUND_STATION_STRAIGHT_TOLERANCE_METERS = 0.5;
const UNDERGROUND_STATION_LEVEL_TOLERANCE_METERS = 0.25;
// resampleLatLngsSmooth only adds points around CURVES, so a straight run
// through the envelope contributes its two vertices and nothing else — one
// sample inside 170 m of platform, which is not a measurement. Walk the
// envelope at a fixed step instead.
const UNDERGROUND_STATION_ENVELOPE_SAMPLE_M = 5;

// The elevation this check must compare is the authored vertical profile in
// metres a.s.l. — the same series the strip draws, the 2D map colours by, and
// both 3D worlds build from.
//
// NOT getTrackElevationAt: that is a display helper whose datum depends on
// whether an asl 3D ride happens to be open. In the plain planner it falls
// through to DERIVED LEVELS × 10 m, and those levels carry fractional ramp
// shaping (shapeDerivedLevelRamps) — so a platform the profile holds dead level
// at 99.10 m was measured as −8.98 m at one end and −6.95 m at the other, and
// reported as "trasa mijenja visinu za 2.0 m" with nothing whatsoever wrong
// with the route. That quantisation artefact is what this function existed to
// rule out, and it was reading it as the fault. (Reported 2026-07-24.)
function getStationCheckElevationM(track, lat, lng) {
    if (trackHasFreshAslProfile(track)) {
        const dM = trackChainageAtLatLng(track, lat, lng);
        const asl = window.__verticalProfile.elevAtChainage(track.verticalProfile, dM);
        if (Number.isFinite(asl)) return asl;
    }
    // No solved profile yet: the coarse levels are all there is. They are a
    // 10 m-quantised stand-in, so anything they can say about a 0.25 m
    // tolerance is noise — report no level error rather than a fabricated one.
    return null;
}

// Measures a candidate underground station against its envelope. Works on the
// smoothed centreline the 3D scene actually renders, not the drawn vertices.
function getUndergroundStationAlignment(track, latlng) {
    const alignment = {
        ok: true,
        driftM: 0,
        levelErrorM: 0,
        envelopeLatLngs: [],
    };
    if (!track?.latlngs || track.latlngs.length < 2 || !Array.isArray(latlng)) return alignment;

    const centreline = resampleLatLngsSmooth(track.latlngs, track.gauge);
    if (!Array.isArray(centreline) || centreline.length < 2) return alignment;

    const anchor = getStationSegmentAnchor({ latlng }, centreline);
    const stationPoint = interpolateSegmentPosition(centreline, anchor.segmentIndex, anchor.t);
    const origin = L.latLng(stationPoint[0], stationPoint[1]);
    const toLocal = point => latLngToLocalMeters(L.latLng(point[0], point[1]), origin);

    // The station box is laid out along the route's heading where the station
    // sits — the same tangent the 3D station group is rotated onto.
    const axisFrom = toLocal(centreline[anchor.segmentIndex]);
    const axisTo = toLocal(centreline[anchor.segmentIndex + 1]);
    const axisLengthM = Math.hypot(axisTo.x - axisFrom.x, axisTo.y - axisFrom.y);
    if (axisLengthM < 1e-6) return alignment;
    const axisX = (axisTo.x - axisFrom.x) / axisLengthM;
    const axisY = (axisTo.y - axisFrom.y) / axisLengthM;

    const stationElevM = getStationCheckElevationM(track, stationPoint[0], stationPoint[1]);
    const measure = (point) => {
        const local = toLocal(point);
        const alongM = local.x * axisX + local.y * axisY;
        if (Math.abs(alongM) > UNDERGROUND_STATION_ENVELOPE_HALF_LENGTH_METERS) return;
        alignment.envelopeLatLngs.push(point);
        alignment.driftM = Math.max(
            alignment.driftM,
            Math.abs(local.y * axisX - local.x * axisY),
        );
        if (stationElevM == null) return;
        const elevM = getStationCheckElevationM(track, point[0], point[1]);
        if (elevM == null) return;
        alignment.levelErrorM = Math.max(alignment.levelErrorM, Math.abs(elevM - stationElevM));
    };
    // Skip whole segments that lie entirely off one end of the envelope, so the
    // fixed-step sampling only runs on the two or three segments that touch it.
    for (let index = 0; index < centreline.length - 1; index++) {
        const fromLocal = toLocal(centreline[index]);
        const toLocalEnd = toLocal(centreline[index + 1]);
        const fromAlongM = fromLocal.x * axisX + fromLocal.y * axisY;
        const toAlongM = toLocalEnd.x * axisX + toLocalEnd.y * axisY;
        const half = UNDERGROUND_STATION_ENVELOPE_HALF_LENGTH_METERS;
        if ((fromAlongM > half && toAlongM > half) || (fromAlongM < -half && toAlongM < -half)) continue;
        const segmentLengthM = distanceMetersLatLng(
            centreline[index][0], centreline[index][1],
            centreline[index + 1][0], centreline[index + 1][1],
        );
        const steps = Math.max(1, Math.ceil(segmentLengthM / UNDERGROUND_STATION_ENVELOPE_SAMPLE_M));
        for (let step = 0; step < steps; step++) {
            measure(interpolateSegmentPosition(centreline, index, step / steps));
        }
    }
    measure(centreline[centreline.length - 1]);
    alignment.ok = alignment.driftM <= UNDERGROUND_STATION_STRAIGHT_TOLERANCE_METERS
        && alignment.levelErrorM <= UNDERGROUND_STATION_LEVEL_TOLERANCE_METERS;
    return alignment;
}

// Underground stations only; a surface or elevated stop has no box to fit.
function getStationUndergroundAlignment(track, station) {
    if (!track || !station || getStationLevel(station) >= 0) return null;
    return getUndergroundStationAlignment(track, station.latlng);
}

function describeUndergroundStationAlignment(alignment) {
    const faults = [];
    if (alignment.driftM > UNDERGROUND_STATION_STRAIGHT_TOLERANCE_METERS) {
        faults.push(`trasa skreće ${alignment.driftM.toFixed(1)} m od osi stanice`);
    }
    if (alignment.levelErrorM > UNDERGROUND_STATION_LEVEL_TOLERANCE_METERS) {
        faults.push(`trasa mijenja visinu za ${alignment.levelErrorM.toFixed(1)} m unutar stanice`);
    }
    return faults.join(' i ');
}

// Whether a station may be PLACED (or moved) here. Deliberately the horizontal
// fault only.
//
// The level fault is not a placement condition, because the station is what
// fixes it: a station's 170 m span is a forced-level constraint the grade
// solver applies, and that span does not exist until the station does. Gating
// on `alignment.ok` therefore refused to place the station that would have
// flattened the route — on any gently-graded tunnel (170 m at 1.2 % is already
// 2 m of "error") placement was simply impossible, and a station dragged along
// its own route was bounced back for a fault the next solve would have erased.
// Curvature is different: no amount of solving straightens the route, so it
// stays a hard gate.
//
// The level fault is still reported after the fact — on the platform bar in the
// elevation strip and in the station's sheet — for the case the solver really
// cannot flatten the span (conflicting manual pins inside it).
function isUndergroundStationPlaceable(alignment) {
    return !alignment
        || alignment.driftM <= UNDERGROUND_STATION_STRAIGHT_TOLERANCE_METERS;
}

// Wording for the gates above: they refuse on curvature, so they must not blame
// the grade. (describeUndergroundStationAlignment still reports both faults —
// that one belongs to the station's sheet, where the level error is real news.)
function describeUndergroundStationDrift(alignment) {
    return `skreće ${alignment.driftM.toFixed(1)} m od osi stanice`;
}

// A station's structure has to FIT on the route it sits on. The profile-span
// builder clamps a span that overruns the end, which silently produced a
// half-length platform: a 170 m tunnel station placed 30 m from the last node
// became a 30 m stub, and on the elevation strip its bar ran into the plot edge
// with one anchor unreachable. Refuse the placement instead, with the number.
//
// `halfSpanM` is passed in because during a placement the station object does
// not exist yet — the caller knows the level it is about to get.
function stationFitsOnTrack(track, dM, halfSpanM) {
    const chainages = trackVertexChainages(track);
    const lengthM = chainages[chainages.length - 1] || 0;
    if (!Number.isFinite(dM) || !(halfSpanM > 0) || lengthM <= 0) return true;
    return dM - halfSpanM >= -1e-6 && dM + halfSpanM <= lengthM + 1e-6;
}

function getStationFitMessage(halfSpanM, typeLabel) {
    return `${typeLabel} je duga ${Math.round(halfSpanM * 2)} m i mora cijela stati na trasu — `
        + `postavite je barem ${Math.round(halfSpanM)} m od kraja trase, ili produžite trasu.`;
}

// Name of the STRUCTURE (distinct from getStationTypeLabel above, which names
// the stop's role — stanica vs remiza).
const STATION_KIND_LABELS = Object.freeze({
    tunnel: 'Podzemna stanica',
    covered: 'Kompaktna natkrivena stanica',
    cut: 'Stanica u otvorenom usjeku',
    elevated: 'Nadzemna stanica na vijaduktu',
    surface: 'Stanica na terenu',
});
function getStationStructureLabel(kind) {
    return STATION_KIND_LABELS[kind] || STATION_KIND_LABELS.surface;
}

function getUndergroundStationAlignmentMessage(alignment) {
    return `Podzemna stanica traži ravnu trasu kroz cijelu stanicu `
        + `(${UNDERGROUND_STATION_ENVELOPE_HALF_LENGTH_METERS * 2} m: peronska dvorana i oba grla): `
        + `trasa skreće ${alignment.driftM.toFixed(1)} m od osi stanice. `
        + 'Izravnajte trasu, pa postavite stanicu.';
}

// Every underground station on this track that the caller has to keep legal.
function getUndergroundStationAlignments(track) {
    return (project.stations || [])
        .filter(station => station.trackId === track?.id && getStationLevel(station) < 0)
        .map(station => ({ station, alignment: getUndergroundStationAlignment(track, station.latlng) }));
}

// Marks the stretch the station box needs and cannot have, then says why.
function showUndergroundStationAlignmentFault(track, alignment, message = null) {
    const envelope = alignment?.envelopeLatLngs || [];
    if (envelope.length >= 2) {
        flashTrackSegments(
            { latlngs: envelope },
            Array.from({ length: envelope.length - 1 }, (_, index) => index),
        );
    } else if (track) {
        flashTrackSegments(track, [0]);
    }
    setStatusMessage(message || getUndergroundStationAlignmentMessage(alignment), true);
}

const UNDERGROUND_FULL_FLARE_DEPTH_METERS = -8;
const UNDERGROUND_NO_FLARE_DEPTH_METERS = -2;

function getUndergroundDepthFlareFactor(elevationMeters) {
    const elevation = Number(elevationMeters);
    if (!Number.isFinite(elevation)) return 0;
    const span = UNDERGROUND_NO_FLARE_DEPTH_METERS - UNDERGROUND_FULL_FLARE_DEPTH_METERS;
    const t = Math.max(0, Math.min(
        1,
        (UNDERGROUND_NO_FLARE_DEPTH_METERS - elevation) / span,
    ));
    return t * t * (3 - 2 * t);
}

// Running tunnels retain the normal compact pair. Only the approach to an
// actual level -1 stop fans the two tracks around its island platform — and the
// curve is the STATION's, asked for here rather than re-derived. The map icon,
// the 3D cab and the static rails therefore cannot drift apart: there is one
// description, in station-3d/core/station-contract.js.
function getLineTrackCenterSpacingAtDistance(line, distanceMeters) {
    const runningSpacingMeters = getTrackCenterSpacingMeters(line?.gauge);
    let spacingMeters = runningSpacingMeters;
    let station = null;
    for (const stop of line?.stationStops || []) {
        const st = _stationById.get(stop.stationId);
        if (!st || getStationLevel(st) !== -1) continue;
        // Described once, and only when an underground stop is actually on this
        // line. No fallback: a missing contract must throw here rather than
        // quietly draw every train at running spacing, which looks like a
        // geometry bug and would send someone hunting through the renderer.
        station = station || window.__stationContract.describeStation(
            window.__stationContract.UNDERGROUND_STATION_TYPE_ID,
            { runningTrackSpacingM: runningSpacingMeters },
        );
        spacingMeters = Math.max(spacingMeters, station.trackSpacingAtM(
            Number(distanceMeters) - Number(stop.offsetMeters),
        ));
    }
    if (spacingMeters === runningSpacingMeters) return runningSpacingMeters;
    // The flare closes with depth as well as distance, so a ramp that surfaces
    // inside the envelope never carries a train at station spacing. This is
    // applied OUTSIDE the station for the same reason it is in the renderer:
    // it exists only because the level requirement is not yet enforced.
    //
    // BUT depth easing only means anything when the elevation is SURFACE-RELATIVE.
    // In the model world getLineElevationAt returns levels×10 (−10 at a tunnel),
    // where −8 m really is 8 m underground and the easing is correct. In a PHOTO
    // ride it returns elevation measured from the boarding DATUM, so a deep
    // station reads ≈0, the easing treats it as "at grade" and collapses the
    // flare — while the photo RAILS skip easing entirely (they pass null), stay
    // flared, and the cab that kept it rode the near-centreline straight through
    // the island platform. Match the rails: in photo the flare is purely a
    // function of distance.
    const depthFactor = plannerCabAslActive
        ? 1
        : getUndergroundDepthFlareFactor(getLineElevationAt(line, Number(distanceMeters) || 0).elevM);
    return runningSpacingMeters + (spacingMeters - runningSpacingMeters) * depthFactor;
}

function getLineTrackCenterOffsetAtDistance(line, distanceMeters) {
    return TRACK_TOPOLOGY_API.rightHandCenterOffsetM(
        TRACK_TOPOLOGY_API.forTracks(getTracksUsedByLine(line)),
        getLineTrackCenterSpacingAtDistance(line, distanceMeters),
    );
}

function plannerCabPoseElevationAt(line, lat, lng, relativeElevationM) {
    if (plannerCabModelGradeActive) {
        const absoluteElevationM = getLineTrackAbsoluteAslAt(line, lat, lng);
        if (!Number.isFinite(absoluteElevationM)) return {};
        return {
            y: roundElevationMeters(absoluteElevationM),
            elevationMode: 'absolute',
            elevationDatum: 'EVRF2000',
        };
    }
    return { y: roundElevationMeters(relativeElevationM) };
}

function makeTrainPoseFn(train, line) {
    const capacity = TRAIN_CAPACITY[normalizeGauge(line.gauge)];
    const stationEntryBufferMeters = isMetroStyleLine(line) ? UNDERGROUND_STATION_ENTRY_BUFFER_METERS : 0;
    const baseSpeedMps = (LINE_SPEED_KMH[normalizeGauge(line.gauge)]) * 1000 / 3600;
    return (opts) => {
        const cabViewPaused = !!(opts && opts.paused);
        const profile = getLineMotionProfile(line);
        if (!profile) return null;
        // Keep the distance-reparameterised horizontal curve for a completely
        // underground metro, but always apply the proposal's real elevation
        // and the same local island-platform track offset used by its meshes.
        const fullyUnderground = isLineFullyUnderground(line);
        const undergroundCabProfile = fullyUnderground && isMetroStyleLine(line) ? buildUndergroundCabProfile(line) : null;
        // The open cab is the SOLE stepper for its train: advance it here, once
        // per render frame, in WALL time. tickTrainAnimations skips _cabRidden
        // trains, so there is no second requestAnimationFrame racing this one —
        // the position (and thus the camera and engine whine) advances smoothly.
        // Realtime, so the cruise speed carries no curve-speed factor.
        if (train._cabRidden) {
            const nowMs = performance.now();
            const dt = train._cabStepMs != null ? Math.min(0.1, (nowMs - train._cabStepMs) / 1000) : 0;
            train._cabStepMs = nowMs;   // keep the wall clock current even when paused
            // Frozen while the P-key pause is held, so the ride does not keep
            // advancing in the background and lurch forward (catching up) on
            // release — that was the 33000 km/h spike + engine-whine blow-up.
            if (dt > 0 && !cabViewPaused) stepPlannerTrain(train, line, profile, baseSpeedMps, dt);
        }
        const pos = undergroundCabProfile
            ? getUndergroundCabPosition(undergroundCabProfile, train.distanceMeters, train.direction)
            : getTrainPosition(profile, train.distanceMeters, train.direction);
        if (!pos) return null;
        const headingDeg = (pos.angleDeg + 90 + 360) % 360;
        const elevation = getLineElevationAt(line, train.distanceMeters);
        const paused = (train.pauseRemainingSeconds || 0) > 0.01;
        let stationName = null;
        if (paused && train.pausedStationId != null) {
            const station = _stationById.get(train.pausedStationId);
            if (station) stationName = getStationDisplayName(station);
        } else if (paused && train.atTerminus) {
            stationName = 'Kraj linije — okretanje';
        }
        // Find the next station ahead of the train along its current direction.
        let nextStation = null;
        const stops = line.stationStops || [];
        if (stops.length > 0) {
            let upcoming = null;
            if (train.direction >= 0) {
                for (let si = 0; si < stops.length; si++) {
                    if (stops[si].offsetMeters > train.distanceMeters + 0.5) { upcoming = stops[si]; break; }
                }
            } else {
                for (let si = stops.length - 1; si >= 0; si--) {
                    if (stops[si].offsetMeters < train.distanceMeters - 0.5) { upcoming = stops[si]; break; }
                }
            }
            if (upcoming) {
                const station = _stationById.get(upcoming.stationId);
                nextStation = {
                    name: station ? getStationDisplayName(station) : '',
                    distanceMeters: Math.max(0, Math.abs(upcoming.offsetMeters - train.distanceMeters) - stationEntryBufferMeters),
                };
            }
        }
        const runningPosition = offsetLatLngRightOfTravel(
            pos.latlng.lat,
            pos.latlng.lng,
            headingDeg,
            getLineTrackCenterOffsetAtDistance(line, train.distanceMeters),
        );
        const articulatedCars = [1, 0, -1].map((carOffset) => {
            const carDistance = Math.max(
                0,
                Math.min(
                    profile.totalLengthMeters,
                    train.distanceMeters + carOffset * train.direction * 23.735,
                ),
            );
            const carPos = undergroundCabProfile
                ? getUndergroundCabPosition(undergroundCabProfile, carDistance, train.direction)
                : getTrainPosition(profile, carDistance, train.direction);
            if (!carPos) return null;
            const carHeadingDeg = (carPos.angleDeg + 90 + 360) % 360;
            const carRunningPosition = offsetLatLngRightOfTravel(
                carPos.latlng.lat,
                carPos.latlng.lng,
                carHeadingDeg,
                getLineTrackCenterOffsetAtDistance(line, carDistance),
            );
            const carElevation = getLineElevationAt(line, carDistance);
            return {
                lat: carRunningPosition.lat,
                lon: carRunningPosition.lon,
                headingDeg: carHeadingDeg,
                ...plannerCabPoseElevationAt(
                    line,
                    carPos.latlng.lat,
                    carPos.latlng.lng,
                    carElevation.elevM,
                ),
            };
        }).filter(Boolean);
        const pose = {
            lat: runningPosition.lat,
            lon: runningPosition.lon,
            headingDeg,
            articulatedCars,
            status: {
                paused,
                // This is the train simulation's dwell state itself, not a HUD
                // timer. The 3D cab rounds it only for display and uses the raw
                // value to close automatic doors before actual departure.
                dwellRemainingS: paused
                    ? Math.max(0, Number(train.pauseRemainingSeconds) || 0)
                    : null,
                departureAutomatic: paused,
                speedKmh: Math.round(Math.max(0, Number(train.currentSpeedMps) || 0) * 3.6),
                stationName,
                nextStation,
                totalPassengers: train.totalPassengers || 0,
                capacity,
                balanceEur: train.totalRevenue || 0,
                lastAlighted: train.lastStopAlighted || 0,
                lastBoarded: train.lastStopBoarded || 0,
            },
        };
        // Keep the authored absolute grade in the pose while the streamed civil
        // formation catches up. Cab placement still gives a published formation
        // first priority, but a temporary miss now holds the same EVRF2000 profile
        // as the visible rail instead of dropping the train onto raw terrain.
        Object.assign(pose, plannerCabPoseElevationAt(
            line,
            pos.latlng.lat,
            pos.latlng.lng,
            elevation.elevM,
        ));
        pose.pitchDeg = elevation.slopeDeg * (train.direction >= 0 ? 1 : -1);
        // Planner rides carry no railFormation, so the cab HUD's chainage/grade
        // readout would be stuck at "km 0+000 · 0.0%". Feed it the train's real
        // position along the line and the grade along the direction of travel.
        pose.status.chainageM = train.distanceMeters;
        pose.status.gradePercent = Math.tan(pose.pitchDeg * Math.PI / 180) * 100;
        return pose;
    };
}

// Returns a function the cab view polls each frame to get all other trains'
// current world positions, for rendering as 3D tram models in the scene.
// Excludes myTrain itself. Each entry: {id, lat, lon, headingDeg, color}.
function makeOtherTrainsFn(myTrain) {
    return () => {
        const result = [];
        for (const line of project.lines) {
            if (!line.trains) continue;
            const profile = getLineMotionProfile(line);
            if (!profile) continue;
            const color = line.color || getLineColor(line.number || line.id);
            for (const train of line.trains) {
                if (train === myTrain) continue;
                const undergroundCabProfile = isLineFullyUnderground(line) && isMetroStyleLine(line)
                    ? buildUndergroundCabProfile(line)
                    : null;
                const pos = undergroundCabProfile
                    ? getUndergroundCabPosition(undergroundCabProfile, train.distanceMeters, train.direction)
                    : getTrainPosition(profile, train.distanceMeters, train.direction);
                if (!pos) continue;
                const headingDeg = (pos.angleDeg + 90 + 360) % 360;
                const elevation = getLineElevationAt(line, train.distanceMeters);
                const runningPosition = offsetLatLngRightOfTravel(
                    pos.latlng.lat,
                    pos.latlng.lng,
                    headingDeg,
                    getLineTrackCenterOffsetAtDistance(line, train.distanceMeters),
                );
                result.push({
                    id: train.id,
                    lat: runningPosition.lat,
                    lon: runningPosition.lon,
                    y: roundElevationMeters(elevation.elevM),
                    headingDeg,
                    color,
                    lineNumber: String(line.number || line.id),
                    trackType: normalizeGauge(line.gauge),
                });
            }
        }
        return result;
    };
}

function createStationDistanceMarker(latlng, distanceText, color, { isPreview = false } = {}) {
    return L.marker(latlng, {
        icon: L.divIcon({
            className: 'station-distance-label-icon',
            iconSize: [0, 0],
            iconAnchor: [0, 0],
            html: `<div class="station-distance-label${isPreview ? ' is-preview' : ''}" style="--distance-color:${color}" data-distance-label="${escapeHtml(distanceText)}" data-preview-pair="${isPreview ? 'true' : 'false'}">${escapeHtml(distanceText)}</div>`,
        }),
        interactive: false,
        keyboard: false,
        zIndexOffset: isPreview ? 820 : 760,
    });
}

function shouldShowCommittedStationDistances() {
    return Boolean(toggleStationDistancesInput?.checked);
}

function clearLineStationDistanceLabels(line) {
    if (!line?.stationDistanceLayer) return;
    map.removeLayer(line.stationDistanceLayer);
    line.stationDistanceLayer = null;
}

function buildLineStationStops(line, { previewLatLng = null } = {}) {
    const profile = getLineMotionProfile(line);
    if (!profile) return [];

    const stationStops = [];
    for (const station of getLineServiceStations(line)) {
        const offsetMeters = getOffsetOnLine(L.latLng(station.latlng[0], station.latlng[1]), profile);
        if (offsetMeters !== null) {
            stationStops.push({ stationId: station.id, offsetMeters, isPreview: false });
        }
    }

    if (previewLatLng) {
        const offsetMeters = getOffsetOnLine(previewLatLng, profile);
        if (offsetMeters !== null) {
            stationStops.push({ stationId: null, offsetMeters, isPreview: true });
        }
    }

    return stationStops.sort((a, b) => a.offsetMeters - b.offsetMeters);
}

function buildPreviewStationSpacingSummary(stationStops) {
    const previewIndex = stationStops.findIndex(stop => stop.isPreview);
    if (previewIndex === -1) return null;

    const previewStop = stationStops[previewIndex];
    const previousStop = stationStops[previewIndex - 1] || null;
    const nextStop = stationStops[previewIndex + 1] || null;
    const leftDistance = previousStop ? formatDistanceMeters(previewStop.offsetMeters - previousStop.offsetMeters) : '--';
    const rightDistance = nextStop ? formatDistanceMeters(nextStop.offsetMeters - previewStop.offsetMeters) : '--';
    return `${leftDistance}, ${rightDistance}`;
}

function createStationDistanceLayer(line, stationStops) {
    const profile = getLineMotionProfile(line);
    if (!profile || stationStops.length < 2) return null;

    const lineColor = line.color || getLineColor(line.number || line.id);
    const markers = [];

    for (let index = 0; index < stationStops.length - 1; index++) {
        const startStop = stationStops[index];
        const endStop = stationStops[index + 1];
        const midpointOffset = startStop.offsetMeters + ((endStop.offsetMeters - startStop.offsetMeters) / 2);
        const position = getTrainPosition(profile, midpointOffset, 1);
        if (!position) continue;

        markers.push(createStationDistanceMarker(
            position.latlng,
            formatDistanceMeters(endStop.offsetMeters - startStop.offsetMeters),
            lineColor,
            { isPreview: startStop.isPreview || endStop.isPreview }
        ));
    }

    return markers.length > 0 ? L.layerGroup(markers) : null;
}

function renderCommittedStationDistanceLabels(line) {
    clearLineStationDistanceLabels(line);
    if (!shouldShowCommittedStationDistances()) return;
    const layer = createStationDistanceLayer(line, line.stationStops || []);
    if (!layer) return;
    layer.addTo(map);
    line.stationDistanceLayer = layer;
}

function syncAllCommittedStationDistanceLabels() {
    project.lines.forEach(line => {
        if (previewStationDistanceLineId === line.id && previewStationDistanceLayer) return;
        renderCommittedStationDistanceLabels(line);
    });
}

function clearPreviewStationDistances({ restoreCommitted = true } = {}) {
    const previewLine = previewStationDistanceLineId !== null
        ? project.lines.find(line => line.id === previewStationDistanceLineId)
        : null;

    if (previewStationDistanceLayer) {
        map.removeLayer(previewStationDistanceLayer);
        previewStationDistanceLayer = null;
    }

    previewStationDistanceLineId = null;
    previewStationSpacingSummary = null;

    if (restoreCommitted && previewLine) {
        renderCommittedStationDistanceLabels(previewLine);
    }

    if (currentMode === 'explore') {
        updateStatus();
    }
}

function showPreviewStationDistances(line, latlng) {
    const previewTrack = getTrackForLine(line);
    if (!previewTrack?.motionProfile) {
        clearPreviewStationDistances();
        return;
    }

    const previousPreviewLine = previewStationDistanceLineId !== null
        ? project.lines.find(entry => entry.id === previewStationDistanceLineId)
        : null;

    if (previewStationDistanceLayer) {
        map.removeLayer(previewStationDistanceLayer);
        previewStationDistanceLayer = null;
    }

    if (previousPreviewLine && previousPreviewLine.id !== line.id) {
        renderCommittedStationDistanceLabels(previousPreviewLine);
    }

    clearLineStationDistanceLabels(line);

    const previewStops = buildLineStationStops(line, { previewLatLng: latlng });
    previewStationSpacingSummary = buildPreviewStationSpacingSummary(previewStops);
    previewStationDistanceLineId = line.id;

    const previewLayer = createStationDistanceLayer(line, previewStops);
    if (previewLayer) {
        previewLayer.addTo(map);
        previewStationDistanceLayer = previewLayer;
    }

    updateStatus();
}

function updateTrainMarker(train, line) {
    if (isStation3DMapSuspended()) return;
    const profile = getLineMotionProfile(line);
    if (!train.marker || !profile) return;
    const position = getTrainPosition(profile, train.distanceMeters, train.direction);
    if (!position) return;

    const headingDeg = (position.angleDeg + 90 + 360) % 360;
    const runningPosition = offsetLatLngRightOfTravel(
        position.latlng.lat,
        position.latlng.lng,
        headingDeg,
        getLineTrackCenterOffsetAtDistance(line, train.distanceMeters),
    );
    train.marker.setLatLng([runningPosition.lat, runningPosition.lon]);
    const markerElement = train.marker.getElement();
    if (!markerElement) return;
    const pauseSeconds = Math.max(0, train.pauseRemainingSeconds || 0);
    const isStopped = pauseSeconds > 0.01;
    // atan2 returns angles in [-180, 180]. Near that seam, tiny real heading
    // changes can alternate between +179 and -179; a CSS transition then
    // spins the icon 358° back and forth. Keep a continuous unwrapped angle
    // so every visual rotation follows the shortest physical turn.
    const previousAngleDeg = Number(train.markerAngleDeg);
    const markerAngleDeg = Number.isFinite(previousAngleDeg)
        ? previousAngleDeg
            + ((((position.angleDeg - previousAngleDeg + 540) % 360) + 360) % 360 - 180)
        : position.angleDeg;
    train.markerAngleDeg = markerAngleDeg;
    markerElement.style.setProperty('--train-angle', `${markerAngleDeg}deg`);
    markerElement.classList.toggle('is-stopped', isStopped);
    markerElement.dataset.trainDistance = position.distanceMeters.toFixed(2);
    markerElement.dataset.trainDirection = String(train.direction);
    markerElement.dataset.trainState = isStopped ? 'stopped' : 'moving';
    markerElement.dataset.trainPauseSeconds = pauseSeconds.toFixed(2);

    const stopIndicator = markerElement.querySelector('.train-stop-indicator');
    if (stopIndicator) {
        const paxCount = train.totalPassengers || 0;
        const capacity = TRAIN_CAPACITY[normalizeGauge(line.gauge)];
        stopIndicator.textContent = isStopped ? formatTrainCountdown(pauseSeconds) : (paxCount > 0 ? `${paxCount}/${capacity}` : '');
    }
}

function updateLineStationStops(line, options = {}) {
    const { initializePause = false } = options;
    const profile = getLineMotionProfile(line);
    if (!profile) {
        line.stationStops = [];
        line._stationSet = new Set();
        clearLineStationDistanceLabels(line);
        return;
    }

    const stationStops = buildLineStationStops(line).map(stop => ({
        stationId: stop.stationId,
        offsetMeters: stop.offsetMeters,
    }));

    line.stationStops = stationStops;
    line._stationSet = new Set(stationStops.map(stop => stop.stationId));

    if (previewStationDistanceLineId === line.id && previewStationDistanceLayer && lastSnappedLatLng) {
        showPreviewStationDistances(line, lastSnappedLatLng);
    } else {
        renderCommittedStationDistanceLabels(line);
    }

    if (!initializePause || stationStops.length === 0 || !line.trains) return;

    for (const train of line.trains) {
        const currentStop = stationStops.find(
            stop => Math.abs(stop.offsetMeters - train.distanceMeters) <= TRAIN_STOP_MATCH_EPSILON_METERS
        );
        if (!currentStop) continue;

        train.pendingDirection = null;
        train.pauseRemainingSeconds = getLineStopDwellSeconds(line);
        train.pausedStationId = currentStop.stationId;
        if (currentStop.offsetMeters <= TRAIN_STOP_MATCH_EPSILON_METERS) {
            train.direction = 1;
        } else if (profile && currentStop.offsetMeters >= profile.totalLengthMeters - TRAIN_STOP_MATCH_EPSILON_METERS) {
            train.direction = -1;
        }
        updateTrainMarker(train, line);
    }
}

function stopLineTrain(line) {
    animatedLines.delete(line);
    if (line.trains) {
        for (const train of line.trains) {
            if (train.marker) map.removeLayer(train.marker);
        }
    }
    line.trains = [];
    line.stationStops = [];
    clearLineStationDistanceLabels(line);

    if (animatedLines.size === 0 && trainAnimationFrameId !== null) {
        cancelAnimationFrame(trainAnimationFrameId);
        trainAnimationFrameId = null;
        lastTrainAnimationTimestamp = null;
    }
}

function handleTrainArrival(train, line, stationId) {
    const station = _stationById.get(stationId);
    if (!station) return;

    const capacity = TRAIN_CAPACITY[normalizeGauge(line.gauge)];

    // --- Alight: passengers whose nextHop is this station get off ---
    let alighted = 0;
    const alightingCount = train.passengers.get(stationId) || 0;
    if (alightingCount > 0) {
        train.passengers.delete(stationId);
        train.totalPassengers -= alightingCount;

        // Check finalDest tracking — some may be transferring, others have arrived
        const finalDests = train.passengerFinalDests.get(stationId);
        train.passengerFinalDests.delete(stationId);

        if (finalDests && finalDests.size > 0) {
            for (const [finalDestId, count] of finalDests) {
                if (finalDestId === stationId) {
                    // Final destination reached — served
                    station.servedCount = (station.servedCount || 0) + count;
                    alighted += count;
                } else {
                    // Transfer passenger: move to connected station's queue
                    alighted += count;
                    handleTransferAlighting(station, stationId, finalDestId, count);
                }
            }
        } else {
            // No finalDest tracking (all direct passengers)
            station.servedCount = (station.servedCount || 0) + alightingCount;
            alighted = alightingCount;
        }

        // Clear finalDests map when train is empty to avoid stale entries
        if (train.totalPassengers === 0) train.passengerFinalDests.clear();
    }

    // --- Board: waiting passengers whose nextHop is on this line ---
    if (!station.passengerQueue) { playArrivalBeep(); showBoardingToast(station, alighted, 0); return; }
    const spaceLeft = capacity - train.totalPassengers;
    if (spaceLeft <= 0) { playArrivalBeep(); showBoardingToast(station, alighted, 0); return; }

    let boarded = 0;
    const lineStationSet = line._stationSet || new Set(line.stationIds);
    for (const [nextHopId, batches] of station.passengerQueue) {
        if (nextHopId === stationId) continue;
        if (!lineStationSet.has(nextHopId)) continue; // only board if nextHop is on this line
        if (boarded >= spaceLeft) break;

        // Board passengers FIFO — consume from oldest batch first
        let i = 0;
        while (i < batches.length && boarded < spaceLeft) {
            const batch = batches[i];
            const toBoard = Math.min(batch.count, spaceLeft - boarded);

            train.passengers.set(nextHopId, (train.passengers.get(nextHopId) || 0) + toBoard);
            train.totalPassengers += toBoard;

            // Track finalDestId for transfer awareness
            const finalDestId = batch.finalDestId || nextHopId;
            if (!train.passengerFinalDests.has(nextHopId)) train.passengerFinalDests.set(nextHopId, new Map());
            const fdMap = train.passengerFinalDests.get(nextHopId);
            fdMap.set(finalDestId, (fdMap.get(finalDestId) || 0) + toBoard);

            boarded += toBoard;
            batch.count -= toBoard;
            if (batch.count === 0) { i++; }
        }
        // Remove fully consumed batches from the front
        if (i > 0) batches.splice(0, i);
        if (batches.length === 0) station.passengerQueue.delete(nextHopId);
    }
    recomputeWaitingCount(station);

    if (boarded > 0) {
        train.totalRevenue = (train.totalRevenue || 0) + boarded * FARE_EUR;
        project.totalRevenue = (project.totalRevenue || 0) + boarded * FARE_EUR;
        updateRevenueDisplay();
    }

    // Remember the latest stop's exchange counts so observers (cab view) can
    // display them while the train is paused at the station.
    train.lastStopAlighted = alighted;
    train.lastStopBoarded = boarded;

    playArrivalBeep();
    showBoardingToast(station, alighted, boarded);
    refreshSelectedTrainPopup(train, line);
}

/**
 * Move transfer passengers from the current station to the connected station's queue.
 * Finds the transfer link, looks up the next routing hop, and enqueues.
 */
function handleTransferAlighting(station, stationId, finalDestId, count) {
    // Use cached adjacency to find connected stations (O(1) lookup, no allocation)
    const adj = getTransferAdj();
    const connectedIds = adj?.get(stationId);

    if (!connectedIds || connectedIds.length === 0) {
        station.servedCount = (station.servedCount || 0) + count;
        return;
    }

    // Pick the connected station that can route to finalDest
    const routingTable = getTransferRoutingTable();
    let bestConnectedId = null;
    let bestRoute = null;
    for (const connId of connectedIds) {
        const route = routingTable?.get(connId)?.get(finalDestId);
        if (route) {
            bestConnectedId = connId;
            bestRoute = route;
            break;
        }
        if (!bestConnectedId) bestConnectedId = connId;
    }

    const connectedStation = _stationById.get(bestConnectedId);
    if (!connectedStation) {
        station.servedCount = (station.servedCount || 0) + count;
        return;
    }

    const nextHop = bestRoute?.nextHop || finalDestId;

    if (!connectedStation.passengerQueue) connectedStation.passengerQueue = new Map();
    if (!connectedStation.passengerQueue.has(nextHop)) connectedStation.passengerQueue.set(nextHop, []);
    connectedStation.passengerQueue.get(nextHop).push({ count, arrivedAt: simHour, finalDestId });
    recomputeWaitingCount(connectedStation);
}

// Shows a short floating label near the station when passengers board or alight.
function showBoardingToast(station, alighted, boarded) {
    if (alighted === 0 && boarded === 0) return;
    if (isStation3DMapSuspended()) return;

    let html = '<div class="boarding-toast">';
    if (alighted > 0) html += `<span class="boarding-toast-off">-${alighted}</span>`;
    if (alighted > 0 && boarded > 0) html += '<span style="color:#94a3b8;font-weight:400">·</span>';
    if (boarded  > 0) html += `<span class="boarding-toast-on">+${boarded}</span>`;
    html += '</div>';

    const icon = L.divIcon({ html, className: 'boarding-toast-icon', iconSize: null, iconAnchor: [0, 0] });
    const marker = L.marker(L.latLng(station.latlng[0], station.latlng[1]), {
        icon,
        interactive: false,
        keyboard: false,
        zIndexOffset: 1100,
    }).addTo(map);

    // Remove marker after the animation completes (~2.3s)
    setTimeout(() => { if (marker._map) map.removeLayer(marker); }, 2300);
}

function closeRailConnectionChoice() {
    railConnectionChoiceModal?.classList.add('hidden');
    if (railConnectionChoices) railConnectionChoices.innerHTML = '';
}

function offerRailConnectionChoice(train, line, arrivalDirection, terminusOffsetM) {
    if (!train?._cabRidden || !savedProjectId || train.awaitingRailChoice
        || !window.__railProjectConnections || !railConnectionChoiceModal || !railConnectionChoices) {
        return false;
    }
    const lineIndex = project.lines.indexOf(line);
    const choices = window.__railProjectConnections.connectionChoices(loadedRailJunctions, {
        projectId: savedProjectId,
        lineIndex,
        arrivalDirection,
        terminusOffsetM,
    });
    if (choices.length === 0) return false;

    train.awaitingRailChoice = true;
    train.pauseRemainingSeconds = Number.POSITIVE_INFINITY;
    train.currentSpeedMps = 0;
    railConnectionChoices.innerHTML = '';

    const turnButton = document.createElement('button');
    turnButton.type = 'button';
    turnButton.className = 'modal-btn-cancel';
    turnButton.textContent = 'Okreni se i vrati';
    turnButton.onclick = () => {
        closeRailConnectionChoice();
        train.awaitingRailChoice = false;
        train.pauseRemainingSeconds = getLineStopDwellSeconds(line);
        train.pendingDirection = -arrivalDirection;
        train.atTerminus = true;
    };
    railConnectionChoices.appendChild(turnButton);

    for (const choice of choices) {
        const target = choice.port;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'modal-btn-confirm';
        const label = target.projectName || `Projekt #${target.projectId}`;
        button.textContent = `Nastavi: ${label}`;
        button.onclick = () => {
            const url = window.__railProjectConnections.buildCabHandoffUrl(window.location.href, target);
            window.location.assign(url);
        };
        railConnectionChoices.appendChild(button);
    }
    railConnectionChoiceModal.classList.remove('hidden');
    return true;
}

// Advances one planner train by dtSeconds at speedMps: dwell countdown, direction
// flip, station-stop snap + arrival, and end-of-line bounce. Extracted from
// tickTrainAnimations so the open 3D cab can be the SOLE stepper for its own
// train (wall time, once per render frame) instead of a second rAF loop racing
// the render loop. The caller supplies the already-resolved cruise speed.
function stepPlannerTrain(train, line, profile, speedMps, dtSeconds) {
    if (train.awaitingRailChoice) {
        train.currentSpeedMps = 0;
        return;
    }
    if (train.pauseRemainingSeconds > 0) {
        train.pauseRemainingSeconds = Math.max(0, train.pauseRemainingSeconds - dtSeconds);
        train.currentSpeedMps = 0;
        return;
    }
    if (Number.isFinite(train.pendingDirection)) {
        train.direction = train.pendingDirection;
        train.pendingDirection = null;
        train.atTerminus = false;   // departing after a terminus turnaround
    }
    // Train is moving — clear the paused station so profile rebuilds don't snap it back.
    train.pausedStationId = null;
    train.currentSpeedMps = speedMps;
    let nextDistance = train.distanceMeters + (train.direction * speedMps * dtSeconds);
    let nextStation = null;
    let heldForConnection = false;
    if (train.direction > 0) {
        for (let si = 0; si < line.stationStops.length; si++) {
            if (line.stationStops[si].offsetMeters > train.distanceMeters + TRAIN_STOP_DEPARTURE_EPSILON_METERS) {
                nextStation = line.stationStops[si];
                break;
            }
        }
    } else {
        for (let si = line.stationStops.length - 1; si >= 0; si--) {
            if (line.stationStops[si].offsetMeters < train.distanceMeters - TRAIN_STOP_DEPARTURE_EPSILON_METERS) {
                nextStation = line.stationStops[si];
                break;
            }
        }
    }
    if (nextStation) {
        const crossesStation = train.direction > 0
            ? nextDistance >= nextStation.offsetMeters - TRAIN_STOP_MATCH_EPSILON_METERS
            : nextDistance <= nextStation.offsetMeters + TRAIN_STOP_MATCH_EPSILON_METERS;
        if (crossesStation) {
            nextDistance = nextStation.offsetMeters;
            train.pauseRemainingSeconds = getLineStopDwellSeconds(line);
            train.pausedStationId = nextStation.stationId;
            handleTrainArrival(train, line, nextStation.stationId);
            if (nextStation.offsetMeters <= TRAIN_STOP_MATCH_EPSILON_METERS) {
                heldForConnection = offerRailConnectionChoice(
                    train,
                    line,
                    train.direction,
                    nextStation.offsetMeters,
                );
                if (!heldForConnection) train.pendingDirection = 1;
            } else if (nextStation.offsetMeters >= profile.totalLengthMeters - TRAIN_STOP_MATCH_EPSILON_METERS) {
                heldForConnection = offerRailConnectionChoice(
                    train,
                    line,
                    train.direction,
                    nextStation.offsetMeters,
                );
                if (!heldForConnection) train.pendingDirection = -1;
            }
        }
    }
    // End of line: stop AT the terminus, dwell, then reverse — a graceful
    // turnaround. Reflecting the position and flipping direction mid-cruise (the
    // old bounce) teleported the cab and flipped its heading in one frame, which
    // spiked the speed and the engine whine.
    if (nextDistance >= profile.totalLengthMeters) {
        nextDistance = profile.totalLengthMeters;
        if (train.direction > 0) {
            if (!heldForConnection) {
                heldForConnection = offerRailConnectionChoice(
                    train,
                    line,
                    train.direction,
                    profile.totalLengthMeters,
                );
            }
            if (!heldForConnection) {
                train.pauseRemainingSeconds = getLineStopDwellSeconds(line);
                train.pendingDirection = -1;
            }
            train.atTerminus = true;
        }
    } else if (nextDistance <= 0) {
        nextDistance = 0;
        if (train.direction < 0) {
            if (!heldForConnection) {
                heldForConnection = offerRailConnectionChoice(train, line, train.direction, 0);
            }
            if (!heldForConnection) {
                train.pauseRemainingSeconds = getLineStopDwellSeconds(line);
                train.pendingDirection = 1;
            }
            train.atTerminus = true;
        }
    }
    train.distanceMeters = nextDistance;
}

function tickTrainAnimations(timestamp) {
    if (animatedLines.size === 0) {
        trainAnimationFrameId = null;
        lastTrainAnimationTimestamp = null;
        return;
    }

    if (lastTrainAnimationTimestamp === null) {
        lastTrainAnimationTimestamp = timestamp;
    }

    const deltaSeconds = Math.min((timestamp - lastTrainAnimationTimestamp) / 1000, 0.25);
    lastTrainAnimationTimestamp = timestamp;

    for (const line of animatedLines) {
        const profile = getLineMotionProfile(line);
        if (!profile || profile.totalLengthMeters <= 0) continue;
        if (!line.trains) continue;
        const baseSpeedMps = (LINE_SPEED_KMH[normalizeGauge(line.gauge)]) * 1000 / 3600;

        for (const train of line.trains) {
            // The open 3D cab OWNS its train's motion: it steps the train in its
            // poseFn, once per render frame, in wall time. Skip it here so there
            // is a SINGLE stepper — two loops advancing the same distance on
            // separate requestAnimationFrames beat against each other and made the
            // cab position (and the camera + engine whine) jitter.
            if (train._cabRidden) continue;
            // A 3D cab must always advance in wall time. The map clock is 4× by
            // default (and can be much faster), which made planner trams cross
            // heading samples several times too quickly in cab view.
            const useRealtimeMotion = line.cabRealtimeMotion === true;
            const timeMultiplier = useRealtimeMotion ? 1 : window.simClock.getSpeedMultiplier();
            const scaledDelta = deltaSeconds * timeMultiplier;
            // Map animation may still slow standard-gauge service through a tight
            // legacy bend; the cab (realtime) never does.
            const curveSpeedFactor = isMetroStyleLine(line) && !useRealtimeMotion
                ? getUndergroundCurveSpeedFactor(line, train.distanceMeters)
                : 1;
            stepPlannerTrain(train, line, profile, baseSpeedMps * curveSpeedFactor, scaledDelta);
            updateTrainMarker(train, line);
        }
    }

    trainAnimationFrameId = requestAnimationFrame(tickTrainAnimations);
}

function ensureTrainAnimationLoop() {
    if (trainAnimationFrameId !== null) return;
    trainAnimationFrameId = requestAnimationFrame(tickTrainAnimations);
}

function createTrainObject(line, startOffset) {
    const profile = getLineMotionProfile(line);
    if (!profile || !profile.segments || profile.segments.length === 0) return null;
    const marker = new SmoothTrainMarker(profile.segments[0].start, {
        icon: createTrainIcon(line),
        interactive: true,
        keyboard: false,
        zIndexOffset: 900,
    }).addTo(map);

    const train = {
        id: nextTrainId++,
        marker,
        distanceMeters: startOffset || 0,
        direction: 1,
        pendingDirection: null,
        currentSpeedMps: 0,
        pauseRemainingSeconds: 0,
        pausedStationId: null,
        passengers: new Map(),          // nextHopId -> count
        passengerFinalDests: new Map(), // nextHopId -> Map<finalDestId, count> (for transfer tracking)
        totalPassengers: 0,
        totalRevenue: 0,
    };

    return train;
}

function addTrainToLine(line, startOffset) {
    const profile = getLineMotionProfile(line);
    if (!profile || profile.totalLengthMeters <= 0) return null;
    if (!line.trains) line.trains = [];

    const train = createTrainObject(line, startOffset);
    if (!train) return null;
    line.trains.push(train);
    attachTrainClickHandlerForTrain(train, line);
    updateTrainMarker(train, line);

    if (!animatedLines.has(line)) {
        animatedLines.add(line);
    }
    ensureTrainAnimationLoop();
    return train;
}

function removeTrainFromLine(line, train) {
    if (!line.trains) return;
    const idx = line.trains.indexOf(train);
    if (idx === -1) return;
    if (train.marker) map.removeLayer(train.marker);
    line.trains.splice(idx, 1);
    if (line.trains.length === 0) {
        animatedLines.delete(line);
        if (animatedLines.size === 0 && trainAnimationFrameId !== null) {
            cancelAnimationFrame(trainAnimationFrameId);
            trainAnimationFrameId = null;
            lastTrainAnimationTimestamp = null;
        }
    }
    updateTracksListUI();
}

function startLineTrain(line) {
    // Remember how many trains existed before reset (e.g. vertex drag).
    // Fall back to savedTrainCount (set during project load) if no trains are running yet.
    const previousTrainCount = line.trains ? line.trains.length : (line.savedTrainCount ?? 0);
    stopLineTrain(line);

    // Rebuild motion profile: multi-station lines build from station paths, single-track use track geometry
    if (line.stationIds && line.stationIds.length >= 2) {
        // Ensure all tracks used by the line have motion profiles (needed by extractPathBetweenStations)
        for (const sid of line.stationIds) {
            const st = _stationById.get(sid);
            if (st?.trackId) {
                const track = project.tracks.find(t => t.id === st.trackId);
                if (track && !track.motionProfile) buildTrackMotionProfile(track);
            }
        }
        buildLineMotionProfileFromStations(line);
        updateLineStationStopsFromIds(line);
    } else {
        const track = getTrackForLine(line);
        if (!track) return;
        buildTrackMotionProfile(track);
        if (!track.motionProfile || track.motionProfile.totalLengthMeters <= 0) return;
        // Single-track line: don't cache profile on line; getLineMotionProfile falls through to track
        line.motionProfile = null;
        updateLineStationStops(line);
    }

    const profile = getLineMotionProfile(line);
    if (!profile || profile.totalLengthMeters <= 0) return;

    line.trains = [];

    // Restore previous train count, or create 1 if fresh line
    const trainCount = Math.max(1, previousTrainCount);
    const stops = line.stationStops || [];
    for (let i = 0; i < trainCount; i++) {
        let offset;
        if (stops.length > 0) {
            const stopIndex = i % stops.length;
            offset = stops[stopIndex].offsetMeters;
        } else {
            offset = trainCount > 1 ? (i / trainCount) * profile.totalLengthMeters : 0;
        }
        const train = createTrainObject(line, offset);
        if (!train) continue;
        if (stops.length > 0) {
            const atStop = stops.find(s => Math.abs(s.offsetMeters - offset) < TRAIN_STOP_MATCH_EPSILON_METERS);
            if (atStop) {
                train.pauseRemainingSeconds = getLineStopDwellSeconds(line);
                train.pausedStationId = atStop.stationId;
                handleTrainArrival(train, line, atStop.stationId);
            }
        }
        line.trains.push(train);
        attachTrainClickHandlerForTrain(train, line);
        updateTrainMarker(train, line);
    }

    animatedLines.add(line);
    ensureTrainAnimationLoop();
}

function allocateTrackId(preferredId) {
    if (Number.isInteger(preferredId) && preferredId > 0 && !project.tracks.some(t => t.id === preferredId)) {
        nextTrackId = Math.max(nextTrackId, preferredId + 1);
        return preferredId;
    }
    return nextTrackId++;
}

// Returns the primary track for a line — derived from the first station's trackId.
function getTrackForLine(line) {
    if (line.trackId) return project.tracks.find(t => t.id === line.trackId);
    // Derive from first station
    const firstStationId = line.stationIds?.[0] || line.depotStationId;
    if (firstStationId) {
        const st = _stationById.get(firstStationId);
        if (st?.trackId) return project.tracks.find(t => t.id === st.trackId);
    }
    // Fallback: find any station on this line
    const anySt = project.stations.find(s => s.lineId === line.id);
    if (anySt?.trackId) return project.tracks.find(t => t.id === anySt.trackId);
    return null;
}

// Returns the effective motion profile for a line:
// multi-track lines have their own combined profile, single-track lines use the track's profile.
function getLineMotionProfile(line) {
    if (line.motionProfile) return line.motionProfile;
    const track = getTrackForLine(line);
    return track?.motionProfile || null;
}

// Compute the line's route length in km from its live motion profile.
function getLineLengthKm(line) {
    const profile = getLineMotionProfile(line);
    return profile ? profile.totalLengthMeters / 1000 : 0;
}

function allocateLineId(preferredId) {
    if (Number.isInteger(preferredId) && preferredId > 0 && !project.lines.some(line => line.id === preferredId)) {
        nextLineId = Math.max(nextLineId, preferredId + 1);
        return preferredId;
    }

    return nextLineId++;
}

function allocateLineNumber(preferredNumber) {
    if (Number.isInteger(preferredNumber) && preferredNumber > 0 && !project.lines.some(line => line.number === preferredNumber)) {
        nextLineNumber = Math.max(nextLineNumber, preferredNumber + 1);
        return preferredNumber;
    }

    return nextLineNumber++;
}

// action: optional { label, onClick } rendered as a button inside the toast
// (e.g. a shortcut to the sidebar Linije tab from delete-guard messages).
function showToast(message, isError = false, action = null) {
    if (!message) return;
    message = I18N?.translateText(message) || message;
    if (action?.label) action = { ...action, label: I18N?.translateText(action.label) || action.label };
    // Log to game log
    let simTime = '--:--';
    // Read the clock directly rather than the cached simHour: the demand loop
    // that refreshes it is stopped during a 3D session, and a log line stamped
    // with the time the ride STARTED is worse than no cache at all.
    try {
        simTime = formatSimTime(window.simClock ? window.simClock.getSimHour() : simHour);
    } catch (_) { /* simHour not yet initialized */ }
    gameLog.push({ time: simTime, message, isError, ts: Date.now() });
    if (gameLog.length > 500) gameLog.splice(0, gameLog.length - 500);
    if (isStation3DMapSuspended()) {
        // Every deep-link failure path ends in an error toast, and while the map
        // is suspended a toast is swallowed — which on a BOOT screen would leave
        // a spinner turning forever over an error nobody can read. So an error
        // raised while the stand-in is up reveals the planner and is shown.
        // Once a real 3D session owns the screen this no longer applies: it
        // reports its own failures and the map beneath must stay hidden.
        if (!isError || !plannerBootLoadingVisible()) return;
        revealPlannerMap();
    }
    // Show toast
    const toast = document.createElement('div');
    const hasAction = Boolean(action?.label && typeof action.onClick === 'function');
    toast.className = `toast${isError ? ' toast-error' : ''}${hasAction ? ' toast-with-action' : ''}`;
    toast.innerHTML = message;
    if (hasAction) {
        const actionBtn = document.createElement('button');
        actionBtn.type = 'button';
        actionBtn.className = 'toast-action-btn';
        actionBtn.textContent = action.label;
        actionBtn.addEventListener('click', () => {
            toast.remove();
            action.onClick();
        });
        toast.appendChild(actionBtn);
    }
    toastContainer.appendChild(toast);
    toast.addEventListener('animationend', (e) => {
        if (e.animationName === 'toast-out') toast.remove();
    });
    // Safety removal — actionable toasts linger longer so the button can be used
    setTimeout(() => toast.remove(), hasAction ? 8000 : 4000);
}

// Keep backward-compatible alias used throughout
function setStatusMessage(message, isError = false, action = null) {
    showToast(message, isError, action);
}

// Ephemeral top-centre banner after a project opens on the map: how to get
// into the cab. The wording (and the no-train silence) is planner-cab-hint.js;
// the timing is CSS — the element removes itself when its fade has finished,
// and openPlannerTrainCab drops it at once, since by then it has been obeyed.
const plannerCabHintEl = document.getElementById('plannerCabHint');
function showPlannerCabHint() {
    if (!plannerCabHintEl || !window.__plannerCabHint || isStation3DMapSuspended()) return;
    const hint = window.__plannerCabHint.plannerCabHint({
        hasTrain: Boolean(window.__plannerCabTarget.pickCabTarget(project, null)),
        coarsePointer: window.matchMedia('(pointer: coarse)').matches,
    });
    if (!hint) return;
    plannerCabHintEl.replaceChildren(hint.lead);
    if (hint.key) {
        const kbd = document.createElement('kbd');
        kbd.textContent = hint.key;
        plannerCabHintEl.append(' ', kbd, ' ');
    }
    if (hint.rest) plannerCabHintEl.append(hint.rest);
    plannerCabHintEl.classList.remove('hidden', 'is-showing');
    void plannerCabHintEl.offsetWidth; // restart the animation on a repeat show
    plannerCabHintEl.classList.add('is-showing');
}
function hidePlannerCabHint() {
    if (!plannerCabHintEl) return;
    plannerCabHintEl.classList.add('hidden');
    plannerCabHintEl.classList.remove('is-showing');
}
if (plannerCabHintEl) {
    plannerCabHintEl.addEventListener('animationend', (e) => {
        if (e.animationName === 'planner-cab-hint-out') hidePlannerCabHint();
    });
}

function renderGameLog() {
    if (gameLog.length === 0) {
        gameLogContent.innerHTML = '<div class="game-log-empty">Nema zapisa.</div>';
        return;
    }
    gameLogContent.innerHTML = gameLog.slice().reverse().map(entry =>
        `<div class="game-log-entry"><span class="game-log-time">${escapeHtml(entry.time)}</span><span class="game-log-msg${entry.isError ? ' is-error' : ''}">${escapeHtml(entry.message)}</span></div>`
    ).join('');
    gameLogContent.scrollTop = 0;
}

function openGameLog() {
    renderGameLog();
    closeSidebarOnMobile();
    gameLogModal.classList.remove('hidden');
    toggleBtn.style.display = 'none';
}

function closeGameLog() {
    gameLogModal.classList.add('hidden');
    toggleBtn.style.display = '';
}

function getNetworkErrorMessage(url) {
    return url === ISOCHRONE_URL ? valhallaUnavailableMessage : apiUnavailableMessage;
}

async function fetchJson(url, payload, options = {}) {
    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: getPostHeaders(url),
            body: JSON.stringify(payload),
            signal: options.signal,
        });
    } catch (error) {
        if (error.name === 'AbortError') {
            throw error;
        }
        throw new Error(getNetworkErrorMessage(url));
    }
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || body.message || `Request failed: ${response.status}`);
    }
    return response.json();
}

// ─── Pedestrian Catchment ───────────────────────────────────────────────────
async function fetchPedestrianCatchment(lat, lon, walkMinutes, options = {}) {
    const data = await fetchJson(ISOCHRONE_URL, {
        locations: [{ lat, lon }],
        costing: 'pedestrian',
        contours: [{ time: walkMinutes }],
        polygons: true,
    }, options);
    return data;
}

async function fetchCatchmentStats(polygon, options = {}) {
    return fetchJson(CATCHMENT_STATS_URL, { polygon }, options);
}

async function fetchCachedStationCatchment(lat, lng, walkMinutes, options = {}) {
    const response = await fetch(STATION_CATCHMENT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat, lng, walkMinutes }),
        signal: options.signal,
    });
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Station catchment request failed (${response.status})`);
    }
    return response.json();
}

function getOutermostPolygon(polygonData) {
    if (!polygonData || !polygonData.features || polygonData.features.length === 0) return null;
    let best = polygonData.features[0];
    for (const f of polygonData.features) {
        if ((f.properties.contour || 0) > (best.properties.contour || 0)) best = f;
    }
    return best.geometry;
}

function updateCatchmentStatsPanel(data) {
    const { catchment_population, catchment_jobs } = data;
    const populationField = CITY_CONFIG.providerFields?.catchmentTotalPopulation || 'city_population';
    const jobsField = CITY_CONFIG.providerFields?.catchmentTotalJobs || 'city_jobs';
    const cityPopulation = Number(data[populationField]) || 0;
    const cityJobs = Number(data[jobsField]) || 0;
    const popPct = cityPopulation > 0 ? (catchment_population / cityPopulation * 100) : 0;
    const jobsPct = cityJobs > 0 ? (catchment_jobs / cityJobs * 100) : 0;

    document.getElementById('statCatchmentPop').textContent = formatNumber(catchment_population);
    document.getElementById('barPopIn').style.width = `${popPct}%`;
    document.getElementById('barPopOut').style.width = `${100 - popPct}%`;
    document.getElementById('statPopDetail').textContent =
        ui(
            `${popPct.toFixed(1)}% of ${CITY_CONFIG.name || 'the city'} (${formatNumber(cityPopulation)} total)`,
            `${popPct.toFixed(1)}% od ukupno ${formatNumber(cityPopulation)}`,
        );

    document.getElementById('statCatchmentJobs').textContent = formatNumber(catchment_jobs);
    document.getElementById('barJobsIn').style.width = `${jobsPct}%`;
    document.getElementById('barJobsOut').style.width = `${100 - jobsPct}%`;
    document.getElementById('statJobsDetail').textContent =
        ui(
            `${jobsPct.toFixed(1)}% of ${CITY_CONFIG.name || 'the city'} (${formatNumber(cityJobs)} total)`,
            `${jobsPct.toFixed(1)}% od ukupno ${formatNumber(cityJobs)}`,
        );

    catchmentStatsDiv.classList.remove('hidden');
}

function showDisabledCatchmentStatsPanel() {
    document.getElementById('statCatchmentPop').textContent = '0';
    document.getElementById('barPopIn').style.width = '0%';
    document.getElementById('barPopOut').style.width = '100%';
    document.getElementById('statPopDetail').textContent = ui('Catchment disabled.', 'Doseg isključen.');

    document.getElementById('statCatchmentJobs').textContent = '0';
    document.getElementById('barJobsIn').style.width = '0%';
    document.getElementById('barJobsOut').style.width = '100%';
    document.getElementById('statJobsDetail').textContent = ui('Catchment disabled.', 'Doseg isključen.');

    catchmentStatsDiv.classList.remove('hidden');
}

function updateHeatmapButtons() {
    togglePopulationHeatmapBtn.classList.toggle('active', activeHeatmapField === 'residents');
    toggleJobsHeatmapBtn.classList.toggle('active', activeHeatmapField === 'jobs');

    const isLoading = heatmapLoadingField !== null;
    togglePopulationHeatmapBtn.disabled = isLoading;
    toggleJobsHeatmapBtn.disabled = isLoading;

    togglePopulationHeatmapBtn.textContent = heatmapLoadingField === 'residents'
        ? ui('Loading…', 'Učitavanje...') : ui('Population', 'Stanovnici');
    toggleJobsHeatmapBtn.textContent = heatmapLoadingField === 'jobs'
        ? ui('Loading…', 'Učitavanje...') : ui('Jobs', 'Radna mjesta');
}

function updateRailStationsButton() {
    toggleRailStationsBtn.checked = railStationsVisible;
    toggleRailStationsBtn.disabled = railStationsLoading;
    toggleRailStationsText.textContent = railStationsLoading ? ui('Loading…', 'Učitavanje...') : ui('Rail', 'Vlak');
}

function updateReferenceRailProjectsButton() {
    if (!toggleReferenceRailProjectsBtn) return;
    toggleReferenceRailProjectsBtn.checked = referenceRailVisible;
    toggleReferenceRailProjectsBtn.disabled = referenceRailLoading;
    if (toggleReferenceRailProjectsText) {
        toggleReferenceRailProjectsText.textContent = referenceRailLoading
            ? ui('Loading…', 'Učitavanje...')
            : ui('Other railways', 'Ostale pruge');
    }
}

function updateTramStopsButton() {
    toggleTramStopsBtn.checked = tramStopsVisible;
    toggleTramStopsBtn.disabled = tramStopsLoading;
    toggleTramStopsText.textContent = tramStopsLoading ? ui('Loading…', 'Učitavanje...') : ui('Tram', 'Tramvaj');
}

function updateTerrainMapButton() {
    if (!toggleTerrainMapInput) return;
    toggleTerrainMapInput.checked = terrainMapVisible;
    toggleTerrainMapInput.disabled = !TERRAIN_MAP_API;
    if (toggleTerrainMapText) {
        toggleTerrainMapText.textContent = TERRAIN_MAP_API
            ? ui('Terrain', 'Reljef') : ui('Terrain unavailable', 'Reljef nije dostupan');
    }
    if (terrainMapLegend) {
        terrainMapLegend.classList.toggle('hidden', !terrainMapVisible);
        terrainMapLegend.setAttribute('aria-hidden', String(!terrainMapVisible));
    }
}

function ensureTerrainMapLayer() {
    if (!TERRAIN_MAP_API) return null;
    const source = getTerrainMapSource();
    const url = TERRAIN_MAP_API.tileUrlTemplate(API_BASE_URL, source);
    if (!terrainMapLayer) {
        terrainMapLayer = L.tileLayer(url, {
            ...TERRAIN_MAP_API.TILE_REQUEST_OPTIONS,
            pane: TERRAIN_MAP_PANE,
            opacity: 0.72,
            minZoom: 8,
            maxNativeZoom: 17,
            maxZoom: 19,
            crossOrigin: true,
            attribution: CITY_CONFIG.providerLabels?.terrainAttribution || 'Elevation data',
        });
        terrainMapLayer.on('tileerror', () => {
            if (terrainMapTileErrorShown || !terrainMapVisible) return;
            terrainMapTileErrorShown = true;
            setStatusMessage('Učitavanje reljefne podloge nije uspjelo.', true);
        });
    } else if (terrainMapSource !== source) {
        terrainMapLayer.setUrl(url, false);
    }
    terrainMapSource = source;
    return terrainMapLayer;
}

function syncTerrainMapSource() {
    if (!terrainMapLayer) return;
    const source = getTerrainMapSource();
    if (source === terrainMapSource) return;
    terrainMapSource = source;
    terrainMapTileErrorShown = false;
    terrainMapLayer.setUrl(
        TERRAIN_MAP_API.tileUrlTemplate(API_BASE_URL, source),
        false,
    );
    if (terrainMapVisible) terrainMapLayer.redraw();
}

function setTerrainMapVisible(visible) {
    const layer = visible ? ensureTerrainMapLayer() : terrainMapLayer;
    terrainMapVisible = Boolean(visible && layer);
    terrainMapTileErrorShown = false;
    if (terrainMapVisible) {
        if (!map.hasLayer(layer)) layer.addTo(map);
        setStatusMessage('Reljefna podloga uključena — klik na kartu prikazuje nadmorsku visinu.');
    } else {
        if (layer && map.hasLayer(layer)) map.removeLayer(layer);
        closeWalkPopup();
    }
    updateTerrainMapButton();
}

function clearHeatmapLayer() {
    if (heatmapLayer) {
        map.removeLayer(heatmapLayer);
        heatmapLayer = null;
    }
    activeHeatmapField = null;
    heatmapLoadingField = null;
    updateHeatmapButtons();
}

function clearRailStationsLayer() {
    if (railStationsLayer && map.hasLayer(railStationsLayer)) {
        map.removeLayer(railStationsLayer);
    }
    railStationsVisible = false;
    railStationsLoading = false;
    updateRailStationsButton();
}

function clearTramStopsLayer() {
    if (tramStopsLayer && map.hasLayer(tramStopsLayer)) {
        map.removeLayer(tramStopsLayer);
    }
    tramStopsVisible = false;
    tramStopsLoading = false;
    updateTramStopsButton();
}

function createReferenceStopsLayer(stops, markerClassName, markerHtml, fallbackTitle) {
    return L.layerGroup(stops.map(stop => L.marker([stop.lat, stop.lng], {
        icon: L.divIcon({
            className: markerClassName,
            html: markerHtml,
            iconSize: [16, 16],
            iconAnchor: [8, 8],
        }),
        interactive: false,
        keyboard: false,
        title: stop.name || fallbackTitle,
    })));
}

function createRailStationsLayer(stations) {
    return createReferenceStopsLayer(
        stations,
        'rail-station-marker',
        '<span class="rail-station-marker-diamond"></span>',
        'Postojeca zeljeznicka stanica'
    );
}

function createTramStopsLayer(stops) {
    return createReferenceStopsLayer(
        stops,
        'tram-stop-marker',
        '<span class="tram-stop-marker-dot"></span>',
        'Postojeca tramvajska stanica'
    );
}

async function loadRailStationsData() {
    if (!railStationsDataPromise) {
        railStationsDataPromise = fetch(RAIL_STATIONS_URL)
            .then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.json();
            })
            .then(payload => {
                if (!Array.isArray(payload)) {
                    throw new Error('Neispravan format popisa zeljeznickih stanica.');
                }
                railStationsResolvedData = payload;
                return payload;
            })
            .catch(error => {
                railStationsDataPromise = null;
                throw error;
            });
    }

    return railStationsDataPromise;
}

async function loadTramStopsData() {
    if (!tramStopsDataPromise) {
        tramStopsDataPromise = fetch(TRAM_STOPS_URL)
            .then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.json();
            })
            .then(payload => {
                if (!Array.isArray(payload)) {
                    throw new Error('Neispravan format popisa tramvajskih stanica.');
                }
                tramStopsResolvedData = payload;
                return payload;
            })
            .catch(error => {
                tramStopsDataPromise = null;
                throw error;
            });
    }

    return tramStopsDataPromise;
}

async function loadHeatmap(field, options = {}) {
    const { preserveStatus = false } = options;
    const config = HEATMAP_CONFIG[field];
    if (!config) return;
    if (typeof L.heatLayer !== 'function') {
        throw new Error('Heatmap plugin nije učitan.');
    }

    const token = ++heatmapRequestToken;
    heatmapLoadingField = field;
    updateHeatmapButtons();

    const bounds = map.getBounds();
    const bbox = `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`;

    try {
        const response = await fetch(`${BUILDINGS_HEATMAP_URL}?bbox=${bbox}&field=${field}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const points = await response.json();
        if (token !== heatmapRequestToken) return;

        if (heatmapLayer) map.removeLayer(heatmapLayer);
        heatmapLayer = L.heatLayer(
            points.map(point => [point.lat, point.lng, point.value]),
            {
                radius: 18,
                blur: 22,
                maxZoom: 17,
                max: config.max,
                gradient: config.gradient,
            }
        ).addTo(map);

        activeHeatmapField = field;
        if (!preserveStatus) {
            setStatusMessage(`Toplinska karta: ${points.length.toLocaleString(UI_LOCALE)} zgrada s ${config.label}.`);
        }
    } catch (error) {
        if (token !== heatmapRequestToken) return;
        if (!preserveStatus) {
            setStatusMessage(error.message, true);
        }
        throw error;
    } finally {
        if (token === heatmapRequestToken) {
            heatmapLoadingField = null;
            updateHeatmapButtons();
        }
    }
}

async function toggleRailStations() {
    if (railStationsVisible) {
        clearRailStationsLayer();
        if (window.railwaySim) window.railwaySim.setEnabled(false);
        updateStatus();
        return;
    }

    railStationsLoading = true;
    updateRailStationsButton();

    try {
        const simulationAvailable = supportsReferenceSimulation(getProjectLocationId(), 'rail');
        let stations = [];
        if (RAIL_STATIONS_URL) {
            stations = await loadRailStationsData();
            if (!railStationsLayer) {
                railStationsLayer = createRailStationsLayer(stations);
            }
            railStationsLayer.addTo(map);
        }
        railStationsVisible = true;
        if (window.railwaySim) window.railwaySim.setEnabled(simulationAvailable);
        setStatusMessage(stations.length > 0
            ? `Prikazano ${formatNumber(stations.length)} postojećih željezničkih stanica.`
            : 'Prikazan je željeznički promet.');
    } catch (error) {
        console.error('Rail stations load error:', error);
        setStatusMessage('Učitavanje željezničkih stanica nije uspjelo.', true);
    } finally {
        railStationsLoading = false;
        updateRailStationsButton();
    }
}

async function toggleReferenceRailProjects() {
    if (referenceRailLoading) return;
    if (referenceRailVisible) {
        referenceRailVisible = false;
        rememberReferenceRailVisible(false);
        referenceConnectionMode = false;
        lastReferenceRailSnap = null;
        await refreshReferenceRailMapLayer();
        updateReferenceRailProjectsButton();
        syncMapActionButtons();
        setStatusMessage('Ostale pruge su skrivene na karti i u 3D prikazu.');
        return;
    }

    referenceRailLoading = true;
    referenceRailVisible = true;
    rememberReferenceRailVisible(true);
    updateReferenceRailProjectsButton();
    try {
        const count = await refreshReferenceRailMapLayer();
        if (count === null) {
            throw new Error('reference-project geometry endpoint unavailable');
        }
        fitMapToConnectedReferenceRailContext();
        setStatusMessage(count > 0
            ? `Prikazano ${formatNumber(count)} dionica drugih projekata na karti i u 3D prikazu.`
            : 'Za ovo područje nema pripremljenih drugih željezničkih projekata.');
    } catch (error) {
        console.error('Reference rail projects load error:', error);
        referenceRailVisible = false;
        await refreshReferenceRailMapLayer();
        setStatusMessage('Učitavanje drugih željezničkih projekata nije uspjelo.', true);
    } finally {
        referenceRailLoading = false;
        updateReferenceRailProjectsButton();
        syncMapActionButtons();
    }
}

async function toggleTramStops() {
    if (tramStopsVisible) {
        clearTramStopsLayer();
        if (window.tramSim) window.tramSim.setEnabled(false);
        updateStatus();
        return;
    }

    tramStopsLoading = true;
    updateTramStopsButton();

    try {
        if (!TRAM_STOPS_URL) throw new Error('No reference-transit stop dataset is configured.');
        const stops = await loadTramStopsData();
        if (!tramStopsLayer) {
            tramStopsLayer = createTramStopsLayer(stops);
        }
        tramStopsLayer.addTo(map);
        tramStopsVisible = true;
        if (window.tramSim) window.tramSim.setEnabled(true);
        setStatusMessage(`Prikazano ${formatNumber(stops.length)} postojećih tramvajskih stanica.`);
    } catch (error) {
        console.error('Tram stops load error:', error);
        setStatusMessage('Učitavanje tramvajskih stanica nije uspjelo.', true);
    } finally {
        tramStopsLoading = false;
        updateTramStopsButton();
    }
}

async function ensureRailStationsVisible() {
    if (railStationsVisible) return;
    await toggleRailStations();
    if (!railStationsVisible) {
        throw new Error('Učitavanje željezničke mreže nije uspjelo.');
    }
}

async function ensureTramStopsVisible() {
    if (tramStopsVisible) return;
    await toggleTramStops();
    if (!tramStopsVisible) {
        throw new Error('Učitavanje tramvajske mreže nije uspjelo.');
    }
}

function waitForWindowEvent(eventName) {
    return new Promise(resolve => {
        window.addEventListener(eventName, resolve, { once: true });
    });
}

async function waitForTramSimApi() {
    if (window.tramSim) return window.tramSim;
    if (!supportsReferenceSimulation(getProjectLocationId(), 'tram')) {
        throw new Error('No reference tram simulation is configured for this location.');
    }
    await waitForWindowEvent('tramSim:api-ready');
    return window.tramSim;
}

// The page installs a tiny facade first. Only a real 3D intent asks that facade
// to fetch and evaluate the renderer/runtime chunks; there is no arbitrary
// desktop-shaped timeout on a cold mobile load.
async function waitForStation3D() {
    // The planner adapter resolves only after the packaged facade has received
    // the product API URL and exact Croatia world profile. This is a startup
    // boundary only; it adds no work to Station3D's render or simulation loops.
    let station3D;
    if (window.__transitPlannerStation3DReady) {
        station3D = await window.__transitPlannerStation3DReady;
    } else {
        if (!window.__station3DReady) {
            await waitForWindowEvent('station3d:loader-ready');
        }
        station3D = await window.__station3DReady;
    }
    if (station3D && typeof station3D.openCab === 'function') {
        return typeof station3D.preload === 'function'
            ? station3D.preload()
            : station3D;
    }
    const detail = window.__station3DLoadError?.message || 'nepoznata pogreška modula';
    throw new Error(`Station3D module failed to load: ${detail}`);
}

async function applyLiveNetworkScene(options = {}) {
    const {
        openRandomTramCab = false,
        linkedCabStation = null,
        linkedCabDirection = 0,
    } = options;
    const openGeneration = openRandomTramCab || linkedCabStation
        ? beginPlanner3DOpenIntent()
        : null;

    const tramSim = await waitForTramSimApi();
    if (openRandomTramCab || linkedCabStation) {
        await waitForStation3D();
        // Both random-tram and station-cab paths need the full schedule:
        // focusRandomActiveTram iterates getActiveTrips() (schedule-driven)
        // and openCabAtStop calls buildLinkedTripFromStop (also schedule-
        // driven). whenLightReady only covers tracks/stops, not trips.
        if (typeof tramSim.whenReady === 'function') {
            await tramSim.whenReady();
        }
        if (!planner3DOpenIntentIsCurrent(openGeneration)) return false;
    } else {
        await Promise.all([ensureRailStationsVisible(), ensureTramStopsVisible()]);
        if (typeof tramSim.whenReady === 'function') {
            await tramSim.whenReady();
        }
    }

    let selection = null;
    if (linkedCabStation) {
        if (!planner3DOpenIntentIsCurrent(openGeneration)) return false;
        if (typeof tramSim.openCabAtStop !== 'function') {
            throw new Error('Ova verzija tramvajske mreže ne podržava duboki link za stanicu.');
        }
        selection = tramSim.openCabAtStop({
            station: linkedCabStation,
            direction: linkedCabDirection,
            panToMarker: true,
            minZoom: 15,
        });
        const routeLabel = escapeHtml(selection.trip.routeName || '?');
        const startLabel = escapeHtml(selection.startStop?.name || linkedCabStation);
        const goalLabel = escapeHtml(selection.goalStop?.name || '?');
        setStatusMessage(`Otvorena kabina na stanici ${startLabel}, linija ${routeLabel}, cilj ${goalLabel}.`);
    } else {
        const focusOptions = {
            openCab: openRandomTramCab,
            openPopup: !openRandomTramCab,
            panToMarker: true,
            minZoom: 15,
            quickStart: false,
        };
        // Prefer a real active service. During an overnight/service gap, keep
        // the actual simulation clock (and therefore the night scene) and
        // synthesize the existing line 6 quick-start trip instead.
        if (openRandomTramCab && !planner3DOpenIntentIsCurrent(openGeneration)) return false;
        selection = tramSim.focusRandomActiveTram(focusOptions);
        if (!selection && openRandomTramCab) {
            selection = tramSim.focusRandomActiveTram({
                ...focusOptions,
                quickStart: true,
            });
        }
        if (!selection) {
            throw new Error('Nije moguće pripremiti tramvaj za ovu poveznicu.');
        }

        const routeLabel = escapeHtml(selection.trip.routeName || '?');
        if (openRandomTramCab) {
            setStatusMessage(`Otvorena kabina nasumičnog tramvaja linije ${routeLabel}.`);
        } else {
            setStatusMessage(`Nasumični tramvaj linije ${routeLabel} je označen na karti.`);
        }
    }
}

// Resolve simulation availability from the spawn itself: an old contradictory
// `loc` must not make another location wait for a city-pack dataset.
function deeplinkHasReferenceTramSimulation(lat, lon) {
    const pointLocation = window.__locationRegistry?.detectByLatLng?.(lat, lon);
    return supportsReferenceSimulation(pointLocation || getProjectLocationId(), 'tram');
}

// Passenger demand needs census (population + jobs) data. Locations prepared
// without it (Split: prepared.census=false) can't simulate boarding demand, so
// the per-station supply/demand labels are all-zero and meaningless — they stay
// hidden there. Per-city via the registry, not hardcoded to one city.
function locationHasPassengerDemand() {
    const cfg = window.__locationRegistry?.REGISTRY?.[getProjectLocationId()];
    return cfg ? cfg.prepared?.census !== false : true;
}

// A project's geometry is authoritative. Its stored location is only the
// context for a not-yet-materialized/empty project; URL state never overrides
// either one.
function resolveProjectLocationId() {
    return PLANNER_LOCATION_API.projectLocationId({
        tracks: project.tracks,
        currentLocationId: project.locationId,
        registry: window.__locationRegistry,
    });
}

function setProjectLocationId(locId) {
    project.locationId = window.__locationRegistry?.isKnown?.(locId) ? locId : null;
    syncTerrainMapSource();
}

function locationLabel(locId) {
    return window.__locationRegistry?.REGISTRY[locId]?.label || locId;
}

// Existing geometry wins; an empty project uses its internal first-point/view
// context, with the selected manifest as the initial fallback.
function getProjectLocationId() {
    return PLANNER_LOCATION_API.projectLocationId({
        tracks: project.tracks,
        currentLocationId: project.locationId,
        registry: window.__locationRegistry,
        fallback: CITY_CONFIG.id,
    });
}

// Phase 2 guard: a new track must fall within the project's location. Returns
// { ok } or { ok:false, message } (Croatian, for the status line). No registry
// (script not loaded) ⇒ never blocks.
function validateNewTrackLocation(latlngs) {
    const registry = window.__locationRegistry;
    if (!registry) return { ok: true };
    const newLoc = registry.detectByPoints(latlngs);
    const projLoc = getProjectLocationId();
    if (newLoc === projLoc) return { ok: true };
    const supported = registry.ids.map(locationLabel).join(', ');
    if (!newLoc) {
        return { ok: false, message: `Crtanje je podržano samo u pripremljenim lokacijama: ${supported}. Ovo područje još nije pripremljeno.` };
    }
    return { ok: false, message: `Ovaj projekt je u lokaciji ${locationLabel(projLoc)}. Za planiranje u ${locationLabel(newLoc)} započnite novi projekt (odaberite tu lokaciju).` };
}

// An empty project adopts the location of its first point in memory. The point
// itself is the durable authority once the track exists, so no URL mutation is
// needed.
function adoptDrawingLocation(locId) {
    setProjectLocationId(locId);
}

// Discard the current project and reload clean into another prepared location.
// A full reload (rather than an in-place clear) is deliberate: the location
// drives terrain, city data and the 3D world, and the page-load path already
// wires all of that up correctly for the target — an in-place switch would have
// to re-run it by hand and would strand stale layers.
function startFreshProjectInLocation(locId) {
    const params = new URLSearchParams(window.location.search);
    params.delete('project');            // a new project, not the shared one
    params.delete('loc');
    const center = PLANNER_LOCATION_API.locationCenter(window.__locationRegistry, locId);
    if (center) {
        params.set('lat', center.lat.toFixed(6));
        params.set('lon', center.lon.toFixed(6));
    }
    params.set('new', '1');              // blank slate, not the top-leaderboard fallback
    window.location.href = `${window.location.pathname}?${params.toString()}`;
}

// Frame the map on a location's served-area bbox. The map is created on the
// hard-coded Zagreb centre. Kept for one-time legacy `loc` links; all newly
// generated empty-project links use their coordinate centre instead.
function centerMapOnLocation(locId) {
    const entry = window.__locationRegistry?.REGISTRY?.[locId];
    if (!entry?.bbox) return;
    const [west, south, east, north] = entry.bbox;
    map.fitBounds([[south, west], [north, east]], { padding: [30, 30] });
}

// Phase-1 guard, run on the FIRST vertex of a new track so no time is spent
// drawing a route that finishCurrentTrack would reject. Returns:
//   'ok'      — first point is in the project's location (or the project is
//               empty and just adopted this one); proceed with the click.
//   'blocked' — the point is outside every prepared location; message shown.
//   'prompt'  — the point is in a DIFFERENT prepared location; a "start a new
//               project here?" dialog was opened, so this click is consumed.
function checkFirstDrawPointLocation(lat, lng) {
    const registry = window.__locationRegistry;
    if (!registry) return 'ok';
    const newLoc = registry.detectByLatLng(lat, lng);
    const projLoc = getProjectLocationId();
    if (newLoc === projLoc) return 'ok';
    if (!newLoc) {
        const supported = registry.ids.map(locationLabel).join(', ');
        setStatusMessage(`Crtanje je podržano samo u pripremljenim lokacijama: ${supported}. Ovo područje još nije pripremljeno.`, true);
        return 'blocked';
    }
    const hasContent = project.tracks.length > 0 || project.stations.length > 0;
    if (!hasContent) {
        adoptDrawingLocation(newLoc);   // empty project: first point sets the location
        refreshReferenceRailMapLayer(); // …and with it, that location's visible reference projects
        return 'ok';
    }
    openDiscardDraftModal(() => startFreshProjectInLocation(newLoc), {
        title: 'Nova lokacija?',
        message: `Ova točka je u lokaciji ${locationLabel(newLoc)}, a vaš projekt je u ${locationLabel(projLoc)}. Želite li započeti novi projekt ovdje? Trenutni projekt bit će uklonjen.`,
        cancelLabel: 'Odustani',
        confirmLabel: `Novi projekt u ${locationLabel(newLoc)}`,
    });
    return 'prompt';
}

async function applyWalk3DLink(options = {}) {
    const {
        lat,
        lon,
        headingDeg = 0,
        pitchDeg = 0,
        proposalIds = null,
    } = options;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new Error('Za 3D šetnju trebate zadati lat i lon.');
    }
    const openGeneration = beginPlanner3DOpenIntent();
    const hasReferenceTramSimulation = deeplinkHasReferenceTramSimulation(lat, lon);
    const [tramSim, station3D] = await Promise.all([
        hasReferenceTramSimulation ? waitForTramSimApi() : Promise.resolve(null),
        waitForStation3D(),
    ]);
    if (!planner3DOpenIntentIsCurrent(openGeneration)) return false;
    // The walk world consumes only track GEOMETRY from the tram sim (via
    // otherTracks); trips are cab-mode territory. whenLightReady covers that
    // without pulling the 5.4 MB schedule into every Zagreb walk open.
    if (hasReferenceTramSimulation && typeof tramSim?.whenLightReady === 'function') {
        await tramSim.whenLightReady();
        if (!planner3DOpenIntentIsCurrent(openGeneration)) return false;
    }
    // Location-agnostic: the options builder reads project.tracks wherever
    // they are. The old Zagreb-only gate handed EMPTY options to a Split
    // deeplink — Google mesh with none of the project drawn.
    const plannerWalkOptions = await preparePlannerWalkOptions(lat, lon);
    // A plan/proposals deeplink may carry DRAWN RAIL (a road-track proposal
    // imported from a transit project): convert it into the same engineered
    // track features a planner ride uses, so the rail formation builds its
    // civil works — the Šibenik plan's bay bridge at its authored height, not
    // a flat tram bed on the anchor plane.
    const proposalRail = await prepareProposalRailWalkOptions(proposalIds, plannerWalkOptions);
    if (!planner3DOpenIntentIsCurrent(openGeneration)) return false;
    station3D.openWalk(lat, lon, {
        ...plannerWalkOptions,
        otherTracks: proposalRail.otherTracks,
        customTrackCorridors: proposalRail.customTrackCorridors,
        initialHeadingDeg: headingDeg,
        initialLookPitchDeg: pitchDeg,
        proposalIds: proposalRail.proposalIds.length > 0 ? proposalRail.proposalIds : proposalIds,
        prefetchedProposals: proposalRail.prefetchedProposals,
    });
    setStatusMessage('Otvorena 3D šetnja na podijeljenoj lokaciji.');
    return true;
}

// Mirrors consensusApiBase() in station-3d/world/proposals.js (that module is
// an ES module inside the sim; this file is the classic-script planner) —
// including the ?consensusApi= dev escape hatches, because a walk boot that
// resolves proposals against a different backend than the overlay would load
// two halves of two different plans.
function consensusApiBaseForWalkLink() {
    const params = new URLSearchParams(window.location.search);
    const override = params.get('consensusApi');
    if (override === 'prod') return 'https://api.urbangametheory.xyz';
    if (override === 'fixture') return '__fixture__';
    const h = (window.location.hostname || '').toLowerCase();
    // A caller-supplied absolute API base is a dev-only escape hatch: honoring it
    // on the public origin would let a crafted link point the planner at an
    // attacker-controlled backend. Restrict it to localhost.
    if (override && /^https?:\/\//.test(override) && ['localhost', '127.0.0.1'].includes(h)) {
        return override.replace(/\/+$/, '');
    }
    if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h.endsWith('.local')) {
        return 'http://localhost:3000';
    }
    return 'https://api.urbangametheory.xyz';
}

// ?plan= pročitan pri UČITAVANJU, ne kasnije iz žive adrese.
//
// Učitavanje projekta prepisuje adresu (history.replaceState preko
// preserveWorldParams), a WORLD_URL_PARAMS ne nosi `plan` — pa ga taj prepis
// izbriše. prepareProposalRailWalkOptions čita adresu tek nakon nekoliko awaita
// (tram/Station3D readiness i priprema opcija šetnje), dakle POSLIJE prepisa, i
// vidi URL bez plana: nijedan zahtjev prema /plans/ ne ode, proposalIds
// ostane prazan i sloj prijedloga nema što nacrtati.
//
// Simptom je bio da ista poveznica radi bez `project=` (bez učitavanja projekta
// nema ni prepisa) a tiho gubi plan čim se doda `project=` — mjereno:
// proposal-overlay 1058 stavki u prvom slučaju, 0 u drugom.
//
// Čita se ovdje, u tijelu modula, koje se izvrši prije ijednog awaita.
const INITIAL_PLAN_PARAM = (() => {
    try { return new URLSearchParams(window.location.search).get('plan'); }
    catch (_) { return null; }
})();

function consensusUrlForWalkLink(path, fixturePath) {
    const base = consensusApiBaseForWalkLink();
    return base === '__fixture__' ? fixturePath : `${base}${path}`;
}

// Resolves ?plan=/?proposals= to records, keeps the rail-track ones, and
// converts them to Station 3D track features (core/proposal-track.js). Every
// failure costs only the rail: the walk itself and the building/park overlay
// (which re-resolves the same ids inside the sim) still open.
// The ?plan=/?proposals= records themselves — plan slug resolved, ids merged,
// every record fetched. Shared by the walk deeplink (which then also converts
// rail proposals into engineered track) and the planner-cab deeplink (which
// only wants the records: its rail is already the project's own line).
async function fetchPlanProposalRecords(explicitProposalIds) {
    const planParam = INITIAL_PLAN_PARAM;
    const [ensPlan] = await Promise.all([
        // Document-relative, like transit.html's own station-3d entry:
        // the app lives at / locally and under /prijevoz/ on production,
        // and a root-absolute path 404s on the latter.
        import('./vendor/station3d/planning.js'),
    ]);
    let planIds = [];
    const planSlug = ensPlan.ensPlanSlug(planParam);
    if (planSlug) {
        const url = consensusUrlForWalkLink(
            `/plans/${encodeURIComponent(planSlug)}`,
            `/dev-proposal-fixtures/plans/${encodeURIComponent(planSlug)}.json`,
        );
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`GET ${url} → ${resp.status}`);
        const plan = await resp.json();
        planIds = Array.isArray(plan?.proposalIds) ? plan.proposalIds : [];
    }
    const ids = ensPlan.mergeProposalIds(explicitProposalIds, planIds);
    if (ids.length === 0) return { proposalIds: [], loaded: [] };
    const records = await Promise.all(ids.map(async (id) => {
        const url = consensusUrlForWalkLink(
            `/proposals/${encodeURIComponent(id)}`,
            `/dev-proposal-fixtures/${encodeURIComponent(id)}.json`,
        );
        try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return { id: String(id), record: await resp.json() };
        } catch (error) {
            console.warn(`[walk-link] proposal ${id} failed to load:`, error?.message || error);
            return null;
        }
    }));
    return { proposalIds: ids, loaded: records.filter(Boolean) };
}

async function prepareProposalRailWalkOptions(explicitProposalIds, baseTrackOptions = {}) {
    const baseOtherTracks = Array.isArray(baseTrackOptions.otherTracks)
        ? baseTrackOptions.otherTracks : [];
    const baseCustomTrackCorridors = Array.isArray(baseTrackOptions.customTrackCorridors)
        ? baseTrackOptions.customTrackCorridors : [];
    const empty = {
        trackFeatures: [],
        otherTracks: baseOtherTracks,
        customTrackCorridors: baseCustomTrackCorridors,
        prefetchedProposals: null,
        proposalIds: [],
    };
    try {
        const proposalTrack = await import('./vendor/station3d/planning.js');
        const { proposalIds: ids, loaded } = await fetchPlanProposalRecords(explicitProposalIds);
        if (ids.length === 0) return empty;
        const trackFeatures = [];
        for (const { id, record } of loaded) {
            const roadPlan = record?.geometry?.roadPlan || record?.roadProposal?.definition;
            if (roadPlan?.metadata?.isTrack !== true) continue;
            try {
                const builtFeatures = proposalTrack.buildProposalTrackFeatures(roadPlan, id, {
                    railPhysicalId: proposalTrack.transitProposalTrackPhysicalId(record),
                });
                trackFeatures.push(...builtFeatures.map((feature) => {
                    const latlngs = (feature?.geometry?.coordinates || []).map(
                        coordinate => [Number(coordinate?.[1]), Number(coordinate?.[0])],
                    );
                    const railSourceGeometryHash = latlngs.length >= 2
                        ? window.__verticalProfile.trackGeometryHash(
                            latlngs,
                            feature.properties.trackType,
                            VERTICAL_PROFILE_INPUT_REVISION,
                        )
                        : null;
                    return railSourceGeometryHash ? {
                        ...feature,
                        properties: {
                            ...feature.properties,
                            railSourceGeometryHash,
                        },
                    } : feature;
                }));
            } catch (error) {
                console.error(`[walk-link] track proposal ${id} rejected:`, error?.message || error);
            }
        }
        if (trackFeatures.length > 0) {
            const totalPoints = trackFeatures.reduce((n, f) => n + f.geometry.coordinates.length, 0);
            console.log(`[walk-link] proposal rail: features=${trackFeatures.length} `
                + `points=${totalPoints} mode=${trackFeatures[0]?.properties?.elevationMode}`);
        }
        return {
            trackFeatures,
            otherTracks: proposalTrack.mergeProposalTrackFeatures(
                baseOtherTracks,
                trackFeatures,
            ),
            customTrackCorridors: proposalTrack.mergeProposalTrackFeatures(
                baseCustomTrackCorridors,
                trackFeatures,
            ),
            prefetchedProposals: loaded,
            proposalIds: ids,
        };
    } catch (error) {
        console.error('[walk-link] proposal rail preparation failed:', error?.message || error);
        return empty;
    }
}

async function applySharedTram3DLink(options = {}) {
    const {
        line = null,
        stop = null,
        station = null,
        shape = null,
        offset = 0,
        direction = 0,
        pitch = 0,
    } = options;
    await Promise.all([ensureRailStationsVisible(), ensureTramStopsVisible()]);
    const tramSim = await waitForTramSimApi();
    if (typeof tramSim.whenReady === 'function') {
        await tramSim.whenReady();
    }
    await waitForStation3D();
    if (typeof tramSim.openCabFromSharedPosition !== 'function') {
        throw new Error('Ova verzija tramvajske mreže ne podržava dijeljenje 3D vožnje.');
    }
    const selection = tramSim.openCabFromSharedPosition({
        line,
        stop,
        station,
        shape,
        offset,
        direction,
        pitch,
        panToMarker: true,
        minZoom: 15,
    });
    const routeLabel = escapeHtml(selection.trip.routeName || '?');
    const startLabel = escapeHtml(selection.startStop?.name || station || stop || '?');
    const goalLabel = escapeHtml(selection.goalStop?.name || '?');
    setStatusMessage(`Otvorena podijeljena 3D vožnja: ${routeLabel}, od ${startLabel} prema ${goalLabel}.`);
}

async function toggleHeatmap(field) {
    if (activeHeatmapField === field) {
        clearHeatmapLayer();
        closeSidebarOnMobile();
        updateStatus();
        return;
    }

    closeSidebarOnMobile();
    showMapLoader('Učitavanje...');
    try {
        await loadHeatmap(field);
    } catch (error) {
        console.error('Heatmap load error:', error);
    } finally {
        hideMapLoader();
    }
}

togglePopulationHeatmapBtn.onclick = () => toggleHeatmap('residents');
toggleJobsHeatmapBtn.onclick = () => toggleHeatmap('jobs');
toggleRailStationsBtn.onchange = () => { closeSidebarOnMobile(); toggleRailStations(); };
if (toggleReferenceRailProjectsBtn) {
    toggleReferenceRailProjectsBtn.onchange = () => {
        closeSidebarOnMobile();
        toggleReferenceRailProjects();
    };
}
toggleTramStopsBtn.onchange = () => { closeSidebarOnMobile(); toggleTramStops(); };
if (toggleTerrainMapInput) {
    toggleTerrainMapInput.onchange = () => {
        closeSidebarOnMobile();
        setTerrainMapVisible(toggleTerrainMapInput.checked);
    };
}
if (toggleStationDistancesInput) {
    toggleStationDistancesInput.onchange = () => {
        if (currentMode !== 'drawLine') {
            syncAllCommittedStationDistanceLabels();
        }
    };
}
if (toggleDemandLabelsInput) {
    // Hide the whole toggle where there's no passenger demand to show (Split):
    // a dead "numbers above stations" switch would just confuse.
    if (!locationHasPassengerDemand()) {
        const row = toggleDemandLabelsInput.closest('.compact-toggle');
        if (row) row.style.display = 'none';
    }
    toggleDemandLabelsInput.onchange = () => {
        if (!toggleDemandLabelsInput.checked) clearDemandLabels();
    };
}
// Walk-time changes also auto-close sidebar so the catchment is visible
walkTimeOptions.forEach(radio => {
    radio.addEventListener('change', () => closeSidebarOnMobile());
});
updateHeatmapButtons();
updateRailStationsButton();
updateTramStopsButton();
updateTerrainMapButton();


function getCurveViolationVertexIndices(violations) {
    return [...new Set((violations || []).flatMap(violation => violation.vertexIndices || []))]
        .filter(index => Number.isInteger(index));
}

function createTrackCurveWarningMarkers(gauge, latlngs, violations, { flashing = false } = {}) {
    // Only the flagged corners are labelled, so only their turns are needed —
    // this runs on every frame of a drag that is currently in violation.
    const flagged = getCurveViolationVertexIndices(violations);
    const plan = buildTrackCurvePlan(latlngs, gauge, flagged.length > 0
        ? { fromVertex: Math.min(...flagged) - 1, toVertex: Math.max(...flagged) + 1 }
        : { fromVertex: 0, toVertex: 0 });
    return flagged
        .filter(index => index > 0 && index < latlngs.length - 1)
        .map(index => {
            const angleDeg = plan.turns[index]?.angleDeg;
            const angleLabel = Number.isFinite(angleDeg) ? ` · ${Math.round(angleDeg)}°` : '';
            return L.marker(latlngs[index], {
                interactive: false,
                keyboard: false,
                zIndexOffset: 1600,
                icon: L.divIcon({
                    className: `curve-angle-warning${flashing ? ' is-flashing' : ''}`,
                    html: '<span aria-hidden="true">∠</span>',
                    iconSize: [28, 28],
                    iconAnchor: [14, 14],
                }),
            }).bindTooltip(`Preoštar zavoj${angleLabel}`, {
                permanent: true,
                direction: 'top',
                offset: [0, -15],
                className: 'curve-angle-warning-tooltip',
            });
        });
}


function getStationSegmentAnchor(station, latlngs) {
    let bestSegment = 0;
    let bestT = 0;
    let bestDistSq = Infinity;
    for (let i = 0; i < latlngs.length - 1; i++) {
        const a = latlngs[i], b = latlngs[i + 1];
        const p = nearestPointOnSegment(station.latlng[1], station.latlng[0], a[1], a[0], b[1], b[0]);
        if (p.distSq < bestDistSq) {
            const dx = b[1] - a[1], dy = b[0] - a[0];
            const lenSq = dx * dx + dy * dy;
            bestT = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.lon - a[1]) * dx + (p.lat - a[0]) * dy) / lenSq));
            bestSegment = i;
            bestDistSq = p.distSq;
        }
    }
    return { segmentIndex: bestSegment, t: bestT };
}

function interpolateSegmentPosition(latlngs, segmentIndex, t) {
    const idx = Math.min(segmentIndex, latlngs.length - 2);
    const a = latlngs[idx], b = latlngs[idx + 1];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}


let trackProblemFlashLayer = null;
let trackProblemFlashTimers = [];

function clearTrackProblemFlash() {
    for (const timer of trackProblemFlashTimers) clearTimeout(timer);
    trackProblemFlashTimers = [];
    if (trackProblemFlashLayer) {
        map.removeLayer(trackProblemFlashLayer);
        trackProblemFlashLayer = null;
    }
}

function flashTrackSegments(track, segmentIndices, { gauge = null, curveViolations = [] } = {}) {
    clearTrackProblemFlash();
    const indices = [...new Set(segmentIndices || [])]
        .filter(i => i >= 0 && i < track.latlngs.length - 1);
    if (indices.length === 0) return;
    const layers = [];
    for (const segmentIndex of indices) {
        const latlngs = [track.latlngs[segmentIndex], track.latlngs[segmentIndex + 1]];
        layers.push(L.polyline(latlngs, {
            pane: TRACK_LEVEL_PANE,
            color: '#fff7ed',
            weight: 15,
            opacity: 0.96,
            lineCap: 'round',
            interactive: false,
        }));
        layers.push(L.polyline(latlngs, {
            pane: TRACK_LEVEL_PANE,
            color: '#dc2626',
            weight: 9,
            opacity: 1,
            lineCap: 'round',
            interactive: false,
        }));
    }
    if (gauge && curveViolations.length > 0) {
        layers.push(...createTrackCurveWarningMarkers(
            gauge,
            track.latlngs,
            curveViolations,
            { flashing: true },
        ));
    }
    const group = L.featureGroup(layers).addTo(map);
    trackProblemFlashLayer = group;
    for (let phase = 1; phase <= 6; phase++) {
        trackProblemFlashTimers.push(setTimeout(() => {
            if (trackProblemFlashLayer !== group) return;
            group.setStyle({ opacity: phase % 2 === 0 ? 1 : 0.08 });
        }, phase * 180));
    }
    trackProblemFlashTimers.push(setTimeout(() => {
        if (trackProblemFlashLayer === group) clearTrackProblemFlash();
    }, 7 * 180));
}


const TRACK_LEVEL_FULL_EPSILON = 1e-4;

function isFullTrackLevel(level) {
    const value = Number(level) || 0;
    return Math.abs(value - Math.round(value)) <= TRACK_LEVEL_FULL_EPSILON;
}


function buildTrackChainage(track) {
    const offsets = [0];
    for (let index = 0; index < track.latlngs.length - 1; index++) {
        offsets.push(offsets[index] + distanceMetersLatLng(
            track.latlngs[index][0],
            track.latlngs[index][1],
            track.latlngs[index + 1][0],
            track.latlngs[index + 1][1],
        ));
    }
    return { offsets, totalM: offsets[offsets.length - 1] || 0 };
}

function pointAtTrackOffset(track, chainage, requestedOffsetM) {
    const offsetM = Math.max(0, Math.min(chainage.totalM, requestedOffsetM));
    let segmentIndex = 0;
    while (segmentIndex < chainage.offsets.length - 2
        && chainage.offsets[segmentIndex + 1] < offsetM - 1e-6) segmentIndex++;
    const startM = chainage.offsets[segmentIndex];
    const endM = chainage.offsets[segmentIndex + 1];
    const t = endM > startM ? (offsetM - startM) / (endM - startM) : 0;
    return interpolateSegmentPosition(track.latlngs, segmentIndex, t);
}

function getStationTrackOffsetM(track, station, chainage) {
    const anchor = getStationSegmentAnchor(station, track.latlngs);
    const startM = chainage.offsets[anchor.segmentIndex] || 0;
    const endM = chainage.offsets[anchor.segmentIndex + 1] ?? startM;
    return startM + (endM - startM) * anchor.t;
}

function getStationOrderOffsetBounds(track, station, chainage = buildTrackChainage(track)) {
    const ordered = project.stations
        .filter(candidate => candidate.trackId === track.id)
        .map(candidate => ({
            station: candidate,
            offsetM: getStationTrackOffsetM(track, candidate, chainage),
        }))
        .sort((left, right) => left.offsetM - right.offsetM || left.station.id - right.station.id);
    const index = ordered.findIndex(entry => entry.station === station);
    if (index < 0) return { minOffsetM: 0, maxOffsetM: chainage.totalM };
    const previousOffsetM = index > 0 ? ordered[index - 1].offsetM : -Infinity;
    const nextOffsetM = index < ordered.length - 1 ? ordered[index + 1].offsetM : Infinity;
    // The station's own structure has to stay on the route, so the drag stops
    // half a station short of each end rather than sliding off and having its
    // span clamped into a half-length platform. Clamping the DRAG is friendlier
    // than refusing the drop: the marker simply will not go further.
    const halfSpanM = Math.min(
        stationProfileHalfSpanM(station),
        Math.max(0, chainage.totalM / 2),
    );
    let minOffsetM = Number.isFinite(previousOffsetM)
        ? previousOffsetM + STATION_ORDER_GAP_M
        : halfSpanM;
    let maxOffsetM = Number.isFinite(nextOffsetM)
        ? nextOffsetM - STATION_ORDER_GAP_M
        : chainage.totalM - halfSpanM;
    minOffsetM = Math.max(minOffsetM, halfSpanM);
    maxOffsetM = Math.min(maxOffsetM, chainage.totalM - halfSpanM);
    if (minOffsetM > maxOffsetM) {
        const midpointM = Math.max(0, Math.min(chainage.totalM, (minOffsetM + maxOffsetM) / 2));
        minOffsetM = midpointM;
        maxOffsetM = midpointM;
    }
    return { minOffsetM, maxOffsetM };
}

function setStationMapPosition(station, latlng) {
    const prev = station.latlng;
    const next = [latlng[0], latlng[1]];
    station.latlng = next;
    if (station.markerLayer) station.markerLayer.setLatLng(next);
    const demandLabel = demandLabelLayers.get(station.id);
    if (demandLabel) demandLabel.setLatLng(next);
    for (const link of project.transferLinks) {
        if ((link.stationIdA !== station.id && link.stationIdB !== station.id) || !link.layer) continue;
        const otherId = link.stationIdA === station.id ? link.stationIdB : link.stationIdA;
        const other = _stationById.get(otherId);
        if (other) link.layer.setLatLngs([next, other.latlng]);
    }
    // Re-derive an auto-named station's label from the nearest road after a
    // move. This runs on every drag frame (route-edit drags call through here
    // continuously), so debounce: only the settled position — a real move, not
    // a jitter — triggers a single roads lookup. Skipped for manual/depot names.
    if (station.autoNamed !== false && station.stationType !== 'depot'
        && (!prev || distanceMetersLatLng(prev[0], prev[1], next[0], next[1]) > 1)) {
        clearTimeout(station._autoNameTimer);
        const requestId = (station._autoNameRequestId || 0) + 1;
        station._autoNameRequestId = requestId;
        station._autoNameTimer = setTimeout(() => { applyAutoStationName(station, requestId); }, 400);
    }
    const profileTrack = project.tracks.find((track) => track.id === station.trackId);
    if (profileTrack) {
        scheduleTrackVerticalProfile(profileTrack);
        // The station's 60/170 m envelope is drawn along the route, so it has to
        // travel with the marker — otherwise the platform appears to detach from
        // the station being dragged. Neutral-coloured while moving; the real
        // alignment colour lands with the settled re-solve.
        rebuildStationEnvelopes(profileTrack, { live: true });
    }
}


// Pre-node-topology saves can encode a raised/buried section as one isolated
// ±1 vertex between surface vertices. Expand those triangles during project
// hydration using the same one-new-endpoint + 50 m platform geometry as a new
// level edit. The original vertex remains one platform endpoint, so saved
// station positions and line paths stay stable. Geometry without enough room
// is left untouched.
function materializeLegacyIsolatedLevelPoints(latlngs, levels, gauge) {
    const points = (latlngs || []).map(point => [point[0], point[1]]);
    const normalizedLevels = Array.isArray(levels) && levels.length === points.length
        ? levels.map(normalizeTrackElevationLevel)
        : points.map(() => 0);
    const pointToward = (fromIndex, toIndex, distanceM) => {
        const from = points[fromIndex];
        const to = points[toIndex];
        const lengthM = distanceMetersLatLng(from[0], from[1], to[0], to[1]);
        // Leave a small positive span to the existing neighbour; inserting a
        // duplicate boundary vertex would create a zero-length segment.
        if (lengthM <= 0 || distanceM >= lengthM - 0.05) return null;
        const t = distanceM / lengthM;
        return [
            from[0] + (to[0] - from[0]) * t,
            from[1] + (to[1] - from[1]) * t,
        ];
    };
    const rampLengthM = getMinLevelChangeMeters(gauge);
    const endpointReachM = rampLengthM + TRACK_MIN_FULL_LEVEL_LENGTH_M;
    let expandedCount = 0;

    for (let index = 0; index < normalizedLevels.length;) {
        const level = normalizedLevels[index] ?? 0;
        const previousLevel = index > 0 ? (normalizedLevels[index - 1] ?? 0) : 0;
        const nextLevel = index < normalizedLevels.length - 1 ? (normalizedLevels[index + 1] ?? 0) : 0;
        if (level === 0 || previousLevel !== 0 || nextLevel !== 0) {
            index++;
            continue;
        }

        const originalPoint = [points[index][0], points[index][1]];
        let replacementPoints = null;
        let replacementLevels = null;
        if (index === 0 && points.length >= 2) {
            const platformBoundary = pointToward(0, 1, TRACK_MIN_FULL_LEVEL_LENGTH_M);
            const neighbourDistanceM = distanceMetersLatLng(...points[0], ...points[1]);
            if (platformBoundary && neighbourDistanceM + 0.05 >= endpointReachM) {
                replacementPoints = [originalPoint, platformBoundary];
                replacementLevels = [level, level];
            }
        } else if (index === points.length - 1 && points.length >= 2) {
            const platformBoundary = pointToward(index, index - 1, TRACK_MIN_FULL_LEVEL_LENGTH_M);
            const neighbourDistanceM = distanceMetersLatLng(...points[index], ...points[index - 1]);
            if (platformBoundary && neighbourDistanceM + 0.05 >= endpointReachM) {
                replacementPoints = [platformBoundary, originalPoint];
                replacementLevels = [level, level];
            }
        } else if (index > 0 && index < points.length - 1) {
            const leftDistanceM = distanceMetersLatLng(...points[index], ...points[index - 1]);
            const rightDistanceM = distanceMetersLatLng(...points[index], ...points[index + 1]);
            const canExtendRight = leftDistanceM + 0.05 >= rampLengthM
                && rightDistanceM + 0.05 >= endpointReachM;
            const canExtendLeft = rightDistanceM + 0.05 >= rampLengthM
                && leftDistanceM + 0.05 >= endpointReachM;
            if (canExtendRight) {
                const platformBoundary = pointToward(index, index + 1, TRACK_MIN_FULL_LEVEL_LENGTH_M);
                if (platformBoundary) {
                    replacementPoints = [originalPoint, platformBoundary];
                    replacementLevels = [level, level];
                }
            } else if (canExtendLeft) {
                const platformBoundary = pointToward(index, index - 1, TRACK_MIN_FULL_LEVEL_LENGTH_M);
                if (platformBoundary) {
                    replacementPoints = [platformBoundary, originalPoint];
                    replacementLevels = [level, level];
                }
            }
        }
        if (!replacementPoints) {
            index++;
            continue;
        }
        points.splice(index, 1, ...replacementPoints);
        normalizedLevels.splice(index, 1, ...replacementLevels);
        expandedCount++;
        index += replacementPoints.length;
    }
    return { latlngs: points, levels: normalizedLevels, expandedCount };
}

// One post-change pipeline for every committed track-geometry change (vertex
// drag/insert/removal, level edits, extensions): recomputes length, cost,
// decor, motion profiles, dependent line paths/stops, station levels, the
// sidebar list, and project totals. Pass refetchCatchments whenever stations
// may have moved horizontally — their cached catchments are position-bound.
function afterTrackGeometryChange(track, { refetchCatchments = false } = {}) {
    invalidateTrackHashMemo(track);   // the geometry the memo describes just changed
    if (track.layer) track.layer.setLatLngs(track.latlngs);
    if (track.hitLayer) track.hitLayer.setLatLngs(track.latlngs);
    const lineGeoJSON = turf.lineString(track.latlngs.map(point => [point[1], point[0]]));
    track.lengthKm = turf.length(lineGeoJSON, { units: 'kilometers' });
    track.cost = computeTrackConstructionCost(track);
    rebuildTrackDecor(track);
    rebuildAffectedMotionProfiles(track);
    syncLineLayersForTrack(track);
    for (const line of project.lines) {
        if (!lineUsesTrack(line, track.id)) continue;
        if (line.stationIds && line.stationIds.length >= 2) updateLineStationStopsFromIds(line);
        else updateLineStationStops(line);
    }
    refreshTrackStationLevels(track);
    scheduleTrackVerticalProfile(track);
    updateTracksListUI();
    updateProjectSummary();
    refreshRouteEditHandles();
    // Geometry rules are warnings, not refusals — so whatever is still broken
    // has to stay visible on the map after every committed edit.
    scheduleTrackProblemOutlines();
    if (selectedObject?.type === 'track' && selectedObject.ref === track) renderSelectionSheet();
    if (refetchCatchments) refreshTrackStationCatchments(track);
}

// Refetches the walk catchment of every station on the track. Guarded by a
// per-station token: overlapping runs (quick successive drags, a station drag
// racing a vertex drag) would otherwise interleave writes and leave replaced
// catchment layers orphaned on the map.
async function refreshTrackStationCatchments(track) {
    const trackStations = project.stations.filter(s => s.trackId === track.id);
    for (const station of trackStations) {
        station._catchmentRefreshId = (station._catchmentRefreshId || 0) + 1;
        if (station.catchmentLayer) {
            map.removeLayer(station.catchmentLayer);
            station.catchmentLayer = null;
        }
    }
    const tokens = new Map(trackStations.map(s => [s, s._catchmentRefreshId]));
    for (const station of trackStations) {
        try {
            const data = station.walkMinutes > 0
                ? await fetchCachedStationCatchment(station.latlng[0], station.latlng[1], station.walkMinutes)
                : { catchmentPolygon: null, catchmentPopulation: 0, catchmentJobs: 0 };
            if (station._catchmentRefreshId !== tokens.get(station)) continue;
            station.catchmentPolygon = data.catchmentPolygon;
            station.catchmentPopulation = data.catchmentPopulation;
            station.catchmentJobs = data.catchmentJobs;
            station.catchmentLayer = createStationCatchmentLayer(data.catchmentPolygon);
        } catch (err) {
            if (station._catchmentRefreshId !== tokens.get(station)) continue;
            station.catchmentPolygon = null;
            station.catchmentPopulation = 0;
            station.catchmentJobs = 0;
        }
    }
    updateProjectSummary();
}


// Vertex level changes can move stations to another level: refresh their cost,
// marker class, and dependent transfer link types/prices.
function refreshTrackStationLevels(track) {
    for (const station of project.stations) {
        if (station.trackId !== track.id) continue;
        const level = getStationLevel(station);
        station.cost = computeStationConstructionCost(
            station.stationType, track.gauge, getStationStructureKind(track, station),
        );
        if (station.markerLayer) {
            const icon = L.divIcon({
                className: getStationMarkerClass(track.gauge, station.stationType, level),
                iconSize: [16, 16], iconAnchor: [8, 8],
            });
            station.markerLayer.setIcon(icon);
            refreshStationMarkerPresentation(station);
            updateStationLinkIndicator(station);
        }
    }
    recomputeTransferLinkCosts();
    if (currentMode === 'edit') syncExclusiveEditInteractivity();
}


function deleteTrack(trackId) {
    if (rejectProjectMutation()) return;
    const idx = project.tracks.findIndex(t => t.id === trackId);
    if (idx === -1) return;
    const track = project.tracks[idx];

    // Block deletion if any line depends on this track
    const affectedLines = project.lines.filter(l => lineUsesTrack(l, trackId));
    if (affectedLines.length > 0) {
        const lineNames = affectedLines.map(l => `Linija ${l.number}`).join(', ');
        setStatusMessage(
            `Nije moguće obrisati trasu — koristi je ${lineNames}. Uklonite liniju prije brisanja trase.`,
            true,
            { label: affectedLines.length > 1 ? 'Prikaži linije →' : 'Prikaži liniju →', onClick: () => revealLineInSidebar(affectedLines[0].id) }
        );
        return;
    }

    // Deselect if this track is selected
    if (selectedObject && selectedObject.type === 'track' && selectedObject.id === trackId) {
        deselectObject();
    }

    // Remove track map layers
    if (track.hitLayer) map.removeLayer(track.hitLayer);
    if (track.layer) map.removeLayer(track.layer);
    if (track.decorGroup) map.removeLayer(track.decorGroup);
    if (track.stationEnvelopeGroup) map.removeLayer(track.stationEnvelopeGroup);

    // Remove stations on this track
    const removedStationIds = new Set();
    project.stations = project.stations.filter(s => {
        if (s.trackId === trackId) {
            if (selectedObject && selectedObject.type === 'station' && selectedObject.id === s.id) {
                deselectObject();
            }
            if (s.catchmentLayer) map.removeLayer(s.catchmentLayer);
            if (s.markerLayer) map.removeLayer(s.markerLayer);
            const dl = demandLabelLayers.get(s.id);
            if (dl) { map.removeLayer(dl); demandLabelLayers.delete(s.id); }
            removedStationIds.add(s.id);
            return false;
        }
        return true;
    });
    for (const stId of removedStationIds) {
        removeTransferLinksForStation(stId);
    }
    rebuildStationIndex();

    project.tracks.splice(idx, 1);
    removeStationPicker();

    updateTracksListUI();
    updateProjectSummary();
}

// ─── Object Selection ────────────────────────────────────────────────────────

// Returns a useful focus coordinate for linked objects and train/station pans.
function getObjectCentroid(type, ref) {
    if (type === 'station') return L.latLng(ref.latlng[0], ref.latlng[1]);
    if (type === 'track') {
        const mid = Math.floor(ref.latlngs.length / 2);
        return L.latLng(ref.latlngs[mid][0], ref.latlngs[mid][1]);
    }
    if (type === 'line') {
        const t = getTrackForLine(ref);
        if (t) { const mid = Math.floor(t.latlngs.length / 2); return L.latLng(t.latlngs[mid][0], t.latlngs[mid][1]); }
    }
    if (type === 'train' && ref.train?.marker) return ref.train.marker.getLatLng();
    if (type === 'transferLink') {
        const stA = _stationById.get(ref.stationIdA);
        const stB = _stationById.get(ref.stationIdB);
        if (stA && stB) return L.latLng((stA.latlng[0] + stB.latlng[0]) / 2, (stA.latlng[1] + stB.latlng[1]) / 2);
    }
    return map.getCenter();
}

const TRACK_ELECTRIFICATION_EDITOR_STYLES = Object.freeze({
    overhead: Object.freeze({ color: '#facc15', dashArray: null }),
    'conductor-rail': Object.freeze({ color: '#f59e0b', dashArray: '10 5' }),
    none: Object.freeze({ color: '#64748b', dashArray: null }),
    unknown: Object.freeze({ color: '#991b1b', dashArray: '7 6' }),
});

function isTrackElectrificationEditorActive(track) {
    return !!trackElectrificationEditor && trackElectrificationEditor.track === track;
}

function clearTrackElectrificationEditorLayers() {
    if (!trackElectrificationEditor) return;
    for (const layer of trackElectrificationEditor.layers || []) {
        if (map.hasLayer(layer)) map.removeLayer(layer);
    }
    trackElectrificationEditor.layers = [];
}

function stopTrackElectrificationEditor({ rerender = true } = {}) {
    if (!trackElectrificationEditor) return;
    clearTrackElectrificationEditorLayers();
    trackElectrificationEditor = null;
    mapContainer.classList.remove('track-electrification-edit-mode');
    if (rerender && selectedObject?.type === 'track') renderSelectionSheet();
}

function trackElectrificationSummary(track) {
    return window.__trackElectrification.summarizeElectrificationSegments(
        track?.electrificationSegments,
        Number(track?.lengthKm) * 1000,
        track || {},
    );
}

function formatTrackElectrificationLength(lengthM) {
    const km = Math.max(0, Number(lengthM) || 0) / 1000;
    return `${km < 10 ? km.toFixed(2) : km.toFixed(1)} km`;
}

function trackElectrificationSummaryLabel(track) {
    const summary = trackElectrificationSummary(track);
    if (summary.status === 'overhead') {
        return `Kontaktni vod · ${formatTrackElectrificationLength(summary.totalM)}`;
    }
    if (summary.status === 'conductor-rail') {
        return `Treća tračnica · ${formatTrackElectrificationLength(summary.totalM)}`;
    }
    if (summary.status === 'none') return 'Nije elektrificirana';
    if (summary.status === 'unknown') return 'Nepoznato';
    return `${formatTrackElectrificationLength(summary.electrifiedM)} od `
        + `${formatTrackElectrificationLength(summary.totalM)} elektrificirano`;
}

function trackElectrificationSourceLabel(track) {
    const sources = [...new Set((track?.electrificationSegments || [])
        .map(segment => String(segment?.source || '').trim())
        .filter(Boolean))];
    if (sources.length > 1) return 'Mješoviti izvori';
    if (CITY_CONFIG.sourceLabels?.[sources[0]]) return CITY_CONFIG.sourceLabels[sources[0]];
    if (sources[0] === 'osm') return 'OSM';
    if (sources[0] === 'authored') return 'Autorski podatak';
    if (sources[0] === 'unknown') return 'Nepoznato';
    if (sources.length === 1) return sources[0];
    const api = window.__trackElectrification;
    const resolved = api.resolve(track, {
        trackMode: api.trackModeFor(track),
        networkDefault: CITY_CONFIG.trackDefaults?.[api.trackModeFor(track)],
        provenance: 'authored',
    });
    return api.provenanceLabelHr(resolved.provenance);
}

function applyTrackElectrificationRange(track, fromM, toM) {
    if (!isTrackElectrificationEditorActive(track)) return;
    const api = window.__trackElectrification;
    const fields = api.fieldsForAuthoredChoice(trackElectrificationEditor.choice);
    track.electrificationSegments = api.applyElectrificationRange(
        track.electrificationSegments,
        fromM,
        toM,
        fields,
        Number(track.lengthKm) * 1000,
        track,
    );
    // Once one node-to-node range is authored, the complete partition above is
    // authoritative. Keeping a second whole-track value would be ambiguous.
    track.electrified = null;
    track.voltage = null;
    track.frequency = null;
    trackElectrificationEditor.rangeStartIndex = null;
    rebuildTrackElectrificationEditorLayers();
    markProjectDirty();
    renderSelectionSheet();
    setStatusMessage(
        `Elektrifikacija dionice ${formatTrackElectrificationLength(Math.abs(toM - fromM))} je ažurirana. `
        + (savedProjectId
            ? 'Spremite projekt kao novu verziju.'
            : 'Spremite projekt.'),
    );
}

function handleTrackElectrificationNodeClick(track, nodeIndex) {
    if (!isTrackElectrificationEditorActive(track)) return;
    const startIndex = trackElectrificationEditor.rangeStartIndex;
    if (!Number.isInteger(startIndex)) {
        trackElectrificationEditor.rangeStartIndex = nodeIndex;
        rebuildTrackElectrificationEditorLayers();
        renderSelectionSheet();
        setStatusMessage(`Početni čvor ${nodeIndex + 1} odabran — kliknite završni čvor raspona.`);
        return;
    }
    if (startIndex === nodeIndex) {
        trackElectrificationEditor.rangeStartIndex = null;
        rebuildTrackElectrificationEditorLayers();
        renderSelectionSheet();
        setStatusMessage('Odabir raspona je poništen.');
        return;
    }
    const chainages = trackVertexChainages(track);
    applyTrackElectrificationRange(track, chainages[startIndex], chainages[nodeIndex]);
}

function rebuildTrackElectrificationEditorLayers() {
    if (!trackElectrificationEditor) return;
    clearTrackElectrificationEditorLayers();
    const track = trackElectrificationEditor.track;
    if (!track || !project.tracks.includes(track)) {
        stopTrackElectrificationEditor({ rerender: false });
        return;
    }
    const api = window.__trackElectrification;
    const chainages = trackVertexChainages(track);
    const layers = [];
    for (let index = 0; index < track.latlngs.length - 1; index++) {
        const midpointM = (chainages[index] + chainages[index + 1]) / 2;
        const resolved = api.resolveAtDistance(track, midpointM, {
            trackMode: api.trackModeFor(track),
            networkDefault: CITY_CONFIG.trackDefaults?.[api.trackModeFor(track)],
            provenance: 'authored',
        });
        const style = TRACK_ELECTRIFICATION_EDITOR_STYLES[resolved.status]
            || TRACK_ELECTRIFICATION_EDITOR_STYLES.unknown;
        const latlngs = [track.latlngs[index], track.latlngs[index + 1]];
        const halo = L.polyline(latlngs, {
            color: '#ffffff',
            weight: 15,
            opacity: 0.88,
            lineCap: 'round',
            interactive: false,
            className: 'track-electrification-segment-halo',
        }).addTo(map);
        const segment = L.polyline(latlngs, {
            color: style.color,
            weight: 10,
            opacity: 1,
            dashArray: style.dashArray,
            lineCap: 'round',
            interactive: true,
            bubblingMouseEvents: false,
            className: 'track-electrification-segment',
        }).addTo(map);
        segment.bindTooltip(
            `${api.statusLabelHr(resolved.status)} · `
            + `${formatTrackElectrificationLength(chainages[index + 1] - chainages[index])}`,
            { sticky: true },
        );
        segment.on('click', event => {
            L.DomEvent.stopPropagation(event);
            applyTrackElectrificationRange(track, chainages[index], chainages[index + 1]);
        });
        layers.push(halo, segment);
    }
    track.latlngs.forEach((latlng, nodeIndex) => {
        const selected = trackElectrificationEditor.rangeStartIndex === nodeIndex;
        const marker = L.circleMarker(latlng, {
            radius: selected ? 8 : 6,
            color: selected ? '#1d4ed8' : '#0f172a',
            weight: selected ? 4 : 2,
            fillColor: selected ? '#dbeafe' : '#ffffff',
            fillOpacity: 1,
            opacity: 1,
            interactive: true,
            bubblingMouseEvents: false,
            className: `track-electrification-node${selected ? ' is-range-start' : ''}`,
        }).addTo(map);
        marker.bindTooltip(`Čvor ${nodeIndex + 1}`, { direction: 'top' });
        marker.on('click', event => {
            L.DomEvent.stopPropagation(event);
            handleTrackElectrificationNodeClick(track, nodeIndex);
        });
        layers.push(marker);
    });
    trackElectrificationEditor.layers = layers;
}

function startTrackElectrificationEditor(track) {
    if (!track || selectedObject?.type !== 'track' || selectedObject.ref !== track) return;
    stopTrackElectrificationEditor({ rerender: false });
    trackElectrificationEditor = {
        track,
        choice: 'contact_line',
        rangeStartIndex: null,
        layers: [],
    };
    mapContainer.classList.add('track-electrification-edit-mode');
    selectionSheetCollapsed = false;
    rebuildTrackElectrificationEditorLayers();
    renderSelectionSheet();
    setStatusMessage(
        'Elektrifikacija: odaberite stanje pa kliknite dionicu, ili dva čvora za cijeli raspon.',
    );
}

// Builds the inner HTML for the shared selection bottom sheet.
function buildSelectionHTML(type, ref) {
    let titleText, isEditable, detailsHTML, showDelete, extraActionsHTML = '', trailingActionsHTML = '';

    if (type === 'track') {
        const track = ref;
        titleText = `Trasa ${track.id}`;
        isEditable = false;
        const typeName = GAUGES[normalizeGauge(track.gauge)].label;
        const stationCount = project.stations.filter(s => s.trackId === track.id).length;
        const linesOnTrack = project.lines.filter(l => lineUsesTrack(l, track.id));
        const linesLabel = linesOnTrack.length > 0
            ? linesOnTrack.map(l => `<span class="sel-link" data-link-type="line" data-link-id="${l.id}">Linija ${l.number || l.id}</span>`).join(', ')
            : 'Nema linija';
        // Elevation is the auto-grade now (shown as "Visinski profil" below and
        const electrificationEditorActive = isTrackElectrificationEditorActive(track);
        const editorChoice = trackElectrificationEditor?.choice || 'contact_line';
        const rangeStartIndex = trackElectrificationEditor?.rangeStartIndex;
        const electrificationEditorHTML = electrificationEditorActive
            ? `<div class="track-electrification-editor">
                <div class="track-electrification-editor-hint">Odaberite stanje pa kliknite dionicu. Za dulji raspon kliknite početni i završni čvor.</div>
                <div class="track-electrification-choices" role="group" aria-label="Stanje elektrifikacije dionice">
                    <button type="button" data-electrification-choice="contact_line" class="${editorChoice === 'contact_line' ? 'active' : ''}">Kontaktni vod</button>
                    <button type="button" data-electrification-choice="no" class="${editorChoice === 'no' ? 'active' : ''}">Bez elektrifikacije</button>
                    <button type="button" data-electrification-choice="unknown" class="${editorChoice === 'unknown' ? 'active' : ''}">Nepoznato</button>
                </div>
                <div class="track-electrification-range-hint">${
                    Number.isInteger(rangeStartIndex)
                        ? `Početni čvor: ${rangeStartIndex + 1}. Kliknite završni čvor.`
                        : 'Klik na jednu dionicu primjenjuje odabrano stanje odmah.'
                }</div>
            </div>`
            : '';
        // as the coloured route on the map); the old ±1 "Razine" breakdown is retired.
        const vp = track.verticalProfile;
        const vpFresh = trackHasFreshAslProfile(track);
        const vpSummary = vpFresh && window.__profileRender
            ? window.__profileRender.regimeSummaryLabel(vp, track.lengthKm * 1000)
            : 'Računa se…';
        const vpViolationHTML = vpFresh && vp.violations.length > 0
            ? `<div class="sel-profile-warn">⚠ ${escapeHtml(vp.violations[0].message)}</div>`
            : '';
        // The elevation graph itself lives in the map-docked strip (#elevationDock,
        // updateElevationDock) — the sheet keeps only the one-line summary + any warning.
        detailsHTML = `
            <div class="sel-row"><span class="sel-label">Vrsta:</span><span class="sel-value">${typeName}</span></div>
            <div class="sel-row"><span class="sel-label">Duljina:</span><span class="sel-value">${track.lengthKm.toFixed(1)} km</span></div>
            <div class="sel-row"><span class="sel-label">Cijena:</span><span class="sel-value">${formatCost(track.cost)}</span></div>
            <div class="sel-row"><span class="sel-label">Stanica:</span><span class="sel-value">${stationCount}</span></div>
            <div class="sel-row"><span class="sel-label">Linije:</span><span class="sel-value">${linesLabel}</span></div>
            <div class="sel-row"><span class="sel-label">Visinski profil:</span><span class="sel-value">${vpSummary}</span></div>
            <div class="sel-row"><span class="sel-label">Elektrifikacija:</span><span class="sel-value">${trackElectrificationSummaryLabel(track)}</span></div>
            <div class="sel-row"><span class="sel-label">Izvor:</span><span class="sel-value">${escapeHtml(trackElectrificationSourceLabel(track))}</span></div>
            ${electrificationEditorHTML}
            ${vpViolationHTML}
        `;
        showDelete = true;
    } else if (type === 'line') {
        const line = ref;
        titleText = `Linija ${line.number || line.id}`;
        isEditable = false;
        const track = getTrackForLine(line);
        const lineGauge = normalizeGauge(track?.gauge || line.gauge);
        const typeName = GAUGES[lineGauge].label;
        const lineStations = (line.stationIds || []).map(id => _stationById.get(id)).filter(Boolean);
        const activeTrains = (line.trains || []).filter(train => train.marker);
        const depotStation = _stationById.get(line.depotStationId);
        const stationListHTML = lineStations.map(station =>
            `<span class="line-popup-station-link" data-station-id="${station.id}">${escapeHtml(getStationDisplayName(station))}</span>`
        ).join(' → ');
        const trainListHTML = activeTrains.map((train, index) => {
            const onboard = train.passengers
                ? Array.from(train.passengers.values()).reduce((sum, count) => sum + count, 0)
                : 0;
            return `<span class="line-popup-train-link" data-train-id="${train.id}">${index + 1}. (${onboard} put.)</span>`;
        }).join(', ');
        const lineRevenue = activeTrains.reduce(
            (sum, train) => sum + (train.totalPassengers || 0), 0,
        ) * FARE_EUR;
        const lineLengthKm = getLineLengthKm(line);
        detailsHTML = `
            <div class="sel-row"><span class="sel-label">Vrsta:</span><span class="sel-value">${typeName}</span></div>
            <div class="sel-row"><span class="sel-label">Duljina rute:</span><span class="sel-value">${lineLengthKm.toFixed(1)} km</span></div>
            <div class="sel-row"><span class="sel-label">Brzina:</span><span class="sel-value">${LINE_SPEED_KMH[lineGauge]} km/h</span></div>
            <div class="sel-row"><span class="sel-label">Kapacitet vlaka:</span><span class="sel-value">${TRAIN_CAPACITY[lineGauge]} put.</span></div>
            <div class="sel-row"><span class="sel-label">Remiza:</span><span class="sel-value">${depotStation
                ? `<span class="line-popup-depot-link" data-station-id="${depotStation.id}">${escapeHtml(getStationDisplayName(depotStation))}</span>`
                : '—'}</span></div>
            <div class="sel-row"><span class="sel-label">Stanice (${lineStations.length}):</span></div>
            ${stationListHTML ? `<div class="line-popup-station-list">${stationListHTML}</div>` : ''}
            <div class="sel-row"><span class="sel-label">Vlakovi (${activeTrains.length}):</span></div>
            ${trainListHTML
                ? `<div class="line-popup-train-list">${trainListHTML}</div>`
                : '<div class="line-popup-train-list line-popup-empty">Nema vlakova</div>'}
            <div class="sel-row"><span class="sel-label">Prihod:</span><span class="sel-value">${lineRevenue.toLocaleString()} €</span></div>
        `;
        extraActionsHTML = '<button class="sel-popup-btn line-popup-add-train" type="button">+ Vlak</button>';
        showDelete = true;
    } else if (type === 'station') {
        const station = ref;
        const stationLines = project.lines.filter(l => l.stationIds && l.stationIds.includes(station.id));
        const track = station.trackId != null ? project.tracks.find(t => t.id === station.trackId) : null;
        const linesLabel = stationLines.length > 0
            ? stationLines.map(l => `<span class="sel-link" data-link-type="line" data-link-id="${l.id}">Linija ${l.number || l.id}</span>`).join(', ')
            : '—';
        const stationLevel = getStationLevel(station);
        const trackLabel = track ? `<span class="sel-link" data-link-type="track" data-link-id="${track.id}">Trasa ${track.id}</span> (${GAUGES[normalizeGauge(track.gauge)].label}, ${TRACK_LEVEL_LABELS[stationLevel]})` : '—';
        const typeLabel = getStationTypeLabel(station);
        const waitingCount = station.waitingCount || 0;
        const servedCount = station.servedCount || 0;
        titleText = getStationDisplayName(station);
        isEditable = true;
        // Depot-specific: list lines originating from this depot with clickable rows
        let depotLinesHTML = '';
        if (station.stationType === 'depot') {
            const depotLines = project.lines.filter(l => l.depotStationId === station.id);
            if (depotLines.length > 0) {
                const rows = depotLines.map(l => {
                    const color = l.color || getLineColor(l.number || l.id);
                    const sc = l.stationIds ? l.stationIds.length : 0;
                    const tc = l.trains ? l.trains.length : 0;
                    return `<div class="sel-depot-line-row sel-link" data-link-type="line" data-link-id="${l.id}"><span class="sel-depot-swatch" style="background:${color}"></span>L${l.number} <span class="sel-depot-line-meta">${sc} st. / ${tc} vl.</span></div>`;
                }).join('');
                depotLinesHTML = `<div class="sel-depot-lines">${rows}</div>`;
            }
        }

        const walkTimeOptions = [0, 5, 10, 15, 20];
        const walkPickerHTML = walkTimeOptions.map(v =>
            `<label class="sel-walk-option"><input type="radio" name="selWalkTime" value="${v}"${v === station.walkMinutes ? ' checked' : ''}><span>${v === 0 ? 'isklj.' : v + ' min'}</span></label>`
        ).join('');

        // A station drawn before the straight-alignment rule (or one whose route
        // was bent around it) still renders its box through the tunnel wall.
        // Say so where the user is already looking, with the numbers — and name
        // the REMEDY, which differs by fault: curvature is fixed on the map, a
        // grade through the platform is fixed in the elevation strip (where the
        // same fault now paints the platform bar red at the spot it happens).
        const undergroundAlignment = getStationUndergroundAlignment(track, station);
        const alignmentFix = undergroundAlignment
            && undergroundAlignment.driftM > UNDERGROUND_STATION_STRAIGHT_TOLERANCE_METERS
            ? `Podzemna stanica je ravna građevina duga `
                + `${UNDERGROUND_STATION_ENVELOPE_HALF_LENGTH_METERS * 2} m — izravnajte trasu kroz nju.`
            : 'Peron mora biti vodoravan: povucite njegovu šipku u visinskom profilu '
                + 'da cijeli peron sjedne na jednu visinu (ili maknite ručne čvorove unutar njega).';
        const alignmentWarningHTML = undergroundAlignment && !undergroundAlignment.ok
            ? `<div class="sel-row sel-row-warning"><span class="sel-label">⚠︎ Trasa:</span><span class="sel-value">`
                + `${escapeHtml(describeUndergroundStationAlignment(undergroundAlignment))}. `
                + `${escapeHtml(alignmentFix)}`
                + '</span></div>'
            : '';

        // The station's structure has to fit on the route. New placements and
        // drags are gated on this, but a station drawn before the rule (or one
        // whose route was later shortened) can still be hanging off the end with
        // its span clamped into a half-length platform — which is also why its
        // bar runs into the edge of the elevation strip. Say so.
        const stationHalfSpanM = stationProfileHalfSpanM(station);
        const stationStructure = getStationStructureLabel(getStationStructureKind(track, station));
        const stationDM = trackChainageAtLatLng(track, station.latlng[0], station.latlng[1]);
        const fitWarningHTML = stationFitsOnTrack(track, stationDM, stationHalfSpanM)
            ? ''
            : `<div class="sel-row sel-row-warning"><span class="sel-label">⚠︎ Duljina:</span><span class="sel-value">`
                + `${escapeHtml(getStationFitMessage(stationHalfSpanM, stationStructure))}`
                + '</span></div>';

        detailsHTML = `
            <div class="sel-row"><span class="sel-label">Vrsta:</span><span class="sel-value">${typeLabel}</span></div>
            <div class="sel-row"><span class="sel-label">Trasa:</span><span class="sel-value">${trackLabel}</span></div>
            <div class="sel-row"><span class="sel-label">Građevina:</span><span class="sel-value">${stationStructure} · ${stationHalfSpanM * 2} m</span></div>
            ${fitWarningHTML}
            ${alignmentWarningHTML}
            <div class="sel-row"><span class="sel-label">Linije:</span><span class="sel-value">${linesLabel}</span></div>
            <div class="sel-row"><span class="sel-label">Cijena:</span><span class="sel-value">${formatCost(station.cost)}</span></div>
            <div class="sel-catchment-group" data-station-id="${station.id}">
                <div class="sel-row sel-row-walk-toggle"><span class="sel-label">Hodanje:</span><span class="sel-value sel-walk-value" role="button" tabindex="0">${station.walkMinutes} min ▾</span></div>
                <div class="sel-walk-picker hidden">${walkPickerHTML}</div>
                <div class="sel-row"><span class="sel-label">Stanovnika:</span><span class="sel-value sel-pop-value">${formatNumber(station.catchmentPopulation)}</span></div>
                <div class="sel-row"><span class="sel-label">Radnih mjesta:</span><span class="sel-value sel-jobs-value">${formatNumber(station.catchmentJobs)}</span></div>
            </div>
            <div class="sel-row"><span class="sel-label">Čeka:</span><span class="sel-value">${formatNumber(waitingCount)}</span></div>
            <div class="sel-row"><span class="sel-label">Opslužen:</span><span class="sel-value">${formatNumber(servedCount)}</span></div>
            ${depotLinesHTML}
        `;
        // "Vidi" (3D view) goes after Zatvori (rendered via trailingActionsHTML below).
        trailingActionsHTML = '<button class="sel-popup-btn sel-popup-btn-3d" type="button">Vidi</button>';
        if (station.stationType === 'depot') {
            extraActionsHTML += '<button class="sel-popup-btn sel-popup-btn-add-line" type="button">Dodaj liniju</button>';
        }
        showDelete = true;
    } else if (type === 'train') {
        const { train, line } = ref;
        const capacity = TRAIN_CAPACITY[normalizeGauge(line.gauge)];
        const trainCount = line.trains ? line.trains.length : 1;
        titleText = `Vlak`;
        isEditable = false;
        const typeName = GAUGES[normalizeGauge(line.gauge)].label;
        const speedKmh = LINE_SPEED_KMH[normalizeGauge(line.gauge)];
        detailsHTML = `
            <div class="sel-row"><span class="sel-label">Linija:</span><span class="sel-value"><span class="sel-link" data-link-type="line" data-link-id="${line.id}">Linija ${line.number || line.id}</span></span></div>
            <div class="sel-row"><span class="sel-label">Vrsta:</span><span class="sel-value">${typeName}</span></div>
            <div class="sel-row"><span class="sel-label">Brzina:</span><span class="sel-value">${speedKmh} km/h</span></div>
            <div class="sel-row"><span class="sel-label">Kapacitet:</span><span class="sel-value">${capacity} putnika</span></div>
            <div class="sel-row"><span class="sel-label">Putnika:</span><span class="sel-value">${train.totalPassengers || 0}</span></div>
            <div class="sel-row"><span class="sel-label">Vlakova na liniji:</span><span class="sel-value">${trainCount}</span></div>
            <div class="sel-row"><span class="sel-label">Duljina rute:</span><span class="sel-value">${getLineLengthKm(line).toFixed(1)} km</span></div>
        `;
        // Cab view is available for both surface tram routes and underground
        // planner lines; Station3D chooses the matching scene path at open time.
        trailingActionsHTML = '<button class="sel-popup-btn sel-popup-btn-3d" type="button" data-action="cab">U kabinu</button>';
        showDelete = true;
    } else if (type === 'transferLink') {
        const link = ref;
        const label = getTransferLinkLabel(link);
        const typeName = link.linkType === 'underground' ? 'Podzemno' : 'Nadzemno';
        titleText = `Presjedanje ${label}`;
        isEditable = false;
        detailsHTML = `
            <div class="sel-row"><span class="sel-label">Vrsta:</span><span class="sel-value">${typeName}</span></div>
            <div class="sel-row"><span class="sel-label">Cijena:</span><span class="sel-value">${link.cost > 0 ? formatCost(link.cost) : 'Besplatno'}</span></div>
        `;
        showDelete = true;
    }

    const editableClass = isEditable ? ' is-editable' : '';
    const editableAttrs = isEditable ? ' role="button" tabindex="0" title="Kliknite za promjenu imena stanice"' : '';
    return `<div class="sel-popup-inner">
        <div class="sel-popup-title${editableClass}"${editableAttrs}>${escapeHtml(titleText)}</div>
        ${isEditable ? '<input class="sel-popup-title-input hidden" type="text" maxlength="120">' : ''}
        <div class="sel-popup-details">${detailsHTML}</div>
        <div class="sel-popup-actions">
            ${extraActionsHTML}
            ${showDelete ? '<button class="sel-popup-btn sel-popup-btn-delete" type="button">Ukloni</button>' : ''}
            <button class="sel-popup-btn sel-popup-btn-neutral" type="button">Zatvori</button>
            ${trailingActionsHTML}
        </div>
    </div>`;
}

// Attaches delegated event handlers to a popup or sheet root element.
// A popup action that takes the main thread — every "open this in 3D" does,
// because Station3D constructs the world synchronously — has to show progress on
// the button it was launched from, or the click reads as ignored for as long as
// the build lasts. The idle label is parked on the element so the button can be
// restored if the action declines to run.
function setPopupButtonBusy(btn, label = 'Učitavam…') {
    if (!btn) return;
    btn.dataset.idleLabel = btn.textContent;
    btn.disabled = true;
    btn.classList.add('is-loading');
    btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = '<span class="sel-popup-btn-loader" aria-hidden="true"></span>'
        + `<span>${escapeHtml(label)}</span>`;
}

function clearPopupButtonBusy(btn) {
    if (!btn) return;
    btn.disabled = false;
    btn.classList.remove('is-loading');
    btn.removeAttribute('aria-busy');
    if (btn.dataset.idleLabel != null) btn.textContent = btn.dataset.idleLabel;
    delete btn.dataset.idleLabel;
}

// Two animation frames guarantee one paint, so the indicator is on screen
// before the synchronous build begins. One frame does not: the callback can run
// in the same frame the class was added, before it has been composited.
function afterOnePaint(work) {
    requestAnimationFrame(() => requestAnimationFrame(work));
}

function attachSelectionHandlers(root) {
    root._selectionHandlersController?.abort();
    const controller = new AbortController();
    root._selectionHandlersController = controller;
    const listenerOptions = { signal: controller.signal };

    // Prevent clicks inside from bubbling to the map and immediately deselecting
    root.addEventListener('click', e => L.DomEvent.stopPropagation(e), listenerOptions);
    root.addEventListener('mouseenter', () => { hoveringObject = true; }, listenerOptions);
    root.addEventListener('mouseleave', () => { hoveringObject = false; }, listenerOptions);

    root.addEventListener('click', e => {
        const stationLink = e.target.closest('.line-popup-station-link, .line-popup-depot-link');
        if (stationLink && selectedObject?.type === 'line') {
            const station = _stationById.get(Number(stationLink.dataset.stationId));
            if (station) {
                const latlng = L.latLng(station.latlng[0], station.latlng[1]);
                map.panTo(latlng, { animate: true, duration: 0.3 });
                selectObject('station', station.id, station, latlng);
            }
            return;
        }

        const trainLink = e.target.closest('.line-popup-train-link');
        if (trainLink && selectedObject?.type === 'line') {
            const line = selectedObject.ref;
            const train = (line.trains || []).find(candidate => candidate.id === Number(trainLink.dataset.trainId));
            if (train) {
                const latlng = train.marker?.getLatLng() || getObjectCentroid('line', line);
                map.panTo(latlng, { animate: true, duration: 0.3 });
                selectObject('train', train.id, { train, line }, latlng);
            }
            return;
        }

        // Handle clickable links to lines/tracks
        const selLink = e.target.closest('.sel-link');
        if (selLink) {
            const linkType = selLink.dataset.linkType;
            const linkId = Number(selLink.dataset.linkId);
            if (linkType === 'line') {
                const line = project.lines.find(l => l.id === linkId);
                if (line) {
                    deselectObject();
                    flyToLine(line);
                    openLinePopup(line);
                }
            } else if (linkType === 'track') {
                const track = project.tracks.find(t => t.id === linkId);
                if (track) {
                    const center = L.latLngBounds(track.latlngs).getCenter();
                    map.panTo(center, { animate: true, duration: 0.3 });
                    deselectObject();
                    selectObject('track', track.id, track, center);
                }
            }
            return;
        }

        const btn = e.target.closest('button');
        if (!btn) return;

        if (btn.matches('[data-electrification-choice]')) {
            if (rejectProjectMutation()) return;
            if (selectedObject?.type !== 'track'
                || !isTrackElectrificationEditorActive(selectedObject.ref)) return;
            trackElectrificationEditor.choice = btn.dataset.electrificationChoice;
            renderSelectionSheet();
            setStatusMessage(`Odabrano: ${btn.textContent.trim()}. Kliknite dionicu ili dva čvora.`);
        } else if (btn.classList.contains('line-popup-add-train')) {
            if (rejectProjectMutation()) return;
            if (selectedObject?.type !== 'line') return;
            const line = selectedObject.ref;
            addTrainToLine(line);
            renderSelectionSheet();
        } else if (btn.classList.contains('sel-popup-btn-delete')) {
            if (rejectProjectMutation()) return;
            if (!selectedObject) return;
            if (selectedObject.type === 'track') {
                const trackId = selectedObject.id;
                deselectObject();
                deleteTrack(trackId);
            } else if (selectedObject.type === 'line') {
                const lineId = selectedObject.id;
                deselectObject();
                deleteLine(lineId);
            } else if (selectedObject.type === 'station') {
                const stationId = selectedObject.id;
                deselectObject();
                removeStation(stationId);
            } else if (selectedObject.type === 'train') {
                const { train, line } = selectedObject.ref;
                deselectObject();
                removeTrainFromLine(line, train);
            } else if (selectedObject.type === 'transferLink') {
                const linkId = selectedObject.id;
                deselectObject();
                removeTransferLink(linkId);
            }
        } else if (btn.classList.contains('sel-popup-btn-3d')) {
            if (!window.Station3D) return;
            if (btn.dataset.action === 'cab' && selectedObject?.type === 'train') {
                const { train, line } = selectedObject.ref;
                setPopupButtonBusy(btn);
                afterOnePaint(() => {
                    let opened = false;
                    try {
                        opened = openPlannerTrainCab(train, line);
                    } catch (error) {
                        console.error('Planner cab open error:', error);
                        setStatusMessage('Otvaranje kabine nije uspjelo.', true);
                    }
                    // An opened cab takes over the screen and the popup goes with
                    // it, so the button stays busy until it disappears. One that
                    // DECLINED (a train no longer on its line, no Station3D) must
                    // not be left spinning — openPlannerTrainCab reports that as
                    // false, including on the path where it returns early to
                    // fetch profiles and re-enters itself afterwards.
                    if (!opened) clearPopupButtonBusy(btn);
                });
            } else if (selectedObject?.type === 'station') {
                const station = selectedObject.ref;
                setPopupButtonBusy(btn);
                afterOnePaint(async () => {
                    try {
                        await openPlannerStationIn3D(station);
                    } catch (error) {
                        console.error('Planner station 3D open error:', error);
                        setStatusMessage('Otvaranje 3D prikaza stanice nije uspjelo.', true);
                    } finally {
                        clearPopupButtonBusy(btn);
                    }
                });
            }
        } else if (btn.classList.contains('sel-popup-btn-add-line')) {
            if (selectedObject?.type === 'station' && selectedObject.ref.stationType === 'depot') {
                const station = selectedObject.ref;
                deselectObject();
                startLineBuildingMode(station);
            }
        } else if (btn.classList.contains('sel-popup-btn-neutral')) {
            deselectObject();
        }
    }, listenerOptions);

    const titleEl = root.querySelector('.sel-popup-title');
    if (titleEl) {
        titleEl.addEventListener('click', () => {
            if (!selectedObject || selectedObject.type !== 'station') return;
            startStationTitleEdit(selectedObject.ref);
        }, listenerOptions);
    }

    const inputEl = root.querySelector('.sel-popup-title-input');
    if (inputEl) {
        inputEl.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); stopStationTitleEdit(true); }
            else if (e.key === 'Escape') { e.preventDefault(); stopStationTitleEdit(false); }
        }, listenerOptions);
        inputEl.addEventListener('blur', () => stopStationTitleEdit(true), listenerOptions);
        // Trigger viewport sync when keyboard appears on mobile
        inputEl.addEventListener('focus', () => { if (mobileSidebarMedia.matches) syncViewportChrome(); }, listenerOptions);
    }

    // Walk-time toggle and picker for station catchment
    const walkToggle = root.querySelector('.sel-walk-value');
    const walkPicker = root.querySelector('.sel-walk-picker');
    if (walkToggle && walkPicker) {
        walkToggle.addEventListener('click', () => {
            walkPicker.classList.toggle('hidden');
        }, listenerOptions);
        walkPicker.addEventListener('change', async (e) => {
            const radio = e.target.closest('input[name="selWalkTime"]');
            if (!radio || !selectedObject || selectedObject.type !== 'station') return;
            const station = selectedObject.ref;
            const newWalk = Number(radio.value);
            walkToggle.textContent = `${newWalk} min ▾`;
            // Sync the global walk-time control in the sidebar
            syncWalkTimeControls(newWalk, { persist: true });
            // Recalculate all stations, prioritising the selected one for instant feedback
            await recalculatePlacedStationsForCurrentWalkTime(station.id);
        }, listenerOptions);
    }

    // The track elevation graph lives in the map-docked strip now
    // (updateElevationDock, called from renderSelectionSheet), not the sheet.
}

// Updates the train popup details in-place when the selected train arrives at a station.
function refreshSelectedTrainPopup(train, line) {
    if (isStation3DMapSuspended()) return;
    if (!selectedObject || selectedObject.type !== 'train') return;
    if (selectedObject.ref.train !== train) return;

    const detailsEl = selectionSheet.querySelector('.sel-popup-details');
    if (!detailsEl) return;

    const capacity = TRAIN_CAPACITY[normalizeGauge(line.gauge)];
    const trainCount = (line.trains || []).filter(t => t.marker).length;
    const typeName = GAUGES[normalizeGauge(line.gauge)].label;
    const speedKmh = LINE_SPEED_KMH[normalizeGauge(line.gauge)];
    const onboard = train.passengers ? Array.from(train.passengers.values()).reduce((s, n) => s + n, 0) : 0;

    detailsEl.innerHTML = `
        <div class="sel-row"><span class="sel-label">Linija:</span><span class="sel-value"><span class="sel-link" data-link-type="line" data-link-id="${line.id}">Linija ${line.number || line.id}</span></span></div>
        <div class="sel-row"><span class="sel-label">Vrsta:</span><span class="sel-value">${typeName}</span></div>
        <div class="sel-row"><span class="sel-label">Brzina:</span><span class="sel-value">${speedKmh} km/h</span></div>
        <div class="sel-row"><span class="sel-label">Kapacitet:</span><span class="sel-value">${capacity} putnika</span></div>
        <div class="sel-row"><span class="sel-label">Putnika:</span><span class="sel-value">${onboard}</span></div>
        <div class="sel-row"><span class="sel-label">Vlakova na liniji:</span><span class="sel-value">${trainCount}</span></div>
        <div class="sel-row"><span class="sel-label">Duljina rute:</span><span class="sel-value">${getLineLengthKm(line).toFixed(1)} km</span></div>
    `;
}

function updateSelectionSheetChip() {
    const show = selectionSheetCollapsed && !!selectedObject && currentMode !== 'edit';
    selectionSheetChip.classList.toggle('hidden', !show);
    if (show) {
        // Icon-only chip; the selection's name lives in the accessible label.
        selectionSheetChip.textContent = 'ⓘ';
        selectionSheetChip.setAttribute(
            'aria-label',
            `Otvori panel: ${selectionSheet.dataset.chipTitle || 'odabir'}`,
        );
        selectionSheetChip.title = selectionSheet.dataset.chipTitle || '';
    }
    syncMapActionButtons();
}

function renderSelectionSheet() {
    if (currentMode === 'edit') {
        selectionSheet.classList.add('hidden');
        selectionSheet.innerHTML = '';
        updateSelectionSheetChip();
        updateElevationDock();
        return;
    }
    if (!selectedObject) {
        selectionSheet.classList.add('hidden');
        selectionSheet.innerHTML = '';
        updateSelectionSheetChip();
        updateElevationDock();
        return;
    }
    const selectionKey = `${selectedObject.type}:${selectedObject.ref?.id ?? ''}`;
    if (selectionKey !== lastSelectionSheetKey) {
        lastSelectionSheetKey = selectionKey;
        selectionSheetCollapsed = false;
    }
    selectionSheet.innerHTML = buildSelectionHTML(selectedObject.type, selectedObject.ref);
    const titleEl = selectionSheet.querySelector('.sel-title, h3, strong');
    selectionSheet.dataset.chipTitle = (titleEl?.textContent || '').trim() || 'ⓘ Info';
    const collapseBtn = document.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.className = 'selection-sheet-collapse';
    collapseBtn.setAttribute('aria-label', 'Sažmi panel');
    // SVG avoids the font-dependent baseline of "⌄", which sat visibly high
    // even inside a flex-centred button.
    collapseBtn.innerHTML = '<svg viewBox="0 0 16 10" aria-hidden="true">'
        + '<path d="M2 2l6 6 6-6" fill="none" stroke="currentColor" '
        + 'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    collapseBtn.onclick = () => {
        selectionSheetCollapsed = true;
        renderSelectionSheet();
    };
    selectionSheet.prepend(collapseBtn);
    selectionSheet.classList.toggle('hidden', selectionSheetCollapsed);
    selectionSheet.setAttribute('aria-label', 'Odabrani objekt');
    attachSelectionHandlers(selectionSheet);
    updateSelectionSheetChip();
    updateElevationDock();
}


// Edit mode owns the map toolbar and intentionally keeps the ordinary
// inspection sheet hidden until editing ends.
function closeSelectionDisplay() {
    if (currentMode === 'edit') return;
    selectionSheet.classList.add('hidden');
    selectionSheet.innerHTML = '';
    updateSelectionSheetChip();
    updateElevationDock();
}

function deselectObject() {
    elevationDockRenderGeneration += 1;
    stopStationTitleEdit(true);
    removeDepotPopup();
    stopTrackElectrificationEditor({ rerender: false });
    if (!selectedObject) {
        if (currentMode === 'edit') setMode('explore');
        closeSelectionDisplay();
        return;
    }

    const wasEditing = currentMode === 'edit';

    if (selectedObject.type === 'track') {
        const track = selectedObject.ref;
        if (track.layer) {
            const pathEl = track.layer.getElement();
            if (pathEl) pathEl.style.pointerEvents = '';
            track.layer.setStyle(getTrackStyle(track.gauge));
        }
    } else if (selectedObject.type === 'line') {
        const line = selectedObject.ref;
        if (line.layer) {
            const pathEl = line.layer.getElement();
            if (pathEl) pathEl.style.pointerEvents = '';
            line.layer.setStyle(getLineStyle(line.gauge, line.color));
        }
    } else if (selectedObject.type === 'station') {
        const station = selectedObject.ref;
        if (station.markerLayer) {
            const el = station.markerLayer.getElement();
            if (el) el.classList.remove('station-marker-selected', 'station-edit-target', 'station-edit-active');
        }
    } else if (selectedObject.type === 'train') {
        const { train } = selectedObject.ref;
        if (train?.marker) {
            const el = train.marker.getElement();
            if (el) el.style.filter = '';
        }
    } else if (selectedObject.type === 'transferLink') {
        const link = selectedObject.ref;
        if (link.layer) {
            link.layer.setStyle(TRANSFER_LINK_STYLE);
        }
    }

    selectedObject = null;
    editingStationTitleId = null;

    if (wasEditing) setMode('explore');
    syncExclusiveEditInteractivity();
    selectionSheet.classList.add('hidden');
    selectionSheet.innerHTML = '';
    updateSelectionSheetChip();
    updateElevationDock();
}

function selectObject(type, id, ref, clickLatLng) {
    if (currentMode === 'edit') {
        if (selectedObject?.type === type && selectedObject.id === id) renderSelectionSheet();
        return;
    }
    deselectObject();
    setRouteGaugePickerOpen(false);
    selectedObject = { type, id, ref };

    if (snapMarker) { map.removeLayer(snapMarker); snapMarker = null; }
    clearPreviewCatchment();
    clearPreviewStationDistances();
    removeStationPicker();

    // Visual highlight on the map object
    if (type === 'track') {
        const track = ref;
        if (track.layer) {
            track.layer.setStyle({ ...getTrackStyle(track.gauge), weight: 8, opacity: 1 });
            track.layer.bringToFront();
            const pathEl = track.layer.getElement();
            if (pathEl) pathEl.style.pointerEvents = 'none';
        }
    } else if (type === 'line') {
        const line = ref;
        if (line.layer) {
            line.layer.setStyle({ ...getLineStyle(line.gauge, line.color), weight: 8, opacity: 1 });
            line.layer.bringToFront();
            const pathEl = line.layer.getElement();
            if (pathEl) pathEl.style.pointerEvents = 'none';
        }
    } else if (type === 'station') {
        const station = ref;
        if (station.markerLayer) {
            const el = station.markerLayer.getElement();
            if (el) el.classList.add('station-marker-selected');
        }
    } else if (type === 'train') {
        const { train, line } = ref;
        if (train?.marker) {
            const el = train.marker.getElement();
            if (el) el.style.filter = 'drop-shadow(0 0 6px rgba(0,123,255,0.8))';
        }
    } else if (type === 'transferLink') {
        const link = ref;
        if (link.layer) {
            link.layer.setStyle({ ...TRANSFER_LINK_STYLE, weight: 6, opacity: 1 });
        }
    }

    if (type === 'track') scheduleSelectedTrackRender(ref);
    else renderSelectionSheet();
}

function handleObjectClick(e, type, id, ref, pointerLatLng = null) {
    L.DomEvent.stopPropagation(e);
    const clickLatLng = pointerLatLng || e.latlng;
    if (currentMode === 'edit') {
        // Track/line clicks insert route nodes; stations are drag-only here.
        if (type === 'track') {
            removePreviewVertex();
            insertTrackVertex(ref, clickLatLng.lat, clickLatLng.lng);
        } else if (type === 'line') {
            removePreviewVertex();
            const track = getTrackForLine(ref);
            if (track) insertTrackVertex(track, clickLatLng.lat, clickLatLng.lng);
        }
        return;
    }
    if (currentMode === 'placeStation' && (type === 'track' || type === 'line')) {
        const trackSnap = snapToTrack(clickLatLng.lat, clickLatLng.lng, 50);
        if (!trackSnap) {
            setStatusMessage('Kliknite bliže trasi na kojoj želite postaviti stanicu.', true);
            return;
        }
        lastSnappedLatLng = trackSnap.latlng;
        lastSnappedTrackId = trackSnap.trackId;
        showStationPicker(clickLatLng);
        return;
    }
    if (selectedObject && selectedObject.type === type && selectedObject.id === id) {
        renderSelectionSheet();
    } else {
        selectObject(type, id, ref, clickLatLng);
    }
}

function createLineHitLayer(line) {
    const track = getTrackForLine(line);
    const hitLayer = L.polyline(track.latlngs, {
        weight: 32,
        opacity: 0,
        interactive: true,
        className: 'line-hit-area',
    }).addTo(map);
    line.hitLayer = hitLayer;
    return hitLayer;
}

function attachLineClickHandler(line) {
    const target = line.hitLayer || line.layer;
    if (target) {
        target.on('click', function (e) {
            handleObjectClick(e, 'line', line.id, line);
        });
        attachLineHover(line);
    }
}

function createTrackHitLayer(track) {
    const hitLayer = L.polyline(track.latlngs, {
        weight: 32,
        opacity: 0,
        interactive: true,
        className: 'track-hit-area',
    }).addTo(map);
    track.hitLayer = hitLayer;
    return hitLayer;
}

function attachTrackClickHandler(track) {
    const target = track.hitLayer || track.layer;
    if (target) {
        target.on('click', function (e) {
            handleObjectClick(e, 'track', track.id, track);
        });
        attachTrackHover(track);
    }
}

function attachTrackHover(track) {
    const target = track.hitLayer || track.layer;
    if (!target) return;
    target.on('mouseover', () => {
        suspendModePreview();
        if (currentMode === 'edit') setMapCursor('copy');
        if (!isObjectSelected('track', track) && track.layer) {
            track.layer.setStyle({ ...getTrackStyle(track.gauge), weight: 7, opacity: 0.9 });
        }
    });
    target.on('mousemove', (e) => {
        if (currentMode === 'edit' && !draggingVertex) {
            if (!canStartVertexPlacement()) {
                removePreviewVertex();
                setMapCursor('zoom-in');
                return;
            }
            const snap = nearestPointOnTrack(track, e.latlng.lat, e.latlng.lng);
            if (snap) showPreviewVertex([snap.lat, snap.lon]);
        }
    });
    target.on('mouseout', () => {
        resumeModePreview();
        removePreviewVertex();
        if (proximityHoveredTrack !== track && !isObjectSelected('track', track) && track.layer) {
            track.layer.setStyle(getTrackStyle(track.gauge));
        }
    });
}

const TRACK_PROXIMITY_PX = 18;

// Invisible Leaflet hit strokes overlap the visible route and line layers.
// Their mouseover/mouseout ordering is therefore not a stable definition of
// "near the track". Use one screen-space nearest-distance test for both hover
// and background clicks, independent of layer order and map latitude.
function nearestTrackInScreenSpace(latlng, maxDistancePx = TRACK_PROXIMITY_PX) {
    const pointer = map.latLngToLayerPoint(latlng);
    let best = null;
    for (const track of project.tracks) {
        const points = (track.latlngs || []).map((point) => map.latLngToLayerPoint(point));
        for (let i = 0; i < points.length - 1; i++) {
            const a = points[i], b = points[i + 1];
            const candidate = nearestPointOnSegment(pointer.x, pointer.y, a.x, a.y, b.x, b.y);
            if (!best || candidate.distSq < best.distSq) best = { track, distSq: candidate.distSq };
        }
    }
    return best && best.distSq <= maxDistancePx * maxDistancePx ? best.track : null;
}

function setProximityHoveredTrack(track) {
    if (proximityHoveredTrack === track) return;
    const previous = proximityHoveredTrack;
    proximityHoveredTrack = track;
    if (previous && !isObjectSelected('track', previous) && previous.layer) {
        previous.layer.setStyle(getTrackStyle(previous.gauge));
    }
    if (track && !isObjectSelected('track', track) && track.layer) {
        track.layer.setStyle({ ...getTrackStyle(track.gauge), weight: 7, opacity: 0.9 });
    }
}

function buildTrackMotionProfile(track) {
    const motionProfile = buildLineMotionProfile(track.latlngs, track.gauge);
    track.motionProfile = motionProfile;
    return motionProfile;
}

// Returns the latlng path a line's motion profile currently follows, or null.
function getLineProfileLatLngs(line) {
    const profile = getLineMotionProfile(line);
    if (!profile?.segments?.length) return null;
    const latlngs = profile.segments.map(segment => [segment.start.lat, segment.start.lng]);
    const last = profile.segments[profile.segments.length - 1];
    latlngs.push([last.end.lat, last.end.lng]);
    return latlngs;
}

// Redraws the visible/hit polylines of every line using this track from their
// (already rebuilt) motion profiles.
function syncLineLayersForTrack(track) {
    for (const line of project.lines) {
        if (!lineUsesTrack(line, track.id)) continue;
        const latlngs = getLineProfileLatLngs(line);
        if (!latlngs) continue;
        if (line.layer) line.layer.setLatLngs(latlngs);
        if (line.hitLayer) line.hitLayer.setLatLngs(latlngs);
    }
}

// Checks whether a line uses a given track — derived from its stations' trackIds.
function lineUsesTrack(line, trackId) {
    if (line.stationIds) {
        return line.stationIds.some(sid => {
            const st = _stationById.get(sid);
            return st && st.trackId === trackId;
        });
    }
    // Fallback for lines with fewer than 2 stations (not yet fully formed)
    return project.stations.some(s => s.lineId === line.id && s.trackId === trackId);
}

// Rebuild the motion profile for a track and all lines that use it.
// Called during vertex drag so trains follow the track in real-time.
function rebuildAffectedMotionProfiles(track) {
    const oldLength = track.motionProfile?.totalLengthMeters || 0;
    buildTrackMotionProfile(track);
    const newLength = track.motionProfile?.totalLengthMeters || 0;

    for (const line of project.lines) {
        if (!lineUsesTrack(line, track.id)) continue;

        const oldLineLength = getLineMotionProfile(line)?.totalLengthMeters || 0;

        if (line.stationIds && line.stationIds.length >= 2) {
            // Multi-track line: rebuild combined profile from stations
            buildLineMotionProfileFromStations(line);
        } else {
            // Single-track line: profile derived from track via getLineMotionProfile fallback
            line.motionProfile = null;
        }

        // Scale train positions proportionally so they don't jump
        const newLineLength = getLineMotionProfile(line)?.totalLengthMeters || 0;
        if (line.trains && oldLineLength > 0 && newLineLength > 0) {
            const scale = newLineLength / oldLineLength;
            for (const train of line.trains) {
                train.distanceMeters = Math.min(train.distanceMeters * scale, newLineLength);
            }
        }
    }
}

// Rebuild a single line's motion profile and station stops, scaling train positions proportionally.
// Trains paused at a station snap to that station's new offset so they move with it.
function rebuildLineProfilePreservingTrains(line) {
    const oldLength = getLineMotionProfile(line)?.totalLengthMeters || 0;

    if (line.stationIds && line.stationIds.length >= 2) {
        buildLineMotionProfileFromStations(line);
        updateLineStationStopsFromIds(line);
    } else {
        updateLineStationStops(line);
    }

    const newLength = getLineMotionProfile(line)?.totalLengthMeters || 0;
    if (line.trains && newLength > 0) {
        const stops = line.stationStops || [];
        const scale = oldLength > 0 ? newLength / oldLength : 1;
        for (const train of line.trains) {
            // Train paused at a station: snap to that station's new offset
            if (train.pausedStationId != null) {
                const stop = stops.find(s => s.stationId === train.pausedStationId);
                if (stop) {
                    train.distanceMeters = stop.offsetMeters;
                    continue;
                }
            }
            // Free-running train: scale proportionally
            train.distanceMeters = Math.min(train.distanceMeters * scale, newLength);
        }
    }
}

// Validate that all stations in a line can still be reached sequentially.
// Returns the line name if broken, or null if OK.
function validateLineConnectivity(line) {
    if (!line.stationIds || line.stationIds.length < 2) return null;

    for (let i = 0; i < line.stationIds.length - 1; i++) {
        const stA = _stationById.get(line.stationIds[i]);
        const stB = _stationById.get(line.stationIds[i + 1]);
        if (!stA || !stB) return `Linija ${line.number}`;

        // Check if stB is reachable from stA (allow visited = all except stB)
        const visited = new Set(line.stationIds.filter(id => id !== stB.id));
        visited.delete(stA.id); // stA must be allowed as origin
        const reachable = findNextReachableStations(stA, [...visited]);
        const canReach = reachable.some(r => r.station.id === stB.id);
        if (!canReach) return `Linija ${line.number}`;
    }
    return null;
}

// Check connectivity for all lines. Returns first broken line name or null.
function validateAllLinesConnectivity() {
    for (const line of project.lines) {
        const broken = validateLineConnectivity(line);
        if (broken) return broken;
    }
    return null;
}

function attachStationClickHandler(station) {
    if (station.markerLayer) {
        station.markerLayer.on('click', function (e) {
            handleObjectClick(e, 'station', station.id, station);
        });
        attachStationHover(station);
        attachStationDrag(station);
    }
}


function attachTrainClickHandler(line) {
    // Legacy compat — attach handlers to all trains on the line
    if (line.trains) {
        for (const train of line.trains) {
            attachTrainClickHandlerForTrain(train, line);
        }
    }
}

function attachTrainClickHandlerForTrain(train, line) {
    if (!train.marker) return;
    train.marker.on('click', function (e) {
        const pointerLatLng = e.originalEvent
            ? map.mouseEventToLatLng(e.originalEvent)
            : e.latlng;
        handleObjectClick(e, 'train', train.id, { train, line }, pointerLatLng);
    });
    attachTrainHoverForTrain(train, line);
}

function setMapCursor(cursor) {
    mapContainer.style.cursor = cursor;
}

function suspendModePreview() {
    if (currentMode === 'placeStation') {
        hoveringObject = false;
        setMapCursor('copy');
        return;
    }
    if (currentMode === 'edit') {
        hoveringObject = true;
        setMapCursor('copy');
        return;
    }
    hoveringObject = true;
    setMapCursor('pointer');
    if (snapMarker) { map.removeLayer(snapMarker); snapMarker = null; }
    clearPreviewCatchment();
    clearPreviewStationDistances();
}

function resumeModePreview() {
    if (proximityHoveredTrack) {
        hoveringObject = true;
        setMapCursor(currentMode === 'edit' ? 'copy' : 'pointer');
        return;
    }
    hoveringObject = false;
    setMapCursor(currentMode === 'placeStation'
        ? 'copy'
        : currentMode === 'edit' ? 'default' : '');
}

function isObjectSelected(type, ref) {
    return selectedObject && selectedObject.type === type && selectedObject.ref === ref;
}

function attachObjectHoverCursor(layer) {
    layer.on('mouseover', suspendModePreview);
    layer.on('mouseout', resumeModePreview);
}

function attachLineHover(line) {
    const target = line.hitLayer || line.layer;
    if (!target) return;
    target.on('mouseover', () => {
        suspendModePreview();
        if (!isObjectSelected('line', line) && line.layer) {
            line.layer.setStyle({ ...getLineStyle(line.gauge, line.color), weight: 6, opacity: 1 });
        }
    });
    target.on('mouseout', () => {
        resumeModePreview();
        removePreviewVertex();
        if (!isObjectSelected('line', line) && line.layer) {
            line.layer.setStyle(getLineStyle(line.gauge, line.color));
        }
    });
}

function attachStationHover(station) {
    if (!station.markerLayer) return;
    station.markerLayer.on('mouseover', () => {
        suspendModePreview();
        if (!isObjectSelected('station', station)) {
            const el = station.markerLayer.getElement();
            if (el) el.classList.add('station-marker-hover');
        }
    });
    station.markerLayer.on('mouseout', () => {
        resumeModePreview();
        const el = station.markerLayer.getElement();
        if (el) el.classList.remove('station-marker-hover');
    });
}

function attachTrainHover(line) {
    if (line.trains) {
        for (const train of line.trains) attachTrainHoverForTrain(train, line);
    }
}

function attachTrainHoverForTrain(train, line) {
    if (!train.marker) return;
    train.marker.on('mouseover', () => {
        suspendModePreview();
        const el = train.marker.getElement();
        if (el) el.style.filter = 'drop-shadow(0 0 4px rgba(0,123,255,0.6))';
    });
    train.marker.on('mouseout', () => {
        resumeModePreview();
        const el = train.marker.getElement();
        if (el) el.style.filter = '';
    });
}

function updateCurrentLinePreview(previewLatLng = null) {
    if (!currentLineLayer) return;

    const latlngs = previewLatLng && currentLinePoints.length > 0
        ? [...currentLinePoints, [previewLatLng.lat, previewLatLng.lng]]
        : currentLinePoints;

    const gauge = normalizeGauge(extendingTrack?.track?.gauge
        || document.querySelector('input[name="trackGauge"]:checked')?.value);
    const style = getTrackStyle(gauge);
    const curveValid = validateDraftTrackCurves(latlngs, { warn: false });
    currentLineLayer.setStyle(curveValid
        ? { ...style, dashArray: null }
        : { ...style, color: '#dc2626', weight: style.weight + 2, dashArray: '8, 6' });
    currentLineLayer.setLatLngs(latlngs);
}

function snapDrawingToCompatibleTrack(lat, lng, maxScreenPx = 30) {
    if (project.tracks.length === 0) return null;
    const gauge = normalizeGauge(extendingTrack?.track?.gauge
        || document.querySelector('input[name="trackGauge"]:checked')?.value);
    const requiredLevel = currentLinePoints.length > 0 || extendingTrack
        ? normalizeTrackLevel(drawingTrackLevel)
        : null;
    return snapToTrack(lat, lng, maxScreenPx, {
        gauge,
        requiredLevel,
        fullLevelOnly: true,
        excludeTrackId: extendingTrack?.track?.id ?? null,
    });
}

function snapPointToReferenceRail(latlng, gauge, maxScreenPx = 30) {
    if (!referenceConnectionMode || !window.__railProjectConnections) return null;
    const features = referenceRailSnapRequest?.collection?.features;
    if (!features?.length) return null;
    const pointer = map.latLngToLayerPoint(latlng);
    return window.__railProjectConnections.nearestReferenceSnap(
        features,
        pointer,
        coordinate => map.latLngToLayerPoint([coordinate[1], coordinate[0]]),
        { gauge: normalizeGauge(gauge), maxDistancePx: maxScreenPx },
    );
}

function snapDrawingToReferenceRail(latlng, maxScreenPx = 30) {
    const gauge = extendingTrack?.track?.gauge
        || document.querySelector('input[name="trackGauge"]:checked')?.value;
    return snapPointToReferenceRail(latlng, gauge, maxScreenPx);
}

// ─── Map Events ─────────────────────────────────────────────────────────────
map.on('mousemove', function (e) {
    if (!draggingVertex && !hoveringFinishMarker
        && currentMode !== 'drawLine' && currentMode !== 'placeStation') {
        const hadProximityHover = !!proximityHoveredTrack;
        const nearbyTrack = nearestTrackInScreenSpace(e.latlng);
        setProximityHoveredTrack(nearbyTrack);
        if (nearbyTrack) {
            hoveringObject = true;
            setMapCursor(currentMode === 'edit' ? 'copy' : 'pointer');
        } else if (hadProximityHover) {
            resumeModePreview();
        }
    }
    if (hoveringObject || draggingVertex || hoveringFinishMarker) return;

    if (currentMode === 'placeStation') {
        // Station placement is an explicit tool: only this mode snaps to
        // tracks, previews station spacing, and turns route clicks into stops.
        const trackSnap = project.tracks.length > 0 ? snapToTrack(e.latlng.lat, e.latlng.lng, 50) : null;
        if (trackSnap) {
            lastSnappedLatLng = trackSnap.latlng;
            lastSnappedTrackId = trackSnap.trackId;
            const nearby = findNearbyStations(trackSnap.latlng, null);
            const snapIconToUse = nearby.length > 0 ? transferSnapIcon : snapIcon;
            if (!snapMarker) {
                snapMarker = L.marker(trackSnap.latlng, { icon: snapIconToUse, interactive: false }).addTo(map);
            } else {
                snapMarker.setLatLng(trackSnap.latlng);
                snapMarker.setIcon(snapIconToUse);
            }
            // Show station distances on the line if one exists on this track
            const lineOnTrack = project.lines.find(l => lineUsesTrack(l, trackSnap.trackId));
            if (lineOnTrack) {
                showPreviewStationDistances(lineOnTrack, trackSnap.latlng);
            } else {
                clearPreviewStationDistances();
            }
            debouncedPreviewCatchment(trackSnap.latlng.lat, trackSnap.latlng.lng);
            setMapCursor('copy');
        } else {
            clearPreviewCatchment();
            clearPreviewStationDistances();
            lastSnappedLatLng = null;
            lastSnappedTrackId = null;
            if (snapMarker) { map.removeLayer(snapMarker); snapMarker = null; }
            setMapCursor('not-allowed');
        }
    } else if (currentMode === 'edit') {
        clearPreviewStationDistances();
        lastSnappedLatLng = null;
        lastSnappedTrackId = null;
        if (snapMarker) { map.removeLayer(snapMarker); snapMarker = null; }
        setMapCursor('default');
    } else if (currentMode === 'explore') {
        // Ordinary map clicks stay available for catchment / walk at the exact
        // clicked point. Geometry changes require the explicit edit mode.
        clearPreviewStationDistances();
        lastSnappedLatLng = null;
        lastSnappedTrackId = null;
        if (snapMarker) { map.removeLayer(snapMarker); snapMarker = null; }
        setMapCursor('');
    } else if (currentMode === 'drawLine') {
        const referenceSnap = snapDrawingToReferenceRail(e.latlng);
        // A shared exact node becomes a functional network switch. Only expose
        // tracks whose gauge and full vertical level match this draft.
        const trackSnap = referenceSnap ? null : snapDrawingToCompatibleTrack(e.latlng.lat, e.latlng.lng);
        if (referenceSnap) {
            lastReferenceRailSnap = referenceSnap;
            lastSnappedLatLng = L.latLng(referenceSnap.lat, referenceSnap.lng);
            lastSnappedTrackId = null;
            if (!snapMarker) {
                snapMarker = L.marker(lastSnappedLatLng, { icon: externalRailSnapIcon, interactive: false }).addTo(map);
            } else {
                snapMarker.setLatLng(lastSnappedLatLng);
                snapMarker.setIcon(externalRailSnapIcon);
            }
        } else if (trackSnap) {
            lastReferenceRailSnap = null;
            lastSnappedLatLng = trackSnap.latlng;
            lastSnappedTrackId = trackSnap.trackId;
            const icon = junctionSnapIcon;
            if (!snapMarker) {
                snapMarker = L.marker(trackSnap.latlng, { icon, interactive: false }).addTo(map);
            } else {
                snapMarker.setLatLng(trackSnap.latlng);
                snapMarker.setIcon(icon);
            }
        } else {
            lastReferenceRailSnap = null;
            lastSnappedLatLng = null;
            lastSnappedTrackId = null;
            if (snapMarker) { map.removeLayer(snapMarker); snapMarker = null; }
        }
        const pointerLatLng = lastSnappedLatLng || e.latlng;
        if (currentLinePoints.length > 0) {
            updateCurrentLinePreview(pointerLatLng);
        }
    }
});

map.on('mouseout', function () {
    if (snapMarker) { map.removeLayer(snapMarker); snapMarker = null; }
    lastSnappedLatLng = null;
    lastSnappedTrackId = null;
    lastReferenceRailSnap = null;
    if (currentMode === 'drawLine') {
        updateCurrentLinePreview();
    }
    clearPreviewCatchment();
    clearPreviewStationDistances();
    setMapCursor('');
});

// ─── Read-only railway projects ─────────────────────────────────────────────
// Both the map and Station3D consume the same clipped project endpoint. Solved
// reconstructions carry absolute EVRF2000 Z; offline local-PBF imports declare
// terrain draping. There is no live OSM query or second display class.
const REFERENCE_RAIL_GEOMETRY_URL = `${API_BASE_URL}/transit/reference-project-geometry`;
const REFERENCE_RAIL_MAP_LOAD_FAILED = Symbol('reference-rail-map-load-failed');
let referenceRailRequest = null;      // clipped 3D/session request
let referenceRailMapRequest = null;   // whole-location 2D request
let referenceRailMapLayer = null;

function locationSupportsReferenceRail(locationId = getProjectLocationId()) {
    return !!window.__locationRegistry?.isKnown?.(locationId);
}

function referenceRailEditingQuery() {
    const id = Number(savedProjectId);
    return Number.isFinite(id) && id > 0 ? `&editing=${id}` : '';
}

function syncRailSimulationGeometry() {
    const features = referenceRailVisible
        ? referenceRailMapRequest?.collection?.features
        : null;
    if (supportsReferenceSimulation(getProjectLocationId(), 'rail')
        && window.railwaySim?.setCanonicalTrackFeatures) {
        window.railwaySim.setCanonicalTrackFeatures(Array.isArray(features) ? features : null);
    }
    // The scheduled simulator may retain its private OSM graph until reference
    // projects load, but it never owns a second visible rail layer.
    window.railwaySim?.setTrackLayerVisible?.(false);
}

window.addEventListener('railwaySim:ready', syncRailSimulationGeometry);

async function ensureReferenceRailSnapGeometry() {
    const locationId = getProjectLocationId();
    const bbox = window.__locationRegistry?.REGISTRY?.[locationId]?.bbox;
    if (!locationSupportsReferenceRail(locationId) || !bbox) return null;
    if (referenceRailSnapRequest?.location === locationId) {
        return referenceRailSnapRequest.promise;
    }
    const query = bbox.map(value => Number(value).toFixed(5)).join(',');
    const request = { location: locationId, collection: null, promise: null };
    request.promise = fetch(
        `${REFERENCE_RAIL_GEOMETRY_URL}?bbox=${encodeURIComponent(query)}`
            + `${referenceRailEditingQuery()}&detail=exact`,
        { cache: 'no-store' },
    )
        .then(response => {
            if (!response.ok) throw new Error(`reference-project-geometry ${response.status}`);
            return response.json();
        })
        .then(collection => {
            request.collection = collection;
            return collection;
        })
        .catch(error => {
            console.warn('[rail-connections] exact snap geometry unavailable:', error?.message || error);
            request.collection = null;
            return null;
        });
    referenceRailSnapRequest = request;
    return request.promise;
}

// What this session can see: its own geometry plus an optional spawn point. A
// project-less walk deeplink has only the spawn, which is exactly right.
function referenceRailAreaPoints(extraPoint) {
    const points = [];
    for (const track of project.tracks || []) {
        for (const latlng of track.latlngs || []) points.push(latlng);
    }
    if (Number.isFinite(extraPoint?.lat) && Number.isFinite(extraPoint?.lng)) {
        points.push([extraPoint.lat, extraPoint.lng]);
    }
    return points;
}

// Resolves to the clipped span collection for the current session, cached by
// (location, box). Never rejects: no existing-rail reference is a missing layer,
// not a broken planner.
function referenceRailRequestDescriptor(extraPoint = null, { force = false } = {}) {
    const api = window.__railReferenceProjects;
    const locationId = getProjectLocationId();
    if (!api || (!force && !referenceRailVisible) || !locationSupportsReferenceRail(locationId)) return null;
    const bbox = api.areaOfInterestBbox(referenceRailAreaPoints(extraPoint));
    if (!bbox) return null;
    const key = api.requestCacheKey({
        locationId,
        bbox,
        savedProjectId,
    });
    const url = `${REFERENCE_RAIL_GEOMETRY_URL}?bbox=${encodeURIComponent(api.bboxQueryValue(bbox))}`
        + referenceRailEditingQuery();
    return { api, key, locationId, url };
}

function referenceRailRequestIsCurrent(extraPoint = null) {
    const descriptor = referenceRailRequestDescriptor(extraPoint);
    if (!descriptor) return true;
    return descriptor.api.loadedRequestMatches(referenceRailRequest, descriptor.key);
}

function ensureReferenceRailProjects(extraPoint = null, { force = false } = {}) {
    const descriptor = referenceRailRequestDescriptor(extraPoint, { force });
    if (!descriptor) return Promise.resolve(null);
    const { key, locationId, url } = descriptor;
    if (referenceRailRequest?.key === key) return referenceRailRequest.promise;
    // The box selects, not the location: a railway that runs from one prepared
    // area into the next is drawn from both sides.
    const request = { key, location: locationId, collection: null, promise: null };
    request.promise = fetch(url, { cache: 'no-store' })
        .then((response) => {
            if (!response.ok) throw new Error(`reference-project-geometry ${response.status}`);
            return response.json();
        })
        .then((collection) => {
            request.collection = collection;
            const spans = collection?.features?.length || 0;
            const nodes = (collection?.features || [])
                .reduce((sum, feature) => sum + (feature.geometry?.coordinates?.length || 0), 0);
            console.info(`[reference-rail] ${locationId}: ${spans} span(s), ${nodes} node(s) in view`);
            return collection;
        })
        .catch((error) => {
            console.warn('[reference-rail] unavailable:', error?.message || error);
            request.collection = null;
            return null;
        });
    referenceRailRequest = request;
    return request.promise;
}

// Already-fetched spans, tagged for the world. Sync by design: the session's
// otherTracks list is assembled in one pass, and every caller awaits
// ensureReferenceRailProjects() first.
function referenceRailWorldFeatures({
    photoDatumM = null,
    force = false,
    solvedOnly = false,
} = {}) {
    const api = window.__railReferenceProjects;
    const collection = referenceRailRequest?.collection;
    if ((!force && !referenceRailVisible) || !api || !collection) return [];
    return api.referenceFeatures(collection, {
        photoDatumM,
        modelTerrainActive: modelTerrainActive(),
        solvedOnly,
    });
}

// ── Chainage dialog ───────────────────────────────────────────────────────────
// This is a PROJECT view: every figure belongs to the reconstruction currently
// open in the planner. A complete infrastructure corridor can cross junctions
// and multiple independently versioned projects; that needs a separate page
// with an explicit corridor definition rather than an endpoint crawl here.
//
// Everything here reads what the API serves. The profile JSONs are build inputs
// and are excluded from the deploy, so they must never be a runtime dependency.
// All of this comes from the API. It used to be static JSON shipped in website/,
// which meant three copies of the same data (browser, profile builder, deploy)
// with no way to tell which was current — see db/rail_reference.sql.
const LEVEL_CROSSINGS_URL = `${API_BASE_URL}/transit/level-crossings`;
const LINE_SECTIONS_URL = `${API_BASE_URL}/transit/line-sections`;

// A generous box around the joined line: stations and crossings are matched to
// chainage afterwards, so asking for slightly too much costs nothing and asking
// for too little silently drops a section boundary.
function chainageAreaBbox(segments, padDeg = 0.05) {
    let west = Infinity; let south = Infinity; let east = -Infinity; let north = -Infinity;
    for (const segment of segments) {
        for (const node of segment.nodes) {
            west = Math.min(west, node.x); east = Math.max(east, node.x);
            south = Math.min(south, node.y); north = Math.max(north, node.y);
        }
    }
    if (!Number.isFinite(west)) return null;
    return [west - padDeg, south - padDeg, east + padDeg, north + padDeg]
        .map(value => value.toFixed(5)).join(',');
}

// A missing side file is a thinner table, never a broken dialog: level crossings
// only exist for the areas that have been extracted.
async function fetchJsonOrNull(url) {
    try {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) return null;
        return await response.json();
    } catch (error) {
        console.warn('[chainage] optional data unavailable:', url, error?.message || error);
        return null;
    }
}

async function openChainageDialog() {
    const api = window.__lineChainage;
    const dialog = window.__lineChainageDialog;
    if (!api || !dialog) return;
    setPopupButtonBusy(openChainageBtn, 'Računam…');
    try {
        // The seed comes from the API, not from the in-memory project: loading
        // normalises a project down to geometry and the solved profile, dropping
        // origin, version and the per-track legacy metadata (ref, name). Built
        // from memory the line had no ref and was labelled "line".
        const savedRow = await fetchJsonOrNull(
            `${API_BASE_URL}/transit/projects/${Number(savedProjectId)}`);
        const seed = savedRow && api.segmentFromProject({ ...savedRow, id: Number(savedProjectId) });
        if (!seed) {
            setStatusMessage('Ova pruga nema riješeni visinski profil.', true);
            return;
        }
        const bbox = chainageAreaBbox([seed]);
        const area = bbox ? `?bbox=${encodeURIComponent(bbox)}` : '';
        const [stations, levelCrossings, officialSections] = await Promise.all([
            fetchJsonOrNull(`${RAIL_STATIONS_URL}${area}`),
            fetchJsonOrNull(`${LEVEL_CROSSINGS_URL}${area}`),
            fetchJsonOrNull(LINE_SECTIONS_URL),
        ]);
        const line = api.buildLineChainage({
            segments: [seed],
            stations: Array.isArray(stations) ? stations : [],
            levelCrossings: Array.isArray(levelCrossings) ? levelCrossings : [],
            // One table now, carrying both annexes: a row has a ruling gradient,
            // a permitted speed, or both, and the matcher reads whichever is set.
            officialGradients: Array.isArray(officialSections) ? officialSections : [],
            officialSpeeds: Array.isArray(officialSections) ? officialSections : [],
        }, {
            // Chainage runs from the end nearest the first node of the OPEN
            // project, so the table reads in the direction the user is looking at.
            startNear: [seed.nodes[0].x, seed.nodes[0].y],
        });
        if (!line?.sections?.length) {
            setStatusMessage('Nema dovoljno stanica na ovoj pruzi za kilometražu.', true);
            return;
        }
        console.info(`[chainage] ${line.refs.join(' + ')}: ${line.sections.length} section(s) `
            + `over ${(line.lengthM / 1000).toFixed(1)} km from ${line.segments.length} segment(s)`);
        dialog.open(line, { title: 'Kilometraža projekta' });
    } catch (error) {
        console.error('[chainage] failed:', error);
        setStatusMessage('Izračun kilometraže nije uspio.', true);
    } finally {
        clearPopupButtonBusy(openChainageBtn);
    }
}

// Only a reconstructed existing line has the solved profile this needs.
function refreshChainageButton() {
    if (!openChainageBtn) return;
    // NOT tested on project.origin: loading normalises that away, so the button
    // never appeared. The real precondition is what the dialog needs — a SAVED
    // project (it re-fetches the row for its metadata) carrying a solved absolute
    // profile. That is exactly the set of reconstructions.
    const hasSolvedProfile = (project?.tracks || []).some(track => (
        track?.verticalProfile?.elevAslM?.length >= 2
    ));
    openChainageBtn.classList.toggle('hidden', !(savedProjectId && hasSolvedProfile));
}

// The relief viewer reads the SAVED project from the API, so the button is only
// live for a project that is saved and has nothing pending. Disabled rather than
// hidden, with the reason in the tooltip: a control that vanishes leaves the
// user guessing, and "why can I not open this?" has an answer worth giving.
function refreshReliefViewerButton() {
    if (!openReliefViewerBtn) return;
    const ready = Boolean(savedProjectId) && !projectDirty;
    openReliefViewerBtn.disabled = !ready;
    openReliefViewerBtn.title = ready
        ? 'Otvori ovaj prijedlog u 3D pregledniku reljefa'
        : (savedProjectId
            ? 'Spremite izmjene da biste ih vidjeli u pregledniku reljefa'
            : 'Spremite projekt da biste ga otvorili u pregledniku reljefa');
}

if (openReliefViewerBtn) {
    openReliefViewerBtn.onclick = () => {
        const base = ReliefViewerLink.reliefViewerBaseUrl(
            window.location, APP_CONFIG.reliefViewerBaseUrl);
        const url = ReliefViewerLink.reliefViewerUrl(base, savedProjectId);
        if (!url) return;
        // A new tab, always: the planner holds editing state that leaving would
        // throw away, and this is a look at the same thing rather than a step
        // in the same task.
        window.open(url, '_blank', 'noopener');
    };
}

// The 2D reference line, drawn for the whole prepared location (the map can be
// panned anywhere in it, and a polyline is cheap where 3D geometry is not).
async function refreshReferenceRailMapLayer() {
    const locationId = getProjectLocationId();
    const supportsConnections = locationSupportsReferenceRail(locationId);
    if (toggleReferenceConnectionBtn) {
        toggleReferenceConnectionBtn.disabled = !projectLifecyclePolicy().canEdit || !supportsConnections;
    }
    if (!supportsConnections) {
        referenceConnectionMode = false;
        referenceRailSnapRequest = null;
    }
    if (!referenceRailVisible) {
        if (referenceRailMapLayer) {
            map.removeLayer(referenceRailMapLayer);
            referenceRailMapLayer = null;
        }
        syncRailSimulationGeometry();
        return 0;
    }
    const bbox = window.__locationRegistry?.REGISTRY?.[locationId]?.bbox;
    if (!bbox) return 0;
    const mapKey = `${locationId}|${savedProjectId ?? 'unsaved'}`;
    if (referenceRailMapRequest?.key !== mapKey) {
        const query = bbox.map(value => Number(value).toFixed(5)).join(',');
        referenceRailMapRequest = {
            key: mapKey,
            location: locationId,
            collection: null,
            promise: fetch(
                // detail=display thins each span server-side: the map draws a
                // dashed polyline for the whole location, where 2,500 points per
                // line buy nothing a 600-point one does not. The 3D reference
                // layer above deliberately does NOT ask for it — the world seats
                // an absolute alignment on real terrain and needs every node.
                `${REFERENCE_RAIL_GEOMETRY_URL}?bbox=${encodeURIComponent(query)}`
                    + referenceRailEditingQuery()
                    + '&detail=display',
                { cache: 'no-store' },
            )
                .then((response) => {
                    if (!response.ok) {
                        throw new Error(`reference-project-geometry ${response.status}`);
                    }
                    return response.json();
                })
                .then((collection) => {
                    if (referenceRailMapRequest?.location === locationId) {
                        referenceRailMapRequest.collection = collection;
                    }
                    return collection;
                })
                .catch((error) => {
                    console.warn('[reference-rail] map layer unavailable:', error?.message || error);
                    referenceRailMapRequest = null;
                    return REFERENCE_RAIL_MAP_LOAD_FAILED;
                }),
        };
    }
    const collection = await referenceRailMapRequest.promise;
    if (collection === REFERENCE_RAIL_MAP_LOAD_FAILED) return null;
    if (!collection?.features?.length || getProjectLocationId() !== locationId) {
        if (referenceRailMapLayer) {
            map.removeLayer(referenceRailMapLayer);
            referenceRailMapLayer = null;
        }
        syncRailSimulationGeometry();
        return 0;
    }
    if (referenceRailMapLayer) map.removeLayer(referenceRailMapLayer);
    referenceRailMapLayer = L.layerGroup(
        collection.features.map(feature => L.polyline(
            (feature.geometry?.coordinates || []).map(([lng, lat]) => [lat, lng]),
            {
                pane: REFERENCE_RAIL_PANE,
                color: '#57534e',
                weight: 2.5,
                opacity: 0.7,
                dashArray: '10 6',
                interactive: false,
            },
        )),
    ).addTo(map);
    syncRailSimulationGeometry();
    return collection.features.length;
}

function fitMapToConnectedReferenceRailContext() {
    const api = window.__railReferenceProjects;
    const collection = referenceRailMapRequest?.collection;
    if (!api?.connectedContext || !collection?.features?.length) return 0;
    const context = api.connectedContext(collection, project.tracks, { toleranceM: 150 });
    if (!context?.connectedFeatureCount) return 0;
    const bounds = L.latLngBounds(
        [context.south, context.west],
        [context.north, context.east],
    );
    if (!bounds.isValid() || map.getBounds().contains(bounds)) {
        return context.connectedFeatureCount;
    }
    map.fitBounds(bounds, {
        animate: true,
        maxZoom: map.getZoom(),
        paddingTopLeft: [24, 24],
        paddingBottomRight: [
            sidebarOpen && !mobileSidebarMedia.matches ? 310 : 24,
            24,
        ],
    });
    return context.connectedFeatureCount;
}

// Builds the combined rail-feature list passed to walk mode so the 3D scene
// shows both an available reference network and user-drawn tracks.
function buildWalkOtherTracks({ photoDatumM = null } = {}) {
    // A city pack's reference network is relevant only inside the locations it
    // declares. Elsewhere, existing rail comes from the provider below.
    const osm = (supportsReferenceSimulation(getProjectLocationId(), 'tram')
        && window.tramSim
        && typeof window.tramSim.getOsmTrackFeatures === 'function')
        ? window.tramSim.getOsmTrackFeatures() || []
        : [];
    const userTracks = (project.tracks || [])
        .filter(t => Array.isArray(t.latlngs) && t.latlngs.length >= 2)
        // Once a photo datum is active, never mix stale level/cut-fill geometry
        // into the fixed-profile corridor. Such a track reappears after its
        // profile is solved; the session remains one coordinate regime.
        .filter(t => !Number.isFinite(photoDatumM) || trackHasFreshAslProfile(t))
        .map(t => {
            const smoothedLatLngs = resampleLatLngsSmooth(t.latlngs, t.gauge);
            const projectId = Number(savedProjectId);
            const trackId = Number(t.id);
            const railPhysicalId = Number.isInteger(projectId) && projectId > 0
                && Number.isInteger(trackId) && trackId > 0
                ? `transit-project-${projectId}-track-${trackId}`
                : null;
            const authoredPhotoProfile = Number.isFinite(photoDatumM)
                && trackHasFreshAslProfile(t);
            // Decide the elevation regime LOCALLY and emit coordinates to
            // match. The old spread of plannerCabTrackElevationProps() leaked
            // the LAST cab session's decision into direct walks — features
            // tagged absolute-EVRF2000 while carrying relative heights (or on
            // a flat world where nothing can seat absolute heights at all).
            const modelGradeTrack = !authoredPhotoProfile
                && modelTerrainActive()
                && trackHasFreshAslProfile(t);
            return {
                type: 'Feature',
                properties: {
                    source: 'user',
                    trackId: t.id,
                    ...(railPhysicalId ? {
                        railPhysicalId,
                        railSourceGeometryHash: currentTrackGeomHash(t),
                    } : {}),
                    trackType: normalizeGauge(t.gauge),
                    ...TRACK_TOPOLOGY_API.normalize(t),
                    // Direct photo walks and cab-launched walks use the same
                    // immutable authored profile; Google only chooses the works.
                    electrified: t.electrified,
                    voltage: t.voltage,
                    frequency: t.frequency,
                    electrificationSegments: t.electrificationSegments,
                    ...(authoredPhotoProfile
                        ? { elevationDatum: 'asl' }
                        : modelGradeTrack
                            ? { elevationMode: 'absolute', elevationDatum: 'EVRF2000' }
                            : {}),
                },
                geometry: {
                    type: 'LineString',
                    // The walk scene receives the same circular horizontal
                    // alignment as train motion, plus the project's localized
                    // ramp elevation sampled at every generated point. In photo/asl
                    // sessions this is authored ASL minus the ONE session datum.
                    coordinates: smoothedLatLngs.map(([lat, lng]) => {
                        const authoredAsl = (authoredPhotoProfile || modelGradeTrack)
                            ? getTrackAbsoluteAslAt(t, lat, lng)?.aslM
                            : null;
                        const elev = Number.isFinite(authoredAsl)
                            ? (authoredPhotoProfile ? authoredAsl - photoDatumM : authoredAsl)
                            : (getTrackElevationAt(t, lat, lng)?.elevM ?? 0);
                        return [lng, lat, roundElevationMeters(elev)];
                    }),
                },
            };
        });
    // The existing railway is drawing-only: it is appended here (otherTracks)
    // and never to driverTracks or customTrackCorridors, so the player cannot
    // drive onto it and the planner's civil works never follow it.
    return osm.concat(userTracks, referenceRailWorldFeatures({ photoDatumM }));
}

function buildPlannerWalkOptions(lat, lng) {
    // A standalone photo walk has no line/cab datum. Use the authored height
    // on the nearest fresh profile as its local origin, then emit every fresh
    // user profile relative to that one value. This keeps walks and rides on
    // the identical alignment without forcing scene coordinates up near ASL.
    const nearestProfile = isPhotoWorld() && Number.isFinite(lat) && Number.isFinite(lng)
        ? findNearestProjectAuthoredTrackAt(lat, lng)
        : null;
    // The datum is one shared offset — any authored point serves, however far
    // the spawn is. The old 200 m gate meant a walk started out in a field
    // emitted every track in legacy levels form: elevated/tunnel spans lost
    // their corridor and rendered as a naked floating ribbon with no civil
    // works. Only a cross-city spawn (different world entirely) skips it.
    const photoDatumM = nearestProfile && nearestProfile.distanceM <= 50000
        ? nearestProfile.aslM
        : null;
    const otherTracks = buildWalkOtherTracks({ photoDatumM });
    const walkStations = Number.isFinite(photoDatumM)
        ? project.stations.filter((station) => {
            const track = project.tracks.find(candidate => candidate.id === station?.trackId);
            return trackHasFreshAslProfile(track);
        })
        : project.stations;
    return {
        otherTracks,
        customTrackCorridors: otherTracks.filter(
            feature => feature?.properties?.source === 'user',
        ),
        allStops: buildPlanner3DStops(walkStations, { photoDatumM }),
        ambientTrainServices: buildPlannerAmbientTrainServices({ photoDatumM }),
        altitudeDatumM: Number.isFinite(photoDatumM) ? photoDatumM : null,
        photoGroundOffsetAt: Number.isFinite(photoDatumM)
            ? (sampleLat, sampleLng, trackId = null) => getProjectDesignGroundOffsetAt(
                sampleLat,
                sampleLng,
                trackId,
            )
            : null,
    };
}

// Compact, renderer-agnostic service definitions for walk mode. Station3D
// owns the visual trains and their wall-clock stepping, while the planner
// remains the authority for route order, station offsets, speed, and dwell.
function buildPlannerAmbientTrainServices({ photoDatumM = null } = {}) {
    const services = [];
    for (const line of project.lines || []) {
        const lineTracks = getTracksUsedByLine(line);
        for (const track of lineTracks) {
            if (!track.motionProfile) buildTrackMotionProfile(track);
        }
        if (line.stationIds?.length >= 2 && !line.motionProfile) {
            buildLineMotionProfileFromStations(line);
        }
        const profile = getLineMotionProfile(line);
        if (!profile?.segments?.length || !(profile.totalLengthMeters > 0)) continue;

        const routeCoordinates = [];
        const appendCoordinate = (latlng) => {
            if (!latlng || !Number.isFinite(latlng.lat) || !Number.isFinite(latlng.lng)) return;
            const previous = routeCoordinates[routeCoordinates.length - 1];
            if (previous
                && Math.abs(previous[0] - latlng.lng) < 1e-9
                && Math.abs(previous[1] - latlng.lat) < 1e-9) {
                return;
            }
            let closestTrack = null;
            let closestDistanceM = Infinity;
            for (const track of lineTracks) {
                const point = nearestPointOnTrack(track, latlng.lat, latlng.lng);
                const distanceM = pointDistanceMeters(point, latlng.lat, latlng.lng);
                if (distanceM < closestDistanceM) {
                    closestDistanceM = distanceM;
                    closestTrack = track;
                }
            }
            const authoredAsl = closestTrack
                ? getTrackAbsoluteAslAt(closestTrack, latlng.lat, latlng.lng)?.aslM
                : null;
            const elevationM = Number.isFinite(photoDatumM) && Number.isFinite(authoredAsl)
                ? authoredAsl - photoDatumM
                : modelTerrainActive() && Number.isFinite(authoredAsl)
                    ? authoredAsl
                    : (getTrackElevationAt(
                        closestTrack,
                        latlng.lat,
                        latlng.lng,
                    )?.elevM ?? 0);
            routeCoordinates.push([
                latlng.lng,
                latlng.lat,
                roundElevationMeters(elevationM),
            ]);
        };
        appendCoordinate(profile.segments[0].start);
        for (const segment of profile.segments) appendCoordinate(segment.end);
        if (routeCoordinates.length < 2) continue;

        const stationStops = (line.stationStops?.length
            ? line.stationStops
            : buildLineStationStops(line))
            .map((stop) => {
                const station = _stationById.get(stop.stationId);
                return {
                    stopId: stop.stationId,
                    name: station ? getStationDisplayName(station) : '',
                    // The 3D world splays the two track centres apart around an
                    // underground island platform, and a train stopping there has
                    // to splay with them. Without the level every stop looked
                    // underground to the ambient trains, which parked them ~4.9 m
                    // to the side of a surface platform — on the grass.
                    level: station ? getStationLevel(station) : 0,
                    positionRatio: Math.max(
                        0,
                        Math.min(1, stop.offsetMeters / profile.totalLengthMeters),
                    ),
                };
            })
            .sort((a, b) => a.positionRatio - b.positionRatio);
        const trackIds = lineTracks.map(track => track.id);
        services.push({
            lineId: line.id,
            lineNumber: line.number ?? line.id,
            trackIds,
            gauge: normalizeGauge(line.gauge),
            routeCoordinates,
            stationStops,
            cruiseSpeedMps: LINE_SPEED_KMH[normalizeGauge(line.gauge)] / 3.6,
            dwellSeconds: getLineStopDwellSeconds(line),
            elevationDatum: Number.isFinite(photoDatumM)
                ? 'asl'
                : modelTerrainActive() && lineHasFullAslCoverage(line)
                    ? 'EVRF2000'
                    : null,
        });
    }
    return services;
}

async function preparePlannerWalkOptions(lat, lng) {
    // The existing-rail reference is part of the scene, so it is fetched before
    // the feature list is assembled — arriving late would mean a session that
    // silently has no railway in it.
    await ensureReferenceRailProjects({ lat, lng });
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return buildPlannerWalkOptions(lat, lng);
    }
    // Profiles and DGU terrain are serialized differently: the authored line
    // is saved, its terrain cache is not. Since the vertical unification the
    // photo world renders EVERY track's corridor no matter where the walk
    // spawns — a track without its asl profile silently degrades to the
    // legacy at-grade-only corridor (elevated/tunnel spans become a naked
    // floating ribbon with no civil works). The old behaviour prepared only
    // a track within 200 m of the click, so a walk started out in a field
    // broke the whole route's rendering. Prepare the closest tracks instead,
    // capped so distant mega-projects stay cheap.
    const candidates = [];
    for (const track of project.tracks || []) {
        if (!Array.isArray(track?.latlngs) || track.latlngs.length < 2) continue;
        const point = nearestPointOnTrack(track, lat, lng);
        if (!point) continue;
        candidates.push({ track, distanceM: pointDistanceMeters(point, lat, lng) });
    }
    candidates.sort((a, b) => a.distanceM - b.distanceM);
    for (const { track } of candidates.slice(0, 6)) {
        if (!trackHasFreshAslProfile(track)) {
            await computeTrackVerticalProfile(track).catch(() => {});
        }
        if (trackHasFreshAslProfile(track)) {
            await ensureTrackTerrainProfile(track);
        }
    }
    return buildPlannerWalkOptions(lat, lng);
}

function pushUniqueLineCoordinate(coords, latlng) {
    if (!latlng || !Number.isFinite(latlng.lng) || !Number.isFinite(latlng.lat)) return;
    const last = coords[coords.length - 1];
    if (last && Math.abs(last[0] - latlng.lng) < 1e-9 && Math.abs(last[1] - latlng.lat) < 1e-9) return;
    coords.push([latlng.lng, latlng.lat]);
}

// Preserve physical-track ownership after a multi-track line is flattened into
// one driveable LineString. Horizontal proximity chooses normally; at stacked
// or crossing tracks (within 0.5 m), authored elevation breaks the tie. Photo
// civil sampling can then request the matching track-scoped DGU ground prior.
function resolvePlannerCabSegmentTrackIds(line, coordinates) {
    const tracks = getTracksUsedByLine(line);
    if (tracks.length === 0 || !Array.isArray(coordinates)) return [];
    const result = [];
    for (let index = 0; index < coordinates.length - 1; index++) {
        const a = coordinates[index];
        const b = coordinates[index + 1];
        const lng = (Number(a?.[0]) + Number(b?.[0])) * 0.5;
        const lat = (Number(a?.[1]) + Number(b?.[1])) * 0.5;
        const targetY = (Number(a?.[2]) + Number(b?.[2])) * 0.5;
        let best = null;
        for (const track of tracks) {
            const point = nearestPointOnTrack(track, lat, lng);
            const distanceM = pointDistanceMeters(point, lat, lng);
            const candidateY = plannerCabModelGradeActive
                ? getTrackAbsoluteAslAt(track, lat, lng)?.aslM
                : getTrackElevationAt(track, lat, lng)?.elevM;
            const elevationDeltaM = Number.isFinite(candidateY) && Number.isFinite(targetY)
                ? Math.abs(candidateY - targetY)
                : Infinity;
            if (!best
                || distanceM < best.distanceM - 0.5
                || (Math.abs(distanceM - best.distanceM) <= 0.5
                    && elevationDeltaM < best.elevationDeltaM)) {
                best = { trackId: track.id, distanceM, elevationDeltaM };
            }
        }
        result.push(best?.trackId ?? null);
    }
    return result;
}

function plannerCabElectrificationProps(line, coordinates) {
    const tracks = getTracksUsedByLine(line);
    if (tracks.length === 0) return {};
    if (tracks.length > 1) {
        const fields = tracks.map(track => window.__trackElectrification.normalizeAuthoredFields(track));
        const first = fields[0];
        return fields.every(item => (
            item.electrified === first.electrified
            && item.voltage === first.voltage
            && item.frequency === first.frequency
        )) ? first : {};
    }
    const track = tracks[0];
    const fields = window.__trackElectrification.normalizeAuthoredFields(track);
    let segments = track.electrificationSegments || [];
    const firstCoordinate = coordinates?.[0];
    const start = track.latlngs?.[0];
    const end = track.latlngs?.at?.(-1);
    if (firstCoordinate && start && end && segments.length) {
        const toStart = (Number(firstCoordinate[0]) - Number(start[1])) ** 2
            + (Number(firstCoordinate[1]) - Number(start[0])) ** 2;
        const toEnd = (Number(firstCoordinate[0]) - Number(end[1])) ** 2
            + (Number(firstCoordinate[1]) - Number(end[0])) ** 2;
        if (toEnd < toStart) {
            const lengthM = track.lengthKm * 1000;
            segments = segments.map(segment => ({
                ...segment,
                fromM: lengthM - Number(segment.toM),
                toM: lengthM - Number(segment.fromM),
            })).reverse();
        }
    }
    return { ...fields, electrificationSegments: segments };
}

function buildPlannerCabTracksForLine(line) {
    if (!line) return [];
    const lineTracks = getTracksUsedByLine(line);
    const trackTopology = TRACK_TOPOLOGY_API.forTracks(lineTracks);
    // A fully-buried metro retains its distance-reparameterised horizontal
    // curve, but receives 3D coordinates just like a mixed-level proposal.
    // This keeps one station/tunnel/access system for every saved proposal.
    if (isLineFullyUnderground(line) && isMetroStyleLine(line)) {
        const undergroundCabProfile = buildUndergroundCabProfile(line);
        if (undergroundCabProfile && undergroundCabProfile.featureCoordinates.length >= 2) {
            const trackIds = lineTracks.map(track => track.id);
            const coordinates = undergroundCabProfile.featureCoordinates.map(([lng, lat]) => [
                lng,
                lat,
                roundElevationMeters(planerCabTrackCoordElevation(line, lat, lng)),
            ]);
            const segmentTrackIds = resolvePlannerCabSegmentTrackIds(line, coordinates);
            return [{
                type: 'Feature',
                properties: {
                    source: 'user-line',
                    lineId: line.id,
                    trackIds,
                    ...(trackIds.length === 1 ? { trackId: trackIds[0] } : {}),
                    segmentTrackIds,
                    trackType: normalizeGauge(line.gauge),
                    ...trackTopology,
                    ...plannerCabElectrificationProps(line, coordinates),
                    ...plannerCabTrackElevationProps(line),
                    ...plannerCabAlignmentProps(line),
                },
                geometry: {
                    type: 'LineString',
                    coordinates,
                },
            }];
        }
    }
    const profile = getLineMotionProfile(line);
    if (!profile || !Array.isArray(profile.segments) || profile.segments.length === 0) return [];
    const coordinates = [];
    for (const segment of profile.segments) {
        pushUniqueLineCoordinate(coordinates, segment.start);
        pushUniqueLineCoordinate(coordinates, segment.end);
    }
    if (coordinates.length < 2) return [];
    for (const coord of coordinates) {
        coord.push(roundElevationMeters(planerCabTrackCoordElevation(line, coord[1], coord[0])));
    }
    const trackIds = lineTracks.map(track => track.id);
    const segmentTrackIds = resolvePlannerCabSegmentTrackIds(line, coordinates);
    return [{
        type: 'Feature',
        properties: {
            source: 'user-line',
            lineId: line.id,
            trackIds,
            ...(trackIds.length === 1 ? { trackId: trackIds[0] } : {}),
            segmentTrackIds,
            trackType: normalizeGauge(line.gauge),
            ...trackTopology,
            ...plannerCabElectrificationProps(line, coordinates),
            ...plannerCabTrackElevationProps(line),
            ...plannerCabAlignmentProps(line),
        },
        geometry: {
            type: 'LineString',
            coordinates,
        },
    }];
}

// Per-mode c[2] for a cab track coordinate:
//  photo (asl)  → authored grade relative to the session datum (levels-free);
//  model grade  → ABSOLUTE EVRF2000 a.s.l. (rail formation seats it directly);
//  fallback     → levels x 10 m.
function planerCabTrackCoordElevation(line, lat, lng) {
    if (plannerCabModelGradeActive) {
        const asl = getLineTrackAbsoluteAslAt(line, lat, lng);
        if (Number.isFinite(asl)) return asl;
    }
    return getLineTrackElevationAt(line, lat, lng);
}

// Feature properties telling station-3d how to read c[2] (see hasAuthoredAbsolute-
// Elevations in rail-formation.js). Absolute EVRF2000 makes the rail FOLLOW the
// authored grade instead of re-designing one over the terrain.
// Marks the cab track as a RECONSTRUCTION of an existing railway when that is
// what the open project is. The world classifies those differently — a solved
// alignment over a resampled 20 m grid otherwise sprouts a minimum-length
// viaduct or tunnel every few hundred metres (see isReconstructedRailFeature in
// station-3d/core/rail-formation.js). Authored projects must NOT carry this:
// their short structures are deliberate.
function plannerCabAlignmentProps(line = null) {
    const tracks = line ? getTracksUsedByLine(line) : [];
    return projectIsReference()
        && tracks.length > 0
        && tracks.every(track => track.reference)
        ? { alignmentSource: 'reference-project' }
        : {};
}

function plannerCabTrackElevationProps(line = null) {
    if (plannerCabAslActive) return { elevationDatum: 'asl' };
    if (plannerCabModelGradeActive) return { elevationMode: 'absolute', elevationDatum: 'EVRF2000' };
    // Flat world: features carry DERIVED levels ×10 (see getTrackElevationAt),
    // so the classic level machinery — planner-elevation tunnels/ramps, surface
    // cutouts, the ±1-keyed underground station structures — renders the
    // profile's regimes exactly as it always rendered manual levels.
    return {};
}

function buildPlannerCabShareUrl(train, line) {
    if (!savedProjectId || projectDirty || !train || !line) return '';
    const projectUrl = getShareProjectUrl();
    if (!projectUrl) return '';
    const url = new URL(projectUrl);
    url.searchParams.set('st3d', 'planner-cab');
    url.searchParams.set('line', String(line.number ?? line.id));
    url.searchParams.set('offset', Math.max(0, Number(train.distanceMeters) || 0).toFixed(1));
    url.searchParams.set('dir', Number(train.direction) < 0 ? '-1' : '1');
    return preserveWorldParams(url.toString());
}

// Force-compute the authored grade for every track a line uses, now. The
// profile is normally solved async on load/edit; a ride that opens before that
// finishes (a fresh page, or a shared photo deeplink that opens the cab during
// load) would find no profile and silently ride flat levels instead.
// Passes, not one shot — see the loop below for why one call cannot be trusted.
// Two is the expected worst case (solve, then re-solve against the spans that
// solve revealed); the third exists only so a genuine failure is reported rather
// than silently riding on a missing grade.
const ENSURE_PROFILE_PASSES = 3;

async function ensureLineTrackProfiles(line, { includeTerrain = false } = {}) {
    if (!window.__verticalProfile || !window.__plannerGrade) {
        return {
            ready: false,
            staleTrackIds: [],
            terrainReady: false,
            terrainMissingTrackIds: [],
        };
    }
    const tracks = getTracksUsedByLine(line);
    // TERRAIN FIRST, then solve. Terrain arrival re-classifies a station between
    // full/compact/cut, which changes its profile half-span, which changes the
    // hash the vertical profile is stamped with — so a profile solved before the
    // terrain lands is invalidated by the terrain landing. It solved correctly
    // and was stale seconds later, trackHasFreshAslProfile() said no for the rest
    // of the session, and the planner cab fell back to flat-world track props
    // inside a world built on real terrain. That is what put a viaduct over the
    // Split ride's own track.
    if (includeTerrain) {
        const terrainPending = tracks.filter(track => !trackHasFreshTerrainProfile(track));
        await Promise.all(terrainPending.map(track => fetchTerrainProfileForTrack(track).catch((error) => {
            console.warn(`[grade] terrain profile for track ${track.id} failed:`, error?.message || error);
        })));
    }
    const terrainMissing = includeTerrain
        ? tracks.filter(track => !trackHasFreshTerrainProfile(track))
        : [];
    // Then solve, RETRYING until the profiles are actually fresh.
    //
    // computeTrackVerticalProfile awaits the terrain, then re-checks the hash it
    // captured before that await; when it has moved it hands the work to a
    // debounced timer and RESOLVES ANYWAY. Awaiting it therefore proves only
    // that a solve was scheduled, not that a profile exists — which is how the
    // cab opened on a track with no grade at all. One pass is enough now that
    // terrain lands first, but the loop is what makes the promise mean what the
    // caller reads it as.
    for (let pass = 1; pass <= ENSURE_PROFILE_PASSES; pass += 1) {
        const pending = tracks.filter(track => !trackHasFreshAslProfile(track));
        if (!pending.length) break;
        await Promise.all(pending.map(track => computeTrackVerticalProfile(track).catch((error) => {
            // Never swallow this. A failed solve leaves the track with no usable
            // grade, and the caller's `_profilesEnsured` flag means "we tried",
            // not "we have it" — so the ride opens anyway, on whatever it can guess.
            console.warn(`[grade] vertical profile for track ${track.id} failed`
                + ` (pass ${pass}):`, error?.stack || error);
        })));
    }
    const stale = tracks.filter(track => !trackHasFreshAslProfile(track));
    if (stale.length) {
        console.warn('[grade] these tracks still have no fresh vertical profile after'
            + ` ensure: ${stale.map(track => track.id).join(', ')}.`
            + ' The ride will use flat-world levels; in a terrain world that builds the'
            + ' civil works twice, at two different heights.');
    }
    return {
        ready: stale.length === 0,
        staleTrackIds: stale.map(track => track.id),
        terrainReady: terrainMissing.length === 0,
        terrainMissingTrackIds: terrainMissing.map(track => track.id),
    };
}

function openPlannerTrainCab(train, line, opts = {}) {
    if (!train || !line || !window.Station3D) return false;
    hidePlannerCabHint();
    const openGeneration = Number.isInteger(opts._planner3DGeneration)
        ? opts._planner3DGeneration
        : beginPlanner3DOpenIntent();
    if (!planner3DOpenIntentIsCurrent(openGeneration)) return false;
    if (!(project.lines || []).includes(line) || !(line.trains || []).includes(train)) return false;
    // Both sims ride the same authored grade, and BOTH need the runtime DGU
    // terrain cache (not serialized with saved projects): photo for its one
    // Google registration tie, the model worlds to express the authored asl
    // profile — as absolute heights over real terrain, or as cut/fill offsets
    // over a flat world. Without it, flat rides silently fell back to the
    // coarse ±1 levels and never showed the designed vertical alignment.
    const needsProfile = !lineHasFullAslCoverage(line);
    const needsTerrain = !lineHasFullTerrainCoverage(line);
    // The existing-rail reference rides the same pre-step: the rail layer builds
    // its features once at session start, so spans arriving afterwards would be
    // missed and the ride would run past an invisible railway.
    const needsReferenceRail = referenceRailVisible && !referenceRailRequestIsCurrent();
    // Claim the train NOW, before the preflight below can await anything. The
    // caller has already parked it where the user clicked; until the cab takes
    // over, tickTrainAnimations is still stepping it — at the map clock's 4×, so
    // a second of terrain fetching drove it tens of metres down the line and the
    // ride opened past the thing the user clicked on. _cabRidden is what makes
    // that loop leave it alone, so it has to be set here rather than once the
    // preflight has resolved.
    train._cabRidden = true;
    train._cabStepMs = null;
    if ((needsProfile || needsTerrain || needsReferenceRail) && !opts._profilesEnsured) {
        setStatusMessage(needsProfile
            ? 'Računam visinski profil…'
            : needsTerrain
                ? 'Dohvaćam visinski teren…'
                : 'Dohvaćam postojeću željezničku mrežu…');
        Promise.all([
            ensureLineTrackProfiles(line, { includeTerrain: true }),
            ensureReferenceRailProjects(),
        ])
            .then(([profileResult]) => {
                if (!planner3DOpenIntentIsCurrent(openGeneration)) {
                    train._cabRidden = false;
                    return;
                }
                if (!profileResult?.ready || !profileResult?.terrainReady) {
                    throw new Error('terrain/profile preflight did not complete');
                }
                return openPlannerTrainCab(train, line, {
                    ...opts,
                    _profilesEnsured: true,
                    _planner3DGeneration: openGeneration,
                });
            })
            .catch((error) => {
                // The cab is not coming, so hand the train back to the map loop.
                train._cabRidden = false;
                if (!planner3DOpenIntentIsCurrent(openGeneration)) return;
                console.error('[planner-cab] terrain/profile preflight failed:', error?.stack || error);
                setStatusMessage(
                    'Nije moguće dohvatiti visinski teren. Pokušajte ponovno.',
                    true,
                );
                document.querySelectorAll('.sel-popup-btn-3d.is-loading')
                    .forEach(clearPopupButtonBusy);
            });
        return true;
    }
    // ASL elevations (M4): decided per session, BEFORE any geometry is built,
    // so tracks, stops and the pose profile all resolve through one datum.
    const aslGeneration = ++plannerCabAslGeneration;
    plannerCabAslActive = isPhotoWorld() && lineHasFullAslCoverage(line);
    plannerCabAslDatumM = 0;
    if (plannerCabAslActive) {
        const anchor = train.marker?.getLatLng?.()
            || (line.stationIds?.length ? _stationById.get(line.stationIds[0])?.latlng : null);
        const anchorLat = anchor?.lat ?? (Array.isArray(anchor) ? anchor[0] : null);
        const anchorLng = anchor?.lng ?? (Array.isArray(anchor) ? anchor[1] : null);
        if (Number.isFinite(anchorLat) && Number.isFinite(anchorLng)) {
            // Datum = authored elevation at the boarding point (sampled with
            // datum 0, so the resolver returns raw a.s.l. here).
            plannerCabAslDatumM = getLineTrackElevationAt(line, anchorLat, anchorLng);
        } else {
            plannerCabAslActive = false;
        }
    }
    // Model ride with a full grade → drive the rail off absolute EVRF2000
    // elevations (authored grade), not the terrain-draped auto design.
    // ONLY when the model terrain surface is actually on: absolute heights are
    // seated by the rail formation, which exists only with a terrain reference.
    // On a flat world (Zagreb default) they would hang the whole alignment and
    // its stations ~100 m above the ground plane.
    plannerCabModelGradeActive = !plannerCabAslActive
        && lineHasFullAslCoverage(line)
        && modelTerrainActive();
    const plannerCabTracks = buildPlannerCabTracksForLine(line);
    const plannerCabStops = buildPlannerCabStopsForLine(line);
    const canShareSavedRide = !!savedProjectId && !projectDirty;
    let opened = false;
    plannerCabReplacementOpening = true;
    // From now on the cab is the sole stepper for this train (see stepPlannerTrain
    // + tickTrainAnimations, which skips _cabRidden trains). Reset its wall clock
    // so the first poseFn step has dt≈0.
    train._cabRidden = true;
    train._cabStepMs = null;
    try {
        opened = window.Station3D.openCab(train, line, makeTrainPoseFn(train, line), {
        // Plan proposals (?plan= deeplink) — the district around the line.
        // Null for ordinary rides; the deeplink applier resolves them.
        proposalIds: opts.proposalIds || null,
        prefetchedProposals: opts.prefetchedProposals || null,
        // Planner lines are new, smooth rails — no old rail-joint "clang" sounds
        // in bends the way the legacy OSM city-tram network has.
        suppressTrackClangs: true,
        // Every planner line is drivable, underground included: a train runs on
        // the same rails with the same controls, only the track is wider. The
        // driver builds its graph from the line's own geometry, exactly as the
        // consensus-builder cab does.
        driverUnavailableMessage: 'Ručna vožnja na ovoj trasi nije moguća — trasa nema vozivu geometriju.',
        driverTracks: plannerCabTracks,
        otherTrainsFn: makeOtherTrainsFn(train),
        // Existing rail is visible from the cab but is NOT part of driverTracks or
        // customTrackCorridors — the ride stays on the authored line.
        otherTracks: plannerCabTracks.concat(referenceRailWorldFeatures({
            photoDatumM: plannerCabAslActive ? plannerCabAslDatumM : null,
        })),
        allStops: plannerCabStops,
        ambientTrainServices: buildPlannerAmbientTrainServices({
            photoDatumM: plannerCabAslActive ? plannerCabAslDatumM : null,
        }),
        customTrackCorridors: plannerCabTracks,
        // The legacy dedicated underground scene had a separate station model
        // and no surface exits. Planner routes now always use the unified,
        // elevation-aware world; their own geometry supplies the tunnel.
        isUndergroundSession: false,
        isTrainSession: isMetroStyleLine(line),
        trackBaseY: 0,
        shareRideUrlProvider: canShareSavedRide
            ? () => buildPlannerCabShareUrl(train, line)
            : null,
        // Authored altitude of relative profile y=0. Station3D uses it to build
        // the exact WGS84 tangent-frame alignment; Google is tied to it once.
        altitudeDatumM: plannerCabAslActive ? plannerCabAslDatumM : null,
        // Preserve the authored track-vs-DGU relationship at whichever route
        // point this cab/walk session starts. This remains a scalar registration
        // constraint; it never becomes a pointwise terrain drape.
        photoGroundOffsetAt: plannerCabAslActive
            ? (lat, lng, trackId = null) => getLineDesignGroundOffsetAt(
                line,
                lat,
                lng,
                trackId,
            )
            : null,
        // Google-ground a.s.l. samples captured along the ride — accumulated onto
        // the line's tracks so the elevation strip can overlay the real photo
        // surface (see accumulateLinePhotoGround). Only meaningful in asl.
        onPhotoGroundSamples: plannerCabAslActive
            ? (samples) => accumulateLinePhotoGround(line, samples)
            : null,
        onClose: () => {
            if (train.awaitingRailChoice) {
                closeRailConnectionChoice();
                train.awaitingRailChoice = false;
                train.pauseRemainingSeconds = getLineStopDwellSeconds(line);
                train.pendingDirection = -train.direction;
            }
            line.cabRealtimeMotion = false;
            train._cabRidden = false;
            if (!plannerCabReplacementOpening) {
                planner3DOpenGeneration += 1;
            }
            if (aslGeneration === plannerCabAslGeneration) {
                plannerCabAslActive = false;
                plannerCabAslDatumM = 0;
                plannerCabModelGradeActive = false;
            }
        },
        });
    } finally {
        plannerCabReplacementOpening = false;
    }
    // openCab closes any previous ride synchronously, so set this after it
    // returns; the old ride's onClose cannot clear the newly opened cab.
    line.cabRealtimeMotion = !!opened;
    train._cabRidden = !!opened;
    return !!opened;
}

async function applyPlannerCab3DLink(options = {}) {
    const lineRef = String(options.line ?? '').trim();
    if (!savedProjectId) throw new Error('Za kabinu prijedloga trebate zadati spremljeni projekt.');
    if (!lineRef) throw new Error('Za kabinu prijedloga trebate zadati parametar line.');
    await waitForStation3D();

    const line = project.lines.find(candidate =>
        String(candidate.number ?? '') === lineRef || String(candidate.id) === lineRef);
    if (!line) throw new Error(`Linija ${lineRef} ne postoji u ovom projektu.`);
    const profile = getLineMotionProfile(line);
    if (!profile || profile.totalLengthMeters <= 0) {
        throw new Error(`Linija ${lineRef} nema valjanu voznu trasu.`);
    }

    const requestedOffset = Number(options.offset);
    const offset = Number.isFinite(requestedOffset)
        ? Math.max(0, Math.min(profile.totalLengthMeters, requestedOffset))
        : 0;
    let train = (line.trains || []).reduce((closest, candidate) => {
        if (!closest) return candidate;
        return Math.abs((candidate.distanceMeters || 0) - offset)
            < Math.abs((closest.distanceMeters || 0) - offset)
            ? candidate
            : closest;
    }, null);
    if (!train) train = addTrainToLine(line, offset);
    if (!train) throw new Error(`Nije moguće pripremiti vozilo na liniji ${lineRef}.`);

    train.distanceMeters = offset;
    train.direction = Number(options.direction) < 0 ? -1 : 1;
    train.pendingDirection = null;
    train.pauseRemainingSeconds = 0;
    train.pausedStationId = null;
    updateTrainMarker(train, line);
    // Hold the exact deeplink offset while proposal data is fetched. The map
    // animation must not advance this train before the cab owns it.
    train._cabRidden = true;
    train._cabStepMs = null;
    // ?plan= (or ?proposals=) rides along: the walk deeplink already resolves
    // it, and a cab over the same corridor without the plan is bare karst —
    // measured on the Šibenik flight, where the whole district was missing.
    // The records go in as prefetched proposals only; the rail stays the
    // project's own line, so a track proposal never doubles it.
    let planProposals = null;
    try {
        const fetched = await fetchPlanProposalRecords(null);
        if (fetched.proposalIds.length > 0) planProposals = fetched;
    } catch (error) {
        console.warn('[planner-cab] plan proposals failed to load:', error?.message || error);
    }
    let opened = false;
    try {
        opened = openPlannerTrainCab(train, line, {
            proposalIds: planProposals ? planProposals.proposalIds : null,
            prefetchedProposals: planProposals ? planProposals.loaded : null,
        });
    } catch (error) {
        train._cabRidden = false;
        throw error;
    }
    if (!opened) {
        train._cabRidden = false;
        throw new Error('Otvaranje kabine prijedloga nije uspjelo.');
    }
    setStatusMessage(`Otvorena kabina na liniji ${escapeHtml(line.number ?? line.id)}.`);
}

function getPlannerStationElevationMeters(station, { photoDatumM = null } = {}) {
    const track = station?.trackId != null
        ? project.tracks.find(candidate => candidate.id === station.trackId)
        : null;
    if (Number.isFinite(photoDatumM)) {
        const authoredAsl = getTrackAbsoluteAslAt(
            track,
            station?.latlng?.[0],
            station?.latlng?.[1],
        )?.aslM;
        if (Number.isFinite(authoredAsl)) return authoredAsl - photoDatumM;
    }
    // Model world with terrain: the scene is seated at absolute EVRF2000 and
    // buildWalkOtherTracks emits this track's coordinates that way, so the stop
    // MUST be in the same frame. Emitting it as level × 10 put the station box
    // ten metres below an origin while its own route was a hundred metres up —
    // one payload carrying two vertical frames. The station has an absolute
    // elevation exactly like the track does; there was never a reason to
    // quantise it back into ±1. (platforms.js already converts an absolute stop
    // through terrain.absoluteToSceneY, the same path the rail formation rides.)
    if (modelTerrainActive() && trackHasFreshAslProfile(track)) {
        const authoredAsl = getTrackAbsoluteAslAt(
            track,
            station?.latlng?.[0],
            station?.latlng?.[1],
        )?.aslM;
        if (Number.isFinite(authoredAsl)) return authoredAsl;
    }
    // Flat world only: the station's OWN level, never the interpolated track
    // level. A station is a level structure and the flat world builds its hall,
    // platform and stairs at level × 10 m — but getTrackElevationAt returns the
    // CONTINUOUS level, which ramp shaping drags to fractional values right
    // where a station sits (−0.695 at a platform whose floor is at −1), so the
    // walker spawned 3 m above the trackbed.
    return getStationLevel(station) * LEVEL_HEIGHT_METERS;
}

function buildPlannerCabStopsForLine(line) {
    if (!line) return [];
    return getLineServiceStations(line)
        .filter((station) => Array.isArray(station.latlng))
        .map((station) => ({
            stopId: station.id,
            trackId: station.trackId,
            lat: station.latlng[0],
            lng: station.latlng[1],
            elevM: getPlannerStationElevationMeters(station),
            level: getStationLevel(station),
            // Level 0 also contains open-cut stations. The 3D civil-works
            // planner needs the saved structural form so it can reserve a
            // widened platform bay and access stair instead of treating the
            // stop as ordinary ground-level furniture.
            structureKind: getStationStructureKind(trackForStation(station), station),
            name: getStationDisplayName(station),
            stationType: station.stationType,
        }));
}

function buildPlanner3DStops(stations = project.stations, { photoDatumM = null } = {}) {
    return (stations || [])
        .filter(station => station && Array.isArray(station.latlng))
        .map(station => ({
            stopId: station.id,
            trackId: station.trackId,
            lat: station.latlng[0],
            lng: station.latlng[1],
            elevM: getPlannerStationElevationMeters(station, { photoDatumM }),
            level: getStationLevel(station),
            structureKind: getStationStructureKind(trackForStation(station), station),
            name: getStationDisplayName(station),
            stationType: station.stationType,
        }));
}

// Where the walker's feet go, in SCENE Y — which is not the same number the
// stops carry.
//
// A stop's elevM is whatever frame that session's geometry uses: relative to the
// photo datum, absolute EVRF2000 on a model terrain world, or levels × 10 on a
// flat one. Only the last of those is already scene Y. The model terrain world
// anchors scene Y on the DGU height under the SPAWN POINT
// (TerrainGrid.absoluteToSceneY subtracts anchorHeightM, sampled exactly there),
// so scene Y for a station is its authored a.s.l. minus the terrain a.s.l. above
// it — the station's own depth. Handing the raw a.s.l. through spawned the
// walker a hundred metres up, in the sky over the city.
function getPlannerStationSceneYMeters(station, { photoDatumM = null } = {}) {
    const elevM = getPlannerStationElevationMeters(station, { photoDatumM });
    if (Number.isFinite(photoDatumM) || !Number.isFinite(elevM)) return elevM;
    const track = station?.trackId != null
        ? project.tracks.find(candidate => candidate.id === station.trackId)
        : null;
    if (modelTerrainActive() && trackHasFreshAslProfile(track)) {
        const dM = trackChainageAtLatLng(track, station.latlng[0], station.latlng[1]);
        const terrainAslM = terrainAslAtChainage(track, dM);
        if (Number.isFinite(terrainAslM)) return elevM - terrainAslM;
    }
    return elevM;
}

function getPlannerStationViewPose(station, { photoDatumM = null } = {}) {
    const level = getStationLevel(station);
    const stationDescription = level < 0 && window.__stationContract
        ? window.__stationContract.describeStation(
            window.__stationContract.UNDERGROUND_STATION_TYPE_ID,
            { runningTrackSpacingM: getTrackCenterSpacingMeters('g1435') },
        )
        : null;
    const platformTopOffsetM = Number(
        stationDescription?.occupancy?.platformTopAboveRailM,
    );
    const initialGroundY = level < 0
        ? getPlannerStationSceneYMeters(station, { photoDatumM })
            + (Number.isFinite(platformTopOffsetM)
                ? platformTopOffsetM
                : UNDERGROUND_3D_VIEW_ISLAND_PLATFORM_TOP_OFFSET_METERS)
        : null;
    const track = station?.trackId != null ? project.tracks.find(item => item.id === station.trackId) : null;
    if (!track || !Array.isArray(track.latlngs) || track.latlngs.length < 2) {
        return {
            lat: station.latlng[0],
            lng: station.latlng[1],
            headingDeg: 0,
            level,
            initialGroundY,
        };
    }
    const viewLatLngs = resampleLatLngsSmooth(track.latlngs, track.gauge);
    const snap = nearestPointOnTrack({ latlngs: viewLatLngs }, station.latlng[0], station.latlng[1]);
    const segmentIndex = Math.max(0, Math.min(viewLatLngs.length - 2, snap?.segmentIndex ?? 0));
    const a = viewLatLngs[segmentIndex];
    const b = viewLatLngs[segmentIndex + 1];
    const meanLatRad = ((a[0] + b[0]) * 0.5) * DEG_TO_RAD;
    const east = (b[1] - a[1]) * Math.cos(meanLatRad);
    const north = b[0] - a[0];
    const length = Math.hypot(east, north) || 1;
    const rightEast = north / length;
    const rightNorth = -east / length;
    // Underground "Vidi" starts safely on top of the centre island. Surface
    // stations retain the right-hand-track viewpoint used by the planner.
    const offsetM = level < 0 ? 0 : TRACK_TOPOLOGY_API.rightHandCenterOffsetM(
        TRACK_TOPOLOGY_API.normalize(track),
        UNDERGROUND_TRACK_CENTER_SPACING_METERS,
    );
    const routeLat = snap?.lat ?? station.latlng[0];
    const routeLng = snap?.lon ?? station.latlng[1];
    const lat = routeLat + (rightNorth * offsetM / EARTH_RADIUS_M) / DEG_TO_RAD;
    const lng = routeLng
        + (rightEast * offsetM / (EARTH_RADIUS_M * Math.cos(routeLat * DEG_TO_RAD))) / DEG_TO_RAD;
    const headingDeg = Math.atan2(east, north) * 180 / Math.PI;
    return { lat, lng, headingDeg, level, initialGroundY };
}

async function openPlannerStationIn3D(station) {
    if (!station || !window.Station3D) return false;
    const openGeneration = beginPlanner3DOpenIntent();
    const initialView = getPlannerStationViewPose(station);
    const walkOptions = await preparePlannerWalkOptions(initialView.lat, initialView.lng);
    if (!planner3DOpenIntentIsCurrent(openGeneration)) return false;
    const view = getPlannerStationViewPose(station, {
        photoDatumM: walkOptions.altitudeDatumM,
    });
    return window.Station3D.openWalk(view.lat, view.lng, {
        titleOverride: getStationDisplayName(station),
        initialHeadingDeg: view.headingDeg,
        initialLookPitchDeg: view.level < 0 ? -3 : -8,
        ...walkOptions,
        ...(view.initialGroundY == null ? {} : {
            initialY: view.initialGroundY,
            initialGroundY: view.initialGroundY,
        }),
    });
}

// Small reusable walk popup; recreated on each click.
function closeWalkPopup() {
    if (terrainElevationAbortController) {
        terrainElevationAbortController.abort();
        terrainElevationAbortController = null;
    }
    if (!walkPopup) return;
    walkPopup.remove();
    walkPopup = null;
}

async function loadTerrainElevationReadout(latlng, readout, valueEl, metaEl) {
    if (!TERRAIN_MAP_API || !terrainMapVisible) return;
    if (terrainElevationAbortController) terrainElevationAbortController.abort();
    const controller = new AbortController();
    terrainElevationAbortController = controller;
    try {
        const response = await fetch(TERRAIN_MAP_API.elevationUrl(
            API_BASE_URL,
            latlng.lat,
            latlng.lng,
            getTerrainMapSource(),
        ), { signal: controller.signal });
        if (!response.ok) throw new Error(`terrain elevation HTTP ${response.status}`);
        const presentation = TERRAIN_MAP_API.elevationPresentation(await response.json());
        if (controller.signal.aborted || terrainElevationAbortController !== controller) return;
        valueEl.textContent = presentation.valueText;
        metaEl.textContent = presentation.metaText;
        readout.title = presentation.title;
        readout.setAttribute('aria-label', presentation.title);
    } catch (error) {
        if (error.name === 'AbortError') return;
        console.warn('[terrain-map] point elevation failed:', error?.message || error);
        valueEl.textContent = 'Visina nedostupna';
        metaEl.textContent = 'Pokušajte ponovno';
        readout.title = 'Visinski podatak nije moguće učitati.';
    } finally {
        if (terrainElevationAbortController === controller) {
            terrainElevationAbortController = null;
        }
    }
}

function showWalkPopup(latlng) {
    if (currentMode !== 'explore') return;
    closeWalkPopup();
    // A dot marks the exact clicked point; the pill hangs to its RIGHT
    // (× first, then the action), rendered as a divIcon marker so the mark
    // stays glued to the location while the pill never covers it.
    const container = document.createElement('div');
    container.className = 'walk-popup-anchor';
    const mark = document.createElement('span');
    mark.className = 'walk-popup-mark';
    container.appendChild(mark);
    // Facing chevron: the walk drops the user looking NORTH (openWalk's
    // default heading) — show it before they commit.
    const facing = document.createElement('span');
    facing.className = 'walk-popup-facing';
    container.appendChild(facing);
    const pill = document.createElement('div');
    pill.className = 'walk-popup-pill';
    let elevationReadout = null;
    let elevationValue = null;
    let elevationMeta = null;
    if (terrainMapVisible && TERRAIN_MAP_API) {
        pill.classList.add('has-terrain-elevation');
        elevationReadout = document.createElement('span');
        elevationReadout.className = 'terrain-elevation-readout';
        elevationReadout.setAttribute('role', 'status');
        elevationReadout.setAttribute('aria-live', 'polite');
        elevationValue = document.createElement('strong');
        elevationValue.className = 'terrain-elevation-value';
        elevationValue.textContent = 'Visina…';
        elevationMeta = document.createElement('span');
        elevationMeta.className = 'terrain-elevation-meta';
        elevationMeta.textContent = CITY_CONFIG.providerLabels?.terrain || ui('Terrain', 'Teren');
        elevationReadout.append(elevationValue, elevationMeta);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'walk-popup-btn';
    // Inline SVG walker + separate label span: emoji glyphs carry font-specific
    // ascent bias that reads as top margin at this size — SVG boxes are
    // metrically exact (same treatment as the × cell).
    const setWalkBtnLabel = () => {
        btn.innerHTML = '<span class="walk-popup-btn-icon" aria-hidden="true">'
            + '<svg width="14" height="16" viewBox="0 0 14 16">'
            + '<circle cx="7.6" cy="2.1" r="1.9" fill="currentColor"/>'
            + '<path d="M7.4 5 L6.2 9.2 L3.4 15 M6.2 9.2 L9 12 L9.6 15 M7.4 5 L4.6 7.6 L3.6 9.6 M7.4 5 L9.8 6.4 L11.4 8.6"'
            + ' stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
            + '</svg></span><span>Šetnja</span>';
    };
    setWalkBtnLabel();
    btn.onclick = async () => {
        if (btn.disabled) return;
        const openGeneration = beginPlanner3DOpenIntent();
        // Freeze map-click handling while the world builds: the build janks
        // the main thread for seconds, and clicks queued during the freeze
        // replayed onto the MAP afterwards — respawning the pill elsewhere.
        walkOpenPending = true;
        const restoreButton = () => {
            walkOpenPending = false;
            btn.disabled = false;
            btn.classList.remove('is-loading');
            btn.removeAttribute('aria-busy');
            setWalkBtnLabel();
        };
        btn.disabled = true;
        btn.classList.add('is-loading');
        btn.setAttribute('aria-busy', 'true');
        btn.innerHTML = '<span class="sel-popup-btn-loader" aria-hidden="true"></span><span>Učitavam…</span>';
        try {
            // Let the spinner reach the screen before Station3D performs its
            // synchronous initial world build, which can take several seconds.
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            if (!planner3DOpenIntentIsCurrent(openGeneration)) {
                restoreButton();
                return;
            }
            const station3D = window.Station3D || await waitForStation3D();
            const walkOptions = await preparePlannerWalkOptions(latlng.lat, latlng.lng);
            if (!planner3DOpenIntentIsCurrent(openGeneration)) {
                restoreButton();
                return;
            }
            const opened = station3D.openWalk(latlng.lat, latlng.lng, {
                ...walkOptions,
            });
            if (opened === false) throw new Error('Station3D nije mogao otvoriti šetnju.');
            walkOpenPending = false;
            closeWalkPopup();
        } catch (error) {
            console.error('3D walk open error:', error);
            restoreButton();
            setStatusMessage('Otvaranje 3D šetnje nije uspjelo.', true);
        }
    };
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'walk-popup-close';
    closeBtn.setAttribute('aria-label', 'Zatvori');
    // An inline SVG cross is metrically exact — the '×' glyph carries
    // font-specific baseline bias that reads as off-centre at this size.
    closeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">'
        + '<path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    closeBtn.onclick = closeWalkPopup;
    pill.appendChild(closeBtn);
    if (elevationReadout) pill.appendChild(elevationReadout);
    pill.appendChild(btn);
    container.appendChild(pill);
    L.DomEvent.disableClickPropagation(container);
    walkPopup = L.marker(latlng, {
        icon: L.divIcon({
            className: 'walk-popup-icon',
            html: container,
            iconSize: [0, 0],
            iconAnchor: [0, 0],
        }),
        interactive: true,
        keyboard: false,
    }).addTo(map);
    if (elevationReadout) {
        void loadTerrainElevationReadout(
            latlng,
            elevationReadout,
            elevationValue,
            elevationMeta,
        );
    }
}

map.on('click', function (e) {
    // Edit mode owns the map. Empty-map clicks neither deselect the route
    // nor open catchment/Šetnja UI; only hit layers, nodes, and stations act.
    if (currentMode === 'edit') return;
    // Clicks queued while a 3D walk is building must not respawn/move the
    // walk pill or deselect anything — the user already committed to a walk.
    if (walkOpenPending) return;

    // A click inside the same screen-space radius used for highlighting belongs
    // to the track even if Leaflet's overlapping transparent strokes missed it.
    const nearbyTrack = currentMode !== 'drawLine' && currentMode !== 'placeStation'
        ? nearestTrackInScreenSpace(e.latlng)
        : null;
    if (nearbyTrack) {
        if (currentMode === 'edit') {
            removePreviewVertex();
            insertTrackVertex(nearbyTrack, e.latlng.lat, e.latlng.lng);
        } else if (selectedObject?.type === 'track' && selectedObject.id === nearbyTrack.id) {
            renderSelectionSheet();
        } else {
            selectObject('track', nearbyTrack.id, nearbyTrack, e.latlng);
        }
        return;
    }

    // If an object is selected, deselect it on background click
    if (selectedObject) {
        deselectObject();
        return;
    }

    if (currentMode === 'drawLine') {
        handleLineClick(e);
    } else if (currentMode === 'placeStation') {
        handleStationPlacementClick(e);
    } else if (currentMode === 'explore') {
        handleExploreClick(e);
    } else {
        // Simulation mode: show walk-here popup on any empty map click.
        showWalkPopup(e.latlng);
    }
});

// The pill is a marker now, not a Leaflet popup, so it no longer auto-closes
// on map interaction — close it before any map click lands (the pill's own
// buttons don't propagate to the map, and a spawning click re-shows it).
// While a walk-open is in flight the loading pill must survive stray clicks.
map.on('preclick', () => { if (!walkOpenPending) closeWalkPopup(); });

map.on('dblclick', function (e) {
    if (currentMode === 'drawLine' && currentLinePoints.length >= 2) {
        L.DomEvent.preventDefault(e);
        finishCurrentTrack();
    }
});

map.on('moveend', function () {
    if (!activeHeatmapField || heatmapLoadingField) return;
    loadHeatmap(activeHeatmapField, { preserveStatus: true }).catch(error => {
        console.error('Heatmap refresh error:', error);
    });
});

// Disable default double-click zoom when drawing
map.doubleClickZoom.disable();

// ─── Catchment Mode Handler ─────────────────────────────────────────────────
async function renderCatchmentCheckerAt(latlng) {
    const walkMinutes = getCurrentWalkMinutes();

    if (walkMinutes <= 0) {
        if (catchmentLayer) { map.removeLayer(catchmentLayer); catchmentLayer = null; }
        if (catchmentMarker) { map.removeLayer(catchmentMarker); catchmentMarker = null; }
        showDisabledCatchmentStatsPanel();
        setStatusMessage('Doseg isključen.');
        return;
    }

    const requestToken = ++catchmentRequestToken;

    loadingDiv.classList.remove('hidden');
    setStatusMessage(`Računam doseg za ${walkMinutes} min hodanja...`);

    try {
        const polygonData = await fetchPedestrianCatchment(latlng.lat, latlng.lng, walkMinutes);
        if (requestToken !== catchmentRequestToken) return;

        if (catchmentLayer) map.removeLayer(catchmentLayer);
        catchmentLayer = L.geoJSON(polygonData, {
            style: { color: CHECKER_CATCHMENT_COLOR, fillColor: CHECKER_CATCHMENT_COLOR, fillOpacity: 0.2, weight: 2 },
            interactive: false,
        }).addTo(map);

        if (catchmentMarker) map.removeLayer(catchmentMarker);
        catchmentMarker = L.marker(latlng, {
            icon: catchmentOriginIcon,
            interactive: false,
            keyboard: false,
        }).addTo(map);

        setStatusMessage(`Doseg prikazan: ${walkMinutes} min hodanja.`);

        const geometry = getOutermostPolygon(polygonData);
        if (geometry) {
            const stats = await fetchCatchmentStats(geometry);
            if (requestToken !== catchmentRequestToken) return;
            updateCatchmentStatsPanel(stats);
        }
    } catch (err) {
        if (requestToken !== catchmentRequestToken) return;
        console.error(err);
        setStatusMessage(err.message, true);
    } finally {
        if (requestToken === catchmentRequestToken) {
            loadingDiv.classList.add('hidden');
        }
    }
}

async function handleExploreClick(e) {
    // Explore mode owns catchments and the walk action. New route/station
    // creation is armed only by the persistent map toolbar, so background
    // clicks cannot accidentally switch from geometry editing into drawing.
    const latlng = e.latlng;
    removeStationPicker();
    await renderCatchmentCheckerAt(latlng);
    showWalkPopup(latlng);
}

function handleStationPlacementClick(e) {
    const trackSnap = project.tracks.length > 0 ? snapToTrack(e.latlng.lat, e.latlng.lng, 50) : null;
    if (trackSnap) {
        // Show picker at the click position so the cursor lands on the first button;
        // the actual station will be placed at the snapped position on the track.
        showStationPicker(e.latlng);
        return;
    }
    setStatusMessage('Kliknite bliže trasi na kojoj želite postaviti stanicu.', true);
}

function refreshActiveCatchmentChecker() {
    if (!catchmentMarker) return;
    return renderCatchmentCheckerAt(catchmentMarker.getLatLng());
}

walkTimeOptions.forEach(option => {
    option.addEventListener('change', async () => {
        if (!option.checked) return;
        syncWalkTimeControls(option.value, { persist: true });
        if (currentMode === 'placeStation' && lastSnappedLatLng) {
            showPreviewCatchment(lastSnappedLatLng.lat, lastSnappedLatLng.lng);
            const previewSnap = snapToTrack(lastSnappedLatLng.lat, lastSnappedLatLng.lng, 50);
            if (previewSnap) {
                const previewLine = project.lines.find(line => lineUsesTrack(line, previewSnap.trackId));
                if (previewLine) {
                    showPreviewStationDistances(previewLine, lastSnappedLatLng);
                }
            }
        }
        await refreshActiveCatchmentChecker();
        await recalculatePlacedStationsForCurrentWalkTime();
    });
});

// ─── Line Drawing Handler ───────────────────────────────────────────────────
function handleLineClick(e) {
    // Recompute at click time because touch devices may not emit a preceding
    // mousemove. This is also the final same-gauge/same-level gate.
    const referenceSnap = snapDrawingToReferenceRail(e.latlng);
    const trackSnap = referenceSnap ? null : snapDrawingToCompatibleTrack(e.latlng.lat, e.latlng.lng);
    const latlng = referenceSnap ? L.latLng(referenceSnap.lat, referenceSnap.lng) : trackSnap?.latlng || e.latlng;
    const snappedToTrack = !!trackSnap;
    const snappedTrackId = trackSnap?.trackId ?? null;

    // First vertex of a fresh track: enforce the project's location NOW, not at
    // finish, so a route is never drawn only to be thrown away. A mismatch with
    // an existing project opens the "start a new project here?" dialog.
    if (currentLinePoints.length === 0 && !extendingTrack) {
        if (checkFirstDrawPointLocation(latlng.lat, latlng.lng) !== 'ok') return;
    }

    const candidatePoints = [...currentLinePoints, [latlng.lat, latlng.lng]];
    if (!validateDraftTrackCurves(candidatePoints)) return;

    if (referenceSnap && currentLinePoints.length >= 1) {
        currentLinePoints.push([latlng.lat, latlng.lng]);
        finishCurrentTrackWithReferenceConnection(referenceSnap);
        return;
    }

    // If snapping to an existing track (not the one being extended) and we already have points, auto-finish
    const snappedToOtherTrack = snappedToTrack
        && !(extendingTrack && snappedTrackId === extendingTrack.track.id);
    if (snappedToOtherTrack && currentLinePoints.length >= 1) {
        currentLinePoints.push([latlng.lat, latlng.lng]);
        finishCurrentTrackWithJunction(snappedTrackId);
        return;
    }

    // If snapping to an existing track on the first click, record the start junction
    if (referenceSnap && currentLinePoints.length === 0) {
        drawingStartReferenceConnection = referenceSnap;
        drawingTrackLevel = 0;
    } else if (snappedToTrack && currentLinePoints.length === 0) {
        drawingStartJunctionTrackId = snappedTrackId;
        drawingTrackLevel = normalizeTrackLevel(trackSnap.level);
    } else if (currentLinePoints.length === 0) {
        drawingTrackLevel = 0;
    }

    currentLinePoints.push([latlng.lat, latlng.lng]);

    // Add vertex marker
    const marker = L.circleMarker(latlng, {
        radius: 5, color: '#333', fillColor: '#fff', fillOpacity: 1, weight: 2,
    }).addTo(map);
    currentLineVertexMarkers.push(marker);

    // Update or create polyline preview (grey track style)
    const gauge = document.querySelector('input[name="trackGauge"]:checked').value;
    const style = getTrackStyle(gauge);
    if (currentLineLayer) {
        currentLineLayer.setStyle(style);
        currentLineLayer.setLatLngs(currentLinePoints);
    } else {
        currentLineLayer = L.polyline(currentLinePoints, style).addTo(map);
    }

    updateFinishLineMarker();
    updateStatus();
}

function cleanUpDrawingArtifacts() {
    currentLineVertexMarkers.forEach(m => map.removeLayer(m));
    currentLineVertexMarkers = [];
    removeFinishLineMarker();
    if (currentLineLayer) map.removeLayer(currentLineLayer);
    currentLineLayer = null;
    currentLinePoints = [];
    drawingStartJunctionTrackId = null;
    drawingStartReferenceConnection = null;
    drawingTrackLevel = 0;
    extendingTrack = null;
}

// Merges drawn points into the track being extended, updating its geometry and derived data.
function mergeExtensionIntoTrack(drawnLatlngs) {
    const { track, endpoint } = extendingTrack;
    // drawnLatlngs[0] is the shared endpoint — skip it to avoid duplication
    const newPoints = drawnLatlngs.slice(1);
    if (newPoints.length === 0) return;
    const oldLengthM = buildTrackChainage(track).totalM;

    if (endpoint === 'end') {
        // New vertices continue at the endpoint's level
        const endLevel = track.levels[track.levels.length - 1] ?? 0;
        track.latlngs.push(...newPoints);
        track.levels.push(...newPoints.map(() => endLevel));
    } else {
        // Extending from the start: drawn points go outward from start,
        // so reverse them and prepend (excluding the shared start)
        const startLevel = track.levels[0] ?? 0;
        track.latlngs.unshift(...newPoints.reverse());
        track.levels.unshift(...newPoints.map(() => startLevel));
        const addedLengthM = Math.max(0, buildTrackChainage(track).totalM - oldLengthM);
        if (addedLengthM > 0 && track.electrificationSegments?.length) {
            track.electrificationSegments = track.electrificationSegments.map(segment => ({
                ...segment,
                fromM: Number(segment.fromM) + addedLengthM,
                toM: Number(segment.toM) + addedLengthM,
            }));
        }
    }

    // Refresh track geometry, layers, and all derived data
    afterTrackGeometryChange(track);
    setStatusMessage(`Trasa produžena: ${track.lengthKm.toFixed(1)} km`);
}

function queueReferenceConnectionIntent(track, endpoint, targetSnap, pointBeforeJunction) {
    if (!track || !targetSnap || !Number.isInteger(targetSnap.lineIndex)) return;
    const targetOutboundDirection = window.__railProjectConnections.chooseContinuingDirection(
        pointBeforeJunction,
        targetSnap,
    );
    const intent = {
        sourceTrackId: track.id,
        sourceEndpoint: endpoint,
        target: {
            projectId: targetSnap.projectId,
            projectName: targetSnap.projectName,
            lineIndex: targetSnap.lineIndex,
            trackIndex: targetSnap.trackIndex,
            trackChainageM: targetSnap.trackChainageM,
            lineOffsetM: targetSnap.trackChainageM,
            outboundDirection: targetOutboundDirection,
            ref: targetSnap.ref,
            name: targetSnap.name,
        },
    };
    pendingRailConnectionIntents = window.__railProjectConnections.upsertPendingIntent(
        pendingRailConnectionIntents,
        intent,
    );
}

function finishCurrentTrack() {
    const gauge = document.querySelector('input[name="trackGauge"]:checked').value;
    let latlngs = [...currentLinePoints];
    const startReferenceConnection = drawingStartReferenceConnection;
    const trackLevel = normalizeTrackLevel(drawingTrackLevel);
    const hasStartJunction = drawingStartJunctionTrackId != null;

    if (latlngs.length < 2) { cleanUpDrawingArtifacts(); setMode('explore'); return; }
    if (!validateDraftTrackCurves(latlngs)) return;

    // A project stays within one prepared location (see location-registry.js).
    const locCheck = validateNewTrackLocation(latlngs);
    if (!locCheck.ok) {
        cleanUpDrawingArtifacts();
        setMode('explore');
        setStatusMessage(locCheck.message, true);
        return;
    }

    // Extending an existing track: merge new points into it
    if (extendingTrack) {
        mergeExtensionIntoTrack(latlngs);
        cleanUpDrawingArtifacts();
        setMode('explore');
        return;
    }

    // Snapping to an existing track: may involve track split
    // Handle start junction: split/snap the start target track
    if (drawingStartJunctionTrackId != null) {
        const startResult = connectToTrack(drawingStartJunctionTrackId, latlngs[0][0], latlngs[0][1]);
        latlngs[0] = startResult.latlng;
    }

    if (latlngs.length < 2) { cleanUpDrawingArtifacts(); setMode('explore'); return; }

    cleanUpDrawingArtifacts();

    const track = createRuntimeTrack(gauge, latlngs, latlngs.map(() => trackLevel));
    project.tracks.push(track);
    if (startReferenceConnection) {
        queueReferenceConnectionIntent(track, 'start', startReferenceConnection, latlngs[1]);
    }

    setMode('explore');
    setStatusMessage(hasStartJunction
        ? `Trasa spojena skretnicom: ${track.lengthKm.toFixed(1)} km`
        : `Trasa dodana: ${track.lengthKm.toFixed(1)} km`);
    updateTracksListUI();
    updateProjectSummary();
}

function finishCurrentTrackWithReferenceConnection(endReferenceConnection) {
    const gauge = document.querySelector('input[name="trackGauge"]:checked').value;
    const latlngs = [...currentLinePoints];
    const trackLevel = normalizeTrackLevel(drawingTrackLevel);
    const startReferenceConnection = drawingStartReferenceConnection;
    if (latlngs.length < 2 || !validateDraftTrackCurves(latlngs)) return;
    const locCheck = validateNewTrackLocation(latlngs);
    if (!locCheck.ok) {
        cleanUpDrawingArtifacts();
        setMode('explore');
        setStatusMessage(locCheck.message, true);
        return;
    }

    if (extendingTrack) {
        const sourceTrack = extendingTrack.track;
        const sourceEndpoint = extendingTrack.endpoint;
        const pointBeforeJunction = latlngs[latlngs.length - 2];
        mergeExtensionIntoTrack(latlngs);
        queueReferenceConnectionIntent(sourceTrack, sourceEndpoint, endReferenceConnection, pointBeforeJunction);
        cleanUpDrawingArtifacts();
        setMode('explore');
        setStatusMessage('Trasa produžena i pripremljena za spajanje na postojeću prugu. Spremite projekt za potvrdu veze.');
        return;
    }

    cleanUpDrawingArtifacts();
    const track = createRuntimeTrack(gauge, latlngs, latlngs.map(() => trackLevel));
    project.tracks.push(track);
    if (startReferenceConnection) {
        queueReferenceConnectionIntent(track, 'start', startReferenceConnection, latlngs[1]);
    }
    queueReferenceConnectionIntent(
        track,
        'end',
        endReferenceConnection,
        latlngs[latlngs.length - 2],
    );
    setMode('explore');
    setStatusMessage('Trasa pripremljena za spajanje na postojeću prugu. Dodajte liniju i spremite projekt za potvrdu veze.');
    updateTracksListUI();
    updateProjectSummary();
}

function finishCurrentTrackWithJunction(endTrackId) {
    const gauge = document.querySelector('input[name="trackGauge"]:checked').value;
    let latlngs = [...currentLinePoints];
    const trackLevel = normalizeTrackLevel(drawingTrackLevel);

    if (latlngs.length < 2) { cleanUpDrawingArtifacts(); setMode('explore'); return; }
    if (!validateDraftTrackCurves(latlngs)) return;

    // A project stays within one prepared location (see location-registry.js).
    const locCheck = validateNewTrackLocation(latlngs);
    if (!locCheck.ok) {
        cleanUpDrawingArtifacts();
        setMode('explore');
        setStatusMessage(locCheck.message, true);
        return;
    }

    // Extending an existing track and snapping end to another track
    if (extendingTrack) {
        // Handle end junction: split/snap the target track at the endpoint
        const endResult = connectToTrack(endTrackId, latlngs[latlngs.length - 1][0], latlngs[latlngs.length - 1][1]);
        latlngs[latlngs.length - 1] = endResult.latlng;
        mergeExtensionIntoTrack(latlngs);
        cleanUpDrawingArtifacts();
        setMode('explore');
        const brokenExt = validateAllLinesConnectivity();
        if (brokenExt) {
            setStatusMessage(`Upozorenje: ${brokenExt} možda ima prekinutu vezu.`, true);
        } else {
            setStatusMessage('Trasa produžena i spojena skretnicom.');
        }
        return;
    }

    // Handle start junction: split/snap the start target track
    if (drawingStartJunctionTrackId != null) {
        const startResult = connectToTrack(drawingStartJunctionTrackId, latlngs[0][0], latlngs[0][1]);
        latlngs[0] = startResult.latlng;
    }

    // Handle end junction: split/snap the end target track
    // If the start split destroyed the end target (same track), re-snap to find the right half
    let resolvedEndTrackId = endTrackId;
    if (!project.tracks.find(t => t.id === endTrackId)) {
        const reSnap = snapToTrack(
            latlngs[latlngs.length - 1][0],
            latlngs[latlngs.length - 1][1],
            30,
            { gauge, requiredLevel: trackLevel, fullLevelOnly: true },
        );
        resolvedEndTrackId = reSnap ? reSnap.trackId : null;
    }
    if (resolvedEndTrackId != null) {
        const endResult = connectToTrack(resolvedEndTrackId, latlngs[latlngs.length - 1][0], latlngs[latlngs.length - 1][1]);
        latlngs[latlngs.length - 1] = endResult.latlng;
    }

    if (latlngs.length < 2) { cleanUpDrawingArtifacts(); setMode('explore'); return; }

    cleanUpDrawingArtifacts();

    const track = createRuntimeTrack(gauge, latlngs, latlngs.map(() => trackLevel));
    project.tracks.push(track);

    setMode('explore');

    // After track topology changes (splits), verify all lines are still connected
    const brokenLine = validateAllLinesConnectivity();
    if (brokenLine) {
        setStatusMessage(`Upozorenje: ${brokenLine} možda ima prekinutu vezu. Provjerite stanke.`, true);
    } else {
        setStatusMessage(`Trasa spojena skretnicom: ${track.lengthKm.toFixed(1)} km`);
    }
    updateTracksListUI();
    updateProjectSummary();
}

function cancelCurrentLine() {
    cleanUpDrawingArtifacts();
}

function undoLastVertex() {
    if (currentLinePoints.length === 0) return;
    currentLinePoints.pop();
    const marker = currentLineVertexMarkers.pop();
    if (marker) map.removeLayer(marker);
    if (currentLinePoints.length === 0) {
        cancelCurrentLine();
        setMode('explore');
        return;
    }
    if (currentLineLayer) currentLineLayer.setLatLngs(currentLinePoints);
    updateCurrentLinePreview();
    updateFinishLineMarker();
    updateStatus();
}

function deleteLine(lineId) {
    if (rejectProjectMutation()) return;
    const idx = project.lines.findIndex(l => l.id === lineId);
    if (idx === -1) return;
    const line = project.lines[idx];
    if (previewStationDistanceLineId === lineId) {
        clearPreviewStationDistances({ restoreCommitted: false });
    }
    // Deselect if this line or its train is selected
    if (selectedObject && ((selectedObject.type === 'line' && selectedObject.id === lineId) ||
        (selectedObject.type === 'train' && selectedObject.ref?.line?.id === lineId))) {
        deselectObject();
    }
    stopLineTrain(line);
    clearLineStationDistanceLabels(line);
    if (line.hitLayer) map.removeLayer(line.hitLayer);
    if (line.layer) map.removeLayer(line.layer);

    // Unassign stations from this line (stations belong to tracks, not lines)
    for (const station of project.stations) {
        if (station.lineId === lineId) {
            station.lineId = null;
        }
    }

    project.lines.splice(idx, 1);

    removeStationPicker();

    updateTracksListUI();
    updateProjectSummary();
}

// ─── Station Placement ──────────────────────────────────────────────────────
function debouncedPreviewCatchment(lat, lon) {
    clearTimeout(previewDebounceTimer);
    previewDebounceTimer = setTimeout(() => showPreviewCatchment(lat, lon), 300);
}

async function showPreviewCatchment(lat, lon) {
    // Cancel any in-flight preview request
    if (previewAbortController) previewAbortController.abort();
    const controller = new AbortController();
    previewAbortController = controller;

    const walkMinutes = getCurrentWalkMinutes();

    if (walkMinutes <= 0) {
        clearPreviewCatchment();
        return;
    }

    try {
        const derivedData = await computeStationCatchmentData(L.latLng(lat, lon), walkMinutes, {
            signal: controller.signal,
        });
        if (previewAbortController !== controller) return;

        if (previewCatchmentLayer) {
            map.removeLayer(previewCatchmentLayer);
            previewCatchmentLayer = null;
        }
        if (derivedData.catchmentPolygon) {
            previewCatchmentLayer = L.geoJSON(derivedData.catchmentPolygon, {
                style: { color: STATION_CATCHMENT_COLOR, fillColor: STATION_CATCHMENT_COLOR, fillOpacity: 0.1, weight: 1, dashArray: '5, 5' },
                interactive: false,
            }).addTo(map);
        }
    } catch (err) {
        if (err.name === 'AbortError') return;
        if (previewAbortController !== controller) return;
        console.error('Preview catchment error:', err);
    } finally {
        if (previewAbortController === controller) {
            previewAbortController = null;
        }
    }
}

function clearPreviewCatchment() {
    clearTimeout(previewDebounceTimer);
    previewDebounceTimer = null;
    if (previewAbortController) {
        previewAbortController.abort();
        previewAbortController = null;
    }
    if (previewCatchmentLayer) {
        map.removeLayer(previewCatchmentLayer);
        previewCatchmentLayer = null;
    }
}

function applyStationCatchmentData(station, derivedData, walkMinutes) {
    station.walkMinutes = walkMinutes;
    station.catchmentPolygon = derivedData.catchmentPolygon;
    station.catchmentPopulation = derivedData.catchmentPopulation;
    station.catchmentJobs = derivedData.catchmentJobs;

    if (station.catchmentLayer) {
        map.removeLayer(station.catchmentLayer);
    }
    station.catchmentLayer = createStationCatchmentLayer(derivedData.catchmentPolygon);
    // Catchment population/jobs affect gravity model attraction weights
    if (typeof PassengerDemand !== 'undefined') PassengerDemand.invalidateGravityCache();
}

async function recalculatePlacedStationsForCurrentWalkTime(priorityStationId = null) {
    if (project.stations.length === 0) return;

    const walkMinutes = getCurrentWalkMinutes();
    const refreshToken = ++stationCatchmentRefreshToken;
    const selectedStationId = selectedObject?.type === 'station' ? selectedObject.id : null;

    // Reorder stations so the priority station is processed first
    const stations = [...project.stations];
    if (priorityStationId != null) {
        const idx = stations.findIndex(s => s.id === priorityStationId);
        if (idx > 0) stations.unshift(stations.splice(idx, 1)[0]);
    }

    const stationLabel = stations.length === 1 ? 'stanice' : 'stanica';

    loadingDiv.classList.remove('hidden');
    if (walkMinutes <= 0) {
        setStatusMessage(`Ažuriram doseg ${stationLabel} (isključen)...`);
    } else {
        setStatusMessage(`Ponovno računam doseg ${stationLabel} za ${walkMinutes} min hodanja...`);
    }

    try {
        // If a priority station is specified, fetch it first for instant feedback, then fetch the rest in parallel.
        let remaining = stations;
        if (priorityStationId != null) {
            const priorityStation = stations.find(s => s.id === priorityStationId);
            if (priorityStation) {
                if (refreshToken !== stationCatchmentRefreshToken) return;
                const data = walkMinutes <= 0
                    ? { catchmentPolygon: null, catchmentPopulation: 0, catchmentJobs: 0 }
                    : await fetchCachedStationCatchment(priorityStation.latlng[0], priorityStation.latlng[1], walkMinutes);
                if (refreshToken !== stationCatchmentRefreshToken) return;
                applyStationCatchmentData(priorityStation, data, walkMinutes);
                if (selectedStationId === priorityStationId) refreshSelectedObjectDetails();
                remaining = stations.filter(s => s.id !== priorityStationId);
            }
        }

        // Fetch remaining stations in parallel
        if (remaining.length > 0) {
            const results = await Promise.all(remaining.map(station => {
                if (walkMinutes <= 0) {
                    return Promise.resolve({ catchmentPolygon: null, catchmentPopulation: 0, catchmentJobs: 0 });
                }
                return fetchCachedStationCatchment(station.latlng[0], station.latlng[1], walkMinutes);
            }));
            if (refreshToken !== stationCatchmentRefreshToken) return;
            remaining.forEach((station, i) => applyStationCatchmentData(station, results[i], walkMinutes));
        }

        if (refreshToken !== stationCatchmentRefreshToken) return;

        if (selectedStationId !== null && selectedStationId !== priorityStationId) {
            const selectedStation = _stationById.get(selectedStationId);
            if (selectedStation) {
                selectObject('station', selectedStation.id, selectedStation);
            }
        }

        updateProjectSummary();
        if (walkMinutes <= 0) {
            setStatusMessage('Doseg isključen.');
        } else {
            setStatusMessage(`Doseg ${stationLabel} ažuriran: ${walkMinutes} min hodanja.`);
        }
    } catch (err) {
        if (refreshToken !== stationCatchmentRefreshToken) return;
        console.error('Station catchment refresh error:', err);
        setStatusMessage(err.message, true);
    } finally {
        if (refreshToken === stationCatchmentRefreshToken) {
            loadingDiv.classList.add('hidden');
        }
    }
}

async function handleStationClick(e, stationType = 'normal') {
    const snap = snapToTrack(e.latlng.lat, e.latlng.lng, 50);
    if (!snap) return;

    const trackId = snap.trackId;
    const track = project.tracks.find(t => t.id === trackId);
    if (!track) return;
    const fullLevelPlacement = resolveStationFullLevelPlacement(
        track,
        [snap.latlng.lat, snap.latlng.lng],
        STATION_RAMP_ENDPOINT_SNAP_M
    );
    if (!fullLevelPlacement) {
        setStatusMessage(
            'Stanice se mogu postaviti samo na ravnom dijelu pune razine −1, 0 ili +1, ne na rampi.',
            true
        );
        return;
    }
    // The whole structure has to fit on the route — a clamped span is a
    // half-length platform, not a shorter station.
    {
        const level = fullLevelPlacement.level;
        const halfSpanM = level < 0 ? STATION_PROFILE_UNDERGROUND_HALF_SPAN_M
            : level > 0 ? STATION_PROFILE_ELEVATED_HALF_SPAN_M
                : STATION_PROFILE_DEFAULT_HALF_SPAN_M;
        const placementDM = trackChainageAtLatLng(
            track, fullLevelPlacement.latlng[0], fullLevelPlacement.latlng[1],
        );
        if (!stationFitsOnTrack(track, placementDM, halfSpanM)) {
            const kind = level < 0 ? 'tunnel' : level > 0 ? 'elevated' : 'surface';
            setStatusMessage(getStationFitMessage(halfSpanM, getStationStructureLabel(kind)), true);
            return;
        }
    }
    if (fullLevelPlacement.level < 0) {
        const alignment = getUndergroundStationAlignment(track, fullLevelPlacement.latlng);
        // Straightness only — the station's own span is what levels the profile
        // here, so it has to be allowed to exist first. See
        // isUndergroundStationPlaceable.
        if (!isUndergroundStationPlaceable(alignment)) {
            showUndergroundStationAlignmentFault(track, alignment);
            return;
        }
    }
    const latlng = L.latLng(fullLevelPlacement.latlng[0], fullLevelPlacement.latlng[1]);
    const walkMinutes = getCurrentWalkMinutes();
    // Find the line on this track (if any) for line-level features
    const line = project.lines.find(l => lineUsesTrack(l, trackId)) || null;
    const lineId = line ? line.id : null;
    const stationLevel = fullLevelPlacement.level;
    // The station does not exist yet, so its structural form can only be read
    // off the level it is being placed at; refreshTrackStationLevels() upgrades
    // it to the exact form (covered / open cut) once the station is on the track.
    const stationCost = computeStationConstructionCost(
        stationType, track.gauge, PRICING_API.stationKindFromLevel(stationLevel),
    );

    loadingDiv.classList.remove('hidden');
    setStatusMessage('Postavljam stanicu...');

    try {
        // Fetch the catchment and the nearest-road name in parallel — the
        // station is named after the closest named road (depots keep "Remiza N").
        const [derivedData, autoRoadName] = await Promise.all([
            walkMinutes > 0
                ? fetchCachedStationCatchment(latlng.lat, latlng.lng, walkMinutes)
                : Promise.resolve({ catchmentPolygon: null, catchmentPopulation: 0, catchmentJobs: 0 }),
            stationType === 'depot' ? Promise.resolve(null) : nearestNamedRoadName(latlng.lat, latlng.lng),
        ]);

        // Clear preview
        clearPreviewCatchment();
        clearPreviewStationDistances({ restoreCommitted: false });

        const catchmentLayer = createStationCatchmentLayer(derivedData.catchmentPolygon);

        // Add station marker
        const stationIcon = L.divIcon({
            className: getStationMarkerClass(track.gauge, stationType, stationLevel),
            iconSize: [16, 16],
            iconAnchor: [8, 8],
        });
        const markerLayer = L.marker(latlng, { icon: stationIcon }).addTo(map);

        const station = {
            id: nextStationId++,
            trackId,
            lineId,
            latlng: [latlng.lat, latlng.lng],
            walkMinutes,
            stationType,
            name: autoRoadName || generateDefaultStationName(stationType),
            autoNamed: true,
            cost: stationCost,
            catchmentPolygon: derivedData.catchmentPolygon,
            catchmentPopulation: derivedData.catchmentPopulation,
            catchmentJobs: derivedData.catchmentJobs,
            catchmentLayer,
            markerLayer,
        };

        project.stations.push(station);
        rebuildStationIndex();
        scheduleTrackVerticalProfile(track);
        attachStationClickHandler(station);
        refreshStationMarkerPresentation(station);
        if (line) updateLineStationStops(line);
        const typeLabel = stationType === 'depot' ? 'Remiza' : 'Stanica';
        setStatusMessage(`${typeLabel} dodana (${formatCost(stationCost)}): ${formatNumber(derivedData.catchmentPopulation)} stan., ${formatNumber(derivedData.catchmentJobs)} radnih mj.`);
        updateProjectSummary();

        // Offer transfer links to nearby stations
        const nearby = findNearbyStations(latlng, station.id);
        const linkableStations = nearby.filter(n => n.station && n.station.trackId !== station.trackId);
        if (linkableStations.length > 0) {
            showTransferLinkPopup(station, linkableStations.map(n => n.station));
        }
    } catch (err) {
        console.error(err);
        setStatusMessage(err.message, true);
    } finally {
        loadingDiv.classList.add('hidden');
    }
}

function removeStation(stationId) {
    if (rejectProjectMutation()) return;
    const idx = project.stations.findIndex(s => s.id === stationId);
    if (idx === -1) return;
    const station = project.stations[idx];

    // Block deletion if station belongs to a line
    const owningLine = station.lineId != null ? project.lines.find(l => l.id === station.lineId) : null;
    if (owningLine) {
        setStatusMessage(
            `Nije moguće obrisati stanicu — pripada Liniji ${owningLine.number}. Uklonite liniju prvo.`,
            true,
            { label: 'Prikaži liniju →', onClick: () => revealLineInSidebar(owningLine.id) }
        );
        return;
    }

    if (selectedObject && selectedObject.type === 'station' && selectedObject.id === stationId) {
        deselectObject();
    }
    const line = station.lineId != null ? project.lines.find(entry => entry.id === station.lineId) : null;
    if (station.lineId != null && previewStationDistanceLineId === station.lineId) {
        clearPreviewStationDistances({ restoreCommitted: false });
    }
    if (station.catchmentLayer) map.removeLayer(station.catchmentLayer);
    if (station.markerLayer) map.removeLayer(station.markerLayer);
    const demandLabel = demandLabelLayers.get(stationId);
    if (demandLabel) { map.removeLayer(demandLabel); demandLabelLayers.delete(stationId); }
    project.stations.splice(idx, 1);
    rebuildStationIndex();
    const stationTrack = project.tracks.find((track) => track.id === station.trackId);
    if (stationTrack) scheduleTrackVerticalProfile(stationTrack);
    // Remove transfer links that reference this station
    removeTransferLinksForStation(stationId);
    if (line) {
        updateLineStationStops(line);
    }
    updateProjectSummary();
}

// ─── Transfer Links ────────────────────────────────────────────────────────
const TRANSFER_LINK_STYLE = {
    color: '#f59f00',
    weight: 3,
    dashArray: '6, 6',
    opacity: 0.85,
};

function createTransferLink(stationA, stationB) {
    const linkType = getTransferLinkType(stationA, stationB);
    const cost = getCurrentTransferLinkPrice(linkType);
    const layer = L.polyline(
        [stationA.latlng, stationB.latlng],
        TRANSFER_LINK_STYLE
    ).addTo(map);

    const link = {
        id: nextTransferLinkId++,
        stationIdA: stationA.id,
        stationIdB: stationB.id,
        linkType,
        cost,
        layer,
    };

    project.transferLinks.push(link);
    attachTransferLinkClickHandler(link);
    updateStationLinkIndicator(stationA);
    updateStationLinkIndicator(stationB);
    updateProjectSummary();
    return link;
}

function removeTransferLink(linkId) {
    const idx = project.transferLinks.findIndex(l => l.id === linkId);
    if (idx === -1) return;
    if (selectedObject && selectedObject.type === 'transferLink' && selectedObject.id === linkId) {
        deselectObject();
    }
    const link = project.transferLinks[idx];
    const { stationIdA, stationIdB } = link;
    if (link.layer) map.removeLayer(link.layer);
    project.transferLinks.splice(idx, 1);
    const stA = _stationById.get(stationIdA);
    const stB = _stationById.get(stationIdB);
    if (stA) updateStationLinkIndicator(stA);
    if (stB) updateStationLinkIndicator(stB);
    updateProjectSummary();
}

function removeTransferLinksForStation(stationId) {
    const toRemove = project.transferLinks.filter(
        l => l.stationIdA === stationId || l.stationIdB === stationId
    );
    for (const link of toRemove) {
        removeTransferLink(link.id);
    }
}

function recomputeTransferLinkCosts() {
    for (const link of project.transferLinks) {
        const stA = _stationById.get(link.stationIdA);
        const stB = _stationById.get(link.stationIdB);
        if (stA && stB) {
            link.linkType = getTransferLinkType(stA, stB);
        }
        link.cost = transferLinkCostEur(link, project.transferLinks.indexOf(link));
    }
}

function attachTransferLinkClickHandler(link) {
    if (link.layer) {
        link.layer.on('click', function (e) {
            handleObjectClick(e, 'transferLink', link.id, link);
        });
        attachObjectHoverCursor(link.layer);
    }
}

function updateStationLinkIndicator(station) {
    const el = station.markerLayer?.getElement();
    if (!el) return;
    const hasLink = project.transferLinks.some(l => l.stationIdA === station.id || l.stationIdB === station.id);
    el.classList.toggle('station-marker-linked', hasLink);
}

function getTransferLinkLabel(link) {
    const stA = _stationById.get(link.stationIdA);
    const stB = _stationById.get(link.stationIdB);
    const lineA = stA ? project.lines.find(l => l.id === stA.lineId) : null;
    const lineB = stB ? project.lines.find(l => l.id === stB.lineId) : null;
    const labelA = lineA ? `L${lineA.number}` : '?';
    const labelB = lineB ? `L${lineB.number}` : '?';
    return `${labelA} \u2194 ${labelB}`;
}

function showTransferLinkPopup(newStation, nearbyStations) {
    // Show one popup per station sequentially; user answers Yes or No for each.
    let index = 0;

    function showNext() {
        if (index >= nearbyStations.length) return;
        const target = nearbyStations[index++];

        const line = project.lines.find(l => l.id === target.lineId);
        const lineLabel = line ? `Linija ${line.number}` : 'Linija';
        const stationLabel = target.name || (target.stationType === 'depot' ? 'Remiza' : 'Stanica');
        const linkType = getTransferLinkType(newStation, target);
        const cost = getCurrentTransferLinkPrice(linkType);
        const costLabel = cost > 0 ? formatCost(cost) : 'besplatno';
        const typeLabel = linkType === 'underground' ? 'podzemno' : 'nadzemno';

        const html = `<div class="transfer-popup">
            <div class="transfer-popup-question">Poveži s <strong>${escapeHtml(stationLabel)}</strong> (${escapeHtml(lineLabel)})?<br>
            <span class="transfer-popup-detail">${typeLabel}, ${costLabel}</span></div>
            <div class="transfer-popup-actions">
                <button class="transfer-popup-btn transfer-popup-yes" data-action="yes">Da</button>
                <button class="transfer-popup-btn transfer-popup-no" data-action="no">Ne</button>
            </div>
        </div>`;

        const popup = L.popup({
            closeButton: false,
            className: 'transfer-choice-popup',
            maxWidth: 280,
        })
            .setLatLng(newStation.latlng)
            .setContent(html)
            .openOn(map);

        const popupEl = popup.getElement();
        if (!popupEl) return;

        // Block map mouse events while hovering the popup
        popupEl.addEventListener('mouseenter', () => { hoveringObject = true; });
        popupEl.addEventListener('mouseleave', () => { hoveringObject = false; });

        popupEl.addEventListener('click', function handler(ev) {
            const btn = ev.target.closest('[data-action]');
            if (!btn) return;
            ev.stopPropagation();
            popupEl.removeEventListener('click', handler);
            hoveringObject = false;
            map.closePopup(popup);

            if (btn.dataset.action === 'yes') {
                const exists = project.transferLinks.some(
                    l => (l.stationIdA === newStation.id && l.stationIdB === target.id)
                        || (l.stationIdA === target.id && l.stationIdB === newStation.id)
                );
                if (!exists) {
                    const link = createTransferLink(newStation, target);
                    setStatusMessage(`Presjedanje povezano: ${getTransferLinkLabel(link)} (${formatCost(link.cost)})`);
                }
            }

            showNext();
        });
    }

    showNext();
}

// ─── Tracks & Lines List UI ─────────────────────────────────────────────────
// ─── Sidebar tabs ──────────────────────────────────────────────────────────
function setSidebarTab(tabName) {
    sidebarActiveTab = tabName;
    const tabs = linesListDiv.querySelectorAll('.sidebar-tab');
    for (const t of tabs) t.classList.toggle('active', t.dataset.tab === tabName);
    linesListContent.classList.toggle('hidden', tabName !== 'tracks');
    routesListContent.classList.toggle('hidden', tabName !== 'lines');
}

function initSidebarTabs() {
    const tabs = linesListDiv.querySelectorAll('.sidebar-tab');
    for (const tab of tabs) {
        tab.addEventListener('click', () => setSidebarTab(tab.dataset.tab));
    }
}
initSidebarTabs();

// Opens the sidebar Linije tab and flashes the given line's row — used by
// delete-guard toasts so users can find where lines are removed.
function revealLineInSidebar(lineId) {
    updateTracksListUI();
    setSidebarTab('lines');
    if (mobileSidebarMedia.matches) setSidebarOpen(true);
    const row = routesListContent.querySelector(`.line-item[data-line-id="${lineId}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('line-item-flash');
    row.addEventListener('animationend', () => row.classList.remove('line-item-flash'), { once: true });
}

function showSidebarHighlight(latlngs, color, weight) {
    removeSidebarHighlight();
    if (!latlngs || latlngs.length < 2) return;
    sidebarHighlightLayer = L.polyline(latlngs, {
        color: color || '#3b82f6', weight: weight || 8, opacity: 0.7, interactive: false,
    }).addTo(map);
}

function removeSidebarHighlight() {
    if (sidebarHighlightLayer) {
        map.removeLayer(sidebarHighlightLayer);
        sidebarHighlightLayer = null;
    }
}


function flyToTrack(track) {
    if (!track?.latlngs?.length) return;
    const bounds = L.latLngBounds(track.latlngs);
    map.flyToBounds(bounds, { padding: [60, 60], maxZoom: 15, duration: 0.5 });
}

function flyToLine(line) {
    const latlngs = getLineProfileLatLngs(line);
    if (!latlngs) return;
    map.flyToBounds(L.latLngBounds(latlngs), { padding: [60, 60], maxZoom: 15, duration: 0.5 });
}

function updateTracksListUI() {
    // Rebuilding the list DOM destroys any hovered row before its mouseleave
    // fires, which would orphan the hover highlight polyline on the map.
    removeSidebarHighlight();
    if (project.tracks.length === 0 && project.lines.length === 0) {
        linesListDiv.classList.add('hidden');
        return;
    }
    linesListDiv.classList.remove('hidden');

    // Tracks tab
    linesListContent.innerHTML = project.tracks.map(track => {
        const typeName = GAUGES[normalizeGauge(track.gauge)].label;
        const trackLabel = `${ui('Track', 'Trasa')} ${track.id}`;
        const linesOnTrack = project.lines.filter(l => lineUsesTrack(l, track.id));
        const linesInfo = linesOnTrack.length > 0
            ? linesOnTrack.map(l => `<span class="line-item-swatch" style="background:${l.color}"></span>L${l.number}`).join(' ')
            : `<span style="color:#9ca3af">${ui('No lines', 'Nema linija')}</span>`;
        const isActive = sidebarSelectedId?.type === 'track' && sidebarSelectedId?.id === track.id;
        return `<div class="line-item${isActive ? ' active' : ''}" data-track-id="${track.id}">
            <div class="line-item-info">
                <span class="line-item-type"><span class="line-item-swatch" style="background:#6b7280"></span>${trackLabel} · ${typeName}</span>
                <span class="line-item-meta">${track.lengthKm.toFixed(1)} km &middot; ${formatCost(track.cost)} &middot; ${linesInfo}</span>
            </div>
            <button class="delete-btn" data-del-track-id="${track.id}">&#10005;</button>
        </div>`;
    }).join('');

    // Attach track item handlers
    linesListContent.querySelectorAll('.line-item').forEach(item => {
        const trackId = parseInt(item.dataset.trackId);
        const track = project.tracks.find(t => t.id === trackId);
        if (!track) return;

        item.addEventListener('mouseenter', () => {
            if (currentMode === 'edit') return;
            showSidebarHighlight(track.latlngs, '#3b82f6', 8);
        });
        item.addEventListener('mouseleave', () => {
            removeSidebarHighlight();
        });
        item.addEventListener('click', (e) => {
            if (e.target.closest('.delete-btn')) return;
            if (blockSidebarRouteActionDuringEdit()) return;
            removeSidebarHighlight();
            if (mobileSidebarMedia.matches) setSidebarOpen(false);
            flyToTrack(track);
            // After fly animation, select the track to show its info popup
            setTimeout(() => {
                const center = L.latLngBounds(track.latlngs).getCenter();
                selectObject('track', track.id, track, center);
            }, 550);
        });
    });

    linesListContent.querySelectorAll('.delete-btn').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            if (blockSidebarRouteActionDuringEdit()) return;
            deleteTrack(parseInt(btn.dataset.delTrackId));
        };
    });

    // Lines (routes) tab
    updateRoutesListUI();
}

function updateRoutesListUI() {
    if (!routesListContent) return;

    if (project.lines.length === 0) {
        routesListContent.innerHTML = `<div style="color:#9ca3af;font-size:0.85em;padding:4px 0">${ui('No lines', 'Nema linija')}</div>`;
        return;
    }

    routesListContent.innerHTML = project.lines.map(line => {
        const color = line.color || getLineColor(line.number || line.id);
        const stationCount = line.stationIds ? line.stationIds.length : 0;
        const trainCount = line.trains ? line.trains.length : 0;
        const depot = line.depotStationId ? _stationById.get(line.depotStationId) : null;
        const depotName = depot ? getStationDisplayName(depot) : '';
        const isActive = sidebarSelectedId?.type === 'line' && sidebarSelectedId?.id === line.id;
        return `<div class="line-item${isActive ? ' active' : ''}" data-line-id="${line.id}">
            <div class="line-item-info">
                <span class="line-item-type"><span class="line-item-swatch" style="background:${color}"></span>${ui('Line', 'Linija')} ${line.number}</span>
                <span class="line-item-meta">${stationCount} ${ui('stations', 'stanica')} &middot; ${trainCount} ${ui('vehicles', 'vlak.')} ${depotName ? '&middot; ' + escapeHtml(depotName) : ''}</span>
            </div>
            <button class="delete-btn" data-del-line-id="${line.id}">&#10005;</button>
        </div>`;
    }).join('');

    // Attach line item handlers
    routesListContent.querySelectorAll('.line-item').forEach(item => {
        const lineId = parseInt(item.dataset.lineId);
        const line = project.lines.find(l => l.id === lineId);
        if (!line) return;

        item.addEventListener('mouseenter', () => {
            if (currentMode === 'edit') return;
            const latlngs = getLineProfileLatLngs(line);
            if (latlngs) showSidebarHighlight(latlngs, line.color || '#3b82f6', 8);
        });
        item.addEventListener('mouseleave', () => {
            removeSidebarHighlight();
        });
        item.addEventListener('click', (e) => {
            if (e.target.closest('.delete-btn')) return;
            if (blockSidebarRouteActionDuringEdit()) return;
            removeSidebarHighlight();
            if (mobileSidebarMedia.matches) setSidebarOpen(false);
            flyToLine(line);
            setTimeout(() => {
                openLinePopup(line);
            }, 550);
        });
    });

    routesListContent.querySelectorAll('.delete-btn').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            if (blockSidebarRouteActionDuringEdit()) return;
            deleteLine(parseInt(btn.dataset.delLineId));
        };
    });
}

// ─── Project Summary ────────────────────────────────────────────────────────
const ancestorLinkEl = document.getElementById('ancestorLink');

function showAncestorLink(parentId, parentAuthorName) {
    if (!ancestorLinkEl) return;
    const label = parentAuthorName
        ? `${ui('based on', 'predak')}: ${parentAuthorName}`
        : `${ui('based on', 'predak')} #${parentId}`;
    const plannerPath = window.location.pathname;
    const link = document.createElement('a');
    link.href = `${plannerPath}?project=${encodeURIComponent(parentId)}`;
    link.textContent = label;
    ancestorLinkEl.textContent = '(';
    ancestorLinkEl.appendChild(link);
    ancestorLinkEl.appendChild(document.createTextNode(')'));
    ancestorLinkEl.classList.remove('hidden');
}

const sumPopulationEl = document.getElementById('sumPopulation');
const sumMultiPopulationEl = document.getElementById('sumMultiPopulation');
const sumJobsEl = document.getElementById('sumJobs');
const sumMultiJobsEl = document.getElementById('sumMultiJobs');
const sumCostPerPersonEl = document.getElementById('sumCostPerPerson');
const sumCostPerJobEl = document.getElementById('sumCostPerJob');
let coverageDebounceTimer = null;
const COVERAGE_DEBOUNCE_MS = 800;

function markProjectDirty() {
    if (!projectLifecyclePolicy().canEdit) return;
    projectDirty = true;
    // Every save is a POST that creates a new project/version. Dirtying a
    // loaded project disables sharing its old URL and enables that save path.
    // Tracks alone are saveable: the API only requires one valid track (v5+),
    // and requiring a line here silently revoked saving the moment the last
    // line's trasa was deleted — hours of track edits became unpersistable.
    saveBtn.disabled = project.tracks.length === 0;
    saveBtn.title = (project.tracks.length > 0 && project.lines.length === 0)
        ? ui(
            'The project has no service lines; you can add them after saving.',
            'Projekt nema linija — možete ih dodati i nakon spremanja.',
        )
        : '';
    updateShareActionAvailability();
}

function applyCoverageStats(coverageStats, totalCost) {
    sumPopulationEl.textContent = formatNumber(coverageStats.uniquePopulation);
    sumMultiPopulationEl.textContent = formatNumber(coverageStats.multiPopulation);
    sumJobsEl.textContent = formatNumber(coverageStats.uniqueJobs);
    sumMultiJobsEl.textContent = formatNumber(coverageStats.multiJobs);
    sumCostPerPersonEl.textContent = coverageStats.uniquePopulation > 0 ? formatCost(totalCost / coverageStats.uniquePopulation) : '\u2014';
    sumCostPerJobEl.textContent = coverageStats.uniqueJobs > 0 ? formatCost(totalCost / coverageStats.uniqueJobs) : '\u2014';
}

function updateProjectSummary() {
    const hasData = project.tracks.length > 0 || project.stations.length > 0;
    projectSummaryDiv.classList.toggle('hidden', !hasData);
    // A project needs at least one LINE to be a rankable proposal. Saving tracks
    // with no line produced a project that reloads without a line and — because
    // the dedup hash ignored the grouping — could not be re-saved once a line was
    // added ("Identičan projekt već postoji"). Require a line up front.
    markProjectDirty();

    const totalLength = project.tracks.reduce((sum, t) => sum + t.lengthKm, 0);
    const trackCost = project.tracks.reduce((sum, t) => sum + (t.cost || 0), 0);
    const stationCost = project.stations.reduce((sum, s) => sum + (s.cost || 0), 0);
    const transferLinkCost = project.transferLinks.reduce((sum, l) => sum + (l.cost || 0), 0);
    const totalCost = trackCost + stationCost + transferLinkCost;

    document.getElementById('sumLength').textContent = `${totalLength.toFixed(1)} km`;
    document.getElementById('sumCost').textContent = formatCost(totalCost);
    document.getElementById('sumStations').textContent = String(project.stations.length);

    // Show loading indicators and debounce the expensive coverage stats API call
    if (project.stations.length > 0) {
        sumPopulationEl.textContent = '...';
        sumMultiPopulationEl.textContent = '...';
        sumJobsEl.textContent = '...';
        sumMultiJobsEl.textContent = '...';
        sumCostPerPersonEl.textContent = '...';
        sumCostPerJobEl.textContent = '...';
    }
    clearTimeout(coverageDebounceTimer);
    const requestToken = ++projectSummaryRequestToken;
    coverageDebounceTimer = setTimeout(() => {
        computeProjectCoverageStats().then(coverageStats => {
            if (requestToken !== projectSummaryRequestToken) return;
            applyCoverageStats(coverageStats, totalCost);
        });
    }, COVERAGE_DEBOUNCE_MS);
}

// ─── Save Project ───────────────────────────────────────────────────────────
const saveBtn = document.getElementById('saveProject');
const shareBtn = document.getElementById('shareProject');
const sharePopup = document.getElementById('sharePopup');
const shareLinkInput = document.getElementById('shareLink');
const copyShareLinkBtn = document.getElementById('copyShareLink');
const downloadScreenshotBtn = document.getElementById('downloadScreenshot');
const copyScreenshotBtn = document.getElementById('copyScreenshot');
let savedProjectId = null;
let loadedParentId = null;
const leaderboardNavLink = document.getElementById('leaderboardNavLink');
let leaderboardCount = null;

function updateLeaderboardNavLink() {
    if (!leaderboardNavLink) return;
    leaderboardNavLink.textContent = leaderboardCount !== null
        ? `${ui('Leaderboard', 'Ljestvica')} (${leaderboardCount})`
        : ui('Leaderboard', 'Ljestvica');
}
// ─── Leaderboard nav link ─────────────────────────────────────────────────
// Leaderboard is a separate page (leaderboard.html); clicking the nav link navigates there.

let loadedParentAuthorName = null;
let projectDirty = false;
const saveModal = document.getElementById('saveModal');
const discardDraftModal = document.getElementById('discardDraftModal');
const discardDraftTitle = document.getElementById('discardDraftTitle');
const discardDraftMessage = document.getElementById('discardDraftMessage');
const discardDraftCancelBtn = document.getElementById('discardDraftCancel');
const discardDraftConfirmBtn = document.getElementById('discardDraftConfirm');
const infoModal = document.getElementById('infoModal');
const closeInfoModalBtn = document.getElementById('closeInfoModal');
const authorInput = document.getElementById('authorInput');
const modalCancel = document.getElementById('modalCancel');
const modalConfirm = document.getElementById('modalConfirm');
const saveModalError = document.getElementById('saveModalError');
let saveDisabledUntil = 0;
let pendingDraftDiscardAction = null;

function buildShareFilename(kind) {
    const suffix = savedProjectId ? `project-${savedProjectId}` : 'projekt';
    return `${CITY_CONFIG.id || 'transit'}-${suffix}-${kind}.png`;
}

function waitForNextFrame() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function setShareActionPending(button, pending, pendingText) {
    if (!button) return;
    if (!button.dataset.defaultLabel) {
        button.dataset.defaultLabel = button.textContent;
    }
    button.disabled = pending;
    button.textContent = pending ? pendingText : button.dataset.defaultLabel;
}

function updateShareActionAvailability() {
    const hasSavedProject = Boolean(savedProjectId);
    [downloadScreenshotBtn, copyScreenshotBtn].forEach(button => {
        button.disabled = !hasSavedProject;
    });
    if (hasSavedProject) {
        shareBtn.classList.remove('hidden');
        shareBtn.classList.toggle('share-unavailable', projectDirty);
        shareBtn.title = projectDirty ? 'Postoje nespremljene promjene — spremi projekt za dijeljenje' : '';
        if (projectDirty) closeSharePopup();
    } else {
        shareBtn.classList.add('hidden');
        shareBtn.classList.remove('share-unavailable');
        shareBtn.title = '';
    }
    // Same two conditions, same moments: the relief viewer link points at the
    // saved row exactly as a share link does. Hanging it here rather than on
    // each of the five places projectDirty moves is what stops the two drifting
    // apart.
    refreshReliefViewerButton();
}

function ensureHtml2CanvasAvailable() {
    if (typeof window.html2canvas !== 'function') {
        throw new Error('Screenshot alat trenutno nije dostupan.');
    }
}

function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
            if (!blob) {
                reject(new Error('Izvoz slike nije uspio.'));
                return;
            }
            resolve(blob);
        }, 'image/png');
    });
}

async function downloadCanvas(canvas, filename) {
    const blob = await canvasToBlob(canvas);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

async function copyCanvasToClipboard(canvas) {
    if (!navigator.clipboard || typeof window.ClipboardItem !== 'function') {
        throw new Error('Kopiranje slike nije podrzano u ovom pregledniku.');
    }

    const blob = await canvasToBlob(canvas);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

function extractTranslatePixels(transformValue) {
    if (!transformValue || transformValue === 'none') return null;

    const translate3dMatch = transformValue.match(/translate3d\(([-\d.]+)px,\s*([-\d.]+)px/i);
    if (translate3dMatch) {
        return { x: parseFloat(translate3dMatch[1]), y: parseFloat(translate3dMatch[2]) };
    }

    const translateMatch = transformValue.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px/i);
    if (translateMatch) {
        return { x: parseFloat(translateMatch[1]), y: parseFloat(translateMatch[2]) };
    }

    const matrixMatch = transformValue.match(/matrix\(([^)]+)\)/i);
    if (matrixMatch) {
        const values = matrixMatch[1].split(',').map(value => parseFloat(value.trim()));
        if (values.length === 6) {
            return { x: values[4], y: values[5] };
        }
    }

    return null;
}

function normalizeLeafletTransforms(clonedDocument) {
    const view = clonedDocument.defaultView || window;
    const elements = clonedDocument.querySelectorAll('.leaflet-pane, .leaflet-tile, .leaflet-marker-icon, .leaflet-marker-shadow, .leaflet-zoom-animated, .leaflet-zoom-hide');
    elements.forEach(element => {
        const transform = element.style.transform || view.getComputedStyle(element).transform;
        const translate = extractTranslatePixels(transform);
        if (!translate) return;

        const currentLeft = parseFloat(element.style.left || 0) || 0;
        const currentTop = parseFloat(element.style.top || 0) || 0;
        element.style.left = `${currentLeft + translate.x}px`;
        element.style.top = `${currentTop + translate.y}px`;
        element.style.transform = 'none';
    });
}

async function captureScreenshotCanvas() {
    ensureHtml2CanvasAvailable();
    closeSharePopup();
    const wasInfoOpen = !infoModal.classList.contains('hidden');
    if (wasInfoOpen) {
        closeInfoModal();
    }

    document.body.classList.add('is-exporting');
    await waitForNextFrame();

    try {
        return await window.html2canvas(document.body, {
            backgroundColor: '#dbe7f3',
            scale: Math.min(2, window.devicePixelRatio || 1),
            logging: false,
            useCORS: true,
            windowWidth: window.innerWidth,
            windowHeight: window.innerHeight,
            onclone: clonedDocument => {
                normalizeLeafletTransforms(clonedDocument);
            },
        });
    } finally {
        document.body.classList.remove('is-exporting');
        if (wasInfoOpen) {
            openInfoModal();
        }
    }
}

async function runShareImageAction(button, pendingText, successMessage, captureFn, handlerFn) {
    setShareActionPending(button, true, pendingText);
    try {
        const canvas = await captureFn();
        await handlerFn(canvas);
        setStatusMessage(successMessage);
    } catch (error) {
        console.error(error);
        setStatusMessage(error.message, true);
    } finally {
        setShareActionPending(button, false);
    }
}

// World-mode, viewer and language params must survive every URL rewrite: saving a project
// and (auto-)loading one both replace the query string wholesale, which used to
// strip ?photo/?rw before the user ever clicked drive. Deeplink params (st3d/
// line/offset/dir) are deliberately NOT preserved — they are parsed into
// constants once on page load, and resurrecting them would re-trigger the ride
// on every refresh.
//   photo (+ rw/real/photoreal aliases) — the photo world; model — the modeled
//   world (default, kept for explicitness); the rest are photo-world toggles
//   (nocarve/nowalls/notunnel/rwq/elev) and the model-world
//   DGU terrain flags (terrain/elevation).
const WORLD_URL_PARAMS = ['photo', 'model', 'rw', 'real', 'photoreal', 'rwq', 'elev', 'nocarve', 'nowalls', 'notunnel', 'terrain', 'elevation', 'time', 'lang'];

function preserveWorldParams(urlString) {
    const live = new URLSearchParams(window.location.search);
    const url = new URL(urlString, window.location.href);
    for (const param of WORLD_URL_PARAMS) {
        if (live.has(param) && !url.searchParams.has(param)) {
            url.searchParams.set(param, live.get(param));
        }
    }
    return url.toString();
}

function getShareProjectUrl() {
    if (!savedProjectId) return '';

    const pathname = String(window.location.pathname || '');
    let plannerPath = pathname;

    if (pathname.endsWith('/')) {
        plannerPath = pathname || '/';
    } else {
        const pageDirectory = pathname.replace(/[^/]*$/, '') || '/';
        plannerPath = pageDirectory === '/' ? pathname : pageDirectory;
    }

    const url = new URL(`${window.location.origin}${plannerPath}`);
    url.searchParams.set('project', savedProjectId);
    url.searchParams.set('lang', UI_LANGUAGE);
    return url.toString();
}

function closeSharePopup() {
    sharePopup.classList.add('hidden');
    shareBtn.setAttribute('aria-expanded', 'false');
    copyShareLinkBtn.textContent = 'Kopiraj';
}

function openSharePopup() {
    const url = getShareProjectUrl();
    if (!url) return;
    shareLinkInput.value = url;
    sharePopup.classList.remove('hidden');
    shareBtn.setAttribute('aria-expanded', 'true');
    shareLinkInput.focus();
    shareLinkInput.select();
}

function toggleSharePopup() {
    if (sharePopup.classList.contains('hidden')) {
        openSharePopup();
    } else {
        closeSharePopup();
    }
}

function closeDiscardDraftModal() {
    discardDraftModal.classList.add('hidden');
    pendingDraftDiscardAction = null;
}

function openDiscardDraftModal(action, { title, message, cancelLabel, confirmLabel } = {}) {
    pendingDraftDiscardAction = action;
    discardDraftTitle.textContent = title ?? 'Odbaciti skicu linije?';
    discardDraftMessage.textContent = message ?? 'Linija nije dovršena. Ako nastavite, trenutna skica će biti odbačena.';
    discardDraftCancelBtn.textContent = cancelLabel ?? 'Nastavi crtati';
    discardDraftConfirmBtn.textContent = confirmLabel ?? 'Odbaci liniju';
    discardDraftModal.classList.remove('hidden');
    discardDraftCancelBtn.focus();
}

function confirmDraftDiscard() {
    const nextAction = pendingDraftDiscardAction;
    closeDiscardDraftModal();
    if (hasDraftLine()) cancelCurrentLine();
    nextAction?.();
}

function requestDraftDiscard(action) {
    if (!hasDraftLine()) {
        action();
        return;
    }

    closeSharePopup();
    openDiscardDraftModal(action);
}

function requestNavigationGuard(action) {
    if (!hasDraftLine() && !projectDirty) {
        action();
        return;
    }

    closeSharePopup();

    if (projectDirty) {
        openDiscardDraftModal(action, {
            title: 'Napustiti bez spremanja?',
            message: 'Projekt ima nespremljene izmjene. Ako nastavite, izmjene će biti izgubljene.',
            cancelLabel: 'Ostani',
            confirmLabel: 'Napusti',
        });
    } else {
        openDiscardDraftModal(action);
    }
}


function shouldGuardNavigationLink(anchor) {
    if (!anchor) return false;
    if (anchor.hasAttribute('download')) return false;
    if (anchor.target && anchor.target.toLowerCase() !== '_self') return false;

    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return false;

    let destination;
    try {
        destination = new URL(anchor.href, window.location.href);
    } catch (error) {
        return false;
    }

    if (destination.origin !== window.location.origin) return false;
    return destination.href !== window.location.href;
}

function openInfoModal() {
    closeSharePopup();
    closeSidebarOnMobile();
    infoModal.classList.remove('hidden');
    toggleBtn.style.display = 'none';
}

function closeInfoModal() {
    infoModal.classList.add('hidden');
    toggleBtn.style.display = '';
}

openInfoModalBtn.onclick = () => openInfoModal();
closeInfoModalBtn.onclick = () => closeInfoModal();
infoModal.onclick = (e) => { if (e.target === infoModal) closeInfoModal(); };
openGameLogBtn.onclick = () => openGameLog();
if (openChainageBtn) openChainageBtn.onclick = () => openChainageDialog();
closeGameLogBtn.onclick = () => closeGameLog();
clearGameLogBtn.onclick = () => { gameLog.length = 0; renderGameLog(); };
gameLogModal.onclick = (e) => { if (e.target === gameLogModal) closeGameLog(); };
document.getElementById('closeCivilObjects').onclick = () => closeCivilObjectsPanel();
discardDraftCancelBtn.onclick = () => closeDiscardDraftModal();
discardDraftConfirmBtn.onclick = () => confirmDraftDiscard();
discardDraftModal.onclick = (e) => { if (e.target === discardDraftModal) closeDiscardDraftModal(); };

saveBtn.onclick = () => {
    if (!projectLifecyclePolicy().canEdit) {
        setStatusMessage('Ovaj projekt nije moguće uređivati ni spremati.', true);
        return;
    }
    if (Date.now() < saveDisabledUntil) {
        setStatusMessage('Pričekajte prije ponovnog spremanja.');
        return;
    }
    if (project.lines.length === 0) {
        setStatusMessage('Dodajte barem jednu liniju prije spremanja (grupirajte stanice u liniju).', true);
        return;
    }
    closeSharePopup();
    authorInput.value = '';
    saveModalError.textContent = '';
    saveModalError.classList.add('hidden');
    saveModal.classList.remove('hidden');
    authorInput.focus();
};

modalCancel.onclick = () => saveModal.classList.add('hidden');
saveModal.onclick = (e) => { if (e.target === saveModal) saveModal.classList.add('hidden'); };
authorInput.onkeydown = (e) => { if (e.key === 'Enter') modalConfirm.click(); if (e.key === 'Escape') saveModal.classList.add('hidden'); };
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (!discardDraftModal.classList.contains('hidden')) {
            closeDiscardDraftModal();
            return;
        }
        if (!saveModal.classList.contains('hidden')) {
            saveModal.classList.add('hidden');
            return;
        }
        if (isCivilObjectsPanelOpen()) {
            closeCivilObjectsPanel();
            return;
        }
        if (!sharePopup.classList.contains('hidden')) {
            closeSharePopup();
            return;
        }
        if (!infoModal.classList.contains('hidden')) {
            closeInfoModal();
            return;
        }
        if (routeGaugePickerOpen) {
            e.preventDefault();
            setRouteGaugePickerOpen(false);
            setStatusMessage('Pokretanje nove trase otkazano.');
            return;
        }
        if (currentMode === 'drawLine') {
            e.preventDefault();
            setMode('explore');
            setStatusMessage('Crtanje trase isključeno.');
            return;
        }
        if (currentMode === 'placeStation') {
            e.preventDefault();
            setMode('explore');
            setStatusMessage('Postavljanje stanica isključeno.');
            return;
        }
        if (currentMode === 'edit') {
            finishEditMode();
            return;
        }
        if (selectedObject) {
            deselectObject();
            return;
        }
        return;
    }

    // Map shortcuts: T toggles tram stops, R toggles reference rail, K rides the
    // cab. Skip when the user is typing into a field, has a modifier held, or
    // any modal is open.
    const target = e.target;
    const isTyping = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (isTyping || e.metaKey || e.ctrlKey || e.altKey) return;
    const aModalOpen =
        (discardDraftModal && !discardDraftModal.classList.contains('hidden')) ||
        (saveModal && !saveModal.classList.contains('hidden')) ||
        (sharePopup && !sharePopup.classList.contains('hidden')) ||
        (infoModal && !infoModal.classList.contains('hidden'));
    if (aModalOpen) return;

    const key = e.key.toLowerCase();
    if (key === 't' && toggleTramStopsBtn && !toggleTramStopsBtn.disabled) {
        e.preventDefault();
        toggleTramStopsBtn.checked = !toggleTramStopsBtn.checked;
        toggleTramStopsBtn.dispatchEvent(new Event('change'));
    } else if (key === 'r' && toggleReferenceRailProjectsBtn && !toggleReferenceRailProjectsBtn.disabled) {
        e.preventDefault();
        toggleReferenceRailProjectsBtn.checked = !toggleReferenceRailProjectsBtn.checked;
        toggleReferenceRailProjectsBtn.dispatchEvent(new Event('change'));
    } else if (key === 'k') {
        // Same entry point as the "U kabinu" button, so the two can never drift
        // apart — including its profile/terrain pre-step, which re-enters this
        // function once the grade is solved.
        const target = window.__plannerCabTarget.pickCabTarget(project, selectedObject);
        if (!target) {
            setStatusMessage('Nema vlaka za kabinu — dodajte vlak na liniju.', true);
            return;
        }
        e.preventDefault();
        try {
            if (!openPlannerTrainCab(target.train, target.line)) {
                // false means DECLINED, not "opening" — the profile pre-step
                // returns true and re-enters itself, so this really is a refusal.
                setStatusMessage('Otvaranje kabine nije uspjelo.', true);
            }
        } catch (error) {
            console.error('Planner cab open error (K shortcut):', error);
            setStatusMessage('Otvaranje kabine nije uspjelo.', true);
        }
    }
});

document.addEventListener('pointerdown', (e) => {
    if (sharePopup.classList.contains('hidden')) return;
    if (sharePopup.contains(e.target) || shareBtn.contains(e.target)) return;
    closeSharePopup();
});

async function refreshLoadedRailJunctions(projectId = savedProjectId) {
    if (!projectId) {
        loadedRailJunctions = [];
        return [];
    }
    try {
        const response = await fetch(
            `${API_BASE_URL}/transit/projects/${encodeURIComponent(projectId)}/rail-junctions`,
            { cache: 'no-store' },
        );
        if (!response.ok) throw new Error(`rail-junctions ${response.status}`);
        loadedRailJunctions = await response.json();
    } catch (error) {
        console.warn('[rail-connections] junction list unavailable:', error?.message || error);
        loadedRailJunctions = [];
    }
    return loadedRailJunctions;
}

function sourcePortForIntent(intent, projectId) {
    const trackIndex = project.tracks.findIndex(track => track.id === intent.sourceTrackId);
    const track = project.tracks[trackIndex];
    if (!track) throw new Error('Spojena trasa više ne postoji.');
    const lineIndex = project.lines.findIndex(line => lineUsesTrack(line, track.id));
    const line = project.lines[lineIndex];
    const profile = line ? getLineMotionProfile(line) : null;
    if (!line || !profile?.totalLengthMeters) {
        throw new Error('Spojena trasa mora pripadati dovršenoj liniji.');
    }
    const endpointLatLng = intent.sourceEndpoint === 'start'
        ? track.latlngs[0]
        : track.latlngs[track.latlngs.length - 1];
    const lineOffsetM = getOffsetOnLine(L.latLng(endpointLatLng[0], endpointLatLng[1]), profile);
    if (!Number.isFinite(lineOffsetM)) throw new Error('Nije moguće pronaći spoj na voznoj liniji.');
    const nearStart = lineOffsetM <= 2;
    const nearEnd = profile.totalLengthMeters - lineOffsetM <= 2;
    if (!nearStart && !nearEnd) throw new Error('Vanjski spoj mora biti na kraju vozne linije.');
    const trackChainages = trackVertexChainages(track);
    return {
        projectId: Number(projectId),
        lineIndex,
        trackIndex,
        trackChainageM: intent.sourceEndpoint === 'start'
            ? 0
            : trackChainages[trackChainages.length - 1],
        lineOffsetM,
        outboundDirection: nearStart ? 1 : -1,
    };
}

async function persistPendingRailConnections(projectId) {
    if (pendingRailConnectionIntents.length === 0) return { saved: 0, failed: [] };
    const failed = [];
    let saved = 0;
    for (const intent of [...pendingRailConnectionIntents]) {
        try {
            const sourcePort = sourcePortForIntent(intent, projectId);
            const response = await fetch(`${API_BASE_URL}/transit/rail-junctions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: intent.target.name || intent.target.ref || null,
                    ports: [sourcePort, intent.target],
                }),
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(body.error || `rail-junction ${response.status}`);
            saved += 1;
            pendingRailConnectionIntents = pendingRailConnectionIntents.filter(candidate => candidate !== intent);
        } catch (error) {
            failed.push(error.message);
        }
    }
    await refreshLoadedRailJunctions(projectId);
    return { saved, failed };
}

modalConfirm.onclick = async () => {
    const authorName = authorInput.value.trim();
    if (!authorName) { authorInput.focus(); return; }
    saveModal.classList.add('hidden');
    modalConfirm.disabled = true;

    const projectData = buildCanonicalProjectData();

    saveBtn.disabled = true;
    projectDirty = false;
    updateShareActionAvailability();
    setStatusMessage('Spremam projekt...');

    try {
        const resp = await fetch(`${API_BASE_URL}/transit/projects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                author_name: authorName,
                project_data: projectData,
                parent_id: loadedParentId,
            }),
        });
        if (!resp.ok) {
            const body = await resp.json().catch(() => ({}));
            throw new Error(body.error || `Greska: ${resp.status}`);
        }
        const result = await resp.json();
        if (loadedParentId) {
            showAncestorLink(loadedParentId, loadedParentAuthorName);
        }
        // The loaded reference remains untouched in storage. Once its edited
        // working copy has its own ID, the live planner state must match the
        // proposal that was actually saved (and that a reload would produce).
        Object.assign(project, PROJECT_LIFECYCLE_API.authoredProjectIdentity());
        for (const track of project.tracks) delete track.reference;
        savedProjectId = result.id;
        loadedParentId = result.id;
        loadedParentAuthorName = authorName;
        const projectNameLabel = document.getElementById('projectNameLabel');
        if (projectNameLabel) projectNameLabel.textContent = `${authorName} — `;
        syncMapActionButtons();
        updateLeaderboardNavLink();
        history.replaceState(null, '', preserveWorldParams(`?project=${encodeURIComponent(result.id)}`));
        const connectionResult = await persistPendingRailConnections(result.id);
        const metricsPending = result.metrics_status === 'pending' || result.metrics_status === 'processing';
        const savedMessage = metricsPending
            ? `Projekt spremljen kao nova verzija #${escapeHtml(String(result.id))}; poveznica radi odmah. `
                + 'Pokazatelji dosega čekaju Valhallu i API će ih automatski izračunati kad ponovno bude dostupna. '
                + 'Projekt će se tada pojaviti na ljestvici.'
            : `Projekt spremljen kao nova verzija #${escapeHtml(String(result.id))}. `
                + 'Za drugi preglednik upotrijebite trenutačnu adresu. '
                + '<a href="leaderboard.html">Pogledaj ljestvicu</a>';
        const connectionMessage = connectionResult.saved > 0
            ? ` Spremljeno spojeva: ${connectionResult.saved}.`
            : '';
        const connectionError = connectionResult.failed.length > 0
            ? ` Spoj nije spremljen: ${escapeHtml(connectionResult.failed.join('; '))}`
            : '';
        // Broken geometry no longer blocks an edit, so saving is the one moment
        // that says out loud how much of it is being carried along.
        const problemCount = getProjectGeometryProblems().length;
        const problemMessage = problemCount > 0
            ? ` Označenih dionica s upozorenjem: ${problemCount}.`
            : '';
        setStatusMessage(
            savedMessage + connectionMessage + problemMessage + connectionError,
            connectionResult.failed.length > 0,
        );
        shareBtn.classList.remove('hidden');
        updateShareActionAvailability();
        closeSharePopup();
        modalConfirm.disabled = false;
        saveDisabledUntil = Date.now() + 10000;
        setTimeout(() => { saveBtn.disabled = !projectDirty; }, 10000);
    } catch (err) {
        console.error(err);
        projectDirty = true;
        saveBtn.disabled = false;
        updateShareActionAvailability();
        setStatusMessage('Spremanje nije uspjelo.', true);
        saveModalError.textContent = err.message;
        saveModalError.classList.remove('hidden');
        saveModal.classList.remove('hidden');
        modalConfirm.disabled = false;
    }
};

shareBtn.onclick = () => {
    if (projectDirty) {
        setStatusMessage('Nespremljene promjene — spremi projekt za dijeljenje.');
        return;
    }
    toggleSharePopup();
};

copyShareLinkBtn.onclick = async () => {
    const shareUrl = shareLinkInput.value;
    try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(shareUrl);
        } else {
            shareLinkInput.focus();
            shareLinkInput.select();
            document.execCommand('copy');
        }
        closeSharePopup();
        setStatusMessage('Link kopiran u međuspremnik.');
    } catch (error) {
        console.error(error);
        setStatusMessage('Kopiranje linka nije uspjelo.', true);
    }
};

downloadScreenshotBtn.onclick = () => runShareImageAction(
    downloadScreenshotBtn,
    'Priprema... ',
    'Screenshot projekta preuzet.',
    captureScreenshotCanvas,
    canvas => downloadCanvas(canvas, buildShareFilename('screenshot'))
);

copyScreenshotBtn.onclick = () => runShareImageAction(
    copyScreenshotBtn,
    'Kopiram... ',
    'Screenshot projekta kopiran u meduspremnik.',
    captureScreenshotCanvas,
    copyCanvasToClipboard
);

// ─── Load Saved Project ─────────────────────────────────────────────────────
const demandLabelLayers = new Map(); // stationId -> L.marker
function clearExistingProject() {
    closeRailConnectionChoice();

    // Stop all train animations
    for (const line of animatedLines) {
        if (line.trains) {
            for (const train of line.trains) {
                if (train.marker) map.removeLayer(train.marker);
            }
        }
        clearLineStationDistanceLabels(line);
    }
    animatedLines.clear();
    if (trainAnimationFrameId !== null) {
        cancelAnimationFrame(trainAnimationFrameId);
        trainAnimationFrameId = null;
        lastTrainAnimationTimestamp = null;
    }

    // Remove track layers
    for (const track of project.tracks) {
        if (track.layer) map.removeLayer(track.layer);
        if (track.hitLayer) map.removeLayer(track.hitLayer);
        if (track.decorGroup) map.removeLayer(track.decorGroup);
        if (track.stationEnvelopeGroup) map.removeLayer(track.stationEnvelopeGroup);
    }

    // Remove station layers
    for (const station of project.stations) {
        if (station.markerLayer) map.removeLayer(station.markerLayer);
        if (station.catchmentLayer) map.removeLayer(station.catchmentLayer);
    }

    // Remove transfer link layers
    for (const link of project.transferLinks) {
        if (link.layer) map.removeLayer(link.layer);
    }

    // Remove popups and overlays
    removeDepotPopup();
    removeLineHighlight();
    removeSidebarHighlight();

    // Remove demand label layers
    for (const [, marker] of demandLabelLayers) {
        map.removeLayer(marker);
    }
    demandLabelLayers.clear();

    // Reset project data
    project.purpose = 'proposal';
    project.access = 'editable';
    project.referenceKind = null;
    project.provenance = null;
    project.tracks.length = 0;
    project.lines.length = 0;
    project.stations.length = 0;
    project.transferLinks.length = 0;
    project.totalRevenue = 0;
    project.locationId = null;
    pendingRailConnectionIntents = [];
    loadedRailJunctions = [];

    // Reset ID counters
    nextTrackId = 1;
    nextLineId = 1;
    nextLineNumber = 1;
    nextStationId = 1;
    nextTrainId = 1;
    nextTransferLinkId = 1;
    nextStationSerial = 1;
    nextDepotSerial = 1;

    // Reset selection state
    if (selectedObject) deselectObject();

    // Clear project name label
    const projectNameLabel = document.getElementById('projectNameLabel');
    if (projectNameLabel) projectNameLabel.textContent = '';
}

async function loadSavedProject(projectId) {
    clearExistingProject();
    loadingDiv.classList.remove('hidden');
    setStatusMessage('Učitavam projekt...');

    // Set early so the ljestvica nav link is correct before the async load completes.
    savedProjectId = projectId;
    updateLeaderboardNavLink();

    try {
        const resp = await fetch(`${API_BASE_URL}/transit/projects/${projectId}`);
        if (!resp.ok) throw new Error(`Projekt nije pronaden (${resp.status})`);
        const saved = await resp.json();
        const data = normalizeSavedProjectData(saved.project_data);
        project.purpose = data.purpose || 'proposal';
        project.access = data.access || 'editable';
        project.referenceKind = data.referenceKind || null;
        project.provenance = data.provenance || null;
        // Establish internal project context before location-scoped map layers
        // start. Geometry wins over both stored metadata and any legacy URL hint.
        const loadedPoints = [];
        for (const track of data.tracks || []) for (const ll of track.latlngs || []) loadedPoints.push(ll);
        setProjectLocationId(
            window.__locationRegistry?.detectByPoints(loadedPoints) || data.location,
        );
        // The project may have switched the location (or is the first thing that
        // establishes it), so the existing-rail context is drawn from here on.
        refreshReferenceRailMapLayer();
        refreshChainageButton();
        const savedMetricsStatus = saved.metrics_status || saved?.computed_data?.metrics_status || 'ready';
        const savedMetricsPending = savedMetricsStatus === 'pending' || savedMetricsStatus === 'processing';
        const storedWalkTime = loadPersistedWalkTime();
        const effectiveWalkTime = normalizeWalkTimeValue(storedWalkTime || data.walkMinutes);
        const effectiveWalkMinutes = parseInt(effectiveWalkTime, 10);
        const canReuseSavedCatchments = !savedMetricsPending
            && !storedWalkTime
            && Number(saved?.project_data?.walkMinutes) === effectiveWalkMinutes;
        const runtimeLineIds = [];
        const derivedStationHydrationJobs = [];

        syncWalkTimeControls(effectiveWalkTime);

        if (data.tracks.length === 0) {
            throw new Error('Projekt nema valjanih trasa.');
        }

        // Reconstruct tracks (physical infrastructure)
        const runtimeTrackIds = [];
        const pendingVerticalProfiles = [];
        for (const trackData of data.tracks) {
            const levelGeometry = materializeLegacyIsolatedLevelPoints(
                trackData.latlngs,
                trackData.levels,
                trackData.gauge,
            );
            if (levelGeometry.expandedCount > 0) {
                console.info(`[load] Expanded ${levelGeometry.expandedCount} legacy single-point level section(s).`);
            }
            const track = createRuntimeTrack(
                trackData.gauge,
                levelGeometry.latlngs,
                levelGeometry.levels,
                trackData,
                { deferVerticalProfile: true },
            );
            // Profile freshness also includes station chainages. Defer adoption
            // until stations exist; checking here would reject every correctly
            // saved station-aware profile against an empty runtime station set.
            pendingVerticalProfiles.push(trackData.verticalProfile || null);
            // Anchor the author's pinned elevations RIGHT NOW, unconditionally.
            //
            // Adoption below can legitimately fail — the freshness hash folds in
            // each station's profile span, which folds in that station's level,
            // which is itself derived from a profile that does not exist yet at
            // load time. Any change to the tunnel-depth rule (and the debounced
            // first solve racing this loop) can therefore flip the hash on a
            // project that is otherwise perfectly valid. Losing the SHAPE to a
            // re-solve is recoverable; losing the PINS is the user's authoring
            // work, and it was being dropped silently because the only branch
            // that anchored them was the one adoption did not take.
            adoptSavedProfilePins(track, trackData.verticalProfile);
            runtimeTrackIds.push(track.id);
            project.tracks.push(track);
        }

        // Reconstruct stations first (lines may reference them via stationIndices in v6)
        const runtimeStationIds = [];
        for (const [index, stData] of data.stations.entries()) {
            // Adapters resolve trackIndex for all formats; derive from lineIndex → trackIndex as fallback
            let trackIndex = stData.trackIndex >= 0 ? stData.trackIndex : -1;
            if (trackIndex < 0 && stData.lineIndex >= 0 && stData.lineIndex < data.lines.length) {
                const lineTrackIdx = data.lines[stData.lineIndex]?.trackIndex;
                if (Number.isInteger(lineTrackIdx) && lineTrackIdx >= 0) trackIndex = lineTrackIdx;
            }
            const trackId = trackIndex >= 0 ? (runtimeTrackIds[trackIndex] ?? runtimeTrackIds[0]) : (runtimeTrackIds[0] || null);
            const track = trackId ? project.tracks.find(t => t.id === trackId) : null;
            const trackGauge = normalizeGauge(track?.gauge);
            const stationAnchor = track ? getStationSegmentAnchor({ latlng: stData.latlng }, track.latlngs) : null;
            const stationLevel = track && stationAnchor
                ? getInterpolatedLevel(track, stationAnchor.segmentIndex, stationAnchor.t)
                : 0;
            const stationType = stData.stationType;
            const cachedStation = canReuseSavedCatchments ? getSavedComputedStationData(saved, index) : null;
            const stationIcon = L.divIcon({
                className: getStationMarkerClass(trackGauge, stationType, stationLevel),
                iconSize: [16, 16], iconAnchor: [8, 8],
            });

            const markerLayer = L.marker(stData.latlng, { icon: stationIcon }).addTo(map);
            const stCatchmentLayer = createStationCatchmentLayer(cachedStation?.catchmentPolygon || null);

            const station = {
                id: nextStationId++,
                trackId,
                lineId: null, // assigned later when lines are reconstructed
                latlng: stData.latlng,
                walkMinutes: effectiveWalkMinutes,
                stationType,
                name: stData.name || '',
                // Saved flag when present; otherwise infer (a station still on
                // its default "Stanica N" name is auto, a custom one is locked).
                autoNamed: stData.autoNamed ?? isDefaultStationName(stData.name),
                cost: computeStationConstructionCost(
                    stationType, trackGauge,
                    stData.structureKind || PRICING_API.stationKindFromLevel(stationLevel),
                ),
                catchmentPolygon: cachedStation?.catchmentPolygon || null,
                catchmentPopulation: cachedStation?.population || 0,
                catchmentJobs: cachedStation?.jobs || 0,
                catchmentLayer: stCatchmentLayer,
                markerLayer,
            };

            runtimeStationIds.push(station.id);
            project.stations.push(station);
            attachStationClickHandler(station);
            refreshStationMarkerPresentation(station);

            if (!cachedStation && !savedMetricsPending) {
                derivedStationHydrationJobs.push((async () => {
                    const derivedData = effectiveWalkMinutes > 0
                        ? await fetchCachedStationCatchment(station.latlng[0], station.latlng[1], effectiveWalkMinutes)
                        : { catchmentPolygon: null, catchmentPopulation: 0, catchmentJobs: 0 };
                    station.catchmentPolygon = derivedData.catchmentPolygon;
                    station.catchmentPopulation = derivedData.catchmentPopulation;
                    station.catchmentJobs = derivedData.catchmentJobs;
                    if (station.catchmentLayer) {
                        map.removeLayer(station.catchmentLayer);
                    }
                    station.catchmentLayer = createStationCatchmentLayer(derivedData.catchmentPolygon);
                })());
            }
        }

        // Now the complete station constraint set exists, adopt only the exact
        // saved solve. A stale auto solve is discarded, while explicit locks
        // are first converted to geographic anchors so the replacement solve
        // preserves the user's authored intent.
        for (let index = 0; index < runtimeTrackIds.length; index++) {
            const track = project.tracks.find((candidate) => candidate.id === runtimeTrackIds[index]);
            const savedProfile = pendingVerticalProfiles[index];
            if (!track) continue;
            // Loading owns the track until this decision is complete. This is
            // defensive even though createRuntimeTrack was asked to defer: if
            // another load-time path ever schedules work, its in-flight token
            // still cannot overwrite the saved profile adopted below.
            cancelTrackVerticalProfileWork(track);
            // Station-envelope width is profile-dependent. Validate the saved
            // hash WITH the saved profile provisionally installed; checking
            // while verticalProfile is null falls back to coarse saved levels,
            // rejects a valid tunnel/viaduct solve, and starts a needless
            // rederive on every hard reload.
            let savedProfileMatches = false;
            if (savedProfile?.inputRevision === VERTICAL_PROFILE_INPUT_REVISION) {
                setTrackVerticalProfile(track, savedProfile);
                savedProfileMatches = savedProfile.geomHash === currentTrackProfileHash(track);
            }
            if (savedProfileMatches) {
                hydrateTrackTerrainProfileFromSavedProfile(track);
                // Anchor the saved pins here too, not only on the stale branch
                // below: an adopted profile's pins are just as authored, and
                // without anchors a later recompute treats the route as unpinned.
                ensureElevationEditsFromProfile(track);
                // …and anchor the whole PVI set, so the first geometry edit
                // after a load carries the saved shape instead of re-solving.
                snapshotProfileGeoAnchors(track);
                applyDerivedTrackLevels(track);
                rebuildTrackDecor(track);
            } else if (savedProfile?.pvis?.length >= 2) {
                // A saved profile the freshness hash rejects (geometry edited
                // elsewhere, or a revision bump like the move onto the route's
                // own chainage domain) must still be CARRIED, not re-optimised.
                // Handing it back to the DP re-answers "what is cheapest" rather
                // than "what did the author draw", and returns a different route
                // — an authored 3.5 km tunnel came back as 0.4 km of sawtooth
                // purely from loading the project.
                //
                // Geo-anchoring every PVI is domain-independent, so the carry
                // survives a rescaled chainage axis exactly. computeTrackVertical
                // Profile below picks these up and re-derives the drawn shape;
                // the DP now only ever runs on a track that has nothing to carry.
                setTrackVerticalProfile(track, savedProfile);
                ensureElevationEditsFromProfile(track);
                snapshotProfileGeoAnchors(track);
                setTrackVerticalProfile(track, null);
            }
            // A complete current save needs neither a solve nor a terrain
            // request. A current profile without embedded terrain schedules
            // only that missing fetch; stale/missing data gets the PVI-preserving
            // rederive above.
            if (!trackHasFreshAslProfile(track) || !trackHasFreshTerrainProfile(track)) {
                scheduleTrackVerticalProfile(track);
            }
        }

        if (derivedStationHydrationJobs.length > 0) {
            setStatusMessage('Učitavam projekt i ponovno računam doseg stanica...');
            const hydrationResults = await Promise.allSettled(derivedStationHydrationJobs);
            hydrationResults.forEach(result => {
                if (result.status === 'rejected') {
                    console.error('Saved station catchment recompute error:', result.reason);
                }
            });
        }

        rebuildStationIndex();

        // Reconstruct lines (service routes on tracks)
        for (const [index, lineData] of data.lines.entries()) {
            const runtimeLineId = allocateLineId();
            const lineNumber = allocateLineNumber(index + 1);
            const lineColor = getLineColor(lineNumber);
            const isV6 = Array.isArray(lineData.stationIndices) && lineData.stationIndices.length >= 2;

            if (isV6) {
                // v6: line is a list of stations — tracks are derived from stations
                const stationIds = lineData.stationIndices
                    .map(si => runtimeStationIds[si])
                    .filter(id => id != null);
                const depotStationId = lineData.depotStationIndex >= 0
                    ? (runtimeStationIds[lineData.depotStationIndex] ?? null)
                    : null;
                // Derive type from first station's track
                const firstStation = stationIds.length > 0 ? _stationById.get(stationIds[0]) : null;
                const firstTrack = firstStation?.trackId ? project.tracks.find(t => t.id === firstStation.trackId) : null;

                const line = {
                    id: runtimeLineId,
                    number: lineNumber,
                    color: lineColor,
                    gauge: normalizeGauge(firstTrack?.gauge),
                    stationIds,
                    depotStationId,
                };

                // Assign lineId to all stations on this line
                for (const stId of stationIds) {
                    const st = _stationById.get(stId);
                    if (st) st.lineId = runtimeLineId;
                }

                line.savedTrainCount = lineData.trainCount || 1;
                runtimeLineIds.push(runtimeLineId);
                project.lines.push(line);

                // Build motion profile and station stops from stationIds
                buildLineMotionProfileFromStations(line);
                updateLineStationStopsFromIds(line);
                startLineTrain(line);
            } else {
                // v5 compat: single trackIndex — trains started after migration below
                const trackId = runtimeTrackIds[lineData.trackIndex] ?? runtimeTrackIds[0];
                const track = project.tracks.find(t => t.id === trackId);
                const line = {
                    id: runtimeLineId,
                    number: lineNumber,
                    color: lineColor,
                    gauge: normalizeGauge(track?.gauge),
                    trackId,
                    savedTrainCount: lineData.trainCount || 1,
                };
                runtimeLineIds.push(runtimeLineId);
                project.lines.push(line);
            }
        }

        // Assign lineId to stations that reference a line via lineIndex
        for (const [index, stData] of data.stations.entries()) {
            if (!(Number.isInteger(stData.lineIndex) && stData.lineIndex >= 0)) continue;
            const runtimeLineId = runtimeLineIds[stData.lineIndex] ?? null;
            if (runtimeLineId == null) continue;
            const station = project.stations[index];
            if (station && !station.lineId) {
                station.lineId = runtimeLineId;
                refreshStationMarkerPresentation(station);
            }
        }

        // stationIndices define the route path, while lineIndex also includes
        // intermediate stations added after that route was created. Earlier
        // loads rebuilt stationStops before assigning those lineIndex values,
        // leaving saved additions absent from train service and the 3D cab.
        for (const line of project.lines) {
            if (line.stationIds && line.stationIds.length >= 2) {
                updateLineStationStopsFromIds(line);
            } else {
                updateLineStationStops(line);
            }
        }

        // Migrate legacy lines (v2) to stationIds so they work like v6 lines.
        // Legacy lines have line.trackId but no stationIds; we derive stationIds from
        // the stations that belong to the line, ordered by offset along the track.
        for (const line of project.lines) {
            if (line.stationIds && line.stationIds.length >= 2) {
                // v6 line already has stationIds and trains started — skip
                continue;
            }
            // Collect all stations belonging to this line, ordered by offset along the track
            const track = getTrackForLine(line);
            if (track) buildTrackMotionProfile(track);
            const lineStations = project.stations.filter(s => s.lineId === line.id);
            if (lineStations.length >= 2 && track?.motionProfile) {
                const withOffset = lineStations.map(s => ({
                    station: s,
                    offset: getOffsetOnLine(L.latLng(s.latlng[0], s.latlng[1]), track.motionProfile),
                })).filter(e => e.offset !== null).sort((a, b) => a.offset - b.offset);
                if (withOffset.length >= 2) {
                    line.stationIds = withOffset.map(e => e.station.id);
                    // Pick depot or first station
                    const depotStation = withOffset.find(e => e.station.stationType === 'depot');
                    line.depotStationId = depotStation ? depotStation.station.id : withOffset[0].station.id;
                    // Assign names to nameless stations
                    for (const { station } of withOffset) {
                        if (!station.name) {
                            station.name = generateDefaultStationName(station.stationType);
                        }
                    }
                    // Start trains (builds line motion profile internally)
                    startLineTrain(line);
                    continue;
                }
            }
            // Fallback for lines that couldn't be migrated (< 2 stations)
            updateLineStationStops(line, { initializePause: true });
            startLineTrain(line);
        }

        // Reconstruct transfer links
        for (const linkData of data.transferLinks || []) {
            const stA = project.stations[linkData.stationAIndex];
            const stB = project.stations[linkData.stationBIndex];
            if (stA && stB) {
                const layer = L.polyline([stA.latlng, stB.latlng], TRANSFER_LINK_STYLE).addTo(map);
                const link = {
                    id: nextTransferLinkId++,
                    stationIdA: stA.id,
                    stationIdB: stB.id,
                    linkType: linkData.linkType,
                    cost: getCurrentTransferLinkPrice(linkData.linkType),
                    layer,
                };
                project.transferLinks.push(link);
                attachTransferLinkClickHandler(link);
                updateStationLinkIndicator(stA);
                updateStationLinkIndicator(stB);
            }
        }

        // Sync serial counters from loaded station names
        let maxStationSerial = 0, maxDepotSerial = 0;
        for (const st of project.stations) {
            const m = st.name?.match(/^(Stanica|Remiza)\s+(\d+)$/);
            if (m) {
                const n = parseInt(m[2], 10);
                if (m[1] === 'Stanica') maxStationSerial = Math.max(maxStationSerial, n);
                else maxDepotSerial = Math.max(maxDepotSerial, n);
            }
        }
        nextStationSerial = Math.max(nextStationSerial, maxStationSerial + 1);
        nextDepotSerial = Math.max(nextDepotSerial, maxDepotSerial + 1);

        // Costs were computed track by track as the project was rebuilt, before
        // the saved vertical profiles were attached — so they were the coarse
        // levels-only numbers, and a loaded project showed a different total
        // than the object bill for the same alignment. Everything the model
        // needs exists by now, so price the whole project once, properly.
        recomputeProjectCostsFromPricing();
        updateTracksListUI();
        updateProjectSummary();
        projectDirty = false;
        saveBtn.disabled = true;
        syncMapActionButtons();

        // Fit map to project bounds
        if (project.tracks.length > 0) {
            const allPoints = project.tracks.flatMap(t => t.latlngs);
            const bounds = L.latLngBounds(allPoints);
            map.fitBounds(bounds, { padding: [50, 50] });
        }

        savedProjectId = projectId;
        await refreshLoadedRailJunctions(projectId);
        updateLeaderboardNavLink();
        history.replaceState(null, '', preserveWorldParams(`?project=${encodeURIComponent(projectId)}`));
        loadedParentId = Number(projectId);
        loadedParentAuthorName = saved.author_name;
        if (saved.parent_id) {
            showAncestorLink(saved.parent_id, saved.parent_author_name);
        }
        shareBtn.classList.remove('hidden');
        updateShareActionAvailability();
        closeSharePopup();
        const projectNameLabel = document.getElementById('projectNameLabel');
        if (projectNameLabel) {
            const referenceLabel = projectIsReference() ? 'Referentna pruga — ' : '';
            projectNameLabel.textContent = `${referenceLabel}${saved.author_name ? `${saved.author_name} — ` : ''}`;
        }
        if (savedMetricsPending) {
            setStatusMessage(
                `Projekt "${escapeHtml(saved.author_name)}" učitan. `
                + 'Pokazatelji dosega još čekaju Valhallu; API će ih dopuniti automatski kad bude dostupna.',
            );
        } else {
            setStatusMessage(`Projekt "${escapeHtml(saved.author_name)}" učitan.`);
        }
    } catch (err) {
        console.error(err);
        setStatusMessage(err.message, true);
    } finally {
        loadingDiv.classList.add('hidden');
        // Here rather than beside the other post-load refreshes: this runs on every
        // load path, and the button's precondition — a saved project carrying a
        // solved profile — is only settled once the load has finished.
        refreshChainageButton();
        // Standing geometry warnings are derived, never stored, so a reopened
        // project has to rediscover its own red stretches.
        scheduleTrackProblemOutlines();
    }
}

// Check for ?project=ID query param; if absent, load the top leaderboard project
// unless a scene deeplink explicitly requests the empty live-network view.
const urlParams = new URLSearchParams(window.location.search);
const station3DSessionLink = window.__station3DLinks.parseSessionQuery(window.location.search);
const station3DLinkMode = station3DSessionLink.mode;
// A redirect can be pending while the old document finishes parsing.
const explorerRedirectRequested = !!window.__station3DLinks.legacyExplorerRedirect(window.location.href);
const loadProjectId = urlParams.get('project');
// ?new=1 forces a blank planner: without it, a project-less load falls back to
// the top leaderboard project (a landing demo), which would hijack "start a new
// project here" back into someone else's project.
const blankProjectRequested = !loadProjectId && urlParams.get('new') === '1';
const liveNetworkSceneRequested = !loadProjectId && urlParams.get('scene') === 'live-network';
// Coordinates are the canonical opening view. `loc` is accepted once for old
// links, then removed after the page's synchronous boot so legacy lazy-load
// policy can still see it. A loaded project re-fits to its own tracks after.
{
    const initialLat = Number.parseFloat(urlParams.get('lat'));
    const initialLon = Number.parseFloat(urlParams.get('lon'));
    const requestedLoc = (urlParams.get('loc') || '').trim().toLowerCase();
    if (Number.isFinite(initialLat) && Number.isFinite(initialLon)) {
        map.setView([initialLat, initialLon], 13);
    } else if (window.__locationRegistry?.isKnown(requestedLoc)) {
        centerMapOnLocation(requestedLoc);
    }
    // Existing-rail context for a project-less view; a loaded project refreshes
    // it again once its geometry has established the internal location.
    // Non-planner world links are ignored by this host before planner boot.
    if (!explorerRedirectRequested && station3DLinkMode !== 'scenario') {
        refreshReferenceRailMapLayer();
    }
    refreshChainageButton();
    if (urlParams.has('loc')) {
        window.addEventListener('load', () => {
            const canonical = PLANNER_LOCATION_API.withoutLegacyLocation(window.location.href);
            history.replaceState(null, '', canonical);
        }, { once: true });
    }
}
const openRandomTramCabRequested = liveNetworkSceneRequested && urlParams.get('cab') === 'random-tram';
const openStationCabRequested = liveNetworkSceneRequested && urlParams.get('cab') === 'station';
const openWalk3DLinkRequested = station3DLinkMode === 'walk';
const openStation3DScenarioRequested = station3DLinkMode === 'scenario';
const openSharedTram3DLinkRequested = station3DLinkMode === 'tram';
const openPlannerCab3DLinkRequested = station3DLinkMode === 'planner-cab';
const linkedPlannerCabLineParam = openPlannerCab3DLinkRequested ? (urlParams.get('line') || '').trim() : '';
const linkedPlannerCabOffsetParam = Number.parseFloat(urlParams.get('offset'));
const linkedPlannerCabDirectionParam = urlParams.get('dir') === '-1' ? -1 : 1;
const linkedCabStationParam = openStationCabRequested
    ? (urlParams.get('stop') || urlParams.get('station') || '').trim()
    : '';
const linkedCabDirectionParam = openStationCabRequested && urlParams.get('dir') === '1' ? 1 : 0;
const linkedWalkLatParam = station3DSessionLink.lat;
const linkedWalkLonParam = station3DSessionLink.lon;
const linkedWalkHeadingParam = station3DSessionLink.headingDeg;
const linkedWalkPitchParam = station3DSessionLink.pitchDeg;
// Proposal overlay in walk mode: comma-separated
// consensus-builder proposal IDs to load over the cadastre. Existing buildings are CARVED by what
// the proposals did to them — razed, cut, or left whole where a road tunnels under them — which
// consensus-builder's POST /buildings/carve decides (see station-3d/world/proposals.js). A whole
// NAMED plan loads without enumeration via ?plan=<slug|ENS name> — the proposals layer resolves
// it itself from the URL, so nothing threads through here.
const linkedWalkProposalsParam = station3DSessionLink.proposalIds;
const linkedTramLineParam = openSharedTram3DLinkRequested ? (urlParams.get('line') || '').trim() : '';
const linkedTramStopParam = openSharedTram3DLinkRequested ? (urlParams.get('stop') || '').trim() : '';
const linkedTramStationParam = openSharedTram3DLinkRequested ? (urlParams.get('station') || '').trim() : '';
const linkedTramShapeParam = openSharedTram3DLinkRequested ? (urlParams.get('shape') || '').trim() : '';
const linkedTramOffsetParam = Number.parseFloat(urlParams.get('offset'));
const linkedTramDirectionParam = urlParams.get('dir') === '1' ? 1 : 0;
const linkedTramPitchParam = Number.parseFloat(urlParams.get('pitch'));
const station3DDeepLinkRequested = explorerRedirectRequested || openWalk3DLinkRequested
    || openStation3DScenarioRequested
    || openSharedTram3DLinkRequested
    || openPlannerCab3DLinkRequested;
const initialProjectLoadPromise = (async () => {
    if (window.__stationContractReady) await window.__stationContractReady;
    // Do not load an unrelated planner project while a redirect is pending.
    return loadProjectId
        && !explorerRedirectRequested
        && !openStation3DScenarioRequested
        ? loadSavedProject(loadProjectId)
        : undefined;
})();
(async () => {
    try {
        const resp = await fetch(`${API_BASE_URL}/transit/leaderboard?sort=cost_per_person`, { cache: 'no-store' });
        if (!resp.ok) return;
        const projects = await resp.json();
        if (!Array.isArray(projects)) return;
        leaderboardCount = projects.length;
        updateLeaderboardNavLink();
        if (!loadProjectId && !blankProjectRequested && !liveNetworkSceneRequested && !station3DDeepLinkRequested && projects[0]?.id) {
            loadSavedProject(projects[0].id).then(showPlannerCabHint);
        }
    } catch {
        // silently ignore
    }
})();

(async () => {
    await initialProjectLoadPromise;
    if (openStation3DScenarioRequested) {
        try {
            const [station3D, scenarioRunner] = await Promise.all([
                waitForStation3D(),
                import('./vendor/station3d/debug.js'),
            ]);
            const scenario = await scenarioRunner.openScenario({
                station3D,
                apiBase: API_BASE_URL,
            });
            setStatusMessage(`Station3D scenario ready: ${scenario.scenarioId}/${scenario.checkpointId}.`);
        } catch (error) {
            console.error('Station3D scenario failed:', error);
            setStatusMessage(error.message, true);
        }
        return;
    }
    if (openWalk3DLinkRequested) {
        if (!Number.isFinite(linkedWalkLatParam) || !Number.isFinite(linkedWalkLonParam)) {
            setStatusMessage('Za 3D šetnju trebate zadati valjane lat i lon parametre.', true);
            return;
        }
        applyWalk3DLink({
            lat: linkedWalkLatParam,
            lon: linkedWalkLonParam,
            headingDeg: Number.isFinite(linkedWalkHeadingParam) ? linkedWalkHeadingParam : 0,
            pitchDeg: Number.isFinite(linkedWalkPitchParam) ? linkedWalkPitchParam : 0,
            proposalIds: linkedWalkProposalsParam.length > 0 ? linkedWalkProposalsParam : null,
        }).catch(error => {
            console.error('3D walk deeplink failed:', error);
            setStatusMessage(error.message, true);
        });
        return;
    }
    if (openPlannerCab3DLinkRequested) {
        if (!loadProjectId || !linkedPlannerCabLineParam) {
            setStatusMessage('Za kabinu prijedloga trebate zadati project i line.', true);
            return;
        }
        applyPlannerCab3DLink({
            line: linkedPlannerCabLineParam,
            offset: Number.isFinite(linkedPlannerCabOffsetParam) ? linkedPlannerCabOffsetParam : 0,
            direction: linkedPlannerCabDirectionParam,
        }).catch(error => {
            console.error('3D planner cab deeplink failed:', error);
            setStatusMessage(error.message, true);
        });
        return;
    }
    if (openSharedTram3DLinkRequested) {
        if (!linkedTramLineParam || (!linkedTramStopParam && !linkedTramStationParam)) {
            setStatusMessage('Za 3D vožnju trebate zadati line i stop/station parametre.', true);
            return;
        }
        applySharedTram3DLink({
            line: linkedTramLineParam,
            stop: linkedTramStopParam || null,
            station: linkedTramStationParam || null,
            shape: linkedTramShapeParam || null,
            offset: Number.isFinite(linkedTramOffsetParam) ? linkedTramOffsetParam : 0,
            direction: linkedTramDirectionParam,
            pitch: Number.isFinite(linkedTramPitchParam) ? linkedTramPitchParam : 0,
        }).catch(error => {
            console.error('3D tram deeplink failed:', error);
            setStatusMessage(error.message, true);
        });
        return;
    }
    if (liveNetworkSceneRequested) {
        if (openStationCabRequested && !linkedCabStationParam) {
            setStatusMessage('Za cab=station morate zadati parametar stop ili station.', true);
        } else {
            applyLiveNetworkScene({
                openRandomTramCab: openRandomTramCabRequested,
                linkedCabStation: linkedCabStationParam || null,
                linkedCabDirection: linkedCabDirectionParam,
            })
                .catch(error => {
                    console.error('Live network scene failed:', error);
                    setStatusMessage(error.message, true);
                });
        }
    }
    // A plain ?project= link lands on the 2D map: every 3D deep link returned
    // above, so whoever gets here can be told how to ride what just loaded.
    if (loadProjectId) showPlannerCabHint();
})();

updateShareActionAvailability();

// ─── Passenger Demand Simulation ───────────────────────────────────────────
// Demand clock derives time from the shared simClock.
const DEMAND_ACCUMULATION_INTERVAL_MS = 500; // accumulate passengers every 500ms
const demandClockDisplay = document.getElementById('timeClockDisplay');
const revenueDisplay = document.getElementById('revenueDisplay');
const revenueHud = document.getElementById('revenueHud');

function updateRevenueDisplay() {
    if (isStation3DMapSuspended()) return;
    const revenue = Math.floor(project.totalRevenue || 0);
    if (revenueDisplay) revenueDisplay.textContent = revenue.toLocaleString();
    if (revenueHud) revenueHud.classList.toggle('hidden', revenue === 0);
}
let simHour = window.simClock ? window.simClock.getSimHour() : 6;
let lastAccumulationTimestamp = null;
let demandAnimationFrameId = null;

// The demand simulation is a MAP-MODE feature and runs on its own
// requestAnimationFrame loop. While a 3D session is open it has nothing to
// drive — the labels, the clock display and the map sky are all hidden — but it
// kept ticking, and because it is a SEPARATE rAF callback the 3D perf overlay
// could not see it: every millisecond it spent landed in the overlay's
// "outside-loop/unattributed" bucket, the largest one in every trace. A Chrome
// trace caught it as a 496 ms FunctionCall named updateDemandClock.
function stopDemandClock() {
    if (demandAnimationFrameId === null) return;
    cancelAnimationFrame(demandAnimationFrameId);
    demandAnimationFrameId = null;
}

function startDemandClock() {
    if (demandAnimationFrameId !== null) return;
    // Resume from NOW. The accumulation delta is wall-clock, so carrying a
    // timestamp from before a long ride would dump every minute of it into one
    // tick — a stall created by the fix for a stall.
    lastAccumulationTimestamp = null;
    demandAnimationFrameId = requestAnimationFrame(updateDemandClock);
}
let _lastDemandResult = null; // cached result from accumulatePassengers for reuse in updateDemandLabels

function formatSimTime(hour) {
    const h = Math.floor(hour) % 24;
    const m = Math.floor((hour % 1) * 60);
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

// Sky gradient keyframes: [hour, topColor, bottomColor]
const SKY_PALETTE = [
    [ 0,  '#0a0a1a', '#0f172a'],  // midnight
    [ 5,  '#1e1b4b', '#312e81'],  // pre-dawn
    [ 6,  '#7c3aed', '#f97316'],  // sunrise
    [ 7,  '#f97316', '#fbbf24'],  // golden hour
    [ 9,  '#0ea5e9', '#bae6fd'],  // morning
    [12,  '#0284c7', '#7dd3fc'],  // noon
    [16,  '#0ea5e9', '#bae6fd'],  // afternoon
    [18,  '#f97316', '#fbbf24'],  // sunset
    [19,  '#7c3aed', '#f97316'],  // dusk
    [20,  '#1e1b4b', '#312e81'],  // twilight
    [22,  '#0a0a1a', '#0f172a'],  // night
    [24,  '#0a0a1a', '#0f172a'],  // midnight
];

function lerpColor(a, b, t) {
    const r = c => parseInt(c.slice(1, 3), 16);
    const g = c => parseInt(c.slice(3, 5), 16);
    const bl = c => parseInt(c.slice(5, 7), 16);
    const mix = (ca, cb) => Math.round(r(ca) + (r(cb) - r(ca)) * t).toString(16).padStart(2, '0')
                          + Math.round(g(ca) + (g(cb) - g(ca)) * t).toString(16).padStart(2, '0')
                          + Math.round(bl(ca) + (bl(cb) - bl(ca)) * t).toString(16).padStart(2, '0');
    return '#' + mix(a, b);
}

function getSkyColors(hour) {
    for (let i = 0; i < SKY_PALETTE.length - 1; i++) {
        const [h0, top0, bot0] = SKY_PALETTE[i];
        const [h1, top1, bot1] = SKY_PALETTE[i + 1];
        if (hour >= h0 && hour <= h1) {
            const t = (hour - h0) / (h1 - h0);
            return { top: lerpColor(top0, top1, t), bottom: lerpColor(bot0, bot1, t) };
        }
    }
    return { top: '#0a0a1a', bottom: '#0f172a' };
}

function updateSkyAnimation() {
    if (isStation3DMapSuspended()) return;
    const strip = document.getElementById('skyStrip');
    const body  = document.getElementById('skyBody');
    if (!strip || !body) return;

    const hour = simHour;
    const center = map?.getCenter?.();
    const daylight = window.Daylight?.solarWindow?.(
        new Date(),
        Number(center?.lat) || DEFAULT_MAP_CENTER[0],
        Number(center?.lng) || DEFAULT_MAP_CENTER[1],
        CITY_CONFIG.timezone || 'UTC',
    );
    const paletteHour = window.Daylight?.paletteHour?.(hour, daylight) ?? hour;
    const { top, bottom } = getSkyColors(paletteHour);
    strip.style.background = `linear-gradient(to bottom, ${top}, ${bottom})`;

    const SUN_RISE = Number(daylight?.sunriseHour) || 6;
    const SUN_SET = Number(daylight?.sunsetHour) || 18;
    const MOON_RISE = SUN_SET;
    const MOON_SET = SUN_RISE + 24;

    const stripH = strip.offsetHeight;
    const bodyR  = 7; // half of 14px

    // Sun: arc from left at sunrise to right at sunset
    if (hour >= SUN_RISE && hour <= SUN_SET) {
        const t = (hour - SUN_RISE) / (SUN_SET - SUN_RISE);
        const x = t * strip.offsetWidth;
        const y = stripH - bodyR - Math.sin(Math.PI * t) * (stripH - bodyR * 2) - bodyR;
        body.style.left   = `${x}px`;
        body.style.bottom = 'auto';
        body.style.top    = `${y}px`;
        body.style.background = 'radial-gradient(circle, #fff8 20%, #fbbf24 55%, transparent 100%)';
        body.style.boxShadow  = '0 0 10px 5px rgba(251,191,36,0.55)';
        body.style.opacity = '1';
    } else {
        // Moon: arc left-to-right like the sun (east to west)
        const moonHour = hour >= MOON_RISE ? hour : hour + 24;
        const t = (moonHour - MOON_RISE) / (MOON_SET - MOON_RISE);
        const x = t * strip.offsetWidth;
        const y = stripH - bodyR - Math.sin(Math.PI * t) * (stripH - bodyR * 2) - bodyR;
        body.style.left   = `${x}px`;
        body.style.top    = `${y}px`;
        body.style.background = 'radial-gradient(circle, #e2e8f0 30%, #94a3b8 70%, transparent 100%)';
        body.style.boxShadow  = '0 0 8px 3px rgba(148,163,184,0.4)';
        body.style.opacity = '1';
    }
}

// Passengers give up and leave if they wait longer than this many sim-hours.
const MAX_WAIT_SIM_HOURS = 1.5;

// How many sim-hours have elapsed between two simHour values, accounting for midnight wrap.
function simHourElapsed(from, to) {
    const diff = to - from;
    return diff >= 0 ? diff : diff + 24;
}

// Recompute station.waitingCount from its passengerQueue batch arrays.
function recomputeWaitingCount(station) {
    let total = 0;
    if (station.passengerQueue) {
        for (const batches of station.passengerQueue.values()) {
            for (const b of batches) total += b.count;
        }
    }
    station.waitingCount = total;
}

// Remove batches that have exceeded the maximum wait time.
function pruneExpiredPassengers() {
    for (const station of project.stations) {
        if (!station.passengerQueue || station.passengerQueue.size === 0) continue;
        for (const [destId, batches] of station.passengerQueue) {
            // Filter out batches older than MAX_WAIT_SIM_HOURS
            const fresh = batches.filter(b => simHourElapsed(b.arrivedAt, simHour) < MAX_WAIT_SIM_HOURS);
            if (fresh.length === 0) {
                station.passengerQueue.delete(destId);
            } else {
                station.passengerQueue.set(destId, fresh);
            }
        }
        recomputeWaitingCount(station);
    }
}

// Cached transfer routing table: Map<originId, Map<destId, {nextHop, finalDest}>>
// nextHop = the station on the same line where the passenger should alight
// (either the final destination if same-line, or a transfer station if cross-line).
let _transferRoutingTable = null;
let _transferRoutingKey = -1; // topology version when last built
// Cached transfer adjacency: Map<stationId, stationId[]> — connected stations via transfer links.
let _transferAdj = null;
let _transferAdjKey = -1;

/**
 * Build a routing table that maps every (origin, dest) pair to a nextHop station.
 * For same-line pairs, nextHop = dest. For cross-line pairs reachable via transfer,
 * nextHop = the transfer station on the origin's line side.
 */
function buildTransferRoutingTable() {
    const graph = PassengerDemand.buildStationGraph(project.stations, project.lines, project.transferLinks);
    const allPairs = PassengerDemand.computeAllPairsShortestPaths(graph);

    // Build a lookup: stationId → lineId (for quick line membership checks)
    const stationLine = new Map();
    for (const st of project.stations) {
        if (st.lineId != null) stationLine.set(st.id, st.lineId);
    }

    // Build transfer link lookup: stationId → [{connectedStationId, linkId}]
    const transferAdj = new Map();
    for (const link of project.transferLinks) {
        if (!transferAdj.has(link.stationIdA)) transferAdj.set(link.stationIdA, []);
        if (!transferAdj.has(link.stationIdB)) transferAdj.set(link.stationIdB, []);
        transferAdj.get(link.stationIdA).push(link.stationIdB);
        transferAdj.get(link.stationIdB).push(link.stationIdA);
    }

    const table = new Map();
    for (const origin of project.stations) {
        const destMap = new Map();
        const originLine = stationLine.get(origin.id);

        for (const dest of project.stations) {
            if (dest.id === origin.id) continue;
            const destLine = stationLine.get(dest.id);

            // Same line: handled directly by accumulatePassengers via stationsByLine — skip
            if (originLine != null && destLine != null && originLine === destLine) continue;

            // Cross-line: find the path through the graph and identify where to alight for transfer.
            // Walk the shortest path back from dest to origin to find the first station
            // that requires leaving the origin's line.
            const fromDists = allPairs.get(origin.id);
            if (!fromDists || fromDists.get(dest.id) === undefined) continue; // unreachable

            // BFS/trace the shortest path to find the transfer point on origin's line
            const nextHop = findNextHopOnPath(origin.id, dest.id, originLine, graph, allPairs, stationLine, transferAdj);
            if (nextHop != null) {
                destMap.set(dest.id, { nextHop, finalDest: dest.id });
            }
        }
        table.set(origin.id, destMap);
    }

    return table;
}

/**
 * Trace the shortest path from origin to dest and find the first station where
 * the passenger should alight — either the destination itself (same line) or
 * the transfer station on the origin's line side.
 */
function findNextHopOnPath(originId, destId, originLineId, graph, allPairs, stationLine, transferAdj) {
    // Reconstruct shortest path by greedy forward stepping
    const fromOrigin = allPairs.get(originId);
    if (!fromOrigin) return null;
    const totalDist = fromOrigin.get(destId);
    if (totalDist === undefined) return null;

    let current = originId;
    const visited = new Set([originId]);

    while (current !== destId) {
        const edges = graph.get(current) || [];
        let bestNext = null;
        let bestDist = Infinity;

        for (const edge of edges) {
            if (visited.has(edge.toId)) continue;
            const distViaCurrent = (fromOrigin.get(current) ?? Infinity) + edge.timeMinutes;
            const distToGoal = allPairs.get(edge.toId)?.get(destId) ?? Infinity;
            const totalVia = distViaCurrent + distToGoal;
            // Accept if this edge is on a shortest path (within floating point tolerance)
            if (Math.abs(totalVia - totalDist) < 0.001 && distToGoal < bestDist) {
                bestDist = distToGoal;
                bestNext = edge.toId;
            }
        }

        if (bestNext === null) return null; // no path

        // Check if we're about to cross a transfer link (leave origin's line)
        const currentLine = stationLine.get(current);
        const nextLine = stationLine.get(bestNext);
        if (currentLine === originLineId && nextLine !== originLineId) {
            // current is the transfer station on origin's line — alight here
            return current;
        }

        visited.add(bestNext);
        current = bestNext;
    }

    // Reached dest without transfer — same line direct trip
    return destId;
}

/**
 * Get or rebuild the transfer routing table, using a simple cache key
 * based on station/line/transfer topology.
 */
function getTransferRoutingTable() {
    if (_transferRoutingKey !== _topologyVersion) {
        _transferRoutingTable = buildTransferRoutingTable();
        _transferRoutingKey = _topologyVersion;
    }
    return _transferRoutingTable;
}

// Cached transfer adjacency: stationId → [connectedStationId, ...]. Rebuilt when topology changes.
function getTransferAdj() {
    if (_transferAdjKey !== _topologyVersion) {
        _transferAdj = new Map();
        for (const link of project.transferLinks) {
            if (!_transferAdj.has(link.stationIdA)) _transferAdj.set(link.stationIdA, []);
            if (!_transferAdj.has(link.stationIdB)) _transferAdj.set(link.stationIdB, []);
            _transferAdj.get(link.stationIdA).push(link.stationIdB);
            _transferAdj.get(link.stationIdB).push(link.stationIdA);
        }
        _transferAdjKey = _topologyVersion;
    }
    return _transferAdj;
}

function accumulatePassengers(deltaSec) {
    if (typeof PassengerDemand === 'undefined' || project.stations.length === 0) return;
    if (project.stations.length < 2) return; // need at least 2 stations for distribution

    const result = PassengerDemand.compute(project.stations, project.lines, simHour, project.tracks, project.transferLinks, _topologyVersion);
    _lastDemandResult = result;
    const routingTable = project.transferLinks.length > 0 ? getTransferRoutingTable() : null;

    // Evict passengers who have waited past their limit before adding new ones
    pruneExpiredPassengers();

    const totalDemand = [...result.values()].reduce((sum, e) => sum + e.demand, 0);
    if (totalDemand <= 0) return;

    // deltaSec of real time × speed multiplier = sim seconds elapsed, convert to sim hours
    const simHoursFraction = deltaSec * window.simClock.getSpeedMultiplier() / 3600;

    // Pre-group stations by lineId so inner loops iterate only relevant stations
    const stationsByLine = new Map();
    for (const st of project.stations) {
        if (st.lineId == null) continue;
        if (!stationsByLine.has(st.lineId)) stationsByLine.set(st.lineId, []);
        stationsByLine.get(st.lineId).push(st);
    }

    for (const station of project.stations) {
        const entry = result.get(station.id);
        if (!entry || entry.demand <= 0) continue;

        // Number of new passengers arriving at this station this tick
        const newPassengers = entry.demand * simHoursFraction;
        // Fractional passengers: accumulate a float and floor to add whole passengers
        station._fracPassengers = (station._fracPassengers || 0) + newPassengers;
        const wholePassengers = Math.floor(station._fracPassengers);
        station._fracPassengers -= wholePassengers;

        if (wholePassengers <= 0) continue;

        // Distribute new passengers to reachable destinations using supply weights.
        // Same-line destinations are always reachable. Cross-line destinations are reachable
        // via transfer links (using the routing table to determine the nextHop station).
        if (!station.passengerQueue) station.passengerQueue = new Map();
        const originRoutes = routingTable?.get(station.id);

        let totalAttraction = 0;
        const attractions = [];

        // Same-line destinations (iterate only this line's stations, not all)
        const sameLineStations = stationsByLine.get(station.lineId) || [];
        for (const destStation of sameLineStations) {
            if (destStation.id === station.id) continue;
            const destEntry = result.get(destStation.id);
            const attraction = destEntry ? destEntry.supply : 0;
            if (attraction > 0) {
                attractions.push({ id: destStation.id, attraction, nextHop: destStation.id, finalDest: destStation.id });
                totalAttraction += attraction;
            }
        }

        // Cross-line destinations reachable via transfer routing
        if (originRoutes) {
            for (const [destId, route] of originRoutes) {
                const destStation = _stationById.get(destId);
                if (!destStation || destStation.lineId === station.lineId) continue; // skip same-line (already handled)
                const destEntry = result.get(destId);
                const attraction = destEntry ? destEntry.supply : 0;
                if (attraction > 0) {
                    attractions.push({ id: destId, attraction, nextHop: route.nextHop, finalDest: route.finalDest });
                    totalAttraction += attraction;
                }
            }
        }

        if (totalAttraction <= 0) continue;

        // Distribute passengers proportionally, recording arrival time on each batch.
        // Queue key is nextHop (where the passenger alights this leg); batch tracks finalDestId.
        let remaining = wholePassengers;
        for (const dest of attractions) {
            const share = Math.round((dest.attraction / totalAttraction) * wholePassengers);
            const actual = Math.min(share, remaining);
            if (actual > 0) {
                const hopKey = dest.nextHop;
                if (!station.passengerQueue.has(hopKey)) station.passengerQueue.set(hopKey, []);
                station.passengerQueue.get(hopKey).push({ count: actual, arrivedAt: simHour, finalDestId: dest.finalDest });
                remaining -= actual;
            }
        }
        // Assign remainder to highest-attraction destination
        if (remaining > 0 && attractions.length > 0) {
            const top = attractions[0];
            const hopKey = top.nextHop;
            if (!station.passengerQueue.has(hopKey)) station.passengerQueue.set(hopKey, []);
            station.passengerQueue.get(hopKey).push({ count: remaining, arrivedAt: simHour, finalDestId: top.finalDest });
        }

        recomputeWaitingCount(station);
    }
}

function updateDemandClock(timestamp) {
    // Should not be scheduled while suspended; if it somehow is, stop rather
    // than re-arming, so this can never quietly resume behind a 3D session.
    if (isStation3DMapSuspended()) {
        demandAnimationFrameId = null;
        return;
    }
    if (lastAccumulationTimestamp === null) lastAccumulationTimestamp = timestamp;

    // Derive simHour from the shared clock
    simHour = window.simClock.getSimHour();

    if (!isStation3DMapSuspended()) {
        // Don't overwrite the input sim-clock.js creates while the user is
        // editing the time — it would wipe their keystrokes every frame.
        if (demandClockDisplay && demandClockDisplay.dataset.editing !== 'true') {
            demandClockDisplay.textContent = formatSimTime(simHour);
        }
        updateSkyAnimation();
    }

    // Accumulate passengers at a lower frequency than rendering
    if (timestamp - lastAccumulationTimestamp >= DEMAND_ACCUMULATION_INTERVAL_MS) {
        const accDelta = (timestamp - lastAccumulationTimestamp) / 1000;
        lastAccumulationTimestamp = timestamp;
        accumulatePassengers(accDelta);
        if (!isStation3DMapSuspended()) {
            updateDemandLabels(); // Only update labels when demand data changes (not every rAF)
        }
    }

    demandAnimationFrameId = requestAnimationFrame(updateDemandClock);
}

function updateDemandLabels() {
    if (isStation3DMapSuspended()) return;
    // No census data (e.g. Split) → no simulated demand → no labels.
    if (!locationHasPassengerDemand()) { clearDemandLabels(); return; }
    if (typeof PassengerDemand === 'undefined' || project.stations.length === 0 || !toggleDemandLabelsInput?.checked) {
        clearDemandLabels();
        return;
    }

    // Reuse the cached result from accumulatePassengers instead of recomputing every frame
    const result = _lastDemandResult || PassengerDemand.compute(project.stations, project.lines, simHour, project.tracks, project.transferLinks, _topologyVersion);

    // Remove labels for stations that no longer exist
    const staleIds = [];
    for (const stationId of demandLabelLayers.keys()) {
        if (!_stationById.has(stationId)) staleIds.push(stationId);
    }
    for (const id of staleIds) {
        map.removeLayer(demandLabelLayers.get(id));
        demandLabelLayers.delete(id);
    }

    for (const station of project.stations) {
        const entry = result.get(station.id);
        if (!entry) continue;
        const supplyText = entry.supply;
        const demandText = station.waitingCount || 0;

        const existing = demandLabelLayers.get(station.id);
        if (existing) {
            existing.setLatLng(station.latlng);
            const el = existing.getElement();
            if (el) {
                const label = el.querySelector('.demand-label');
                if (label) {
                    label.querySelector('.demand-label-supply').textContent = supplyText;
                    label.querySelector('.demand-label-demand').textContent = demandText;
                }
            }
        } else {
            const icon = L.divIcon({
                className: 'demand-label-icon',
                iconSize: [0, 0],
                iconAnchor: [0, 0],
                html: `<div class="demand-label"><span class="demand-label-supply">${supplyText}</span><span class="demand-label-sep">/</span><span class="demand-label-demand">${demandText}</span></div>`,
            });
            const marker = L.marker(station.latlng, {
                icon,
                interactive: false,
                keyboard: false,
                zIndexOffset: 950,
            }).addTo(map);
            demandLabelLayers.set(station.id, marker);
        }
    }
}

function clearDemandLabels() {
    for (const marker of demandLabelLayers.values()) {
        map.removeLayer(marker);
    }
    demandLabelLayers.clear();
}

// Start the simulation clock
startDemandClock();
