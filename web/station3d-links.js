// Planner-only Station3D URL parsing. Authored campaigns belong to downstream
// story hosts and are deliberately absent from this repository.
(function exposeStation3DLinks(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.__station3DLinks = api;
}(globalThis, function createPlannerLinks() {
    'use strict';

    function finiteNumber(value) {
        if (value == null || String(value).trim() === '') return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function parseSessionQuery(search = '') {
        const params = new URLSearchParams(search);
        const requestedMode = (params.get('st3d') || '').trim().toLowerCase();
        const supportedModes = new Set(['walk', 'tram', 'planner-cab', 'scenario']);
        return Object.freeze({
            mode: supportedModes.has(requestedMode) ? requestedMode : '',
            lat: finiteNumber(params.get('lat')),
            lon: finiteNumber(params.get('lon')),
            headingDeg: finiteNumber(params.get('heading')) ?? 0,
            pitchDeg: finiteNumber(params.get('pitch')) ?? 0,
            railProfileMode: ['osm', 'solved'].includes(params.get('railProfile'))
                ? params.get('railProfile') : null,
            proposalIds: (params.get('proposals') || '')
                .split(',').map(value => value.trim()).filter(Boolean),
        });
    }

    function legacyExplorerRedirect() { return null; }

    return Object.freeze({ parseSessionQuery, legacyExplorerRedirect });
}));
