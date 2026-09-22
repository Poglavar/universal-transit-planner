// Railway simulation: animates trains along real tracks using GTFS schedules.
// Loads rail tracks (GeoJSON) and schedule data, then moves train markers on the Leaflet map.

(function () {
    'use strict';

    const TRACKS_URL = 'city-pack/data/zagreb_rail_tracks.geojson';
    const SCHEDULE_URL = 'city-pack/data/zagreb_rail_schedule.json';
    const UPDATE_INTERVAL_MS = 50;
    // Keep heavy-rail cab mode aligned with Station3D's elevated viaduct:
    // deck top 7.5 m + half the 0.12 m rail height.
    const ELEVATED_RAIL_BASE_Y = 7.56;
    // Snap tolerance: stops within this distance of a track node become graph nodes
    const SNAP_TOLERANCE_M = 150;
    // Grid cell size for spatial index (in degrees, ~100m)
    const GRID_CELL = 0.001;

    // ─── State ─────────────────────────────────────────────────────────────
    let trackFeatures = [];
    let schedule = [];
    let trainMarkers = new Map();
    let trackLayer = null;
    let animationTimer = null;
    let simEnabled = false;
    let scheduleLoaded = false;
    let mapUpdatesSuspended = false;
    let canonicalTrackFeatures = null;
    let osmTrackFeatures = [];
    let initPromise = null;

    // Track network graph
    // Nodes: Map<nodeKey, {lat, lng}>
    // Edges: Map<nodeKey, [{to: nodeKey, dist: number, path: [{lat,lng}]}]>
    let graphNodes = new Map();
    let graphEdges = new Map();

    // Spatial index for fast nearest-node lookup
    let nodeGrid = new Map();

    // ─── Helpers ───────────────────────────────────────────────────────────

    function haversineMeters(lat1, lng1, lat2, lng2) {
        const R = 6371000;
        const toRad = d => d * Math.PI / 180;
        const dLat = toRad(lat2 - lat1);
        const dLng = toRad(lng2 - lng1);
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // Round coords to make a stable key (7 decimal places ~ 1cm precision)
    function nodeKey(lat, lng) {
        return `${lat.toFixed(7)},${lng.toFixed(7)}`;
    }

    function gridKey(lat, lng) {
        return `${Math.floor(lat / GRID_CELL)},${Math.floor(lng / GRID_CELL)}`;
    }

    function addToGrid(key, lat, lng) {
        const gk = gridKey(lat, lng);
        if (!nodeGrid.has(gk)) nodeGrid.set(gk, []);
        nodeGrid.get(gk).push(key);
    }

    function findNearestNode(lat, lng) {
        const gLat = Math.floor(lat / GRID_CELL);
        const gLng = Math.floor(lng / GRID_CELL);
        let bestKey = null;
        let bestDist = Infinity;

        for (let di = -2; di <= 2; di++) {
            for (let dj = -2; dj <= 2; dj++) {
                const candidates = nodeGrid.get(`${gLat + di},${gLng + dj}`);
                if (!candidates) continue;
                for (const key of candidates) {
                    const node = graphNodes.get(key);
                    const d = haversineMeters(lat, lng, node.lat, node.lng);
                    if (d < bestDist) {
                        bestDist = d;
                        bestKey = key;
                    }
                }
            }
        }
        return { key: bestKey, dist: bestDist };
    }

    // ─── Build Track Network Graph ─────────────────────────────────────────

    function buildGraph() {
        graphNodes.clear();
        graphEdges.clear();
        nodeGrid = new Map();

        // Merge nearby nodes (OSM features often have slightly different coords at junctions)
        // Small tolerance only for floating-point safety — OSM data is topologically correct
        const NODE_MERGE_TOLERANCE_M = 1;

        function getOrCreateNode(lat, lng) {
            const nearest = findNearestNode(lat, lng);
            if (nearest.key && nearest.dist < NODE_MERGE_TOLERANCE_M) {
                return nearest.key;
            }
            const key = nodeKey(lat, lng);
            if (!graphNodes.has(key)) {
                graphNodes.set(key, { lat, lng });
                addToGrid(key, lat, lng);
                graphEdges.set(key, []);
            }
            return key;
        }

        for (const feature of trackFeatures) {
            const coords = feature.geometry.coordinates; // [lng, lat]
            if (coords.length < 2) continue;

            const keys = coords.map(([lng, lat]) => getOrCreateNode(lat, lng));

            for (let i = 0; i < keys.length - 1; i++) {
                const fromKey = keys[i];
                const toKey = keys[i + 1];
                if (fromKey === toKey) continue;

                const fromCoord = coords[i];
                const toCoord = coords[i + 1];
                const dist = haversineMeters(fromCoord[1], fromCoord[0], toCoord[1], toCoord[0]);

                const existingEdges = graphEdges.get(fromKey);
                if (!existingEdges.some(e => e.to === toKey)) {
                    existingEdges.push({
                        to: toKey,
                        dist,
                        path: [
                            { lat: fromCoord[1], lng: fromCoord[0] },
                            { lat: toCoord[1], lng: toCoord[0] },
                        ],
                    });
                }
                const reverseEdges = graphEdges.get(toKey);
                if (!reverseEdges.some(e => e.to === fromKey)) {
                    reverseEdges.push({
                        to: fromKey,
                        dist,
                        path: [
                            { lat: toCoord[1], lng: toCoord[0] },
                            { lat: fromCoord[1], lng: fromCoord[0] },
                        ],
                    });
                }
            }
        }

        console.log(`Railway graph: ${graphNodes.size} nodes, ${[...graphEdges.values()].reduce((s, e) => s + e.length, 0)} edges`);
    }

    // Dijkstra shortest path between two graph nodes
    function dijkstra(fromKey, toKey) {
        if (fromKey === toKey) return { dist: 0, path: [] };

        const dist = new Map();
        const prev = new Map();
        const prevEdge = new Map();
        const visited = new Set();

        // Simple priority queue using array (graph is small enough)
        const queue = [];
        dist.set(fromKey, 0);
        queue.push({ key: fromKey, d: 0 });

        while (queue.length > 0) {
            // Find min
            let minIdx = 0;
            for (let i = 1; i < queue.length; i++) {
                if (queue[i].d < queue[minIdx].d) minIdx = i;
            }
            const { key: u, d: uDist } = queue.splice(minIdx, 1)[0];

            if (visited.has(u)) continue;
            visited.add(u);

            if (u === toKey) break;

            const edges = graphEdges.get(u) || [];
            for (const edge of edges) {
                const newDist = uDist + edge.dist;
                if (!dist.has(edge.to) || newDist < dist.get(edge.to)) {
                    dist.set(edge.to, newDist);
                    prev.set(edge.to, u);
                    prevEdge.set(edge.to, edge);
                    queue.push({ key: edge.to, d: newDist });
                }
            }
        }

        if (!prev.has(toKey)) return null; // No path found

        // Reconstruct path
        const pathSegments = [];
        let current = toKey;
        while (prev.has(current)) {
            const edge = prevEdge.get(current);
            pathSegments.unshift(edge.path);
            current = prev.get(current);
        }

        // Flatten path segments, removing duplicate junction points
        const fullPath = [];
        for (const seg of pathSegments) {
            for (let i = 0; i < seg.length; i++) {
                if (i === 0 && fullPath.length > 0) continue; // Skip duplicate junction
                fullPath.push(seg[i]);
            }
        }

        return { dist: dist.get(toKey), path: fullPath };
    }

    // Project (pLat, pLng) onto the closest rail edge segment in the
    // graph. Returns { lat, lng, distM } of the projection, or null if
    // no rail edge sits within `maxDistM`. Used to snap a stop's OSM
    // coord onto the actual rail centerline so:
    //   • the path between two stops starts and ends ON the rail (no
    //     visible "float" off the elevated viaduct on approach/depart)
    //   • the train still arrives at the station, instead of stopping
    //     at the nearest rail NODE, which can be hundreds of metres
    //     from the actual platform at major junctions like Glavni
    //     kolodvor.
    function projectStopOntoRail(pLat, pLng, maxDistM) {
        const cap = Number.isFinite(maxDistM) ? maxDistM : SNAP_TOLERANCE_M * 6;
        const cosLat = Math.cos(pLat * Math.PI / 180);
        const M_PER_DEG_LAT = 110540;
        const M_PER_DEG_LNG = 111320 * cosLat;
        let bestLat = null, bestLng = null;
        let bestDist = cap;
        for (const edges of graphEdges.values()) {
            for (const edge of edges) {
                const path = edge.path;
                if (!path || path.length < 2) continue;
                for (let i = 0; i < path.length - 1; i++) {
                    const a = path[i];
                    const b = path[i + 1];
                    const ax = (a.lng - pLng) * M_PER_DEG_LNG;
                    const ay = (a.lat - pLat) * M_PER_DEG_LAT;
                    const bx = (b.lng - pLng) * M_PER_DEG_LNG;
                    const by = (b.lat - pLat) * M_PER_DEG_LAT;
                    const dx = bx - ax, dy = by - ay;
                    const len2 = dx * dx + dy * dy;
                    if (len2 < 1e-9) continue;
                    let t = -((ax * dx) + (ay * dy)) / len2;
                    if (t < 0) t = 0;
                    else if (t > 1) t = 1;
                    const projX = ax + t * dx;
                    const projY = ay + t * dy;
                    const distM = Math.hypot(projX, projY);
                    if (distM < bestDist) {
                        bestDist = distM;
                        bestLat = a.lat + t * (b.lat - a.lat);
                        bestLng = a.lng + t * (b.lng - a.lng);
                    }
                }
            }
        }
        return bestLat == null ? null : { lat: bestLat, lng: bestLng, distM: bestDist };
    }

    // Find path between two lat/lng points via the track graph. The
    // input coords are typically a stop's OSM lat/lng — the function
    // projects them onto the rail centerline before pathing, so the
    // returned path's first and last points are ON the rail (no off-
    // rail bookends jutting out toward the original stop coord).
    function findTrackPath(fromLat, fromLng, toLat, toLng) {
        const fromProj = projectStopOntoRail(fromLat, fromLng) || { lat: fromLat, lng: fromLng };
        const toProj   = projectStopOntoRail(toLat, toLng)     || { lat: toLat, lng: toLng };
        const from = findNearestNode(fromProj.lat, fromProj.lng);
        const to   = findNearestNode(toProj.lat, toProj.lng);

        if (!from.key || !to.key || from.dist > SNAP_TOLERANCE_M * 3 || to.dist > SNAP_TOLERANCE_M * 3) {
            return buildStraightPath(fromLat, fromLng, toLat, toLng);
        }

        const result = dijkstra(from.key, to.key);
        if (!result || result.path.length === 0) {
            return buildStraightPath(fromLat, fromLng, toLat, toLng);
        }

        // Bookend with the rail-projected stop coords — both are on the
        // rail by construction, so the returned path is fully on-rail
        // AND lands at (effectively) the actual station instead of at
        // the nearest rail NODE, which can be hundreds of metres away
        // from a platform at big junctions.
        return [
            { lat: fromProj.lat, lng: fromProj.lng },
            ...result.path,
            { lat: toProj.lat,   lng: toProj.lng   },
        ];
    }

    function buildStraightPath(fromLat, fromLng, toLat, toLng) {
        const steps = 10;
        const path = [];
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            path.push({
                lat: fromLat + t * (toLat - fromLat),
                lng: fromLng + t * (toLng - fromLng),
            });
        }
        return path;
    }

    // Compute cumulative distances along a path
    function pathWithDistances(path) {
        const result = [{ lat: path[0].lat, lng: path[0].lng, dist: 0 }];
        let cum = 0;
        for (let i = 1; i < path.length; i++) {
            cum += haversineMeters(path[i - 1].lat, path[i - 1].lng, path[i].lat, path[i].lng);
            result.push({ lat: path[i].lat, lng: path[i].lng, dist: cum });
        }
        return result;
    }

    // Interpolate position along a path at a given distance
    function interpolateOnPath(pathDists, distance) {
        if (distance <= 0) return { lat: pathDists[0].lat, lng: pathDists[0].lng };
        const last = pathDists[pathDists.length - 1];
        if (distance >= last.dist) return { lat: last.lat, lng: last.lng };

        for (let i = 1; i < pathDists.length; i++) {
            if (pathDists[i].dist >= distance) {
                const prev = pathDists[i - 1];
                const segLen = pathDists[i].dist - prev.dist;
                if (segLen === 0) return { lat: prev.lat, lng: prev.lng };
                const t = (distance - prev.dist) / segLen;
                return {
                    lat: prev.lat + t * (pathDists[i].lat - prev.lat),
                    lng: prev.lng + t * (pathDists[i].lng - prev.lng),
                };
            }
        }
        return { lat: last.lat, lng: last.lng };
    }

    // ─── Precompute trip segments ──────────────────────────────────────────

    function precomputeTrips() {
        for (const trip of schedule) {
            trip._segments = [];
            for (let i = 0; i < trip.stops.length - 1; i++) {
                const from = trip.stops[i];
                const to = trip.stops[i + 1];
                const path = findTrackPath(from.lat, from.lng, to.lat, to.lng);
                const pathDists = pathWithDistances(path);
                const totalDist = pathDists[pathDists.length - 1].dist;

                const departureSec = from.departureSec;
                const arrivalSec = to.arrivalSec;
                let travelSec = arrivalSec - departureSec;
                if (travelSec <= 0) travelSec = 60;

                trip._segments.push({
                    departureSec,
                    arrivalSec,
                    travelSec,
                    totalDist,
                    pathDists,
                });
            }
            trip._startSec = trip.stops[0].departureSec;
            trip._endSec = trip.stops[trip.stops.length - 1].arrivalSec;
        }
    }

    // ─── Get train position and bearing at a given time ──────────────────

    function bearingDeg(lat1, lng1, lat2, lng2) {
        const toRad = d => d * Math.PI / 180;
        const toDeg = r => r * 180 / Math.PI;
        const dLng = toRad(lng2 - lng1);
        const y = Math.sin(dLng) * Math.cos(toRad(lat2));
        const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
        return (toDeg(Math.atan2(y, x)) + 360) % 360;
    }

    function getTrainPosition(trip, timeSec) {
        if (timeSec < trip._startSec || timeSec > trip._endSec) return null;

        for (let i = 0; i < trip._segments.length; i++) {
            const seg = trip._segments[i];
            const stop = trip.stops[i];
            const nextStop = trip.stops[i + 1];

            // Dwelling at this stop?
            if (i > 0) {
                const arrival = stop.arrivalSec;
                const departure = stop.departureSec;
                if (timeSec >= arrival && timeSec < departure) {
                    // The previous segment ended at the rail-projected
                    // stop coord (its last pathDists entry). Use the
                    // same point for the dwell pose so the cab doesn't
                    // jump between the path's last on-rail point and
                    // some other rendering during the dwell window.
                    const prevSeg = trip._segments[i - 1];
                    const dwellPt = prevSeg && prevSeg.pathDists.length
                        ? prevSeg.pathDists[prevSeg.pathDists.length - 1]
                        : { lat: stop.lat, lng: stop.lng };
                    const angle = bearingDeg(dwellPt.lat, dwellPt.lng, nextStop.lat, nextStop.lng);
                    const dwellRemainingS = Math.max(0, Math.ceil(departure - timeSec));
                    return {
                        lat: dwellPt.lat,
                        lng: dwellPt.lng,
                        angle,
                        stopped: true,
                        dwellRemainingS,
                    };
                }
            }

            // Moving between stop i and i+1?
            if (timeSec >= seg.departureSec && timeSec <= seg.arrivalSec) {
                const elapsed = timeSec - seg.departureSec;
                const fraction = Math.min(1, elapsed / seg.travelSec);
                const distance = fraction * seg.totalDist;
                const pos = interpolateOnPath(seg.pathDists, distance);
                // Compute bearing from nearby path points
                const aheadDist = Math.min(distance + 50, seg.totalDist);
                const ahead = interpolateOnPath(seg.pathDists, aheadDist);
                const angle = bearingDeg(pos.lat, pos.lng, ahead.lat, ahead.lng);
                return { lat: pos.lat, lng: pos.lng, angle, stopped: false };
            }
        }

        const last = trip.stops[trip.stops.length - 1];
        return { lat: last.lat, lng: last.lng, angle: 0, stopped: true };
    }

    // ─── Animation Loop ───────────────────────────────────────────────────

    function getSimTimeSec() {
        return window.simClock.getSimTimeSec();
    }

    // ─── Cab view (Station3D.openCab) ─────────────────────────────────────
    // Real HŽ trains aren't part of the planning model, so they have no
    // passenger load or capacity — the HUD hides those rows when capacity is 0.

    function escHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    // Recomputes which segment the train is in (and how far along it) given
    // sim time. railway-sim's getTrainPosition doesn't expose segIdx/segFrac,
    // so we do it here once per cab frame.
    function findTrainPhase(trip, timeSec) {
        if (!trip._segments) return null;
        for (let i = 0; i < trip._segments.length; i++) {
            const seg = trip._segments[i];
            const stop = trip.stops[i];
            if (i > 0 && timeSec >= stop.arrivalSec && timeSec < stop.departureSec) {
                return { stopped: true, segIdx: i, segFrac: 0, stopName: stop.name };
            }
            if (timeSec >= seg.departureSec && timeSec <= seg.arrivalSec) {
                const frac = seg.travelSec > 0
                    ? Math.min(1, Math.max(0, (timeSec - seg.departureSec) / seg.travelSec))
                    : 0;
                return { stopped: false, segIdx: i, segFrac: frac, stopName: null };
            }
        }
        return null;
    }

    // Finds another currently-active trip on the same route, excluding
    // `currentTrip`. Used by the cab pose closure to swap trips when the
    // one being followed ends — without this the camera detaches from
    // the train at the terminus (getTrainPosition returns null and the
    // cab pose freezes in space). Mirrors tram-sim.findActiveTripForRoute.
    function findNextActiveTrainTrip(currentTrip, timeSec) {
        if (!currentTrip || !Array.isArray(schedule)) return null;
        const route = currentTrip.routeId || currentTrip.routeName;
        if (!route) return null;
        let best = null;
        let bestStart = Infinity;
        for (const trip of schedule) {
            if (trip === currentTrip) continue;
            const trRoute = trip.routeId || trip.routeName;
            if (trRoute !== route) continue;
            if (timeSec < trip._startSec || timeSec > trip._endSec) continue;
            if (trip._startSec < bestStart) {
                bestStart = trip._startSec;
                best = trip;
            }
        }
        return best;
    }

    // ─── Cab-only train physics ────────────────────────────────────────
    // Once the player is INSIDE the cab, we ignore the schedule's
    // timing and drive the train along its precomputed on-rail
    // pathDists at a sane physics-paced speed. The schedule's stop
    // LIST is preserved (so HUD next-station, dwell countdown, station
    // PA all keep working), but arrival/departure times come from
    // physics, not from sim time. This stops the cab from speeding
    // through the city centre, sailing past stations, or rubber-
    // banding when sim time advances faster than the cab can render.
    const TRAIN_PHYSICS_MAX_SPEED   = 22.0;   // m/s ≈ 80 km/h cruise
    const TRAIN_PHYSICS_ACCEL       = 0.65;   // m/s² gentle accel
    const TRAIN_PHYSICS_DECEL       = 0.95;   // m/s² braking
    const TRAIN_PHYSICS_DWELL_S     = 22;     // station dwell

    function createTrainPhysics() {
        return {
            segIdx: 0,
            distOnSeg: 0,
            speed: 0,
            state: 'cruising',          // 'cruising' | 'dwelling'
            dwellRemainingS: 0,
        };
    }

    function stepTrainPhysics(physics, trip, dt) {
        if (!trip._segments || trip._segments.length === 0 || dt <= 0) return;
        if (physics.state === 'dwelling') {
            physics.dwellRemainingS = Math.max(0, physics.dwellRemainingS - dt);
            if (physics.dwellRemainingS <= 0) {
                const nextIdx = physics.segIdx + 1;
                if (nextIdx >= trip._segments.length) {
                    // Terminus — sit at the final station; railway-sim
                    // up the stack will swap to another active trip if
                    // one exists (handled by tripRef in the poseFn).
                    physics.dwellRemainingS = 0;
                    return;
                }
                physics.segIdx = nextIdx;
                physics.distOnSeg = 0;
                physics.speed = 0;
                physics.state = 'cruising';
            }
            return;
        }
        const seg = trip._segments[physics.segIdx];
        if (!seg) return;
        const remaining = seg.totalDist - physics.distOnSeg;
        if (remaining <= 0.5) {
            physics.distOnSeg = seg.totalDist;
            physics.speed = 0;
            physics.state = 'dwelling';
            physics.dwellRemainingS = TRAIN_PHYSICS_DWELL_S;
            return;
        }
        // Brake-distance check: keep enough room to stop at the next
        // station. brakeDist = v² / (2·a). Ramp speed down to whatever
        // square-root-of-2-a-d allows.
        const brakeDist = (physics.speed * physics.speed) / (2 * TRAIN_PHYSICS_DECEL);
        let targetSpeed;
        if (remaining <= brakeDist + 2) {
            targetSpeed = Math.sqrt(Math.max(0, 2 * TRAIN_PHYSICS_DECEL * remaining));
        } else {
            targetSpeed = TRAIN_PHYSICS_MAX_SPEED;
        }
        if (physics.speed < targetSpeed) {
            physics.speed = Math.min(targetSpeed, physics.speed + TRAIN_PHYSICS_ACCEL * dt);
        } else if (physics.speed > targetSpeed) {
            physics.speed = Math.max(targetSpeed, physics.speed - TRAIN_PHYSICS_DECEL * dt);
        }
        physics.distOnSeg = Math.min(seg.totalDist, physics.distOnSeg + physics.speed * dt);
    }

    // Sample a point a signed distance from the physics origin, walking across
    // stop-to-stop segment boundaries. The three-car player model uses this to
    // follow curves per module instead of rotating its full 70 m body as a stick.
    function sampleTrainPhysicsOffset(physics, trip, offsetM) {
        let segIdx = physics.segIdx;
        let distance = physics.distOnSeg + Number(offsetM || 0);
        while (distance < 0 && segIdx > 0) {
            segIdx -= 1;
            distance += trip._segments[segIdx].totalDist;
        }
        while (segIdx < trip._segments.length - 1
            && distance > trip._segments[segIdx].totalDist) {
            distance -= trip._segments[segIdx].totalDist;
            segIdx += 1;
        }
        const seg = trip._segments[segIdx];
        if (!seg) return null;
        distance = Math.max(0, Math.min(seg.totalDist, distance));
        const pos = interpolateOnPath(seg.pathDists, distance);
        const behind = interpolateOnPath(seg.pathDists, Math.max(0, distance - 6));
        const ahead = interpolateOnPath(seg.pathDists, Math.min(seg.totalDist, distance + 6));
        return {
            lat: pos.lat,
            lon: pos.lng,
            headingDeg: bearingDeg(behind.lat, behind.lng, ahead.lat, ahead.lng),
        };
    }

    function getTrainPhysicsPose(physics, trip) {
        if (!trip._segments || trip._segments.length === 0) return null;
        const seg = trip._segments[physics.segIdx];
        if (!seg) return null;
        const pos = interpolateOnPath(seg.pathDists, physics.distOnSeg);
        // Heading: bearing across a small window straddling the current
        // position. The earlier code took the bearing from pos to a
        // point AHEAD only — when the train arrived at the platform
        // (distOnSeg = totalDist), the "ahead" point collapsed to pos
        // and bearingDeg(pt, pt) returns 0° (north), whip-panning the
        // cab to face north for the entire dwell. Sampling 8 m behind
        // → 30 m ahead keeps the span positive even when the train is
        // parked at the end of the path. We cache the last good
        // heading on the physics state so a degenerate sample (very
        // short residual segment) doesn't produce a 0° fallback.
        const sampleStart = Math.max(0, physics.distOnSeg - 8);
        const sampleEnd   = Math.min(seg.totalDist, physics.distOnSeg + 30);
        let angle = (physics.lastHeadingDeg != null) ? physics.lastHeadingDeg : 0;
        if (sampleEnd - sampleStart > 0.5) {
            const a = interpolateOnPath(seg.pathDists, sampleStart);
            const b = interpolateOnPath(seg.pathDists, sampleEnd);
            angle = bearingDeg(a.lat, a.lng, b.lat, b.lng);
            physics.lastHeadingDeg = angle;
        }

        let nextStation = null;
        if (physics.state === 'cruising') {
            const upcoming = trip.stops[physics.segIdx + 1];
            if (upcoming) {
                nextStation = {
                    name: upcoming.name || '',
                    distanceMeters: Math.max(0, seg.totalDist - physics.distOnSeg),
                };
            }
        }
        let stationName = null;
        if (physics.state === 'dwelling') {
            const arrived = trip.stops[physics.segIdx + 1];
            if (arrived) stationName = arrived.name;
        }

        return {
            lat: pos.lat,
            lon: pos.lng,
            headingDeg: angle,
            articulatedCars: [1, 0, -1]
                .map(offset => sampleTrainPhysicsOffset(physics, trip, offset * 23.735))
                .filter(Boolean),
            status: {
                paused: physics.state === 'dwelling',
                stationName,
                nextStation,
                dwellRemainingS: physics.state === 'dwelling' ? Math.ceil(physics.dwellRemainingS) : undefined,
                speedKmh: Math.round(physics.speed * 3.6),
                totalPassengers: 0,
                capacity: 0,
                lastAlighted: 0,
                lastBoarded: 0,
            },
        };
    }

    // Returns a poseFn closure backed by stepTrainPhysics. The returned
    // closure tracks wall-time dt internally and steps the physics on
    // each call. Trip is fixed for the session — no schedule-time
    // swaps; once the trip ends the closure starts returning the same
    // dwell pose forever (terminus parking).
    function makePhysicsTrainPoseFn(trip) {
        const physics = createTrainPhysics();
        let lastCallMs = null;
        return ({ paused = false } = {}) => {
            const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            const dt = paused || lastCallMs == null
                ? 0
                : Math.min(0.1, Math.max(0, (nowMs - lastCallMs) / 1000));
            // Always rebase the wall timestamp while paused so resuming does
            // not inject a catch-up physics step after a long screenshot.
            lastCallMs = nowMs;
            stepTrainPhysics(physics, trip, dt);
            return getTrainPhysicsPose(physics, trip);
        };
    }

    function makeTrainPoseFn(tripRef) {
        return () => {
            const timeSec = getSimTimeSec();
            let trip = tripRef.current;
            let pos = getTrainPosition(trip, timeSec);
            if (!pos) {
                // Current trip is over (or hasn't started). Try to swap
                // to another active trip on the same route so the cab
                // doesn't freeze at the terminus.
                const next = findNextActiveTrainTrip(trip, timeSec);
                if (next) {
                    console.log(`[railwaySim] cab: trip ended, switching to ${next.vehicleId || next.routeName}`);
                    tripRef.current = next;
                    trip = next;
                    pos = getTrainPosition(trip, timeSec);
                }
            }
            if (!pos) return null;
            const phase = findTrainPhase(trip, timeSec);

            let nextStation = null;
            if (phase && !phase.stopped && trip._segments[phase.segIdx]) {
                const seg = trip._segments[phase.segIdx];
                const upcoming = trip.stops[phase.segIdx + 1];
                if (upcoming) {
                    nextStation = {
                        name: upcoming.name || '',
                        distanceMeters: Math.max(0, (1 - phase.segFrac) * seg.totalDist),
                    };
                }
            }

            return {
                lat: pos.lat,
                lon: pos.lng,
                headingDeg: pos.angle || 0,
                status: {
                    paused: !!pos.stopped,
                    stationName: pos.stopped && phase ? phase.stopName : null,
                    nextStation,
                    // Surface the dwell countdown the same way trams do
                    // (Number.isFinite check in the HUD treats undefined
                    // as "no countdown") so the route overlay shows
                    // "🛑 Na stanici … · 12 s".
                    dwellRemainingS: (pos.stopped && Number.isFinite(pos.dwellRemainingS))
                        ? pos.dwellRemainingS
                        : undefined,
                    totalPassengers: 0,
                    capacity: 0,
                    lastAlighted: 0,
                    lastBoarded: 0,
                },
            };
        };
    }

    // Returns a function that polls all other currently active railway trains each
    // frame, excluding myTrip. Used by station-3d.js to render them in the scene.
    function makeOtherTrainsFn(myTrip) {
        return () => {
            const timeSec = getSimTimeSec();
            const result = [];
            for (const trip of schedule) {
                if (trip === myTrip) continue;
                const pos = getTrainPosition(trip, timeSec);
                if (!pos) continue;
                const id = (trip.vehicleId || trip.routeId || '') + '_' + (trip.stops?.[0]?.arrivalSec ?? 0);
                result.push({
                    id,
                    lat: pos.lat,
                    lon: pos.lng,
                    headingDeg: pos.angle || 0,
                    color: '#555555',
                    trackType: 'g1435',
                });
            }
            return result;
        };
    }

    function openCabForTrip(trip) {
        if (!window.Station3D || typeof window.Station3D.openCab !== 'function') {
            console.warn('[railwaySim] Station3D.openCab not available');
            return;
        }
        // The cab gets a PHYSICS-paced pose, not the schedule pose. The
        // schedule keeps the world map's other trains advancing on
        // sim-time as before, but THIS train (the one the player is
        // sitting in) is driven by stepTrainPhysics — accelerates,
        // brakes for stations, dwells, accelerates again. No more
        // city-centre slowness, no more sailing past stations.
        const poseFn = makePhysicsTrainPoseFn(trip);
        const initial = poseFn();
        if (!initial) {
            console.warn('[railwaySim] train is not currently active — cannot open cab view');
            return;
        }
        const routeName = trip.routeName || trip.routeId || '?';
        window.Station3D.openCab({}, { number: routeName }, poseFn, {
            isTrainSession: true,
            driverUnavailableKey: 'driver.trainsNotDriveable',
            otherTrainsFn: makeOtherTrainsFn(trip),
            trackBaseY: ELEVATED_RAIL_BASE_Y,
        });
    }

    function bindCabPopup(marker, trip) {
        const routeName = trip.routeName || trip.routeId || '?';
        const html =
            `<div class="tram-cab-popup">` +
                `<div class="tram-cab-popup-line">Vlak ${escHtml(routeName)}</div>` +
                `<button type="button" class="tram-cab-popup-btn">U kabinu</button>` +
            `</div>`;
        marker.on('click', e => {
            L.DomEvent.stopPropagation(e);
            const pointerLatLng = e.originalEvent
                ? map.mouseEventToLatLng(e.originalEvent)
                : marker.getLatLng();
            const popup = L.popup({ closeButton: true, autoClose: true })
                .setLatLng(pointerLatLng)
                .setContent(html)
                .openOn(map);
            const el = popup.getElement();
            if (!el) return;
            const btn = el.querySelector('.tram-cab-popup-btn');
            if (!btn) return;
            btn.addEventListener('click', () => {
                map.closePopup();
                openCabForTrip(trip);
            }, { once: true });
        });
    }

    function createRailTrainIcon() {
        return L.divIcon({
            className: 'train-marker train-marker-overground',
            html: `<div class="train-marker-shell" style="--train-color:#000000">
                <div class="train-marker-icon"></div>
                <div class="train-stop-indicator" aria-hidden="true"></div>
            </div>`,
            iconSize: [44, 44],
            iconAnchor: [22, 22],
        });
    }

    function updateTrains() {
        if (!simEnabled) return;
        const timeSec = getSimTimeSec();

        for (const trip of schedule) {
            const pos = getTrainPosition(trip, timeSec);
            if (pos) {
                let marker = trainMarkers.get(trip.tripId);
                if (!marker) {
                    marker = L.marker([pos.lat, pos.lng], {
                        icon: createRailTrainIcon(),
                        pane: 'markerPane',
                        interactive: true,
                        keyboard: false,
                        zIndexOffset: 900,
                    }).addTo(map);
                    marker.bindTooltip('', { direction: 'top', offset: [0, -15] });
                    bindCabPopup(marker, trip);
                    trainMarkers.set(trip.tripId, marker);
                }
                marker.setLatLng([pos.lat, pos.lng]);
                marker.setTooltipContent(formatTooltip(trip, timeSec));

                // Update angle and stopped state
                const el = marker.getElement();
                if (el) {
                    const icon = el.querySelector('.train-marker-icon');
                    if (icon) icon.style.setProperty('--train-angle', `${pos.angle - 90}deg`);
                    el.classList.toggle('is-stopped', pos.stopped);
                }

                if (!map.hasLayer(marker)) marker.addTo(map);
            } else {
                const marker = trainMarkers.get(trip.tripId);
                if (marker && map.hasLayer(marker)) {
                    map.removeLayer(marker);
                }
            }
        }
    }

    function startMapUpdateLoop() {
        if (animationTimer !== null || mapUpdatesSuspended || !scheduleLoaded) return;
        if (simEnabled) updateTrains();
        animationTimer = setInterval(updateTrains, UPDATE_INTERVAL_MS);
    }

    function stopMapUpdateLoop() {
        if (animationTimer === null) return;
        clearInterval(animationTimer);
        animationTimer = null;
    }

    function setMapUpdatesSuspended(active) {
        const next = !!active;
        if (mapUpdatesSuspended === next) return;
        mapUpdatesSuspended = next;
        if (next) stopMapUpdateLoop();
        else startMapUpdateLoop();
    }

    function formatTooltip(trip, timeSec) {
        const routeName = trip.routeName || trip.routeId;
        const time = formatTime(timeSec);
        // Find current/next stop
        let currentStop = '';
        for (let i = 0; i < trip.stops.length - 1; i++) {
            if (timeSec <= trip.stops[i + 1].arrivalSec) {
                currentStop = `${trip.stops[i].name} → ${trip.stops[i + 1].name}`;
                break;
            }
        }
        return `<strong>${routeName}</strong><br>${currentStop}<br>${time}`;
    }

    function formatTime(sec) {
        const h = Math.floor(sec / 3600) % 24;
        const m = Math.floor((sec % 3600) / 60);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    // ─── Track Layer ──────────────────────────────────────────────────────

    function showTracks() {
        if (trackLayer) map.removeLayer(trackLayer);
        trackLayer = L.geoJSON({ type: 'FeatureCollection', features: trackFeatures }, {
            style: {
                color: '#555555',
                weight: 2,
                opacity: 0.5,
                dashArray: '4,4',
            },
            interactive: false,
        }).addTo(map);
    }

    function hideTracks() {
        if (trackLayer) {
            map.removeLayer(trackLayer);
            trackLayer = null;
        }
    }

    // ─── Toggle Control ────────────────────────────────────────────────────

    let trackLayerVisible = true;

    function syncTrackLayer() {
        if (simEnabled && trackLayerVisible) showTracks();
        else hideTracks();
    }

    function enableSim() {
        ensureInitialized();
        if (simEnabled) return;
        simEnabled = true;
        syncTrackLayer();
        updateTrains();
        window.simClock.setSimActive('rail', true);
    }

    function disableSim() {
        if (!simEnabled) return;
        simEnabled = false;
        hideTracks();
        for (const [, marker] of trainMarkers) {
            if (map.hasLayer(marker)) map.removeLayer(marker);
        }
        trainMarkers.clear();
        window.simClock.setSimActive('rail', false);
    }

    function setSimEnabled(enabled) {
        if (enabled) enableSim(); else disableSim();
    }

    function setTrackLayerVisible(visible) {
        trackLayerVisible = !!visible;
        syncTrackLayer();
    }

    function setCanonicalTrackFeatures(features) {
        const next = Array.isArray(features) ? features : null;
        if (canonicalTrackFeatures === next) return;
        canonicalTrackFeatures = next;
        trackFeatures = canonicalTrackFeatures || osmTrackFeatures;
        if (!scheduleLoaded) return;
        buildGraph();
        precomputeTrips();
        syncTrackLayer();
        if (simEnabled) updateTrains();
    }

    // OSM bootstraps the schedule graph before the user asks for the railway
    // overlay. Once transit.js fetches the reconstructed network, that canonical
    // geometry replaces OSM for routing too: display, snapping and trains then
    // share one set of tracks.
    window.railwaySim = {
        setEnabled: setSimEnabled,
        setTrackLayerVisible,
        setCanonicalTrackFeatures,
        isEnabled: () => simEnabled,
    };
    window.dispatchEvent(new CustomEvent('railwaySim:ready'));
    window.addEventListener('station3d:visibility', event => {
        setMapUpdatesSuspended(!!event.detail?.active);
    });

    // ─── Init ──────────────────────────────────────────────────────────────

    async function loadSimulationData() {
        try {
            const [tracksResp, scheduleResp] = await Promise.all([
                fetch(TRACKS_URL).then(r => r.json()),
                fetch(SCHEDULE_URL).then(r => r.json()),
            ]);

            osmTrackFeatures = tracksResp.features || [];
            trackFeatures = canonicalTrackFeatures || osmTrackFeatures;
            schedule = scheduleResp;

            console.log(`Railway sim: ${trackFeatures.length} track segments, ${schedule.length} trips loaded`);

            buildGraph();
            precomputeTrips();
            scheduleLoaded = true;
            startMapUpdateLoop();

        } catch (err) {
            console.error('Railway sim failed to load:', err);
        }
    }

    function ensureInitialized() {
        if (!initPromise) initPromise = loadSimulationData();
        return initPromise;
    }

    const shouldAutoLoad = window.__worldMode?.shouldAutoLoadReferenceSimulation?.(
        window.location?.search,
        window.__locationRegistry,
        window.__TRANSIT_RUNTIME_CONFIG__?.city,
    ) !== false;
    if (shouldAutoLoad) {
        if (typeof map !== 'undefined') {
            ensureInitialized();
        } else {
            window.addEventListener('load', ensureInitialized, { once: true });
        }
    }
})();
