// Pure planner-location policy: geometry and coordinates are authoritative;
// `loc` is accepted only as an incoming one-time view hint and never persisted.
(function exposePlannerLocationContext(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__plannerLocationContext = api;
}(typeof window !== 'undefined' ? window : globalThis, function buildPlannerLocationContext() {
    function knownLocationId(value, registry) {
        const id = String(value || '').trim().toLowerCase();
        return registry?.isKnown?.(id) ? id : null;
    }

    function locationFromCoordinates(search, registry) {
        try {
            const params = new URLSearchParams(search || '');
            const lat = Number.parseFloat(params.get('lat'));
            const lon = Number.parseFloat(params.get('lon'));
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
            return registry?.detectByLatLng?.(lat, lon) || null;
        } catch (_error) {
            return null;
        }
    }

    function initialLocationId(search, registry, fallback = null) {
        const coordinateLocation = locationFromCoordinates(search, registry);
        if (coordinateLocation) return coordinateLocation;
        try {
            const params = new URLSearchParams(search || '');
            return knownLocationId(params.get('loc'), registry)
                || knownLocationId(fallback, registry)
                || null;
        } catch (_error) {
            return knownLocationId(fallback, registry);
        }
    }

    function geometryLocationId(tracks, registry) {
        if (!registry?.detectByPoints) return null;
        const points = [];
        for (const track of tracks || []) {
            for (const point of track?.latlngs || []) points.push(point);
        }
        return points.length > 0 ? registry.detectByPoints(points) : null;
    }

    function projectLocationId({
        tracks,
        storedLocationId,
        currentLocationId,
        registry,
        fallback = null,
    } = {}) {
        return geometryLocationId(tracks, registry)
            || knownLocationId(storedLocationId, registry)
            || knownLocationId(currentLocationId, registry)
            || knownLocationId(fallback, registry)
            || null;
    }

    function locationCenter(registry, locationId) {
        const id = knownLocationId(locationId, registry);
        const bbox = id && registry?.REGISTRY?.[id]?.bbox;
        if (!Array.isArray(bbox) || bbox.length !== 4) return null;
        const [west, south, east, north] = bbox.map(Number);
        if (![west, south, east, north].every(Number.isFinite)) return null;
        return { lat: (south + north) / 2, lon: (west + east) / 2 };
    }

    function withoutLegacyLocation(currentUrl) {
        const url = new URL(currentUrl);
        url.searchParams.delete('loc');
        return url.toString();
    }

    return {
        geometryLocationId,
        initialLocationId,
        locationCenter,
        locationFromCoordinates,
        projectLocationId,
        withoutLegacyLocation,
    };
}));
