(function exposeCityPackLoader(root, factory) {
    const api = factory(root || {});
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__transitCityPack = api;
}(typeof window !== 'undefined' ? window : globalThis, function buildCityPackLoader(root) {
    'use strict';

    const PHASES = Object.freeze(['prePlanner', 'simulation']);

    function scriptsForPhase(city, phase) {
        if (!PHASES.includes(phase)) return [];
        const scripts = city?.cityPack?.[phase];
        if (!Array.isArray(scripts)) return [];
        return scripts.filter(script => (
            typeof script === 'string'
            && script.startsWith('city-pack/')
            && !script.split('/').includes('..')
            && script.endsWith('.js')
        ));
    }

    function load(phase, documentRef = root.document) {
        const city = root.__TRANSIT_RUNTIME_CONFIG__?.city || root.__TRANSIT_CITY_CONFIG__ || {};
        const scripts = scriptsForPhase(city, phase);
        if (!documentRef || scripts.length === 0) return scripts;
        if (documentRef.readyState !== 'loading') {
            throw new Error(`City-pack phase ${phase} must load while the document is parsing`);
        }
        for (const source of scripts) {
            documentRef.write(`<script src="${source}"><\/script>`);
        }
        return scripts;
    }

    return Object.freeze({ PHASES, load, scriptsForPhase });
}));
