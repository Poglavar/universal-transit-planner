// Pure wheel-gesture accumulator for the objekti ortho pane: turns a stream
// of wheel events into whole zoom-level steps. The pane runs zoomSnap 0 so
// Leaflet's own wheel zoom moves in fractions of a level, which the pane
// sync rounds straight back — whole-level steps are the only wheel motion
// the synced pair can keep. UMD so the page and node tests share one copy.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__orthoPaneZoom = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // One step per this much accumulated wheel travel — Leaflet's
    // wheelPxPerZoomLevel default, so both panes need similar effort.
    const PX_PER_STEP = 60;
    // A pause this long (or a direction flip) starts a new gesture, so a
    // stale remainder from an old swipe cannot leak into the next one.
    const GESTURE_BREAK_MS = 400;

    function createWheelStepper(options) {
        const settings = Object.assign(
            { pxPerStep: PX_PER_STEP, gestureBreakMs: GESTURE_BREAK_MS }, options);
        let accumulated = 0;
        let lastTime = -Infinity;
        return {
            // Feed one wheel event (timeStamp in ms, deltaY in px — wheel up
            // / pinch out is negative). Returns +1 to zoom in a whole level,
            // -1 to zoom out, 0 to keep accumulating.
            push(timeStamp, deltaY) {
                if (!deltaY) return 0; // horizontal-only scroll — not ours
                const flipped = accumulated !== 0
                    && (accumulated > 0) !== (deltaY > 0);
                if (flipped || timeStamp - lastTime > settings.gestureBreakMs) {
                    accumulated = 0;
                }
                lastTime = timeStamp;
                accumulated += deltaY;
                if (Math.abs(accumulated) < settings.pxPerStep) return 0;
                const step = accumulated < 0 ? 1 : -1;
                accumulated = 0; // one level per crossing; remainder is noise
                return step;
            },
        };
    }

    return { createWheelStepper, PX_PER_STEP, GESTURE_BREAK_MS };
}));
