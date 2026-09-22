// Generic location registry for a single manifest-defined planning area.
// A selected city pack may install a richer registry before this script runs;
// when it does, that pack remains authoritative for its own prepared regions.
(function exposeManifestLocationRegistry(root) {
    'use strict';

    if (root.__locationRegistry) return;
    const city = root.__TRANSIT_RUNTIME_CONFIG__?.city || root.__TRANSIT_CITY_CONFIG__ || {};
    const bounds = city.bounds || {};
    const bbox = [bounds.west, bounds.south, bounds.east, bounds.north].map(Number);
    const validBbox = bbox.length === 4 && bbox.every(Number.isFinite)
        && bbox[0] < bbox[2] && bbox[1] < bbox[3];
    const id = String(city.id || 'city');
    const terrainSources = Array.isArray(city.providers?.terrain) ? city.providers.terrain : [];
    const terrainSource = terrainSources[0] || null;
    const entry = Object.freeze({
        id,
        label: city.name || id,
        bbox: validBbox ? Object.freeze(bbox) : null,
        prepared: Object.freeze({
            buildings: null,
            terrain: city.features?.terrain === true,
            census: city.features?.population === true && city.features?.jobs === true,
        }),
        terrainMapSource: terrainSource,
        simulationTerrainSource: terrainSource,
    });
    const REGISTRY = Object.freeze({ [id]: entry });

    function isKnown(value) {
        return String(value || '') === id;
    }

    function detectByLatLng(lat, lng) {
        if (!validBbox || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3]
            ? id
            : null;
    }

    function detectByPoints(points) {
        let sumLat = 0;
        let sumLng = 0;
        let count = 0;
        for (const point of points || []) {
            const lat = Number(point?.[0]);
            const lng = Number(point?.[1]);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
            sumLat += lat;
            sumLng += lng;
            count += 1;
        }
        return count > 0 ? detectByLatLng(sumLat / count, sumLng / count) : null;
    }

    root.__locationRegistry = Object.freeze({
        REGISTRY,
        ids: Object.freeze([id]),
        cityIds: () => [id],
        corridorIds: () => [],
        detectByLatLng,
        detectByPoints,
        isKnown,
        nearestCityId: detectByLatLng,
    });
}(typeof self !== 'undefined' ? self : globalThis));
