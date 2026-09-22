// Auto-grade engine for planner tracks: turns a terrain elevation profile
// (POST /api/terrain/profile) plus gauge constraints and user-locked PVIs into
// a buildable vertical alignment — per-step elevation, grade and construction
// regime (tunnel/cut/at-grade/fill/viaduct), and the PVI polyline that is the
// canonical, editable form of the result.
//
// The core is a dynamic program over (chainage x quantized elevation) with
// per-regime construction costs, because no deviation-minimizing projection
// gives buildable answers: pulled toward smoothed terrain, a solver happily
// climbs half a hill on phantom embankments instead of tunnelling, and dives
// into valleys it can only leave by cutting through the far rim. Cost curves
// make those trade-offs explicit: shallow cut/fill is cheap and quadratic
// (deep open cuts are not a thing), tunnels cost a lot but barely more with
// depth, viaducts likewise with height — so summits go underground, valleys
// get bridged, and gentle ground is simply followed, which is how real
// vertical design behaves.
//
// UMD: classic scripts get window.__plannerGrade (never bare globals), node
// tests require()/import the same file. Pure — no DOM, no fetch, no THREE.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__plannerGrade = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Absent is not zero. `Number(null)` is 0 and `Number.isFinite(0)` is true,
    // so the obvious guard `Number.isFinite(Number(x))` accepts a MISSING height
    // as a valid sea-level reading — the coercion that grew a phantom viaduct
    // across Split from a hole in the DEM. Mirror of finiteOrNull in
    // station-3d/core/math.js; UMD cannot import it, so the rule is restated.
    function finiteOrNull(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (typeof value === 'string' && value.trim() !== '') {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : null;
        }
        return null;
    }

    const DEFAULTS = {
        denoiseRadiusM: 60,
        atGradeEpsM: 0.5,
        // Regime hysteresis for CLASSIFICATION: a deep cut becomes a tunnel at
        // enter depth and only reverts below exit depth, so a profile grazing
        // the threshold cannot flicker. Enter mirrors photoreal's
        // TUNNEL_MIN_DEPTH_M.
        tunnelEnterDepthM: 15,
        tunnelExitDepthM: 12,
        viaductEnterHeightM: 10,
        viaductExitHeightM: 8,
        minRegimeRunM: 60,
        pviToleranceM: 0.5,
        // Construction cost model (arbitrary units per metre of run). Cut and
        // fill grow QUADRATICALLY with depth/height — a 20 m open cut is not
        // "4x a 5 m cut", it is a different engineering problem — while tunnel
        // and viaduct are expensive to enter but nearly flat beyond their
        // threshold. Each curve is continuous at its regime threshold. The
        // vertical penalty charges every metre climbed or descended, so the
        // profile does not wander when terrain-hugging is free.
        costs: {
            cutPerM: (depth) => depth * depth / 5,
            fillPerM: (height) => height * height / 4,
            // Overburden barely matters to a tunnel (30 m of rock overhead is
            // not pricier than 20), and pier height only modestly to a viaduct.
            // Keep these LOW relative to fill, or the solver discovers that a
            // long approach embankment "buys" a shallower tunnel and builds
            // phantom ramps on flat ground in front of every portal.
            tunnelExtraPerM: 0.05,  // per metre of depth beyond the threshold
            viaductExtraPerM: 0.2,  // per metre of height beyond the threshold
            verticalPenaltyPerM: 1.0,
        },
        // OSM structures are one-sided evidence, not surveyed rail-head
        // elevations. Their penalty can steer the civil solve toward a plausible
        // envelope, but can always yield to hard anchors and the ruling grade.
        structureConstraintToleranceM: 2,
        // Self-crossing (spiral/loop) separation: where the route crosses its
        // own plan line, the two passes must differ vertically by clearance
        // plus deck. Separation mirrors __selfCrossing.MIN_SEPARATION_M in
        // self-crossing.js (UMD cannot import it; a unit test keeps them equal).
        selfCrossingSeparationM: 8,
        selfCrossingMarginM: 0.75,  // planned above the minimum so grid quantization cannot eat it
        selfCrossingToleranceM: 1,  // measurement slack before a solve is called violating
        selfCrossingMaxRounds: 3,
        selfCrossingBandM: 25,      // half-width of the red strip band at each pass
        // Elevation quantization: never coarser than half the per-chord rise
        // (or adjacent levels become unreachable and the DP can only go flat),
        // capped so pathological ranges cannot explode the state space.
        maxElevationLevels: 2400,
    };

    function clamp(value, minimum, maximum) {
        return Math.max(minimum, Math.min(maximum, value));
    }

    function median(values) {
        const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
        if (sorted.length === 0) return 0;
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) * 0.5;
    }

    // ---- terrain sanitizing -------------------------------------------------
    // Profile points arrive as {dM, elevAslM|null} (null = no DEM coverage).
    // Nulls are bridged linearly between known neighbours; leading/trailing
    // nulls clamp to the nearest known value. Returns null if nothing is known.
    function sanitizeTerrain(points) {
        const rows = (points || [])
            // Number(null) is 0, so null coverage must be caught BEFORE coercion.
            .map((p) => ({
                dM: Number(p && p.dM),
                elev: (p && p.elevAslM) == null ? NaN : Number(p.elevAslM),
            }))
            .filter((p) => Number.isFinite(p.dM))
            .sort((a, b) => a.dM - b.dM);
        if (rows.length < 2) return null;
        const known = rows.map((p, i) => (Number.isFinite(p.elev) ? i : -1)).filter((i) => i >= 0);
        if (known.length === 0) return null;
        for (let i = 0; i < rows.length; i++) {
            if (Number.isFinite(rows[i].elev)) continue;
            const nextKnown = known.find((k) => k > i);
            const prevKnown = [...known].reverse().find((k) => k < i);
            if (prevKnown == null) rows[i].elev = rows[nextKnown].elev;
            else if (nextKnown == null) rows[i].elev = rows[prevKnown].elev;
            else {
                const a = rows[prevKnown], b = rows[nextKnown];
                const t = (rows[i].dM - a.dM) / Math.max(1e-9, b.dM - a.dM);
                rows[i].elev = a.elev + (b.elev - a.elev) * t;
            }
        }
        return rows;
    }

    // Short rolling median: rejects individual DTM spikes without moving real
    // landforms (same role as rail-formation's denoise pass).
    function denoiseTerrain(rows, denoiseRadiusM) {
        return rows.map((row) => median(rows
            .filter((c) => Math.abs(c.dM - row.dM) <= denoiseRadiusM)
            .map((c) => c.elev)));
    }

    // ---- cost-optimal vertical alignment (DP) --------------------------------
    function regimeCostPerM(diff, opts) {
        const c = opts.costs;
        // The at-grade band is essentially free, but not EXACTLY flat: a zero-
        // cost plateau lets the DP drift anywhere inside it, and profiles came
        // out hovering a grid cell above the ground. The whisper of slope pulls
        // them onto the terrain without ever outweighing a real regime choice.
        if (Math.abs(diff) <= opts.atGradeEpsM) return 0.01 * Math.abs(diff);
        if (diff < 0) {
            const depth = -diff;
            if (depth < opts.tunnelEnterDepthM) return c.cutPerM(depth);
            return c.cutPerM(opts.tunnelEnterDepthM) + c.tunnelExtraPerM * (depth - opts.tunnelEnterDepthM);
        }
        if (diff < opts.viaductEnterHeightM) return c.fillPerM(diff);
        return c.fillPerM(opts.viaductEnterHeightM) + c.viaductExtraPerM * (diff - opts.viaductEnterHeightM);
    }

    const STRUCTURE_DEFAULTS = Object.freeze({
        tunnel: { direction: 'upper', targetOffsetM: -7, weight: 12 },
        viaduct: { direction: 'lower', targetOffsetM: 3, weight: 12 },
        bridge: { direction: 'lower', targetOffsetM: 1.5, weight: 8 },
        embankment: { direction: 'lower', targetOffsetM: 0.5, weight: 0.75 },
        cutting: { direction: 'upper', targetOffsetM: -0.5, weight: 0.75 },
    });

    function normalizeStructureConstraints(input) {
        return (input || []).map((raw, index) => {
            const type = String(raw?.type || '');
            const defaults = STRUCTURE_DEFAULTS[type];
            const d0 = Number(raw?.dM0);
            const d1 = Number(raw?.dM1);
            if (!defaults || !Number.isFinite(d0) || !Number.isFinite(d1) || d0 === d1) return null;
            const dM0 = Math.min(d0, d1);
            const dM1 = Math.max(d0, d1);
            const transition = finiteOrNull(raw?.portalTransitionM);
            const targetOffset = finiteOrNull(raw?.targetOffsetM);
            const weight = finiteOrNull(raw?.weight);
            return {
                ...raw,
                id: String(raw?.id || `structure-${index + 1}`),
                type,
                dM0,
                dM1,
                direction: raw?.direction === 'upper' || raw?.direction === 'lower'
                    ? raw.direction : defaults.direction,
                targetOffsetM: targetOffset === null ? defaults.targetOffsetM : targetOffset,
                portalTransitionM: Math.min(
                    (dM1 - dM0) / 2,
                    transition === null ? 40 : Math.max(1, transition),
                ),
                weight: weight === null ? defaults.weight : Math.max(0, weight),
                osmWayIds: Array.isArray(raw?.osmWayIds)
                    ? [...new Set(raw.osmWayIds.map(String))] : [],
            };
        }).filter(Boolean);
    }

    function interpolatedElevation(rows, dM) {
        if (!rows?.length) return null;
        if (dM <= rows[0].dM) return rows[0].elev;
        if (dM >= rows[rows.length - 1].dM) return rows[rows.length - 1].elev;
        let high = 1;
        while (high < rows.length && rows[high].dM < dM) high++;
        const a = rows[high - 1], b = rows[high];
        const t = (dM - a.dM) / Math.max(1e-9, b.dM - a.dM);
        return a.elev + (b.elev - a.elev) * t;
    }

    function constraintFactor(constraint, dM) {
        if (dM <= constraint.dM0 || dM >= constraint.dM1) return 0;
        const edgeDistanceM = Math.min(dM - constraint.dM0, constraint.dM1 - dM);
        return clamp(edgeDistanceM / Math.max(1, constraint.portalTransitionM), 0, 1);
    }

    function buildStructureConstraintContext(stations, terrainPoints, structureConstraints) {
        const constraints = normalizeStructureConstraints(structureConstraints);
        if (!constraints.length) return { constraints, samples: stations.map(() => []) };
        const rows = sanitizeTerrain(terrainPoints);
        if (!rows) return { constraints: [], samples: stations.map(() => []) };
        const samples = stations.map((dM) => {
            const terrainAslM = interpolatedElevation(rows, dM);
            if (!Number.isFinite(terrainAslM)) return [];
            return constraints.flatMap((constraint) => {
                const factor = constraintFactor(constraint, dM);
                if (factor <= 0) return [];
                return [{
                    constraint,
                    factor,
                    targetAslM: terrainAslM + constraint.targetOffsetM * factor,
                }];
            });
        });
        return { constraints, samples };
    }

    function structureConstraintCostPerM(elevAslM, samples) {
        let cost = 0;
        for (const sample of samples || []) {
            const violationM = sample.constraint.direction === 'upper'
                ? Math.max(0, elevAslM - sample.targetAslM)
                : Math.max(0, sample.targetAslM - elevAslM);
            cost += sample.constraint.weight * sample.factor * violationM * violationM;
        }
        return cost;
    }

    function evaluateStructureConstraints(stations, track, terrainPoints, input, toleranceM = 2) {
        const context = buildStructureConstraintContext(stations, terrainPoints, input);
        return context.constraints.map((constraint) => {
            let minimumMarginM = Infinity;
            let minimumOffsetM = Infinity;
            let maximumOffsetM = -Infinity;
            let sampleCount = 0;
            for (let index = 0; index < stations.length; index++) {
                const sample = context.samples[index].find(
                    candidate => candidate.constraint.id === constraint.id);
                // The transition ends are deliberately unconstrained: OSM gives
                // the portal/abutment location, while a 20 m DTM cannot give its
                // exact rail-head altitude.
                if (!sample || sample.factor < 0.5 || !Number.isFinite(track[index])) continue;
                const terrainAslM = sample.targetAslM
                    - constraint.targetOffsetM * sample.factor;
                const offsetM = track[index] - terrainAslM;
                const marginM = constraint.direction === 'upper'
                    ? sample.targetAslM - track[index]
                    : track[index] - sample.targetAslM;
                minimumMarginM = Math.min(minimumMarginM, marginM);
                minimumOffsetM = Math.min(minimumOffsetM, offsetM);
                maximumOffsetM = Math.max(maximumOffsetM, offsetM);
                sampleCount += 1;
            }
            const status = sampleCount === 0
                ? 'unknown'
                : minimumMarginM >= -Math.max(0, Number(toleranceM) || 0)
                    ? 'satisfied'
                    : 'review';
            return {
                ...constraint,
                minimumMarginM: sampleCount ? Math.round(minimumMarginM * 100) / 100 : null,
                minimumOffsetM: sampleCount ? Math.round(minimumOffsetM * 100) / 100 : null,
                maximumOffsetM: sampleCount ? Math.round(maximumOffsetM * 100) / 100 : null,
                sampleCount,
                status,
            };
        });
    }

    function solveAlignmentDp(stations, terrain, maxGrade, pins, opts) {
        const count = stations.length;
        // Elevation grid bounds: terrain plus room for the deepest tunnel /
        // tallest viaduct worth paying for, and every pinned elevation.
        let lo = Math.min(...terrain), hi = Math.max(...terrain);
        for (const elev of pins.values()) { lo = Math.min(lo, elev); hi = Math.max(hi, elev); }
        lo -= 40; hi += 40;
        let minChordRise = Infinity;
        for (let i = 1; i < count; i++) {
            minChordRise = Math.min(minChordRise, maxGrade * Math.max(0.01, stations[i] - stations[i - 1]));
        }
        const q = Math.max((hi - lo) / opts.maxElevationLevels, Math.min(0.25, minChordRise / 2));
        const levels = Math.max(2, Math.ceil((hi - lo) / q) + 1);
        const levelElev = (l) => lo + l * q;
        const nearestLevel = (elev) => clamp(Math.round((elev - lo) / q), 0, levels - 1);

        const INF = Infinity;
        let prev = new Float64Array(levels).fill(INF);
        let curr = new Float64Array(levels);
        // parent[i * levels + l] = best predecessor level at i-1
        const parent = new Int32Array(count * levels).fill(-1);

        const allowedAt = (i) => (pins.has(i) ? [nearestLevel(pins.get(i))] : null);

        const startPin = allowedAt(0);
        const dM0 = 0.5 * (stations[1] - stations[0]);
        for (let l = 0; l < levels; l++) {
            if (startPin && l !== startPin[0]) continue;
            prev[l] = (regimeCostPerM(levelElev(l) - terrain[0], opts)
                + structureConstraintCostPerM(levelElev(l), opts.structureContext?.samples[0])) * dM0;
        }

        for (let i = 1; i < count; i++) {
            const runM = Math.max(0.01, stations[i] - stations[i - 1]);
            const maxDelta = Math.max(1, Math.floor((maxGrade * runM) / q));
            // Cost is charged over the half-chords this sample owns.
            const ownM = 0.5 * (stations[Math.min(i + 1, count - 1)] - stations[Math.max(i - 1, 0)]);
            const pinLevel = allowedAt(i);
            curr.fill(INF);
            const from = pinLevel ? [pinLevel[0]] : null;
            for (let l = 0; l < levels; l++) {
                if (from && l !== from[0]) continue;
                const stepCost = (regimeCostPerM(levelElev(l) - terrain[i], opts)
                    + structureConstraintCostPerM(
                        levelElev(l),
                        opts.structureContext?.samples[i],
                    )) * ownM;
                let best = INF, bestFrom = -1;
                const fromLo = Math.max(0, l - maxDelta);
                const fromHi = Math.min(levels - 1, l + maxDelta);
                for (let p = fromLo; p <= fromHi; p++) {
                    if (prev[p] === INF) continue;
                    const vertical = Math.abs(l - p) * q * opts.costs.verticalPenaltyPerM;
                    const total = prev[p] + vertical;
                    if (total < best) { best = total; bestFrom = p; }
                }
                if (bestFrom < 0) continue;
                curr[l] = best + stepCost;
                parent[i * levels + l] = bestFrom;
            }
            // A pin unreachable within the grade limit (already reported as a
            // violation) must not kill the whole solve: jump to it from the
            // cheapest live predecessor and let the polish pass absorb the kink.
            let anyLive = false;
            for (let l = 0; l < levels; l++) if (curr[l] !== INF) { anyLive = true; break; }
            if (!anyLive) {
                let bestPrev = INF, bestPrevLevel = 0;
                for (let p = 0; p < levels; p++) if (prev[p] < bestPrev) { bestPrev = prev[p]; bestPrevLevel = p; }
                const l = pinLevel ? pinLevel[0] : bestPrevLevel;
                curr[l] = bestPrev + (regimeCostPerM(levelElev(l) - terrain[i], opts)
                    + structureConstraintCostPerM(
                        levelElev(l),
                        opts.structureContext?.samples[i],
                    )) * ownM;
                parent[i * levels + l] = bestPrevLevel;
            }
            [prev, curr] = [curr, prev];
        }

        let endLevel = 0, endBest = INF;
        for (let l = 0; l < levels; l++) if (prev[l] < endBest) { endBest = prev[l]; endLevel = l; }
        const track = new Array(count);
        let level = endLevel;
        for (let i = count - 1; i >= 0; i--) {
            track[i] = levelElev(level);
            level = i > 0 ? parent[i * levels + level] : level;
        }
        // Pins are exact values, not grid-rounded ones.
        for (const [i, elev] of pins) track[i] = elev;
        return track;
    }

    // Post-DP polish: a light 3-tap ease removes grid stairsteps, then pure
    // grade clamping restores strict feasibility (easing near re-asserted pins
    // can nudge a chord over the limit). Pins are never moved.
    function easeAndClamp(track, stations, maxGrade, pins) {
        const t = track.slice();
        const lastIndex = t.length - 1;
        for (let round = 0; round < 2; round++) {
            const source = t.slice();
            for (let i = 1; i < lastIndex; i++) {
                if (pins.has(i)) continue;
                t[i] = source[i - 1] * 0.25 + source[i] * 0.5 + source[i + 1] * 0.25;
            }
        }
        const rise = (i, j) => maxGrade * Math.max(0.01, Math.abs(stations[j] - stations[i]));
        for (let pass = 0; pass < 8; pass++) {
            for (let i = 1; i <= lastIndex; i++) {
                if (pins.has(i)) continue;
                t[i] = clamp(t[i], t[i - 1] - rise(i - 1, i), t[i - 1] + rise(i - 1, i));
            }
            for (let i = lastIndex - 1; i >= 0; i--) {
                if (pins.has(i)) continue;
                t[i] = clamp(t[i], t[i + 1] - rise(i, i + 1), t[i + 1] + rise(i, i + 1));
            }
        }
        return t;
    }

    // ---- regimes -------------------------------------------------------------
    function classifyRegimes(diffs, stations, options) {
        const regimes = new Array(diffs.length);
        let state = 'at-grade';
        for (let i = 0; i < diffs.length; i++) {
            const depth = -diffs[i];   // positive = track below terrain
            const height = diffs[i];   // positive = track above terrain
            if (state === 'tunnel') {
                state = depth >= options.tunnelExitDepthM ? 'tunnel' : 'cut';
            } else if (state === 'viaduct') {
                state = height >= options.viaductExitHeightM ? 'viaduct' : 'fill';
            }
            if (state !== 'tunnel' && state !== 'viaduct') {
                if (depth >= options.tunnelEnterDepthM) state = 'tunnel';
                else if (height >= options.viaductEnterHeightM) state = 'viaduct';
                else if (depth > options.atGradeEpsM) state = 'cut';
                else if (height > options.atGradeEpsM) state = 'fill';
                else state = 'at-grade';
            }
            regimes[i] = state;
        }
        // Absorb runs shorter than minRegimeRunM into a neighbour so a few
        // samples around a threshold cannot stripe the profile.
        //
        // Absorbing must not manufacture an impossible regime. 'fill' is an
        // embankment and cannot describe rail BELOW ground; 'cut' cannot
        // describe rail above it. Absorbing unconditionally into the preceding
        // regime did exactly that at every tunnel portal, where the approach
        // cut is naturally short because the ground rises fast: the cut was
        // swallowed by the fill before it, leaving an embankment recorded 14 m
        // under the hillside where the portal mouth belongs. Prefer the
        // preceding regime, fall back to the following one, and if neither can
        // honestly hold the run, leave it alone — a short truthful cut beats a
        // long impossible fill.
        const regimeAllowsDiff = (regime, diff) => {
            if (regime === 'fill' || regime === 'viaduct') return diff >= -options.atGradeEpsM;
            if (regime === 'cut' || regime === 'tunnel') return diff <= options.atGradeEpsM;
            return true;
        };
        let runStart = 0;
        for (let i = 1; i <= regimes.length; i++) {
            if (i < regimes.length && regimes[i] === regimes[runStart]) continue;
            const runLength = stations[i - 1] - stations[runStart];
            if (runStart > 0 && runLength < options.minRegimeRunM && i < regimes.length) {
                const fits = (regime) => {
                    for (let j = runStart; j < i; j++) {
                        if (!regimeAllowsDiff(regime, diffs[j])) return false;
                    }
                    return true;
                };
                const previous = regimes[runStart - 1];
                const next = regimes[i];
                const target = fits(previous) ? previous : (fits(next) ? next : null);
                if (target !== null) {
                    for (let j = runStart; j < i; j++) regimes[j] = target;
                }
            }
            runStart = i;
        }
        return regimes;
    }

    // ---- PVI extraction (Douglas-Peucker on chainage x elevation) ------------
    function simplifyProfile(stations, values, toleranceM, keepIndices) {
        const keep = new Set([0, stations.length - 1, ...keepIndices]);
        const anchors = [...keep].sort((a, b) => a - b);
        for (let a = 0; a < anchors.length - 1; a++) {
            rdp(anchors[a], anchors[a + 1]);
        }
        function rdp(from, to) {
            if (to - from < 2) return;
            let worst = -1, worstDev = 0;
            for (let i = from + 1; i < to; i++) {
                const t = (stations[i] - stations[from]) / Math.max(1e-9, stations[to] - stations[from]);
                const straight = values[from] + (values[to] - values[from]) * t;
                const deviation = Math.abs(values[i] - straight);
                if (deviation > worstDev) { worstDev = deviation; worst = i; }
            }
            if (worstDev > toleranceM) {
                keep.add(worst);
                rdp(from, worst);
                rdp(worst, to);
            }
        }
        return [...keep].sort((a, b) => a - b);
    }

    // ---- self-crossing separation (spiral/loop tracks) -----------------------
    // A plan self-intersection couples two DISTANT chainages — elev(dMa) and
    // elev(dMb) must differ by a full separation — which a 1-D DP cannot
    // express directly (it breaks the Markov property). Classic constraint
    // generation instead: solve, measure the crossings, pin the violated pairs
    // apart, re-solve. The archetypal climbing spiral separates on the first
    // solve (endpoints force the climb) and never needs a pin at all.

    function interpolatedTrackElevation(stations, track, dM) {
        const last = stations.length - 1;
        if (dM <= stations[0]) return track[0];
        if (dM >= stations[last]) return track[last];
        let hi = 1;
        while (hi < last && stations[hi] < dM) hi++;
        const t = (dM - stations[hi - 1]) / Math.max(1e-9, stations[hi] - stations[hi - 1]);
        return track[hi - 1] + (track[hi] - track[hi - 1]) * t;
    }

    // Sanitize caller crossings ({dMa, dMb} pairs from __selfCrossing) into the
    // profile's chainage range. A pair the sample grid cannot distinguish
    // (both chainages on one sample) is dropped here and surfaces as a
    // violation from the final separation check instead.
    function normalizeSelfCrossings(input, stations) {
        const startM = stations[0];
        const endM = stations[stations.length - 1];
        return (input || [])
            .map((crossing) => {
                const a = Number(crossing && crossing.dMa);
                const b = Number(crossing && crossing.dMb);
                if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
                const dMa = clamp(Math.min(a, b), startM, endM);
                const dMb = clamp(Math.max(a, b), startM, endM);
                if (dMb - dMa < 2) return null;
                return { dMa, dMb };
            })
            .filter(Boolean)
            .sort((a, b) => a.dMa - b.dMa);
    }

    // Which crossings still need pins, and where. Both passes free → split
    // symmetrically around their midpoint, the higher first-solve pass on top
    // (tie → the later pass climbs over, the climbing-spiral convention). A
    // pass already pinned by a user lock or a station plateau is never moved:
    // the free pass takes the whole separation. Both passes owned, colliding
    // sample indices, or a loop too short for the ruling grade → no pin; the
    // final separation check reports those honestly.
    function planSelfCrossingPins(crossings, elevAt, context) {
        const { stations, pins, injected, nearestIndex, maxGrade } = context;
        const separationM = context.separationM;
        const needM = separationM + 2 * context.marginM;
        const plans = [];
        for (const { dMa, dMb } of crossings) {
            const elevA = elevAt(dMa);
            const elevB = elevAt(dMb);
            if (Math.abs(elevA - elevB) >= separationM - context.toleranceM) continue;
            const indexA = nearestIndex(dMa);
            const indexB = nearestIndex(dMb);
            if (indexA === indexB) continue;
            if (maxGrade * Math.abs(stations[indexB] - stations[indexA]) < needM - 1e-6) continue;
            const ownedA = pins.has(indexA) && !injected.has(indexA);
            const ownedB = pins.has(indexB) && !injected.has(indexB);
            if (ownedA && ownedB) continue;
            if (ownedA) {
                plans.push({ index: indexB, elevAslM: pins.get(indexA) + (elevB >= elevA ? needM : -needM) });
            } else if (ownedB) {
                plans.push({ index: indexA, elevAslM: pins.get(indexB) + (elevA > elevB ? needM : -needM) });
            } else {
                const mid = (elevA + elevB) / 2;
                const aOnTop = elevA > elevB;
                plans.push(
                    { index: indexA, elevAslM: mid + (aOnTop ? needM : -needM) / 2 },
                    { index: indexB, elevAslM: mid + (aOnTop ? -needM : needM) / 2 },
                );
            }
        }
        return plans;
    }

    // Post-solve audit: every crossing the solve did NOT separate becomes a
    // pair of narrow red bands, one at each pass — never a band across the
    // whole loop, which would paint the entire route red.
    function selfCrossingSeparationViolations(crossings, elevAt, context) {
        const violations = [];
        for (const { dMa, dMb } of crossings) {
            const separation = Math.abs(elevAt(dMa) - elevAt(dMb));
            if (separation >= context.separationM - context.toleranceM) continue;
            const message = `petlja se križa sama sa sobom uz razmak ${separation.toFixed(1)} m `
                + `(min ${context.separationM} m) — km ${(dMa / 1000).toFixed(2)} ↔ km ${(dMb / 1000).toFixed(2)}`;
            for (const dM of [dMa, dMb]) {
                violations.push({
                    type: 'self-crossing',
                    dM0: Math.max(context.startM, dM - context.bandM),
                    dM1: Math.min(context.endM, dM + context.bandM),
                    message,
                });
            }
        }
        return violations;
    }

    // ---- solver ---------------------------------------------------------------
    // terrainPoints: [{dM, elevAslM|null}], ascending dM (the /terrain/profile shape).
    // options: {
    //   maxGradePct            required — per-gauge limit (g1435 4, g1000 6, monorail 8)
    //   lockedPvis             [{dM, elevAslM}] must-pass points (profile-strip drags)
    //   stationSpans           [{dM0, dM1, elevAslM?}] low-level forced-level
    //                          runs; callers integrating real stations should
    //                          use solveGradeProfileWithStations so the level
    //                          is inherited from the unconstrained design
    //   ...DEFAULTS overrides (costs{} merges shallowly)
    // }
    function solveGradeProfile(terrainPoints, options) {
        const opts = Object.assign({}, DEFAULTS, options || {});
        opts.costs = Object.assign({}, DEFAULTS.costs, (options || {}).costs || {});
        const maxGradePct = Number(opts.maxGradePct);
        if (!Number.isFinite(maxGradePct) || maxGradePct <= 0) {
            throw new Error('solveGradeProfile: options.maxGradePct is required');
        }
        const maxGrade = maxGradePct / 100;
        const rows = sanitizeTerrain(terrainPoints);
        if (!rows) throw new Error('solveGradeProfile: terrain profile has no usable points');
        const stations = rows.map((r) => r.dM);
        const lastIndex = rows.length - 1;
        const violations = [];

        const denoised = denoiseTerrain(rows, opts.denoiseRadiusM);
        opts.structureContext = buildStructureConstraintContext(
            stations,
            opts.structureTerrainPoints || terrainPoints,
            opts.structureConstraints,
        );

        const nearestIndex = (dM) => {
            let best = 0, bestDist = Infinity;
            for (let i = 0; i < stations.length; i++) {
                const distance = Math.abs(stations[i] - dM);
                if (distance < bestDist) { bestDist = distance; best = i; }
            }
            return best;
        };
        // Every sample inside a station span is a solver constraint, but it is
        // NOT a user lock. Keep those concepts separate: otherwise saving and
        // reloading a station-flattened profile turns generated plateau points
        // into permanent geographic edit anchors. Explicit user locks are
        // applied last, so a station can never silently overwrite authored
        // intent when the two constraints happen to share a terrain sample.
        const pins = new Map();
        const spans = (opts.stationSpans || [])
            .map((s) => ({
                from: nearestIndex(Math.min(Number(s.dM0), Number(s.dM1))),
                to: nearestIndex(Math.max(Number(s.dM0), Number(s.dM1))),
                elev: finiteOrNull(s.elevAslM),
            }))
            .filter((s) => s.to > s.from);
        for (const span of spans) {
            if (span.elev == null) {
                const inside = denoised.slice(span.from, span.to + 1);
                span.elev = inside.reduce((a, b) => a + b, 0) / inside.length;
            }
            for (let i = span.from; i <= span.to; i++) pins.set(i, span.elev);
        }
        const lockedPinIndices = new Set();
        for (const pvi of opts.lockedPvis || []) {
            const elev = Number(pvi && pvi.elevAslM);
            const dM = Number(pvi && pvi.dM);
            if (!Number.isFinite(elev) || !Number.isFinite(dM)) continue;
            const index = nearestIndex(dM);
            pins.set(index, elev);
            lockedPinIndices.add(index);
        }

        // Feasibility: consecutive pins further apart in elevation than the grade
        // can climb are reported, never silently moved. Re-run after loop pins
        // are injected, so a pin planted beside a user lock reports too.
        const pinGradeViolations = () => {
            const indices = [...pins.keys()].sort((a, b) => a - b);
            const found = [];
            for (let p = 0; p < indices.length - 1; p++) {
                const a = indices[p], b = indices[p + 1];
                const run = stations[b] - stations[a];
                const rise = Math.abs(pins.get(b) - pins.get(a));
                // Same 2 cm quantization slack as the derive-path grade check:
                // locked PVIs come from saved (0.01 m-rounded) elevations.
                if (rise > maxGrade * run + 0.021) {
                    found.push({
                        type: 'pin-grade',
                        dM0: stations[a],
                        dM1: stations[b],
                        message: `locked elevations need ${(rise / Math.max(0.01, run) * 100).toFixed(1)}% `
                            + `over ${Math.round(run)} m (limit ${maxGradePct}%)`,
                    });
                }
            }
            return found;
        };
        violations.push(...pinGradeViolations());

        let track = easeAndClamp(
            solveAlignmentDp(stations, denoised, maxGrade, pins, opts),
            stations, maxGrade, pins,
        );

        // Spiral/loop tracks: measure each plan self-crossing on the solved
        // profile, pin the still-level pairs apart, and re-solve. A crossing
        // the terrain-forced climb already separates costs nothing here.
        const selfCrossings = normalizeSelfCrossings(opts.selfCrossings, stations);
        if (selfCrossings.length > 0) {
            const trackElevAt = (dM) => interpolatedTrackElevation(stations, track, dM);
            const crossingContext = {
                stations,
                pins,
                nearestIndex,
                maxGrade,
                injected: new Set(),
                separationM: opts.selfCrossingSeparationM,
                marginM: opts.selfCrossingMarginM,
                toleranceM: opts.selfCrossingToleranceM,
            };
            for (let round = 0; round < opts.selfCrossingMaxRounds; round++) {
                const plans = planSelfCrossingPins(selfCrossings, trackElevAt, crossingContext);
                if (plans.length === 0) break;
                for (const plan of plans) {
                    pins.set(plan.index, plan.elevAslM);
                    crossingContext.injected.add(plan.index);
                }
                track = easeAndClamp(
                    solveAlignmentDp(stations, denoised, maxGrade, pins, opts),
                    stations, maxGrade, pins,
                );
            }
            if (crossingContext.injected.size > 0) {
                for (const violation of pinGradeViolations()) {
                    const duplicate = violations.some((existing) => existing.type === violation.type
                        && existing.dM0 === violation.dM0 && existing.dM1 === violation.dM1);
                    if (!duplicate) violations.push(violation);
                }
            }
            violations.push(...selfCrossingSeparationViolations(selfCrossings, trackElevAt, {
                separationM: opts.selfCrossingSeparationM,
                toleranceM: opts.selfCrossingToleranceM,
                bandM: opts.selfCrossingBandM,
                startM: stations[0],
                endM: stations[lastIndex],
            }));
        }

        const diffs = track.map((elev, i) => elev - denoised[i]);
        const regimes = classifyRegimes(diffs, stations, opts);

        const steps = rows.map((row, i) => {
            const next = i < lastIndex ? i + 1 : i;
            const previous = i < lastIndex ? i : i - 1;
            const run = Math.max(0.01, stations[next] - stations[previous]);
            return {
                dM: row.dM,
                elevAslM: Math.round(track[i] * 100) / 100,
                terrainAslM: Math.round(denoised[i] * 100) / 100,
                gradePct: Math.round(((track[next] - track[previous]) / run) * 10000) / 100,
                regime: regimes[i],
            };
        });

        // Loop pins injected above must survive as PVIs, so the keep list is
        // read from the final pins map, not the pre-injection snapshot.
        const pviIndexList = simplifyProfile(
            stations, track, opts.pviToleranceM, [...pins.keys()],
        );
        const pvis = pviIndexList.map((i) => ({
            dM: stations[i],
            elevAslM: Math.round(track[i] * 100) / 100,
            locked: lockedPinIndices.has(i),
        }));

        const structureConstraints = evaluateStructureConstraints(
            stations,
            track,
            opts.structureTerrainPoints || terrainPoints,
            opts.structureContext.constraints,
            opts.structureConstraintToleranceM,
        );
        return { steps, pvis, violations, structureConstraints };
    }

    // Elevation on a solved step series at an arbitrary chainage. Kept here,
    // rather than in transit.js, so the two-pass station policy is pure and
    // covered without a browser.
    function solvedElevationAt(steps, dM) {
        if (!Array.isArray(steps) || steps.length === 0) return null;
        const target = Number(dM);
        if (!Number.isFinite(target)) return null;
        if (target <= steps[0].dM) return steps[0].elevAslM;
        if (target >= steps[steps.length - 1].dM) return steps[steps.length - 1].elevAslM;
        let hi = 1;
        while (hi < steps.length && steps[hi].dM < target) hi++;
        const a = steps[hi - 1], b = steps[hi];
        const t = (target - a.dM) / Math.max(1e-9, b.dM - a.dM);
        return a.elevAslM + (b.elevAslM - a.elevAslM) * t;
    }

    // Turn station centres into spans on the solver's ACTUAL sample grid.
    // Overlapping spans become one short station complex at the median of the
    // first-pass station elevations. An explicit lock inside such a complex
    // owns its elevation; incompatible locks make the generated span opt out,
    // because preserving an authored slope is safer than silently moving it.
    function stationSpansFromFirstPass(firstPass, stationCenters, lockedPvis, defaultHalfSpanM) {
        const steps = firstPass?.steps || [];
        if (steps.length < 2) return [];
        const chainages = steps.map((step) => Number(step.dM));
        const routeStartM = chainages[0];
        const routeEndM = chainages[chainages.length - 1];
        const nearestIndex = (dM) => {
            let best = 0, bestDistance = Infinity;
            for (let i = 0; i < chainages.length; i++) {
                const distance = Math.abs(chainages[i] - dM);
                if (distance < bestDistance) { best = i; bestDistance = distance; }
            }
            return best;
        };
        const floorIndex = (dM) => {
            let index = 0;
            while (index < chainages.length - 1 && chainages[index + 1] <= dM) index++;
            return index;
        };
        const ceilIndex = (dM) => {
            let index = chainages.length - 1;
            while (index > 0 && chainages[index - 1] >= dM) index--;
            return index;
        };

        const requests = (stationCenters || [])
            .map((station) => {
                const dM = clamp(Number(station?.dM), routeStartM, routeEndM);
                const explicit0 = station?.dM0 == null ? NaN : Number(station.dM0);
                const explicit1 = station?.dM1 == null ? NaN : Number(station.dM1);
                const hasExplicitSpan = Number.isFinite(explicit0) && Number.isFinite(explicit1);
                const requestedHalfSpanM = Number(station?.halfSpanM);
                const halfSpanM = Number.isFinite(requestedHalfSpanM) && requestedHalfSpanM > 0
                    ? requestedHalfSpanM
                    : defaultHalfSpanM;
                if (!Number.isFinite(dM)
                    || (!hasExplicitSpan && (!Number.isFinite(halfSpanM) || halfSpanM <= 0))) return null;
                const requestedFromM = hasExplicitSpan ? Math.min(explicit0, explicit1) : dM - halfSpanM;
                const requestedToM = hasExplicitSpan ? Math.max(explicit0, explicit1) : dM + halfSpanM;
                // Round OUTWARD on the sample grid. Nearest rounding can trim
                // ten metres from a 30 m half-platform when the boundary falls
                // midway between 20 m terrain samples.
                let from = floorIndex(Math.max(routeStartM, requestedFromM));
                let to = ceilIndex(Math.min(routeEndM, requestedToM));
                if (from > to) [from, to] = [to, from];
                // A station shorter than the terrain step still needs a chord
                // on which a zero grade can be expressed.
                if (from === to) {
                    if (to < steps.length - 1) to += 1;
                    else if (from > 0) from -= 1;
                }
                if (from === to) return null;
                return {
                    from,
                    to,
                    elevations: [solvedElevationAt(steps, dM)],
                };
            })
            .filter(Boolean)
            .sort((a, b) => a.from - b.from || a.to - b.to);
        if (requests.length === 0) return [];

        const clusters = [];
        for (const request of requests) {
            const previous = clusters[clusters.length - 1];
            if (previous && request.from <= previous.to) {
                previous.to = Math.max(previous.to, request.to);
                previous.elevations.push(...request.elevations);
            } else {
                clusters.push({
                    from: request.from,
                    to: request.to,
                    elevations: request.elevations.slice(),
                });
            }
        }

        const lockByIndex = new Map();
        for (const lock of lockedPvis || []) {
            const dM = Number(lock?.dM);
            const elevAslM = Number(lock?.elevAslM);
            if (!Number.isFinite(dM) || !Number.isFinite(elevAslM)) continue;
            lockByIndex.set(nearestIndex(dM), elevAslM);
        }

        const spans = [];
        for (const cluster of clusters) {
            const lockElevations = [...lockByIndex.entries()]
                .filter(([index]) => index >= cluster.from && index <= cluster.to)
                .map(([, elevation]) => elevation);
            let elevAslM = median(cluster.elevations);
            if (lockElevations.length > 0) {
                const minLock = Math.min(...lockElevations);
                const maxLock = Math.max(...lockElevations);
                if (maxLock - minLock > 1e-6) continue;
                elevAslM = lockElevations[0];
            }
            if (!Number.isFinite(elevAslM)) continue;
            spans.push({
                dM0: chainages[cluster.from],
                dM1: chainages[cluster.to],
                elevAslM,
            });
        }
        return spans;
    }

    // Conservative station integration: solve the authored/automatic civil
    // alignment first, then inherit each station's elevation from THAT design
    // and re-solve only to introduce a short level chord. Terrain never chooses
    // a station's elevation, so a station in a tunnel stays in the tunnel and a
    // station on a viaduct stays on the viaduct.
    function solveGradeProfileWithStations(terrainPoints, options) {
        const opts = Object.assign({}, options || {});
        const stationCenters = Array.isArray(opts.stationCenters) ? opts.stationCenters : [];
        const halfSpanRequest = finiteOrNull(opts.stationHalfSpanM);
        const defaultHalfSpanM = halfSpanRequest === null ? 30 : Math.max(0, halfSpanRequest);
        delete opts.stationCenters;
        delete opts.stationHalfSpanM;
        const firstPass = solveGradeProfile(terrainPoints, { ...opts, stationSpans: [] });
        if (stationCenters.length === 0) return firstPass;
        const stationSpans = stationSpansFromFirstPass(
            firstPass,
            stationCenters,
            opts.lockedPvis,
            defaultHalfSpanM,
        );
        if (stationSpans.length === 0) return firstPass;
        return solveGradeProfile(terrainPoints, { ...opts, stationSpans });
    }

    // Reconcile station plateau boundaries into an explicit PVI polyline.
    // Generated boundaries stay unlocked. Locked points inside the span are
    // retained (stationSpansFromFirstPass already made a compatible single
    // lock own the plateau elevation, or skipped an incompatible span).
    function applyStationSpansToPvis(pviList, stationSpans) {
        let pvis = (pviList || [])
            .map((p) => ({
                dM: Number(p?.dM),
                elevAslM: Number(p?.elevAslM),
                locked: !!p?.locked,
            }))
            .filter((p) => Number.isFinite(p.dM) && Number.isFinite(p.elevAslM))
            .sort((a, b) => a.dM - b.dM);
        for (const span of stationSpans || []) {
            const dM0 = Number(span?.dM0);
            const dM1 = Number(span?.dM1);
            const elevAslM = Number(span?.elevAslM);
            if (!Number.isFinite(dM0) || !Number.isFinite(dM1)
                || !Number.isFinite(elevAslM) || dM1 <= dM0) continue;
            pvis = pvis.filter((p) => p.locked || p.dM < dM0 - 1e-6 || p.dM > dM1 + 1e-6);
            pvis.push(
                { dM: dM0, elevAslM, locked: false },
                { dM: dM1, elevAslM, locked: false },
            );
        }
        pvis.sort((a, b) => a.dM - b.dM || Number(b.locked) - Number(a.locked));
        const deduped = [];
        for (const pvi of pvis) {
            const previous = deduped[deduped.length - 1];
            if (!previous || Math.abs(previous.dM - pvi.dM) > 1e-6) {
                deduped.push(pvi);
            } else if (pvi.locked && !previous.locked) {
                deduped[deduped.length - 1] = pvi;
            }
        }
        return deduped;
    }

    // A station changing structural type (surface/elevated/tunnel) changes its
    // width. Clear the UNION of the old and new footprints, but pin only the
    // NEW footprint. Using the union for both jobs leaves the old, wider
    // station edges behind as apparently unrelated grade nodes.
    function planStationSpanTransition(oldFromM, oldToM, targetFromM, targetToM, options) {
        const opts = options || {};
        const profileStartM = Number(opts.profileStartM);
        const profileEndM = Number(opts.profileEndM);
        const routeEndM = Number(opts.routeEndM);
        const endSnapM = Math.max(0, Number(opts.endSnapM) || 0);
        let targetLo = Math.min(Number(targetFromM), Number(targetToM));
        let targetHi = Math.max(Number(targetFromM), Number(targetToM));
        if (![targetLo, targetHi, profileStartM, profileEndM, routeEndM].every(Number.isFinite)) return null;
        if (targetLo <= profileStartM + endSnapM) targetLo = Math.min(profileStartM, targetLo);
        if (targetHi >= routeEndM - endSnapM) targetHi = Math.max(profileEndM, targetHi);
        return {
            targetLo,
            targetHi,
            clearLo: Math.min(Number(oldFromM), Number(oldToM), targetLo),
            clearHi: Math.max(Number(oldFromM), Number(oldToM), targetHi),
        };
    }

    // Local PVI editing keeps its straight-line, no-global-reoptimisation
    // contract while regenerating the small station plateaus. Moving one lock
    // within a station span therefore shifts that whole span instead of
    // twisting a rigid platform across the edited rail.
    function deriveProfileFromPvisWithStations(terrainPoints, pviList, options) {
        const opts = Object.assign({}, options || {});
        const stationCenters = Array.isArray(opts.stationCenters) ? opts.stationCenters : [];
        const halfSpanRequest = finiteOrNull(opts.stationHalfSpanM);
        const defaultHalfSpanM = halfSpanRequest === null ? 30 : Math.max(0, halfSpanRequest);
        delete opts.stationCenters;
        delete opts.stationHalfSpanM;
        const firstPass = deriveProfileFromPvis(terrainPoints, pviList, opts);
        if (stationCenters.length === 0) return firstPass;
        const stationSpans = stationSpansFromFirstPass(
            firstPass,
            stationCenters,
            pviList?.filter((pvi) => pvi?.locked),
            defaultHalfSpanM,
        );
        if (stationSpans.length === 0) return firstPass;
        const stationPvis = applyStationSpansToPvis(pviList, stationSpans);
        return deriveProfileFromPvis(terrainPoints, stationPvis, opts);
    }

    // ---- local editing (straight lines between PVIs, no DP) ------------------
    // The user dragged a node, so the profile is the PVI polyline as-is — NOT a
    // re-optimised alignment. Same output shape as solveGradeProfile so
    // buildVerticalProfile consumes it identically. Grades over the limit are
    // reported (never silently corrected) so the strip can flag them red.
    function deriveProfileFromPvis(terrainPoints, pviList, options) {
        const opts = Object.assign({}, DEFAULTS, options || {});
        const maxGradePct = Number(opts.maxGradePct);
        if (!Number.isFinite(maxGradePct) || maxGradePct <= 0) {
            throw new Error('deriveProfileFromPvis: options.maxGradePct is required');
        }
        const maxGrade = maxGradePct / 100;
        const rows = sanitizeTerrain(terrainPoints);
        if (!rows) throw new Error('deriveProfileFromPvis: terrain profile has no usable points');
        const stations = rows.map((r) => r.dM);
        const lastIndex = rows.length - 1;
        const denoised = denoiseTerrain(rows, opts.denoiseRadiusM);

        const pvis = (pviList || [])
            .map((p) => ({ dM: Number(p.dM), elevAslM: Number(p.elevAslM), locked: !!p.locked }))
            .filter((p) => Number.isFinite(p.dM) && Number.isFinite(p.elevAslM))
            .sort((a, b) => a.dM - b.dM);
        if (pvis.length < 2) throw new Error('deriveProfileFromPvis: need >= 2 PVIs');

        // The polyline elevation at an arbitrary chainage (clamped to the ends).
        const elevAt = (dM) => {
            if (dM <= pvis[0].dM) return pvis[0].elevAslM;
            if (dM >= pvis[pvis.length - 1].dM) return pvis[pvis.length - 1].elevAslM;
            let hi = 1;
            while (hi < pvis.length && pvis[hi].dM < dM) hi++;
            const a = pvis[hi - 1], b = pvis[hi];
            const t = (dM - a.dM) / Math.max(1e-9, b.dM - a.dM);
            return a.elevAslM + (b.elevAslM - a.elevAslM) * t;
        };

        const track = stations.map(elevAt);
        const diffs = track.map((elev, i) => elev - denoised[i]);
        const regimes = classifyRegimes(diffs, stations, opts);

        const steps = rows.map((row, i) => {
            const next = i < lastIndex ? i + 1 : i;
            const previous = i < lastIndex ? i : i - 1;
            const run = Math.max(0.01, stations[next] - stations[previous]);
            return {
                dM: row.dM,
                elevAslM: Math.round(track[i] * 100) / 100,
                terrainAslM: Math.round(denoised[i] * 100) / 100,
                gradePct: Math.round(((track[next] - track[previous]) / run) * 10000) / 100,
                regime: regimes[i],
            };
        });

        const violations = [];
        for (let p = 0; p < pvis.length - 1; p++) {
            const run = pvis[p + 1].dM - pvis[p].dM;
            const rise = Math.abs(pvis[p + 1].elevAslM - pvis[p].elevAslM);
            // Stored elevations are rounded to 0.01 m, so a chord solved at
            // exactly the ruling grade can read up to 2 cm over after a save
            // round-trip. That is quantization, not a design fault — without
            // this slack an untouched max-grade chord paints red
            // ("4.0% … limit 4%") the moment it reloads.
            if (run > 0.01 && rise > maxGrade * run + 0.021) {
                violations.push({
                    type: 'grade',
                    dM0: pvis[p].dM,
                    dM1: pvis[p + 1].dM,
                    message: `${(rise / run * 100).toFixed(1)}% preko ${Math.round(run)} m (limit ${maxGradePct}%)`,
                });
            }
        }

        // This path is "what the user drew" — self-crossings are audited and
        // reported, never separated by force. The auto-solver is the only
        // thing that moves elevations; a red band is the honest answer here.
        const selfCrossings = normalizeSelfCrossings(opts.selfCrossings, stations);
        if (selfCrossings.length > 0) {
            violations.push(...selfCrossingSeparationViolations(
                selfCrossings,
                (dM) => interpolatedTrackElevation(stations, track, dM),
                {
                    separationM: opts.selfCrossingSeparationM,
                    toleranceM: opts.selfCrossingToleranceM,
                    bandM: opts.selfCrossingBandM,
                    startM: stations[0],
                    endM: stations[lastIndex],
                },
            ));
        }

        const structureConstraints = evaluateStructureConstraints(
            stations,
            track,
            opts.structureTerrainPoints || terrainPoints,
            opts.structureConstraints,
            opts.structureConstraintToleranceM,
        );
        return { steps, pvis, violations, structureConstraints };
    }

    // The PVI set "recompute" produces on a route that already has pins: the
    // pins themselves, plus each route endpoint that no pin already covers, and
    // nothing else. Everything the auto-solver had put between them is dropped,
    // so consecutive pins end up joined by a straight chord.
    //
    // This is deliberately NOT a re-optimisation. The DP's cost model gives a
    // tunnel its discount only past 15 m of cover, so an authored 8 m tunnel is
    // priced as a deep open cut and the optimizer climbs back to the surface in
    // every unpinned gap — it is answering "what is cheapest", not "what did the
    // user draw". Endpoints are included because deriveProfileFromPvis clamps
    // flat outside the PVI range: without them the route ends would jump to the
    // outermost pin's elevation.
    function pinnedRecomputePvis(pins, endpoints) {
        const out = (pins || [])
            .map((p) => ({ dM: Number(p?.dM), elevAslM: Number(p?.elevAslM), locked: true }))
            .filter((p) => Number.isFinite(p.dM) && Number.isFinite(p.elevAslM));
        if (out.length === 0) return [];
        for (const end of endpoints || []) {
            const dM = Number(end?.dM);
            const elevAslM = Number(end?.elevAslM);
            if (!Number.isFinite(dM) || !Number.isFinite(elevAslM)) continue;
            if (out.some((p) => Math.abs(p.dM - dM) < 1)) continue;
            out.push({ dM, elevAslM, locked: false });
        }
        out.sort((a, b) => a.dM - b.dM);
        return out;
    }

    return {
        solveGradeProfile,
        solveGradeProfileWithStations,
        deriveProfileFromPvis,
        deriveProfileFromPvisWithStations,
        sanitizeTerrain,
        solvedElevationAt,
        stationSpansFromFirstPass,
        applyStationSpansToPvis,
        planStationSpanTransition,
        pinnedRecomputePvis,
        normalizeStructureConstraints,
        evaluateStructureConstraints,
        DEFAULTS,
    };
}));
