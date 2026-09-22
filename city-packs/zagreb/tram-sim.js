// Tram simulation: animates trams along track polylines using actual stop arrival data.
// Matches stop pairs to track geometry via projection — no pathfinding needed.

(function () {
    'use strict';

    // Switchable track data source. Two pipelines coexist on disk:
    //   'osm'           — OSM railway=tram ways routed offline with Dijkstra.
    //                     Cleanest geometry; can have stop-to-network attach
    //                     glitches at terminal sidings.
    //   'gtfs-smoothed' — GTFS shapes per route, with the ±20 m around each
    //                     station replaced by a straight line so junctions /
    //                     switches / sidings near platforms don't appear.
    // Each pipeline writes its own files; flip this constant to swap sources.
    const TRACK_SOURCE = 'osm';
    const TRACKS_URL = TRACK_SOURCE === 'osm'
        ? 'city-pack/data/zagreb_tram_tracks_osm.geojson'
        : 'city-pack/data/zagreb_tram_tracks_gtfs.geojson';
    const SEGMENTS_URL = TRACK_SOURCE === 'osm'
        ? 'city-pack/data/zagreb_tram_segments_osm.json'
        : 'city-pack/data/zagreb_tram_segments_gtfs.json';
    // OSM tram network is ALWAYS loaded (regardless of TRACK_SOURCE) because
    // the cab view's other-rails layer and the driver-mode routing graph both
    // need a clean unified network. GTFS shapes are too fragmented for both.
    const OSM_TRACKS_URL = 'city-pack/data/zagreb_tram_tracks_osm.geojson';
    const STOPS_URL = 'city-pack/data/zagreb_tram_stops.json';
    const SWITCH_RULES_URL = 'city-pack/data/zagreb_tram_switch_rules.json';
    // The full-day replay comes from the API, generated live from observed
    // arrivals (cadastre-data api/src/domains/zet/tram-replay.js). The baked
    // JSON that used to ship here remains only as an offline input to the
    // track/stop build scripts, under scripts/data/.
    const scheduleUrl = () => {
        const base = (window.__TRANSIT_RUNTIME_CONFIG__ || {}).apiBaseUrl || '/api';
        return `${base}/zet/tram-replay`;
    };
    const UPDATE_INTERVAL_MS = 100;
    const DWELL_SECONDS = 10;
    const SNAP_TOLERANCE_M = 100;
    const QUICK_START_LINE = '6';
    const QUICK_START_STOP_IDS = Object.freeze([
        '111_1', '112_1', '297_3', '163_3', '303_3', '247_1',
        '231_1', '197_1', '222_1', '264_1', '1787_4',
    ]);

    // ZET tram colors by route number
    const TRAM_COLORS = {
        '1': '#0074D9', '2': '#FF4136', '3': '#2ECC40', '4': '#FF851B',
        '5': '#B10DC9', '6': '#FFDC00', '7': '#01FF70', '8': '#39CCCC',
        '9': '#F012BE', '11': '#85144b', '12': '#3D9970', '13': '#6B8E23',
        '14': '#AAAAAA', '15': '#7FDBFF', '17': '#FF6600',
    };
    const DEFAULT_TRAM_COLOR = '#334155';

    // ─── State ─────────────────────────────────────────────────────────────
    let trackFeatures = [];
    let osmTrackFeatures = []; // always loaded; used for cab visual + driver routing
    let allTramStops = [];    // all platform stops (both directions) from stops JSON
    let schedule = [];
    let tramMarkers = new Map();
    let trackLayer = null;
    let switchRules = { version: 1, switches: {} };
    let simEnabled = false;
    let mapUpdateTimer = null;
    let scheduleLoaded = false;
    let mapUpdatesSuspended = false;
    let resolveReady = null;
    let rejectReady = null;
    let resolveLightReady = null;
    let rejectLightReady = null;
    let initPromise = null;
    const readyPromise = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });
    const lightReadyPromise = new Promise((resolve, reject) => {
        resolveLightReady = resolve;
        rejectLightReady = reject;
    });
    // Trips that the player has taken control of via the cab view. Skipped by
    // updateTrams() and makeOtherTramsFn() so the autopiloted "ghost" of the
    // controlled tram disappears from the map and from other cabs.
    const controlledTrips = new WeakSet();

    // Precomputed routed segments from build-tram-tracks-osm.mjs:
    // "stopKeyA__stopKeyB" → { c: [[lng, lat], ...], d: totalMeters }
    // The build script routed every consecutive pair on the OSM tram network,
    // so adjacent slices share endpoints on the actual rails — no twisting.
    let routedSegments = {};

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

    function bearingDeg(lat1, lng1, lat2, lng2) {
        const toRad = d => d * Math.PI / 180;
        const toDeg = r => r * 180 / Math.PI;
        const dLng = toRad(lng2 - lng1);
        const y = Math.sin(dLng) * Math.cos(toRad(lat2));
        const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
        return (toDeg(Math.atan2(y, x)) + 360) % 360;
    }

    // ─── Stop-pair segment lookup ─────────────────────────────────────────
    //
    // Tracks are now an OSM tram-network polyline file (purely geometry, no
    // route metadata) and routing is done OFFLINE by build-tram-tracks-osm.mjs:
    // it builds a graph from the OSM ways, projects each stop onto its
    // nearest edge, and runs Dijkstra between every consecutive stop pair
    // that appears in the schedule. The result is `routedSegments`, a flat
    // dict keyed by `${nameA}@${lat},${lng}__${nameB}@${lat},${lng}`. The
    // runtime just looks up the precomputed polyline for each pair, so the
    // tracks always follow the actual rails and adjacent slices share their
    // stop endpoints by construction — no twisting.

    function stopKey(stopOrName, lat, lng) {
        if (stopOrName && typeof stopOrName === 'object') {
            if (stopOrName.stopId != null) return `id:${stopOrName.stopId}`;
            return `${stopOrName.name}@${stopOrName.lat.toFixed(5)},${stopOrName.lng.toFixed(5)}`;
        }
        return `${stopOrName}@${lat.toFixed(5)},${lng.toFixed(5)}`;
    }

    function buildStraightSegment(fromLat, fromLng, toLat, toLng) {
        const dist = haversineMeters(fromLat, fromLng, toLat, toLng);
        return {
            pathDists: [
                { lat: fromLat, lng: fromLng, dist: 0 },
                { lat: toLat, lng: toLng, dist: dist },
            ],
            totalDist: dist,
        };
    }

    // Returns { pathDists, totalDist } for a stop pair, looking up the
    // precomputed routed segment first and falling back to a straight line
    // if it's missing (rare — should only happen if the schedule was
    // regenerated without re-running the segment builder).
    function findSegmentForStops(from, to) {
        const key = `${stopKey(from)}__${stopKey(to)}`;
        const seg = routedSegments[key];
        if (!seg || !seg.c || seg.c.length < 2) {
            return buildStraightSegment(from.lat, from.lng, to.lat, to.lng);
        }
        const pathDists = [{ lat: seg.c[0][1], lng: seg.c[0][0], dist: 0 }];
        let cum = 0;
        for (let i = 1; i < seg.c.length; i++) {
            const prev = seg.c[i - 1], cur = seg.c[i];
            cum += haversineMeters(prev[1], prev[0], cur[1], cur[0]);
            pathDists.push({ lat: cur[1], lng: cur[0], dist: cum });
        }
        return { pathDists, totalDist: cum };
    }

    // ─── Interpolation ────────────────────────────────────────────────────

    function interpolateOnPath(pathDists, distance) {
        if (pathDists.length === 0) return null;
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

    // ─── Decode compact schedule format ────────────────────────────────────

    function decodeSchedule(compact) {
        return compact.map(t => ({
            vehicleId: t.v,
            routeName: t.r,
            shapeId: t.sh || null,
            stops: t.s.map(s => ({
                stopId: s.i || null,
                name: s.n,
                lat: s.a[0],
                lng: s.a[1],
                arrivalSec: s.t,
                departureSec: s.t + DWELL_SECONDS,
            })),
        }));
    }

    function precomputeTrip(trip) {
        trip._segments = [];
        for (let i = 0; i < trip.stops.length - 1; i++) {
            const from = trip.stops[i];
            const to = trip.stops[i + 1];
            const seg = findSegmentForStops(from, to);
            const departureSec = from.departureSec;
            const arrivalSec = to.arrivalSec;
            let travelSec = arrivalSec - departureSec;
            if (travelSec <= 0) travelSec = 30;

            trip._segments.push({
                departureSec, arrivalSec, travelSec,
                totalDist: seg.totalDist,
                pathDists: seg.pathDists,
            });
        }
        trip._startSec = trip.stops[0].arrivalSec;
        trip._endSec = trip.stops[trip.stops.length - 1].departureSec;
    }

    // ─── Precompute ────────────────────────────────────────────────────────

    function precomputeTrips() {
        let totalSegs = 0, straightFallbacks = 0;
        for (const trip of schedule) {
            for (let i = 0; i < trip.stops.length - 1; i++) {
                const seg = findSegmentForStops(trip.stops[i], trip.stops[i + 1]);
                if (seg.pathDists.length <= 2) straightFallbacks++;
                totalSegs++;
            }
            precomputeTrip(trip);
        }
        console.log(`Tram segments: ${totalSegs} resolved, ${straightFallbacks} straight-line fallbacks`);
    }

    // ─── Tram physics ──────────────────────────────────────────────────────
    // The schedule is used ONLY to seed each trip's initial state when it
    // first becomes visible. Movement after that is purely physics:
    // accelerate from a stop, cruise capped at TRAM_MAX_SPEED_MPS,
    // brake to zero in time for the next station, dwell, repeat. This
    // replaces the older time-based interpolation, which let trams hit
    // unrealistic speeds whenever the GTFS feed gave a short travel time.
    //
    // Per-trip state lives on `trip._physics`:
    //   state         : 'cruising' | 'dwelling' | 'finished'
    //   segIdx        : current segment index (0 = stops[0]→stops[1])
    //   dist          : metres covered along the current segment
    //   speed         : m/s
    //   dwellUntil    : sim-time at which dwell ends
    //   lastUpdateAt  : sim-time we've simulated up to

    const TRAM_MAX_SPEED_MPS  = 14.0;   // ~50 km/h — typical urban tram cruise
    const TRAM_ACCEL_MPS2     = 1.0;    // departure acceleration
    const TRAM_DECEL_MPS2     = 1.2;    // braking deceleration
    const TRAM_DWELL_S        = 10;     // station dwell time
    const PHYSICS_MAX_STEP_S  = 0.5;    // sub-step for stability + large dt
    const PHYSICS_END_GRACE_S = 600;    // stop simulating trips ended >10 min ago

    function seedPhysicsFromSchedule(trip, simTime) {
        // Trip hasn't started yet — nothing to seed.
        if (simTime < trip._startSec) return null;
        // Trip ended long ago — nothing to render.
        if (simTime > trip._endSec + PHYSICS_END_GRACE_S) {
            return { state: 'finished', segIdx: trip._segments.length,
                     dist: 0, speed: 0, dwellUntil: 0, lastUpdateAt: simTime };
        }
        // Special case: simTime is in the FIRST stop's dwell window
        // [stops[0].arrivalSec, stops[0].departureSec). The loop below
        // skips i=0's dwell check (its `i > 0` guard exists because
        // intermediate-stop dwell anchors at the end of seg[i-1], which
        // doesn't exist for i=0). Without this branch the function would
        // fall through to "cruising at end of last segment", which
        // stepPhysics immediately transitions to 'finished' — the cab
        // pose then returns null and the tram visually freezes the
        // moment the cab opens onto a trip that's at its first stop.
        const firstStop = trip.stops[0];
        if (simTime >= firstStop.arrivalSec && simTime < firstStop.departureSec) {
            return {
                state: 'cruising',
                segIdx: 0,
                dist: 0,
                speed: 0,
                dwellUntil: 0,
                lastUpdateAt: simTime,
            };
        }
        // Same bug for the LAST stop's dwell window — the loop only
        // iterates segments (0..N-2), so a dwell at stops[N-1] never
        // matched. Anchor at the end of the last segment in 'dwelling'
        // state; physics will tick down our own DWELL_S and then
        // transition to 'finished' on the natural segment boundary.
        const lastStop = trip.stops[trip.stops.length - 1];
        if (simTime >= lastStop.arrivalSec && simTime < lastStop.departureSec) {
            const lastSeg = trip._segments[trip._segments.length - 1];
            return {
                state: 'dwelling',
                segIdx: trip._segments.length - 1,
                dist: lastSeg.totalDist,
                speed: 0,
                dwellUntil: simTime + TRAM_DWELL_S,
                lastUpdateAt: simTime,
            };
        }
        // Find which schedule slot we're in and seed the matching state.
        for (let i = 0; i < trip._segments.length; i++) {
            const seg = trip._segments[i];
            const stop = trip.stops[i];
            // Dwelling at intermediate stop?
            if (i > 0 && simTime >= stop.arrivalSec && simTime < stop.departureSec) {
                const prevSeg = trip._segments[i - 1];
                return {
                    state: 'dwelling',
                    segIdx: i - 1,                // sit at end of arriving seg
                    dist: prevSeg.totalDist,
                    speed: 0,
                    // Dwell from now until our own DWELL_S elapses (don't
                    // honour schedule departureSec — it's the part we're
                    // ignoring).
                    dwellUntil: simTime + TRAM_DWELL_S,
                    lastUpdateAt: simTime,
                };
            }
            // Cruising on segment i?
            if (simTime >= seg.departureSec && simTime <= seg.arrivalSec) {
                const elapsed = simTime - seg.departureSec;
                const frac = Math.min(1, elapsed / seg.travelSec);
                return {
                    state: 'cruising',
                    segIdx: i,
                    dist: frac * seg.totalDist,
                    // Assume cruise speed; physics will normalise within a
                    // second or two if we needed to be slower.
                    speed: TRAM_MAX_SPEED_MPS,
                    dwellUntil: 0,
                    lastUpdateAt: simTime,
                };
            }
        }
        // After last scheduled segment but within grace — let physics finish.
        return {
            state: 'cruising',
            segIdx: trip._segments.length - 1,
            dist: trip._segments[trip._segments.length - 1].totalDist,
            speed: 0,
            dwellUntil: 0,
            lastUpdateAt: simTime,
        };
    }

    // Advance the trip's physics by `dt` seconds. Sub-stepped for both
    // stability (small constant step) and to absorb large catch-ups
    // (sim clock jumps, tab regaining focus, etc).
    function stepPhysics(trip, p, dt) {
        if (p.state === 'finished') { p.lastUpdateAt += dt; return; }
        // Obstacle stall: when the cars layer detects a car/wreck in
        // this autopilot tram's forward cone, it sets `p.obstacleStall
        // = true` (and clears it once the path is free). While stalled,
        // the cruise step brakes / holds the tram at zero speed without
        // advancing distance, but we still tick lastUpdateAt so dwell
        // timers etc. behave normally. Player-driven trams never have
        // this flag set — see cars.js applyAutopilotTramStalls.
        const stalled = !!p.obstacleStall;
        let remaining = dt;
        while (remaining > 0) {
            const step = Math.min(remaining, PHYSICS_MAX_STEP_S);
            remaining -= step;
            p.lastUpdateAt += step;
            if (p.state === 'dwelling') {
                if (p.lastUpdateAt >= p.dwellUntil) {
                    p.segIdx++;
                    if (p.segIdx >= trip._segments.length) {
                        p.state = 'finished';
                        return;
                    }
                    p.state = 'cruising';
                    p.dist = 0;
                    p.speed = 0;
                }
                continue;
            }
            if (stalled) {
                // Brake hard, hold at zero, don't advance distance.
                p.speed = Math.max(0, p.speed - TRAM_DECEL_MPS2 * step);
                continue;
            }
            // Cruising. Brake-distance-based throttle: if we can't stop in
            // the remaining length of this segment, brake; otherwise keep
            // accelerating until cruise speed.
            const seg = trip._segments[p.segIdx];
            const remDist = Math.max(0, seg.totalDist - p.dist);
            const brakeDist = (p.speed * p.speed) / (2 * TRAM_DECEL_MPS2);
            let accel;
            if (brakeDist >= remDist) accel = -TRAM_DECEL_MPS2;
            else if (p.speed < TRAM_MAX_SPEED_MPS) accel = TRAM_ACCEL_MPS2;
            else accel = 0;
            const newSpeed = Math.max(0,
                Math.min(TRAM_MAX_SPEED_MPS, p.speed + accel * step));
            // Trapezoidal integration so distance doesn't lag at speed steps.
            const dDist = (p.speed + newSpeed) * 0.5 * step;
            p.speed = newSpeed;
            p.dist += dDist;
            if (p.dist >= seg.totalDist) {
                p.dist = seg.totalDist;
                p.speed = 0;
                if (p.segIdx >= trip._segments.length - 1) {
                    p.state = 'finished';
                    return;
                }
                p.state = 'dwelling';
                p.dwellUntil = p.lastUpdateAt + TRAM_DWELL_S;
            }
        }
    }

    // ─── Position ──────────────────────────────────────────────────────────

    // Render-side: derive a {lat, lng, angle, stopped, stopName,
    // segIdx, segFrac} pose from the trip's physics state. Shared by
    // both the sim-time-driven (map) and wall-time-driven (cab) paths.
    function poseFromPhysics(trip, p) {
        if (p.state === 'finished') return null;
        const seg = trip._segments[p.segIdx];
        if (!seg) return null;
        if (p.state === 'dwelling') {
            const path = seg.pathDists;
            const pos = path[path.length - 1];
            // Heading while stopped: use the stable approach direction (bearing
            // over the last ~30 m into the stop, matching the cruising lookahead)
            // rather than the final polyline leg. On a curved/densified approach
            // the final-leg bearing differs sharply from the cruising heading, and
            // that snap turned the cab camera AND tilted its gaze down (pitch is
            // sampled along the heading) at every stop.
            let angle = 0;
            const backDist = Math.max(0, seg.totalDist - 30);
            const back = interpolateOnPath(seg.pathDists, backDist);
            if (back && (back.lat !== pos.lat || back.lng !== pos.lng)) {
                angle = bearingDeg(back.lat, back.lng, pos.lat, pos.lng);
            } else if (path.length > 1) {
                const before = path[path.length - 2];
                angle = bearingDeg(before.lat, before.lng, pos.lat, pos.lng);
            }
            return {
                lat: pos.lat, lng: pos.lng, angle, stopped: true,
                stopName: trip.stops[p.segIdx + 1] && trip.stops[p.segIdx + 1].name,
                segIdx: p.segIdx, segFrac: 1,
            };
        }
        const pos = interpolateOnPath(seg.pathDists, p.dist);
        if (!pos) return null;
        const aheadDist = Math.min(p.dist + 30, seg.totalDist);
        const ahead = interpolateOnPath(seg.pathDists, aheadDist);
        const angle = bearingDeg(pos.lat, pos.lng, ahead.lat, ahead.lng);
        const segFrac = seg.totalDist > 0 ? Math.min(1, p.dist / seg.totalDist) : 0;
        return {
            lat: pos.lat, lng: pos.lng, angle, stopped: false,
            segIdx: p.segIdx, segFrac,
        };
    }

    // Map-view position. Steps physics by SIM-time delta so the
    // time-compression (4×, 8×, …) the user picked on the map panel
    // applies — trams do more route-traversals per wall-second when the
    // user wants to scrub through a day.
    function getTramPosition(trip, timeSec) {
        if (timeSec < trip._startSec) return null;
        if (!trip._physics) {
            const seed = seedPhysicsFromSchedule(trip, timeSec);
            if (!seed) return null;
            trip._physics = seed;
        }
        const p = trip._physics;
        const dt = timeSec - p.lastUpdateAt;
        if (dt > 0) {
            stepPhysics(trip, p, dt);
        } else if (dt < -10) {
            const seed = seedPhysicsFromSchedule(trip, timeSec);
            if (!seed) { trip._physics = null; return null; }
            trip._physics = seed;
        }
        return poseFromPhysics(trip, p);
    }

    // Cab-view position. Steps physics by WALL-clock delta — the sim
    // clock's speed multiplier is map-view-only; trams in the 3D cab
    // should always travel at human-realistic pace regardless of how
    // fast the simulated day is currently running.
    //
    // A separate physics state (`_physicsWall`) is maintained so this
    // doesn't fight the map's sim-time physics. On first access we seed
    // it from the sim physics if available — keeps the tram visually
    // continuous as the user enters cab mode — otherwise from the
    // schedule snapshot.
    //
    // simTimeSec is REQUIRED — callers cache it once per frame and pass
    // it in. Calling getSimTimeSec() per trip is expensive (it does a
    // Date.toLocaleString with TZ under the hood) and tanks framerate
    // when iterated across the full schedule.
    function getTramPositionRealtime(trip, simTimeSec, paused = false) {
        // Cheap bail before any allocation or work for trips that
        // haven't begun and have no carry-over physics state.
        if (!trip._physicsWall && simTimeSec < trip._startSec) return null;
        const wallNow = performance.now() / 1000;
        if (!trip._physicsWall) {
            let seed = null;
            if (trip._physics) {
                seed = {
                    state: trip._physics.state,
                    segIdx: trip._physics.segIdx,
                    dist: trip._physics.dist,
                    speed: trip._physics.speed,
                    dwellUntil: 0,
                    lastUpdateAt: wallNow,
                };
                if (seed.state === 'dwelling') {
                    seed.dwellUntil = wallNow + TRAM_DWELL_S;
                }
            } else {
                seed = seedPhysicsFromSchedule(trip, simTimeSec);
                if (!seed) return null;
                seed.lastUpdateAt = wallNow;
                if (seed.state === 'dwelling') {
                    seed.dwellUntil = wallNow + TRAM_DWELL_S;
                }
            }
            trip._physicsWall = seed;
        }
        const p = trip._physicsWall;
        const elapsed = wallNow - p.lastUpdateAt;
        if (paused && elapsed >= 0) {
            // Cab screenshot pause freezes wall-time physics too. Rebase its
            // timestamps on every paused poll so neither motion nor a station
            // dwell catches up in one jump when P is pressed again.
            p.lastUpdateAt = wallNow;
            if (p.state === 'dwelling') p.dwellUntil += elapsed;
            return poseFromPhysics(trip, p);
        }
        // Cap dt so a tab-blur / closed-then-reopened cab doesn't fast-
        // forward physics by minutes in a single frame. The tram just
        // resumes from its last known state and catches up at real speed.
        const dt = Math.min(2.0, elapsed);
        if (dt > 0) {
            stepPhysics(trip, p, dt);
            // Bring lastUpdateAt fully up to wallNow even if we capped
            // the step — otherwise the next frame would still see a huge
            // outstanding delta.
            p.lastUpdateAt = wallNow;
        } else if (dt < -10) {
            // Wall clock went BACKWARDS (rare; system clock change?) — re-seed.
            const seed = seedPhysicsFromSchedule(trip, simTimeSec);
            if (!seed) { trip._physicsWall = null; return null; }
            seed.lastUpdateAt = wallNow;
            if (seed.state === 'dwelling') seed.dwellUntil = wallNow + TRAM_DWELL_S;
            trip._physicsWall = seed;
        }
        return poseFromPhysics(trip, p);
    }

    // ─── Time ──────────────────────────────────────────────────────────────

    function getSimTimeSec() {
        return window.simClock.getSimTimeSec();
    }

    // ─── Animation ─────────────────────────────────────────────────────────

    // ─── Cab view (Station3D.openCab) ─────────────────────────────────────
    // Real ZET trams aren't part of the planning model, so they have no
    // passenger load or capacity — the HUD hides those rows when capacity is 0.

    function escHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    // Finds another currently-active trip on the same route so the cab view
    // can hand off when the followed trip reaches its final stop. Prefers the
    // trip with the most remaining time.
    function findActiveTripForRoute(routeName, timeSec, exclude) {
        let best = null;
        let bestRemaining = -Infinity;
        for (const t of schedule) {
            if (t === exclude) continue;
            if (t.routeName !== routeName) continue;
            if (timeSec >= t._startSec && timeSec <= t._endSec) {
                const remaining = t._endSec - timeSec;
                if (remaining > bestRemaining) { best = t; bestRemaining = remaining; }
            }
        }
        return best;
    }

    // Returns a poseFn closure that the cab view polls each frame. Translates
    // a getTramPosition snapshot into the {lat, lon, headingDeg, status} shape
    // station-3d.js expects. tripRef is a mutable { current } so the closure
    // can swap trips when the current one ends (prevents cab freeze at terminus).
    function makeTramPoseFn(tripRef) {
        return ({ paused = false } = {}) => {
            const timeSec = getSimTimeSec();
            let trip = tripRef.current;
            // Try the current trip with wall-time physics first; if it's
            // returning null (finished or missing) AND the schedule's end
            // has passed, switch to the next active trip on this route so
            // the cab doesn't freeze at the terminus.
            let pos = getTramPositionRealtime(trip, timeSec, paused);
            if (!pos) {
                // Wall-time physics has finished this trip (or the
                // schedule has fully ended). Try to swap to the next
                // active trip on this route — don't gate on
                // `timeSec > trip._endSec` like the previous code,
                // because wall-time physics can finish a trip while
                // sim-time is still within its scheduled window
                // (different time domains). Without this, a trip whose
                // physics ended early would freeze the cab.
                const next = findActiveTripForRoute(trip.routeName, timeSec, trip);
                if (next) {
                    console.log(`[tramSim] cab: trip ${trip.vehicleId} ended, switching to ${next.vehicleId}`);
                    tripRef.current = next;
                    trip = next;
                    pos = getTramPositionRealtime(trip, timeSec, paused);
                }
            }
            if (!pos) return null;

            // bearingDeg() returns 0=N, 90=E — exactly the convention station-3d.js wants.
            const headingDeg = pos.angle || 0;

            // Next-station distance: when moving in segment segIdx, that segment
            // ends at trip.stops[segIdx + 1]; remaining = (1 - segFrac) * totalDist.
            // When dwelling at stop segIdx, the cab HUD shows "Na stanici" instead.
            let nextStation = null;
            if (!pos.stopped && trip._segments && trip._segments[pos.segIdx]) {
                const seg = trip._segments[pos.segIdx];
                const upcoming = trip.stops[pos.segIdx + 1];
                if (upcoming) {
                    nextStation = {
                        name: upcoming.name || '',
                        distanceMeters: Math.max(0, (1 - (pos.segFrac || 0)) * seg.totalDist),
                    };
                }
            }

            // Dwell countdown: while parked at a stop, expose the seconds
            // remaining on the wall-time physics dwell timer so the HUD
            // can show a visible "Na stanici … 12 s" countdown. Read
            // straight off `_physicsWall` since the cab's pose was just
            // derived from it.
            let dwellRemainingS = null;
            if (pos.stopped && trip._physicsWall && trip._physicsWall.state === 'dwelling') {
                const p = trip._physicsWall;
                dwellRemainingS = Math.max(0, Math.ceil(p.dwellUntil - p.lastUpdateAt));
            }

            return {
                lat: pos.lat,
                lon: pos.lng,
                headingDeg,
                status: {
                    paused: !!pos.stopped,
                    stationName: pos.stopped ? (pos.stopName || null) : null,
                    dwellRemainingS,
                    nextStation,
                    totalPassengers: 0,
                    capacity: 0,
                    lastAlighted: 0,
                    lastBoarded: 0,
                },
            };
        };
    }

    // Returns a function that polls all other currently active trams each frame,
    // excluding the currently-followed trip. tripRef lets us exclude whichever
    // trip the cab has swapped to mid-stream. Player-controlled trips are also
    // hidden — they're being driven, not autopiloted, so the autopilot pose is
    // stale.
    function makeOtherTramsFn(tripRef) {
        return () => {
            // Cache simTime once per frame — getSimTimeSec() is O(slow)
            // because it crosses into Date/Intl/timezone logic. Iterating
            // it across the full schedule (thousands of trips) was making
            // FPS tank as soon as cab mode opened.
            const timeSec = getSimTimeSec();
            const myTrip = tripRef.current;
            const result = [];
            for (const trip of schedule) {
                if (trip === myTrip) continue;
                if (controlledTrips.has(trip)) continue;
                // Wall-time physics: other trams in the cab view also move
                // at human-realistic pace, regardless of the map's clock
                // multiplier.
                const pos = getTramPositionRealtime(trip, timeSec);
                if (!pos) continue;
                const color = TRAM_COLORS[trip.routeName] || DEFAULT_TRAM_COLOR;
                const id = trip.vehicleId + '_' + (trip.stops[0]?.arrivalSec ?? 0);
                // Zagreb ZET trams are all blue — route color is only for the map marker.
                // tripRef lets the cars layer reach back into the
                // autopilot's wall-time physics (`trip._physicsWall`)
                // and toggle a per-tram obstacle-stall flag when a
                // car / wreck sits in this tram's forward cone.
                result.push({ id, lat: pos.lat, lon: pos.lng, headingDeg: pos.angle || 0, color: '#1560a8', lineNumber: trip.routeName, tripRef: trip });
            }
            return result;
        };
    }

    function normalizeStopText(value) {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-zA-Z0-9]+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function listMatchingStops(query) {
        const raw = String(query || '').trim();
        if (!raw) return [];
        const byId = allTramStops.filter(stop => String(stop.stopId || '') === raw);
        if (byId.length > 0) return byId;

        const norm = normalizeStopText(raw);
        const exact = allTramStops.filter(stop => normalizeStopText(stop.name) === norm);
        const fuzzy = exact.length > 0 ? exact : allTramStops.filter(stop => normalizeStopText(stop.name).includes(norm));
        return fuzzy.sort((a, b) => String(a.stopId || '').localeCompare(String(b.stopId || '')));
    }

    function buildLinkedTripFromStop(stop, directionIndex) {
        const candidates = [];
        const seen = new Set();
        for (const trip of schedule) {
            const startIdx = trip.stops.findIndex(s => s.stopId === stop.stopId);
            if (startIdx < 0 || startIdx >= trip.stops.length - 1) continue;
            const key = `${trip.routeName}|${trip.shapeId || ''}|${startIdx}`;
            if (seen.has(key)) continue;
            seen.add(key);
            candidates.push({ trip, startIdx });
        }
        if (candidates.length === 0) return null;

        const chosen = candidates[Math.floor(Math.random() * candidates.length)];
        const remaining = chosen.trip.stops.length - 1 - chosen.startIdx;
        const goalOffset = 1 + Math.floor(Math.random() * remaining);
        const goalIdx = chosen.startIdx + goalOffset;
        const stopSlice = chosen.trip.stops.slice(chosen.startIdx, goalIdx + 1);
        const simNow = getSimTimeSec();
        const linkedStops = [];
        let cursorSec = simNow;
        for (let i = 0; i < stopSlice.length; i++) {
            const baseStop = stopSlice[i];
            if (i === 0) {
                linkedStops.push({
                    stopId: baseStop.stopId,
                    name: baseStop.name,
                    lat: baseStop.lat,
                    lng: baseStop.lng,
                    arrivalSec: cursorSec,
                    departureSec: cursorSec,
                });
                continue;
            }
            const prevStop = stopSlice[i - 1];
            const seg = findSegmentForStops(prevStop, baseStop);
            const travelSec = Math.max(20, Math.round(seg.totalDist / 7.5));
            const arrivalSec = cursorSec + travelSec;
            const departureSec = arrivalSec + DWELL_SECONDS;
            linkedStops.push({
                stopId: baseStop.stopId,
                name: baseStop.name,
                lat: baseStop.lat,
                lng: baseStop.lng,
                arrivalSec,
                departureSec,
            });
            cursorSec = departureSec;
        }

        const linkedTrip = {
            vehicleId: `linked_${Date.now()}_${stop.stopId || 'station'}_${directionIndex}`,
            routeName: chosen.trip.routeName,
            shapeId: chosen.trip.shapeId || null,
            stops: linkedStops,
        };
        precomputeTrip(linkedTrip);
        return {
            trip: linkedTrip,
            startStop: linkedStops[0],
            goalStop: linkedStops[linkedStops.length - 1],
        };
    }

    function buildLinkedTripFromTemplate(templateTrip, startIdx, options = {}) {
        const {
            endIdx = templateTrip.stops.length - 1,
            offsetMeters = 0,
        } = options;
        const safeStartIdx = Math.max(0, Math.min(startIdx, templateTrip.stops.length - 2));
        const safeEndIdx = Math.max(safeStartIdx + 1, Math.min(endIdx, templateTrip.stops.length - 1));
        const stopSlice = templateTrip.stops.slice(safeStartIdx, safeEndIdx + 1);
        const simNow = getSimTimeSec();
        const linkedStops = [];
        let cursorSec = simNow;
        for (let i = 0; i < stopSlice.length; i++) {
            const baseStop = stopSlice[i];
            if (i === 0) {
                linkedStops.push({
                    stopId: baseStop.stopId,
                    name: baseStop.name,
                    lat: baseStop.lat,
                    lng: baseStop.lng,
                    arrivalSec: cursorSec,
                    departureSec: cursorSec,
                });
                continue;
            }
            const prevStop = stopSlice[i - 1];
            const seg = findSegmentForStops(prevStop, baseStop);
            const travelSec = Math.max(20, Math.round(seg.totalDist / 7.5));
            const arrivalSec = cursorSec + travelSec;
            const departureSec = arrivalSec + DWELL_SECONDS;
            linkedStops.push({
                stopId: baseStop.stopId,
                name: baseStop.name,
                lat: baseStop.lat,
                lng: baseStop.lng,
                arrivalSec,
                departureSec,
            });
            cursorSec = departureSec;
        }

        const linkedTrip = {
            vehicleId: `linked_${Date.now()}_${templateTrip.routeName}_${stopSlice[0]?.stopId || 'stop'}`,
            routeName: templateTrip.routeName,
            shapeId: templateTrip.shapeId || null,
            stops: linkedStops,
        };
        precomputeTrip(linkedTrip);
        if (linkedTrip._segments.length > 0) {
            const wallNow = performance.now() / 1000;
            const firstSeg = linkedTrip._segments[0];
            linkedTrip._physicsWall = {
                state: 'cruising',
                segIdx: 0,
                dist: Math.max(0, Math.min(Number(offsetMeters) || 0, firstSeg.totalDist)),
                speed: 0,
                dwellUntil: 0,
                lastUpdateAt: wallNow,
            };
            linkedTrip._physics = {
                state: 'cruising',
                segIdx: 0,
                dist: linkedTrip._physicsWall.dist,
                speed: 0,
                dwellUntil: 0,
                lastUpdateAt: getSimTimeSec(),
            };
        }
        return {
            trip: linkedTrip,
            startStop: linkedStops[0],
            goalStop: linkedStops[linkedStops.length - 1],
        };
    }

    function buildQuickStartTrip() {
        const stopsById = new Map(allTramStops.map(stop => [String(stop.stopId || ''), stop]));
        let stopSlice = QUICK_START_STOP_IDS
            .map(id => stopsById.get(id))
            .filter(Boolean);
        if (stopSlice.length < 2) {
            stopSlice = allTramStops.slice(0, Math.min(11, allTramStops.length));
        }
        if (stopSlice.length < 2) {
            throw new Error('Brzi ulaz u vožnju nema dovoljno tramvajskih stanica.');
        }

        const simNow = getSimTimeSec();
        const linkedStops = [];
        let cursorSec = simNow;
        for (let i = 0; i < stopSlice.length; i++) {
            const baseStop = stopSlice[i];
            if (i === 0) {
                linkedStops.push({
                    stopId: baseStop.stopId,
                    name: baseStop.name,
                    lat: baseStop.lat,
                    lng: baseStop.lng,
                    arrivalSec: cursorSec,
                    departureSec: cursorSec,
                });
                continue;
            }
            const prevStop = stopSlice[i - 1];
            const seg = findSegmentForStops(prevStop, baseStop);
            const travelSec = Math.max(20, Math.round(seg.totalDist / 7.5));
            const arrivalSec = cursorSec + travelSec;
            const departureSec = arrivalSec + DWELL_SECONDS;
            linkedStops.push({
                stopId: baseStop.stopId,
                name: baseStop.name,
                lat: baseStop.lat,
                lng: baseStop.lng,
                arrivalSec,
                departureSec,
            });
            cursorSec = departureSec;
        }

        const linkedTrip = {
            vehicleId: `quick_${Date.now()}_${QUICK_START_LINE}`,
            routeName: QUICK_START_LINE,
            shapeId: 'quick-start',
            stops: linkedStops,
        };
        precomputeTrip(linkedTrip);
        if (linkedTrip._segments.length > 0) {
            const wallNow = performance.now() / 1000;
            // Drop the player into a tram that's already at cruise speed.
            // Starting at speed:0 makes the cab feel "stuck at a stop" for
            // the first few seconds while autopilot ramps up — not great
            // for a quick-start ride. Cruise from the first segment instead.
            linkedTrip._physicsWall = {
                state: 'cruising',
                segIdx: 0,
                dist: 0,
                speed: TRAM_MAX_SPEED_MPS,
                dwellUntil: 0,
                lastUpdateAt: wallNow,
            };
            linkedTrip._physics = {
                state: 'cruising',
                segIdx: 0,
                dist: 0,
                speed: TRAM_MAX_SPEED_MPS,
                dwellUntil: 0,
                lastUpdateAt: simNow,
            };
        }
        return {
            trip: linkedTrip,
            startStop: linkedStops[0],
            goalStop: linkedStops[linkedStops.length - 1],
        };
    }

    function getRideShareUrl(options = {}) {
        const {
            cab = 'random-tram',
            stopId = null,
            station = null,
            direction = null,
            line = null,
            shapeId = null,
            offsetMeters = null,
        } = options;
        const url = new URL(window.location.href);
        url.searchParams.set('scene', 'live-network');
        url.searchParams.delete('project');
        url.searchParams.delete('st3d');
        url.searchParams.delete('cab');
        url.searchParams.delete('station');
        url.searchParams.delete('dir');
        url.searchParams.delete('line');
        url.searchParams.delete('shape');
        url.searchParams.delete('offset');
        url.searchParams.delete('lat');
        url.searchParams.delete('lon');
        url.searchParams.delete('heading');
        url.searchParams.delete('pitch');
        url.searchParams.set(cab === 'tram-share' ? 'st3d' : 'cab', cab === 'tram-share' ? 'tram' : cab);
        if (stopId) url.searchParams.set('stop', stopId);
        else if (station) url.searchParams.set('station', station);
        if (direction != null) url.searchParams.set('dir', String(direction));
        if (line) url.searchParams.set('line', String(line));
        if (shapeId) url.searchParams.set('shape', String(shapeId));
        if (offsetMeters != null) url.searchParams.set('offset', String(Math.max(0, Math.round(offsetMeters))));
        return url.toString();
    }

    function buildShareUrlForTrip(tripRef) {
        const trip = tripRef && tripRef.current;
        if (!trip || !trip.stops || trip.stops.length < 2) return '';
        const p = trip._physicsWall;
        let stopIndex = 0;
        let offsetMeters = 0;
        if (p && p.state === 'dwelling') {
            stopIndex = Math.min(p.segIdx + 1, trip.stops.length - 2);
            offsetMeters = 0;
        } else if (p) {
            stopIndex = Math.max(0, Math.min(p.segIdx, trip.stops.length - 2));
            offsetMeters = p.dist || 0;
        }
        const refStop = trip.stops[stopIndex];
        if (!refStop || !refStop.stopId) return '';
        const sameNameStops = listMatchingStops(refStop.name);
        const direction = Math.max(0, sameNameStops.findIndex(stop => stop.stopId === refStop.stopId));
        return getRideShareUrl({
            cab: 'tram-share',
            stopId: refStop.stopId,
            direction: direction > 0 ? 1 : 0,
            line: trip.routeName,
            shapeId: trip.shapeId,
            offsetMeters,
        });
    }

    // Entering the cab from the 2D map should start from the exact tram
    // marker the user clicked, not from some stale wall-clock tram state
    // left over from a previous cab session on the same route.
    function syncWallPhysicsFromMapState(trip, simTimeSec) {
        const mapPos = getTramPosition(trip, simTimeSec);
        if (!mapPos || !trip._physics) return null;
        const wallNow = performance.now() / 1000;
        trip._physicsWall = {
            state: trip._physics.state,
            segIdx: trip._physics.segIdx,
            dist: trip._physics.dist,
            speed: trip._physics.speed,
            dwellUntil: 0,
            lastUpdateAt: wallNow,
        };
        if (trip._physicsWall.state === 'dwelling') {
            trip._physicsWall.dwellUntil = wallNow + TRAM_DWELL_S;
        }
        return mapPos;
    }

    function openCabForTrip(trip, options = {}) {
        if (!window.Station3D || typeof window.Station3D.openCab !== 'function') {
            console.warn('[tramSim] Station3D.openCab not available');
            return;
        }
        const {
            shareRideUrl = getRideShareUrl(),
            shareRideUrlProvider = null,
            initialLookPitchDeg = null,
            initialLookYawDeg = null,
        } = options;
        const simTimeSec = getSimTimeSec();
        const syncedPos = syncWallPhysicsFromMapState(trip, simTimeSec);
        const tripRef = { current: trip };
        const poseFn = makeTramPoseFn(tripRef);
        const initial = syncedPos || poseFn();
        if (!initial) {
            console.warn('[tramSim] tram is not currently active — cannot open cab view');
            return;
        }
        window.Station3D.openCab({}, { number: trip.routeName }, poseFn, {
            switchRules,
            routedSegments,
            shareRideUrl,
            shareRideUrlProvider: shareRideUrlProvider || (() => buildShareUrlForTrip(tripRef)),
            initialLookPitchDeg,
            initialLookYawDeg,
            otherTrainsFn: makeOtherTramsFn(tripRef),
            // Always pass the OSM tram network — both the visual rails layer
            // and the driver-mode routing graph need a clean unified network.
            otherTracks: osmTrackFeatures,
            allStops: allTramStops,
            // Hook so the cab can mark this trip as player-controlled when V
            // is pressed, removing it from the autopilot map + other-trams feed.
            onTakeControl: () => { controlledTrips.add(tripRef.current); },
            onReleaseControl: () => { controlledTrips.delete(tripRef.current); },
        });
    }

    function openCabAtStop(options = {}) {
        const {
            station = null,
            stop = null,
            direction = 0,
            panToMarker = true,
            minZoom = 15,
            cabOptions = {},
        } = options;
        if (!simEnabled) enableSim();

        const query = (stop || station || '').trim();
        if (!query) {
            throw new Error('Nedostaje parametar station ili stop za kabinu tramvaja.');
        }
        const matches = listMatchingStops(query);
        if (matches.length === 0) {
            throw new Error(`Stanica ili stajalište "${query}" nije pronađeno.`);
        }
        const directionIndex = Number.parseInt(direction, 10) === 1 ? 1 : 0;
        const selectedStop = matches[Math.min(directionIndex, matches.length - 1)];
        const linked = buildLinkedTripFromStop(selectedStop, directionIndex);
        if (!linked) {
            throw new Error(`Na stajalištu ${selectedStop.name} nema dostupnog polaska za ovu poveznicu.`);
        }

        if (panToMarker) {
            const nextZoom = Math.max(Number(map.getZoom?.() || minZoom), minZoom);
            map.setView([selectedStop.lat, selectedStop.lng], nextZoom, { animate: false });
        }

        openCabForTrip(linked.trip, {
            ...cabOptions,
            shareRideUrl: getRideShareUrl({
                cab: 'station',
                stopId: selectedStop.stopId,
                direction: directionIndex,
            }),
        });
        return {
            trip: linked.trip,
            startStop: linked.startStop,
            goalStop: linked.goalStop,
            selectedStop,
            position: { lat: selectedStop.lat, lng: selectedStop.lng },
        };
    }

    function openCabFromSharedPosition(options = {}) {
        const {
            line,
            stop,
            station = null,
            shape = null,
            offset = 0,
            direction = 0,
            pitch = 0,
            panToMarker = true,
            minZoom = 15,
            cabOptions = {},
        } = options;
        if (!simEnabled) enableSim();
        const query = String(stop || station || '').trim();
        if (!line || !query) {
            throw new Error('Za dijeljenje vožnje trebate line i stop/station parametre.');
        }
        const matches = listMatchingStops(query);
        if (matches.length === 0) {
            throw new Error(`Stajalište "${query}" nije pronađeno.`);
        }
        const directionIndex = Number.parseInt(direction, 10) === 1 ? 1 : 0;
        const selectedStop = matches[Math.min(directionIndex, matches.length - 1)];
        const candidates = schedule.filter(trip => {
            if (String(trip.routeName) !== String(line)) return false;
            if (shape && String(trip.shapeId || '') !== String(shape)) return false;
            const idx = trip.stops.findIndex(s => s.stopId === selectedStop.stopId);
            return idx >= 0 && idx < trip.stops.length - 1;
        });
        const fallbackCandidates = candidates.length > 0 ? candidates : schedule.filter(trip => {
            if (String(trip.routeName) !== String(line)) return false;
            const idx = trip.stops.findIndex(s => s.stopId === selectedStop.stopId);
            return idx >= 0 && idx < trip.stops.length - 1;
        });
        if (fallbackCandidates.length === 0) {
            throw new Error(`Linija ${line} nema valjanu rutu kroz ${selectedStop.name}.`);
        }
        const templateTrip = fallbackCandidates[Math.floor(Math.random() * fallbackCandidates.length)];
        const startIdx = templateTrip.stops.findIndex(s => s.stopId === selectedStop.stopId);
        const linked = buildLinkedTripFromTemplate(templateTrip, startIdx, {
            offsetMeters: Number(offset) || 0,
        });

        if (panToMarker) {
            const nextZoom = Math.max(Number(map.getZoom?.() || minZoom), minZoom);
            map.setView([selectedStop.lat, selectedStop.lng], nextZoom, { animate: false });
        }

        openCabForTrip(linked.trip, {
            ...cabOptions,
            initialLookPitchDeg: Number(pitch) || 0,
        });
        return {
            trip: linked.trip,
            startStop: linked.startStop,
            goalStop: linked.goalStop,
            selectedStop,
            position: { lat: selectedStop.lat, lng: selectedStop.lng },
        };
    }

    // Opens a small click popup ("Tram N" + "U kabinu" button) at the pointer.
    // It deliberately belongs to the map, not the moving marker: chasing a
    // button that keeps travelling with the tram makes the popup unusable.
    function bindCabPopup(marker, trip) {
        const html =
            `<div class="tram-cab-popup">` +
                `<div class="tram-cab-popup-line">Tram ${escHtml(trip.routeName || '?')}</div>` +
                `<button type="button" class="tram-cab-popup-btn">U kabinu</button>` +
            `</div>`;
        const openAt = (latlng) => {
            const popup = L.popup({ closeButton: true, autoClose: true })
                .setLatLng(latlng || marker.getLatLng())
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
        };
        marker.openCabPopupAt = openAt;
        marker.on('click', e => {
            L.DomEvent.stopPropagation(e);
            const pointerLatLng = e.originalEvent
                ? map.mouseEventToLatLng(e.originalEvent)
                : marker.getLatLng();
            openAt(pointerLatLng);
        });
    }

    function createTramIcon(routeName) {
        const color = TRAM_COLORS[routeName] || DEFAULT_TRAM_COLOR;
        return L.divIcon({
            className: 'train-marker train-marker-overground',
            html: `<div class="train-marker-shell" style="--train-color:${color}">
                <div class="train-marker-icon"></div>
                <div class="train-stop-indicator" aria-hidden="true"></div>
            </div>`,
            iconSize: [44, 44],
            iconAnchor: [22, 22],
        });
    }

    function upsertTramMarker(trip, pos, markerId) {
        let marker = tramMarkers.get(markerId);
        if (!marker) {
            marker = L.marker([pos.lat, pos.lng], {
                icon: createTramIcon(trip.routeName),
                pane: 'markerPane',
                interactive: true,
                keyboard: false,
                zIndexOffset: 900,
            }).addTo(map);
            marker.bindTooltip('', { direction: 'top', offset: [0, -15] });
            bindCabPopup(marker, trip);
            tramMarkers.set(markerId, marker);
        }
        marker.setLatLng([pos.lat, pos.lng]);

        let info = `<strong>Tram ${trip.routeName}</strong>`;
        if (pos.stopped && pos.stopName) {
            info += `<br>${pos.stopName}`;
        }
        marker.setTooltipContent(info);

        const el = marker.getElement();
        if (el) {
            const icon = el.querySelector('.train-marker-icon');
            if (icon) icon.style.setProperty('--train-angle', `${pos.angle - 90}deg`);
            el.classList.toggle('is-stopped', pos.stopped);
        }

        if (!map.hasLayer(marker)) marker.addTo(map);
        return marker;
    }

    function getActiveTrips(timeSec = getSimTimeSec()) {
        const activeTrips = [];
        for (const trip of schedule) {
            // Player-controlled trams are driven by the cab view, not by the
            // schedule; hide their autopilot ghost from the map.
            if (controlledTrips.has(trip)) continue;
            const pos = getTramPosition(trip, timeSec);
            if (!pos) continue;
            activeTrips.push({
                trip,
                pos,
                markerId: trip.vehicleId + '_' + trip.stops[0].arrivalSec,
            });
        }
        preventOvertaking(activeTrips);
        return activeTrips;
    }

    function focusRandomActiveTram(options = {}) {
        const {
            openCab = false,
            openPopup = !openCab,
            panToMarker = true,
            minZoom = 15,
            quickStart = false,
            cabOptions = {},
        } = options;

        if (!simEnabled) enableSim();

        if (quickStart && openCab) {
            const linked = buildQuickStartTrip();
            const pos = getTramPositionRealtime(linked.trip, getSimTimeSec());
            if (!pos) return null;
            const markerId = linked.trip.vehicleId + '_' + linked.trip.stops[0].arrivalSec;
            const marker = upsertTramMarker(linked.trip, pos, markerId);

            if (panToMarker) {
                const nextZoom = Math.max(Number(map.getZoom?.() || minZoom), minZoom);
                map.setView([pos.lat, pos.lng], nextZoom, { animate: false });
            }
            if (openPopup && marker.openCabPopupAt) marker.openCabPopupAt();
            openCabForTrip(linked.trip, cabOptions);

            return {
                trip: linked.trip,
                markerId,
                marker,
                startStop: linked.startStop,
                goalStop: linked.goalStop,
                quickStart: true,
                position: { lat: pos.lat, lng: pos.lng },
            };
        }

        const activeTrips = getActiveTrips();
        if (activeTrips.length === 0) return null;

        const selected = activeTrips[Math.floor(Math.random() * activeTrips.length)];
        const marker = upsertTramMarker(selected.trip, selected.pos, selected.markerId);

        if (panToMarker) {
            const nextZoom = Math.max(Number(map.getZoom?.() || minZoom), minZoom);
            map.setView([selected.pos.lat, selected.pos.lng], nextZoom, { animate: false });
        }
        if (openPopup && marker.openCabPopupAt) marker.openCabPopupAt();
        if (openCab) openCabForTrip(selected.trip, cabOptions);

        return {
            trip: selected.trip,
            markerId: selected.markerId,
            marker,
            position: { lat: selected.pos.lat, lng: selected.pos.lng },
        };
    }

    // Prevent same-route, same-direction trams from overtaking each other.
    // Trams share a single track per direction — physically impossible to pass.
    // GTFS data sometimes shows overtaking due to GPS/timing imprecision.
    const OVERTAKE_CHECK_DIST_M = 80;
    const MIN_GAP_M = 5;
    const toRad = d => d * Math.PI / 180;

    function preventOvertaking(activeTrips) {
        const byRoute = new Map();
        for (const entry of activeTrips) {
            const route = entry.trip.routeName;
            if (!byRoute.has(route)) byRoute.set(route, []);
            byRoute.get(route).push(entry);
        }

        for (const trams of byRoute.values()) {
            if (trams.length < 2) continue;

            for (let i = 0; i < trams.length; i++) {
                for (let j = i + 1; j < trams.length; j++) {
                    const a = trams[i], b = trams[j];
                    if (a.pos.stopped && b.pos.stopped) continue;

                    const dist = haversineMeters(a.pos.lat, a.pos.lng, b.pos.lat, b.pos.lng);
                    if (dist > OVERTAKE_CHECK_DIST_M || dist < 1) continue;

                    // Check same direction (bearing within 90°)
                    let angleDiff = Math.abs(a.pos.angle - b.pos.angle);
                    if (angleDiff > 180) angleDiff = 360 - angleDiff;
                    if (angleDiff > 90) continue;

                    // Find which shared stop they're both heading towards next.
                    // Build a set of stop names from trip B's upcoming stops.
                    const bUpcoming = new Map();
                    for (let si = b.pos.segIdx; si < b.trip.stops.length; si++) {
                        bUpcoming.set(b.trip.stops[si].name, b.trip.stops[si].arrivalSec);
                    }
                    // Find the first upcoming stop in trip A that also appears in B's upcoming stops
                    let aNextShared = null, bNextShared = null;
                    for (let si = a.pos.segIdx; si < a.trip.stops.length; si++) {
                        const bArr = bUpcoming.get(a.trip.stops[si].name);
                        if (bArr !== undefined) {
                            aNextShared = a.trip.stops[si].arrivalSec;
                            bNextShared = bArr;
                            break;
                        }
                    }
                    // If no shared upcoming stop, skip — different branches
                    if (aNextShared === null) continue;

                    // Whoever arrives at the shared stop first should be AHEAD.
                    // Determine who is currently ahead using bearing projection.
                    const avgAngle = toRad((a.pos.angle + b.pos.angle) / 2);
                    const dirY = Math.cos(avgAngle);
                    const dirX = Math.sin(avgAngle);
                    const dy = b.pos.lat - a.pos.lat;
                    const dx = b.pos.lng - a.pos.lng;
                    const dot = dx * dirX + dy * dirY;
                    // dot > 0 means b is ahead of a

                    const aShouldBeAhead = aNextShared <= bNextShared;

                    if (dot > 0 && aShouldBeAhead) {
                        // b is ahead but a should be — hold b behind a
                        b.pos.lat = a.pos.lat - dirY * MIN_GAP_M / 111320;
                        b.pos.lng = a.pos.lng - dirX * MIN_GAP_M / (111320 * Math.cos(toRad(a.pos.lat)));
                        b.pos.angle = a.pos.angle;
                    } else if (dot < 0 && !aShouldBeAhead) {
                        // a is ahead but b should be — hold a behind b
                        a.pos.lat = b.pos.lat - dirY * MIN_GAP_M / 111320;
                        a.pos.lng = b.pos.lng - dirX * MIN_GAP_M / (111320 * Math.cos(toRad(b.pos.lat)));
                        a.pos.angle = b.pos.angle;
                    }
                }
            }
        }
    }

    function updateTrams() {
        if (!simEnabled) return;
        const activeTrips = getActiveTrips();
        const activeMarkerIds = new Set();
        for (const { trip, pos, markerId } of activeTrips) {
            activeMarkerIds.add(markerId);
            upsertTramMarker(trip, pos, markerId);
        }

        for (const [markerId, marker] of tramMarkers) {
            if (!activeMarkerIds.has(markerId) && map.hasLayer(marker)) {
                map.removeLayer(marker);
            }
        }
    }

    function startMapUpdateLoop() {
        if (mapUpdateTimer !== null || mapUpdatesSuspended || !scheduleLoaded) return;
        if (simEnabled) updateTrams();
        mapUpdateTimer = setInterval(updateTrams, UPDATE_INTERVAL_MS);
    }

    function stopMapUpdateLoop() {
        if (mapUpdateTimer === null) return;
        clearInterval(mapUpdateTimer);
        mapUpdateTimer = null;
    }

    function setMapUpdatesSuspended(active) {
        const next = !!active;
        if (mapUpdatesSuspended === next) return;
        mapUpdatesSuspended = next;
        if (next) stopMapUpdateLoop();
        else startMapUpdateLoop();
    }

    // ─── Track Layer ──────────────────────────────────────────────────────

    function showTracks() {
        if (trackLayer) map.removeLayer(trackLayer);
        trackLayer = L.geoJSON({ type: 'FeatureCollection', features: trackFeatures }, {
            style: {
                color: '#1a73e8',
                weight: 2,
                opacity: 0.4,
                dashArray: '4,4',
            },
            interactive: false,
        }).addTo(map);
    }

    function hideTracks() {
        if (trackLayer) { map.removeLayer(trackLayer); trackLayer = null; }
    }

    // ─── Toggle ────────────────────────────────────────────────────────────

    function enableSim() {
        ensureInitialized();
        // Live tram markers are schedule-driven; readyPromise reports failures.
        ensureScheduleLoaded().catch(() => {});
        if (simEnabled) return;
        simEnabled = true;
        showTracks();
        updateTrams();
        window.simClock.setSimActive('tram', true);
    }

    function disableSim() {
        if (!simEnabled) return;
        simEnabled = false;
        hideTracks();
        for (const [, marker] of tramMarkers) {
            if (map.hasLayer(marker)) map.removeLayer(marker);
        }
        tramMarkers.clear();
        window.simClock.setSimActive('tram', false);
    }

    function setSimEnabled(enabled) {
        if (enabled) enableSim(); else disableSim();
    }

    window.tramSim = {
        setEnabled: setSimEnabled,
        isEnabled: () => simEnabled,
        whenReady: () => {
            // Full readiness includes the schedule; kick its lazy fetch. The
            // returned readyPromise carries any failure to the caller.
            ensureScheduleLoaded().catch(() => {});
            return readyPromise;
        },
        whenLightReady: () => {
            ensureInitialized();
            return lightReadyPromise;
        },
        focusRandomActiveTram,
        openCabAtStop,
        openCabFromSharedPosition,
        getOsmTrackFeatures: () => osmTrackFeatures,
    };
    window.dispatchEvent(new CustomEvent('tramSim:api-ready'));
    window.addEventListener('station3d:visibility', event => {
        setMapUpdatesSuspended(!!event.detail?.active);
    });

    // ─── Init ──────────────────────────────────────────────────────────────

    // Pull the deploy version off any script tag the deploy script rewrote.
    // We append the same `?v=…` to data fetches so a redeploy invalidates
    // both the JS and the JSON it consumes in one shot.
    function deployCacheBust() {
        if (typeof document === 'undefined') return '';
        for (const s of document.getElementsByTagName('script')) {
            const m = (s.src || '').match(/\?v=([^&]+)/);
            if (m) return `?v=${m[1]}`;
        }
        return '';
    }

    async function loadSimulationData() {
        const cb = deployCacheBust();
        try {
            // OSM tracks fetched in parallel; if TRACK_SOURCE is already 'osm'
            // the response is reused instead of refetching the same file.
            const fetchOsm = TRACK_SOURCE === 'osm'
                ? null
                : fetch(OSM_TRACKS_URL + cb).then(r => r.json());
            const [tracksResp, segmentsResp, osmRespMaybe, switchRulesResp, stopsResp] = await Promise.all([
                fetch(TRACKS_URL + cb).then(r => r.json()),
                fetch(SEGMENTS_URL + cb).then(r => r.json()),
                fetchOsm,
                fetch(SWITCH_RULES_URL + cb)
                    .then(async r => (r.ok ? r.json() : { version: 1, switches: {} }))
                    .catch(() => ({ version: 1, switches: {} })),
                fetch(STOPS_URL + cb).then(r => r.json()).catch(() => []),
            ]);

            trackFeatures = tracksResp.features || [];
            routedSegments = segmentsResp || {};
            osmTrackFeatures = (osmRespMaybe || tracksResp).features || [];
            allTramStops = Array.isArray(stopsResp) ? stopsResp : [];
            switchRules = window.TramSwitchUtils && typeof window.TramSwitchUtils.normalizeSwitchRules === 'function'
                ? window.TramSwitchUtils.normalizeSwitchRules(switchRulesResp)
                : (switchRulesResp || { version: 1, switches: {} });

            const switchRuleCount = Object.values(switchRules.switches || {}).reduce(
                (sum, incomingMap) => sum + Object.keys(incomingMap || {}).length,
                0
            );
            console.log(`Tram sim light: ${trackFeatures.length} track features, ${osmTrackFeatures.length} OSM features, ${Object.keys(routedSegments).length} routed pairs loaded, ${switchRuleCount} switch rules`);
            if (simEnabled) showTracks();
            resolveLightReady?.();
            window.dispatchEvent(new CustomEvent('tramSim:light-ready'));
        } catch (err) {
            console.error('Tram sim quick-start data failed to load:', err);
            rejectLightReady?.(err);
            rejectReady?.(err);
            window.dispatchEvent(new CustomEvent('tramSim:error', { detail: err }));
        }
    }

    function ensureInitialized() {
        if (!initPromise) initPromise = loadSimulationData();
        return initPromise;
    }

    // The 5.4 MB schedule is fetched only when something actually needs trips:
    // the live-tram map layer (enableSim), or a cab/whenReady consumer. Every
    // plain open — 2D planner work, walk worlds, other cities — pays only for
    // the light data above (tracks, stops, switch rules), which the cab visuals
    // and routing genuinely need.
    let schedulePromise = null;
    function ensureScheduleLoaded() {
        if (!schedulePromise) {
            schedulePromise = (async () => {
                await ensureInitialized();
                await lightReadyPromise;
                const scheduleResp = await fetch(scheduleUrl()).then(r => r.json());
                schedule = decodeSchedule(scheduleResp.trips || []);
                console.log(`Tram sim schedule: ${schedule.length} trips loaded`);
                precomputeTrips();
                scheduleLoaded = true;
                startMapUpdateLoop();
                resolveReady?.();
                window.dispatchEvent(new CustomEvent('tramSim:ready'));
            })().catch(err => {
                console.error('Tram sim failed to load:', err);
                rejectReady?.(err);
                window.dispatchEvent(new CustomEvent('tramSim:error', { detail: err }));
                throw err;
            });
        }
        return schedulePromise;
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
