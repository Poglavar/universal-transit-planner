// Pure endpoint-based direction labels for regional cab routes. Exposed as a
// browser namespace and CommonJS export so the classic transit UI stays thin.
(function exposeRouteDirection(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TramSimRouteDirection = api;
}(typeof window !== 'undefined' ? window : globalThis, function buildRouteDirectionApi() {
    const SPLIT_TERMINAL = [16.4402, 43.5081];
    const TROGIR_TERMINAL = [16.2510, 43.5160];

    function distanceSquared(a, b) {
        const meanLat = ((Number(a[1]) + Number(b[1])) * 0.5) * Math.PI / 180;
        const dx = (Number(a[0]) - Number(b[0])) * Math.cos(meanLat);
        const dy = Number(a[1]) - Number(b[1]);
        return dx * dx + dy * dy;
    }

    function splitTrackDirectionLabel(trackFeatures) {
        const firstLine = trackFeatures && trackFeatures[0]?.geometry?.coordinates;
        const lastLine = trackFeatures && trackFeatures[trackFeatures.length - 1]?.geometry?.coordinates;
        if (!Array.isArray(firstLine) || firstLine.length === 0
            || !Array.isArray(lastLine) || lastLine.length === 0) return '';
        const start = firstLine[0];
        const end = lastLine[lastLine.length - 1];
        if (!Array.isArray(start) || !Array.isArray(end)) return '';
        const splitToTrogirCost = distanceSquared(start, SPLIT_TERMINAL)
            + distanceSquared(end, TROGIR_TERMINAL);
        const trogirToSplitCost = distanceSquared(start, TROGIR_TERMINAL)
            + distanceSquared(end, SPLIT_TERMINAL);
        return splitToTrogirCost <= trogirToSplitCost
            ? 'Split → Trogir'
            : 'Trogir → Split';
    }

    return { splitTrackDirectionLabel };
}));
