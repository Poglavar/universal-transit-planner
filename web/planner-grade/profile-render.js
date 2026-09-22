// Pure layout/scene math for the track elevation-profile strip (M3): maps a
// solved verticalProfile + terrain points into pixel-space paths, regime
// bands, PVI handles, ticks and hit-tests. No DOM, no canvas — the drawing
// and pointer wiring live in profile-strip.js; everything with a branch worth
// testing is here.
//
// UMD: classic scripts get window.__profileRender, node tests require() it.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__profileRender = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Mirrors finiteOrNull() in station-3d/core/math.js, which this UMD module
    // cannot import. The guard that LOOKS right — Number.isFinite(Number(x)) —
    // accepts null, because Number(null) is 0, and a height of zero is a real
    // reading. Splitting it over two lines hides it from the repo's ratchet but
    // not from the bug.
    function finiteOrNull(value) {
        if (value === null || value === undefined || value === '') return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }

    // Regime colors for the band under the profile. Red stays reserved for
    // violations (matches the planner map-legend convention).
    const REGIME_COLORS = {
        tunnel: '#26262b',
        cut: '#8a6d3b',
        'at-grade': '#2e7dd1',
        fill: '#c9a227',
        viaduct: '#2e9e4f',
    };
    const REGIME_LABELS = {
        tunnel: 'Tunel',
        cut: 'Usjek',
        'at-grade': 'Na terenu',
        fill: 'Nasip',
        viaduct: 'Vijadukt',
    };
    // The tube section standing above rail. This is the 7.3 m inside the ONE
    // authoring rule (8 m of cover = 7.3 m of tube + 0.7 m over the roof slab,
    // DEFAULT_TUNNEL_COVER_THRESHOLD_M in station-3d/core/rail-formation.js),
    // pulled out so the strip can DRAW the roof instead of only implying it.
    // A profile can read as a tunnel to its author and still stand proud of the
    // hillside; without the roof on the chart there is nothing to see it in.
    const TUNNEL_TUBE_HEIGHT_M = 7.3;

    const STRUCTURE_COLORS = {
        tunnel: '#6b4f9d',
        viaduct: '#16836f',
        bridge: '#16836f',
        embankment: '#b38820',
        cutting: '#9a5b2c',
    };
    const STRUCTURE_LABELS = {
        tunnel: 'OSM tunel',
        viaduct: 'OSM vijadukt',
        bridge: 'OSM most',
        embankment: 'OSM nasip',
        cutting: 'OSM usjek',
    };
    // A handle is an 8–12 px interaction target. Reconstructed rail profiles
    // can carry one locked PVI every 20 m (5,592 on the longest current
    // project), so painting all of them means thousands of indistinguishable
    // canvas fill/stroke calls. Keep at most one handle per visible 8 px bucket;
    // zooming in naturally reveals the nodes that were sharing a bucket.
    const PVI_HANDLE_MIN_SPACING_PX = 8;

    // 1/2/5 x 10^n step that yields <= targetCount intervals over range.
    function niceStep(range, targetCount) {
        const rough = Math.abs(range) / Math.max(1, targetCount);
        const power = Math.pow(10, Math.floor(Math.log10(Math.max(rough, 1e-9))));
        for (const mult of [1, 2, 5, 10]) {
            if (power * mult >= rough) return power * mult;
        }
        return power * 10;
    }

    // Elevation domain over every series (terrain, track, pvis), padded so
    // lines never hug the plot edge; a near-flat profile still gets a sane
    // vertical span instead of magnifying 20 cm of noise into mountains.
    function elevDomain(seriesArrays, { padFraction = 0.12, minSpanM = 12 } = {}) {
        let min = Infinity, max = -Infinity;
        for (const series of seriesArrays || []) {
            for (const value of series || []) {
                const elev = Number(value);
                if (!Number.isFinite(elev)) continue;
                if (elev < min) min = elev;
                if (elev > max) max = elev;
            }
        }
        if (!(min <= max)) { min = 0; max = 1; }
        let span = max - min;
        if (span < minSpanM) {
            const center = (min + max) / 2;
            min = center - minSpanM / 2;
            max = center + minSpanM / 2;
            span = minSpanM;
        }
        return { elevMin: min - span * padFraction, elevMax: max + span * padFraction };
    }

    // Generous side insets: the first/last PVI handles sit exactly at the plot
    // edges and need empty canvas around them to be draggable.
    const PAD = { left: 52, right: 26, top: 6, bottom: 18 };

    // viewDM0/viewDM1 are the VISIBLE chainage window (zoom/pan); they default
    // to the whole route. toX/fromXtoDM map that window across the plot width.
    // flip reverses the x-axis so the strip always reads left→right in the map's
    // sense (west/north on the left) regardless of which end was drawn first;
    // chainage (dM, measured from node 0) is unchanged, so callers, cursor and
    // node-drag mapping need no changes — only the axis labels count from the
    // left edge, and dispDM() converts a chainage to that left-based distance.
    function buildLayout({ widthPx, heightPx, lengthM, elevMin, elevMax, viewDM0, viewDM1, flip = false }) {
        const plot = {
            x0: PAD.left,
            y0: PAD.top,
            w: Math.max(1, widthPx - PAD.left - PAD.right),
            h: Math.max(1, heightPx - PAD.top - PAD.bottom),
        };
        const safeLength = Math.max(1e-6, Number(lengthM) || 0);
        const d0 = Number.isFinite(viewDM0) ? Math.max(0, viewDM0) : 0;
        const d1 = Number.isFinite(viewDM1) ? Math.min(safeLength, viewDM1) : safeLength;
        const viewSpan = Math.max(1e-6, d1 - d0);
        const elevSpan = Math.max(1e-6, elevMax - elevMin);
        const toX = flip
            ? (dM) => plot.x0 + (1 - (dM - d0) / viewSpan) * plot.w
            : (dM) => plot.x0 + ((dM - d0) / viewSpan) * plot.w;
        const toY = (elev) => plot.y0 + (1 - (elev - elevMin) / elevSpan) * plot.h;
        const fromYtoElev = (y) => elevMin + (1 - (y - plot.y0) / plot.h) * elevSpan;
        const fromXtoDM = flip
            ? (x) => d0 + (1 - (x - plot.x0) / plot.w) * viewSpan
            : (x) => d0 + ((x - plot.x0) / plot.w) * viewSpan;
        // Distance from the LEFT edge (what the axis labels and the cursor read),
        // so the ticks always count up rightward from 0 even when flipped.
        const dispDM = flip ? (dM) => safeLength - dM : (dM) => dM;

        const xStep = niceStep(viewSpan, 6);
        const xTicks = [];
        const leftDisp = flip ? safeLength - d1 : d0;
        const rightDisp = flip ? safeLength - d0 : d1;
        for (let disp = Math.ceil(leftDisp / xStep) * xStep; disp <= rightDisp + 1e-6; disp += xStep) {
            const dM = flip ? safeLength - disp : disp;
            xTicks.push({
                dM,
                x: toX(dM),
                label: viewSpan >= 2000 ? `${(disp / 1000).toFixed(disp % 1000 === 0 ? 0 : 1)} km` : `${Math.round(disp)} m`,
            });
        }
        const yStep = niceStep(elevSpan, 4);
        const yTicks = [];
        for (let elev = Math.ceil(elevMin / yStep) * yStep; elev <= elevMax + 1e-6; elev += yStep) {
            yTicks.push({ elev, y: toY(elev), label: `${Math.round(elev)}` });
        }
        return { plot, lengthM: safeLength, viewDM0: d0, viewDM1: d1, elevMin, elevMax, toX, toY, fromYtoElev, fromXtoDM, dispDM, flip, xTicks, yTicks };
    }

    // The stored profile keeps elevAslM[] without chainages: sample i sits at
    // i*stepM, except the final sample which the endpoint clamps to the exact
    // route length.
    function stepChainages(profile, lengthM) {
        const count = (profile.elevAslM || []).length;
        const out = new Array(count);
        for (let i = 0; i < count; i++) out[i] = Math.min(i * profile.stepM, lengthM);
        return out;
    }

    // Solved track elevation at an arbitrary chainage (linear between the
    // stored per-step samples; the last step is the route's partial remainder).
    // Used to ride the location cursor's dot along the track line.
    function elevAtChainageOnProfile(profile, dM, lengthM) {
        const elevs = (profile && profile.elevAslM) || [];
        const count = elevs.length;
        if (count === 0) return NaN;
        const len = Number(lengthM) || (count - 1) * profile.stepM;
        const clamped = Math.max(0, Math.min(Number(dM), len));
        const lastFull = (count - 2) * profile.stepM;
        if (clamped >= lastFull) {
            const span = Math.max(1e-9, len - lastFull);
            const t = Math.min(1, (clamped - lastFull) / span);
            return elevs[count - 2] + (elevs[count - 1] - elevs[count - 2]) * t;
        }
        const index = Math.floor(clamped / profile.stepM);
        const t = (clamped - index * profile.stepM) / profile.stepM;
        return elevs[index] + (elevs[index + 1] - elevs[index]) * t;
    }

    // Signed grade of the canonical PVI segment containing a chainage. Using
    // PVIs rather than adjacent display samples keeps the value stable while
    // the pointer moves along one straight designed segment.
    function gradeAtChainageOnProfile(profile, dM) {
        const pvis = (profile?.pvis || [])
            .filter((p) => Number.isFinite(Number(p?.dM)) && Number.isFinite(Number(p?.elevAslM)))
            .slice()
            .sort((a, b) => Number(a.dM) - Number(b.dM));
        if (pvis.length < 2 || !Number.isFinite(Number(dM))) return NaN;
        const target = Number(dM);
        let after = 1;
        while (after < pvis.length - 1 && target > Number(pvis[after].dM)) after++;
        const a = pvis[after - 1];
        const b = pvis[after];
        const runM = Number(b.dM) - Number(a.dM);
        return runM > 1e-9 ? (Number(b.elevAslM) - Number(a.elevAslM)) / runM * 100 : 0;
    }

    // Null coverage splits a [{dM, elevAslM}] series into drawable pixel
    // segments (no line across sea / unimported tiles).
    function toPixelSegments(points, layout) {
        const segments = [];
        let current = null;
        for (const point of points || []) {
            const elev = point && point.elevAslM;
            if (elev == null || !Number.isFinite(Number(elev))) { current = null; continue; }
            if (!current) { current = []; segments.push(current); }
            current.push([layout.toX(Number(point.dM)), layout.toY(Number(elev))]);
        }
        return segments;
    }

    // Fill null DGU coverage by linear interpolation between known neighbours
    // (leading/trailing gaps clamp to the nearest known value) — the same bridge
    // the grade solver's sanitizeTerrain applies. Without it the strip breaks the
    // terrain silhouette over a gap while the regime bands there are still drawn
    // from the bridged terrain the solver used, so the two disagreed. Only the
    // terrain series is bridged; model/photo-ground coverage is genuinely partial.
    function bridgeTerrainNulls(points) {
        // Number(null) is 0, so null coverage must be caught BEFORE coercion.
        const isKnown = (v) => v != null && Number.isFinite(Number(v));
        const pts = (points || []).map((p) => ({
            dM: Number(p && p.dM),
            elevAslM: p && p.elevAslM != null ? Number(p.elevAslM) : null,
        }));
        const known = [];
        for (let i = 0; i < pts.length; i++) if (isKnown(pts[i].elevAslM)) known.push(i);
        if (known.length === 0) return pts;
        for (let i = 0; i < pts.length; i++) {
            if (isKnown(pts[i].elevAslM)) continue;
            const next = known.find((k) => k > i);
            const prev = [...known].reverse().find((k) => k < i);
            if (prev == null) pts[i].elevAslM = pts[known[0]].elevAslM;
            else if (next == null) pts[i].elevAslM = pts[known[known.length - 1]].elevAslM;
            else {
                const a = pts[prev], b = pts[next];
                const t = (pts[i].dM - a.dM) / Math.max(1e-9, b.dM - a.dM);
                pts[i].elevAslM = a.elevAslM + (b.elevAslM - a.elevAslM) * t;
            }
        }
        return pts;
    }

    function selectDisplayPviHandles(handles, layout, minSpacingPx = PVI_HANDLE_MIN_SPACING_PX) {
        const source = Array.isArray(handles) ? handles : [];
        if (source.length <= 2 || !layout?.plot) return source.slice();
        const spacing = Math.max(1, Number(minSpacingPx) || PVI_HANDLE_MIN_SPACING_PX);
        const left = Number(layout.plot.x0);
        const right = left + Number(layout.plot.w);
        const selected = [source[0]];
        let bucketIndex = null;
        let bucketCandidate = null;

        const flushBucket = () => {
            if (bucketCandidate) selected.push(bucketCandidate);
            bucketCandidate = null;
        };
        for (let index = 1; index < source.length - 1; index++) {
            const handle = source[index];
            const x = Number(handle?.x);
            if (!Number.isFinite(x) || x < left || x > right) continue;
            const nextBucketIndex = Math.floor((x - left) / spacing);
            if (bucketIndex !== nextBucketIndex) {
                flushBucket();
                bucketIndex = nextBucketIndex;
            }
            const bucketCentre = left + (nextBucketIndex + 0.5) * spacing;
            const candidateIsBetter = !bucketCandidate
                || (!!handle.locked && !bucketCandidate.locked)
                || (!!handle.locked === !!bucketCandidate.locked
                    && Math.abs(x - bucketCentre) < Math.abs(bucketCandidate.x - bucketCentre));
            if (candidateIsBetter) bucketCandidate = handle;
        }
        flushBucket();
        selected.push(source[source.length - 1]);
        return selected;
    }

    // Where the line is TRYING to be in tunnel: the tunnel regime itself, plus
    // any other run fully enclosed by it. That enclosed case is the one worth
    // drawing — a dip in cover reclassifies a stretch as at-grade, so the very
    // place the roof fails to bury itself is the place the regime band stops
    // calling it a tunnel, and gating on the band alone would hide it.
    function tunnelIntentMask(regimes, staysUnderground = null) {
        const isTunnel = (regimes || []).map((r) => r === 'tunnel');
        const mask = isTunnel.slice();
        // Enclosure alone is not intent. Two tunnels with two kilometres of open
        // line between them enclose that line, and filling it paints the whole
        // surface section red. What separates a dip from an interlude is whether
        // the rail ever comes up: a dip stays under the ground the entire way.
        const encloses = (from, to) => {
            if (from <= 0 || to >= isTunnel.length) return false;
            if (!staysUnderground) return true;
            for (let k = from; k < to; k += 1) if (!staysUnderground[k]) return false;
            return true;
        };
        let i = 0;
        while (i < isTunnel.length) {
            if (isTunnel[i]) { i += 1; continue; }
            let j = i;
            while (j < isTunnel.length && !isTunnel[j]) j += 1;
            // Judged on the ORIGINAL flags, so a run filled in here cannot go on
            // to enclose the next one.
            if (encloses(i, j)) for (let k = i; k < j; k += 1) mask[k] = true;
            i = j;
        }
        return mask;
    }

    // The tunnel roof: the crown of the tube, 7.3 m above rail, wherever the
    // ground actually covers it.
    //
    // Where it would stand above the ground there IS no roof — the stretch is
    // built as an open cut, which is a perfectly ordinary outcome and not a
    // fault. So the line simply stops. An earlier version painted those spans
    // red; red is the planner's violation colour and it read as an error over
    // something legal.
    //
    // Restricted to tunnel intent rather than "anywhere the rail is below the
    // ground", which on a real route is most of it — every shallow cutting and
    // every at-grade metre where the terrain sample sits a few centimetres high
    // would have drawn a roof, 5.1 km of it on Sibenik 141.
    function buildTunnelRoof(profile, chainages, layout) {
        const rail = profile?.elevAslM || [];
        const terrain = profile?.terrainAslM || null;
        const railSeries = profile?.elevAslM || [];
        const terrainSeries = profile?.terrainAslM || [];
        // Both heights via finiteOrNull, NOT Number.isFinite(Number(x)): that
        // guard accepts null, Number(null) is 0, and a missing rail height would
        // read as sea level — below almost any terrain, so an unmeasured sample
        // would quietly certify a stretch as "never surfaces".
        const staysUnderground = railSeries.map((railAsl, i) => {
            const railM = finiteOrNull(railAsl);
            const groundM = finiteOrNull(terrainSeries[i]);
            return railM !== null && groundM !== null && railM < groundM;
        });
        const intent = tunnelIntentMask(
            profile?.displayRegimes || profile?.regimes || [],
            staysUnderground,
        );
        const lines = [];
        if (!Array.isArray(terrain) || terrain.length !== rail.length) {
            return { lines, present: false };
        }
        let current = null;
        for (let i = 0; i < rail.length && i < chainages.length; i++) {
            // An unmeasured height is not a height: it can neither bury a roof
            // nor expose one, so the line simply stops.
            const railAsl = finiteOrNull(rail[i]);
            const groundAsl = finiteOrNull(terrain[i]);
            const dM = finiteOrNull(chainages[i]);
            if (!intent[i] || railAsl === null || groundAsl === null || dM === null
                || railAsl >= groundAsl) {
                current = null;
                continue;
            }
            const roofAsl = railAsl + TUNNEL_TUBE_HEIGHT_M;
            if (roofAsl > groundAsl) { current = null; continue; }
            const point = [layout.toX(dM), layout.toY(roofAsl)];
            if (!current) { current = [point]; lines.push(current); }
            else current.push(point);
        }
        return { lines, present: lines.length > 0 };
    }

    function buildScene(profile, terrainPoints, layout, modelTrackPoints, photoGroundPoints) {
        const chainages = stepChainages(profile, layout.lengthM);

        const terrainSegments = toPixelSegments(bridgeTerrainNulls(terrainPoints), layout);
        // The model-world track drapes the terrain (terrain + level×10) — a
        // separate series the caller supplies; drawn as a second line so the
        // grade-limited photo track can be compared against it.
        const modelTrackSegments = toPixelSegments(modelTrackPoints, layout);
        // Real Google surface captured during a photo ride (partial coverage).
        const photoGroundSegments = toPixelSegments(photoGroundPoints, layout);

        const trackPath = chainages.map((dM, i) => [layout.toX(dM), layout.toY(profile.elevAslM[i])]);

        // Contiguous same-regime runs -> bands; edges midway between samples.
        // displayRegimes (depth-classified tunel/na terenu/vijadukt, stamped by
        // the app) wins over the solver's five raw cost regimes so the band
        // tells the same story as the map decor and the ride.
        const regimeBands = [];
        let runStart = 0;
        const regimes = profile.displayRegimes || profile.regimes || [];
        for (let i = 1; i <= regimes.length; i++) {
            if (i < regimes.length && regimes[i] === regimes[runStart]) continue;
            const x0 = runStart === 0
                ? layout.toX(0)
                : layout.toX((chainages[runStart - 1] + chainages[runStart]) / 2);
            const x1 = i >= regimes.length
                ? layout.toX(layout.lengthM)
                : layout.toX((chainages[i - 1] + chainages[i]) / 2);
            regimeBands.push({ x0, x1, regime: regimes[runStart], color: REGIME_COLORS[regimes[runStart]] || '#888' });
            runStart = i;
        }

        const pviHandles = (profile.pvis || []).map((p) => ({
            x: layout.toX(p.dM),
            y: layout.toY(p.elevAslM),
            dM: p.dM,
            elevAslM: p.elevAslM,
            locked: !!p.locked,
        }));
        const displayPviHandles = selectDisplayPviHandles(pviHandles, layout);

        const violationBands = (profile.violations || [])
            .filter((v) => Number.isFinite(Number(v.dM0)) && Number.isFinite(Number(v.dM1)))
            .map((v) => ({ x0: layout.toX(Number(v.dM0)), x1: layout.toX(Number(v.dM1)), message: v.message }));
        const structureBands = (profile.structureConstraints || [])
            .filter((constraint) => typeof constraint?.dM0 === 'number'
                && Number.isFinite(constraint.dM0)
                && typeof constraint?.dM1 === 'number'
                && Number.isFinite(constraint.dM1))
            .map((constraint) => ({
                ...constraint,
                x0: layout.toX(Number(constraint.dM0)),
                x1: layout.toX(Number(constraint.dM1)),
                color: STRUCTURE_COLORS[constraint.type] || '#666',
                label: constraint.name || STRUCTURE_LABELS[constraint.type] || 'OSM objekt',
                sourceUrl: constraint.sourceUrls?.[0] || null,
            }));

        const tunnelRoof = buildTunnelRoof(profile, chainages, layout);

        return {
            tunnelRoof,
            terrainSegments,
            modelTrackSegments,
            photoGroundSegments,
            trackPath,
            regimeBands,
            pviHandles,
            displayPviHandles,
            violationBands,
            structureBands,
        };
    }

    function structureAtChainage(profile, dM) {
        const target = Number(dM);
        if (!Number.isFinite(target)) return null;
        return (profile?.structureConstraints || []).find((constraint) =>
            target >= Number(constraint?.dM0) && target <= Number(constraint?.dM1)) || null;
    }

    function hitTestStructureBand(bands, x, y, topY, heightPx = 8) {
        if (y < topY || y > topY + heightPx) return null;
        return (bands || []).find((band) =>
            x >= Math.min(band.x0, band.x1) && x <= Math.max(band.x0, band.x1)) || null;
    }

    function hitTestPviHandle(handles, x, y, radiusPx) {
        const rSq = radiusPx * radiusPx;
        let best = null, bestDistSq = Infinity;
        for (const handle of handles || []) {
            const dx = handle.x - x, dy = handle.y - y;
            const distSq = dx * dx + dy * dy;
            if (distSq <= rSq && distSq < bestDistSq) { best = handle; bestDistSq = distSq; }
        }
        return best;
    }

    // "Tunel 1.2 km · Vijadukt 0.4 km" for the selection sheet — only regimes
    // that actually occur, at-grade omitted unless it is everything. Prefers
    // the depth-classified display states when the app has stamped them.
    function regimeSummaryLabel(profile, lengthM) {
        const regimes = profile.displayRegimes || profile.regimes || [];
        if (regimes.length === 0) return '';
        const chainages = stepChainages(profile, lengthM);
        const meters = {};
        for (let i = 0; i < regimes.length - 1; i++) {
            meters[regimes[i]] = (meters[regimes[i]] || 0) + (chainages[i + 1] - chainages[i]);
        }
        const parts = [];
        for (const regime of ['tunnel', 'cut', 'fill', 'viaduct']) {
            if ((meters[regime] || 0) >= 50) {
                parts.push(`${REGIME_LABELS[regime]} ${(meters[regime] / 1000).toFixed(1)} km`);
            }
        }
        return parts.length > 0 ? parts.join(' · ') : REGIME_LABELS['at-grade'];
    }

    return {
        REGIME_COLORS,
        REGIME_LABELS,
        STRUCTURE_COLORS,
        STRUCTURE_LABELS,
        TUNNEL_TUBE_HEIGHT_M,
        buildTunnelRoof,
        tunnelIntentMask,
        niceStep,
        elevDomain,
        buildLayout,
        buildScene,
        stepChainages,
        elevAtChainageOnProfile,
        gradeAtChainageOnProfile,
        hitTestPviHandle,
        structureAtChainage,
        hitTestStructureBand,
        selectDisplayPviHandles,
        regimeSummaryLabel,
    };
}));
