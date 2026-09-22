// Passenger demand simulation using a gravity model.
// Each station generates departures (demand) and attracts arrivals (supply)
// based on catchment population/jobs and time-of-day commute patterns.

const PassengerDemand = (() => {

    // Distance decay exponent — controls how strongly travel time dampens demand.
    // 2 is the standard transport-planning value.
    const DECAY_EXPONENT = 2;

    // Scale factor: what fraction of catchment population actually travels per hour.
    // Kept low so numbers look reasonable on-screen.
    const TRIP_RATE_PER_HOUR = 0.02;

    // Time-of-day activity profiles.
    // Each returns a multiplier (0–1) for the given hour (0–24 continuous).
    // "commute" peaks morning+evening, "reverse" is the mirror, "baseline" is flat.
    function commuteProfile(hour) {
        // Morning peak 7–9, evening peak 17–19
        return gaussian(hour, 8, 1.2) + gaussian(hour, 18, 1.2);
    }

    function reverseCommuteProfile(hour) {
        // People arriving at residential areas in the evening, leaving jobs in morning
        return gaussian(hour, 9.5, 1.5) + gaussian(hour, 17, 1.5);
    }

    function baselineProfile(hour) {
        // Low flat activity during waking hours (7–23), near-zero at night
        return gaussian(hour, 14, 5) * 0.3;
    }

    function gaussian(x, mean, sigma) {
        const d = x - mean;
        return Math.exp(-(d * d) / (2 * sigma * sigma));
    }

    // Walking penalty for transferring between lines at a transfer station (minutes).
    const TRANSFER_WALK_MINUTES = 3;

    /**
     * Build a station adjacency graph from lines and transfer links.
     * Edges within a line use line motion profile offsets for travel time.
     * Transfer link edges add a fixed walk penalty.
     * Returns: Map<stationId, [{toId, timeMinutes}]>
     */
    function buildStationGraph(stations, lines, transferLinks) {
        const graph = new Map();
        for (const st of stations) graph.set(st.id, []);

        // Edges from lines: consecutive stations connected by travel time along line
        for (const line of lines) {
            if (!line.stationStops || line.stationStops.length < 2) continue;
            const speedMps = line.trainSpeedMetersPerSecond || 10;
            const sorted = [...line.stationStops].sort((a, b) => a.offsetMeters - b.offsetMeters);
            for (let i = 0; i < sorted.length - 1; i++) {
                const a = sorted[i], b = sorted[i + 1];
                const distMeters = Math.abs(b.offsetMeters - a.offsetMeters);
                const timeMin = (distMeters / speedMps) / 60;
                if (graph.has(a.stationId) && graph.has(b.stationId)) {
                    graph.get(a.stationId).push({ toId: b.stationId, timeMinutes: timeMin });
                    graph.get(b.stationId).push({ toId: a.stationId, timeMinutes: timeMin });
                }
            }
        }

        // Edges from transfer links: walk between connected stations
        if (transferLinks) {
            for (const link of transferLinks) {
                if (graph.has(link.stationIdA) && graph.has(link.stationIdB)) {
                    graph.get(link.stationIdA).push({ toId: link.stationIdB, timeMinutes: TRANSFER_WALK_MINUTES });
                    graph.get(link.stationIdB).push({ toId: link.stationIdA, timeMinutes: TRANSFER_WALK_MINUTES });
                }
            }
        }

        return graph;
    }

    // Binary min-heap for Dijkstra priority queue.
    function _heapPush(heap, item) {
        heap.push(item);
        let i = heap.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (heap[parent].d <= heap[i].d) break;
            [heap[parent], heap[i]] = [heap[i], heap[parent]];
            i = parent;
        }
    }

    function _heapPop(heap) {
        const top = heap[0];
        const last = heap.pop();
        if (heap.length > 0) {
            heap[0] = last;
            let i = 0;
            const n = heap.length;
            while (true) {
                let smallest = i;
                const l = 2 * i + 1, r = 2 * i + 2;
                if (l < n && heap[l].d < heap[smallest].d) smallest = l;
                if (r < n && heap[r].d < heap[smallest].d) smallest = r;
                if (smallest === i) break;
                [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
                i = smallest;
            }
        }
        return top;
    }

    /**
     * All-pairs shortest travel times via Dijkstra from each source.
     * Uses a binary min-heap for O(E log V) per source instead of O(V² log V).
     * Returns: Map<fromId, Map<toId, timeMinutes>>
     */
    function computeAllPairsShortestPaths(graph) {
        const allPairs = new Map();
        for (const sourceId of graph.keys()) {
            const dist = new Map();
            dist.set(sourceId, 0);
            const heap = [];
            _heapPush(heap, { id: sourceId, d: 0 });
            while (heap.length > 0) {
                const { id, d } = _heapPop(heap);
                if (d > (dist.get(id) ?? Infinity)) continue;
                for (const edge of (graph.get(id) || [])) {
                    const nd = d + edge.timeMinutes;
                    if (nd < (dist.get(edge.toId) ?? Infinity)) {
                        dist.set(edge.toId, nd);
                        _heapPush(heap, { id: edge.toId, d: nd });
                    }
                }
            }
            allPairs.set(sourceId, dist);
        }
        return allPairs;
    }

    /**
     * Compute travel time in minutes between two stations.
     * Uses precomputed shortest paths if available, falls back to straight-line at 30km/h.
     */
    function travelTimeBetween(stationA, stationB, shortestPaths) {
        if (shortestPaths) {
            const fromDists = shortestPaths.get(stationA.id);
            if (fromDists) {
                const t = fromDists.get(stationB.id);
                if (t !== undefined && t !== Infinity) return t;
            }
        }
        // Disconnected stations: straight-line distance at 30 km/h
        const distMeters = L.latLng(stationA.latlng).distanceTo(L.latLng(stationB.latlng));
        return (distMeters / (30 * 1000 / 3600)) / 60;
    }

    /**
     * Build gravity weights matrix.
     * Returns a Map: stationId -> Map(otherStationId -> weight)
     * Weight of station j as destination from station i = attraction(j) / travelTime(i,j)^decay
     */
    function buildGravityWeights(stations, lines, attractionFn, shortestPaths) {
        const weights = new Map();

        for (const origin of stations) {
            const destWeights = new Map();
            let totalWeight = 0;

            for (const dest of stations) {
                if (dest.id === origin.id) continue;
                const attraction = attractionFn(dest);
                if (attraction <= 0) continue;

                const tt = travelTimeBetween(origin, dest, shortestPaths);
                const effectiveTT = Math.max(tt, 0.5); // floor at 30 seconds
                const w = attraction / Math.pow(effectiveTT, DECAY_EXPONENT);
                destWeights.set(dest.id, w);
                totalWeight += w;
            }

            // Normalize to probabilities
            if (totalWeight > 0) {
                for (const [id, w] of destWeights) {
                    destWeights.set(id, w / totalWeight);
                }
            }

            weights.set(origin.id, destWeights);
        }

        return weights;
    }

    // Topology cache: avoid rebuilding graph/shortest paths every tick when network hasn't changed.
    let _cachedTopologyVersion = -1;
    let _cachedGraph = null;
    let _cachedShortestPaths = null;

    // Gravity weights cache: rebuild only when topology changes or simHour shifts enough.
    // The weights depend on time-of-day attraction blend, which changes smoothly,
    // so a 0.25h (~15min) staleness threshold avoids most rebuilds.
    const GRAVITY_STALENESS_HOURS = 0.25;
    let _cachedGravityWeights = null;
    let _cachedGravityHour = -Infinity;
    let _cachedGravityTopology = -1;

    /**
     * Invalidate topology cache. Call when stations, lines, or transfer links change.
     */
    function invalidateTopologyCache() {
        _cachedTopologyVersion = -1;
        _cachedGravityTopology = -1; // also invalidate gravity weights
    }

    /**
     * Invalidate only gravity weights (not graph/shortest paths).
     * Call when station catchment data (population/jobs) changes without topology change.
     */
    function invalidateGravityCache() {
        _cachedGravityTopology = -1;
    }

    /**
     * Main computation: for each station, compute supply and demand at a given hour.
     *
     * Demand at station i = people wanting to DEPART from station i
     *   = catchmentPopulation(i) * commuteRate(hour) + catchmentJobs(i) * reverseCommuteRate(hour) + baseline
     *
     * Supply at station i = people wanting to ARRIVE at station i
     *   = sum over all j: demand(j) * gravityWeight(j -> i)
     *
     * Returns: Map<stationId, { supply, demand }>
     */
    function compute(stations, lines, hour, tracks, transferLinks, topologyVersion) {
        if (stations.length === 0) return new Map();

        const result = new Map();

        // Step 1: Trip generation — compute raw demand (departures) at each station
        const morningFactor = commuteProfile(hour);
        const eveningFactor = reverseCommuteProfile(hour);
        const baseFactor = baselineProfile(hour);

        for (const station of stations) {
            const pop = station.catchmentPopulation || 0;
            const jobs = station.catchmentJobs || 0;

            // Residents depart during morning commute, arrive during evening
            // Workers depart during evening, arrive during morning
            const demand = (pop * morningFactor + jobs * eveningFactor + (pop + jobs) * baseFactor) * TRIP_RATE_PER_HOUR;

            result.set(station.id, { supply: 0, demand: Math.round(demand) });
        }

        // Step 2: Trip distribution — where do departing passengers want to go?
        // Use jobs as attraction for morning (people go to work), population for evening (people go home)
        const morningWeight = morningFactor / (morningFactor + eveningFactor + baseFactor + 0.001);
        const eveningWeight = eveningFactor / (morningFactor + eveningFactor + baseFactor + 0.001);

        // Blended attraction: during morning rush, jobs attract; during evening, residents attract
        const attractionFn = (dest) => {
            const jobs = dest.catchmentJobs || 0;
            const pop = dest.catchmentPopulation || 0;
            return jobs * morningWeight + pop * eveningWeight + (pop + jobs) * (1 - morningWeight - eveningWeight) * 0.5;
        };

        // Reuse cached graph/shortest paths if topology hasn't changed
        const tv = topologyVersion ?? -1;
        if (tv !== _cachedTopologyVersion || !_cachedGraph) {
            _cachedGraph = buildStationGraph(stations, lines, transferLinks);
            _cachedShortestPaths = computeAllPairsShortestPaths(_cachedGraph);
            _cachedTopologyVersion = tv;
        }
        const shortestPaths = _cachedShortestPaths;

        // Reuse cached gravity weights if topology and time-of-day haven't shifted much
        if (!_cachedGravityWeights || tv !== _cachedGravityTopology || Math.abs(hour - _cachedGravityHour) >= GRAVITY_STALENESS_HOURS) {
            _cachedGravityWeights = buildGravityWeights(stations, lines, attractionFn, shortestPaths);
            _cachedGravityHour = hour;
            _cachedGravityTopology = tv;
        }
        const gravityWeights = _cachedGravityWeights;

        // Step 3: Distribute demand to supply at destinations
        for (const station of stations) {
            const entry = result.get(station.id);
            const destWeights = gravityWeights.get(station.id);
            if (!destWeights || entry.demand <= 0) continue;

            for (const [destId, probability] of destWeights) {
                const destEntry = result.get(destId);
                if (destEntry) {
                    destEntry.supply += entry.demand * probability;
                }
            }
        }

        // Round supply values
        for (const entry of result.values()) {
            entry.supply = Math.round(entry.supply);
        }

        return result;
    }

    return { compute, buildStationGraph, computeAllPairsShortestPaths, invalidateTopologyCache, invalidateGravityCache, TRANSFER_WALK_MINUTES };
})();
