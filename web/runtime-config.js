(function () {
    function stripTrailingSlash(value) {
        return String(value || '').replace(/\/+$/, '');
    }

    function getAppBasePath(pathname) {
        const value = String(pathname || '');
        const lastSlashIndex = value.lastIndexOf('/');

        if (lastSlashIndex <= 0) {
            return '';
        }

        return value.slice(0, lastSlashIndex);
    }

    function isLocalFrontend(hostname) {
        return hostname === 'localhost' || hostname === '127.0.0.1';
    }

    // Dev-only: ?apiPort=3011 points the page at another local API instance
    // (e.g. a feature-branch API running beside the docker one on 3001). A
    // port number only, honoured only on a localhost frontend — so a shared
    // link can never redirect a deployed page's API calls anywhere.
    function getLocalApiPortOverride(search, isLocal) {
        if (!isLocal) return null;
        const port = Number(new URLSearchParams(search).get('apiPort'));
        return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
    }

    const city = window.__TRANSIT_CITY_CONFIG__ || {};
    const capabilityApi = window.__transitCityCapabilities;
    const capabilities = capabilityApi?.resolve(city) || Object.freeze({ campaigns: false });
    const override = window.__TRANSIT_APP_CONFIG__ || {};
    const isLocal = isLocalFrontend(window.location.hostname);
    // Service URLs belong to the planner deployment rather than to a city pack.
    const scriptPath = document.currentScript?.src
        ? new URL(document.currentScript.src, window.location.href).pathname
        : window.location.pathname;
    const appBasePath = getAppBasePath(scriptPath);
    const apiPortOverride = getLocalApiPortOverride(window.location.search, isLocal);

    const fallbackValhallaIsochroneUrl = isLocal
        ? 'http://localhost:8002/isochrone'
        : `${window.location.origin}${appBasePath}/api/isochrone`;
    const fallbackApiBaseUrl = isLocal
        ? `http://localhost:${apiPortOverride || 3001}/api`
        : `${window.location.origin}${appBasePath}/api`;
    const needsPlannerApi = ['terrain', 'population', 'jobs', 'referenceTransit', 'referenceRail', 'persistence']
        .some(capability => capabilities[capability] === true);
    // The relief viewer (hr-reljef) is a SIBLING of this app, not something
    // under its base path: the planner is at /prijevoz and the viewer at
    // /reljef, so appBasePath must not be in this one. Locally it is its own
    // dev server on its own port. Left undefined here means "work it out from
    // the location" — see relief-viewer-link.js, which owns that rule so it can
    // be tested; this is only the override hook.
    const reliefViewerBaseUrl = override.reliefViewerBaseUrl
        ? stripTrailingSlash(override.reliefViewerBaseUrl)
        : null;

    window.__TRANSIT_RUNTIME_CONFIG__ = Object.freeze({
        city,
        capabilities,
        valhallaIsochroneUrl: capabilities.routing
            ? (override.valhallaIsochroneUrl
                || city.providers?.valhallaIsochroneUrl
                || fallbackValhallaIsochroneUrl)
            : null,
        apiBaseUrl: needsPlannerApi
            ? stripTrailingSlash(override.apiBaseUrl
                || city.providers?.apiBaseUrl
                || fallbackApiBaseUrl)
            : null,
        reliefViewerBaseUrl,
        // Cesium ion token override hook: lets the token be rotated via config
        // (window.__TRANSIT_APP_CONFIG__) instead of editing source. null means
        // "no override" — the Station3D consumer keeps its
        // own default in that case.
        ionToken: override.ionToken || null,
    });

    capabilityApi?.apply(document, capabilities);
})();
