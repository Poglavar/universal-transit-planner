// Pure URL/source/readout helpers for the Leaflet terrain overlay. UMD keeps
// the planner's classic-script boundary thin while remaining Node-testable.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TerrainMapLayer = api;
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const DEFAULT_SOURCE = 'best-available';
    const DEFAULT_SIMULATION_SOURCE = 'copernicus-glo30';
    const STYLE = 'hypsometric-v3';
    // Long-distance projects invite rapid pans across hundreds of kilometres.
    // Wait until each pan ends and retain only one surrounding tile ring so
    // abandoned views do not become an origin-render storm.
    const TILE_REQUEST_OPTIONS = Object.freeze({
        keepBuffer: 1,
        updateWhenIdle: true,
        updateWhenZooming: false,
    });

    function apiBase(value) {
        return String(value || '').replace(/\/+$/, '');
    }

    function configuredSource(registry, locationId, property, fallback) {
        const configured = registry?.REGISTRY?.[locationId]?.[property];
        return typeof configured === 'string' && configured.trim()
            ? configured.trim()
            : fallback;
    }

    function mapSourceForLocation(registry, locationId, fallback = DEFAULT_SOURCE) {
        const location = registry?.REGISTRY?.[locationId];
        const legacyFallback = typeof location?.terrainSource === 'string'
            ? location.terrainSource
            : fallback;
        return configuredSource(registry, locationId, 'terrainMapSource', legacyFallback);
    }

    function simulationSourceForLocation(
        registry,
        locationId,
        fallback = DEFAULT_SIMULATION_SOURCE,
    ) {
        const location = registry?.REGISTRY?.[locationId];
        const legacyFallback = typeof location?.terrainSource === 'string'
            ? location.terrainSource
            : fallback;
        return configuredSource(registry, locationId, 'simulationTerrainSource', legacyFallback);
    }

    function tileUrlTemplate(baseUrl, source = DEFAULT_SOURCE) {
        return `${apiBase(baseUrl)}/terrain/tiles/{z}/{x}/{y}.png`
            + `?source=${encodeURIComponent(source)}&style=${encodeURIComponent(STYLE)}`;
    }

    function elevationUrl(baseUrl, lat, lon, source = DEFAULT_SOURCE) {
        if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
            throw new Error('terrain elevation URL needs finite coordinates');
        }
        const params = new URLSearchParams({
            lat: Number(lat).toFixed(7),
            lon: Number(lon).toFixed(7),
            source,
        });
        return `${apiBase(baseUrl)}/terrain/elevation?${params.toString()}`;
    }

    function shortDatum(value) {
        const datum = String(value || '');
        if (datum.includes('EVRF2000')) return 'EVRF2000';
        if (datum.includes('HVRS71')) return 'HVRS71';
        return datum;
    }

    function elevationPresentation(payload, locale = 'en') {
        if (payload?.elevationM == null) {
            return {
                valueText: 'Nema visine',
                metaText: 'No terrain coverage',
                title: 'Za ovu točku nema visinskih podataka.',
            };
        }
        const elevationM = Number(payload?.elevationM);
        if (!Number.isFinite(elevationM)) {
            return {
                valueText: 'Nema visine',
                metaText: 'No terrain coverage',
                title: 'Za ovu točku nema visinskih podataka.',
            };
        }
        const source = payload?.source || {};
        const valueText = `${elevationM.toLocaleString(locale, {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
        })} m`;
        const resolutionM = Number(source.resolutionM);
        const resolutionText = Number.isFinite(resolutionM) ? `${resolutionM} m` : '';
        const datumText = shortDatum(payload?.datum);
        const metaText = [source.provider, resolutionText, datumText].filter(Boolean).join(' · ');
        const title = [
            valueText,
            source.product || source.key,
            datumText,
        ].filter(Boolean).join(' · ');
        return { valueText, metaText, title };
    }

    return Object.freeze({
        DEFAULT_SOURCE,
        DEFAULT_SIMULATION_SOURCE,
        STYLE,
        TILE_REQUEST_OPTIONS,
        elevationPresentation,
        elevationUrl,
        mapSourceForLocation,
        // Backwards-compatible name for the helper's original map-only role.
        sourceForLocation: mapSourceForLocation,
        simulationSourceForLocation,
        tileUrlTemplate,
    });
}));
