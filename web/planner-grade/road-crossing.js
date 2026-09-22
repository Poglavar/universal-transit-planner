// Pure road-crossing "regime" classifier for the planner elevation strip.
// Every place the drawn track crosses a road must land in exactly one clean
// regime — OVER (a viaduct with real clearance), UNDER (a deep-enough cut or
// tunnel), or AT-GRADE (a level crossing exactly on grade). Anything in
// between (a shallow embankment slicing a road, or a too-shallow cut across
// one) is a VIOLATION. This is an ADVISORY aid ONLY: it never blocks, fixes,
// or otherwise changes the track — it just tells the strip where to paint red.
//
// clearanceM = authored track elevation a.s.l. − terrain a.s.l. at the same
// chainage: positive = track above the ground (fill/viaduct), negative = below
// it (cut/tunnel).
//
// UMD: classic scripts get window.__roadCrossing (never bare globals); node
// tests require()/import the same file. Pure — no DOM, no fetch.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__roadCrossing = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Road clearances — deliberately NOT the earthworks thresholds in
    // grade-solver (those classify tunnel/viaduct by COST, at 15 m / 10 m).
    // A track clears a road on a viaduct at ~5 m+ (truck 4.5 m + deck), passes
    // under it in a cut/tunnel at ~5.5 m+ (mirrors PLANNER_TUNNEL_CLEARANCE_M
    // and PILLAR_ROAD_CLEAR_M), and a level crossing sits within ±0.5 m of
    // grade. The band between those regimes is the physically-broken zone.
    const DEFAULT_THRESHOLDS = {
        overMinM: 5,       // track ≥ this ABOVE the road → clean viaduct
        underMaxM: -5.5,   // track ≤ this BELOW the road → clean cut / tunnel
        atGradeTolM: 0.5,  // |clearance| ≤ this → level crossing (at-grade)
    };

    // clearanceM (track a.s.l. − terrain a.s.l.) → regime string.
    // A null/NaN clearance (terrain not loaded yet) is 'unknown' and NEVER a
    // violation — nothing gets painted red until the check can actually judge.
    function classifyCrossing(clearanceM, thresholds) {
        const t = Object.assign({}, DEFAULT_THRESHOLDS, thresholds || {});
        // Number(null) is 0 — guard the "no clearance known" case first.
        const c = clearanceM == null ? NaN : Number(clearanceM);
        if (!Number.isFinite(c)) return 'unknown';
        if (Math.abs(c) <= t.atGradeTolM) return 'at-grade';
        if (c >= t.overMinM) return 'over';
        if (c <= t.underMaxM) return 'under';
        return 'violation';
    }

    function isViolation(mode) { return mode === 'violation'; }

    // A route that FOLLOWS an existing railway is not crossing it. Turf's
    // lineIntersect reports the endpoints of every overlapping segment as
    // intersections, which turns a 36 km imported railway into hundreds of
    // fake purple dots. Compare local segment bearings and keep only a genuine
    // transverse intersection.
    function transverseIntersection(segmentA, segmentB, minimumAngleDeg = 15) {
        if (!Array.isArray(segmentA) || segmentA.length < 2
            || !Array.isArray(segmentB) || segmentB.length < 2) return false;
        const vector = (segment) => {
            const a = segment[0], b = segment[1];
            const lat = (Number(a?.[1]) + Number(b?.[1])) * 0.5 * Math.PI / 180;
            return {
                x: (Number(b?.[0]) - Number(a?.[0])) * Math.cos(lat),
                y: Number(b?.[1]) - Number(a?.[1]),
            };
        };
        const a = vector(segmentA), b = vector(segmentB);
        const aLength = Math.hypot(a.x, a.y), bLength = Math.hypot(b.x, b.y);
        if (!(aLength > 0) || !(bLength > 0)) return false;
        const cosine = Math.max(-1, Math.min(1, Math.abs(
            (a.x * b.x + a.y * b.y) / (aLength * bLength),
        )));
        const acuteAngleDeg = Math.acos(cosine) * 180 / Math.PI;
        return acuteAngleDeg >= Number(minimumAngleDeg);
    }

    // Multiple OSM ways often describe the two rails of one physical crossing.
    // The strip needs one marker for the crossing, not one per way/rail.
    function clusterRailCrossings(crossings, toleranceM = 12) {
        const sorted = (crossings || []).slice().sort((a, b) => Number(a.dM) - Number(b.dM));
        const output = [];
        for (const crossing of sorted) {
            const previous = output[output.length - 1];
            if (crossing?.kind === 'rail' && previous?.kind === 'rail'
                && Number.isFinite(Number(crossing.dM))
                && Math.abs(Number(crossing.dM) - Number(previous.dM)) <= toleranceM) {
                if (Number(crossing.r) > Number(previous.r)) output[output.length - 1] = crossing;
                continue;
            }
            output.push(crossing);
        }
        return output;
    }

    // The grade solver's earthworks regimes that already decide over/under/at
    // outright — a viaduct always clears a road, a tunnel always passes under,
    // and a genuine at-grade run IS a level crossing. Fill and cut are the
    // ambiguous middle: above/below the terrain, but only clearance says whether
    // they clear the road or slice through it.
    const REGIME_TO_MODE = { viaduct: 'over', tunnel: 'under', 'at-grade': 'at-grade' };

    // Regime-aware classification — the ROBUST path. The solver's per-chainage
    // regime is the SAME signal the 3D world renders (rails.js), so it is
    // authoritative for whether the track sits over / under / at the terrain; a
    // re-sampled terrain that is stale or registered differently can no longer
    // mislabel a fill as a level crossing. Road clearance only refines fill/cut
    // into over/under vs a shallow VIOLATION that fails to clear the road.
    function classifyCrossingByRegime(regime, clearanceM, thresholds) {
        const t = Object.assign({}, DEFAULT_THRESHOLDS, thresholds || {});
        if (regime && REGIME_TO_MODE[regime]) return REGIME_TO_MODE[regime];
        const c = clearanceM == null ? NaN : Number(clearanceM);
        if (regime === 'fill') {
            // Above the terrain: clears the road → over, otherwise a shallow
            // embankment slicing it → violation. Unknown clearance trusts the
            // structure (never a level crossing) and reads it as over.
            if (!Number.isFinite(c)) return 'over';
            return c >= t.overMinM ? 'over' : 'violation';
        }
        if (regime === 'cut') {
            if (!Number.isFinite(c)) return 'under';
            return c <= t.underMaxM ? 'under' : 'violation';
        }
        // No regime available → pure-clearance classifier.
        return classifyCrossing(clearanceM, thresholds);
    }

    // Map raw crossings ([{dM, ...}]) to classified ones, sampling the authored
    // track elevation and the terrain at each crossing chainage via injected
    // samplers (so this module stays free of the profile/terrain code and fully
    // unit-testable). elevAtDM/terrainAtDM each return metres a.s.l., or a
    // non-finite value where that quantity is unknown. Every extra field on the
    // input crossing (highway, name, latlng, r, …) is preserved.
    // opts.regimeAtDM(dM) — the profile's stored regime at that chainage. When
    // supplied, the regime-aware classifier runs (matches the 3D); otherwise the
    // pure-clearance classifier is used (older saves without stored regimes).
    function classifyCrossings(crossings, options) {
        const opts = options || {};
        const elevAtDM = opts.elevAtDM;
        const terrainAtDM = opts.terrainAtDM;
        const regimeAtDM = opts.regimeAtDM;
        if (!Array.isArray(crossings)) return [];
        // Number(null) is 0, so a missing sample must be caught BEFORE coercion
        // — otherwise unloaded terrain reads as sea level and every crossing
        // looks like a 100 m viaduct.
        const num = (v) => (v == null ? NaN : Number(v));
        return crossings.map((rc) => {
            const dM = Number(rc && rc.dM);
            const trackElev = typeof elevAtDM === 'function' ? num(elevAtDM(dM)) : NaN;
            const terrElev = typeof terrainAtDM === 'function' ? num(terrainAtDM(dM)) : NaN;
            const clearanceM = (Number.isFinite(trackElev) && Number.isFinite(terrElev))
                ? trackElev - terrElev
                : null;
            const regime = typeof regimeAtDM === 'function' ? (regimeAtDM(dM) || null) : null;
            const mode = regime
                ? classifyCrossingByRegime(regime, clearanceM, opts.thresholds)
                : classifyCrossing(clearanceM, opts.thresholds);
            return Object.assign({}, rc, { dM, clearanceM, regime, mode });
        });
    }

    return {
        classifyCrossing, classifyCrossingByRegime, classifyCrossings,
        transverseIntersection, clusterRailCrossings,
        isViolation, DEFAULT_THRESHOLDS,
    };
}));
