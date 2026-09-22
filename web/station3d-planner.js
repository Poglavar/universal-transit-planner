// Product adapter for the independently packaged Station3D engine. City data
// is injected by the selected manifest; world rules remain inside Station3D.
(function initPlannerStation3D(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root || !root.document) return;
    root.__transitPlannerStation3DConfig = api;
    root.__station3DAssetConfig = Object.freeze({
        rootUrl: new URL('vendor/station3d/', root.location.href).href,
    });
    root.__transitPlannerStation3DReady = api.install(root);
}(typeof window === 'undefined' ? null : window, function createPlannerStation3DAdapter() {
    'use strict';

    const DEFAULT_WORLD_PROFILE = Object.freeze({
        id: 'default',
        buildings: 'overture',
        farBuildings: true,
        decorEnabled: false,
        apiDecor: true,
        passengers: false,
        water: true,
        terrain: Object.freeze({
            surfaceStyle: 'grass',
            source: 'copernicus-glo30',
        }),
    });

    function createConfiguration(runtimeConfig = {}) {
        if (!runtimeConfig.apiBaseUrl) {
            throw new Error('Station3D requires the planner API base URL');
        }
        const city = runtimeConfig.city || {};
        const worldProfile = city.station3d?.worldProfile || DEFAULT_WORLD_PROFILE;
        return Object.freeze({
            world: Object.freeze({
                id: `transit-planner-${city.id || 'default'}`,
                apiBaseUrl: runtimeConfig.apiBaseUrl,
                bounds: city.bounds || null,
                attributions: Object.freeze(city.attributions || []),
                worldProfile,
            }),
            host: Object.freeze({
                name: city.name ? `${city.name} Transit Planner` : 'Universal Transit Planner',
                devOverlays: true,
                campaigns: false,
            }),
        });
    }

    function configure(station3D, runtimeConfig) {
        if (!station3D || typeof station3D.configureWorld !== 'function'
            || typeof station3D.configureHost !== 'function') {
            throw new Error('Installed Station3D package does not expose configuration APIs');
        }
        const configuration = createConfiguration(runtimeConfig);
        station3D.configureWorld(configuration.world);
        station3D.configureHost(configuration.host);
        return station3D;
    }

    function waitForPackageLoader(root) {
        if (root.__station3DReady) return Promise.resolve(root.__station3DReady);
        return new Promise((resolve) => {
            root.addEventListener('station3d:loader-ready', () => {
                resolve(root.__station3DReady);
            }, { once: true });
        }).then(ready => ready);
    }

    async function install(root) {
        const station3D = await waitForPackageLoader(root);
        return configure(station3D, root.__TRANSIT_RUNTIME_CONFIG__ || {});
    }

    return Object.freeze({ DEFAULT_WORLD_PROFILE, createConfiguration, configure, install });
}));
