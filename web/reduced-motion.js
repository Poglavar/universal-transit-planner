// Honours the OS "reduce motion" accessibility setting for Leaflet maps, with a
// ?reduceMotion URL override for drivers that cannot emulate media queries (a browser
// extension). Leaflet's animated zoom rides on requestAnimationFrame, which Chrome
// freezes in hidden or occluded tabs, so an agent driving a background tab can never
// observe a zoom finish; with motion reduced the transition is synchronous and the end
// state is directly assertable.
//
// This ONLY ever turns animation off. When motion is not reduced it calls nothing and
// changes no Leaflet default, so rendering is byte-identical to not loading the file.
// Uses L.Map.mergeOptions (Leaflet's own API for class defaults) so a call site that
// passes an explicit animation option still wins.
//
// Must load after Leaflet and before any map is constructed.
(function (global) {
    'use strict';

    var reduce = false;
    try {
        reduce = new global.URLSearchParams(global.location.search).has('reduceMotion')
            || !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
        reduce = false; // no location/matchMedia: leave animation exactly as it was
    }

    global.__reducedMotion = reduce;

    if (!reduce) return;

    var L = global.L;
    if (L && L.Map && typeof L.Map.mergeOptions === 'function') {
        L.Map.mergeOptions({
            zoomAnimation: false,
            fadeAnimation: false,
            markerZoomAnimation: false
        });
    }
})(typeof window !== 'undefined' ? window : globalThis);
