// What speed the RECONSTRUCTED geometry allows, as opposed to what the timetable
// or the network statement permits. Two independent limits per point — the curve
// and the gradient — then a run over the resulting limit curve that respects
// acceleration and braking, which is what makes "time to cross" and "average
// speed" mean anything.
//
// Every constant here is an ASSUMPTION, exposed and named, never an official
// figure. The official numbers come from the network statement (annex 2.13 for
// permitted speed, 2.18 for the ruling gradient). line-chainage.js retains this
// physical profile for comparison, then caps a second run with the published
// speed so its travel time reflects the infrastructure as it exists.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.__lineSpeed = api;
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const EARTH_RADIUS_M = 6371000;
    const DEG_TO_RAD = Math.PI / 180;

    // ── Curve limit ───────────────────────────────────────────────────────────
    // The standard relation between cant, cant deficiency, radius and speed:
    //     h + hd = 11.8 · V² / R      (h, hd in mm; V in km/h; R in m)
    // so V = sqrt(R · (h + hd) / 11.8). The 11.8 folds in gravity and the 1435 mm
    // gauge, and is the same constant the UIC leaflets and HŽ's own design rules
    // use, which is why the formula is quoted rather than re-derived.
    const CANT_CONSTANT = 11.8;
    // Conventional stock on a rebuilt conventional line. Tilting trains are
    // allowed more deficiency, which is exactly why annex 2.13 tabulates them
    // separately — pass DEFAULTS.tiltingCantDeficiencyMm to get that figure.
    const DEFAULTS = Object.freeze({
        cantMm: 150,                    // maximum cant, conventional main line
        cantDeficiencyMm: 100,          // conventional stock
        tiltingCantDeficiencyMm: 130,
        // Service braking, not emergency: the figure a driver may plan on.
        serviceBrakingMs2: 0.9,
        // Distance a train may need to stop from line speed. The annex tabulates
        // a real "duljina zaustavnog puta" per section; where it is known, pass
        // it instead of this default.
        stoppingDistanceM: 1000,
        accelerationMs2: 0.5,
        maxSpeedKph: 160,               // nothing on these lines is cleared higher
    });

    function curveSpeedLimitKph(radiusM, options = {}) {
        const radius = Number(radiusM);
        if (!Number.isFinite(radius) || radius <= 0) return Infinity;   // straight
        const cant = Number(options.cantMm ?? DEFAULTS.cantMm);
        const deficiency = Number(options.cantDeficiencyMm ?? DEFAULTS.cantDeficiencyMm);
        return Math.sqrt(radius * (cant + deficiency) / CANT_CONSTANT);
    }

    // ── Gradient limit ────────────────────────────────────────────────────────
    // A falling gradient eats into the deceleration a brake can deliver, so the
    // speed from which a train can still stop within the available distance drops.
    // A rising gradient does not limit speed this way (it limits load and
    // acceleration, which is a different question), so it returns Infinity rather
    // than pretending to be a speed cap.
    function gradeSpeedLimitKph(gradePermille, options = {}) {
        const grade = Number(gradePermille);
        if (!Number.isFinite(grade) || grade >= 0) return Infinity;
        const descent = Math.abs(grade) / 1000;
        const braking = Number(options.serviceBrakingMs2 ?? DEFAULTS.serviceBrakingMs2);
        const distance = Number(options.stoppingDistanceM ?? DEFAULTS.stoppingDistanceM);
        const effective = braking - 9.81 * descent;
        if (effective <= 0) return 0;   // cannot hold the train on this gradient
        return Math.sqrt(2 * effective * distance) * 3.6;
    }

    // ── Curvature from the plan geometry ──────────────────────────────────────
    // Radius of the circle through three consecutive points, in metres, computed
    // in a local equirectangular frame (exact to centimetres at Croatian
    // latitudes over the tens of metres between nodes).
    function radiusThroughM(a, b, c) {
        const latRad = b[1] * DEG_TO_RAD;
        const mPerLon = DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(latRad);
        const mPerLat = DEG_TO_RAD * EARTH_RADIUS_M;
        const ax = a[0] * mPerLon, ay = a[1] * mPerLat;
        const bx = b[0] * mPerLon, by = b[1] * mPerLat;
        const cx = c[0] * mPerLon, cy = c[1] * mPerLat;
        const areaTwice = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        // Collinear within numerical noise: a straight, not a huge circle whose
        // radius would be dominated by rounding.
        if (Math.abs(areaTwice) < 1e-6) return Infinity;
        const ab = Math.hypot(bx - ax, by - ay);
        const bc = Math.hypot(cx - bx, cy - by);
        const ca = Math.hypot(ax - cx, ay - cy);
        return (ab * bc * ca) / (2 * Math.abs(areaTwice));
    }

    // Curvature must be measured across a BASELINE, never between adjacent nodes.
    // A reconstruction inherits OSM's node spacing, which is often well under a
    // metre; three points 0.5 m apart with a few centimetres of lateral jitter
    // describe a circle of a few tens of metres, so adjacent-triple curvature
    // reports tram radii on a main line (48 m on Gračac–Knin, where nothing is
    // below ~250 m) and drags the "possible speed" down with it. Same lesson as
    // the grade audit's 20 m chord: the baseline has to suit the data, not the
    // node list. 40 m still resolves a 250 m curve and ignores the jitter.
    const CURVATURE_BASELINE_M = 40;

    function cumulativeMetres(points) {
        const out = [0];
        for (let index = 1; index < points.length; index += 1) {
            const [aLon, aLat] = points[index - 1];
            const [bLon, bLat] = points[index];
            const midLat = ((aLat + bLat) / 2) * DEG_TO_RAD;
            const dx = (bLon - aLon) * DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(midLat);
            const dy = (bLat - aLat) * DEG_TO_RAD * EARTH_RADIUS_M;
            out.push(out[index - 1] + Math.hypot(dx, dy));
        }
        return out;
    }

    // Per-node radius, from the neighbours at least `baselineM` away along the
    // line. Ends inherit the nearest computable value — reporting Infinity there
    // would understate a curve that starts at the very first node.
    function curveRadiiM(coordinates, options = {}) {
        const points = Array.isArray(coordinates) ? coordinates : [];
        if (points.length < 3) return points.map(() => Infinity);
        const baseline = Math.max(0, Number(options.curvatureBaselineM ?? CURVATURE_BASELINE_M));
        const at = cumulativeMetres(points);
        const radii = points.map((_point, index) => {
            let before = index;
            while (before > 0 && at[index] - at[before] < baseline) before -= 1;
            let after = index;
            while (after < points.length - 1 && at[after] - at[index] < baseline) after += 1;
            // Both arms must ACTUALLY span the baseline, not merely exist. Near
            // the ends the walk stops at the array bound with a short arm, and an
            // asymmetric triple is as jitter-sensitive as adjacent nodes were —
            // a dead straight line read as a 334 m curve that way.
            if (at[index] - at[before] < baseline || at[after] - at[index] < baseline) return null;
            return radiusThroughM(points[before], points[index], points[after]);
        });
        const firstReal = radii.find(value => value !== null) ?? Infinity;
        const lastReal = [...radii].reverse().find(value => value !== null) ?? Infinity;
        return radii.map((value, index) => {
            if (value !== null) return value;
            return index < radii.length / 2 ? firstReal : lastReal;
        });
    }

    // ── The limit curve ───────────────────────────────────────────────────────
    // nodes: [{ dM, x, y, gradePermille }]. Returns one entry per node with the
    // binding limit named, so a slow section can be explained rather than just
    // reported.
    function speedLimitProfile(nodes, options = {}) {
        const list = Array.isArray(nodes) ? nodes : [];
        const radii = curveRadiiM(list.map(node => [Number(node.x), Number(node.y)]));
        const ceiling = Number(options.maxSpeedKph ?? DEFAULTS.maxSpeedKph);
        return list.map((node, index) => {
            const curveKph = curveSpeedLimitKph(radii[index], options);
            const gradeKph = gradeSpeedLimitKph(node.gradePermille, options);
            const limits = [
                { by: 'ceiling', kph: ceiling },
                { by: 'curve', kph: curveKph },
                { by: 'grade', kph: gradeKph },
            ].filter(entry => Number.isFinite(entry.kph));
            const binding = limits.reduce((best, entry) => (entry.kph < best.kph ? entry : best));
            return {
                dM: Number(node.dM),
                radiusM: Number.isFinite(radii[index]) ? radii[index] : null,
                curveKph: Number.isFinite(curveKph) ? curveKph : null,
                gradeKph: Number.isFinite(gradeKph) ? gradeKph : null,
                limitKph: binding.kph,
                limitedBy: binding.by,
            };
        });
    }

    // ── Running it ────────────────────────────────────────────────────────────
    // A limit curve is not a speed: a train cannot step from 40 to 140 km/h at a
    // curve exit. Forward pass applies acceleration, backward pass applies
    // braking, and the achievable speed is the lower of the two — the standard
    // construction, and the reason the time below is longer than sum(ds / limit).
    function runProfile(limits, options = {}) {
        const points = Array.isArray(limits) ? limits : [];
        if (points.length < 2) return { speedsKph: points.map(p => p.limitKph), seconds: 0 };
        const accel = Number(options.accelerationMs2 ?? DEFAULTS.accelerationMs2);
        const brake = Number(options.serviceBrakingMs2 ?? DEFAULTS.serviceBrakingMs2);
        const startStopped = options.startStopped !== false;
        const endStopped = options.endStopped !== false;
        const toMs = kph => kph / 3.6;

        const forward = points.map(point => toMs(point.limitKph));
        if (startStopped) forward[0] = 0;
        for (let index = 1; index < points.length; index += 1) {
            const ds = Math.max(0, points[index].dM - points[index - 1].dM);
            const reachable = Math.sqrt(forward[index - 1] ** 2 + 2 * accel * ds);
            forward[index] = Math.min(forward[index], reachable);
        }
        const backward = points.map(point => toMs(point.limitKph));
        if (endStopped) backward[backward.length - 1] = 0;
        for (let index = points.length - 2; index >= 0; index -= 1) {
            const ds = Math.max(0, points[index + 1].dM - points[index].dM);
            const reachable = Math.sqrt(backward[index + 1] ** 2 + 2 * brake * ds);
            backward[index] = Math.min(backward[index], reachable);
        }
        const speeds = points.map((_point, index) => Math.min(forward[index], backward[index]));

        let seconds = 0;
        for (let index = 1; index < points.length; index += 1) {
            const ds = Math.max(0, points[index].dM - points[index - 1].dM);
            // Trapezoidal in speed over the step; a stopped pair contributes no
            // time and no distance, which is correct for a zero-length step.
            const mean = (speeds[index - 1] + speeds[index]) / 2;
            if (ds > 0 && mean > 0) seconds += ds / mean;
        }
        return { speedsKph: speeds.map(ms => ms * 3.6), seconds };
    }

    // Everything a section row needs, from its own nodes.
    function sectionSpeedSummary(nodes, options = {}) {
        const limits = speedLimitProfile(nodes, options);
        if (limits.length < 2) return null;
        const run = runProfile(limits, options);
        const lengthM = limits[limits.length - 1].dM - limits[0].dM;
        const limitValues = limits.map(entry => entry.limitKph);
        const radii = limits.map(entry => entry.radiusM).filter(Number.isFinite);
        const binding = limits.reduce((counts, entry) => {
            counts[entry.limitedBy] = (counts[entry.limitedBy] || 0) + 1;
            return counts;
        }, {});
        return {
            lengthM,
            seconds: run.seconds,
            // Distance over time, which is what "average speed" has to mean if
            // the number is to be comparable with a timetable.
            averageSpeedKph: run.seconds > 0 ? (lengthM / run.seconds) * 3.6 : null,
            maxPossibleSpeedKph: Math.max(...limitValues),
            minPossibleSpeedKph: Math.min(...limitValues),
            tightestRadiusM: radii.length ? Math.min(...radii) : null,
            limitedBy: binding,
        };
    }

    return {
        DEFAULTS,
        CANT_CONSTANT,
        CURVATURE_BASELINE_M,
        curveSpeedLimitKph,
        gradeSpeedLimitKph,
        curveRadiiM,
        speedLimitProfile,
        runProfile,
        sectionSpeedSummary,
    };
}));
