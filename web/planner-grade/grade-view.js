// The map's grade view: a route coloured by whether it climbs or descends, and
// by how hard, instead of by what it is built on.
//
// Two things this module exists to get right, both of which a naive version
// gets wrong:
//
// 1. A grade is NOT a property of a piece of track — it is a property of a
//    direction of travel over it. Zagreb→Split climbs exactly where Split→
//    Zagreb descends, on the same metal. So every reading here is relative to a
//    stated direction (increasing chainage by default), and `flipped` turns the
//    whole view around rather than pretending there is one true answer.
//
// 2. Grade is read from the profile's PVIs — the authored grade-change points —
//    so the span between two of them IS one designed constant grade. Never
//    difference adjacent elevation samples: on a 20 m step with centimetre
//    quantisation that is ±1.25‰ of pure noise, which is the same defect that
//    once made the cab's grade readout flicker between −1% and 0% inside ten
//    metres. There is no smoothing here because there is nothing to smooth.
//
// Pure: no DOM, no Leaflet, no map. Given a profile it returns spans and colours;
// the caller draws them.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.__gradeView = api;
}(typeof self !== 'undefined' ? self : globalThis, function () {
    'use strict';

    // Below this a railway is level for every purpose a map colour serves, and
    // colouring it would be colouring survey noise rather than a slope.
    const FLAT_GRADE_PCT = 0.2;

    // Warm climbs, cool descents: a diverging pair that reads at a glance, stays
    // legible for the red/green colourblind, and does not collide with the
    // strip's traffic-light green/amber/red — which already means something else
    // there (grade against the limit, not direction).
    const CLIMB_RGB = [180, 35, 24];        // deep warm red
    const CLIMB_LIGHT_RGB = [253, 214, 187]; // barely-there warm
    const DESCENT_RGB = [21, 72, 148];      // deep cool blue
    const DESCENT_LIGHT_RGB = [199, 224, 246];
    const FLAT_COLOR = '#8d9199';           // neutral grey — level, and known to be

    // Number(null) is 0 and Number(true) is 1, so a missing elevation would
    // become sea level and a missing grade would become "flat" — a real value,
    // plausible, and wrong. Anything that is not actually a number (or a string
    // holding one) is NaN here and stays NaN all the way out.
    function num(value) {
        if (typeof value !== 'number' && typeof value !== 'string') return NaN;
        if (typeof value === 'string' && value.trim() === '') return NaN;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : NaN;
    }

    function mix(from, to, t) {
        const ratio = Math.max(0, Math.min(1, t));
        return from.map((value, index) => Math.round(value + (to[index] - value) * ratio));
    }

    function rgb(values) {
        return `rgb(${values[0]}, ${values[1]}, ${values[2]})`;
    }

    // gradePct is signed and already expressed in the reading direction.
    // maxPct is the gauge's ruling grade, so full intensity means "at the limit
    // for this kind of railway" rather than at some absolute slope — otherwise a
    // mountain line saturates into one flat block of colour and says nothing.
    function gradeColor(gradePct, maxPct) {
        const grade = num(gradePct);
        if (!Number.isFinite(grade) || Math.abs(grade) < FLAT_GRADE_PCT) return FLAT_COLOR;
        const limit = Math.max(0.1, num(maxPct) || 4);
        // Ease the ramp so the common gentle grades still separate from each
        // other instead of all sitting in the palest tenth of the scale.
        const ratio = Math.min(1, Math.abs(grade) / limit) ** 0.65;
        return grade > 0
            ? rgb(mix(CLIMB_LIGHT_RGB, CLIMB_RGB, ratio))
            : rgb(mix(DESCENT_LIGHT_RGB, DESCENT_RGB, ratio));
    }

    function classify(gradePct, maxPct) {
        const grade = num(gradePct);
        if (!Number.isFinite(grade)) return 'unknown';
        if (Math.abs(grade) < FLAT_GRADE_PCT) return 'flat';
        if (Math.abs(grade) > (num(maxPct) || 4)) return grade > 0 ? 'climb-over' : 'descent-over';
        return grade > 0 ? 'climb' : 'descent';
    }

    // One entry per authored grade tangent: [dM0, dM1) at a constant gradePct.
    // `flipped` reads the line from the far end, which negates every grade AND
    // reverses the order, so the result still runs the way the reader is going.
    function gradeSpans(profile, { flipped = false } = {}) {
        const pvis = (profile && Array.isArray(profile.pvis) ? profile.pvis : [])
            .map(pvi => ({ dM: num(pvi && pvi.dM), elevAslM: num(pvi && pvi.elevAslM) }))
            .filter(pvi => Number.isFinite(pvi.dM) && Number.isFinite(pvi.elevAslM))
            .sort((left, right) => left.dM - right.dM);
        if (pvis.length < 2) return [];

        const spans = [];
        for (let index = 0; index < pvis.length - 1; index++) {
            const from = pvis[index];
            const to = pvis[index + 1];
            const runM = to.dM - from.dM;
            if (runM <= 1e-9) continue;
            const gradePct = ((to.elevAslM - from.elevAslM) / runM) * 100;
            spans.push({
                dM0: from.dM,
                dM1: to.dM,
                lengthM: runM,
                gradePct: flipped ? -gradePct : gradePct,
                riseM: (flipped ? -1 : 1) * (to.elevAslM - from.elevAslM),
            });
        }
        // Chainage stays the map's own coordinate — only the READING flips — so
        // the spans are returned in chainage order either way and a caller can
        // draw them without knowing which direction is being read.
        return spans;
    }

    // How many intensity steps each direction gets. Colour is quantised to these
    // before drawing, for two reasons: adjacent tangents that differ by a tenth
    // of a percent are the same fact to a reader, and a solved profile can carry
    // a PVI every 20 m — project 107 has ~2,950 of them — so painting one path
    // per tangent is thousands of SVG nodes for a picture with a dozen
    // distinguishable colours in it. Banding first, then merging, keeps the path
    // count near the number of things you can actually see.
    const GRADE_BANDS = 5;

    // A small integer per span: 0 is level, ±1..±GRADE_BANDS climb/descend, and
    // ±(GRADE_BANDS + 1) is over the gauge's ruling grade.
    function gradeBand(gradePct, maxPct) {
        const grade = num(gradePct);
        if (!Number.isFinite(grade) || Math.abs(grade) < FLAT_GRADE_PCT) return 0;
        const limit = Math.max(0.1, num(maxPct) || 4);
        const sign = grade > 0 ? 1 : -1;
        if (Math.abs(grade) > limit) return sign * (GRADE_BANDS + 1);
        const step = Math.ceil((Math.abs(grade) / limit) * GRADE_BANDS);
        return sign * Math.max(1, Math.min(GRADE_BANDS, step));
    }

    // The colour a band is drawn in. The map and the legend both go through
    // this, so a swatch cannot come to mean something the route does not.
    function bandColor(band, maxPct) {
        const index = Math.round(num(band) || 0);
        if (index === 0) return FLAT_COLOR;
        const limit = Math.max(0.1, num(maxPct) || 4);
        const sign = index > 0 ? 1 : -1;
        const steps = Math.min(Math.abs(index), GRADE_BANDS + 1);
        // The over-limit band sits past the ramp's end, so it saturates.
        const representative = sign * limit * (steps / GRADE_BANDS);
        return gradeColor(representative, limit);
    }

    // Over the ruling grade cannot be shown by colour alone: the ramp is already
    // saturated at the limit, so "steeper than allowed" and "exactly at the
    // limit" came out the same red. It gets a broken line instead — a different
    // KIND of mark, which survives both the saturation and colourblindness.
    function isOverLimitBand(band) {
        return Math.abs(Math.round(num(band) || 0)) > GRADE_BANDS;
    }

    function bandDashArray(band) {
        return isOverLimitBand(band) ? '9, 5' : null;
    }

    // Contiguous spans in the same band become one run. The reported gradePct is
    // length-weighted, so a hover or a label quotes what the run really averages
    // rather than whichever tangent happened to come first.
    function mergeSpansByBand(spans, maxPct) {
        const runs = [];
        for (const span of spans || []) {
            const band = gradeBand(span.gradePct, maxPct);
            const previous = runs[runs.length - 1];
            if (previous && previous.band === band && Math.abs(previous.dM1 - span.dM0) < 1e-6) {
                previous.dM1 = span.dM1;
                previous.lengthM += span.lengthM;
                previous.riseM += span.riseM;
                continue;
            }
            runs.push({
                dM0: span.dM0,
                dM1: span.dM1,
                lengthM: span.lengthM,
                riseM: span.riseM,
                band,
            });
        }
        for (const run of runs) {
            run.gradePct = run.lengthM > 1e-9 ? (run.riseM / run.lengthM) * 100 : 0;
        }
        return runs;
    }

    // What the legend and any summary should say. Lengths, not span counts: a
    // 12 km climb and a 200 m one are not two equal facts.
    function summarize(spans, maxPct) {
        const totals = { climbM: 0, descentM: 0, flatM: 0, overLimitM: 0, steepestClimbPct: 0, steepestDescentPct: 0 };
        for (const span of spans || []) {
            const kind = classify(span.gradePct, maxPct);
            if (kind === 'flat' || kind === 'unknown') totals.flatM += span.lengthM;
            else if (span.gradePct > 0) totals.climbM += span.lengthM;
            else totals.descentM += span.lengthM;
            if (kind === 'climb-over' || kind === 'descent-over') totals.overLimitM += span.lengthM;
            if (span.gradePct > totals.steepestClimbPct) totals.steepestClimbPct = span.gradePct;
            if (span.gradePct < totals.steepestDescentPct) totals.steepestDescentPct = span.gradePct;
        }
        return totals;
    }

    function formatGradePct(gradePct) {
        const grade = num(gradePct);
        if (!Number.isFinite(grade)) return '—';
        if (Math.abs(grade) < FLAT_GRADE_PCT) return '0%';
        const sign = grade > 0 ? '+' : '−';
        return `${sign}${Math.abs(grade).toFixed(1)}%`;
    }

    return {
        FLAT_GRADE_PCT,
        FLAT_COLOR,
        GRADE_BANDS,
        gradeBand,
        bandColor,
        bandDashArray,
        isOverLimitBand,
        mergeSpansByBand,
        gradeColor,
        classify,
        gradeSpans,
        summarize,
        formatGradePct,
    };
}));
