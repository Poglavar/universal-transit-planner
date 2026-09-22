// Where a drawn track crosses ITSELF in plan (a spiral/helix gaining height, a
// figure-eight), the two passes share a lat/lng but not a chainage — so the
// crossing is a PAIR of chainages {dMa, dMb}, never one dM like a road
// crossing. Elevation is a function of chainage (track.verticalProfile), so
// the same plan point legitimately carries two heights; this module only finds
// the pairs and classifies their vertical separation. Making the grade solver
// HOLD that separation lives in grade-solver.js (opts.selfCrossings); this
// module is deliberately solver-free plan geometry.
//
// UMD: classic scripts get window.__selfCrossing (never bare globals); node
// tests require()/import the same file. Pure — no DOM, no fetch.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__selfCrossing = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Absent is not zero: Number(null) is 0 and Number.isFinite(0) is true, so
    // options must be guarded before coercion. Mirror of finiteOrNull in
    // station-3d/core/math.js; UMD cannot import it, so the rule is restated.
    function finiteOrNull(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (typeof value === 'string' && value.trim() !== '') {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : null;
        }
        return null;
    }

    // Minimum rail-to-rail vertical separation where the track crosses over
    // itself: ~6.5 m structure gauge under the deck (electrified clearance)
    // plus ~1.5 m of deck. Mirror of DEFAULTS.selfCrossingSeparationM in
    // grade-solver.js (UMD cannot import it) — a unit test asserts the two
    // stay equal, same guard as the tunnel-depth rule.
    const MIN_SEPARATION_M = 8;

    // Two crossings reported within this chainage distance on BOTH passes are
    // one physical crossing (a crossing landing near a vertex is reported by
    // two adjacent segment pairs).
    const CLUSTER_TOLERANCE_M = 15;

    // Same haversine as vertical-profile's vertexChainagesMeters, restated so
    // detection lands in the profile's exact dM domain without an import.
    const EARTH_RADIUS_M = 6371000;
    function vertexChainages(latlngs) {
        const rad = Math.PI / 180;
        const out = [0];
        for (let i = 1; i < (latlngs || []).length; i++) {
            const [lat1, lng1] = latlngs[i - 1];
            const [lat2, lng2] = latlngs[i];
            const dLat = (lat2 - lat1) * rad;
            const dLng = (lng2 - lng1) * rad;
            const s = Math.sin(dLat / 2) ** 2
                + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
            out.push(out[i - 1] + 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(s)));
        }
        return out;
    }

    // Proper segment intersection in local metres. Parallel/collinear pairs
    // return null on purpose: a route retracing its own corridor (out-and-back)
    // overlaps on infinitely many points and is not a point crossing. Endpoint
    // touches are included (a crossing may pass exactly through a vertex of the
    // other pass); the cluster pass merges the duplicate reports that creates.
    function segmentIntersection(ax, ay, bx, by, cx, cy, dx, dy) {
        const rx = bx - ax, ry = by - ay;
        const sx = dx - cx, sy = dy - cy;
        const denom = rx * sy - ry * sx;
        const rLen = Math.hypot(rx, ry), sLen = Math.hypot(sx, sy);
        if (!(rLen > 0) || !(sLen > 0)) return null;
        if (Math.abs(denom) <= 1e-9 * rLen * sLen) return null;
        const qpx = cx - ax, qpy = cy - ay;
        const t = (qpx * sy - qpy * sx) / denom;
        const u = (qpx * ry - qpy * rx) / denom;
        const eps = 1e-9;
        if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
        const angleDeg = Math.asin(Math.min(1, Math.abs(denom) / (rLen * sLen))) * 180 / Math.PI;
        return {
            t: Math.max(0, Math.min(1, t)),
            u: Math.max(0, Math.min(1, u)),
            angleDeg,
        };
    }

    // One physical crossing per cluster: entries whose chainages sit within
    // toleranceM on BOTH passes collapse, keeping the most transverse report
    // (largest angle — the least jitter-prone of the duplicates).
    function clusterSelfCrossings(crossings, toleranceM = CLUSTER_TOLERANCE_M) {
        const sorted = (crossings || []).slice().sort((a, b) => a.dMa - b.dMa || a.dMb - b.dMb);
        const out = [];
        for (const crossing of sorted) {
            const previous = out.find((existing) => (
                Math.abs(existing.dMa - crossing.dMa) <= toleranceM
                && Math.abs(existing.dMb - crossing.dMb) <= toleranceM
            ));
            if (!previous) { out.push(crossing); continue; }
            if (crossing.angleDeg > previous.angleDeg) out[out.indexOf(previous)] = crossing;
        }
        return out.sort((a, b) => a.dMa - b.dMa);
    }

    // All plan self-intersections of one track polyline as chainage pairs
    // [{dMa, dMb, lat, lng, angleDeg}], dMa < dMb. Non-adjacent segment pairs
    // only (consecutive segments legitimately share a vertex; a closed ring's
    // identical first/last coordinate is continuation, not a crossing — hence
    // the shared-endpoint skip). options.chainagesM lets the caller inject its
    // cached vertex chainages so dM lands in the exact profile domain.
    function findSelfCrossings(latlngs, options) {
        const opts = options || {};
        const points = Array.isArray(latlngs) ? latlngs : [];
        if (points.length < 4) return [];
        const chainages = (Array.isArray(opts.chainagesM)
            && opts.chainagesM.length === points.length)
            ? opts.chainagesM
            : vertexChainages(points);

        // Local equirectangular metres around the mean latitude.
        let latSum = 0;
        for (const point of points) latSum += Number(point[0]);
        const lat0 = latSum / points.length;
        const lng0 = Number(points[0][1]);
        const rad = Math.PI / 180;
        const cosLat = Math.cos(lat0 * rad);
        const xs = new Array(points.length);
        const ys = new Array(points.length);
        for (let i = 0; i < points.length; i++) {
            xs[i] = (Number(points[i][1]) - lng0) * rad * EARTH_RADIUS_M * cosLat;
            ys[i] = (Number(points[i][0]) - lat0) * rad * EARTH_RADIUS_M;
        }

        // Sweep over segments sorted by min-x: only pairs whose x-ranges
        // overlap are tested, so a long non-looping route stays near-linear
        // instead of the naive O(n²) that made whole-track hashing painful.
        const segmentCount = points.length - 1;
        const order = [];
        const minX = new Float64Array(segmentCount);
        const maxX = new Float64Array(segmentCount);
        const minY = new Float64Array(segmentCount);
        const maxY = new Float64Array(segmentCount);
        for (let i = 0; i < segmentCount; i++) {
            if (![xs[i], ys[i], xs[i + 1], ys[i + 1]].every(Number.isFinite)) continue;
            minX[i] = Math.min(xs[i], xs[i + 1]);
            maxX[i] = Math.max(xs[i], xs[i + 1]);
            minY[i] = Math.min(ys[i], ys[i + 1]);
            maxY[i] = Math.max(ys[i], ys[i + 1]);
            order.push(i);
        }
        order.sort((a, b) => minX[a] - minX[b]);

        const sharesEndpoint = (i, j) => (
            (xs[i] === xs[j] && ys[i] === ys[j])
            || (xs[i] === xs[j + 1] && ys[i] === ys[j + 1])
            || (xs[i + 1] === xs[j] && ys[i + 1] === ys[j])
            || (xs[i + 1] === xs[j + 1] && ys[i + 1] === ys[j + 1])
        );

        const found = [];
        for (let a = 0; a < order.length; a++) {
            const i = order[a];
            for (let b = a + 1; b < order.length; b++) {
                const j = order[b];
                if (minX[j] > maxX[i]) break;
                if (minY[j] > maxY[i] || maxY[j] < minY[i]) continue;
                if (Math.abs(i - j) < 2) continue;
                if (sharesEndpoint(i, j)) continue;
                const lo = Math.min(i, j), hi = Math.max(i, j);
                const hit = segmentIntersection(
                    xs[lo], ys[lo], xs[lo + 1], ys[lo + 1],
                    xs[hi], ys[hi], xs[hi + 1], ys[hi + 1],
                );
                if (!hit) continue;
                const x = xs[lo] + (xs[lo + 1] - xs[lo]) * hit.t;
                const y = ys[lo] + (ys[lo + 1] - ys[lo]) * hit.t;
                found.push({
                    dMa: chainages[lo] + (chainages[lo + 1] - chainages[lo]) * hit.t,
                    dMb: chainages[hi] + (chainages[hi + 1] - chainages[hi]) * hit.u,
                    lat: y / (rad * EARTH_RADIUS_M) + lat0,
                    lng: x / (rad * EARTH_RADIUS_M * cosLat) + lng0,
                    angleDeg: hit.angleDeg,
                });
            }
        }
        return clusterSelfCrossings(found);
    }

    // deltaZM = this pass's rail elevation − the other pass's, at the shared
    // plan point. Null/NaN (profile not solved yet) is 'unknown' and NEVER a
    // violation — nothing paints red until the check can actually judge.
    // toleranceM absorbs grid quantization and interpolation slack so a solve
    // that lands at 7.6 m of a planned 8 is not flagged as broken.
    function classifySelfCrossing(deltaZM, options) {
        const opts = options || {};
        const minSeparationM = finiteOrNull(opts.minSeparationM) ?? MIN_SEPARATION_M;
        const toleranceM = finiteOrNull(opts.toleranceM) ?? 1;
        const delta = deltaZM == null ? NaN : Number(deltaZM);
        if (!Number.isFinite(delta)) return 'unknown';
        if (delta >= minSeparationM - toleranceM) return 'over';
        if (delta <= -(minSeparationM - toleranceM)) return 'under';
        return 'violation';
    }

    // Strip markers: one per PASS (two per crossing), each carrying its own
    // elevation for the y position and its relation to the other pass.
    // elevAtDM returns metres a.s.l. or a non-finite value while unsolved.
    function stripMarksForSelfCrossings(crossings, elevAtDM, options) {
        if (!Array.isArray(crossings) || typeof elevAtDM !== 'function') return [];
        const num = (v) => (v == null ? NaN : Number(v));
        const marks = [];
        for (const crossing of crossings) {
            const dMa = Number(crossing && crossing.dMa);
            const dMb = Number(crossing && crossing.dMb);
            if (!Number.isFinite(dMa) || !Number.isFinite(dMb)) continue;
            const elevA = num(elevAtDM(dMa));
            const elevB = num(elevAtDM(dMb));
            const both = Number.isFinite(elevA) && Number.isFinite(elevB);
            marks.push({
                dM: dMa,
                otherDM: dMb,
                elevAslM: Number.isFinite(elevA) ? elevA : null,
                deltaZM: both ? elevA - elevB : null,
                mode: classifySelfCrossing(both ? elevA - elevB : null, options),
            }, {
                dM: dMb,
                otherDM: dMa,
                elevAslM: Number.isFinite(elevB) ? elevB : null,
                deltaZM: both ? elevB - elevA : null,
                mode: classifySelfCrossing(both ? elevB - elevA : null, options),
            });
        }
        return marks.sort((a, b) => a.dM - b.dM);
    }

    return {
        findSelfCrossings,
        clusterSelfCrossings,
        classifySelfCrossing,
        stripMarksForSelfCrossings,
        MIN_SEPARATION_M,
        CLUSTER_TOLERANCE_M,
    };
}));
