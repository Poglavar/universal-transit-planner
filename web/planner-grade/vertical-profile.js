// The verticalProfile data model (project format v10): pure build/parse/hash
// helpers between the grade solver's output and what a saved project carries.
// A track's verticalProfile is {datum:'asl', inputRevision, stepM, geomHash,
// pvis, elevAslM, terrainAslM, terrainProvenance, regimes, violations,
// structureConstraints} — PVIs
// are the canonical, editable
// form; the per-step arrays and OSM structure audits are derived convenience for
// consumers that would otherwise re-solve.
// geomHash fingerprints geometry, gauge, solver source revision and semantic
// profile inputs (currently station chainages), so stale profiles are
// detectable and never serialized.
//
// UMD: classic scripts get window.__verticalProfile (never bare globals),
// node tests require()/import the same file. Pure — no DOM, no fetch.
(function (root, factory) {
    const api = factory(
        typeof require === 'function'
            ? require('../tunnel-cover-rule.js')
            : root.__tunnelCoverRule,
    );
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.__verticalProfile = api;
}(typeof self !== 'undefined' ? self : this, function (tunnelCoverRule) {
    'use strict';

    if (!tunnelCoverRule) throw new Error('tunnel-cover-rule.js must load before vertical-profile.js');

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

    const DATUM = 'asl';
    // This is deliberately stored on every profile as data, not only folded
    // into geomHash. A hash mismatch says "something changed"; the explicit
    // revision says which terrain/interpolation contract produced the arrays
    // and makes database audits/backfills deterministic.
    const INPUT_REVISION = 'terrain-bilinear-v5';
    const REGIMES = new Set(['tunnel', 'cut', 'at-grade', 'fill', 'viaduct']);
    const STRUCTURE_TYPES = new Set(['tunnel', 'viaduct', 'bridge', 'embankment', 'cutting']);
    const STRUCTURE_STATUSES = new Set(['satisfied', 'review', 'unknown']);

    function clamp(value, minimum, maximum) {
        return Math.max(minimum, Math.min(maximum, value));
    }

    // djb2 over rounded coordinates + gauge + the caller's terrain/solver
    // revision + profile-only constraints. 1e-6 deg / 0.1 chainage metre is
    // below the terrain resolution. The optional revision invalidates a fixed
    // source contract; station constraints invalidate the solved alignment
    // without pretending the underlying terrain geometry changed.
    function trackGeometryHash(latlngs, gauge, sourceRevision = '', profileInputs = []) {
        let hash = 5381;
        const mix = (text) => {
            for (let i = 0; i < text.length; i++) {
                hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
            }
        };
        for (const point of latlngs || []) {
            mix(`${Number(point[0]).toFixed(6)},${Number(point[1]).toFixed(6)};`);
        }
        mix(`|${gauge || ''}|${sourceRevision || ''}`);
        const constraints = (profileInputs || [])
            .map((input) => {
                const dM = Number(input?.dM);
                const halfSpanM = Number(input?.halfSpanM);
                const explicit0 = input?.dM0 == null ? NaN : Number(input.dM0);
                const explicit1 = input?.dM1 == null ? NaN : Number(input.dM1);
                const dM0 = Number.isFinite(explicit0)
                    ? explicit0
                    : dM - halfSpanM;
                const dM1 = Number.isFinite(explicit1)
                    ? explicit1
                    : dM + halfSpanM;
                return { dM, dM0: Math.min(dM0, dM1), dM1: Math.max(dM0, dM1) };
            })
            .filter((input) => Number.isFinite(input.dM)
                && Number.isFinite(input.dM0) && Number.isFinite(input.dM1))
            .sort((a, b) => a.dM - b.dM || a.dM0 - b.dM0 || a.dM1 - b.dM1);
        for (const constraint of constraints) {
            mix(`|s:${constraint.dM.toFixed(1)},${constraint.dM0.toFixed(1)},${constraint.dM1.toFixed(1)}`);
        }
        return hash.toString(36);
    }

    function normalizeStoredStructureConstraint(raw, index) {
        const type = String(raw?.type || '');
        const dM0 = Number(raw?.dM0);
        const dM1 = Number(raw?.dM1);
        if (!STRUCTURE_TYPES.has(type) || !Number.isFinite(dM0)
            || !Number.isFinite(dM1) || dM1 <= dM0) return null;
        const expectedRegime = REGIMES.has(raw?.expectedRegime)
            ? raw.expectedRegime
            : type === 'bridge' ? 'viaduct'
                : type === 'embankment' ? 'fill'
                    : type === 'cutting' ? 'cut'
                        : type;
        const status = STRUCTURE_STATUSES.has(raw?.status) ? raw.status : 'unknown';
        return {
            id: String(raw?.id || `structure-${index + 1}`),
            type,
            expectedRegime,
            dM0,
            dM1,
            direction: raw?.direction === 'upper' ? 'upper' : 'lower',
            targetOffsetM: finiteOrNull(raw?.targetOffsetM),
            portalTransitionM: finiteOrNull(raw?.portalTransitionM),
            evidence: String(raw?.evidence || 'osm-explicit'),
            confidence: String(raw?.confidence || 'medium'),
            name: raw?.name == null ? null : String(raw.name),
            osmWayIds: Array.isArray(raw?.osmWayIds) ? raw.osmWayIds.map(String) : [],
            sourceUrls: Array.isArray(raw?.sourceUrls) ? raw.sourceUrls.map(String) : [],
            sourceTag: raw?.sourceTag == null ? null : String(raw.sourceTag),
            layer: finiteOrNull(raw?.layer),
            weight: finiteOrNull(raw?.weight),
            minimumMarginM: finiteOrNull(raw?.minimumMarginM),
            minimumOffsetM: finiteOrNull(raw?.minimumOffsetM),
            maximumOffsetM: finiteOrNull(raw?.maximumOffsetM),
            sampleCount: Math.max(0, Number(raw?.sampleCount) || 0),
            status,
        };
    }

    function normalizeStoredStructureConstraints(input) {
        return (input || [])
            .map(normalizeStoredStructureConstraint)
            .filter(Boolean);
    }

    function optionalText(value, maximum = 200) {
        if (typeof value !== 'string') return null;
        const text = value.trim();
        return text ? text.slice(0, maximum) : null;
    }

    function normalizeTerrainProvenance(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const sources = Array.isArray(raw.sources) ? raw.sources.slice(0, 8).map((source) => {
            if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
            const resolutionM = finiteOrNull(source.resolutionM);
            const normalized = {
                key: optionalText(source.key),
                provider: optionalText(source.provider),
                product: optionalText(source.product),
                revision: optionalText(source.revision),
                resolutionM,
                horizontalCrs: optionalText(source.horizontalCrs),
                verticalReference: optionalText(source.verticalReference),
                surfaceType: source.surfaceType === 'terrain' || source.surfaceType === 'surface'
                    ? source.surfaceType : null,
            };
            return normalized.key ? normalized : null;
        }).filter(Boolean) : [];
        const provenance = {
            requestedSource: optionalText(raw.requestedSource),
            horizontalCrs: optionalText(raw.horizontalCrs),
            verticalReference: optionalText(raw.verticalReference || raw.datum),
            surfaceType: raw.surfaceType === 'terrain' || raw.surfaceType === 'surface'
                ? raw.surfaceType : null,
            unit: optionalText(raw.unit, 20),
            revision: optionalText(raw.revision),
            quality: optionalText(raw.quality),
            sources,
        };
        return provenance.requestedSource || provenance.verticalReference
            || provenance.revision || sources.length ? provenance : null;
    }

    // Solver output ({steps, pvis, violations}) -> the stored shape.
    function buildVerticalProfile(solved, {
        stepM,
        geomHash,
        inputRevision = INPUT_REVISION,
        terrainProvenance = null,
    }) {
        const provenance = normalizeTerrainProvenance(terrainProvenance);
        return {
            datum: DATUM,
            inputRevision: String(inputRevision),
            stepM: Number(stepM),
            geomHash: String(geomHash),
            pvis: solved.pvis.map((p) => ({ dM: p.dM, elevAslM: p.elevAslM, locked: !!p.locked })),
            elevAslM: solved.steps.map((s) => s.elevAslM),
            // The terrain the solver classified each regime against (denoised
            // DTM). Persisting it lets a consumer take a clearance that ALWAYS
            // agrees in sign with `regimes` — the advisory road-crossing check
            // needs exactly this, instead of re-sampling fetched terrain that
            // can be stale/null/registered differently.
            terrainAslM: solved.steps.map((s) => (
                finiteOrNull(s.terrainAslM)
            )),
            ...(provenance ? { terrainProvenance: provenance } : {}),
            regimes: solved.steps.map((s) => s.regime),
            violations: (solved.violations || []).map((v) => ({
                type: v.type, dM0: v.dM0, dM1: v.dM1, message: v.message,
            })),
            structureConstraints: normalizeStoredStructureConstraints(
                solved.structureConstraints,
            ),
        };
    }

    // Saved data is untrusted (hand-edited projects, older buggy saves): parse
    // returns a normalized profile or null — a track without a profile is a
    // valid state (recomputed lazily), a track with a malformed one is not.
    function parseVerticalProfile(raw) {
        if (!raw || typeof raw !== 'object') return null;
        if (raw.datum !== DATUM) return null;
        const stepM = Number(raw.stepM);
        if (!Number.isFinite(stepM) || stepM <= 0) return null;
        if (typeof raw.geomHash !== 'string' || raw.geomHash.length === 0) return null;
        if (!Array.isArray(raw.pvis) || raw.pvis.length < 2) return null;
        const pvis = [];
        for (const p of raw.pvis) {
            const dM = Number(p && p.dM);
            const elevAslM = Number(p && p.elevAslM);
            if (!Number.isFinite(dM) || !Number.isFinite(elevAslM)) return null;
            pvis.push({ dM, elevAslM, locked: !!p.locked });
        }
        if (!Array.isArray(raw.elevAslM) || !Array.isArray(raw.regimes)
            || raw.elevAslM.length !== raw.regimes.length || raw.elevAslM.length < 2) return null;
        const elevAslM = [];
        for (const value of raw.elevAslM) {
            const elev = Number(value);
            if (!Number.isFinite(elev)) return null;
            elevAslM.push(elev);
        }
        for (const regime of raw.regimes) {
            if (!REGIMES.has(regime)) return null;
        }
        // Optional (added after v10's first saves): the solver terrain per step.
        // Only trusted when it lines up 1:1 with elevAslM; older saves lack it,
        // and the road-crossing check falls back to fetched terrain there.
        let terrainAslM = null;
        if (Array.isArray(raw.terrainAslM) && raw.terrainAslM.length === elevAslM.length) {
            terrainAslM = raw.terrainAslM.map(finiteOrNull);
        }
        return {
            datum: DATUM,
            // Missing stays missing. Treating an old save as current here would
            // make the exact migration cohort unknowable and let nearest-cell
            // terrain masquerade as bilinear terrain.
            inputRevision: typeof raw.inputRevision === 'string'
                && raw.inputRevision.length > 0 ? raw.inputRevision : null,
            stepM,
            geomHash: raw.geomHash,
            pvis,
            elevAslM,
            terrainAslM,
            terrainProvenance: normalizeTerrainProvenance(raw.terrainProvenance),
            regimes: raw.regimes.slice(),
            violations: Array.isArray(raw.violations)
                ? raw.violations
                    .filter((v) => v && typeof v.message === 'string')
                    .map((v) => ({ type: String(v.type), dM0: Number(v.dM0), dM1: Number(v.dM1), message: v.message }))
                : [],
            structureConstraints: normalizeStoredStructureConstraints(
                raw.structureConstraints,
            ),
        };
    }

    // Reconstruct the runtime-only terrain cache from the terrain samples that
    // are already persisted beside a current solved profile. The final sample
    // sits at the exact route end (which may be a partial step), matching the
    // terrain API contract and every chainage sampler in this module.
    function runtimeTerrainProfileFromSavedProfile(profile, {
        geomHash,
        source,
        inputRevision = INPUT_REVISION,
    } = {}) {
        if (!profile || profile.inputRevision !== inputRevision) return null;
        if (typeof geomHash !== 'string' || profile.geomHash == null) return null;
        const stepM = Number(profile.stepM);
        const terrain = profile.terrainAslM;
        const elevations = profile.elevAslM;
        const pvis = profile.pvis;
        if (!(stepM > 0) || !Array.isArray(terrain) || !Array.isArray(elevations)
            || terrain.length !== elevations.length || terrain.length < 2
            || !Array.isArray(pvis) || pvis.length < 2) return null;
        const lengthM = Number(pvis[pvis.length - 1]?.dM);
        if (!(lengthM > 0)) return null;
        const points = terrain.map((value, index) => ({
            dM: index === terrain.length - 1
                ? lengthM
                : Math.min(lengthM, index * stepM),
            elevAslM: finiteOrNull(value),
            source: source == null ? undefined : String(source),
        }));
        return {
            geomHash,
            source: source == null ? undefined : String(source),
            stepM,
            points,
            provenance: normalizeTerrainProvenance(profile.terrainProvenance),
        };
    }

    // Chainage (metres from the track start) of every latlng vertex — the
    // SAME haversine the planner uses for lengths, so profile dM and vertex
    // chainage agree to well under the DEM resolution.
    const EARTH_RADIUS_M = 6371000;
    function vertexChainagesMeters(latlngs) {
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

    function normalizedLatLng(value) {
        const lat = Number(Array.isArray(value) ? value[0] : value?.lat);
        const lng = Number(Array.isArray(value) ? value[1] : value?.lng);
        return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    }

    function metricPolyline(latlngs, origin) {
        const cosLat = Math.cos(origin.lat * Math.PI / 180);
        const points = (latlngs || [])
            .map(normalizedLatLng)
            .filter(Boolean)
            .map((point) => ({
                x: (point.lng - origin.lng) * Math.PI / 180 * EARTH_RADIUS_M * cosLat,
                y: (point.lat - origin.lat) * Math.PI / 180 * EARTH_RADIUS_M,
            }));
        const chainages = [0];
        for (let i = 1; i < points.length; i++) {
            chainages.push(chainages[i - 1] + Math.hypot(
                points[i].x - points[i - 1].x,
                points[i].y - points[i - 1].y,
            ));
        }
        return { points, chainages, lengthM: chainages[chainages.length - 1] || 0 };
    }

    function projectMetricPoint(polyline, point) {
        let nearest = null;
        for (let i = 0; i < polyline.points.length - 1; i++) {
            const from = polyline.points[i], to = polyline.points[i + 1];
            const dx = to.x - from.x, dy = to.y - from.y;
            const lengthSq = dx * dx + dy * dy;
            if (lengthSq < 1e-9) continue;
            const t = clamp(((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSq, 0, 1);
            const x = from.x + dx * t, y = from.y + dy * t;
            const distanceSq = (point.x - x) ** 2 + (point.y - y) ** 2;
            if (nearest && distanceSq >= nearest.distanceSq) continue;
            nearest = {
                segmentIndex: i,
                t,
                distanceSq,
                chainageM: polyline.chainages[i]
                    + (polyline.chainages[i + 1] - polyline.chainages[i]) * t,
            };
        }
        return nearest;
    }

    function sampleMetricPolyline(polyline, requestedChainageM) {
        const dM = clamp(Number(requestedChainageM), 0, polyline.lengthM);
        let segmentIndex = polyline.points.length - 2;
        for (let i = 0; i < polyline.chainages.length - 1; i++) {
            if (dM <= polyline.chainages[i + 1]) { segmentIndex = i; break; }
        }
        const fromM = polyline.chainages[segmentIndex];
        const toM = polyline.chainages[segmentIndex + 1];
        const t = toM > fromM ? (dM - fromM) / (toM - fromM) : 0;
        const from = polyline.points[segmentIndex], to = polyline.points[segmentIndex + 1];
        return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    }

    // A station is rendered on the rounded motion route, while its elevation
    // profile is parameterised on the editable control polyline. Project the
    // station to the rendered route, sample its complete rigid footprint there,
    // then map every sample back to authored-profile chainage. At a tight corner
    // this envelope is wider and asymmetric compared with a naive raw ±length.
    function stationProfileSpanFromRenderedRoute(
        rawLatLngs,
        renderedLatLngs,
        stationLatLng,
        halfSpanM = 30,
        sampleStepM = 2,
    ) {
        const origin = normalizedLatLng(stationLatLng);
        const halfSpan = Number(halfSpanM);
        const sampleStep = Number(sampleStepM);
        if (!origin || !Number.isFinite(halfSpan) || halfSpan <= 0
            || !Number.isFinite(sampleStep) || sampleStep <= 0) return null;
        const raw = metricPolyline(rawLatLngs, origin);
        const rendered = metricPolyline(renderedLatLngs, origin);
        if (raw.points.length < 2 || rendered.points.length < 2
            || raw.lengthM <= 0 || rendered.lengthM <= 0) return null;
        const renderedCenter = projectMetricPoint(rendered, { x: 0, y: 0 });
        if (!renderedCenter) return null;
        // Elevation INTENT belongs to the authored station point. Mapping the
        // rounded centre back by nearest distance is ambiguous at a fillet
        // (equally near legs can produce dM 85 or 115 depending on iteration).
        // The original station projected to the control line is stable under
        // route reversal; rendered samples below are used only for coverage.
        const rawCenterProjection = projectMetricPoint(raw, { x: 0, y: 0 });
        if (!rawCenterProjection) return null;
        const rawVertexChainages = vertexChainagesMeters(rawLatLngs);
        const rawCenterFromM = rawVertexChainages[rawCenterProjection.segmentIndex];
        const rawCenterToM = rawVertexChainages[rawCenterProjection.segmentIndex + 1];
        const dM = rawCenterFromM
            + (rawCenterToM - rawCenterFromM) * rawCenterProjection.t;
        const renderedFromM = Math.max(0, renderedCenter.chainageM - halfSpan);
        const renderedToM = Math.min(rendered.lengthM, renderedCenter.chainageM + halfSpan);
        const sampleCount = Math.max(1, Math.ceil((renderedToM - renderedFromM) / sampleStep));
        const mappedChainages = [];
        for (let sample = 0; sample <= sampleCount; sample++) {
            const t = sample / sampleCount;
            const renderedPoint = sampleMetricPolyline(
                rendered,
                renderedFromM + (renderedToM - renderedFromM) * t,
            );
            const rawProjection = projectMetricPoint(raw, renderedPoint);
            if (!rawProjection) continue;
            const fromM = rawVertexChainages[rawProjection.segmentIndex];
            const toM = rawVertexChainages[rawProjection.segmentIndex + 1];
            mappedChainages.push(fromM + (toM - fromM) * rawProjection.t);
        }
        if (mappedChainages.length < 2) return null;
        const dM0 = Math.min(...mappedChainages);
        const dM1 = Math.max(...mappedChainages);
        if (!Number.isFinite(dM) || !Number.isFinite(dM0)
            || !Number.isFinite(dM1) || dM1 <= dM0 + 1e-6) return null;
        return { dM, dM0, dM1 };
    }

    // Linear interpolation of the solved elevation at an arbitrary chainage.
    // Sample i sits at i*stepM except the last, which is the exact length;
    // out-of-range chainages clamp to the ends.
    function elevAtChainage(profile, dM) {
        const elevs = profile.elevAslM;
        const count = elevs.length;
        if (count === 0) return null;
        const lengthM = profile.pvis[profile.pvis.length - 1].dM;
        const clamped = Math.max(0, Math.min(Number(dM), lengthM));
        const lastFull = (count - 2) * profile.stepM; // chainage of the second-to-last sample
        if (clamped >= lastFull) {
            const span = Math.max(1e-9, lengthM - lastFull);
            const t = (clamped - lastFull) / span;
            return elevs[count - 2] + (elevs[count - 1] - elevs[count - 2]) * Math.min(1, t);
        }
        const index = Math.floor(clamped / profile.stepM);
        const t = (clamped - index * profile.stepM) / profile.stepM;
        return elevs[index] + (elevs[index + 1] - elevs[index]) * t;
    }

    // Interpolated SOLVER terrain a.s.l. at an arbitrary chainage — the exact
    // terrain the profile was solved against (the values classifyRegimes used),
    // so a clearance taken as elevAtChainage − terrainAtChainage always agrees in
    // sign with the stored regime. Returns null when the profile carries no
    // stored terrain (older saves) so the caller can fall back to fetched
    // terrain. Same step convention as elevAtChainage: sample i sits at i*stepM,
    // the last clamped to the route length.
    function terrainAtChainage(profile, dM) {
        const terr = profile && profile.terrainAslM;
        if (!Array.isArray(terr) || terr.length === 0) return null;
        const count = terr.length;
        const lengthM = profile.pvis[profile.pvis.length - 1].dM;
        const clamped = Math.max(0, Math.min(Number(dM), lengthM));
        const at = (i) => (terr[i] == null ? null : Number(terr[i]));
        const lastFull = (count - 2) * profile.stepM;
        if (clamped >= lastFull) {
            const a = at(count - 2), b = at(count - 1);
            if (a == null || b == null) return a ?? b;
            const span = Math.max(1e-9, lengthM - lastFull);
            const t = Math.min(1, (clamped - lastFull) / span);
            return a + (b - a) * t;
        }
        const index = Math.floor(clamped / profile.stepM);
        const a = at(index), b = at(index + 1);
        if (a == null || b == null) return a ?? b;
        const t = (clamped - index * profile.stepM) / profile.stepM;
        return a + (b - a) * t;
    }

    // The stored per-step regime nearest a chainage — the SAME classification the
    // 3D world renders (rails.js). Authoritative for over/under/at-grade; road
    // clearance only refines fill/cut into over/under vs a shallow violation.
    function regimeAtChainage(profile, dM) {
        const regimes = profile && profile.regimes;
        if (!Array.isArray(regimes) || regimes.length === 0) return null;
        const lengthM = profile.pvis[profile.pvis.length - 1].dM;
        const clamped = Math.max(0, Math.min(Number(dM), lengthM));
        const index = Math.max(0, Math.min(regimes.length - 1, Math.round(clamped / profile.stepM)));
        return regimes[index];
    }

    // ONE user-facing vertical vocabulary (revised 2026-07-23): underground /
    // surface / elevated, decided by DEPTH against terrain — not by the solver's
    // five cost regimes. TUNNEL means the tube fits FULLY underground: rail
    // deep enough that the tube roof (≈7.3 m of section above rail, matching
    // PHOTO_RUNNING_TUNNEL_SECTION.roofTopOffsetM in station-3d) sits below
    // the bare earth. Anything shallower — a 4 m or 6 m city trench — is an
    // OPEN CUT and stays 'at-grade' in this vocabulary: rendered as a trench
    // by the worlds that can dig (terrain model, photo), and is priced like
    // surface under the current scenario assumptions.
    // There is deliberately NO covered-cut middle type, and both 3D worlds
    // must classify identically from this one rule.
    //
    const DISPLAY_DEPTH_THRESHOLD_M = 3.5;          // viaduct side: deck clear of ground
    const {
        TUNNEL_FULL_COVER_MIN_M,
        TUNNEL_COVER_TOLERANCE_M,
    } = tunnelCoverRule;

    // Display state at a chainage: 'tunnel' | 'at-grade' | 'viaduct'.
    // `terrainAt(dM)` is an optional runtime terrain accessor for profiles saved
    // without terrainAslM (older saves); when neither terrain source is
    // available we fall back to the raw regime, which only distinguishes the
    // solver's own tunnel/viaduct calls.
    function displayStateAtChainage(profile, dM, terrainAt) {
        const elev = elevAtChainage(profile, dM);
        let terr = terrainAtChainage(profile, dM);
        if (!Number.isFinite(terr) && typeof terrainAt === 'function') {
            const fetched = Number(terrainAt(dM));
            terr = Number.isFinite(fetched) ? fetched : null;
        }
        if (Number.isFinite(elev) && Number.isFinite(terr)) {
            const rel = elev - terr;
            if (rel <= -(TUNNEL_FULL_COVER_MIN_M - TUNNEL_COVER_TOLERANCE_M)) return 'tunnel';
            if (rel >= DISPLAY_DEPTH_THRESHOLD_M) return 'viaduct';
            return 'at-grade';
        }
        const regime = regimeAtChainage(profile, dM);
        if (regime === null) return null;
        return regime === 'tunnel' || regime === 'viaduct' ? regime : 'at-grade';
    }

    // Per-step display states, same sampling convention as profile.regimes so
    // renderers can substitute this array 1:1 (strip band, map decor, summary).
    function displayRegimes(profile, terrainAt) {
        const regimes = profile && profile.regimes;
        if (!Array.isArray(regimes) || regimes.length === 0) return null;
        const lengthM = profile.pvis[profile.pvis.length - 1].dM;
        return regimes.map((_, i) => (
            displayStateAtChainage(profile, Math.min(i * profile.stepM, lengthM), terrainAt) || 'at-grade'
        ));
    }

    // Flat-world ramp shaping for DERIVED levels: quantized levels step at a
    // single vertex boundary, but the ride and the civil works both lerp
    // between vertices — a hard −1→0 step across one short segment reads as a
    // teleport at the portal. Spread every transition across the physical
    // ramp length as fractional levels (the retired manual ±1 editor kept
    // ramps shaped the same way). Transitions are summed, so ramps that
    // overlap on a short plateau compose instead of fighting.
    // `holdSpans` are stretches whose level must stay INTEGRAL — station
    // platforms. A station is a level structure, so ramp shaping has no business
    // inside one, and letting it in did real damage: at a 170 m underground
    // platform the derived levels read −0.898, −0.217, −0.886 instead of a flat
    // −1. Everything downstream keys off those numbers, so the platform read as
    // barely below the surface — "Vidi" spawned the walker 3 m above the
    // trackbed, and underground.js's build gate (segment deeper than −5 m)
    // SKIPPED the station's own segments, so no station box was built at all.
    // The ramp belongs outside the platform, which is where a real one is.
    function shapeDerivedLevelRamps(levels, vertexChainagesM, rampLengthM, holdSpans) {
        if (!Array.isArray(levels) || !Array.isArray(vertexChainagesM)
            || levels.length !== vertexChainagesM.length || levels.length < 2) {
            return levels;
        }
        const ramp = Math.max(1, Number(rampLengthM) || 0);
        const holds = (Array.isArray(holdSpans) ? holdSpans : [])
            .map((span) => ({ dM0: Number(span?.dM0), dM1: Number(span?.dM1) }))
            .filter((span) => Number.isFinite(span.dM0) && Number.isFinite(span.dM1)
                && span.dM1 > span.dM0);
        const heldAt = (chainage) => holds.find(
            (span) => chainage >= span.dM0 - 1e-6 && chainage <= span.dM1 + 1e-6,
        ) || null;
        const steps = [];
        for (let i = 0; i < levels.length - 1; i++) {
            if (levels[i + 1] !== levels[i]) {
                steps.push({
                    atM: (Number(vertexChainagesM[i]) + Number(vertexChainagesM[i + 1])) / 2,
                    deltaLevel: levels[i + 1] - levels[i],
                });
            }
        }
        if (steps.length === 0) return levels;
        const base = levels[0];
        return vertexChainagesM.map((chainage, index) => {
            // Inside a platform: the quantised level, untouched.
            if (heldAt(Number(chainage))) return levels[index];
            let value = base;
            for (const step of steps) {
                const t = (Number(chainage) - (step.atM - ramp / 2)) / ramp;
                value += step.deltaLevel * Math.max(0, Math.min(1, t));
            }
            return Math.round(value * 1000) / 1000;
        });
    }

    // Levels are DERIVED from the solved profile (2026-07-22 decision): the
    // elevation strip is the only vertical editor, while every legacy level
    // consumer — level-based pricing, underground/elevated station structures
    // keyed on ±1, save format v11 — keeps reading `levels`, now computed from
    // the DISPLAY state above: tunnel → −1, viaduct → +1, at-grade → 0.
    function deriveLevelsFromProfile(profile, vertexChainagesM, terrainAt) {
        if (!profile || !Array.isArray(vertexChainagesM)) return null;
        const levels = [];
        for (const chainage of vertexChainagesM) {
            const state = displayStateAtChainage(profile, chainage, terrainAt);
            if (state === null) return null;
            levels.push(state === 'tunnel' ? -1 : state === 'viaduct' ? 1 : 0);
        }
        return levels;
    }

    return {
        trackGeometryHash, buildVerticalProfile, parseVerticalProfile,
        runtimeTerrainProfileFromSavedProfile,
        vertexChainagesMeters, stationProfileSpanFromRenderedRoute,
        elevAtChainage, terrainAtChainage, regimeAtChainage,
        displayStateAtChainage, displayRegimes, deriveLevelsFromProfile,
        shapeDerivedLevelRamps, DISPLAY_DEPTH_THRESHOLD_M,
        TUNNEL_FULL_COVER_MIN_M, TUNNEL_COVER_TOLERANCE_M, DATUM,
        INPUT_REVISION,
    };
}));
