// Canvas + pointer wiring for the track elevation-profile strip in the
// planner's selection sheet. All layout/scene math is pure and lives in
// profile-render.js; this file only draws the scene and turns pointer
// gestures into callbacks:
//   attach(container, state) — (re)builds the canvas inside `container`.
//   state = { profile, terrainPoints|null, lengthM,
//             onLockPvi(dM, elevAslM),   // drag committed: lock PVI there
//             onUnlockPvi(dM),           // double-click a locked handle
//             onSeekCab(dM) }            // click empty space: ride the cab there
// The selection sheet rebuilds its HTML on every render, so attach() is
// idempotent and self-contained — no state survives outside the container.
(function (root, factory) {
    root.__profileStrip = factory(
        root,
        typeof require === 'function'
            ? require('../tunnel-cover-rule.js')
            : root.__tunnelCoverRule,
    );
}(typeof self !== 'undefined' ? self : this, function (root, tunnelCoverRule) {
    'use strict';

    if (!tunnelCoverRule) throw new Error('tunnel-cover-rule.js must load before profile-strip.js');
    const {
        TUNNEL_FULL_COVER_MIN_M,
        TUNNEL_COVER_TOLERANCE_M,
    } = tunnelCoverRule;

    const HANDLE_HIT_PX = 12;
    const STRIP_HEIGHT_PX = 184;
    const CLICK_SLOP_PX = 4;   // pointer travel under this = a click, not a pan
    const NEAR_LINE_PX = 14;   // click within this of the trasa line = add a node
    // Tram-emoji cursor for the "ride the cab here" zone below the X axis.
    // The ride-entry cursor carries a direction arrow: the cab departs toward
    // INCREASING chainage, which is screen-right normally and screen-left when
    // the strip is flipped — the arrow flips with it.
    const TRAIN_CURSOR_RIGHT = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='40' height='28'><text y='23' font-size='22'>🚋</text><path d='M29 14 h6 m0 0 l-3 -3 m3 3 l-3 3' stroke='%232563eb' stroke-width='2.4' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>\") 14 20, pointer";
    const TRAIN_CURSOR_LEFT = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='40' height='28'><g transform='translate(12 0)'><text y='23' font-size='22'>🚋</text></g><path d='M11 14 h-6 m0 0 l3 -3 m-3 3 l3 3' stroke='%232563eb' stroke-width='2.4' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>\") 26 20, pointer";
    // Blue ⊕ cursor over the trasa line, where a single click inserts a node.
    const ADD_NODE_CURSOR = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'><circle cx='12' cy='12' r='9' fill='rgba(37,99,235,0.18)' stroke='%232563eb' stroke-width='2'/><path d='M12 7v10M7 12h10' stroke='%232563eb' stroke-width='2' stroke-linecap='round'/></svg>\") 12 12, copy";

    // Snap aids: reasonable track heights above/below the terrain, from real
    // clearances — a road overpass needs ~4.5 m truck clearance + ~1.5 m deck
    // ≈ 6 m; an underpass/tunnel mirrors it; a tram slips under a structure at
    // ~4.8 m. Magnetic only (snaps when the drag comes close), never rigid.
    const SNAP_CLEARANCE_M = 6;      // road over/under (default)
    // The tunnel magnet aims at the DESIGN RULE, not at a road clearance: 8 m
    // is where the tube roof (7.3 m above rail) is fully buried, which is what
    // every world classifies as a tunnel rather than an open cut. It used to
    // default to 6 m while labelling itself "tunel", so the obvious gesture —
    // drag a node, let it snap — produced a cut in the 3D worlds every time.
    const SNAP_TUNNEL_UNDER_M = TUNNEL_FULL_COVER_MIN_M;
    const SNAP_TRAM_UNDER_M = 4.8;   // tram passing beneath a bridge
    const SNAP_THRESHOLD_M = 1.0;    // snap when within this of a target
    // User-tunable clearances (the dock's ⚙ writes them; labels re-derive).
    // Typical values: viaduct rail ≈ +6 m (4.5 m road clearance + deck);
    // tunnel rail ≈ −8 m (the design rule), −9 to −10 m for heavy rail where
    // services have to run over the roof slab.
    let snapOverM = SNAP_CLEARANCE_M;
    let snapUnderM = SNAP_TUNNEL_UNDER_M;
    function setSnapClearances({ overM, underM } = {}) {
        const over = Number(overM);
        const under = Number(underM);
        if (Number.isFinite(over) && over > 0) snapOverM = over;
        if (Number.isFinite(under) && under > 0) snapUnderM = under;
    }
    function getSnapClearances() {
        return { overM: snapOverM, underM: snapUnderM };
    }
    function snapTargets(terrainAsl) {
        return [
            { elev: terrainAsl, label: 'na terenu' },
            { elev: terrainAsl + snapOverM, label: `nadvožnjak (+${snapOverM} m, kamion prolazi)` },
            { elev: terrainAsl - snapUnderM, label: `tunel (−${snapUnderM} m, natkriveno)` },
            { elev: terrainAsl - SNAP_TRAM_UNDER_M, label: `tramvaj ispod (−${SNAP_TRAM_UNDER_M} m)` },
        ];
    }
    // Snap the dragged elevation to the nearest clearance target within
    // threshold. Shift while dragging bypasses the magnet entirely — the
    // standard way to author a gentle grade through a snap height.
    function snapDragElevation(elev, terrainAsl, bypass = false) {
        if (bypass || !Number.isFinite(terrainAsl)) return { elev, snapLabel: null };
        let best = null, bestDist = SNAP_THRESHOLD_M;
        for (const t of snapTargets(terrainAsl)) {
            const d = Math.abs(elev - t.elev);
            if (d <= bestDist) { bestDist = d; best = t; }
        }
        return best ? { elev: best.elev, snapLabel: best.label } : { elev, snapLabel: null };
    }

    // Plain-language chips for the live drag feedback. The tunnel threshold is
    // the shared design rule (TUNNEL_FULL_COVER_MIN_M, with its tolerance), so
    // the chip flips to 🚇 at the same depth the 2D map recolours and both 3D
    // worlds start boring — dragging to the snap target must never say "cut".
    const REGIME_ICONS = { tunnel: '🚇', cut: '⛰️', 'at-grade': '🛤️', fill: '🧱', viaduct: '🌉' };
    const CHIP_TUNNEL_DEPTH_M = TUNNEL_FULL_COVER_MIN_M - TUNNEL_COVER_TOLERANCE_M;
    function regimeForDiff(diff) {
        if (diff <= -CHIP_TUNNEL_DEPTH_M) return 'tunnel';
        if (diff < -0.5) return 'cut';
        if (diff >= 10) return 'viaduct';
        if (diff > 0.5) return 'fill';
        return 'at-grade';
    }
    // Traffic-light colour for a grade vs the track's max incline.
    function gradeColor(gradePct, maxPct) {
        const ratio = Math.abs(gradePct) / Math.max(0.1, maxPct);
        if (ratio > 1) return '#dc2626';    // red — over the limit
        if (ratio > 0.8) return '#d97706';  // amber — near the limit
        return '#16a34a';                   // green — fine
    }
    // Terrain elevation at an arbitrary chainage (nulls = no DEM → nearest known).
    function terrainAtDM(points, dM) {
        if (!points || !points.length) return null;
        if (dM <= points[0].dM) return points[0].elevAslM;
        if (dM >= points[points.length - 1].dM) return points[points.length - 1].elevAslM;
        for (let i = 1; i < points.length; i++) {
            if (points[i].dM >= dM) {
                const a = points[i - 1], b = points[i];
                if (a.elevAslM == null || b.elevAslM == null) return a.elevAslM ?? b.elevAslM;
                const t = (dM - a.dM) / Math.max(1e-9, b.dM - a.dM);
                return a.elevAslM + (b.elevAslM - a.elevAslM) * t;
            }
        }
        return points[points.length - 1].elevAslM;
    }
    const ELECTRIFICATION_STYLES = Object.freeze({
        contact_line: '#eab308',
        rail: '#f59e0b',
    });

    // Exact authored chainage runs projected into the current zoom/flip layout.
    // Pure so the thin underlay can be verified without a canvas or browser.
    function bottomBandLayout(plot, electrificationPresent) {
        const bottomY = Number(plot.y0) + Number(plot.h);
        return {
            regimeY: bottomY - 5 - (electrificationPresent ? 2 : 0),
            regimeHeight: 5,
            electrificationY: bottomY - 2,
            electrificationHeight: 2,
        };
    }

    function buildElectrificationBands(segments, layout) {
        const viewStartM = Number(layout?.viewDM0) || 0;
        const viewEndM = Number(layout?.viewDM1 ?? layout?.lengthM);
        return (segments || []).map((segment) => {
            const color = ELECTRIFICATION_STYLES[segment?.electrified];
            const fromM = Math.max(viewStartM, Number(segment?.fromM));
            const toM = Math.min(viewEndM, Number(segment?.toM));
            if (!color || !Number.isFinite(fromM) || !Number.isFinite(toM) || !(toM > fromM)) {
                return null;
            }
            const firstX = layout.toX(fromM);
            const secondX = layout.toX(toM);
            return {
                fromM,
                toM,
                x0: Math.min(firstX, secondX),
                x1: Math.max(firstX, secondX),
                color,
                electrified: segment.electrified,
            };
        }).filter(Boolean);
    }

    function roundRect(ctx, x, y, w, h, r) {
        if (typeof ctx.roundRect === 'function') { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    // ─── Earthworks: the dirt you actually move ──────────────────────────────
    // A tunnel and a viaduct are structures — the strip already says so with the
    // regime band and the map colour. Everything between them is EARTHWORKS, and
    // the strip drew nothing for it: a 6 m open cut and a 6 m embankment looked
    // identical to track sitting on the ground, because all three are the same
    // "na terenu" state in the display vocabulary. Hatch the volume between the
    // terrain line and the track line so the excavation and the fill read as
    // what they are, at the scale they are.
    //
    // Classification is the DISPLAY state, so the hatch appears exactly where
    // the map stops calling the route a tunnel/viaduct — the two never disagree.
    const EARTHWORKS_EPS_M = 0.5;              // = atGradeEpsM in the grade solver
    const DISPLAY_TUNNEL_DEPTH_M = TUNNEL_FULL_COVER_MIN_M - TUNNEL_COVER_TOLERANCE_M;
    const DISPLAY_VIADUCT_HEIGHT_M = 3.5;      // = DISPLAY_DEPTH_THRESHOLD_M
    const EARTHWORKS_STYLE = {
        cut: { color: '#8a6d3b', hatch: 1 },    // usjek — excavated, hatch "\"
        fill: { color: '#c9a227', hatch: -1 },  // nasip — placed, hatch "/"
    };

    // Which earthworks state (if any) a sample is in. `displayState` is the
    // app-stamped tunnel/at-grade/viaduct call; the depth-rule fallback covers
    // older saves that never had one stamped.
    function earthworksKindAt(elevAslM, terrainAslM, displayState) {
        if (!Number.isFinite(elevAslM) || !Number.isFinite(terrainAslM)) return null;
        const rel = elevAslM - terrainAslM;
        const state = displayState || (
            rel <= -DISPLAY_TUNNEL_DEPTH_M ? 'tunnel'
                : rel >= DISPLAY_VIADUCT_HEIGHT_M ? 'viaduct' : 'at-grade'
        );
        if (state === 'tunnel' || state === 'viaduct') return null;   // a structure, not dirt
        if (rel < -EARTHWORKS_EPS_M) return 'cut';
        if (rel > EARTHWORKS_EPS_M) return 'fill';
        return null;
    }

    // A shallow trench crosses the at-grade epsilon repeatedly — 0.8 m, 0.4 m,
    // 0.5 m of cover over consecutive samples — and every dip under it closed
    // the run and opened a new one, so a continuous cut drew as a broken line of
    // hatch with holes in it. The digging does not stop and restart every 20 m.
    //
    // So the epsilon decides whether there is an earthwork at all, not whether a
    // run survives: a short sub-epsilon stretch is bridged when the SAME kind
    // resumes on the far side. A kind FLIP is not bridged — passing from cut to
    // fill really does go through grade, and the gap there is the truth.
    const EARTHWORKS_BRIDGE_M = 60;

    function bridgeEarthworksGaps(samples, maxGapM = EARTHWORKS_BRIDGE_M) {
        const bridged = samples.slice();
        let index = 0;
        while (index < bridged.length) {
            if (bridged[index].kind) { index += 1; continue; }
            let end = index;
            while (end < bridged.length && !bridged[end].kind) end += 1;
            const before = index > 0 ? bridged[index - 1] : null;
            const after = end < bridged.length ? bridged[end] : null;
            const spanM = before && after ? Math.abs(after.dM - before.dM) : Infinity;
            if (before && after && before.kind && before.kind === after.kind && spanM <= maxGapM) {
                for (let k = index; k < end; k++) bridged[k] = { ...bridged[k], kind: before.kind };
            }
            index = end + 1;
        }
        return bridged;
    }

    // Contiguous cut/fill runs as closed pixel polygons (track line out, terrain
    // line back). Pure — the drawing below just fills what this returns.
    function buildEarthworksBands(profile, layout, terrainAtFallback) {
        const renderApi = root.__profileRender;
        const elevs = (profile && profile.elevAslM) || [];
        if (elevs.length < 2) return [];
        const chainages = renderApi.stepChainages(profile, layout.lengthM);
        const displayStates = profile.displayRegimes || null;
        const sampleAt = (i) => {
            const dM = chainages[i];
            const elev = Number(elevs[i]);
            let terr = profile.terrainAslM ? Number(profile.terrainAslM[i]) : NaN;
            if (!Number.isFinite(terr) && typeof terrainAtFallback === 'function') {
                const fetched = Number(terrainAtFallback(dM));
                terr = Number.isFinite(fetched) ? fetched : NaN;
            }
            return { dM, elev, terr, kind: earthworksKindAt(elev, terr, displayStates ? displayStates[i] : null) };
        };
        const samples = bridgeEarthworksGaps(elevs.map((_, i) => sampleAt(i)));

        const bands = [];
        let run = null;
        // Runs close on the MIDPOINT between the last sample inside and the
        // first outside — the same convention buildScene uses for regime band
        // edges. Without it a band started at the first fully-below sample,
        // leaving a visible gap before the hatch began, and a one-sample
        // earthwork (a 20 m cut is a real 20 m of digging) produced a
        // degenerate two-point ring and vanished entirely.
        const edge = (inside, outside) => ({
            dM: (inside.dM + outside.dM) / 2,
            elev: (inside.elev + outside.elev) / 2,
            terr: (inside.terr + outside.terr) / 2,
        });
        const addPoint = (point) => {
            if (!Number.isFinite(point.elev) || !Number.isFinite(point.terr)) return;
            const x = layout.toX(point.dM);
            run.track.push([x, layout.toY(point.elev)]);
            run.terrain.push([x, layout.toY(point.terr)]);
        };
        const closeRun = (outside) => {
            if (!run) return;
            if (outside) addPoint(edge(run.lastInside, outside));
            if (run.track.length >= 2) {
                bands.push({ kind: run.kind, polygon: run.track.concat(run.terrain.reverse()) });
            }
            run = null;
        };
        for (let i = 0; i < samples.length; i++) {
            const sample = samples[i];
            if (!sample.kind) { closeRun(sample); continue; }
            if (run && run.kind !== sample.kind) closeRun(sample);
            if (!run) {
                run = { kind: sample.kind, track: [], terrain: [], lastInside: sample };
                const previous = samples[i - 1];
                if (previous && Number.isFinite(previous.elev) && Number.isFinite(previous.terr)) {
                    addPoint(edge(sample, previous));
                }
            }
            addPoint(sample);
            run.lastInside = sample;
        }
        closeRun(null);
        return bands;
    }

    // Diagonal hatch, built once per colour+direction. Cut leans one way and
    // fill the other, so a section reads at a glance even in greyscale.
    const hatchCache = new Map();
    function earthworksHatch(ctx, kind) {
        const style = EARTHWORKS_STYLE[kind];
        if (hatchCache.has(kind)) return hatchCache.get(kind);
        const SIZE = 7;
        const tile = document.createElement('canvas');
        tile.width = SIZE; tile.height = SIZE;
        const tctx = tile.getContext('2d');
        tctx.strokeStyle = style.color;
        tctx.globalAlpha = 0.55;
        tctx.lineWidth = 1;
        // Draw the stroke three times, offset by ±SIZE, so the diagonal is
        // continuous across tile seams instead of dashed.
        for (const offset of [-SIZE, 0, SIZE]) {
            tctx.beginPath();
            if (style.hatch > 0) {
                tctx.moveTo(offset, 0); tctx.lineTo(offset + SIZE, SIZE);
            } else {
                tctx.moveTo(offset, SIZE); tctx.lineTo(offset + SIZE, 0);
            }
            tctx.stroke();
        }
        const pattern = ctx.createPattern(tile, 'repeat');
        hatchCache.set(kind, pattern);
        return pattern;
    }

    // ─── Station platforms are rigid objects, not runs of grade nodes ────────
    // A station is a level building: the solver forces its [dM0, dM1] span flat
    // and the PVIs at the span edges exist ONLY to express that plateau. The
    // strip used to treat them as ordinary nodes, so dragging one end tilted the
    // platform — and two pins at different elevations inside the span make the
    // solver abandon the plateau altogether (grade-solver.js
    // stationSpansFromFirstPass), silently, with nothing on screen to say so.
    // So: one bar, two anchors, moved as one piece, and drawn red when the
    // profile through it is not actually level.
    const STATION_EDGE_EPS_M = 1e-6;
    // Mirrors UNDERGROUND_STATION_LEVEL_TOLERANCE_METERS in transit.js — the
    // same threshold the station sheet's ⚠︎ uses, so the strip and the sheet
    // never disagree about whether a platform is level.
    const STATION_LEVEL_TOLERANCE_M = 0.25;
    const STATION_BAR_COLOR = '#1d4ed8';
    const STATION_BAR_FAULT_COLOR = '#dc2626';
    const STATION_ANCHOR_HALF_PX = 5;

    function stationSpans(state) {
        return (state && state.stationMarks || []).filter((s) => (
            Number.isFinite(s.dM0) && Number.isFinite(s.dM1) && s.dM1 > s.dM0
        ));
    }

    // The station whose span contains this chainage, or null. Anything inside a
    // span belongs to the station, not to the free grade line.
    function stationSpanAt(state, dM) {
        if (!Number.isFinite(dM)) return null;
        for (const span of stationSpans(state)) {
            if (dM >= span.dM0 - STATION_EDGE_EPS_M && dM <= span.dM1 + STATION_EDGE_EPS_M) return span;
        }
        return null;
    }

    // Worst deviation from the platform's own elevation across its span. This is
    // the number the station sheet reports as "trasa mijenja visinu za N m",
    // recomputed here so the strip can show WHERE it happens instead of leaving
    // the user to hunt for it.
    function stationLevelErrorM(profile, span, lengthM) {
        const renderApi = root.__profileRender;
        const at = (dM) => renderApi.elevAtChainageOnProfile(profile, dM, lengthM);
        const base = at((span.dM0 + span.dM1) / 2);
        if (!Number.isFinite(base)) return 0;
        let worst = 0;
        const STEPS = 16;
        for (let i = 0; i <= STEPS; i++) {
            const elev = at(span.dM0 + (span.dM1 - span.dM0) * (i / STEPS));
            if (Number.isFinite(elev)) worst = Math.max(worst, Math.abs(elev - base));
        }
        return worst;
    }

    // ─── The station box ────────────────────────────────────────────────────
    // A station is not a line on the track — it is a rigid box sitting on the
    // rail, and whether its roof stands out of the ground is the single fact the
    // strip was worst at showing. It was reported as a sentence in the station's
    // sheet, so a station 1.6 m too shallow looked exactly like one that was
    // fine. Drawn as the box it is, the terrain line cuts through it and both
    // the fault and its size are legible at a glance.
    //
    // Pure metres in, metres out — no canvas, no layout — so the verdict can be
    // tested headlessly and can't disagree with what gets painted.
    function stationBoxProfile(box, railElevAslM, terrainSamplesAslM) {
        if (!box || !Number.isFinite(railElevAslM)) return null;
        const contract = root.__stationContract;
        if (!contract || typeof contract.classifyStationVerticalForm !== 'function') return null;
        const samples = Array.isArray(terrainSamplesAslM)
            ? { full: terrainSamplesAslM, compact: terrainSamplesAslM }
            : (terrainSamplesAslM || {});
        const verdict = contract.classifyStationVerticalForm({
            railElevAslM,
            terrainSamplesAslM: samples.full,
            compactTerrainSamplesAslM: samples.compact,
        });
        if (!verdict) return null;
        const selected = verdict.selected;
        const heightM = Number(selected?.heightAboveRailM);
        const requiredDepthM = Number(selected?.requiredDepthM);
        const roofAslM = Number.isFinite(heightM) ? railElevAslM + heightM : null;
        const coverAslM = Number.isFinite(requiredDepthM)
            ? railElevAslM + requiredDepthM : null;
        return {
            ...verdict,
            roofAslM,
            coverAslM,
            lengthM: Number(selected?.lengthM),
            buried: verdict.form !== contract.STATION_VERTICAL_FORM.OPEN_CUT,
            covered: verdict.form !== contract.STATION_VERTICAL_FORM.OPEN_CUT,
            // Missing lazy terrain is unknown, not physically impossible.
            valid: verdict.form === contract.STATION_VERTICAL_FORM.UNKNOWN ? null : true,
        };
    }

    // Terrain across a station's span, at the resolution the box is drawn with.
    function stationTerrainSamples(span, terrainAt, steps = 16) {
        const out = [];
        if (typeof terrainAt !== 'function') return out;
        for (let i = 0; i <= steps; i++) {
            out.push(terrainAt(span.dM0 + (span.dM1 - span.dM0) * (i / steps)));
        }
        return out;
    }

    function stationFormTerrainSamples(span, box, terrainAt) {
        const centreDM = (span.dM0 + span.dM1) * 0.5;
        const compactLengthM = Number(box?.compact?.lengthM);
        const compactSpan = Number.isFinite(compactLengthM)
            ? {
                dM0: centreDM - compactLengthM * 0.5,
                dM1: centreDM + compactLengthM * 0.5,
            }
            : span;
        return {
            full: stationTerrainSamples(span, terrainAt),
            compact: stationTerrainSamples(compactSpan, terrainAt),
        };
    }

    // Screen geometry for every station bar. Shared by drawing and hit-testing
    // so the grab target is exactly what the user sees — the whole bar, not two
    // small end dots.
    //
    // `points` is the TRACK LINE across the span, not a synthetic flat chord.
    // The platform is part of the route: the track runs up to it, the station is
    // that stretch of track, and the track carries on from its far end. Drawing
    // the bar as a level chord at the span's mid elevation made it a SECOND line
    // that peeled away from the trasa whenever the plateau was not actually flat
    // — two parallel routes on one strip, and a "peron nije ravan" that looked
    // impossible because the bar it was describing was drawn perfectly level.
    function buildStationBars(state, profile, layout, terrainAt) {
        const renderApi = root.__profileRender;
        const BAR_SAMPLE_PX = 6;
        return stationSpans(state).map((span) => {
            const elevAslM = renderApi.elevAtChainageOnProfile(
                profile, (span.dM0 + span.dM1) / 2, layout.lengthM,
            );
            if (!Number.isFinite(elevAslM)) return null;
            const xa = layout.toX(span.dM0);
            const xb = layout.toX(span.dM1);
            const levelErrorM = stationLevelErrorM(profile, span, layout.lengthM);
            const x0 = Math.min(xa, xb);
            const x1 = Math.max(xa, xb);
            // A station sitting at the route end has an anchor exactly ON the
            // plot edge, where the clip cut it into an ungrabbable half-square.
            // Keep both anchors a full square inside the plot: the platform is
            // always visible and always has two ends you can take hold of.
            const plot = layout.plot;
            const lo = plot.x0 + STATION_ANCHOR_HALF_PX;
            const hi = plot.x0 + plot.w - STATION_ANCHOR_HALF_PX;
            // Follow the track across the span, densely enough that a kink
            // inside the platform is visible rather than averaged away.
            const steps = Math.max(2, Math.ceil((x1 - x0) / BAR_SAMPLE_PX));
            const points = [];
            for (let i = 0; i <= steps; i++) {
                const dM = span.dM0 + (span.dM1 - span.dM0) * (i / steps);
                const elev = renderApi.elevAtChainageOnProfile(profile, dM, layout.lengthM);
                if (Number.isFinite(elev)) points.push([layout.toX(dM), layout.toY(elev)]);
            }
            points.sort((a, b) => a[0] - b[0]);   // flipped strips run right→left
            const endElev = (dM) => renderApi.elevAtChainageOnProfile(profile, dM, layout.lengthM);
            const yAt = (dM) => {
                const elev = endElev(dM);
                return Number.isFinite(elev) ? layout.toY(elev) : layout.toY(elevAslM);
            };
            const yLeft = yAt(x0 === layout.toX(span.dM0) ? span.dM0 : span.dM1);
            const yRight = yAt(x1 === layout.toX(span.dM1) ? span.dM1 : span.dM0);
            // Two ways a platform can be wrong, and the bar has to show both:
            // it is not level, or it does not FIT on the route (squeezed off an
            // end, its span clamped into a half-length platform). The second was
            // reported only in the station's sheet, so the strip showed a
            // perfectly ordinary blue bar for a station the app considered
            // illegal.
            const level = !(levelErrorM > STATION_LEVEL_TOLERANCE_M);
            const fits = span.fits !== false;
            // Third way a station can be wrong, and the one that had nothing on
            // screen at all: it is too shallow for its own box, so the roof
            // stands out of the ground. Measured against the platform's own
            // level elevation, because that is what the box sits on.
            const boxProfile = stationBoxProfile(
                span.box, elevAslM, stationFormTerrainSamples(span, span.box, terrainAt),
            );
            const covered = !boxProfile || boxProfile.covered;
            const validVertical = !boxProfile || boxProfile.valid !== false;
            return {
                span,
                elevAslM,
                levelErrorM,
                level,
                fits,
                box: boxProfile,
                covered,
                validVertical,
                ok: level && fits && validVertical,
                x0,
                x1,
                ax0: Math.max(lo, Math.min(hi, x0)),
                ax1: Math.max(lo, Math.min(hi, x1)),
                onPlot: x1 >= plot.x0 && x0 <= plot.x0 + plot.w,
                y: layout.toY(elevAslM),
                points,
                y0: yLeft,
                y1: yRight,
            };
        }).filter(Boolean);
    }

    // Track-line y at a screen x along the bar's polyline (clamped to its ends).
    function stationBarYAt(bar, x) {
        const points = bar && bar.points;
        if (!Array.isArray(points) || points.length === 0) return bar ? bar.y : NaN;
        if (x <= points[0][0]) return points[0][1];
        const last = points[points.length - 1];
        if (x >= last[0]) return last[1];
        for (let i = 1; i < points.length; i++) {
            if (points[i][0] < x) continue;
            const a = points[i - 1], b = points[i];
            const t = (x - a[0]) / Math.max(1e-9, b[0] - a[0]);
            return a[1] + (b[1] - a[1]) * t;
        }
        return last[1];
    }

    // A pointer on a station bar — anywhere along it, or on either drawn anchor
    // — grabs the whole platform. Tested against the bar's own polyline, so a
    // platform that is currently sloped is still grabbable along its length.
    function hitTestStationBar(bars, x, y, radiusPx) {
        for (const bar of bars || []) {
            if (bar.onPlot === false) continue;
            const lo = Math.min(bar.x0, bar.ax0) - radiusPx;
            const hi = Math.max(bar.x1, bar.ax1) + radiusPx;
            if (x < lo || x > hi) continue;
            if (Math.abs(y - stationBarYAt(bar, x)) <= radiusPx) return bar;
        }
        return null;
    }

    // The complete PVI list remains in scene.pviHandles for exact grade
    // neighbours and endpoint rules. Painting and hit-testing use only handles
    // that occupy distinct screen space, avoiding thousands of canvas circles
    // on long reconstructed routes. Zooming in reveals the finer nodes.
    function interactivePviHandles(scene) {
        return scene?.displayPviHandles || scene?.pviHandles || [];
    }

    // The × delete chip for the selected node: a small circle offset from the
    // handle (flipped to stay inside the plot), or null when nothing is
    // selected or the selection is a route endpoint (endpoints can't be
    // deleted, so they get no chip). Same geometry for drawing and hit-testing.
    const DELETE_CHIP_R = 9;
    function deleteChipFor(scene, selectedDM, plot, state) {
        if (selectedDM == null || !scene || !Array.isArray(scene.pviHandles)) return null;
        // A node inside a station span holds that station's level platform. The
        // solver re-creates it immediately, so the × was a button that appeared
        // to do nothing; the station is deleted from the map, not from here.
        if (stationSpanAt(state, selectedDM)) return null;
        const handles = scene.pviHandles;
        if (handles.length < 3) return null;   // only endpoints exist → nothing deletable
        let sel = null, minDM = Infinity, maxDM = -Infinity;
        for (const h of handles) {
            if (h.dM < minDM) minDM = h.dM;
            if (h.dM > maxDM) maxDM = h.dM;
            if (Math.abs(h.dM - selectedDM) < 1e-6) sel = h;
        }
        if (!sel) return null;
        if (Math.abs(sel.dM - minDM) < 1e-6 || Math.abs(sel.dM - maxDM) < 1e-6) return null;   // endpoint
        const r = DELETE_CHIP_R;
        let cx = sel.x + 12;
        if (plot && cx + r > plot.x0 + plot.w) cx = sel.x - 12;
        let cy = sel.y - 14;
        if (plot && cy - r < plot.y0) cy = sel.y + 14;
        return { cx, cy, r, handle: sel };
    }

    function render(canvas, state, dragGhost, cursorDM, view, series, selected) {
        const vis = series || {
            terrain: true, model: true, foto: true, google: true, structures: true,
        };
        const renderApi = root.__profileRender;
        const dpr = (root.devicePixelRatio || 1);
        const widthPx = canvas.clientWidth || 300;
        const heightPx = STRIP_HEIGHT_PX;
        canvas.width = Math.round(widthPx * dpr);
        canvas.height = Math.round(heightPx * dpr);
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, widthPx, heightPx);

        const profile = state.profile;
        const terrainElevs = (state.terrainPoints || []).map((p) => p && p.elevAslM);
        const modelElevs = (state.modelTrackPoints || []).map((p) => p && p.elevAslM);
        const photoGroundElevs = (state.photoGroundPoints || []).map((p) => p && p.elevAslM);
        const { elevMin, elevMax } = renderApi.elevDomain([
            terrainElevs,
            modelElevs,
            photoGroundElevs,
            profile.elevAslM,
            profile.pvis.map((p) => p.elevAslM),
            dragGhost ? [dragGhost.elevAslM] : [],
        ]);
        const layout = renderApi.buildLayout({
            widthPx, heightPx, lengthM: state.lengthM, elevMin, elevMax,
            viewDM0: view ? view.dM0 : undefined,
            viewDM1: view ? view.dM1 : undefined,
            flip: !!state.flip,
        });
        const scene = renderApi.buildScene(profile, state.terrainPoints, layout, state.modelTrackPoints, state.photoGroundPoints);
        const { plot } = layout;
        // A route ALWAYS has an end node the moment it has two points, it can
        // never be deleted, and it must always be grabbable — so keep the two
        // end handles fully inside the plot rather than centred on its edge,
        // where the clip would halve them. Every consumer (drawing, hit test,
        // delete chip, drag ghost) reads the same corrected x, so what you see
        // is what you can grab. Only nudged when the visible window actually
        // reaches that end — a route start scrolled far off to the left must NOT
        // get a phantom node pinned to the edge.
        if (scene.pviHandles.length >= 2) {
            const r = 6;
            const lo = plot.x0 + r;
            const hi = plot.x0 + plot.w - r;
            // Decided on CHAINAGE, not pixels: if the visible window reaches the
            // route start (or end), then the route's first (or last) node
            // belongs on that edge of the plot however far the stored kilometrage
            // and the profile's extent happen to disagree. Panned away from an
            // end, its node is genuinely off-screen and gets no phantom.
            const EPS_M = 1e-6;
            const first = scene.pviHandles[0];
            const last = scene.pviHandles[scene.pviHandles.length - 1];
            if (layout.viewDM0 <= EPS_M) {
                const edge = layout.flip ? hi : lo;
                first.x = layout.flip ? Math.min(first.x, edge) : Math.max(first.x, edge);
            }
            if (layout.viewDM1 >= layout.lengthM - EPS_M) {
                const edge = layout.flip ? lo : hi;
                last.x = layout.flip ? Math.max(last.x, edge) : Math.min(last.x, edge);
            }
        }

        ctx.font = '10px system-ui, sans-serif';

        // Grid + ticks
        ctx.strokeStyle = 'rgba(0,0,0,0.08)';
        ctx.fillStyle = '#667';
        ctx.lineWidth = 1;
        for (const tick of layout.yTicks) {
            ctx.beginPath();
            ctx.moveTo(plot.x0, tick.y);
            ctx.lineTo(plot.x0 + plot.w, tick.y);
            ctx.stroke();
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText(tick.label, plot.x0 - 4, tick.y);
        }
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (const tick of layout.xTicks) {
            ctx.fillText(tick.label, tick.x, plot.y0 + plot.h + 4);
        }

        // Clip everything data-related to the plot rect so zoomed/panned lines
        // don't bleed over the axes. Restored just before render returns.
        ctx.save();
        ctx.beginPath();
        ctx.rect(plot.x0, plot.y0, plot.w, plot.h);
        ctx.clip();

        // Grade violations: a translucent full-height red band marks the illegal
        // stretch, and a solid red bar along the TOP edge (mirror of the regime
        // band at the bottom) keeps it visible even where the terrain silhouette
        // fills most of the plot. band.x0/x1 come from toX(), which REVERSES on a
        // flipped strip (dM0<dM1 → x0>x1), so take the absolute width + a min
        // floor — otherwise a short violation on a flipped route collapsed to a
        // 1 px invisible sliver.
        for (const band of scene.violationBands) {
            const left = Math.min(band.x0, band.x1);
            const w = Math.max(4, Math.abs(band.x1 - band.x0));
            ctx.fillStyle = 'rgba(220, 60, 50, 0.20)';
            ctx.fillRect(left, plot.y0, w, plot.h);
            ctx.fillStyle = 'rgba(220, 60, 50, 0.95)';
            ctx.fillRect(left, plot.y0, w, 4);
        }

        // Explicit OSM route objects are evidence, not a duplicate of the civil
        // regime band. Keep them in a separate top rail: solid means the solved
        // profile satisfies the soft terrain envelope; dashed red asks for
        // review. Clicking a span opens its OSM way.
        const structureBandY = plot.y0 + 5;
        const structureBandHeight = 8;
        if (vis.structures !== false) {
            for (const band of scene.structureBands || []) {
                const left = Math.min(band.x0, band.x1);
                const width = Math.max(2, Math.abs(band.x1 - band.x0));
                ctx.fillStyle = `${band.color}cc`;
                ctx.fillRect(left, structureBandY, width, structureBandHeight);
                if (band.status === 'review') {
                    ctx.strokeStyle = '#dc2626';
                    ctx.lineWidth = 1.5;
                    ctx.setLineDash([3, 2]);
                    ctx.strokeRect(left, structureBandY, width, structureBandHeight);
                    ctx.setLineDash([]);
                }
                if (width >= 52) {
                    ctx.fillStyle = '#fff';
                    ctx.font = '8px system-ui, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(band.label, left + width / 2, structureBandY + structureBandHeight / 2, width - 4);
                }
            }
        }

        // Terrain (DGU): filled silhouette below the terrain line.
        const hasTerrain = scene.terrainSegments.some((seg) => seg.length >= 2);
        if (vis.terrain) {
            ctx.fillStyle = 'rgba(140, 150, 130, 0.28)';
            ctx.strokeStyle = 'rgba(100, 110, 95, 0.9)';
            for (const segment of scene.terrainSegments) {
                if (segment.length < 2) continue;
                ctx.beginPath();
                ctx.moveTo(segment[0][0], segment[0][1]);
                for (const [x, y] of segment) ctx.lineTo(x, y);
                ctx.lineTo(segment[segment.length - 1][0], plot.y0 + plot.h);
                ctx.lineTo(segment[0][0], plot.y0 + plot.h);
                ctx.closePath();
                ctx.fill();
                ctx.beginPath();
                ctx.moveTo(segment[0][0], segment[0][1]);
                for (const [x, y] of segment) ctx.lineTo(x, y);
                ctx.stroke();
            }
        }

        // Earthworks between the terrain and the track: hatched excavation where
        // the route runs in an open cut, hatched fill where it rides an
        // embankment. Skipped inside tunnels and under viaducts — those are
        // structures, and the regime band already names them. Drawn under the
        // track line so the line itself stays the crispest thing on the strip.
        // Needs both series: the hatch IS the gap between them, so with either
        // line hidden it would be a shape with no visible edge.
        if (vis.foto && vis.terrain) {
            const bands = buildEarthworksBands(
                profile, layout, (dM) => terrainAtDM(state.terrainPoints, dM),
            );
            for (const band of bands) {
                if (band.polygon.length < 4) continue;
                ctx.beginPath();
                ctx.moveTo(band.polygon[0][0], band.polygon[0][1]);
                for (const [x, y] of band.polygon) ctx.lineTo(x, y);
                ctx.closePath();
                ctx.fillStyle = earthworksHatch(ctx, band.kind);
                ctx.fill();
                // A thin edge along the cut/fill boundary keeps thin slivers
                // legible where the hatch has no room to show a full stripe.
                ctx.strokeStyle = EARTHWORKS_STYLE[band.kind].color;
                ctx.globalAlpha = 0.45;
                ctx.lineWidth = 1;
                ctx.stroke();
                ctx.globalAlpha = 1;
            }
        }

        // Road/rail crossings tucked just UNDER the terrain line, sized by
        // class. Roads are black; train/tram rails are purple. Sitting
        // on the terrain (not the track line) keeps them clear of the PVI nodes,
        // and marks where a viaduct or tunnel would carry the track over/under a
        // road.
        if (vis.terrain && Array.isArray(state.roadCrossings)) {
            for (const rc of state.roadCrossings) {
                const dM = Number(rc && rc.dM);
                if (!Number.isFinite(dM) || dM < layout.viewDM0 || dM > layout.viewDM1) continue;
                const terr = terrainAtDM(state.terrainPoints, dM);
                if (!Number.isFinite(terr)) continue;
                const r = Number(rc.r) || 2;
                ctx.fillStyle = rc.kind === 'rail'
                    ? 'rgba(126, 34, 206, 0.95)'
                    : 'rgba(17, 22, 28, 0.9)';
                ctx.beginPath();
                ctx.arc(layout.toX(dM), layout.toY(terr) + r + 1, r, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Self-crossing (spiral/loop) passes: a ring ON the track line at each
        // pass of a plan self-intersection. Rings, not dots, so the PVI handle
        // the separation pin creates stays visible inside. Colours follow the
        // level legend: green = this pass crosses OVER the other, near-black =
        // UNDER, red = unseparated (violation), grey = profile not solved yet.
        // Gated with the trasa series: rings describe the track line, and
        // floating rings over a hidden line read as phantom PVI nodes.
        if (vis.foto && Array.isArray(state.selfCrossings)) {
            const SELF_CROSSING_RING_COLORS = {
                over: 'rgba(22, 163, 74, 0.95)',
                under: 'rgba(17, 24, 39, 0.95)',
                violation: 'rgba(220, 38, 38, 0.95)',
                unknown: 'rgba(107, 114, 128, 0.9)',
            };
            for (const mark of state.selfCrossings) {
                const dM = Number(mark && mark.dM);
                const elev = Number(mark && mark.elevAslM);
                if (!Number.isFinite(dM) || !Number.isFinite(elev)) continue;
                if (dM < layout.viewDM0 || dM > layout.viewDM1) continue;
                ctx.strokeStyle = SELF_CROSSING_RING_COLORS[mark.mode]
                    || SELF_CROSSING_RING_COLORS.unknown;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(layout.toX(dM), layout.toY(elev), 5, 0, Math.PI * 2);
                ctx.stroke();
            }
        }

        // Civil regime remains the thick band. Where electrification data exists,
        // reserve the bottom two pixels for a quiet system underlay: yellow for
        // overhead contact line, amber for conductor rail.
        const electrificationPresent = (state.electrificationSegments || [])
            .some(segment => ELECTRIFICATION_STYLES[segment?.electrified]);
        const electrificationBands = buildElectrificationBands(
            state.electrificationSegments,
            layout,
        );
        const bottomBands = bottomBandLayout(plot, electrificationPresent);
        for (const band of scene.regimeBands) {
            ctx.fillStyle = band.color;
            ctx.fillRect(
                band.x0,
                bottomBands.regimeY,
                Math.max(1, band.x1 - band.x0),
                bottomBands.regimeHeight,
            );
        }
        if (vis.electrification !== false) {
            for (const band of electrificationBands) {
                ctx.fillStyle = band.color;
                ctx.fillRect(
                    band.x0,
                    bottomBands.electrificationY,
                    Math.max(1, band.x1 - band.x0),
                    bottomBands.electrificationHeight,
                );
            }
        }

        // Model-world track (drapes the terrain, grade-unlimited): dashed, under
        // the photo track so the grade-limited line reads on top.
        const hasModel = scene.modelTrackSegments.some((seg) => seg.length >= 2);
        if (hasModel && vis.model) {
            ctx.strokeStyle = 'rgba(150, 90, 30, 0.85)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([5, 4]);
            for (const seg of scene.modelTrackSegments) {
                if (seg.length < 2) continue;
                ctx.beginPath();
                ctx.moveTo(seg[0][0], seg[0][1]);
                for (const [x, y] of seg) ctx.lineTo(x, y);
                ctx.stroke();
            }
            ctx.setLineDash([]);
        }

        // Real Google surface captured during a photo ride (dotted teal): where
        // it dips below the terrain silhouette, the photo world bridges it (viaduct).
        const hasPhotoGround = scene.photoGroundSegments.some((seg) => seg.length >= 2);
        if (hasPhotoGround && vis.google) {
            ctx.strokeStyle = 'rgba(13, 148, 136, 0.9)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([2, 3]);
            for (const seg of scene.photoGroundSegments) {
                if (seg.length < 2) continue;
                ctx.beginPath();
                ctx.moveTo(seg[0][0], seg[0][1]);
                for (const [x, y] of seg) ctx.lineTo(x, y);
                ctx.stroke();
            }
            ctx.setLineDash([]);
        }

        // Tunnel roof: the crown of the tube, 7.3 m above rail, drawn where the
        // ground actually covers it. Where it would stand above the ground the
        // line stops — that stretch is an open cut, which is a normal outcome
        // and gets no marking of its own.
        const roof = scene.tunnelRoof;
        if (vis.tunnelRoof !== false && roof?.present) {
            ctx.save();
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 3]);
            ctx.strokeStyle = 'rgba(38, 38, 43, 0.85)';
            for (const line of roof.lines) {
                if (line.length < 2) continue;
                ctx.beginPath();
                ctx.moveTo(line[0][0], line[0][1]);
                for (const [x, y] of line) ctx.lineTo(x, y);
                ctx.stroke();
            }
            ctx.restore();
        }

        // Track line (photo world / authored grade)
        if (vis.foto && scene.trackPath.length >= 2) {
            ctx.strokeStyle = '#1f6fd0';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(scene.trackPath[0][0], scene.trackPath[0][1]);
            for (const [x, y] of scene.trackPath) ctx.lineTo(x, y);
            ctx.stroke();
        }

        // Legend (top-right): each row toggles its series; off rows are dimmed
        // and struck through. Hit-boxes are returned so attach() can hit-test.
        const legendHits = [];
        {
            const rows = [
                { key: 'terrain', color: 'rgba(100, 110, 95, 0.95)', dash: [], width: 2, label: state.terrainLabel || 'terrain', present: hasTerrain },
                { key: 'model', color: 'rgba(150, 90, 30, 0.9)', dash: [5, 4], width: 1.5, label: 'model', present: hasModel },
                { key: 'foto', color: '#1f6fd0', dash: [], width: 2, label: 'trasa', present: true },
                { key: 'tunnelRoof', color: 'rgba(38, 38, 43, 0.85)', dash: [4, 3], width: 1.5, label: 'krov tunela', present: !!scene.tunnelRoof?.present },
                { key: 'electrification', color: ELECTRIFICATION_STYLES.contact_line, dash: [], width: 2, label: 'elektrificirano', present: electrificationPresent },
                { key: 'google', color: 'rgba(13, 148, 136, 0.95)', dash: [2, 3], width: 1.5, label: 'Google', present: hasPhotoGround },
                { key: 'structures', color: '#6b4f9d', dash: [], width: 4, label: 'OSM objekti', present: scene.structureBands?.length > 0 },
            ].filter((r) => r.present);
            ctx.font = '10px system-ui, sans-serif';
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';
            const lw = 104;
            const lx = plot.x0 + plot.w - lw;
            // Leave the first top row to the usually-present terminal station
            // name at the right edge.
            let ly = plot.y0 + 24;
            for (const row of rows) {
                const on = vis[row.key] !== false;
                ctx.globalAlpha = on ? 1 : 0.4;
                ctx.strokeStyle = row.color; ctx.lineWidth = row.width; ctx.setLineDash(row.dash);
                ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 16, ly); ctx.stroke(); ctx.setLineDash([]);
                ctx.fillStyle = '#333'; ctx.fillText(row.label, lx + 20, ly);
                const tw = ctx.measureText(row.label).width;
                if (!on) {
                    ctx.strokeStyle = '#333'; ctx.lineWidth = 1;
                    ctx.beginPath(); ctx.moveTo(lx + 20, ly); ctx.lineTo(lx + 20 + tw, ly); ctx.stroke();
                }
                ctx.globalAlpha = 1;
                // Hit box ends at the LABEL, not the plot edge: a full-width
                // band silently swallowed clicks aimed at PVI nodes that live
                // in the top-right corner (high elevations near the route end)
                // and toggled the trasa line off instead.
                legendHits.push({ key: row.key, x0: lx - 4, y0: ly - 8, x1: lx + 20 + tw + 6, y1: ly + 8 });
                ly += 15;
            }
        }

        // Station platforms: a translucent named band over the span and — the
        // part that makes the constraint legible — the platform itself drawn as
        // ONE emphasized horizontal bar with a square anchor at each end. The
        // bar is the station: it moves as a rigid
        // piece and cannot be tilted. When the profile through the span is NOT
        // level (the solver dropped the plateau, usually because of conflicting
        // manual pins) the bar turns red and states the error in metres, so the
        // fault is visible at the place it happens instead of only in the
        // station's sheet.
        const clampX = (x) => Math.max(plot.x0, Math.min(plot.x0 + plot.w, x));
        const stationBars = vis.foto
            ? buildStationBars(state, profile, layout,
                (dM) => terrainAtDM(state.terrainPoints, dM))
            : [];
        const stationGhost = dragGhost && dragGhost.station ? dragGhost : null;
        for (const st of (state.stationMarks || [])) {
            if (!Number.isFinite(st.dM)) continue;
            const sx = layout.toX(st.dM);
            if (sx < plot.x0 - 2 || sx > plot.x0 + plot.w + 2) continue;
            // Platform-span band (min ~5 px wide so it's always visible).
            if (Number.isFinite(st.dM0) && Number.isFinite(st.dM1)) {
                let xa = clampX(layout.toX(st.dM0));
                let xb = clampX(layout.toX(st.dM1));
                if (xb < xa) { const t = xa; xa = xb; xb = t; }
                const bw = Math.max(5, xb - xa);
                ctx.fillStyle = 'rgba(37, 99, 235, 0.14)';
                ctx.fillRect(xa - (bw - (xb - xa)) / 2, plot.y0, bw, plot.h);
            }
            // The blue span already identifies the station. Put its name at the
            // top instead of repeating that information with an icon and arrow.
            ctx.fillStyle = '#1d4ed8';
            ctx.font = '10px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            const stationName = String(st.name || '').trim();
            if (stationName) ctx.fillText(stationName, sx, plot.y0 + 2, 120);
        }
        for (const bar of stationBars) {
            const dragged = stationGhost && stationGhost.station.span === bar.span;
            // A dragged bar is level by construction, so it never shows the fault
            // colour mid-gesture — that would read as "you are breaking it".
            // A drag never shows the LEVEL fault (mid-gesture the platform is
            // level by construction), but a platform that does not fit on the
            // route stays wrong however you move it up and down.
            const color = ((dragged ? bar.fits : bar.ok)) ? STATION_BAR_COLOR : STATION_BAR_FAULT_COLOR;
            // The BOX, drawn before the bar so the platform line stays on top of
            // it. Rail level up to the roof slab, the full length of the station:
            // where the terrain line crosses into it, that much of the station is
            // out of the ground, and you can read the amount off the strip.
            // Mid-drag it follows the ghost, so you can see the roof submerge as
            // you pull the station down.
            const boxProfile = dragged && bar.span.box
                ? stationBoxProfile(bar.span.box, stationGhost.elevAslM,
                    stationFormTerrainSamples(
                        bar.span,
                        bar.span.box,
                        (dM) => terrainAtDM(state.terrainPoints, dM),
                    ))
                : bar.box;
            if (boxProfile && bar.onPlot !== false) {
                const railY = layout.toY(dragged ? stationGhost.elevAslM : bar.elevAslM);
                const roofY = Number.isFinite(boxProfile.roofAslM)
                    ? layout.toY(boxProfile.roofAslM) : railY;
                const centreDM = (bar.span.dM0 + bar.span.dM1) * 0.5;
                const halfLengthM = Number.isFinite(boxProfile.lengthM)
                    ? boxProfile.lengthM * 0.5
                    : Math.abs(bar.span.dM1 - bar.span.dM0) * 0.5;
                const bx0 = Math.max(plot.x0, Math.min(
                    layout.toX(centreDM - halfLengthM),
                    layout.toX(centreDM + halfLengthM),
                ));
                const bx1 = Math.min(plot.x0 + plot.w, Math.max(
                    layout.toX(centreDM - halfLengthM),
                    layout.toX(centreDM + halfLengthM),
                ));
                if (bx1 > bx0 && Number.isFinite(boxProfile.roofAslM)) {
                    ctx.fillStyle = 'rgba(37, 99, 235, 0.12)';
                    ctx.fillRect(bx0, roofY, bx1 - bx0, railY - roofY);
                    ctx.strokeStyle = STATION_BAR_COLOR;
                    ctx.lineWidth = 1.5;
                    ctx.strokeRect(bx0, roofY, bx1 - bx0, railY - roofY);
                    if (Number.isFinite(boxProfile.coverAslM)
                        && boxProfile.coverAslM > boxProfile.roofAslM) {
                        const coverY = layout.toY(boxProfile.coverAslM);
                        ctx.setLineDash([4, 3]);
                        ctx.lineWidth = 1;
                        ctx.strokeStyle = 'rgba(37, 99, 235, 0.55)';
                        ctx.beginPath();
                        ctx.moveTo(bx0, coverY);
                        ctx.lineTo(bx1, coverY);
                        ctx.stroke();
                        ctx.setLineDash([]);
                    }
                    const compact = root.__stationContract
                        && boxProfile.form === root.__stationContract.STATION_VERTICAL_FORM.COMPACT_COVERED;
                    ctx.fillStyle = STATION_BAR_COLOR;
                    ctx.font = '9px system-ui, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'bottom';
                    ctx.fillText(
                        `${compact ? 'natkrivena' : 'podzemna'} · `
                        + `${Math.round(boxProfile.lengthM)} × ${Number(boxProfile.selected.heightAboveRailM).toFixed(2)} m`,
                        (bx0 + bx1) * 0.5,
                        roofY - 3,
                    );
                } else if (boxProfile.form === root.__stationContract?.STATION_VERTICAL_FORM.OPEN_CUT) {
                    ctx.fillStyle = STATION_BAR_COLOR;
                    ctx.font = '9px system-ui, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'bottom';
                    ctx.fillText('stanica u otvorenom usjeku', (bar.x0 + bar.x1) * 0.5, railY - 5);
                }
            }
            ctx.strokeStyle = color;
            ctx.lineWidth = 5;
            ctx.lineCap = 'butt';
            ctx.beginPath();
            if (dragged) {
                // Mid-drag the platform IS a level chord at the ghost height —
                // that is what dropping it will build.
                const gy = layout.toY(stationGhost.elevAslM);
                ctx.moveTo(bar.x0, gy);
                ctx.lineTo(bar.x1, gy);
            } else {
                // Otherwise the bar IS the track over this span. Never a second
                // line: if the platform is not level, the bar itself is what
                // slopes, which is the whole point of showing it.
                const points = bar.points.length >= 2
                    ? bar.points : [[bar.x0, bar.y], [bar.x1, bar.y]];
                ctx.moveTo(points[0][0], points[0][1]);
                for (const [px, py] of points) ctx.lineTo(px, py);
            }
            ctx.stroke();
            // ABOVE the bar: the hover readout writes its altitude/chainage
            // BELOW the track line, and the two used to overprint each other
            // into an unreadable smear at the route end. The fit fault outranks
            // the level one — a platform hanging off the end of the route is not
            // going to be fixed by levelling it.
            const boxFaultText = boxProfile && boxProfile.valid === false
                ? '⚠︎ oblik stanice nije moguće odrediti'
                : null;
            const faultText = !bar.fits
                ? (Number.isFinite(bar.span.requiredLengthM)
                    ? `⚠︎ stanica (${Math.round(bar.span.requiredLengthM)} m) ne stane na trasu`
                    : '⚠︎ stanica ne stane na trasu')
                : boxFaultText
                    || (!bar.level && !dragged
                        ? `⚠︎ peron nije ravan (${bar.levelErrorM.toFixed(1)} m)`
                        : null);
            // Only for a platform that is actually on screen: the label's x is
            // clamped into the plot, so a station scrolled out of the window
            // parked its warning against the edge with no bar under it.
            if (faultText && bar.onPlot !== false) {
                ctx.font = '10px system-ui, sans-serif';
                ctx.textAlign = 'center';
                // Clamp by the label's MEASURED half width. A fixed 70 px margin
                // was narrower than these warnings, so a station near the right
                // edge had its text cut off mid-word by the canvas.
                const halfTextPx = ctx.measureText(faultText).width / 2 + 2;
                const cxLabel = Math.max(
                    plot.x0 + halfTextPx,
                    Math.min(plot.x0 + plot.w - halfTextPx, (bar.x0 + bar.x1) / 2),
                );
                ctx.textBaseline = 'bottom';
                ctx.fillStyle = STATION_BAR_FAULT_COLOR;
                // Clear of the box, not inside it — the label used to sit 10 px
                // above the track line, which is now the box's floor.
                const labelY = boxProfile
                    ? layout.toY(Math.max(boxProfile.roofAslM, boxProfile.coverAslM)) - 6
                    : stationBarYAt(bar, cxLabel) - 10;
                ctx.fillText(faultText, cxLabel, labelY);
            }
        }
        ctx.lineCap = 'round';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';

        // PVI handles (only with the foto grade line): locked = amber, auto =
        // hollow. Nodes inside a station span are skipped — the platform's
        // square anchors already represent them, and drawing a round, draggable
        // node there would invite exactly the single-end drag that tilts the
        // station.
        for (const handle of (vis.foto ? interactivePviHandles(scene) : [])) {
            if (stationSpanAt(state, handle.dM)) continue;
            const ghosted = dragGhost && !dragGhost.station && Math.abs(dragGhost.dM - handle.dM) < 1e-6;
            const y = ghosted ? layout.toY(dragGhost.elevAslM) : handle.y;
            ctx.beginPath();
            ctx.arc(handle.x, y, handle.locked || ghosted ? 5 : 4, 0, Math.PI * 2);
            if (handle.locked || ghosted) {
                ctx.fillStyle = ghosted ? '#e67e22' : '#d9962c';
                ctx.fill();
                ctx.strokeStyle = '#8a5c12';
                ctx.lineWidth = 1;
                ctx.stroke();
            } else {
                ctx.fillStyle = '#fff';
                ctx.fill();
                ctx.strokeStyle = '#1f6fd0';
                ctx.lineWidth = 1.5;
                ctx.stroke();
            }
        }

        // Selected node: a blue highlight ring, plus a red × delete chip above
        // it (tap to remove). Route endpoints highlight but get no chip.
        if (vis.foto && selected != null) {
            const chip = deleteChipFor(scene, selected, plot, state);
            const sel = chip ? chip.handle
                : scene.pviHandles.find((h) => Math.abs(h.dM - selected) < 1e-6);
            if (sel) {
                ctx.beginPath();
                ctx.arc(sel.x, sel.y, 8, 0, Math.PI * 2);
                ctx.strokeStyle = '#2563eb';
                ctx.lineWidth = 2;
                ctx.stroke();
            }
            if (chip) {
                ctx.beginPath();
                ctx.arc(chip.cx, chip.cy, chip.r, 0, Math.PI * 2);
                ctx.fillStyle = '#dc3c32';
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 1.5;
                ctx.stroke();
                const d = chip.r * 0.42;
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 1.7;
                ctx.beginPath();
                ctx.moveTo(chip.cx - d, chip.cy - d); ctx.lineTo(chip.cx + d, chip.cy + d);
                ctx.moveTo(chip.cx + d, chip.cy - d); ctx.lineTo(chip.cx - d, chip.cy + d);
                ctx.stroke();
            }
        }

        // Location cursor: a vertical line linking the strip to the map, an
        // elevation dot on the track line, and the two readings that answer
        // "where am I and how deep is it" — altitude + chainage BELOW the dot,
        // regime icon + distance to ground ABOVE it.
        //
        // A DRAG drives the same readout, from the ghost. Previously the two
        // readings were a hover-only affordance, so the moment you took hold of
        // a node the depth-to-ground you were aiming at disappeared and only the
        // absolute altitude remained — the one number a route is NOT authored
        // against. Now the readout follows the node you are moving.
        const readoutDM = dragGhost ? dragGhost.dM : cursorDM;
        const readoutElev = dragGhost
            ? dragGhost.elevAslM
            : renderApi.elevAtChainageOnProfile(profile, cursorDM, layout.lengthM);
        let readoutSide = 'left';
        if (Number.isFinite(readoutDM) && readoutDM >= 0 && readoutDM <= layout.lengthM) {
            const cx = layout.toX(readoutDM);
            if (!dragGhost) {
                ctx.strokeStyle = 'rgba(214, 69, 33, 0.9)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(cx, plot.y0);
                ctx.lineTo(cx, plot.y0 + plot.h);
                ctx.stroke();
            }
            if (Number.isFinite(readoutElev)) {
                const ry = layout.toY(readoutElev);
                if (!dragGhost) {
                    ctx.beginPath();
                    ctx.arc(cx, ry, 3.5, 0, Math.PI * 2);
                    ctx.fillStyle = '#d64521';
                    ctx.fill();
                }
                readoutSide = cx > plot.x0 + plot.w * 0.6 ? 'right' : 'left';
                ctx.textAlign = readoutSide;
                ctx.font = '11px system-ui, sans-serif';
                const dx = readoutSide === 'right' ? -11 : 11;
                const terr = terrainAtDM(state.terrainPoints, readoutDM);
                const diffM = Number.isFinite(terr) ? readoutElev - terr : NaN;
                const regime = Number.isFinite(diffM) ? regimeForDiff(diffM) : 'at-grade';
                const gradePct = renderApi.gradeAtChainageOnProfile(profile, readoutDM);
                const structure = renderApi.structureAtChainage(profile, readoutDM);
                const signedGrade = Number.isFinite(gradePct)
                    ? `${gradePct > 0 ? '+' : gradePct < 0 ? '−' : ''}${Math.abs(gradePct).toFixed(1)}%`
                    : '—';
                const rows = [
                    {
                        text: Number.isFinite(diffM)
                            ? `${REGIME_ICONS[regime]} ${renderApi.REGIME_LABELS[regime]} · ${Math.abs(diffM).toFixed(1)} m`
                            : 'Teren —',
                        color: diffM < 0 ? '#8a4b12' : diffM > 0 ? '#0d6b6b' : '#333',
                    },
                    ...(structure ? [{
                        text: `${structure.status === 'review' ? '⚠︎ ' : ''}`
                            + `${structure.name || renderApi.STRUCTURE_LABELS[structure.type] || 'OSM objekt'}`
                            + ` · ${structure.status === 'satisfied' ? 'usklađeno'
                                : structure.status === 'review' ? 'provjeriti' : 'bez audita'}`,
                        color: structure.status === 'review' ? '#dc2626'
                            : (renderApi.STRUCTURE_COLORS[structure.type] || '#555'),
                    }] : []),
                    { text: `${Math.round(readoutElev)} m n.v.`, color: '#333' },
                    { text: `${(layout.dispDM(readoutDM) / 1000).toFixed(3)} km`, color: '#333' },
                    { text: `Nagib ${signedGrade}`, color: gradeColor(gradePct, Number(state.maxGradePct) || 4) },
                ];
                const linePx = 14;
                const stackHeight = rows.length * linePx;
                const stackY = Math.max(
                    plot.y0 + 2,
                    Math.min(plot.y0 + plot.h - stackHeight - 2, ry - stackHeight / 2),
                );
                ctx.textBaseline = 'top';
                rows.forEach((row, index) => {
                    ctx.fillStyle = row.color;
                    ctx.fillText(row.text, cx + dx, stackY + index * linePx);
                });
            }
        }

        // Live drag feedback: draw the two segments from the fixed neighbours to
        // the moving node, coloured by grade legality, plus a plain-language
        // regime chip with the elevation and steepest grade.
        if (dragGhost && vis.foto) {
            const maxPct = Number(state.maxGradePct) || 4;
            const handles = scene.pviHandles;   // sorted by dM
            // A station drag moves the whole platform, so the approach grades
            // are measured from its ENDS, not from a single node. Everything
            // between the anchors rides with the bar and is skipped.
            const ghostSpan = dragGhost.station ? dragGhost.station.span : null;
            const fromDM = ghostSpan ? ghostSpan.dM0 : dragGhost.dM;
            const toDM = ghostSpan ? ghostSpan.dM1 : dragGhost.dM;
            let prev = null, next = null;
            for (const h of handles) {
                if (h.dM < fromDM - 1e-6) prev = h;
                else if (h.dM > toDM + 1e-6 && !next) next = h;
            }
            const gy = layout.toY(dragGhost.elevAslM);
            const gxFrom = layout.toX(fromDM), gxTo = layout.toX(toDM);
            const gx = layout.toX(dragGhost.dM);
            const drawSeg = (h, anchorDM, anchorX) => {
                if (!h) return 0;
                const run = Math.abs(anchorDM - h.dM);
                const gradePct = run > 0.01 ? Math.abs(dragGhost.elevAslM - h.elevAslM) / run * 100 : 0;
                ctx.strokeStyle = gradeColor(gradePct, maxPct);
                ctx.lineWidth = 3;
                ctx.beginPath(); ctx.moveTo(h.x, h.y); ctx.lineTo(anchorX, gy); ctx.stroke();
                return gradePct;
            };
            const steepest = Math.max(
                drawSeg(prev, fromDM, gxFrom),
                drawSeg(next, toDM, gxTo),
            );
            const terr = terrainAtDM(state.terrainPoints, dragGhost.dM);
            // Snap-aid guides: faint ticks at the reasonable clearance heights;
            // the one the node has snapped to is highlighted.
            if (Number.isFinite(terr)) {
                ctx.setLineDash([3, 3]);
                ctx.lineWidth = 1;
                for (const target of snapTargets(terr)) {
                    const ty = layout.toY(target.elev);
                    if (ty < plot.y0 || ty > plot.y0 + plot.h) continue;
                    ctx.strokeStyle = dragGhost.snapLabel === target.label
                        ? 'rgba(37, 99, 235, 0.9)' : 'rgba(120, 120, 120, 0.38)';
                    ctx.beginPath(); ctx.moveTo(gx - 24, ty); ctx.lineTo(gx + 24, ty); ctx.stroke();
                }
                ctx.setLineDash([]);
            }
            const regime = Number.isFinite(terr) ? regimeForDiff(dragGhost.elevAslM - terr) : 'at-grade';
            const chipColor = gradeColor(steepest, maxPct);
            const snapSuffix = dragGhost.snapLabel ? `   ▸ ${dragGhost.snapLabel}` : '';
            // Two facts only — what you are building here, and how steep the
            // approach is. Altitude and depth-to-ground are already on the
            // readout at the node; repeating the altitude here was the third
            // copy of a number nobody was reading.
            const label = `${REGIME_ICONS[regime]} ${renderApi.REGIME_LABELS[regime]}  ·  ${steepest.toFixed(1)}%${snapSuffix}`;
            ctx.font = '11px system-ui, sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            const padX = 7, chipH = 20;
            const tw = ctx.measureText(label).width;
            // Park the chip on the side of the node the readout is NOT using,
            // and level with the node rather than above it: the readout writes
            // one line above and one below, and the chip used to land squarely
            // on the upper one.
            const chipW = tw + padX * 2;
            const CLEAR_PX = 30;   // past the readout text, not just past the node
            let bx = readoutSide === 'right' ? gx + CLEAR_PX : gx - CLEAR_PX - chipW;
            let by = gy - chipH / 2;
            if (bx + chipW > plot.x0 + plot.w) bx = gx - CLEAR_PX - chipW;
            if (bx < plot.x0) bx = Math.min(gx + CLEAR_PX, plot.x0 + plot.w - chipW);
            if (bx < plot.x0) bx = plot.x0 + 2;
            by = Math.max(plot.y0 + 2, Math.min(plot.y0 + plot.h - chipH - 2, by));
            roundRect(ctx, bx, by, tw + padX * 2, chipH, 6);
            ctx.fillStyle = 'rgba(255,255,255,0.96)'; ctx.fill();
            ctx.strokeStyle = chipColor; ctx.lineWidth = 2; ctx.stroke();
            ctx.fillStyle = '#222';
            ctx.fillText(label, bx + padX, by + chipH / 2 + 0.5);
            if (steepest > maxPct + 1e-6) {
                const warn = `prestrmo — najviše ${maxPct}%`;
                ctx.font = '10px system-ui, sans-serif';
                ctx.fillStyle = '#dc2626';
                ctx.fillText(warn, bx + padX, by + chipH + 8);
            }
        }

        ctx.restore();   // end plot clip

        // Endpoint handles sit exactly on the plot edge, so the clip above cut
        // them to half-circles — hard to see and grab. Redraw the first and
        // last handle UNCLIPPED (into the padding) as full circles. Hit-testing
        // already uses the handle centre + radius, so the fuller target is
        // immediately draggable.
        // Station anchors go here too, for the same reason: a platform at the
        // route end had its outer anchor sliced in half by the clip. Drawn at
        // the nudged positions hitTestStationBar uses, so what you see is what
        // you can grab.
        for (const bar of stationBars) {
            if (bar.onPlot === false) continue;
            const dragged = stationGhost && stationGhost.station.span === bar.span;
            const color = (dragged ? bar.fits : bar.ok) ? STATION_BAR_COLOR : STATION_BAR_FAULT_COLOR;
            const gy = dragged ? layout.toY(stationGhost.elevAslM) : null;
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = '#fff';
            ctx.fillStyle = color;
            // Anchors ride the LINE, at each end's own height. Pinning them to
            // one mid-span elevation floated them off the track exactly where a
            // sloped platform most needed them to stay attached.
            for (const [ax, ay] of [[bar.ax0, bar.y0], [bar.ax1, bar.y1]]) {
                const h = STATION_ANCHOR_HALF_PX;
                ctx.beginPath();
                ctx.rect(ax - h, (gy ?? ay) - h, h * 2, h * 2);
                ctx.fill();
                ctx.stroke();
            }
        }

        const endHandles = vis.foto ? scene.pviHandles : [];
        if (endHandles.length >= 2) {
            for (const handle of [endHandles[0], endHandles[endHandles.length - 1]]) {
                // A route endpoint is ALWAYS drawn, including inside a station
                // span. There is an end node the moment a route has two points,
                // it can never be deleted, and hiding it under a platform anchor
                // made it look like the route simply stopped having one. Its
                // circle sits on top of the square: the end of the line, on the
                // end of a station. Dragging it still moves the whole platform —
                // hitTestStationBar wins the pointer — so the platform cannot be
                // tilted from its end.
                // A metre of slack, not an exact-match epsilon: the question is
                // "is this node on that platform", which no sub-metre rounding
                // between the axis and the profile can change.
                const memberDM = Math.max(0, Math.min(layout.lengthM, handle.dM));
                const bar = stationBars.find(
                    (b) => memberDM >= b.span.dM0 - 1 && memberDM <= b.span.dM1 + 1,
                ) || null;
                const dragged = bar && stationGhost && stationGhost.station.span === bar.span;
                const ghosted = !bar && dragGhost && !dragGhost.station
                    && Math.abs(dragGhost.dM - handle.dM) < 1e-6;
                // An anchored end rides the platform: same nudged x, and the
                // track's own height at that end (not a mid-span average).
                const nearStart = bar
                    && Math.abs(handle.x - bar.x0) <= Math.abs(handle.x - bar.x1);
                const x = bar ? (nearStart ? bar.ax0 : bar.ax1) : handle.x;
                const y = dragged ? layout.toY(stationGhost.elevAslM)
                    : bar ? (nearStart ? bar.y0 : bar.y1)
                        : ghosted ? layout.toY(dragGhost.elevAslM) : handle.y;
                ctx.beginPath();
                ctx.arc(x, y, handle.locked || ghosted || bar ? 5 : 4, 0, Math.PI * 2);
                if (bar) {
                    // Hollow over the platform colour: unmistakably the route
                    // end, unmistakably part of the station.
                    ctx.fillStyle = '#fff';
                    ctx.fill();
                    ctx.strokeStyle = (dragged ? bar.fits : bar.ok)
                        ? STATION_BAR_COLOR : STATION_BAR_FAULT_COLOR;
                    ctx.lineWidth = 2;
                    ctx.stroke();
                } else if (handle.locked || ghosted) {
                    ctx.fillStyle = ghosted ? '#e67e22' : '#d9962c';
                    ctx.fill();
                    ctx.strokeStyle = '#8a5c12';
                    ctx.lineWidth = 1;
                    ctx.stroke();
                } else {
                    ctx.fillStyle = '#fff';
                    ctx.fill();
                    ctx.strokeStyle = '#1f6fd0';
                    ctx.lineWidth = 1.5;
                    ctx.stroke();
                }
            }
        }
        return { layout, scene, legendHits, stationBars };
    }

    // Legend row under (x, y), or null.
    function hitTestLegend(legendHits, x, y) {
        for (const hit of legendHits || []) {
            if (x >= hit.x0 && x <= hit.x1 && y >= hit.y0 && y <= hit.y1) return hit;
        }
        return null;
    }

    // attach(container, state) -> handle. state adds two optional hooks beyond
    // the PVI callbacks:
    //   onHoverChainage(dM | null)  fired as the pointer moves over the strip,
    //                               so the caller can mark that spot on the map.
    // The returned handle drives the reverse direction:
    //   setMapCursor(dM | null)     draw the location cursor from a map hover.
    //   destroy()                   detach observers/listeners.
    function attach(container, state) {
        if (!container || !root.__profileRender || !state || !state.profile) return null;
        container.innerHTML = '';
        const canvas = document.createElement('canvas');
        canvas.className = 'sel-profile-canvas';
        canvas.style.height = `${STRIP_HEIGHT_PX}px`;
        container.appendChild(canvas);

        let drag = null;        // PVI drag: { dM, elevAslM, startY, moved }
        let pan = null;         // pan gesture: { startX, startD0, startD1 }
        let hoverDM = null;     // pointer over the strip
        let mapCursorDM = null; // external (map hover)
        let selected = null;    // dM of the tapped node showing its × delete chip
        // Per-series visibility, toggled from the legend. Carried across a
        // re-attach (via state.initialSeries) so a node drop doesn't reset it.
        const series = Object.assign({
            terrain: true,
            model: true,
            foto: true,
            tunnelRoof: true,
            electrification: true,
            google: true,
            structures: true,
        }, state.initialSeries || {});
        // Visible chainage window (zoom/pan). Restored from state.initialView on a
        // re-attach — the route length is unchanged by an elevation edit, so the
        // window stays valid — otherwise starts at the whole route.
        const routeLenM = Math.max(1, state.lengthM);
        let viewWindow = { dM0: 0, dM1: routeLenM };
        const iv = state.initialView;
        if (iv && Number.isFinite(iv.dM0) && Number.isFinite(iv.dM1) && iv.dM1 > iv.dM0) {
            const d0 = Math.max(0, Math.min(routeLenM, iv.dM0));
            const d1 = Math.max(d0 + 1, Math.min(routeLenM, iv.dM1));
            viewWindow = { dM0: d0, dM1: d1 };
        }
        const MIN_SPAN_M = Math.max(20, state.lengthM / 500);
        let view = render(canvas, state, null, null, viewWindow, series, selected);

        const redraw = () => {
            view = render(canvas, state, drag, mapCursorDM != null ? mapCursorDM : hoverDM, viewWindow, series, selected);
        };

        // True when (x, y) is below the plot's X axis — the zone reserved for the
        // "ride the cab here" click, so it can't be confused with node dragging.
        const belowAxis = (y) => y > view.layout.plot.y0 + view.layout.plot.h;

        // True when (x, y) sits on/very near the trasa line — a single click here
        // inserts a node (mobile-friendly; no double-click). Compares the click
        // Y against the profile's elevation line at that chainage.
        const nearTrasaLine = (x, y) => {
            const dM = view.layout.fromXtoDM(x);
            if (!Number.isFinite(dM) || dM < viewWindow.dM0 - 1e-6 || dM > viewWindow.dM1 + 1e-6) return false;
            const elev = root.__profileRender.elevAtChainageOnProfile(state.profile, dM, state.lengthM);
            if (!Number.isFinite(elev)) return false;
            return Math.abs(y - view.layout.toY(elev)) <= NEAR_LINE_PX;
        };

        // Clamp + apply a new [d0, d1] window and redraw.
        function setWindow(d0, d1) {
            const L = Math.max(1, state.lengthM);
            const span = Math.max(MIN_SPAN_M, Math.min(L, d1 - d0));
            const clamped0 = Math.max(0, Math.min(L - span, d0));
            viewWindow = { dM0: clamped0, dM1: clamped0 + span };
            redraw();
        }

        const canvasPoint = (event) => {
            const rect = canvas.getBoundingClientRect();
            return { x: event.clientX - rect.left, y: event.clientY - rect.top };
        };

        canvas.addEventListener('pointerdown', (event) => {
            const { x, y } = canvasPoint(event);
            // Legend row → toggle that series, nothing else. A PVI node or a
            // station bar under the pointer wins over the legend: an editable
            // thing must never be silently converted into a visibility toggle.
            const pointerOverEditable = series.foto
                && (root.__profileRender.hitTestPviHandle(
                    interactivePviHandles(view.scene), x, y, HANDLE_HIT_PX)
                    || hitTestStationBar(view.stationBars, x, y, HANDLE_HIT_PX));
            const legendHit = pointerOverEditable
                ? null
                : hitTestLegend(view.legendHits, x, y);
            if (legendHit) {
                series[legendHit.key] = series[legendHit.key] === false;
                redraw();
                event.preventDefault();
                return;
            }
            const structureHit = series.structures !== false
                ? root.__profileRender.hitTestStructureBand(
                    view.scene.structureBands,
                    x,
                    y,
                    view.layout.plot.y0 + 5,
                    8,
                )
                : null;
            if (structureHit?.sourceUrl) {
                root.open(structureHit.sourceUrl, '_blank', 'noopener');
                event.preventDefault();
                return;
            }
            // The selected node's × delete chip takes priority over the node
            // beneath it: tapping it removes the node (the strip then rebuilds).
            if (selected != null) {
                const chip = deleteChipFor(view.scene, selected, view.layout.plot, state);
                if (chip) {
                    const dx = x - chip.cx, dy = y - chip.cy;
                    if (dx * dx + dy * dy <= (chip.r + 3) * (chip.r + 3)) {
                        const dM = selected;
                        selected = null;
                        if (typeof state.onUnlockPvi === 'function') state.onUnlockPvi(dM);
                        event.preventDefault();
                        return;
                    }
                }
            }
            // A station bar is grabbed anywhere along its length and takes
            // priority over the nodes underneath it, so the platform can only
            // ever be raised or lowered whole — never tilted from one end.
            const bar = series.foto
                ? hitTestStationBar(view.stationBars, x, y, HANDLE_HIT_PX)
                : null;
            const handle = (!bar && series.foto)
                ? root.__profileRender.hitTestPviHandle(
                    interactivePviHandles(view.scene), x, y, HANDLE_HIT_PX)
                : null;
            if (bar) {
                drag = {
                    station: bar,
                    dM: bar.span.dM ?? (bar.span.dM0 + bar.span.dM1) / 2,
                    elevAslM: bar.elevAslM,
                    startY: y,
                    moved: false,
                };
            } else if (handle) {
                drag = { dM: handle.dM, elevAslM: handle.elevAslM, startY: y, moved: false };
            } else {
                // Empty space → a DRAG pans the chainage window; a stationary
                // CLICK resolves (in pointerup) to: ride the cab (below axis),
                // add a node (on the trasa line), or focus the map (elsewhere).
                // clientX is kept so the map focus can align under the click.
                pan = {
                    startX: x, startY: y, clientX: event.clientX,
                    startD0: viewWindow.dM0, startD1: viewWindow.dM1,
                    moved: false, belowAxis: belowAxis(y),
                };
                hoverDM = null;
                if (typeof state.onHoverChainage === 'function') state.onHoverChainage(null);
            }
            canvas.setPointerCapture(event.pointerId);
            event.preventDefault();
        });
        canvas.addEventListener('pointermove', (event) => {
            const { x, y } = canvasPoint(event);
            if (drag) {
                if (Math.abs(y - drag.startY) > CLICK_SLOP_PX) drag.moved = true;
                canvas.style.cursor = 'grabbing';
                const clampedY = Math.min(view.layout.plot.y0 + view.layout.plot.h, Math.max(view.layout.plot.y0, y));
                const raw = view.layout.fromYtoElev(clampedY);
                // Magnetic snap to reasonable clearance heights (aid, not a rule).
                const terr = terrainAtDM(state.terrainPoints, drag.dM);
                const snapped = snapDragElevation(raw, terr, event.shiftKey);
                drag.elevAslM = snapped.elev;
                drag.snapLabel = snapped.snapLabel;
                // Keep the map marker on the node being dragged. Dropping the
                // hover link the moment a drag started left the map pointing at
                // wherever the pointer happened to have been.
                if (typeof state.onHoverChainage === 'function') state.onHoverChainage(drag.dM);
                redraw();
                return;
            }
            if (pan) {
                if (!pan.moved && Math.abs(x - pan.startX) < CLICK_SLOP_PX) return;   // still a potential click
                pan.moved = true;
                canvas.style.cursor = 'grabbing';
                const span = pan.startD1 - pan.startD0;
                // Grab-and-drag: content follows the pointer. The chainage axis is
                // mirrored when flipped, so the pixel→chainage sign flips with it.
                const dDM = (view.layout.flip ? 1 : -1) * ((x - pan.startX) / view.layout.plot.w) * span;
                setWindow(pan.startD0 + dDM, pan.startD1 + dDM);
                return;
            }
            // Hover affordances: legend → pointer, draggable node → grab, ride
            // zone → tram, on the trasa line → ⊕ (single click adds a node).
            // Same priority as pointerdown: an editable node/bar under the
            // pointer shows grab, not the legend's pointer.
            const hoverOverEditable = series.foto
                && (root.__profileRender.hitTestPviHandle(
                    interactivePviHandles(view.scene), x, y, HANDLE_HIT_PX)
                    || hitTestStationBar(view.stationBars, x, y, HANDLE_HIT_PX));
            const overLegend = !hoverOverEditable && !!hitTestLegend(view.legendHits, x, y);
            const overStructure = series.structures !== false
                && !!root.__profileRender.hitTestStructureBand(
                    view.scene.structureBands,
                    x,
                    y,
                    view.layout.plot.y0 + 5,
                    8,
                );
            let overChip = false;
            if (selected != null) {
                const chip = deleteChipFor(view.scene, selected, view.layout.plot, state);
                if (chip) {
                    const dx = x - chip.cx, dy = y - chip.cy;
                    overChip = dx * dx + dy * dy <= (chip.r + 3) * (chip.r + 3);
                }
            }
            const overBar = series.foto && !!hitTestStationBar(view.stationBars, x, y, HANDLE_HIT_PX);
            const overHandle = !overBar && series.foto
                && !!root.__profileRender.hitTestPviHandle(
                    interactivePviHandles(view.scene), x, y, HANDLE_HIT_PX);
            const overLine = series.foto && !overBar && !overHandle
                && !belowAxis(y) && nearTrasaLine(x, y);
            canvas.style.cursor = overChip ? 'pointer'
                : overLegend ? 'pointer'
                : overStructure ? 'pointer'
                : overBar ? 'ns-resize'
                : overHandle ? 'grab'
                : belowAxis(y) ? ((((state.rideDirection ?? 1) >= 0) !== !!view.layout.flip)
                    ? TRAIN_CURSOR_RIGHT : TRAIN_CURSOR_LEFT)
                : overLine ? ADD_NODE_CURSOR
                : 'default';
            const dM = view.layout.fromXtoDM(x);
            hoverDM = (dM >= viewWindow.dM0 && dM <= viewWindow.dM1) ? dM : null;
            if (typeof state.onHoverChainage === 'function') state.onHoverChainage(hoverDM);
            redraw();
        });
        canvas.addEventListener('pointerup', () => {
            const wasPan = pan;
            pan = null;
            canvas.style.cursor = 'default';
            if (drag) {
                const committed = drag;
                drag = null;
                if (committed.moved) {
                    if (committed.station) {
                        // A station moves as one level piece: both anchors are
                        // pinned to the SAME elevation and anything pinned
                        // between them is cleared, which is also what keeps the
                        // solver's plateau alive (two interior pins at unequal
                        // elevations make it abandon the span entirely).
                        if (typeof state.onMoveStationPlateau === 'function') {
                            state.onMoveStationPlateau(
                                committed.station.span.dM0,
                                committed.station.span.dM1,
                                Math.round(committed.elevAslM * 10) / 10,
                            );
                        }
                    } else if (typeof state.onLockPvi === 'function') {
                        // A real drag → commit the moved elevation as a lock.
                        state.onLockPvi(committed.dM, Math.round(committed.elevAslM * 10) / 10);
                    }
                    selected = null;
                } else if (committed.station) {
                    // Tapping a platform selects nothing — it has no × chip (the
                    // station is removed from the map, not from the strip).
                    selected = null;
                    redraw();
                } else {
                    // A tap on a node (no drag) → select it so its × delete chip
                    // shows; tapping the same node again deselects.
                    selected = (selected != null && Math.abs(selected - committed.dM) < 1e-6)
                        ? null : committed.dM;
                    redraw();
                }
                return;
            }
            // Any stationary click that is NOT on a node clears the selection.
            const hadSelection = selected != null;
            selected = null;
            // A stationary click (negligible travel) resolves by where it landed.
            if (!wasPan || wasPan.moved) { if (hadSelection) redraw(); return; }
            const dMraw = view.layout.fromXtoDM(wasPan.startX);
            if (!Number.isFinite(dMraw)) { if (hadSelection) redraw(); return; }
            const dM = Math.max(0, Math.min(state.lengthM, dMraw));
            // Below the X axis → ride the cab there.
            if (wasPan.belowAxis) {
                if (typeof state.onSeekCab === 'function') state.onSeekCab(dM);
                return;
            }
            // On the trasa line → INSERT a node there, at the line's current
            // elevation (so the shape is unchanged until you drag it). This is
            // the mobile-friendly single-tap replacement for double-click-to-add;
            // applyLocalPviEdit turns a fresh chainage into a new locked PVI.
            // …except inside a station span, where a new pin is precisely what
            // tilts the platform (or makes the solver drop its level plateau).
            // The click falls through to focusing the map instead.
            if (series.foto && nearTrasaLine(wasPan.startX, wasPan.startY)
                && !stationSpanAt(state, dM)
                && typeof state.onLockPvi === 'function') {
                const elev = root.__profileRender.elevAtChainageOnProfile(state.profile, dM, state.lengthM);
                if (Number.isFinite(elev)) { state.onLockPvi(dM, Math.round(elev * 10) / 10); return; }
            }
            // Anywhere else in the plot → focus the main map on that chainage,
            // aligned under the click. Just an aid; nothing is edited.
            if (typeof state.onFocusMap === 'function') state.onFocusMap(dM, wasPan.clientX);
            if (hadSelection) redraw();
        });
        canvas.addEventListener('pointercancel', () => { drag = null; pan = null; canvas.style.cursor = 'default'; redraw(); });
        canvas.addEventListener('pointerleave', () => {
            hoverDM = null;
            canvas.style.cursor = 'default';
            if (typeof state.onHoverChainage === 'function') state.onHoverChainage(null);
            redraw();
        });
        // Wheel = zoom the chainage window, keeping the point under the cursor fixed.
        canvas.addEventListener('wheel', (event) => {
            event.preventDefault();
            const { x } = canvasPoint(event);
            const anchorDM = view.layout.fromXtoDM(x);
            const span = viewWindow.dM1 - viewWindow.dM0;
            const factor = event.deltaY < 0 ? 0.82 : 1.22;   // scroll up = zoom in
            const newSpan = Math.max(MIN_SPAN_M, Math.min(state.lengthM, span * factor));
            const frac = span > 1e-9 ? (anchorDM - viewWindow.dM0) / span : 0.5;
            setWindow(anchorDM - frac * newSpan, anchorDM - frac * newSpan + newSpan);
        }, { passive: false });
        canvas.addEventListener('dblclick', (event) => {
            const { x, y } = canvasPoint(event);
            const handle = root.__profileRender.hitTestPviHandle(
                interactivePviHandles(view.scene), x, y, HANDLE_HIT_PX);
            // Double-click a locked node = delete it (rejoin its neighbours).
            // Adding a node is a single click on the trasa line (see pointerup);
            // empty double-click stays a no-op (single click focuses the map).
            // A node inside a station span is the platform's own anchor — the
            // solver puts it straight back, so deleting it is meaningless.
            if (handle && handle.locked && !stationSpanAt(state, handle.dM)
                && typeof state.onUnlockPvi === 'function') {
                state.onUnlockPvi(handle.dM);
            }
        });

        // Redraw on width changes (viewport rotation, sidebar/drawer, dock show).
        let observer = null;
        if (typeof ResizeObserver === 'function') {
            observer = new ResizeObserver(() => {
                if (!container.isConnected) { observer.disconnect(); return; }
                redraw();
            });
            observer.observe(container);
        }

        return {
            setMapCursor(dM) {
                const next = Number.isFinite(dM) ? dM : null;
                if (next === mapCursorDM) return;
                mapCursorDM = next;
                redraw();
            },
            // Current zoom/pan window + legend visibility, so a re-attach after an
            // elevation edit can restore exactly what the user was looking at.
            getViewState() {
                return { viewWindow: { dM0: viewWindow.dM0, dM1: viewWindow.dM1 }, series: { ...series } };
            },
            // Swap in fresh data (e.g. the re-derived profile after a node drag)
            // and redraw WITHOUT re-creating the canvas. redraw() rebuilds the
            // scene from `state` every frame, and selection/zoom/drag are locals
            // that persist — so this keeps the interaction alive where a full
            // re-attach used to destroy it (the "strip closed on every drag").
            update(partial) {
                if (partial && typeof partial === 'object') Object.assign(state, partial);
                redraw();
            },
            destroy() { if (observer) observer.disconnect(); container.innerHTML = ''; },
        };
    }

    // The station-platform helpers are exported for headless tests: they carry
    // the rules that decide whether a platform is a rigid object (which nodes
    // belong to it, whether it is level, where its bar can be grabbed) and none
    // of them touch the DOM or a canvas. In node, `root` is module.exports, so a
    // test can also inject __profileRender the same way the browser provides it.
    return {
        attach, setSnapClearances, getSnapClearances,
        stationSpanAt, stationLevelErrorM, buildStationBars, hitTestStationBar,
        stationBoxProfile, stationTerrainSamples, terrainAtDM,
        STATION_LEVEL_TOLERANCE_M,
        earthworksKindAt, bridgeEarthworksGaps, buildEarthworksBands,
        bottomBandLayout, buildElectrificationBands,
    };
}));
