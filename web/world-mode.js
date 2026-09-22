// Which 3D world a URL asks for: `photo` (photorealistic Google 3D Tiles) or
// `model` (the modelled OSM/GDI/Overture world, the default).
//
// One implementation, exposed as a browser namespace and a CommonJS export,
// because this predicate was duplicated verbatim in transit.js and
// station-3d/world/photoreal.js with a comment on each saying it mirrored the
// other — two copies of a rule that decides which world you are standing in.
//
// It also used to be a bare `params.has('photo')`, so `?photo=0`, `?photo=false`
// and `?photo=off` all opened the PHOTO world. isElevationMode() in
// station-3d/core/session-flags.js already rejected those, so the two flags in
// the same app disagreed about what "off" meant.
(function exposeWorldMode(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__worldMode = api;
}(typeof window !== 'undefined' ? window : globalThis, function buildWorldModeApi() {
    // rw/real/photoreal are back-compat aliases so existing share links still
    // open the photo world.
    const PHOTO_PARAMS = ['photo', 'rw', 'real', 'photoreal'];
    const FALSY = ['0', 'false', 'off', 'no'];

    // A present-but-falsy value means OFF, matching isElevationMode(). A present
    // flag with any other value (including empty, as in a bare `?photo`) is ON.
    function flagIsOn(params, name) {
        if (!params.has(name)) return false;
        const value = (params.get(name) || '').trim().toLowerCase();
        return !FALSY.includes(value);
    }

    function isPhotoWorld(search) {
        try {
            const raw = search !== undefined && search !== null
                ? search
                : ((typeof window !== 'undefined' && window.location && window.location.search) || '');
            const params = new URLSearchParams(raw);
            return PHOTO_PARAMS.some(name => flagIsOn(params, name));
        } catch (_error) {
            return false;
        }
    }

    // City packs may provide an optional scheduled reference-network
    // simulation. Only locations declared by that pack may eagerly load it;
    // a coordinate-resolved spawn elsewhere must not download local datasets.
    function shouldAutoLoadReferenceSimulation(search, registry, city = {}) {
        const supportedLocations = new Set(city.referenceSimulation?.locationIds || []);
        if (supportedLocations.size === 0) return false;
        try {
            const raw = search !== undefined && search !== null
                ? search
                : ((typeof window !== 'undefined' && window.location && window.location.search) || '');
            const params = new URLSearchParams(raw);
            const stationMode = (params.get('st3d') || '').trim().toLowerCase();
            if (stationMode === 'gta' || stationMode === 'scenario') return false;
            const lat = Number.parseFloat(params.get('lat'));
            const lon = Number.parseFloat(params.get('lon'));
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
                const pointLocation = registry?.detectByLatLng?.(lat, lon);
                if (pointLocation) return supportedLocations.has(pointLocation);
            }
            const locationId = (params.get('loc') || city.id || '').trim().toLowerCase();
            return supportedLocations.has(locationId);
        } catch (_error) {
            return false;
        }
    }

    return { isPhotoWorld, shouldAutoLoadReferenceSimulation, PHOTO_PARAMS };
}));
