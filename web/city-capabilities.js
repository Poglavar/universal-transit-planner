(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__transitCityCapabilities = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    const CAPABILITIES = Object.freeze([
        'routing',
        'terrain',
        'terrainTiles',
        'population',
        'jobs',
        'referenceTransit',
        'referenceRail',
        'station3d',
        'persistence',
        'campaigns',
    ]);

    function resolve(city) {
        const declared = city?.features || {};
        const capabilities = {};
        for (const name of CAPABILITIES) capabilities[name] = declared[name] === true;
        capabilities.campaigns = false;
        return Object.freeze(capabilities);
    }

    function supports(capabilities, requirement) {
        const names = String(requirement || '')
            .split(',')
            .map(name => name.trim())
            .filter(Boolean);
        return names.every(name => capabilities?.[name] === true);
    }

    function apply(rootNode, capabilities) {
        if (!rootNode?.querySelectorAll) return;
        for (const element of rootNode.querySelectorAll('[data-requires-capability]')) {
            if (supports(capabilities, element.dataset.requiresCapability)) continue;
            element.hidden = true;
            element.classList.add('capability-unavailable');
            element.setAttribute('aria-hidden', 'true');
            for (const control of element.querySelectorAll('button, input, select, textarea')) {
                control.disabled = true;
            }
        }
    }

    return Object.freeze({ CAPABILITIES, resolve, supports, apply });
});
