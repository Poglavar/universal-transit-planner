// Existing railway projects drawn as read-only context in the map and 3D world.
// A reference can carry a solved EVRF2000 profile or 2D geometry imported
// offline from a local OSM PBF and deliberately draped on terrain.
//
// This file is the pure part: which area to ask the API for, and how to tag the
// returned spans so Station3D's rail layer treats them as an engineered
// alignment. Fetching and drawing live in transit.js.
//
// Exposed as window.__railReferenceProjects for classic scripts.
(function (root) {
    'use strict';

    const EARTH_RADIUS_M = 6371000;
    const DEG_TO_RAD = Math.PI / 180;

    // Mirror of RAILS_RENDER_RADIUS_M in station-3d/world/rails.js: how far from
    // the camera that layer builds rail geometry. Duplicated because a classic
    // script cannot import the ES module; rail-reference-projects.test.mjs fails if
    // the two drift apart.
    const RAILS_RENDER_RADIUS_M = 3500;

    // How far beyond the session's own geometry we ask for reference rail. It must
    // exceed the render radius above: the span we fetch is CUT at that distance,
    // and a cut end inside the render window would be drawn — a railway ending
    // in mid-air, with a tunnel portal or a viaduct deck stopping at nothing.
    // Beyond it, the cut can never be reached by the renderer.
    const AREA_MARGIN_M = 4000;

    const SOURCE = 'reference-project';

    function inflateBbox(bbox, marginM) {
        const latPad = marginM / (EARTH_RADIUS_M * DEG_TO_RAD);
        const midLat = (bbox.south + bbox.north) / 2;
        const cos = Math.max(0.05, Math.cos(midLat * DEG_TO_RAD));
        const lngPad = latPad / cos;
        return {
            west: bbox.west - lngPad,
            south: bbox.south - latPad,
            east: bbox.east + lngPad,
            north: bbox.north + latPad,
        };
    }

    // The box a session can see: everything it has drawn (plus the spawn point),
    // grown by AREA_MARGIN_M. For a Trogir–Split route that leaves the whole
    // Perković half of the M604 unfetched — it is never rendered, never smoothed,
    // and never enters the rail formation model.
    function areaOfInterestBbox(points, options) {
        const marginM = Number(options && options.marginM);
        const margin = Number.isFinite(marginM) ? marginM : AREA_MARGIN_M;
        let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
        for (const point of points || []) {
            const lat = Number(point && point[0]);
            const lng = Number(point && point[1]);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
            west = Math.min(west, lng);
            east = Math.max(east, lng);
            south = Math.min(south, lat);
            north = Math.max(north, lat);
        }
        if (!Number.isFinite(west)) return null;
        return inflateBbox({ west, south, east, north }, margin);
    }

    function bboxQueryValue(bbox) {
        if (!bbox) return null;
        return [bbox.west, bbox.south, bbox.east, bbox.north]
            .map(value => Number(value).toFixed(5))
            .join(',');
    }

    // Cache key: a box that moved less than ~100 m is the same request.
    function bboxCacheKey(bbox) {
        if (!bbox) return '';
        return [bbox.west, bbox.south, bbox.east, bbox.north]
            .map(value => Number(value).toFixed(3))
            .join(',');
    }

    function requestCacheKey({
        locationId,
        bbox,
        savedProjectId,
    } = {}) {
        if (!bbox) return '';
        return `${locationId || ''}|${bboxCacheKey(bbox)}`
            + `|${savedProjectId ?? 'unsaved'}`;
    }

    function loadedRequestMatches(request, key) {
        return !!key && request?.key === key && !!request.collection;
    }

    function haversineM(a, b) {
        const lat1 = Number(a?.[0]) * DEG_TO_RAD;
        const lat2 = Number(b?.[0]) * DEG_TO_RAD;
        const deltaLat = lat2 - lat1;
        const deltaLng = (Number(b?.[1]) - Number(a?.[1])) * DEG_TO_RAD;
        if (![lat1, lat2, deltaLat, deltaLng].every(Number.isFinite)) return Infinity;
        const sinLat = Math.sin(deltaLat / 2);
        const sinLng = Math.sin(deltaLng / 2);
        const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
        return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    function finiteLatLng(point) {
        const lat = Number(point?.[0]);
        const lng = Number(point?.[1]);
        return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
    }

    // Bounds for the open project plus only its directly connected reference
    // spans. This gives the layer toggle useful one-hop context without zooming
    // from Gračac all the way out to every prepared line in Zagreb and Split.
    function connectedContext(collection, tracks, options) {
        const toleranceM = Number.isFinite(Number(options?.toleranceM))
            ? Number(options.toleranceM)
            : 150;
        const projectPoints = [];
        const projectEndpoints = [];
        for (const track of tracks || []) {
            const points = (track?.latlngs || []).map(finiteLatLng).filter(Boolean);
            if (!points.length) continue;
            projectPoints.push(...points);
            projectEndpoints.push(points[0], points[points.length - 1]);
        }
        if (!projectPoints.length || !projectEndpoints.length) return null;
        const connected = [];
        for (const feature of collection?.features || []) {
            const coordinates = feature?.geometry?.coordinates || [];
            if (coordinates.length < 2) continue;
            const endpoints = [
                finiteLatLng([coordinates[0][1], coordinates[0][0]]),
                finiteLatLng([coordinates[coordinates.length - 1][1], coordinates[coordinates.length - 1][0]]),
            ].filter(Boolean);
            const touches = endpoints.some(endpoint => projectEndpoints.some(
                projectEndpoint => haversineM(endpoint, projectEndpoint) <= toleranceM,
            ));
            if (touches) connected.push(feature);
        }
        if (!connected.length) return null;
        const allPoints = [...projectPoints];
        for (const feature of connected) {
            for (const coordinate of feature.geometry.coordinates || []) {
                const point = finiteLatLng([coordinate[1], coordinate[0]]);
                if (point) allPoints.push(point);
            }
        }
        const lats = allPoints.map(point => point[0]);
        const lngs = allPoints.map(point => point[1]);
        return {
            south: Math.min(...lats),
            west: Math.min(...lngs),
            north: Math.max(...lats),
            east: Math.max(...lngs),
            connectedFeatureCount: connected.length,
            connectedProjectIds: [...new Set(connected
                .map(feature => Number(feature?.properties?.projectId))
                .filter(Number.isFinite))],
        };
    }

    // A missing ordinate drops the whole span rather than defaulting to 0: an
    // absolute alignment silently pinned to sea level would be drawn buried or
    // floating, which reads as a rendering bug rather than missing data.
    const numeric = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

    function featureFrom(span, elevationOf, extraProperties) {
        const coordinates = [];
        for (const coordinate of span.geometry.coordinates || []) {
            const lng = numeric(coordinate[0]);
            const lat = numeric(coordinate[1]);
            const railHeadM = numeric(coordinate[2]);
            if (lng === null || lat === null || railHeadM === null) return null;
            const elevationM = numeric(elevationOf(railHeadM));
            if (elevationM === null) return null;
            coordinates.push([lng, lat, elevationM]);
        }
        if (coordinates.length < 2) return null;
        const properties = span.properties || {};
        return {
            type: 'Feature',
            properties: Object.assign({
                source: SOURCE,
                trackType: properties.gauge || 'g1435',
                trackCount: Number(properties.trackCount) || 1,
                trackArrangement: properties.trackArrangement || 'single',
                referenceRef: properties.ref || null,
                referenceName: properties.name || null,
                referenceProjectId: properties.projectId || null,
                referenceSegmentKey: properties.segmentKey || null,
                // Stable reconstruction identity, independent of the mutable
                // database project id. Station3D uses this to attach tightly
                // scoped OSM context (for example Split's station throat and
                // companion tunnel track) only to the matching solved line.
                referenceSourceId: properties.sourceId || properties.profileId || null,
                referenceProvenance: properties.provenance || null,
                // Exact display spans are clipped out of a much longer solved
                // profile. Keep their original chainage axis and compact civil
                // runs together: Station3D can then honour the published
                // tunnel/viaduct boundaries instead of re-guessing them from
                // whichever terrain window happens to be loaded around the cab.
                railSourceChainagesM: Array.isArray(properties.chainagesM)
                    ? properties.chainagesM.slice() : [],
                railCivilRuns: Array.isArray(properties.civilRuns)
                    ? properties.civilRuns.map(run => Object.assign({}, run)) : [],
                electrified: properties.electrified ?? null,
                voltage: properties.voltage ?? null,
                frequency: properties.frequency ?? null,
                electrificationSegments: properties.electrificationSegments || [],
            }, extraProperties),
            geometry: { type: 'LineString', coordinates },
        };
    }

    // Tag the fetched spans for Station3D's otherTracks. The elevation regime is
    // the SAME decision the planner makes for its own tracks:
    //   photo session  → heights relative to the session datum ('asl')
    //   model + terrain→ absolute EVRF2000 heights
    //   flat model     → nothing. Absolute heights need a terrain surface to be
    //                    seated on; on a flat world they would hang the whole
    //                    line ~100 m above the ground plane.
    // These features are for DRAWING only — never for driverTracks or
    // customTrackCorridors, or the player could drive onto the existing railway
    // and the planner's civil works would follow it.
    function terrainDrapedFeature(span) {
        const coordinates = [];
        for (const coordinate of span.geometry.coordinates || []) {
            const lng = numeric(coordinate[0]);
            const lat = numeric(coordinate[1]);
            if (lng === null || lat === null) return null;
            coordinates.push([lng, lat, 0]);
        }
        if (coordinates.length < 2) return null;
        return featureFrom(
            { ...span, geometry: { ...span.geometry, coordinates: coordinates.map(
                ([lng, lat]) => [lng, lat, 0],
            ) } },
            () => 0,
            { elevationMode: 'terrain' },
        );
    }

    function referenceFeatures(collection, options) {
        const opts = options || {};
        const spans = (collection && collection.features) || [];
        const terrainDraped = opts.solvedOnly ? [] : spans
            .filter(span => span?.properties?.elevationMode === 'terrain')
            .map(terrainDrapedFeature)
            .filter(Boolean);
        const absolute = spans.filter(span => span?.properties?.elevationMode !== 'terrain');
        // Strict again: model sessions pass photoDatumM = null, and Number(null)
        // is 0 — which reads as a perfectly valid photo datum and would tag an
        // absolute EVRF2000 alignment as session-relative 'asl'.
        const photoDatumM = numeric(opts.photoDatumM);
        if (photoDatumM !== null) {
            return terrainDraped.concat(absolute
                .map(span => featureFrom(span, z => z - photoDatumM, { elevationDatum: 'asl' }))
                .filter(Boolean));
        }
        if (!opts.modelTerrainActive) return terrainDraped;
        return terrainDraped.concat(absolute
            .map(span => featureFrom(span, z => z, {
                elevationMode: 'absolute',
                elevationDatum: 'EVRF2000',
            }))
            .filter(Boolean));
    }

    root.__railReferenceProjects = {
        SOURCE,
        AREA_MARGIN_M,
        RAILS_RENDER_RADIUS_M,
        areaOfInterestBbox,
        bboxQueryValue,
        bboxCacheKey,
        requestCacheKey,
        loadedRequestMatches,
        connectedContext,
        referenceFeatures,
    };
}(typeof self !== 'undefined' ? self : this));
