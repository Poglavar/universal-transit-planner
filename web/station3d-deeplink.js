// Is this URL asking for a 3D session rather than the planner map?
//
// A link like ?st3d=walk or ?scene=live-network&cab=station opens the map,
// paints it in full, streams its basemap tiles, and then throws all of it away
// about five seconds later when the 3D world takes over. The reader asked for a
// walk, not for a map of Dalmatia. Knowing the answer BEFORE the map is built
// lets the boot skip the basemap entirely and show the loading screen at once.
//
// Kept pure and DOM-free because it has to run at the very top of transit.js,
// before anything else exists, and because the rule is worth pinning: every
// mode named here is one the boot must not paint a map for, and a mode missing
// from it silently gets the old five seconds back.
(function (root) {
    'use strict';

    // Modes of ?st3d=. Each opens a full-screen 3D session on load.
    const ST3D_MODES = new Set(['walk', 'scenario', 'tram', 'planner-cab']);
    // ?scene=live-network is a MAP view on its own; only its cab variants are 3D.
    const LIVE_NETWORK_CABS = new Set(['random-tram', 'station']);

    // search: a location.search string, or anything URLSearchParams accepts.
    function isStation3DDeepLink(search) {
        let params;
        try {
            params = new URLSearchParams(search || '');
        } catch (_) {
            return false;
        }
        const mode = (params.get('st3d') || '').trim().toLowerCase();
        if (ST3D_MODES.has(mode)) return true;
        // Mirrors transit.js: a project= link is never the live-network scene.
        if (params.get('project')) return false;
        if ((params.get('scene') || '').trim() !== 'live-network') return false;
        return LIVE_NETWORK_CABS.has((params.get('cab') || '').trim());
    }

    const api = { isStation3DDeepLink, ST3D_MODES, LIVE_NETWORK_CABS };
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.__station3dDeepLink = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
