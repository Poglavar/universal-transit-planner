// Discrete civil-engineering OBJECTS along a solved vertical profile: every
// tunnel, open cut, embankment and viaduct as one connected thing, the stations
// on top of them, and all the ground-level track summed into a single row.
// A second look at the cost problem — a route priced as a bill of structures
// rather than as a per-kilometre average.
//
// "Connected and discrete" is the whole point: two elevated stretches separated
// by anything else are two viaducts, and a 20 m sampling blip is not a
// separation, so short runs are absorbed into their larger neighbour before
// anything is counted (see smoothRuns).
//
// The tunnel/viaduct call is NOT re-derived here — the caller passes the display
// states stamped by __verticalProfile.displayRegimes, which owns the 8 m rule.
// This file only splits the remaining "na terenu" band into cut / on-ground /
// fill, and that eps is locked in lockstep with the strip's earthworks hatch.
//
// UMD: classic scripts get window.__civilObjects, node tests require() it.
// Pure — no DOM, no fetch, no canvas.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__civilObjects = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Track within this of the terrain is sitting ON the ground, not in a cut
    // and not on fill. Same number as profile-strip.js EARTHWORKS_EPS_M (the
    // hatch) and the grade solver's atGradeEpsM — civil-objects.test.mjs holds
    // the two in lockstep, because a route the strip hatches as an excavation
    // must appear in this list as a cut.
    const EARTHWORKS_EPS_M = 0.5;

    // Below this an object is sampling noise, not a structure: the DGU profile
    // steps every 20 m, so a single step of "cut" between two tunnel steps is a
    // rounding artefact, and 30 m of ground between two viaducts is not a place
    // anyone ends a bridge and starts another. Two DEM steps.
    const MIN_OBJECT_LENGTH_M = 40;

    // …and below this an earthwork is not an earthwork. A grade-limited line
    // over a 20 m DEM spends most of its length a few tens of centimetres off
    // the ground, which the strip rightly hatches as dirt but which nobody would
    // list as a structure: a real 15 km route produced 23 cut/fill rows, of
    // which 19 were shallower than a metre. Anything that never gets a metre
    // deep is track sitting on the ground, and it is summed with the rest of it.
    // Structures are exempt — a tunnel is a tunnel at any cover.
    const MIN_EARTHWORKS_HEIGHT_M = 1;

    // Structure kinds in vertical order, top to bottom — the display order of
    // the summary table.
    const OBJECT_KINDS = Object.freeze([
        'viaduct', 'fill', 'at-grade', 'cut', 'tunnel', 'station', 'transfer',
    ]);
    const OBJECT_LABELS = Object.freeze({
        tunnel: 'Tunel',
        cut: 'Usjek',
        'at-grade': 'Ravni teren',
        fill: 'Nasip',
        viaduct: 'Vijadukt',
        station: 'Stanica',
        transfer: 'Presjedanje',
    });
    const OBJECT_ICONS = Object.freeze({
        tunnel: '🚇',
        cut: '⛰️',
        'at-grade': '🛤️',
        fill: '🧱',
        viaduct: '🌉',
        station: '🏘️',
        transfer: '🔗',
    });
    // What the height column means for each kind — a tunnel is deep, a viaduct
    // is tall, and calling both "height" reads as a mistake.
    const OBJECT_HEIGHT_LABELS = Object.freeze({
        tunnel: 'dubina',
        cut: 'dubina',
        fill: 'visina',
        viaduct: 'visina',
    });

    // Placeholder rates until the real cost model lands. Deliberately the
    // planner's own numbers so the two views cannot disagree by an order of
    // magnitude: 1435 mm surface track is 20 mil. EUR/km, underground ×8,
    // elevated ×2.5; cut and fill are guesses between surface and structure.
    const DEFAULT_OBJECT_RATES = Object.freeze({
        perMeterEur: Object.freeze({
            tunnel: 160000,
            cut: 40000,
            'at-grade': 20000,
            fill: 26000,
            viaduct: 50000,
        }),
        stationEur: Object.freeze({
            tunnel: 48000000,
            covered: 30000000,
            cut: 12000000,
            elevated: 15000000,
            surface: 6000000,
        }),
        depotEur: Object.freeze({
            tunnel: 320000000,
            covered: 200000000,
            cut: 80000000,
            elevated: 100000000,
            surface: 40000000,
        }),
        transferEur: Object.freeze({ underground: 20000000, overground: 0 }),
    });

    // A transfer link priced as an object: no length, no position, one flat
    // price per link type.
    function transferObject(link, index) {
        return {
            kind: 'transfer',
            linkType: link?.linkType === 'underground' ? 'underground' : 'overground',
            name: link?.name || '',
            dM0: null,
            dM1: null,
            lengthM: 0,
            heightM: null,
            avgHeightM: null,
            count: 1,
            key: `transfer|${link?.id != null ? link.id : index}`,
        };
    }

    // One sample's object kind. `displayState` is the app-stamped
    // tunnel/at-grade/viaduct call; a structure stays a structure whatever the
    // dirt around it does, and only the at-grade band is split by depth. A
    // missing state (a profile nothing has stamped) degrades to the earthworks
    // split rather than guessing at the tunnel rule this file does not own.
    function objectKindAt(elevAslM, terrainAslM, displayState) {
        const elev = Number(elevAslM);
        const terr = Number(terrainAslM);
        if (displayState === 'tunnel' || displayState === 'viaduct') return displayState;
        if (!Number.isFinite(elev) || !Number.isFinite(terr)) return 'at-grade';
        const rel = elev - terr;
        if (rel < -EARTHWORKS_EPS_M) return 'cut';
        if (rel > EARTHWORKS_EPS_M) return 'fill';
        return 'at-grade';
    }

    // Per-step samples in the profile's own convention: sample i sits at
    // i*stepM, the last clamped to the exact route length.
    function profileSamples(profile, lengthM, displayStates, terrainAt) {
        const elevs = (profile && profile.elevAslM) || [];
        const stepM = Number(profile && profile.stepM);
        if (elevs.length < 2 || !(stepM > 0)) return [];
        const routeLengthM = Number(lengthM) > 0 ? Number(lengthM) : (elevs.length - 1) * stepM;
        const states = Array.isArray(displayStates) && displayStates.length === elevs.length
            ? displayStates
            : (Array.isArray(profile.displayRegimes) && profile.displayRegimes.length === elevs.length
                ? profile.displayRegimes
                : null);
        return elevs.map((value, i) => {
            const dM = Math.min(i * stepM, routeLengthM);
            const elev = Number(value);
            let terr = profile.terrainAslM ? Number(profile.terrainAslM[i]) : NaN;
            if (!Number.isFinite(terr) && typeof terrainAt === 'function') {
                const fetched = Number(terrainAt(dM));
                terr = Number.isFinite(fetched) ? fetched : NaN;
            }
            const state = states ? states[i] : null;
            return {
                dM,
                elevAslM: elev,
                terrainAslM: Number.isFinite(terr) ? terr : null,
                relM: Number.isFinite(elev) && Number.isFinite(terr) ? elev - terr : null,
                kind: objectKindAt(elev, terr, state),
            };
        });
    }

    // The coarse source: a track that has no solved profile still carries one
    // level per vertex (−1 underground / 0 surface / +1 elevated), which is the
    // same three states the display vocabulary uses. Detection runs on exactly
    // the same machinery — only the sampling is different (irregular vertex
    // chainages instead of a fixed step) and there is no terrain, so earthworks
    // cannot be told apart from ground and no depth can be reported. Levels are
    // fractional across ramps (shapeDerivedLevelRamps), so the half-level mark
    // is where a ramp becomes the thing it is ramping into.
    const LEVEL_STATE_THRESHOLD = 0.5;
    function levelSamples(levels, chainagesM) {
        if (!Array.isArray(levels) || !Array.isArray(chainagesM)
            || levels.length !== chainagesM.length || levels.length < 2) return [];
        return levels.map((value, i) => {
            const level = Number(value);
            const kind = level <= -LEVEL_STATE_THRESHOLD ? 'tunnel'
                : level >= LEVEL_STATE_THRESHOLD ? 'viaduct' : 'at-grade';
            return {
                dM: Number(chainagesM[i]),
                elevAslM: null,
                terrainAslM: null,
                relM: null,
                kind,
            };
        }).filter((sample) => Number.isFinite(sample.dM));
    }

    // Contiguous same-kind runs. Edges sit midway between the last sample inside
    // and the first outside — the same convention the strip's regime bands and
    // earthworks hatch use, so a 20 m object is 20 m long here too instead of
    // collapsing to a point.
    function buildRuns(samples, lengthM) {
        if (!Array.isArray(samples) || samples.length < 2) return [];
        const routeLengthM = Number(lengthM) > 0
            ? Number(lengthM)
            : samples[samples.length - 1].dM;
        const runs = [];
        let startIndex = 0;
        for (let i = 1; i <= samples.length; i++) {
            if (i < samples.length && samples[i].kind === samples[startIndex].kind) continue;
            const dM0 = startIndex === 0
                ? 0
                : (samples[startIndex - 1].dM + samples[startIndex].dM) / 2;
            const dM1 = i >= samples.length
                ? routeLengthM
                : (samples[i - 1].dM + samples[i].dM) / 2;
            runs.push({ kind: samples[startIndex].kind, dM0, dM1 });
            startIndex = i;
        }
        return runs;
    }

    function coalesceRuns(runs) {
        const out = [];
        for (const run of runs) {
            const last = out[out.length - 1];
            if (last && last.kind === run.kind) last.dM1 = run.dM1;
            else out.push({ kind: run.kind, dM0: run.dM0, dM1: run.dM1 });
        }
        return out;
    }

    // Absorb every run shorter than the threshold into its LONGER neighbour,
    // shortest first, until nothing short is left. This is what makes an object
    // discrete rather than an artefact: a one-step "cut" inside a tunnel becomes
    // tunnel, and two viaducts 30 m apart become one viaduct — which is the
    // structure a person would actually build. A route that is entirely one
    // short thing keeps it (a 30 m route is still one object).
    function smoothRuns(runs, minLengthM) {
        const threshold = Number.isFinite(Number(minLengthM)) && Number(minLengthM) > 0
            ? Number(minLengthM)
            : MIN_OBJECT_LENGTH_M;
        let current = coalesceRuns(runs);
        while (current.length > 1) {
            let index = -1;
            let shortest = Infinity;
            for (let i = 0; i < current.length; i++) {
                const runLengthM = current[i].dM1 - current[i].dM0;
                if (runLengthM < threshold && runLengthM < shortest) {
                    shortest = runLengthM;
                    index = i;
                }
            }
            if (index < 0) break;
            const previous = current[index - 1] || null;
            const next = current[index + 1] || null;
            const previousLengthM = previous ? previous.dM1 - previous.dM0 : -1;
            const nextLengthM = next ? next.dM1 - next.dM0 : -1;
            current[index].kind = previousLengthM >= nextLengthM ? previous.kind : next.kind;
            // The re-kinded run now matches a neighbour, so coalescing always
            // removes at least one run — the loop cannot spin.
            current = coalesceRuns(current);
        }
        return current;
    }

    // Extreme and mean clearance over a run, as magnitudes: the sign is already
    // in the kind (a tunnel is below, a viaduct above) and a signed number in a
    // "dubina" column reads as a bug.
    function runHeightStats(run, samples) {
        let extreme = 0;
        let sum = 0;
        let count = 0;
        for (const sample of samples) {
            if (sample.dM < run.dM0 - 1e-6 || sample.dM > run.dM1 + 1e-6) continue;
            if (!Number.isFinite(sample.relM)) continue;
            const magnitude = Math.abs(sample.relM);
            if (magnitude > extreme) extreme = magnitude;
            sum += magnitude;
            count += 1;
        }
        return {
            heightM: count > 0 ? extreme : null,
            avgHeightM: count > 0 ? sum / count : null,
        };
    }

    // A cut or fill that never reaches the minimum height is regraded ground,
    // not a structure — hand it back to the at-grade total. Runs through the
    // same at-grade bucket as everything else, so it still coalesces with its
    // neighbours instead of leaving a hole in the route.
    function demoteShallowEarthworks(runs, samples, minHeightM) {
        const threshold = Number.isFinite(Number(minHeightM)) && Number(minHeightM) >= 0
            ? Number(minHeightM)
            : MIN_EARTHWORKS_HEIGHT_M;
        return runs.map((run) => {
            if (run.kind !== 'cut' && run.kind !== 'fill') return run;
            const { heightM } = runHeightStats(run, samples);
            return Number.isFinite(heightM) && heightM >= threshold
                ? run
                : { ...run, kind: 'at-grade' };
        });
    }

    function stationObject(mark) {
        const dM0 = Number(mark && mark.dM0);
        const dM1 = Number(mark && mark.dM1);
        if (!Number.isFinite(dM0) || !Number.isFinite(dM1) || dM1 <= dM0) return null;
        return {
            kind: 'station',
            stationKind: mark.kind || 'surface',
            stationType: mark.stationType === 'depot' ? 'depot' : 'normal',
            name: mark.name || '',
            dM0,
            dM1,
            lengthM: dM1 - dM0,
            heightM: null,
            avgHeightM: null,
            count: 1,
        };
    }

    // Every object on one track, in chainage order, with the summed ground-level
    // row last (it has no single position — it is all of them).
    function detectTrackObjects(options) {
        const opts = options || {};
        return objectsFromSamples(
            profileSamples(opts.profile, Number(opts.lengthM), opts.displayRegimes, opts.terrainAt),
            opts,
        );
    }

    // Same objects, detected from the per-vertex level array of a track that has
    // no solved profile — one model, two sources, never two cost formulas.
    function detectTrackObjectsFromLevels(options) {
        const opts = options || {};
        return objectsFromSamples(levelSamples(opts.levels, opts.chainagesM), opts);
    }

    function objectsFromSamples(samples, opts) {
        const lengthM = Number(opts.lengthM);
        if (samples.length < 2) return [];
        const routeLengthM = Number(lengthM) > 0 ? Number(lengthM) : samples[samples.length - 1].dM;
        const runs = smoothRuns(
            demoteShallowEarthworks(
                buildRuns(samples, routeLengthM), samples, opts.minEarthworksHeightM,
            ),
            opts.minObjectLengthM,
        );

        const objects = [];
        const flatSegments = [];
        let flatLengthM = 0;
        for (const run of runs) {
            const runLengthM = run.dM1 - run.dM0;
            if (run.kind === 'at-grade') {
                flatSegments.push({ dM0: run.dM0, dM1: run.dM1 });
                flatLengthM += runLengthM;
                continue;
            }
            objects.push({
                kind: run.kind,
                dM0: run.dM0,
                dM1: run.dM1,
                lengthM: runLengthM,
                count: 1,
                ...runHeightStats(run, samples),
            });
        }
        for (const mark of (opts.stationMarks || [])) {
            const station = stationObject(mark);
            if (station) objects.push(station);
        }
        objects.sort((a, b) => a.dM0 - b.dM0);
        if (flatLengthM > 0) {
            objects.push({
                kind: 'at-grade',
                dM0: null,
                dM1: null,
                lengthM: flatLengthM,
                count: flatSegments.length,
                segments: flatSegments,
                heightM: null,
                avgHeightM: null,
            });
        }
        for (const object of objects) object.key = objectKey(object, opts.trackId);
        return objects;
    }

    // Stable-enough identity for a hand-typed price: which track, what kind of
    // thing, and where it starts (to the metre). Re-detecting the same alignment
    // reproduces the key exactly; moving the alignment does not, and the manual
    // price is dropped — which is correct, since it was a price for a structure
    // that no longer exists. The summed ground-level row has no position, so it
    // is keyed by track alone.
    function objectKey(object, trackId) {
        const track = trackId == null ? '' : String(trackId);
        if (!object) return '';
        if (object.kind === 'at-grade') return `${track}|at-grade`;
        return `${track}|${object.kind}|${Math.round(Number(object.dM0) || 0)}`;
    }

    // Model price of one object. `overrides` is an optional {key: eur} map of
    // hand-typed prices — see transit-pricing.js, which owns their storage.
    function objectCostEur(object, rates, overrides) {
        if (!object) return 0;
        const manual = overrides ? Number(overrides[object.key]) : NaN;
        if (Number.isFinite(manual) && manual >= 0) return manual;
        const table = rates || DEFAULT_OBJECT_RATES;
        if (object.kind === 'station') {
            const stations = (object.stationType === 'depot' && table.depotEur)
                || table.stationEur || DEFAULT_OBJECT_RATES.stationEur;
            const price = Number(stations[object.stationKind]);
            return Number.isFinite(price) ? price : Number(stations.surface) || 0;
        }
        // A transfer link is a flat-priced object with no length — the walking
        // connection between two stations, which the planner already prices.
        if (object.kind === 'transfer') {
            const links = table.transferEur || DEFAULT_OBJECT_RATES.transferEur;
            const price = Number(links[object.linkType]);
            return Number.isFinite(price) ? price : 0;
        }
        const perMeter = Number((table.perMeterEur || {})[object.kind]);
        const lengthM = Number(object.lengthM);
        if (!Number.isFinite(perMeter) || !Number.isFinite(lengthM)) return 0;
        return perMeter * lengthM;
    }

    function hasManualCost(object, overrides) {
        if (!object || !overrides) return false;
        const manual = Number(overrides[object.key]);
        return Number.isFinite(manual) && manual >= 0;
    }

    // Roll several tracks' objects into one per-kind table. Entries are
    // {objects, rates} so each track prices with its own gauge's rates.
    // `count` is objects (the ground-level row is ONE object per track however
    // many stretches it is made of); `stretches` is those pieces, which only
    // differs for that row.
    function summarize(entries) {
        const byKind = new Map();
        let totalCostEur = 0;
        let totalLengthM = 0;
        for (const entry of (entries || [])) {
            for (const object of (entry?.objects || [])) {
                const costEur = objectCostEur(object, entry.rates, entry.overrides);
                const bucket = byKind.get(object.kind)
                    || { kind: object.kind, count: 0, stretches: 0, lengthM: 0, costEur: 0 };
                bucket.count += 1;
                bucket.stretches += Number(object.count) || 1;
                bucket.lengthM += Number(object.lengthM) || 0;
                bucket.costEur += costEur;
                byKind.set(object.kind, bucket);
                totalCostEur += costEur;
                totalLengthM += Number(object.lengthM) || 0;
            }
        }
        const rows = OBJECT_KINDS
            .map((kind) => byKind.get(kind))
            .filter(Boolean);
        return { rows, totalCostEur, totalLengthM, objectCount: rows.reduce((n, r) => n + r.count, 0) };
    }

    return {
        EARTHWORKS_EPS_M,
        MIN_OBJECT_LENGTH_M,
        MIN_EARTHWORKS_HEIGHT_M,
        OBJECT_KINDS,
        OBJECT_LABELS,
        OBJECT_ICONS,
        OBJECT_HEIGHT_LABELS,
        DEFAULT_OBJECT_RATES,
        objectKindAt,
        profileSamples,
        levelSamples,
        buildRuns,
        smoothRuns,
        demoteShallowEarthworks,
        detectTrackObjects,
        detectTrackObjectsFromLevels,
        transferObject,
        objectKey,
        objectCostEur,
        hasManualCost,
        summarize,
    };
}));
