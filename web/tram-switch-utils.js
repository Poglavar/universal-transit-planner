// Shared tram switch helpers for the browser. They build an exact OSM tram
// graph, identify switch nodes and arms, and evaluate manual incoming->outgoing
// turn rules without ever inventing connectivity from nearby geometry.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.TramSwitchUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

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

    function angularDeltaDeg(a, b) {
        let diff = Math.abs(a - b) % 360;
        if (diff > 180) diff = 360 - diff;
        return diff;
    }

    function nodeKeyForCoords(lat, lng) {
        return `${lat.toFixed(7)},${lng.toFixed(7)}`;
    }

    function lineStringsFromGeometry(geometry) {
        if (!geometry) return [];
        if (geometry.type === 'LineString') return [geometry.coordinates];
        if (geometry.type === 'MultiLineString') return geometry.coordinates;
        return [];
    }

    function buildExactGraph(features) {
        const nodes = [];
        const nodeIndex = new Map();
        const edges = [];
        const edgeIndex = new Map();
        const dirEdges = [];
        const outgoing = [];

        function findOrCreateNode(lat, lng) {
            const key = nodeKeyForCoords(lat, lng);
            if (nodeIndex.has(key)) return nodeIndex.get(key);
            const id = nodes.length;
            nodes.push({ id, lat, lng, key, adj: [] });
            outgoing.push([]);
            nodeIndex.set(key, id);
            return id;
        }

        function addSegment(aLat, aLng, bLat, bLng, lineIdx) {
            const u = findOrCreateNode(aLat, aLng);
            const v = findOrCreateNode(bLat, bLng);
            if (u === v) return;
            const edgeKey = u < v ? `${u}:${v}` : `${v}:${u}`;
            if (edgeIndex.has(edgeKey)) return;

            const len = haversineMeters(aLat, aLng, bLat, bLng);
            const forwardBearing = bearingDeg(aLat, aLng, bLat, bLng);
            const backwardBearing = bearingDeg(bLat, bLng, aLat, aLng);
            const edgeId = edges.length;
            const edge = {
                id: edgeId,
                u, v,
                a: u, b: v,
                len,
                length: len,
                lineIdx,
                aLat, aLng, bLat, bLng,
                lat1: aLat, lng1: aLng,
                lat2: bLat, lng2: bLng,
                midLat: (aLat + bLat) * 0.5,
                midLng: (aLng + bLng) * 0.5,
                forwardBearing,
                backwardBearing,
                bearing: forwardBearing,
                dirForwardId: -1,
                dirBackwardId: -1,
            };
            edges.push(edge);
            edgeIndex.set(edgeKey, edgeId);

            const dirForwardId = dirEdges.length;
            dirEdges.push({
                id: dirForwardId,
                edgeId,
                from: u,
                to: v,
                len,
                bearing: forwardBearing,
                fromLat: aLat,
                fromLng: aLng,
                toLat: bLat,
                toLng: bLng,
                midLat: edge.midLat,
                midLng: edge.midLng,
            });
            const dirBackwardId = dirEdges.length;
            dirEdges.push({
                id: dirBackwardId,
                edgeId,
                from: v,
                to: u,
                len,
                bearing: backwardBearing,
                fromLat: bLat,
                fromLng: bLng,
                toLat: aLat,
                toLng: aLng,
                midLat: edge.midLat,
                midLng: edge.midLng,
            });
            edge.dirForwardId = dirForwardId;
            edge.dirBackwardId = dirBackwardId;

            nodes[u].adj.push({ edgeId, other: v });
            nodes[v].adj.push({ edgeId, other: u });
            outgoing[u].push(dirForwardId);
            outgoing[v].push(dirBackwardId);
        }

        for (let lineIdx = 0; lineIdx < (features || []).length; lineIdx++) {
            const feature = features[lineIdx];
            for (const coords of lineStringsFromGeometry(feature && feature.geometry)) {
                for (let i = 1; i < coords.length; i++) {
                    const [aLng, aLat] = coords[i - 1];
                    const [bLng, bLat] = coords[i];
                    addSegment(aLat, aLng, bLat, bLng, lineIdx);
                }
            }
        }

        return { nodes, nodeIndex, edges, edgeIndex, dirEdges, outgoing };
    }

    function isSwitchNode(graph, nodeId) {
        const node = graph && graph.nodes && graph.nodes[nodeId];
        return !!node && node.adj.length >= 3;
    }

    function isDecisionNode(graph, nodeId) {
        const node = graph && graph.nodes && graph.nodes[nodeId];
        return !!node && node.adj.length !== 2;
    }

    function traceArm(graph, switchNodeId, neighborNodeId) {
        const visited = new Set([`${switchNodeId}:${neighborNodeId}`]);
        const nodeIds = [switchNodeId, neighborNodeId];
        let prev = switchNodeId;
        let cur = neighborNodeId;
        let length = 0;

        const startNode = graph.nodes[switchNodeId];
        const nextNode = graph.nodes[neighborNodeId];
        const startBearing = bearingDeg(startNode.lat, startNode.lng, nextNode.lat, nextNode.lng);

        while (true) {
            length += haversineMeters(
                graph.nodes[prev].lat,
                graph.nodes[prev].lng,
                graph.nodes[cur].lat,
                graph.nodes[cur].lng
            );
            if (isDecisionNode(graph, cur)) break;
            const nextAdj = graph.nodes[cur].adj.find(a => a.other !== prev);
            if (!nextAdj) break;
            const key = `${cur}:${nextAdj.other}`;
            if (visited.has(key)) break;
            visited.add(key);
            prev = cur;
            cur = nextAdj.other;
            nodeIds.push(cur);
        }

        const coords = nodeIds.map(id => [graph.nodes[id].lat, graph.nodes[id].lng]);
        return {
            switchNodeId,
            firstNeighborNodeId: neighborNodeId,
            firstNeighborKey: graph.nodes[neighborNodeId].key,
            endNodeId: cur,
            endNodeKey: graph.nodes[cur].key,
            nodeIds,
            coords,
            lengthMeters: length,
            bearingDeg: startBearing,
        };
    }

    function getSwitchNodeIds(graph) {
        const out = [];
        for (const node of graph.nodes) {
            if (node.adj.length >= 3) out.push(node.id);
        }
        return out;
    }

    function getSwitchArms(graph, switchNodeId) {
        const node = graph.nodes[switchNodeId];
        if (!node) return [];
        const arms = node.adj.map(adj => traceArm(graph, switchNodeId, adj.other));
        arms.sort((a, b) => a.bearingDeg - b.bearingDeg);
        return arms;
    }

    function emptyRules() {
        return { version: 1, switches: {} };
    }

    function normalizeSwitchRules(raw) {
        // Fast path: output of a previous normalize. The sim normalizes its
        // rules once at load and then calls getAllowedOutgoingKeys thousands
        // of times per second from the driver look-ahead — rebuilding the
        // whole map on every lookup cost ~1.7 ms per physics frame. The
        // marker is non-enumerable so JSON.stringify (editor save) never
        // sees it.
        if (raw && typeof raw === 'object' && raw.__normalized === true) return raw;
        const out = emptyRules();
        if (!raw || typeof raw !== 'object') return out;
        if (raw.version != null) out.version = raw.version;
        const switches = raw.switches;
        if (!switches || typeof switches !== 'object') return out;
        for (const [switchKey, incomingMap] of Object.entries(switches)) {
            if (!incomingMap || typeof incomingMap !== 'object') continue;
            const normIncoming = {};
            for (const [incomingKey, allowed] of Object.entries(incomingMap)) {
                if (!Array.isArray(allowed)) continue;
                const clean = Array.from(new Set(
                    allowed
                        .filter(v => typeof v === 'string' && v.trim())
                        .map(v => v.trim())
                ));
                normIncoming[incomingKey] = clean;
            }
            out.switches[switchKey] = normIncoming;
        }
        Object.defineProperty(out, '__normalized', { value: true });
        return out;
    }

    function getAllowedOutgoingKeys(rules, switchKey, incomingKey) {
        const normalized = normalizeSwitchRules(rules);
        const switchRules = normalized.switches[switchKey];
        if (!switchRules) return null;
        if (!Object.prototype.hasOwnProperty.call(switchRules, incomingKey)) return null;
        return switchRules[incomingKey];
    }

    function routeCoordKey(lng, lat) {
        return `${(Math.round(lng * 1e6) / 1e6).toFixed(6)},${(Math.round(lat * 1e6) / 1e6).toFixed(6)}`;
    }

    function buildDirectedSwitchUsage(graph, routedSegments) {
        const out = { switches: {} };
        if (!graph || !routedSegments || typeof routedSegments !== 'object') return out;

        const dirEdgeByPair = new Map();
        for (const dir of graph.dirEdges || []) {
            dirEdgeByPair.set(
                `${routeCoordKey(dir.fromLng, dir.fromLat)}>${routeCoordKey(dir.toLng, dir.toLat)}`,
                dir.id
            );
        }

        const switchUsage = new Map();
        function ensureSwitchUsage(switchKey) {
            let usage = switchUsage.get(switchKey);
            if (!usage) {
                usage = {
                    legalIncomingKeys: new Set(),
                    legalOutgoingByIncoming: new Map(),
                };
                switchUsage.set(switchKey, usage);
            }
            return usage;
        }

        for (const seg of Object.values(routedSegments)) {
            if (!seg || !Array.isArray(seg.c) || seg.c.length < 2) continue;
            const dirSeq = [];
            for (let i = 1; i < seg.c.length; i++) {
                const a = seg.c[i - 1];
                const b = seg.c[i];
                const dirId = dirEdgeByPair.get(`${routeCoordKey(a[0], a[1])}>${routeCoordKey(b[0], b[1])}`);
                if (dirId == null) continue;
                if (dirSeq[dirSeq.length - 1] !== dirId) dirSeq.push(dirId);
            }
            for (let i = 1; i < dirSeq.length; i++) {
                const prevDir = graph.dirEdges[dirSeq[i - 1]];
                const nextDir = graph.dirEdges[dirSeq[i]];
                if (!prevDir || !nextDir || prevDir.to !== nextDir.from) continue;
                const switchNode = graph.nodes[prevDir.to];
                if (!switchNode || switchNode.adj.length < 3) continue;
                const switchKey = switchNode.key;
                const incomingKey = graph.nodes[prevDir.from].key;
                const outgoingKey = graph.nodes[nextDir.to].key;
                const usage = ensureSwitchUsage(switchKey);
                usage.legalIncomingKeys.add(incomingKey);
                if (!usage.legalOutgoingByIncoming.has(incomingKey)) {
                    usage.legalOutgoingByIncoming.set(incomingKey, new Set());
                }
                usage.legalOutgoingByIncoming.get(incomingKey).add(outgoingKey);
            }
        }

        for (const [switchKey, usage] of switchUsage) {
            out.switches[switchKey] = {
                legalIncomingKeys: Array.from(usage.legalIncomingKeys).sort(),
                legalOutgoingByIncoming: Object.fromEntries(
                    Array.from(usage.legalOutgoingByIncoming.entries())
                        .map(([incomingKey, outgoingSet]) => [
                            incomingKey,
                            Array.from(outgoingSet).sort(),
                        ])
                ),
            };
        }
        return out;
    }

    function getSwitchCoverage(graph, rules, switchNodeId, directedUsage) {
        const node = graph && graph.nodes && graph.nodes[switchNodeId];
        if (!node) return null;
        const switchKey = node.key;
        const switchUsage = directedUsage && directedUsage.switches ? directedUsage.switches[switchKey] : null;
        const legalIncomingKeys = switchUsage
            ? (Array.isArray(switchUsage.legalIncomingKeys) ? switchUsage.legalIncomingKeys.slice() : [])
            : getSwitchArms(graph, switchNodeId).map(arm => arm.firstNeighborKey);
        const legalOutgoingByIncoming = switchUsage && switchUsage.legalOutgoingByIncoming && typeof switchUsage.legalOutgoingByIncoming === 'object'
            ? switchUsage.legalOutgoingByIncoming
            : {};
        const relevantIncomingKeys = switchUsage
            ? legalIncomingKeys.filter((incomingKey) => Array.isArray(legalOutgoingByIncoming[incomingKey]) && legalOutgoingByIncoming[incomingKey].length > 1)
            : legalIncomingKeys;
        const incomingMap = rules && rules.switches && rules.switches[switchKey] && typeof rules.switches[switchKey] === 'object'
            ? rules.switches[switchKey]
            : null;
        const coveredIncomingKeys = [];
        const missingIncomingKeys = [];
        const partialIncomingKeys = [];
        let hasAnyRules = false;
        for (const incomingKey of relevantIncomingKeys) {
            const requiredOutgoingKeys = Array.isArray(legalOutgoingByIncoming[incomingKey])
                ? legalOutgoingByIncoming[incomingKey]
                : [];
            const allowedOutgoingKeys = incomingMap && Object.prototype.hasOwnProperty.call(incomingMap, incomingKey)
                ? incomingMap[incomingKey]
                : null;
            if (Array.isArray(allowedOutgoingKeys)) hasAnyRules = true;
            const coversRequiredOutgoing = Array.isArray(allowedOutgoingKeys)
                && requiredOutgoingKeys.every((outgoingKey) => allowedOutgoingKeys.includes(outgoingKey));
            if (coversRequiredOutgoing) {
                coveredIncomingKeys.push(incomingKey);
            } else {
                missingIncomingKeys.push(incomingKey);
                if (Array.isArray(allowedOutgoingKeys)) partialIncomingKeys.push(incomingKey);
            }
        }
        const totalIncomingCount = relevantIncomingKeys.length;
        const coveredIncomingCount = coveredIncomingKeys.length;
        return {
            switchNodeId,
            switchKey,
            totalIncomingCount,
            coveredIncomingCount,
            coveredIncomingKeys,
            missingIncomingKeys,
            partialIncomingKeys,
            legalIncomingKeys,
            relevantIncomingKeys,
            legalOutgoingByIncoming,
            isServiceSwitch: totalIncomingCount > 0,
            hasAnyRules,
            isFullyCovered: totalIncomingCount > 0 && coveredIncomingCount === totalIncomingCount,
            isPartiallyCovered: totalIncomingCount > 0 && ! (totalIncomingCount > 0 && coveredIncomingCount === totalIncomingCount) && hasAnyRules,
        };
    }

    function getUncoveredSwitchInfos(graph, rules, directedUsage) {
        const out = [];
        const switchNodeIds = directedUsage && directedUsage.switches
            ? Object.keys(directedUsage.switches)
                .map((switchKey) => graph.nodeIndex && graph.nodeIndex.get ? graph.nodeIndex.get(switchKey) : null)
                .filter((nodeId) => nodeId != null)
            : getSwitchNodeIds(graph);
        for (const switchNodeId of switchNodeIds) {
            const coverage = getSwitchCoverage(graph, rules, switchNodeId, directedUsage);
            if (!coverage || !coverage.isServiceSwitch || coverage.isFullyCovered) continue;
            out.push(coverage);
        }
        return out;
    }

    function transitionAllowed(rules, switchKey, incomingKey, outgoingKey) {
        const allowed = getAllowedOutgoingKeys(rules, switchKey, incomingKey);
        if (!allowed) return true;
        return allowed.includes(outgoingKey);
    }

    return {
        angularDeltaDeg,
        bearingDeg,
        buildExactGraph,
        buildDirectedSwitchUsage,
        emptyRules,
        getAllowedOutgoingKeys,
        getSwitchCoverage,
        getSwitchArms,
        getUncoveredSwitchInfos,
        getSwitchNodeIds,
        haversineMeters,
        isDecisionNode,
        isSwitchNode,
        lineStringsFromGeometry,
        nodeKeyForCoords,
        normalizeSwitchRules,
        projectOnSegment: function (lat, lng, aLat, aLng, bLat, bLng) {
            const cosLat = Math.cos((aLat * Math.PI) / 180);
            const ax = aLng * cosLat;
            const ay = aLat;
            const bx = bLng * cosLat;
            const by = bLat;
            const px = lng * cosLat;
            const py = lat;
            const dx = bx - ax;
            const dy = by - ay;
            const len2 = dx * dx + dy * dy;
            let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
            if (t < 0) t = 0;
            else if (t > 1) t = 1;
            const projLat = aLat + t * (bLat - aLat);
            const projLng = aLng + t * (bLng - aLng);
            const distM = haversineMeters(lat, lng, projLat, projLng);
            return { t, lat: projLat, lng: projLng, distM };
        },
        traceArm,
        transitionAllowed,
    };
});
