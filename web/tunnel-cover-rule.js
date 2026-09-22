// One physical tunnel-cover rule shared by classic planner scripts, CommonJS
// tests and Station3D ES modules. The small UMD bridge is deliberate: the
// planner still loads as ordered classic scripts, while Station3D is native ESM.
(function (root, factory) {
    const rule = factory();
    if (typeof module === 'object' && module.exports) module.exports = rule;
    if (root) root.__tunnelCoverRule = rule;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const RAIL_TUBE_HEIGHT_ABOVE_RAIL_M = 7.3;
    const TUNNEL_ROOF_SLAB_COVER_M = 0.7;
    const TUNNEL_FULL_COVER_MIN_M =
        RAIL_TUBE_HEIGHT_ABOVE_RAIL_M + TUNNEL_ROOF_SLAB_COVER_M;
    const TUNNEL_COVER_TOLERANCE_M = 0.25;

    return Object.freeze({
        RAIL_TUBE_HEIGHT_ABOVE_RAIL_M,
        TUNNEL_ROOF_SLAB_COVER_M,
        TUNNEL_FULL_COVER_MIN_M,
        TUNNEL_COVER_TOLERANCE_M,
    });
}));
