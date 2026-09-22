// Canonical track-count/arrangement handling shared by saved projects and the
// planner-to-Station3D adapter. New planner tracks default to the established
// paired corridor, while imported existing rail keeps its authored topology.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.__trackTopology = api;
}(typeof self !== 'undefined' ? self : globalThis, function () {
    'use strict';

    const DEFAULT = Object.freeze({ trackCount: 2, trackArrangement: 'together' });

    function normalize(source = {}, fallback = DEFAULT) {
        const fallbackCount = Number(fallback?.trackCount) === 1 ? 1 : 2;
        const declaredCount = Number(source?.trackCount);
        const trackCount = declaredCount === 1 || declaredCount === 2
            ? declaredCount
            : fallbackCount;
        if (trackCount === 1) return { trackCount: 1, trackArrangement: 'single' };
        const declaredArrangement = String(source?.trackArrangement || '').trim();
        return {
            trackCount: 2,
            trackArrangement: declaredArrangement && declaredArrangement !== 'single'
                ? declaredArrangement
                : String(fallback?.trackArrangement || DEFAULT.trackArrangement),
        };
    }

    function forTracks(tracks = [], fallback = DEFAULT) {
        const resolved = (Array.isArray(tracks) ? tracks : []).map(track => normalize(track, fallback));
        if (resolved.length === 0) return normalize({}, fallback);
        const first = resolved[0];
        if (resolved.every(value => value.trackCount === first.trackCount
            && value.trackArrangement === first.trackArrangement)) return first;
        return normalize({}, fallback);
    }

    function rightHandCenterOffsetM(source = {}, spacingM = 0) {
        if (normalize(source).trackCount === 1) return 0;
        const spacing = Number(spacingM);
        return Number.isFinite(spacing) ? Math.max(0, spacing) * 0.5 : 0;
    }

    return Object.freeze({ DEFAULT, normalize, forTracks, rightHandCenterOffsetM });
}));
