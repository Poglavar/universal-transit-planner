// The link from the planner to the relief viewer (hr-reljef).
//
// The viewer takes `?projekt=140`, or `?projekti=140,133` for several, and
// frames what it loads when the link carries no camera — which is exactly what
// is wanted here, so this deliberately passes NO lon/lat/h. Handing it the
// planner's map centre would open the viewer looking at wherever the user had
// scrolled to rather than at the proposal.
//
// It reads the SAVED project from the API, so a link is only meaningful for a
// project that has been saved and has no pending edits; the caller enforces
// that, and this returns an empty string when there is no id to point at.
//
// UMD so it stays a classic script in the page and can still be required by the
// node tests. Pure — no DOM, no fetch.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ReliefViewerLink = api;
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // The viewer is a SIBLING of the planner on the deployed host, not something
    // under its base path: the planner lives at /prijevoz and the viewer at
    // /reljef. Deriving it from the app base path would produce
    // /prijevoz/reljef, which is nothing.
    const DEPLOYED_PATH = '/reljef';
    // hr-reljef's own dev server default (see its README). Only ever used from a
    // localhost page.
    const LOCAL_ORIGIN = 'http://localhost:8093';

    function stripTrailingSlash(value) {
        return String(value || '').replace(/\/+$/, '');
    }

    function isLocalFrontend(hostname) {
        return hostname === 'localhost' || hostname === '127.0.0.1';
    }

    // Mirrors runtime-config.js's local-vs-deployed split, for the same reason:
    // in development the two apps are separate origins on separate ports, and
    // deployed they are two paths on one host.
    function reliefViewerBaseUrl(location, override) {
        if (override) return stripTrailingSlash(override);
        const hostname = location && location.hostname;
        if (isLocalFrontend(hostname)) return LOCAL_ORIGIN;
        const origin = (location && location.origin) || '';
        return `${stripTrailingSlash(origin)}${DEPLOYED_PATH}`;
    }

    // Positive integers only, in order, without duplicates. A project id comes
    // from app state rather than from a user, but Number(null) is 0 and a "0"
    // in the query would send the viewer looking for a project that cannot
    // exist — silently, since it would simply find nothing to draw.
    function normalizeProjectIds(value) {
        const list = Array.isArray(value) ? value : [value];
        const seen = [];
        for (const entry of list) {
            const id = Number(entry);
            if (!Number.isInteger(id) || id <= 0) continue;
            if (seen.indexOf(id) === -1) seen.push(id);
        }
        return seen;
    }

    function reliefViewerUrl(baseUrl, projectIds) {
        const ids = normalizeProjectIds(projectIds);
        if (ids.length === 0) return '';
        const base = stripTrailingSlash(baseUrl);
        // The singular reads better for the usual case of one project, and the
        // viewer accepts either.
        const query = ids.length === 1
            ? `projekt=${ids[0]}`
            : `projekti=${ids.join(',')}`;
        return `${base}/?${query}`;
    }

    return {
        DEPLOYED_PATH,
        LOCAL_ORIGIN,
        normalizeProjectIds,
        reliefViewerBaseUrl,
        reliefViewerUrl,
    };
}));
