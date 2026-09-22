// Pure geometry and cab-transition helpers for links between independently
// saved rail projects. Browser wiring lives in transit.js; tests run in Node.
(function initRailProjectConnections(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__railProjectConnections = api;
})(typeof window !== 'undefined' ? window : globalThis, function railProjectConnectionsFactory() {
    function nearestPointOnSegment(px, py, ax, ay, bx, by) {
        const dx = bx - ax;
        const dy = by - ay;
        const denom = dx * dx + dy * dy;
        const t = denom > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / denom)) : 0;
        const x = ax + dx * t;
        const y = ay + dy * t;
        return { t, x, y, distSq: (px - x) ** 2 + (py - y) ** 2 };
    }

    function nearestReferenceSnap(features, pointer, project, {
        gauge = null,
        maxDistancePx = 30,
    } = {}) {
        let best = null;
        for (const feature of features || []) {
            if (gauge && String(feature?.properties?.gauge || '') !== gauge) continue;
            const coordinates = feature?.geometry?.coordinates || [];
            const chainages = feature?.properties?.chainagesM || [];
            for (let index = 0; index < coordinates.length - 1; index += 1) {
                const a = project(coordinates[index]);
                const b = project(coordinates[index + 1]);
                const candidate = nearestPointOnSegment(pointer.x, pointer.y, a.x, a.y, b.x, b.y);
                if (best && candidate.distSq >= best.distSq) continue;
                const c0 = coordinates[index];
                const c1 = coordinates[index + 1];
                const startChainage = Number(chainages[index]);
                const endChainage = Number(chainages[index + 1]);
                best = {
                    distSq: candidate.distSq,
                    t: candidate.t,
                    segmentIndex: index,
                    lat: Number(c0[1]) + (Number(c1[1]) - Number(c0[1])) * candidate.t,
                    lng: Number(c0[0]) + (Number(c1[0]) - Number(c0[0])) * candidate.t,
                    elevationM: Number(c0[2]) + (Number(c1[2]) - Number(c0[2])) * candidate.t,
                    trackChainageM: startChainage + (endChainage - startChainage) * candidate.t,
                    projectId: Number(feature.properties.projectId),
                    projectName: feature.properties.projectName || null,
                    lineIndex: Number(feature.properties.lineIndex),
                    trackIndex: Number(feature.properties.trackIndex),
                    ref: feature.properties.ref || null,
                    name: feature.properties.name || null,
                    feature,
                };
            }
        }
        return best && best.distSq <= maxDistancePx ** 2 ? best : null;
    }

    function localVector(from, to) {
        const lat = (Number(from[0]) + Number(to[0])) * 0.5 * Math.PI / 180;
        return {
            x: (Number(to[1]) - Number(from[1])) * Math.cos(lat),
            y: Number(to[0]) - Number(from[0]),
        };
    }

    function normalized(vector) {
        const length = Math.hypot(vector.x, vector.y) || 1;
        return { x: vector.x / length, y: vector.y / length };
    }

    function chooseContinuingDirection(pointBeforeJunction, snap) {
        const coordinates = snap?.feature?.geometry?.coordinates || [];
        const index = Number(snap?.segmentIndex);
        if (!pointBeforeJunction || !coordinates[index] || !coordinates[index + 1]) return 1;
        const junction = [snap.lat, snap.lng];
        const incoming = normalized(localVector(pointBeforeJunction, junction));
        const forward = normalized(localVector(
            junction,
            [coordinates[index + 1][1], coordinates[index + 1][0]],
        ));
        const backward = normalized(localVector(
            junction,
            [coordinates[index][1], coordinates[index][0]],
        ));
        const forwardDot = incoming.x * forward.x + incoming.y * forward.y;
        const backwardDot = incoming.x * backward.x + incoming.y * backward.y;
        return forwardDot >= backwardDot ? 1 : -1;
    }

    function connectionChoices(junctions, {
        projectId,
        lineIndex,
        arrivalDirection,
        terminusOffsetM,
        toleranceM = 2,
    }) {
        const choices = [];
        for (const junction of junctions || []) {
            const ownPorts = (junction.ports || []).filter(port =>
                Number(port.projectId) === Number(projectId)
                && Number(port.lineIndex) === Number(lineIndex)
                && Number(port.outboundDirection) === -Number(arrivalDirection)
                && Math.abs(Number(port.lineOffsetM) - Number(terminusOffsetM)) <= toleranceM);
            if (ownPorts.length === 0) continue;
            for (const port of junction.ports || []) {
                if (Number(port.projectId) === Number(projectId)
                    && Number(port.lineIndex) === Number(lineIndex)) continue;
                choices.push({ junction, port });
            }
        }
        return choices;
    }

    function buildCabHandoffUrl(currentUrl, targetPort) {
        const url = new URL(currentUrl);
        url.searchParams.set('project', String(targetPort.projectId));
        url.searchParams.set('st3d', 'planner-cab');
        url.searchParams.set('line', String(Number(targetPort.lineIndex) + 1));
        url.searchParams.set('offset', Math.max(0, Number(targetPort.lineOffsetM) || 0).toFixed(1));
        url.searchParams.set('dir', Number(targetPort.outboundDirection) < 0 ? '-1' : '1');
        url.searchParams.delete('loc');
        return url.toString();
    }

    function upsertPendingIntent(intents, nextIntent) {
        return [
            ...(intents || []).filter(intent => !(
                intent.sourceTrackId === nextIntent.sourceTrackId
                && intent.sourceEndpoint === nextIntent.sourceEndpoint
            )),
            nextIntent,
        ];
    }

    return {
        buildCabHandoffUrl,
        chooseContinuingDirection,
        connectionChoices,
        nearestReferenceSnap,
        nearestPointOnSegment,
        upsertPendingIntent,
    };
});
