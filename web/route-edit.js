// Network edit mode for the transit planner: draggable route vertices with
// curve/grade/junction validation, pending node insertion, per-vertex level
// (underground/surface/elevated) editing, and station dragging along tracks.
// Loaded before transit.js as a classic script; shares its global scope
// (map, project, setMode, geometry helpers) at call time.

// ─── Standing Geometry Warnings ─────────────────────────────────────────────
// Every geometry rule except the junction one is now a warning: an edit that
// breaks it is accepted, and the stretch it broke keeps a red dashed outline
// until it is repaired. Refusing these mid-edit made the editor unusable, since
// a route often has to pass through a bad shape on the way to a good one — but
// a fault you cannot see is worse than one that blocks you, so the outline is
// derived from the live geometry rather than remembered from the edit.
let trackProblemOutlineLayer = null;
let trackProblemOutlineFrame = null;
let trackGeometryProblemCount = 0;

// ─── Network-edit undo ─────────────────────────────────────────────────────
// The elevation strip has its own per-track history. This stack is only for
// top-down network editing: route-node changes and station moves. Each entry
// restores the complete affected-track state so one gesture remains one undo,
// including stations reprojected by a node edit and links broken by a move.
const routeEditUndoHistory = window.__routeEditHistory.createHistory(50);

function clearRouteEditUndoHistory() {
    routeEditUndoHistory.clear();
}

function copyRouteEditRecords(records) {
    return Array.isArray(records) ? records.map(record => ({ ...record })) : [];
}

function captureRouteEditTrackSnapshot(track) {
    const stationStates = (project.stations || [])
        .filter(station => station.trackId === track.id)
        .map(station => ({
            station,
            latlng: [station.latlng[0], station.latlng[1]],
            name: station.name,
            autoNamed: station.autoNamed,
            hasAutoNamed: Object.prototype.hasOwnProperty.call(station, 'autoNamed'),
        }));
    const stationIds = new Set(stationStates.map(state => state.station.id));
    return {
        track,
        latlngs: track.latlngs.map(point => [point[0], point[1]]),
        levels: [...track.levels],
        electrificationSegments: copyRouteEditRecords(track.electrificationSegments),
        verticalProfile: track.verticalProfile || null,
        verticalProfileGeomHash: track.verticalProfile?.geomHash,
        elevationEdits: Array.isArray(track._elevationEdits)
            ? copyRouteEditRecords(track._elevationEdits)
            : null,
        profileGeoAnchors: Array.isArray(track._profileGeoAnchors)
            ? copyRouteEditRecords(track._profileGeoAnchors)
            : null,
        terrainProfile: track._terrainProfile,
        stationStates,
        stationIds,
        transferLinks: (project.transferLinks || [])
            .filter(link => stationIds.has(link.stationIdA) || stationIds.has(link.stationIdB))
            .map(link => ({
                id: link.id,
                stationIdA: link.stationIdA,
                stationIdB: link.stationIdB,
                linkType: link.linkType,
                cost: link.cost,
            })),
        pendingRailConnectionIntents: [...pendingRailConnectionIntents],
    };
}

function restoreRouteEditTransferLinks(snapshot) {
    const savedIds = new Set(snapshot.transferLinks.map(link => link.id));
    const currentAffected = project.transferLinks.filter(link => (
        snapshot.stationIds.has(link.stationIdA) || snapshot.stationIds.has(link.stationIdB)
    ));
    for (const link of currentAffected) {
        if (!savedIds.has(link.id)) removeTransferLink(link.id);
    }
    for (const saved of snapshot.transferLinks) {
        let link = project.transferLinks.find(candidate => candidate.id === saved.id);
        if (!link) {
            const stationA = _stationById.get(saved.stationIdA);
            const stationB = _stationById.get(saved.stationIdB);
            if (!stationA || !stationB) continue;
            link = createTransferLink(stationA, stationB);
            link.id = saved.id;
            nextTransferLinkId = Math.max(nextTransferLinkId, saved.id + 1);
        }
        link.stationIdA = saved.stationIdA;
        link.stationIdB = saved.stationIdB;
        link.linkType = saved.linkType;
        link.cost = saved.cost;
        const stationA = _stationById.get(link.stationIdA);
        const stationB = _stationById.get(link.stationIdB);
        if (stationA && stationB && link.layer) {
            link.layer.setLatLngs([stationA.latlng, stationB.latlng]);
        }
    }
}

function restoreRouteEditTrackSnapshot(snapshot) {
    const { track } = snapshot;
    if (!project.tracks.includes(track)) {
        throw new Error('Trasa za poništavanje više nije u projektu.');
    }
    cancelTrackVerticalProfileWork(track);
    track.latlngs.splice(0, track.latlngs.length, ...snapshot.latlngs.map(point => [...point]));
    track.levels.splice(0, track.levels.length, ...snapshot.levels);
    track.electrificationSegments = copyRouteEditRecords(snapshot.electrificationSegments);
    setTrackVerticalProfile(track, snapshot.verticalProfile);
    if (track.verticalProfile && snapshot.verticalProfileGeomHash !== undefined) {
        track.verticalProfile.geomHash = snapshot.verticalProfileGeomHash;
    }
    if (snapshot.elevationEdits) track._elevationEdits = copyRouteEditRecords(snapshot.elevationEdits);
    else delete track._elevationEdits;
    if (snapshot.profileGeoAnchors) track._profileGeoAnchors = copyRouteEditRecords(snapshot.profileGeoAnchors);
    else delete track._profileGeoAnchors;
    if (snapshot.terrainProfile === undefined) delete track._terrainProfile;
    else track._terrainProfile = snapshot.terrainProfile;
    delete track._profileStationInputs;

    for (const state of snapshot.stationStates) {
        const { station } = state;
        clearTimeout(station._autoNameTimer);
        station._autoNameRequestId = (station._autoNameRequestId || 0) + 1;
        setStationMapPosition(station, state.latlng);
        clearTimeout(station._autoNameTimer);
        station.name = state.name;
        if (state.hasAutoNamed) station.autoNamed = state.autoNamed;
        else delete station.autoNamed;
        refreshStationMarkerPresentation(station);
    }
    restoreRouteEditTransferLinks(snapshot);
    pendingRailConnectionIntents.splice(
        0,
        pendingRailConnectionIntents.length,
        ...snapshot.pendingRailConnectionIntents,
    );
    clearFreshVertex({ rerender: false });
    afterTrackGeometryChange(track, { refetchCatchments: true });
}

function pushRouteEditUndoSnapshot(snapshot, label, undoMessage) {
    return routeEditUndoHistory.push({
        label,
        undoMessage,
        undo: () => restoreRouteEditTrackSnapshot(snapshot),
    });
}

function undoLastRouteEdit(expectedEntry = null) {
    if (expectedEntry && routeEditUndoHistory.peek() !== expectedEntry) return false;
    let entry;
    try {
        entry = routeEditUndoHistory.undo();
    } catch (error) {
        console.error('Network edit undo failed:', error);
        setStatusMessage(error.message || 'Poništavanje izmjene nije uspjelo.', true);
        return false;
    }
    if (!entry) return false;
    setStatusMessage(entry.undoMessage || `Poništeno: ${entry.label}.`);
    return true;
}

function routeEditPointListsEqual(left, right) {
    return left.length === right.length && left.every((point, index) => (
        point[0] === right[index][0] && point[1] === right[index][1]
    ));
}

function routeEditTrackSnapshotChanged(snapshot) {
    const track = snapshot.track;
    if (!routeEditPointListsEqual(snapshot.latlngs, track.latlngs)) return true;
    if (snapshot.levels.length !== track.levels.length
        || snapshot.levels.some((level, index) => level !== track.levels[index])) return true;
    return snapshot.stationStates.some(state => (
        state.latlng[0] !== state.station.latlng[0] || state.latlng[1] !== state.station.latlng[1]
    ));
}

// Bubble phase is deliberate: the elevation strip's capture-phase Cmd/Ctrl-Z
// gets first refusal while it is open. Native text-field undo also wins.
document.addEventListener('keydown', event => {
    const historyApi = window.__routeEditHistory;
    if (!historyApi.isUndoShortcut(event) || historyApi.isEditableTarget(event.target)) return;
    if (currentMode === 'drawLine') {
        if (currentLinePoints.length === 0) return;
        event.preventDefault();
        undoLastVertex();
        return;
    }
    if (currentMode !== 'edit' || draggingVertex || routeEditUndoHistory.size === 0) return;
    event.preventDefault();
    undoLastRouteEdit();
});

// Every standing fault on one track, as segment ranges with a reason. Whole
// track passes, so this is only ever run after an edit is committed.
function getTrackGeometryProblems(track) {
    if (!track || !Array.isArray(track.latlngs) || track.latlngs.length < 2) return [];
    const problems = [];
    const gaugeConfig = GAUGES[normalizeGauge(track.gauge)];
    for (const violation of buildTrackCurvePlan(track.latlngs, track.gauge).violations) {
        problems.push({
            kind: 'curve',
            segmentIndices: [violation.segmentIndex],
            message: `Zavoj je preoštar: dionici fali ${Math.ceil(violation.shortfallM)} m `
                + `od potrebnih ${Math.ceil(violation.requiredM)} m.`,
        });
    }
    for (const detail of getSteepSegmentDetails(track)) {
        problems.push({
            kind: 'grade',
            segmentIndices: [detail.segmentIndex],
            message: `Nagib prelazi ${gaugeConfig.maxInclinePct}%: `
                + formatSteepSegmentDetail(detail),
        });
    }
    for (const detail of getShortFullLevelRunDetails(track)) {
        problems.push({
            kind: 'level-run',
            segmentIndices: detail.segmentIndices,
            message: `Ravna razina ${detail.level > 0 ? '+1' : '−1'} ima ${detail.actualM.toFixed(1)} m, `
                + `a treba najmanje ${TRACK_MIN_FULL_LEVEL_LENGTH_M} m.`,
        });
    }
    for (const { station, alignment } of getUndergroundStationAlignments(track)) {
        if (alignment.ok) continue;
        problems.push({
            kind: 'station-alignment',
            envelopeLatLngs: alignment.envelopeLatLngs,
            segmentIndices: [],
            message: `Podzemna stanica ${getStationDisplayName(station)} traži ravnu trasu: `
                + `trasa ${describeUndergroundStationDrift(alignment)}.`,
        });
    }
    return problems;
}

function getProjectGeometryProblems() {
    return (project.tracks || []).flatMap(track => (
        getTrackGeometryProblems(track).map(problem => ({ ...problem, track }))
    ));
}

// Coalesced to one frame: a committed edit can touch several tracks, and the
// scan is a whole-track pass per track.
function scheduleTrackProblemOutlines() {
    if (trackProblemOutlineFrame != null) return;
    trackProblemOutlineFrame = requestAnimationFrame(() => {
        trackProblemOutlineFrame = null;
        refreshTrackProblemOutlines();
    });
}

function refreshTrackProblemOutlines() {
    if (trackProblemOutlineLayer) {
        map.removeLayer(trackProblemOutlineLayer);
        trackProblemOutlineLayer = null;
    }
    const problems = getProjectGeometryProblems();
    trackGeometryProblemCount = problems.length;
    // Drawn while editing only. Imported and reconstructed routes carry plenty
    // of pre-existing faults — project 107 alone has 69 — and painting those
    // over the ordinary view would bury the ones the current edit just made.
    if (currentMode !== 'edit' || problems.length === 0) return;

    const layers = [];
    for (const problem of problems) {
        const paths = problem.kind === 'station-alignment'
            ? [problem.envelopeLatLngs]
            : problem.segmentIndices
                .filter(index => index >= 0 && index < problem.track.latlngs.length - 1)
                .map(index => [problem.track.latlngs[index], problem.track.latlngs[index + 1]]);
        const usable = paths.filter(path => Array.isArray(path) && path.length >= 2);
        if (usable.length === 0) continue;
        layers.push(L.polyline(usable, {
            pane: TRACK_LEVEL_PANE,
            color: '#dc2626',
            weight: 11,
            opacity: 0.7,
            dashArray: '9, 7',
            lineCap: 'round',
            interactive: true,
        }).bindTooltip(problem.message, { sticky: true, className: 'track-problem-tooltip' }));
    }
    if (layers.length === 0) return;
    trackProblemOutlineLayer = L.featureGroup(layers).addTo(map);
}

// ─── Vertex Editing ─────────────────────────────────────────────────────────
let activeVertexHandles = [];
let vertexDragStationProjections = null;
let vertexDragOriginalState = null;
let previewVertexMarker = null;
let vertexDragMergeTarget = null;
let vertexMergePreviewMarker = null;
let vertexDragLegalityLayer = null;
let vertexDragLegalityState = null;
let vertexDragLegalityVerdictKey = null;
let vertexDragLegalityHandle = null;
let vertexDragCurveWarningMarkers = [];
let vertexDragCurveWarningKey = null;
let vertexDragReferenceSnap = null;
let vertexDragReferenceSnapMarker = null;

// Adding a bend needs close-enough map precision that the new handle and its
// immediate geometry are unambiguous. Existing handles stay visible at every
// zoom while route editing is active; only insertion is gated by this limit.
const TRACK_NODE_INSERT_MIN_ZOOM = 16;

// Fractional levels are samples of one continuous ramp, not independently
// fixed altitudes. Recompute them from the full-level ramp endpoints whenever
// horizontal geometry changes so a bend can be dragged without introducing a
// local grade spike that immediately snaps the edit back.
function reflowTrackRampShapeSpan(track, startIndex, endIndex) {
    const fromLevel = Math.round(track.levels[startIndex]);
    const toLevel = Math.round(track.levels[endIndex]);
    if (fromLevel === toLevel || endIndex <= startIndex + 1) return;
    const distances = [0];
    for (let index = startIndex; index < endIndex; index++) {
        const from = track.latlngs[index];
        const to = track.latlngs[index + 1];
        distances.push(distances[distances.length - 1]
            + distanceMetersLatLng(from[0], from[1], to[0], to[1]));
    }
    const totalM = distances[distances.length - 1];
    if (totalM <= 1e-6) return;
    for (let index = startIndex + 1; index < endIndex; index++) {
        const ratio = distances[index - startIndex] / totalM;
        track.levels[index] = normalizeTrackElevationLevel(
            fromLevel + (toLevel - fromLevel) * ratio,
        );
    }
}

// nearVertexIndex: a drag moves one node, and a node only ever sits inside the
// single ramp span bounded by the full levels on either side of it. Reflowing
// that span alone turns a whole-track walk into a handful of vertices.
function reflowTrackRampShapeLevels(track, { nearVertexIndex = null } = {}) {
    if (!track || !Array.isArray(track.latlngs) || !Array.isArray(track.levels)) return;
    if (Number.isInteger(nearVertexIndex)) {
        const lastIndex = track.levels.length - 1;
        const vertexIndex = Math.max(0, Math.min(lastIndex, nearVertexIndex));
        const previousFull = index => {
            let cursor = index;
            if (cursor < 0) return null;
            while (cursor > 0 && !isFullTrackLevel(track.levels[cursor])) cursor--;
            return isFullTrackLevel(track.levels[cursor]) ? cursor : null;
        };
        const nextFull = index => {
            let cursor = index;
            if (cursor > lastIndex) return null;
            while (cursor < lastIndex && !isFullTrackLevel(track.levels[cursor])) cursor++;
            return isFullTrackLevel(track.levels[cursor]) ? cursor : null;
        };
        // A full-level node bounds the ramp on each side of it; a fractional one
        // sits inside exactly one ramp.
        const spans = isFullTrackLevel(track.levels[vertexIndex])
            ? [[previousFull(vertexIndex - 1), vertexIndex], [vertexIndex, nextFull(vertexIndex + 1)]]
            : [[previousFull(vertexIndex), nextFull(vertexIndex)]];
        for (const [startIndex, endIndex] of spans) {
            if (startIndex == null || endIndex == null || endIndex <= startIndex) continue;
            reflowTrackRampShapeSpan(track, startIndex, endIndex);
        }
        return;
    }
    let startIndex = 0;
    while (startIndex < track.levels.length - 1) {
        while (startIndex < track.levels.length && !isFullTrackLevel(track.levels[startIndex])) {
            startIndex++;
        }
        if (startIndex >= track.levels.length - 1) break;

        let endIndex = startIndex + 1;
        while (endIndex < track.levels.length && !isFullTrackLevel(track.levels[endIndex])) {
            endIndex++;
        }
        if (endIndex >= track.levels.length) break;

        reflowTrackRampShapeSpan(track, startIndex, endIndex);
        startIndex = endIndex;
    }
}

// isNewVertex: a node that has just been inserted never carried a junction, so
// it must not inherit one from an unrelated track endpoint it happens to land
// near — only pre-existing nodes are pinned to their junction partners.
function beginTrackVertexDrag(track, stations, vertexIndex, { isNewVertex = false } = {}) {
    // Every baseline here is only ever compared against the same few segments
    // the drag can reach, so each is measured over that window rather than the
    // whole line — otherwise grabbing a node on a long route costs ~14 ms of
    // whole-track passes before the pointer has moved at all.
    const undoSnapshot = captureRouteEditTrackSnapshot(track);
    const electrificationSegments = undoSnapshot.electrificationSegments;
    const affectedSegments = getVertexDragAffectedSegments(track, vertexIndex);
    vertexDragOriginalState = {
        track,
        vertexIndex,
        undoSnapshot,
        latlngs: undoSnapshot.latlngs,
        levels: undoSnapshot.levels,
        // Only the electrification remap reads this, and only when there is
        // something to remap.
        chainages: electrificationSegments.length > 0 ? buildTrackChainage(track).offsets : null,
        electrificationSegments,
        stationLatLngs: undoSnapshot.stationStates.map(({ station, latlng }) => ({ station, latlng })),
        baselineViolations: getTrackCurveViolations(track.gauge, track.latlngs, affectedSegments).violations,
        baselineSteepSegments: getSteepSegmentDetails(track, affectedSegments),
        baselineShortLevelRuns: getShortFullLevelRunDetails(track, { nearVertexIndex: vertexIndex }),
        baselineStationAlignments: getStationAlignmentBaseline(track),
        vertexRole: getTrackVertexRole(track, vertexIndex),
        junctionPartners: isNewVertex ? [] : getVertexJunctionPartners(track, vertexIndex),
    };
}

// A station box already sitting on a bad alignment (drawn before the rule, or
// mid-repair) must not trap the editor: like every other geometry rule here,
// the drag is judged comparatively and only a WORSENED alignment is rejected.
function getStationAlignmentBaseline(track) {
    return getUndergroundStationAlignments(track).map(({ station, alignment }) => ({
        station,
        driftM: alignment.driftM,
        levelErrorM: alignment.levelErrorM,
    }));
}

const STATION_ALIGNMENT_EPSILON_M = 0.05;

function getWorsenedStationAlignments(track, baseline) {
    const baselineByStation = new Map(
        (baseline || []).map(entry => [entry.station, entry]),
    );
    return getUndergroundStationAlignments(track)
        .map(({ station, alignment }) => {
            const before = baselineByStation.get(station);
            // A station that was legal before must stay legal; one that was
            // already broken must at least not get worse.
            //
            // Straightness only. Bending the route past a station is permanent —
            // the station box would cut through its own wall — but a grade
            // through it is not: the station's span is re-flattened by the next
            // solve, which this check cannot see because the re-solve is
            // debounced and has not run yet. Including the level error here
            // refused geometry edits for a fault that fixed itself moments later.
            const driftBefore = before
                ? Math.max(before.driftM, UNDERGROUND_STATION_STRAIGHT_TOLERANCE_METERS)
                : UNDERGROUND_STATION_STRAIGHT_TOLERANCE_METERS;
            const worsened = alignment.driftM > driftBefore + STATION_ALIGNMENT_EPSILON_M;
            return worsened ? { station, alignment } : null;
        })
        .filter(Boolean);
}

function clearVertexMergePreview() {
    vertexDragMergeTarget = null;
    if (vertexMergePreviewMarker) {
        map.removeLayer(vertexMergePreviewMarker);
        vertexMergePreviewMarker = null;
    }
}

function clearVertexDragLegalityPreview() {
    if (vertexDragLegalityLayer) {
        map.removeLayer(vertexDragLegalityLayer);
        vertexDragLegalityLayer = null;
    }
    vertexDragLegalityState = null;
    vertexDragLegalityVerdictKey = null;
    if (vertexDragLegalityHandle) {
        const element = vertexDragLegalityHandle.getElement();
        if (element) element.classList.remove('vertex-drag-legal', 'vertex-drag-warned', 'vertex-drag-illegal');
        vertexDragLegalityHandle.closeTooltip();
        vertexDragLegalityHandle.unbindTooltip();
        vertexDragLegalityHandle = null;
    }
    clearVertexDragCurveWarnings();
}

function clearVertexDragCurveWarnings() {
    for (const marker of vertexDragCurveWarningMarkers) map.removeLayer(marker);
    vertexDragCurveWarningMarkers = [];
    vertexDragCurveWarningKey = null;
}

// The ∠ badges over the corners that are currently too tight. Tearing them down
// and rebuilding them on every frame of a drag cost more than every geometry
// check put together, so they are rebuilt only when the set of flagged corners
// or a displayed angle actually changes; in between they simply move with the
// geometry they mark.
function updateVertexDragCurveWarnings(track, validation) {
    const flagged = getCurveViolationVertexIndices(validation.worsened)
        .filter(index => index > 0 && index < track.latlngs.length - 1);
    const key = flagged
        .map(index => `${index}@${Math.round(validation.curvePlan?.turns?.[index]?.angleDeg ?? 0)}`)
        .join(',');
    if (key !== vertexDragCurveWarningKey) {
        clearVertexDragCurveWarnings();
        vertexDragCurveWarningKey = key;
        vertexDragCurveWarningMarkers = createTrackCurveWarningMarkers(
            track.gauge,
            track.latlngs,
            validation.worsened,
        );
        for (const marker of vertexDragCurveWarningMarkers) marker.addTo(map).openTooltip();
        return;
    }
    flagged.forEach((index, position) => {
        vertexDragCurveWarningMarkers[position]?.setLatLng(track.latlngs[index]);
    });
}

function clearVertexDragReferenceSnap() {
    vertexDragReferenceSnap = null;
    if (vertexDragReferenceSnapMarker) {
        map.removeLayer(vertexDragReferenceSnapMarker);
        vertexDragReferenceSnapMarker = null;
    }
}

function updateVertexMergePreview(track, vertexIndex, draggedLatLng) {
    clearVertexMergePreview();
    const state = vertexDragOriginalState;
    if (!state || state.track !== track || !state.vertexRole.removable) return;
    const candidates = [];
    for (const adjacentIndex of [vertexIndex - 1, vertexIndex + 1]) {
        if (adjacentIndex < 0 || adjacentIndex >= state.latlngs.length) continue;
        candidates.push({ kind: 'node', latlng: state.latlngs[adjacentIndex], vertexIndex: adjacentIndex });
    }
    const draggedPoint = map.latLngToContainerPoint(draggedLatLng);
    const nearest = candidates
        .map(candidate => ({
            ...candidate,
            pixelDistance: draggedPoint.distanceTo(map.latLngToContainerPoint(candidate.latlng)),
        }))
        .filter(candidate => candidate.pixelDistance <= 22)
        .sort((left, right) => left.pixelDistance - right.pixelDistance)[0];
    if (!nearest) return;
    vertexDragMergeTarget = nearest;
    vertexMergePreviewMarker = L.marker(nearest.latlng, {
        icon: L.divIcon({ className: 'vertex-merge-target', iconSize: [30, 30], iconAnchor: [15, 15] }),
        interactive: false,
        zIndexOffset: 1250,
    }).addTo(map);
}

function finishVertexMergeDrop(track, vertexIndex) {
    if (!vertexDragMergeTarget || !vertexDragOriginalState) return false;
    const state = vertexDragOriginalState;
    clearVertexMergePreview();
    restoreRejectedTrackVertexDrag(track, state);
    vertexDragOriginalState = null;
    removeTrackVertex(track, vertexIndex);
    return true;
}

function getVertexDragAffectedSegments(track, vertexIndex) {
    const first = Math.max(0, vertexIndex - 2);
    const last = Math.min(track.latlngs.length - 2, vertexIndex + 1);
    return Array.from({ length: Math.max(0, last - first + 1) }, (_, offset) => first + offset);
}

// Light path/profile sync while geometry is provisional (mid-drag, pending
// placement, or a rejected-drag restore); the full derived refresh happens in
// afterTrackGeometryChange once an edit is committed.
//
// On a long route the motion profile is NOT rebuilt while a node is being
// dragged. Rebuilding it turns a 2,959-node route into 14,411 fresh segment
// objects and twice that many LatLngs — roughly 43,000 allocations per frame —
// and the resulting garbage collections were the drag's real cost: the train
// animation callback measured a 0.1 ms median but a 27 ms p90 and a 57 ms worst,
// so every tenth frame stalled on GC while the numbers said everything was fast.
//
// Hand-drawn projects are nowhere near that size, and there the live update is
// what makes trains and the coloured line follow the pointer — so the skip is
// bounded by cost, not applied everywhere. Above the budget, trains and line
// overlays keep running on the geometry as it stood when the drag began and
// catch up the moment the node is dropped; the track polyline under the pointer
// stays live either way.
const LIVE_DRAG_MOTION_PROFILE_MAX_SEGMENTS = 2000;

function shouldRebuildMotionProfileDuringDrag(track) {
    if (!draggingVertex) return true;
    const segments = track.motionProfile?.segments?.length || 0;
    return segments <= LIVE_DRAG_MOTION_PROFILE_MAX_SEGMENTS;
}

function syncTrackGeometryLayers(track) {
    if (track.layer) track.layer.setLatLngs(track.latlngs);
    if (track.hitLayer) track.hitLayer.setLatLngs(track.latlngs);
    if (!shouldRebuildMotionProfileDuringDrag(track)) return;
    rebuildAffectedMotionProfiles(track);
    syncLineLayersForTrack(track);
}

function restoreRejectedTrackVertexDrag(track, state) {
    track.latlngs.splice(0, track.latlngs.length, ...state.latlngs.map(point => [point[0], point[1]]));
    track.levels.splice(0, track.levels.length, ...state.levels);
    for (const { station, latlng } of state.stationLatLngs) {
        setStationMapPosition(station, latlng);
    }
    syncTrackGeometryLayers(track);
}

function getTrackVertexDragValidation(track, state = vertexDragOriginalState) {
    if (!state || state.track !== track) {
        return {
            legal: true,
            blocking: false,
            issueType: null,
            segmentIndices: [],
            worsened: [],
            worsenedSteep: [],
            worsenedShortLevelRuns: [],
            worsenedStationAlignments: [],
            curvePlan: null,
        };
    }
    const affectedSegments = getVertexDragAffectedSegments(track, state.vertexIndex);
    // Junction vertices are pinned: moving one away from its partner endpoints
    // would silently split the network, so that outranks every geometry check.
    const draggedPoint = track.latlngs[state.vertexIndex];
    const junctionBroken = (state.junctionPartners || []).some(partner => (
        distanceMetersLatLng(draggedPoint[0], draggedPoint[1], partner[0], partner[1])
        >= JUNCTION_CONNECTIVITY_THRESHOLD_METERS
    ));
    if (junctionBroken) {
        return {
            legal: false,
            // The only rule that still refuses a drop: every other fault is
            // visible on the map and repairable later, but a junction pulled
            // off its partner splits the network with nothing to show for it.
            blocking: true,
            issueType: 'junction',
            segmentIndices: affectedSegments,
            worsened: [],
            worsenedSteep: [],
            worsenedShortLevelRuns: [],
            worsenedStationAlignments: [],
            curvePlan: null,
        };
    }
    const current = getTrackCurveViolations(track.gauge, track.latlngs, affectedSegments);
    const baselineBySegment = new Map(
        state.baselineViolations.map(violation => [violation.segmentIndex, violation.shortfallM]),
    );
    const worsened = current.violations.filter(violation => (
        violation.shortfallM
        > (baselineBySegment.get(violation.segmentIndex) || 0) + TRACK_CURVE_LENGTH_EPSILON_M
    ));
    const currentSteep = getSteepSegmentDetails(track, affectedSegments);
    const baselineSteepBySegment = new Map(
        state.baselineSteepSegments.map(detail => [detail.segmentIndex, detail.shortfallM]),
    );
    const worsenedSteep = currentSteep.filter(detail => (
        detail.shortfallM > (baselineSteepBySegment.get(detail.segmentIndex) || 0) + 0.2
    ));
    const currentShortLevelRuns = getShortFullLevelRunDetails(track, { nearVertexIndex: state.vertexIndex });
    const baselineShortLevelRuns = new Map(
        state.baselineShortLevelRuns.map(detail => [detail.key, detail.shortfallM]),
    );
    const worsenedShortLevelRuns = currentShortLevelRuns.filter(detail => (
        detail.shortfallM > (baselineShortLevelRuns.get(detail.key) || 0) + 0.1
    ));
    // A station box cannot be bent or tilted: an underground platform hall and
    // its throats are a straight, level 170 m structure.
    const worsenedStationAlignments = getWorsenedStationAlignments(
        track,
        state.baselineStationAlignments,
    );
    const issueType = worsened.length > 0
        ? 'curve'
        : worsenedSteep.length > 0
            ? 'grade'
            : worsenedShortLevelRuns.length > 0
                ? 'level-run'
                : worsenedStationAlignments.length > 0
                    ? 'station-alignment'
                    : null;
    const segmentIndices = issueType === 'curve'
        ? worsened.map(violation => violation.segmentIndex)
        : issueType === 'grade'
            ? worsenedSteep.map(detail => detail.segmentIndex)
            : issueType === 'level-run'
                ? worsenedShortLevelRuns.flatMap(detail => detail.segmentIndices)
                : affectedSegments;
    return {
        legal: issueType == null,
        blocking: false,
        issueType,
        segmentIndices: [...new Set(segmentIndices)],
        worsened,
        worsenedSteep,
        worsenedShortLevelRuns,
        worsenedStationAlignments,
        curvePlan: current.plan,
    };
}

function updateVertexDragLegalityPreview(handle, track) {
    if (vertexDragLegalityHandle && vertexDragLegalityHandle !== handle) {
        clearVertexDragLegalityPreview();
    }
    const validation = getTrackVertexDragValidation(track);
    const paths = validation.segmentIndices
        .filter(index => index >= 0 && index < track.latlngs.length - 1)
        .map(index => [track.latlngs[index], track.latlngs[index + 1]]);
    // Three states, not two: green is clean, amber is "this will be accepted
    // and left marked", red is the one drop that still gets refused.
    const state = validation.legal ? 'legal' : validation.blocking ? 'illegal' : 'warned';
    const color = { legal: '#16a34a', warned: '#d97706', illegal: '#dc2626' }[state];
    if (!vertexDragLegalityLayer) {
        vertexDragLegalityLayer = L.polyline(paths, {
            color,
            weight: 8,
            opacity: 0.82,
            dashArray: validation.legal ? null : '8, 6',
            interactive: false,
        }).addTo(map);
        // Once per drag, not once per frame: bringToFront re-appends the path
        // into an SVG container that also holds the multi-thousand-point route,
        // and doing that every frame cost more than the whole validation.
        vertexDragLegalityLayer.bringToFront();
    } else {
        vertexDragLegalityLayer.setLatLngs(paths);
        if (vertexDragLegalityState !== state) {
            vertexDragLegalityLayer.setStyle({
                color,
                dashArray: validation.legal ? null : '8, 6',
            });
        }
    }

    vertexDragLegalityHandle = handle;
    // The badge and its tooltip only ever change when the verdict does, and
    // rewriting a Leaflet tooltip forces a synchronous layout of a page holding
    // a multi-thousand-point SVG route — which cost more per frame than every
    // geometry check in this file put together. A curve fault is exempt from the
    // early return because its ∠ badges have to follow the corner they mark.
    const verdictKey = `${state}:${validation.issueType || 'none'}`;
    if (vertexDragLegalityVerdictKey === verdictKey && validation.issueType !== 'curve') {
        return validation;
    }
    const verdictChanged = vertexDragLegalityVerdictKey !== verdictKey;
    vertexDragLegalityVerdictKey = verdictKey;
    vertexDragLegalityState = state;

    if (verdictChanged) {
        const element = handle.getElement();
        if (element) {
            element.classList.toggle('vertex-drag-legal', state === 'legal');
            element.classList.toggle('vertex-drag-warned', state === 'warned');
            element.classList.toggle('vertex-drag-illegal', state === 'illegal');
        }
    }
    if (validation.issueType === 'curve') {
        if (verdictChanged) {
            handle.closeTooltip();
            handle.unbindTooltip();
        }
        updateVertexDragCurveWarnings(track, validation);
    } else {
        clearVertexDragCurveWarnings();
        const label = validation.legal
            ? '✓ Dopušten položaj'
            : validation.issueType === 'junction'
                ? '✕ Spoj s drugom trasom mora ostati povezan'
                : validation.issueType === 'station-alignment'
                    ? '⚠ Podzemna stanica traži ravnu trasu'
                    : validation.issueType === 'grade'
                        ? '⚠ Nagib je prevelik'
                        : '⚠ Puna razina je prekratka';
        if (handle.getTooltip()) handle.setTooltipContent(label);
        else {
            handle.bindTooltip(label, {
                permanent: true,
                direction: 'top',
                offset: [0, -10],
                className: `vertex-drag-legality-tooltip is-${state}`,
            }).openTooltip();
        }
        const tooltipElement = handle.getTooltip()?.getElement();
        if (tooltipElement) {
            tooltipElement.classList.toggle('is-legal', state === 'legal');
            tooltipElement.classList.toggle('is-warned', state === 'warned');
            tooltipElement.classList.toggle('is-illegal', state === 'illegal');
        }
    }
    return validation;
}

function acceptTrackVertexCurveEdit(track) {
    const state = vertexDragOriginalState;
    if (!state || state.track !== track) {
        vertexDragOriginalState = null;
        return true;
    }
    const validation = getTrackVertexDragValidation(track, state);
    // The geometry is kept unless the drop is outright refused, so the
    // electrification remap follows the same rule.
    if (!validation.blocking && state.electrificationSegments.length > 0) {
        track.electrificationSegments = window.__trackElectrification
            .remapElectrificationSegments(
                state.electrificationSegments,
                state.chainages,
                buildTrackChainage(track).offsets,
            );
    }
    vertexDragOriginalState = null;
    if (validation.blocking) {
        const droppedLatLngs = track.latlngs.map(point => [point[0], point[1]]);
        flashTrackSegments({ latlngs: droppedLatLngs }, validation.segmentIndices);
        setStatusMessage('Čvor je spoj s drugom trasom — mora ostati na mjestu spoja.', true);
        restoreRejectedTrackVertexDrag(track, state);
        return false;
    }

    if (routeEditTrackSnapshotChanged(state.undoSnapshot)) {
        pushRouteEditUndoSnapshot(
            state.undoSnapshot,
            'pomicanje čvora',
            'Pomicanje čvora je poništeno.',
        );
    }
    if (validation.legal) return true;

    // Everything else is a warning now: the node stays where it was dropped and
    // the offending stretch keeps a red outline until it is fixed. Refusing
    // these mid-edit made the editor unusable — you often have to pass through
    // a bad shape on the way to a good one.
    setStatusMessage(describeSoftGeometryFault(track, validation), true);
    return true;
}

// The warning text for a fault that was accepted rather than refused. Same
// diagnosis as the old rejection messages, phrased as what was left behind.
function describeSoftGeometryFault(track, validation) {
    const { worsened, worsenedSteep, worsenedShortLevelRuns } = validation;
    if (validation.issueType === 'station-alignment') {
        const worst = validation.worsenedStationAlignments[0];
        return `Upozorenje: ${getStationDisplayName(worst.station)} je podzemna stanica — njezina `
            + `peronska dvorana i grla su ravna građevina duga `
            + `${UNDERGROUND_STATION_ENVELOPE_HALF_LENGTH_METERS * 2} m, a trasa unutar stanice sada `
            + `${describeUndergroundStationDrift(worst.alignment)}.`;
    }
    if (worsened.length > 0) {
        const worst = worsened.reduce((left, right) => (right.shortfallM > left.shortfallM ? right : left));
        return `Upozorenje: zavoj je preoštar — dionici fali ${Math.ceil(worst.shortfallM)} m `
            + `od potrebnih ${Math.ceil(worst.requiredM)} m.`;
    }
    if (worsenedSteep.length > 0) {
        const gaugeConfig = GAUGES[normalizeGauge(track.gauge)];
        return `Upozorenje: nagib prelazi ${gaugeConfig.maxInclinePct}% za ${gaugeConfig.label}. `
            + worsenedSteep.map(detail => formatSteepSegmentDetail(detail)).join(' ');
    }
    const detail = worsenedShortLevelRuns[0];
    return `Upozorenje: ravna razina ${detail.level > 0 ? '+1' : '−1'} mora imati najmanje `
        + `${TRACK_MIN_FULL_LEVEL_LENGTH_M} m, a označena dionica ima ${detail.actualM.toFixed(1)} m `
        + `(fali ${detail.shortfallM.toFixed(1)} m).`;
}

function showPreviewVertex(latlng) {
    if (!previewVertexMarker) {
        previewVertexMarker = L.marker(latlng, {
            icon: L.divIcon({
                className: 'vertex-handle vertex-handle-preview',
                iconSize: [12, 12],
                iconAnchor: [6, 6],
            }),
            interactive: false,
            zIndexOffset: 999,
        }).addTo(map);
    } else {
        previewVertexMarker.setLatLng(latlng);
    }
}

function removePreviewVertex() {
    if (previewVertexMarker) {
        map.removeLayer(previewVertexMarker);
        previewVertexMarker = null;
    }
}

// Inserts a vertex into a track after segmentIndex, keeping the levels array in
// sync (the new vertex takes the interpolated level of the split segment).
function spliceTrackVertex(track, segmentIndex, latlng) {
    const fromLevel = track.levels?.[segmentIndex] ?? 0;
    const toLevel = track.levels?.[segmentIndex + 1] ?? fromLevel;
    const segStart = track.latlngs[segmentIndex];
    const segEnd = track.latlngs[segmentIndex + 1];
    const segLenM = distanceMetersLatLng(segStart[0], segStart[1], segEnd[0], segEnd[1]);
    const t = segLenM > 0
        ? distanceMetersLatLng(segStart[0], segStart[1], latlng[0], latlng[1]) / segLenM
        : 0;
    const level = normalizeTrackElevationLevel(getContinuousTrackLevel(track, segmentIndex, t));
    track.latlngs.splice(segmentIndex + 1, 0, latlng);
    track.levels.splice(segmentIndex + 1, 0, level);
    return true;
}

function canStartVertexPlacement({ notify = false } = {}) {
    const allowed = map.getZoom() >= TRACK_NODE_INSERT_MIN_ZOOM;
    if (!allowed && notify) {
        setStatusMessage(
            `Približite kartu na razinu ${TRACK_NODE_INSERT_MIN_ZOOM} ili bliže prije dodavanja čvora. `
            + 'Svi postojeći čvorovi ostaju vidljivi.',
            true,
        );
    }
    return allowed;
}

// A new node lands where it was clicked and stays there — no cursor-following
// provisional node to place with a second click, which read as "sticky" on
// desktop and was unusable on touch. It is drawn oversized for a moment so it
// is easy to grab and drag straight away.
const FRESH_VERTEX_HIGHLIGHT_MS = 2600;
// Guards against a double-click (or a jittery tap) dropping a cluster of nodes
// on top of each other: a new node has to clear the existing ones on screen.
const VERTEX_INSERT_MIN_SEPARATION_PX = 16;

let freshVertex = null;
let freshVertexTimer = null;

function isFreshVertex(track, vertexIndex) {
    return !!freshVertex
        && freshVertex.trackId === track?.id
        && freshVertex.vertexIndex === vertexIndex;
}

function clearFreshVertex({ rerender = true } = {}) {
    if (freshVertexTimer) {
        clearTimeout(freshVertexTimer);
        freshVertexTimer = null;
    }
    if (!freshVertex) return;
    freshVertex = null;
    if (rerender) refreshRouteEditHandles();
}

function markFreshVertex(track, vertexIndex) {
    clearFreshVertex({ rerender: false });
    freshVertex = { trackId: track.id, vertexIndex };
    freshVertexTimer = setTimeout(() => {
        freshVertexTimer = null;
        freshVertex = null;
        refreshRouteEditHandles();
    }, FRESH_VERTEX_HIGHLIGHT_MS);
}

// True when the point sits on top of a node the track already has.
function isTooCloseToExistingVertex(track, latlng) {
    const point = map.latLngToContainerPoint(latlng);
    return track.latlngs.some(vertex => (
        point.distanceTo(map.latLngToContainerPoint(L.latLng(vertex[0], vertex[1])))
        < VERTEX_INSERT_MIN_SEPARATION_PX
    ));
}

// Only the junction rule still refuses an insertion.
function getInsertedVertexInvalidMessage() {
    return 'Čvor nije dodan: spoj s drugom trasom mora ostati povezan.';
}

// Moving one vertex changes only its incoming and outgoing segments. Stations
// remain independent objects: preserve their map position and project them to
// the closest legal point on either changed segment instead of inheriting the
// vertex's segment fraction (which glued a station at t=0/1 to that node).
function captureAdjacentStationProjections(track, stations, vertexIndex) {
    const adjacentSegments = new Set([vertexIndex - 1, vertexIndex]);
    const segmentIndices = [...adjacentSegments]
        .filter(index => index >= 0 && index < track.latlngs.length - 1);
    const chainage = buildTrackChainage(track);
    return stations
        .map(station => ({ station, anchor: getStationSegmentAnchor(station, track.latlngs) }))
        .filter(({ anchor }) => adjacentSegments.has(anchor.segmentIndex))
        .map(({ station }) => ({
            station,
            originalLatLng: [station.latlng[0], station.latlng[1]],
            originalOffsetM: getStationTrackOffsetM(track, station, chainage),
            segmentIndices,
        }))
        .sort((left, right) => left.originalOffsetM - right.originalOffsetM);
}

function reprojectStationsAfterVertexMove(track, projections) {
    if (!projections?.length) return;
    const chainage = buildTrackChainage(track);
    for (const projection of projections) {
        const bounds = { ...getStationOrderOffsetBounds(track, projection.station, chainage), chainage };
        const options = { ...bounds, segmentIndices: projection.segmentIndices };
        const snap = nearestFullLevelPointOnTrack(
            track,
            projection.originalLatLng[0],
            projection.originalLatLng[1],
            options,
        ) || nearestFullLevelPointOnTrack(
            track,
            projection.originalLatLng[0],
            projection.originalLatLng[1],
            bounds,
        );
        if (snap) setStationMapPosition(projection.station, [snap.lat, snap.lon]);
    }
}

function removeVertexHandles() {
    activeVertexHandles.forEach(h => map.removeLayer(h));
    activeVertexHandles = [];
    vertexDragStationProjections = null;
    if (!draggingVertex) vertexDragOriginalState = null;
    clearVertexMergePreview();
    clearVertexDragLegalityPreview();
    closeVertexLevelPopup();
    hiddenVertexHandleCount = 0;
    updateHiddenVertexHandleHint();
}


// ─── Track Vertex Levels ─────────────────────────────────────────────────────
// Each vertex has a level (-1/0/+1). New edits materialize one platform
// endpoint and reuse existing surface vertices as outer ramp boundaries;
// unequal explicit endpoints make the complete intervening span a ramp.

function getSteepSegmentDetails(track, segmentIndices = null) {
    const indices = Array.isArray(segmentIndices)
        ? segmentIndices
        : Array.from({ length: Math.max(0, track.latlngs.length - 1) }, (_, i) => i);
    const details = [];
    for (const segmentIndex of indices) {
        if (segmentIndex < 0 || segmentIndex >= track.latlngs.length - 1) continue;
        const profile = getTrackSegmentLevelProfile(track, segmentIndex);
        const levelDelta = Math.abs(profile.toLevel - profile.fromLevel);
        if (levelDelta === 0) continue;
        const requiredM = getMinLevelChangeMeters(track.gauge) * levelDelta;
        // Fractional ramp levels are persisted to six decimals. Allow the same
        // 20 cm geometric tolerance used by interactive curve/ramp validation
        // so harmless coordinate and level rounding does not flag a legal ramp.
        if (profile.lengthM + 0.2 >= requiredM) continue;
        details.push({
            segmentIndex,
            actualM: profile.lengthM,
            requiredM,
            shortfallM: requiredM - profile.lengthM,
        });
    }
    return details;
}

// Contiguous ±1 vertices form the flat platform between their boundary ramps.
// Old/saved projects may already contain shorter runs, so drag validation uses
// these details comparatively and rejects only a newly-created or worsened
// shortfall.
function measureFullLevelRun(track, first) {
    const levels = track?.levels || [];
    const points = track?.latlngs || [];
    const rawLevel = levels[first] ?? 0;
    if (!isFullTrackLevel(rawLevel) || Math.round(rawLevel) === 0) return null;
    const level = Math.round(rawLevel);
    let last = first;
    while (last + 1 < levels.length
        && isFullTrackLevel(levels[last + 1])
        && Math.round(levels[last + 1]) === level) last++;
    let actualM = 0;
    const segmentIndices = [];
    for (let segmentIndex = first; segmentIndex < last; segmentIndex++) {
        actualM += distanceMetersLatLng(...points[segmentIndex], ...points[segmentIndex + 1]);
        segmentIndices.push(segmentIndex);
    }
    if (actualM + 1e-6 >= TRACK_MIN_FULL_LEVEL_LENGTH_M) return { last, detail: null };
    if (segmentIndices.length === 0) {
        if (first > 0) segmentIndices.push(first - 1);
        if (first < points.length - 1) segmentIndices.push(first);
    }
    return {
        last,
        detail: {
            key: `${level}:${first}:${last}`,
            level,
            firstVertexIndex: first,
            lastVertexIndex: last,
            segmentIndices,
            actualM,
            requiredM: TRACK_MIN_FULL_LEVEL_LENGTH_M,
            shortfallM: TRACK_MIN_FULL_LEVEL_LENGTH_M - actualM,
        },
    };
}

// nearVertexIndex: moving one node changes the length of the two segments
// beside it, so only a run covering vertices k-1..k+1 can change. The rest of
// the line is unchanged by construction and does not need re-measuring.
function getShortFullLevelRunDetails(track, { nearVertexIndex = null } = {}) {
    const levels = track?.levels || [];
    const details = [];
    if (Number.isInteger(nearVertexIndex)) {
        const seen = new Set();
        for (const vertexIndex of [nearVertexIndex - 1, nearVertexIndex, nearVertexIndex + 1]) {
            if (vertexIndex < 0 || vertexIndex >= levels.length) continue;
            let first = vertexIndex;
            const level = Math.round(levels[first] ?? 0);
            while (first > 0
                && isFullTrackLevel(levels[first - 1])
                && Math.round(levels[first - 1]) === level) first--;
            if (seen.has(first)) continue;
            seen.add(first);
            const run = measureFullLevelRun(track, first);
            if (run?.detail) details.push(run.detail);
        }
        return details;
    }
    let first = 0;
    while (first < levels.length) {
        const run = measureFullLevelRun(track, first);
        if (!run) { first++; continue; }
        if (run.detail) details.push(run.detail);
        first = run.last + 1;
    }
    return details;
}

function formatSteepSegmentDetail(detail, vertexIndex = null) {
    let label = 'Označeni odsjek';
    if (vertexIndex != null) {
        label = detail.segmentIndex < vertexIndex ? 'Prethodni odsjek' : 'Sljedeći odsjek';
    }
    return `${label} ima ${Math.round(detail.actualM)} m; treba ${Math.ceil(detail.requiredM)} m `
        + `(fali ${Math.ceil(detail.shortfallM)} m).`;
}

// Collects the connected other-track endpoints that make this vertex a
// junction. Every partner must stay within the connectivity threshold or the
// network silently splits, so vertex drags validate against this list.
function getVertexJunctionPartners(track, vertexIndex) {
    const partners = [];
    if (!track?.latlngs?.[vertexIndex]) return partners;
    const point = track.latlngs[vertexIndex];
    const level = normalizeTrackElevationLevel(track.levels?.[vertexIndex]);
    for (const other of project.tracks) {
        if (other.id === track.id || normalizeGauge(other.gauge) !== normalizeGauge(track.gauge)) continue;
        for (const otherIndex of [0, other.latlngs.length - 1]) {
            const otherPoint = other.latlngs[otherIndex];
            if (!otherPoint) continue;
            const otherLevel = normalizeTrackElevationLevel(other.levels?.[otherIndex]);
            if (Math.abs(otherLevel - level) > TRACK_LEVEL_FULL_EPSILON) continue;
            if (distanceMetersLatLng(point[0], point[1], otherPoint[0], otherPoint[1])
                <= JUNCTION_CONNECTIVITY_THRESHOLD_METERS) {
                partners.push([otherPoint[0], otherPoint[1]]);
            }
        }
    }
    return partners;
}

function isTrackVertexJunction(track, vertexIndex) {
    return getVertexJunctionPartners(track, vertexIndex).length > 0;
}

function findNearestSurfaceRampEndpoint(track, chainage, boundaryM, direction, rampLengthM, limit) {
    const thresholdM = boundaryM + direction * rampLengthM;
    let best = null;
    for (let index = 0; index < track.latlngs.length; index++) {
        const offsetM = chainage.offsets[index];
        if (direction < 0 && (
            offsetM < limit.offsetM - 0.05
            || offsetM > thresholdM + 0.05
        )) continue;
        if (direction > 0 && (
            offsetM > limit.offsetM + 0.05
            || offsetM < thresholdM - 0.05
        )) continue;
        const level = normalizeTrackElevationLevel(track.levels[index]);
        if (!isFullTrackLevel(level) || Math.round(level) !== 0) continue;
        if (!best
            || (direction < 0 && offsetM > best.offsetM)
            || (direction > 0 && offsetM < best.offsetM)) {
            best = { vertexIndex: index, offsetM };
        }
    }
    return best;
}

let vertexLevelPopup = null;
let activeVertexSelection = null;

function closeVertexLevelPopup() {
    if (vertexLevelPopup) {
        map.closePopup(vertexLevelPopup);
        vertexLevelPopup = null;
    }
    activeVertexSelection = null;
}

function getTrackVertexRole(track, vertexIndex) {
    const lastIndex = track.latlngs.length - 1;
    const level = track.levels?.[vertexIndex] ?? 0;
    if (vertexIndex === 0 || vertexIndex === lastIndex) {
        return { kind: 'endpoint', removable: false, reason: 'Krajnji čvor trase ne može se ukloniti.' };
    }
    if (isTrackVertexJunction(track, vertexIndex)) {
        return { kind: 'junction', removable: false, reason: 'Čvor je spoj s drugom trasom.' };
    }
    // Levels are DERIVED from the strip's profile now (with fractional ramp
    // shaping), so "this vertex marks a ramp boundary" stopped being an
    // authored fact — the old guard silently refused removal along every
    // derived transition. Removing a vertex simply re-derives the profile.
    return { kind: 'ordinary', removable: true, reason: '' };
}

// 1 čvor / 2 čvora / 5 čvorova. The counting rule itself lives in
// civil-objects-view.js — one implementation, several nouns, so a fix to the
// teens case can only be made in one place.
function nodeCountText(count) {
    return window.__civilObjectsView.countText(count, ['čvor', 'čvora', 'čvorova']);
}

// A node sitting where the electrification changes is the thing that records
// where it changes; removing it would silently move the boundary.
function isElectrificationBoundaryVertex(track, chainage, vertexIndex) {
    const api = window.__trackElectrification;
    if (!api || vertexIndex <= 0 || vertexIndex >= track.latlngs.length - 1) return false;
    const trackMode = api.trackModeFor(track);
    const at = (offsetM) => api.resolveAtDistance(track, offsetM, {
        provenance: 'authored',
        trackMode,
        networkDefault: window.__TRANSIT_RUNTIME_CONFIG__?.city?.trackDefaults?.[trackMode],
    });
    const left = at((chainage.offsets[vertexIndex - 1] + chainage.offsets[vertexIndex]) / 2);
    const right = at((chainage.offsets[vertexIndex] + chainage.offsets[vertexIndex + 1]) / 2);
    return left.status !== right.status
        || left.voltageV !== right.voltageV
        || left.frequencyHz !== right.frequencyHz;
}

function removeTrackVertex(track, vertexIndex) {
    return removeTrackVertices(track, [vertexIndex]);
}

// The nodes one visible handle stands for at the current zoom. Handles are
// thinned so they can be told apart, so on a dense route a single dot is the
// only thing drawn for a whole run of nodes — and removing just that one node
// leaves the bend exactly where it was, because its neighbours still describe
// it. The run reaches to the neighbouring DRAWN handles and no further, so a
// removal can never touch geometry that is off screen.
function vertexRemovalSpanFrom(drawnIndices, vertexIndex) {
    const drawn = [...new Set(drawnIndices)].sort((left, right) => left - right);
    const position = drawn.indexOf(vertexIndex);
    if (position < 0) return [vertexIndex];
    const previous = position > 0 ? drawn[position - 1] : vertexIndex - 1;
    const next = position < drawn.length - 1 ? drawn[position + 1] : vertexIndex + 1;
    const span = [];
    for (let index = previous + 1; index <= next - 1; index++) span.push(index);
    return span.length > 0 ? span : [vertexIndex];
}

function getVertexRemovalSpan(track, vertexIndex) {
    return vertexRemovalSpanFrom(
        activeVertexHandles
            .filter(handle => handle._track === track && Number.isInteger(handle._vertexIndex))
            .map(handle => handle._vertexIndex),
        vertexIndex,
    );
}

// Asks before dropping more than the one node that was clicked. The count is
// the honest one — what will actually be removed after endpoints, junctions and
// electrification boundaries in the run are excluded.
async function requestTrackVertexRemoval(track, vertexIndex) {
    const span = getVertexRemovalSpan(track, vertexIndex);
    const chainage = span.length > 1 ? buildTrackChainage(track) : null;
    const removable = span.length > 1
        ? span.filter(index => getTrackVertexRole(track, index).removable
            && !isElectrificationBoundaryVertex(track, chainage, index))
        : span;
    if (removable.length > 1) {
        const confirmed = await askConfirm(
            `Na ovoj razini zumiranja ovdje je nacrtan samo ovaj čvor, a dionica ih ima `
            + `${removable.length}. Uklanjanjem se brišu svi — inače bi zavoj ostao `
            + 'gotovo isti, jer ga opisuju i susjedni čvorovi koji sada nisu vidljivi. '
            + 'Želite li ukloniti samo jedan čvor, približite kartu.',
            {
                title: 'Ukloniti cijelu dionicu čvorova?',
                confirmLabel: `Ukloni ${nodeCountText(removable.length)}`,
            },
        );
        if (!confirmed) return false;
    }
    return removeTrackVertices(track, span);
}

// Removes any number of nodes in one edit. One path rather than two: a
// zoomed-out removal drops the whole run of nodes a single visible handle
// stands for, and a duplicate of this (with its station reprojection,
// electrification remap, soft geometry checks and undo) would drift from it.
function removeTrackVertices(track, requestedIndices) {
    const chainage = buildTrackChainage(track);
    const api = window.__trackElectrification;
    const requested = [...new Set((requestedIndices || [])
        .filter(index => Number.isInteger(index) && index >= 0 && index < track.latlngs.length))]
        .sort((left, right) => left - right);
    if (requested.length === 0) return false;

    const blocked = [];
    const removable = requested.filter((index) => {
        const role = getTrackVertexRole(track, index);
        if (!role.removable) {
            blocked.push(role.reason || 'Ovaj čvor ne može se ukloniti.');
            return false;
        }
        if (isElectrificationBoundaryVertex(track, chainage, index)) {
            blocked.push('Čvor ostaje jer je granica elektrifikacije. '
                + 'Prvo postavite isto stanje na obje susjedne dionice.');
            return false;
        }
        return true;
    });
    if (removable.length === 0) {
        setStatusMessage(blocked[0] || 'Ovaj čvor ne može se ukloniti.', true);
        return false;
    }

    const undoSnapshot = captureRouteEditTrackSnapshot(track);
    const removedSet = new Set(removable);
    const originalLatLngs = track.latlngs.map(point => [point[0], point[1]]);
    const originalLevels = [...track.levels];
    const originalElectrificationSegments = (track.electrificationSegments || [])
        .map(segment => ({ ...segment }));
    const removedPoint = originalLatLngs[removable[Math.floor(removable.length / 2)]];
    // Chainages of the nodes that SURVIVE, before and after. Same length and
    // same order, which is what lets electrification boundaries be carried over
    // by position along the line however many nodes disappeared between them.
    const keptOldOffsets = chainage.offsets.filter((_, index) => !removedSet.has(index));
    const stationProjections = project.stations
        .filter(station => station.trackId === track.id)
        .map(station => ({
            station,
            originalLatLng: [station.latlng[0], station.latlng[1]],
            originalOffsetM: getStationTrackOffsetM(track, station, chainage),
        }))
        .sort((left, right) => left.originalOffsetM - right.originalOffsetM);
    const candidateLatLngs = originalLatLngs.filter((_, index) => !removedSet.has(index));
    const candidateLevels = originalLevels.filter((_, index) => !removedSet.has(index));
    const candidateTrack = { ...track, latlngs: candidateLatLngs, levels: candidateLevels };
    reflowTrackRampShapeLevels(candidateTrack);
    // Removal is judged by the same soft rules as a drag: the node goes, and
    // anything the straightened chord breaks is reported and left outlined in
    // red rather than trapping the node in place.
    const warnings = [];
    const baselineCurveShortfall = buildTrackCurvePlan(originalLatLngs, track.gauge).violations
        .reduce((sum, violation) => sum + violation.shortfallM, 0);
    const candidateCurve = buildTrackCurvePlan(candidateLatLngs, track.gauge);
    const candidateCurveShortfall = candidateCurve.violations
        .reduce((sum, violation) => sum + violation.shortfallM, 0);
    if (candidateCurveShortfall > baselineCurveShortfall + TRACK_CURVE_LENGTH_EPSILON_M) {
        warnings.push('zavoj je sada preoštar');
    }
    const baselineSteepShortfall = getSteepSegmentDetails(track)
        .reduce((sum, detail) => sum + detail.shortfallM, 0);
    const candidateSteepShortfall = getSteepSegmentDetails(candidateTrack)
        .reduce((sum, detail) => sum + detail.shortfallM, 0);
    if (candidateSteepShortfall > baselineSteepShortfall + 0.2) {
        warnings.push('rampa je sada prestrma');
    }
    const baselineLevelRunShortfall = getShortFullLevelRunDetails(track)
        .reduce((sum, detail) => sum + detail.shortfallM, 0);
    const candidateLevelRunShortfall = getShortFullLevelRunDetails(candidateTrack)
        .reduce((sum, detail) => sum + detail.shortfallM, 0);
    if (candidateLevelRunShortfall > baselineLevelRunShortfall + 0.2) {
        warnings.push('puna razina je sada prekratka');
    }
    // Removing a node straightens the chord it spanned — which can just as
    // easily bow the route through an underground station box as a drag can.
    const candidateAlignments = getWorsenedStationAlignments(
        candidateTrack,
        getStationAlignmentBaseline(track),
    );
    if (candidateAlignments.length > 0) {
        const worst = candidateAlignments[0];
        warnings.push(`trasa kroz ${getStationDisplayName(worst.station)} `
            + `${describeUndergroundStationDrift(worst.alignment)}`);
    }

    track.latlngs.splice(0, track.latlngs.length, ...candidateLatLngs);
    track.levels.splice(0, track.levels.length, ...candidateLevels);
    // Mapped between the surviving nodes' old and new chainages. For a single
    // removal this is the same shift the vertex-specific remap produces (every
    // node past the joined chord moves by one constant), and unlike that one it
    // stays correct when a whole run of nodes goes at once.
    track.electrificationSegments = api.remapElectrificationSegments(
        originalElectrificationSegments,
        keptOldOffsets,
        buildTrackChainage(track).offsets,
    );
    reprojectStationsAfterVertexMove(track, stationProjections);
    closeVertexLevelPopup();
    // Reprojection can move stations onto the straightened chord, so their
    // position-bound catchments must be refetched along with the geometry.
    afterTrackGeometryChange(track, { refetchCatchments: true });
    const removalMarker = L.marker(removedPoint, {
        icon: L.divIcon({ className: 'vertex-remove-effect', iconSize: [22, 22], iconAnchor: [11, 11] }),
        interactive: false,
        zIndexOffset: 1300,
    }).addTo(map);
    const effectElement = removalMarker.getElement();
    if (effectElement) {
        effectElement.addEventListener('animationend', () => map.removeLayer(removalMarker), { once: true });
    }
    const removedText = removable.length === 1
        ? 'Čvor je uklonjen'
        : `Uklonjeno čvorova: ${removable.length}`;
    const skipped = blocked.length > 0 ? ` Zadržano čvorova: ${blocked.length}.` : '';
    const undoEntry = pushRouteEditUndoSnapshot(
        undoSnapshot,
        removable.length === 1 ? 'uklanjanje čvora' : 'uklanjanje čvorova',
        removable.length === 1 ? 'Čvor je vraćen.' : `Vraćeno čvorova: ${removable.length}.`,
    );
    setStatusMessage(warnings.length > 0
        ? `${removedText}, ali: ${warnings.join('; ')}.${skipped}`
        : `${removedText}.${skipped}`, warnings.length > 0, {
        label: 'Poništi',
        onClick: () => undoLastRouteEdit(undoEntry),
    });
    return true;
}

// Small popup for inspecting/removing a track vertex. Elevation is authored in
// the profile strip now (the map is display-only for height), so this no longer
// carries the raise/lower level controls — only node removal + a drag hint.
function openVertexLevelPopup(track, vertexIndex) {
    closeVertexLevelPopup();
    const role = getTrackVertexRole(track, vertexIndex);
    activeVertexSelection = { track, vertexIndex };
    const hint = role.removable
        ? 'Povucite čvor da promijenite trasu, ili ga uklonite. Visinu uređujete u visinskom profilu ispod karte.'
        : (role.reason || 'Povucite čvor da promijenite trasu. Visinu uređujete u visinskom profilu ispod karte.');
    const html = `<div class="vertex-level-popup" data-track-id="${track.id}" data-vertex-index="${vertexIndex}">
        <button class="vertex-remove-btn" data-remove-vertex ${role.removable ? '' : `disabled title="${escapeHtml(role.reason)}"`}>Ukloni čvor</button>
        <div class="vertex-level-hint">${escapeHtml(hint)}</div>
    </div>`;

    vertexLevelPopup = L.popup({
        closeButton: false,
        className: 'vertex-level-map-popup',
        offset: [28, -10],
        autoPan: false,
    })
        .setLatLng(track.latlngs[vertexIndex])
        .setContent(html)
        .openOn(map);

    vertexLevelPopup.once('remove', () => {
        vertexLevelPopup = null;
        activeVertexSelection = null;
    });

    const popupEl = vertexLevelPopup.getElement();
    if (!popupEl) return;
    popupEl.addEventListener('click', e => {
        L.DomEvent.stopPropagation(e);
        const removeButton = e.target.closest('[data-remove-vertex]');
        if (removeButton && !removeButton.disabled) requestTrackVertexRemoval(track, vertexIndex);
    });
    popupEl.addEventListener('mouseenter', () => { hoveringObject = true; });
    popupEl.addEventListener('mouseleave', () => { hoveringObject = false; });
}

document.addEventListener('keydown', event => {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
    if (!activeVertexSelection) return;
    event.preventDefault();
    requestTrackVertexRemoval(activeVertexSelection.track, activeVertexSelection.vertexIndex);
});

function getVertexHandleIcon(track, index, isFreeEndpoint) {
    // Elevation is authored in the strip now, so handles no longer encode level
    // (no ±1 badge, no below/above tint) — they're plain drag handles.
    const fresh = isFreshVertex(track, index);
    const freshClass = fresh ? ' vertex-handle-fresh' : '';
    // A just-added node is drawn oversized so it can be grabbed and dragged
    // immediately, on a phone as much as with a mouse.
    const size = isFreeEndpoint ? 20 : fresh ? 22 : 12;
    return L.divIcon({
        className: (isFreeEndpoint ? 'vertex-handle vertex-handle-extend' : 'vertex-handle') + freshClass,
        html: '',
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
    });
}


// ─── Which vertices get a handle ────────────────────────────────────────────
// A handle is a DOM marker. A reconstructed main line carries thousands of
// nodes, and putting a marker on every one of them makes the map crawl before
// anything is even dragged. Only nodes in view get a handle, and only far
// enough apart on screen to be told apart and grabbed — zoom in for the ones
// in between, exactly as node insertion already requires.
const VERTEX_HANDLE_MIN_SPACING_PX = 22;
const VERTEX_HANDLE_VIEWPORT_PADDING = 0.2;
// Backstop for a route that folds back on itself often enough to defeat the
// spacing rule. Well above what a screen can show at that spacing.
const VERTEX_HANDLE_MAX_PER_TRACK = 400;

function getVertexHandleIndices(track) {
    const lastIndex = track.latlngs.length - 1;
    if (lastIndex < 1) {
        return { indices: track.latlngs.map((_, index) => index), hidden: 0 };
    }

    const bounds = map.getBounds().pad(VERTEX_HANDLE_VIEWPORT_PADDING);
    // Compared as plain numbers: this runs over every vertex on every pan, and
    // a LatLng per vertex is thousands of throwaway objects for no gain.
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    const west = bounds.getWest();
    const east = bounds.getEast();
    // Endpoints anchor the route and junctions pin it to the rest of the
    // network: both stay reachable whatever the thinning would otherwise do.
    const pinned = new Set([0, lastIndex]);
    for (const index of getTrackJunctionVertexIndices(track, bounds)) pinned.add(index);
    if (freshVertex?.trackId === track.id) pinned.add(freshVertex.vertexIndex);
    if (vertexDragOriginalState?.track === track) pinned.add(vertexDragOriginalState.vertexIndex);

    const indices = [];
    let hidden = 0;
    let lastKeptPoint = null;
    for (let index = 0; index <= lastIndex; index++) {
        const [lat, lng] = track.latlngs[index];
        if (lat < south || lat > north || lng < west || lng > east) continue;
        const point = map.latLngToContainerPoint(L.latLng(lat, lng));
        if (!pinned.has(index)
            && lastKeptPoint
            && point.distanceTo(lastKeptPoint) < VERTEX_HANDLE_MIN_SPACING_PX) {
            hidden++;
            continue;
        }
        if (indices.length >= VERTEX_HANDLE_MAX_PER_TRACK && !pinned.has(index)) {
            hidden++;
            continue;
        }
        indices.push(index);
        lastKeptPoint = point;
    }
    return { indices, hidden };
}

// The vertices of this track that coincide with another track's endpoint.
// Scanned from the other tracks' ends (a handful of points) rather than by
// asking every vertex whether it is a junction.
function getTrackJunctionVertexIndices(track, bounds = null) {
    const junctions = new Set();
    for (const other of project.tracks || []) {
        if (other.id === track.id) continue;
        for (const otherIndex of [0, other.latlngs.length - 1]) {
            const otherPoint = other.latlngs[otherIndex];
            if (!otherPoint) continue;
            // A junction outside the view cannot pin a handle that is not being
            // drawn, and skipping it keeps this off the per-pan path when a
            // project has many tracks.
            if (bounds && !bounds.contains(L.latLng(otherPoint[0], otherPoint[1]))) continue;
            for (let index = 0; index <= track.latlngs.length - 1; index++) {
                const point = track.latlngs[index];
                if (distanceMetersLatLng(point[0], point[1], otherPoint[0], otherPoint[1])
                    <= JUNCTION_CONNECTIVITY_THRESHOLD_METERS) junctions.add(index);
            }
        }
    }
    return junctions;
}


// ─── Track Vertex Editing ───────────────────────────────────────────────────
let hiddenVertexHandleCount = 0;

function showTrackVertexHandles(track, { append = false } = {}) {
    if (!append) removeVertexHandles();
    if (!track) return;
    const trackStations = project.stations.filter(s => s.trackId === track.id);

    const lastIndex = track.latlngs.length - 1;
    const startFree = isTrackEndpointFree(track, 0);
    const endFree = isTrackEndpointFree(track, lastIndex);

    const { indices, hidden } = getVertexHandleIndices(track);
    hiddenVertexHandleCount += hidden;

    indices.forEach((index) => {
        const ll = track.latlngs[index];
        const isFreeEndpoint = (index === 0 && startFree) || (index === lastIndex && endFree);

        const handle = L.marker(ll, {
            draggable: true,
            interactive: true,
            keyboard: false,
            icon: getVertexHandleIcon(track, index, isFreeEndpoint),
            zIndexOffset: isFreshVertex(track, index) ? 1200 : isFreeEndpoint ? 1100 : 1000,
        }).addTo(map);
        handle._track = track;
        handle._vertexIndex = index;
        activeVertexHandles.push(handle);

        // Free endpoints: click to extend (enter draw mode from this point).
        // Other vertices: click opens the raise/lower level popup; right-click
        // (long-press on mobile) opens it on any vertex, endpoints included.
        if (isFreeEndpoint) {
            handle.on('click', (e) => {
                L.DomEvent.stopPropagation(e);
                startExtendFromEndpoint(track, index);
            });
        } else {
            handle.on('click', (e) => {
                L.DomEvent.stopPropagation(e);
                openVertexLevelPopup(track, index);
            });
        }
        handle.on('contextmenu', (e) => {
            L.DomEvent.stopPropagation(e);
            if (e.originalEvent) e.originalEvent.preventDefault();
            openVertexLevelPopup(track, index);
        });

        handle.on('dragstart', () => {
            draggingVertex = true;
            clearVertexDragReferenceSnap();
            beginTrackVertexDrag(track, trackStations, index);
            vertexDragStationProjections = captureAdjacentStationProjections(track, trackStations, index);
            updateVertexDragLegalityPreview(handle, track);
            if (snapMarker) { map.removeLayer(snapMarker); snapMarker = null; }
            clearPreviewCatchment();
            clearPreviewStationDistances();
        });

        handle.on('drag', () => {
            let pos = handle.getLatLng();
            const isEndpoint = index === 0 || index === lastIndex;
            const referenceSnap = isEndpoint
                ? snapPointToReferenceRail(pos, track.gauge)
                : null;
            if (referenceSnap) {
                vertexDragReferenceSnap = referenceSnap;
                pos = L.latLng(referenceSnap.lat, referenceSnap.lng);
                handle.setLatLng(pos);
                if (!vertexDragReferenceSnapMarker) {
                    vertexDragReferenceSnapMarker = L.marker(pos, {
                        icon: externalRailSnapIcon,
                        interactive: false,
                        zIndexOffset: 1250,
                    }).addTo(map);
                } else {
                    vertexDragReferenceSnapMarker.setLatLng(pos);
                }
            } else {
                clearVertexDragReferenceSnap();
            }
            track.latlngs[index] = [pos.lat, pos.lng];
            reflowTrackRampShapeLevels(track, { nearVertexIndex: index });
            // Live layer/profile sync so trains follow the track in real time
            syncTrackGeometryLayers(track);
            reprojectStationsAfterVertexMove(track, vertexDragStationProjections);
            updateVertexMergePreview(track, index, pos);
            updateVertexDragLegalityPreview(handle, track);
        });

        handle.on('dragend', () => {
            draggingVertex = false;
            const referenceSnap = vertexDragReferenceSnap;
            clearVertexDragReferenceSnap();
            clearVertexDragLegalityPreview();
            if (finishVertexMergeDrop(track, index)) {
                refreshRouteEditHandles();
                return;
            }
            clearVertexMergePreview();
            if (!acceptTrackVertexCurveEdit(track)) {
                refreshRouteEditHandles();
                return;
            }
            if (referenceSnap) {
                const endpoint = index === 0 ? 'start' : 'end';
                const pointBeforeJunction = index === 0
                    ? track.latlngs[1]
                    : track.latlngs[track.latlngs.length - 2];
                queueReferenceConnectionIntent(track, endpoint, referenceSnap, pointBeforeJunction);
            }
            finalizeTrackVertexDrag(track);
            if (referenceSnap) {
                setStatusMessage(
                    'Kraj postojeće trase pripremljen je za spoj. Spremite projekt za potvrdu veze.',
                );
            }
        });
    });
}

function showAllTrackVertexHandles() {
    removeVertexHandles();
    hiddenVertexHandleCount = 0;
    for (const track of project.tracks || []) showTrackVertexHandles(track, { append: true });
    updateHiddenVertexHandleHint();
}

// Says once, quietly, that the map is not showing every node — otherwise a
// thinned view reads as nodes having gone missing.
function updateHiddenVertexHandleHint() {
    const hint = document.getElementById('vertexHandleDensityHint');
    if (!hint) return;
    hint.classList.toggle('hidden', hiddenVertexHandleCount === 0);
    if (hiddenVertexHandleCount > 0) {
        hint.textContent = `Skriveno čvorova: ${hiddenVertexHandleCount} — približite kartu da ih vidite.`;
    }
}

function refreshRouteEditHandles() {
    if (currentMode === 'edit') showAllTrackVertexHandles();
}

// Which vertices are close enough together to be worth drawing depends on the
// current zoom and viewport, so the handle set is rebuilt whenever either
// settles. Never mid-drag: that would delete the marker being dragged. Bound on
// first use because this file is loaded before transit.js creates the map.
let vertexHandleViewportWatchBound = false;
function ensureVertexHandleViewportWatch() {
    if (vertexHandleViewportWatchBound) return;
    vertexHandleViewportWatchBound = true;
    map.on('moveend zoomend', () => {
        if (currentMode !== 'edit' || draggingVertex) return;
        showAllTrackVertexHandles();
    });
}

// Adds a node where the track was clicked. The geometry is checked exactly as
// a drag is: only a broken junction is refused, anything else is added with a
// warning and left marked on the map.
function insertTrackVertex(track, lat, lon) {
    if (!track) return false;
    if (!canStartVertexPlacement({ notify: true })) return false;
    const snap = nearestPointOnTrack(track, lat, lon);
    if (!snap) return false;

    const snappedLatLng = L.latLng(snap.lat, snap.lon);
    if (isTooCloseToExistingVertex(track, snappedLatLng)) {
        setStatusMessage('Ovdje već postoji čvor. Povucite postojeći ili kliknite dalje od njega.', true);
        return false;
    }

    const undoSnapshot = captureRouteEditTrackSnapshot(track);
    const trackStations = project.stations.filter(station => station.trackId === track.id);
    const originalLatLngs = undoSnapshot.latlngs;
    const originalLevels = undoSnapshot.levels;
    const originalStationLatLngs = undoSnapshot.stationStates;

    if (!spliceTrackVertex(track, snap.segmentIndex, [snap.lat, snap.lon])) return false;
    const vertexIndex = snap.segmentIndex + 1;

    beginTrackVertexDrag(track, trackStations, vertexIndex, { isNewVertex: true });
    vertexDragStationProjections = captureAdjacentStationProjections(
        track,
        trackStations,
        vertexIndex,
    );
    reflowTrackRampShapeLevels(track, { nearVertexIndex: vertexIndex });
    reprojectStationsAfterVertexMove(track, vertexDragStationProjections);
    vertexDragStationProjections = null;

    const validation = getTrackVertexDragValidation(track);
    if (validation.blocking) {
        vertexDragOriginalState = null;
        track.latlngs.splice(0, track.latlngs.length, ...originalLatLngs);
        track.levels.splice(0, track.levels.length, ...originalLevels);
        for (const { station, latlng } of originalStationLatLngs) {
            setStationMapPosition(station, latlng);
        }
        syncTrackGeometryLayers(track);
        flashTrackSegments(track, validation.segmentIndices);
        setStatusMessage(getInsertedVertexInvalidMessage(validation), true);
        return false;
    }

    vertexDragOriginalState = null;
    removePreviewVertex();
    markFreshVertex(track, vertexIndex);
    finalizeTrackVertexDrag(track);
    pushRouteEditUndoSnapshot(
        undoSnapshot,
        'dodavanje čvora',
        'Dodavanje čvora je poništeno.',
    );
    setStatusMessage(validation.legal
        ? 'Čvor je dodan — povucite ga na željeno mjesto.'
        : `${describeSoftGeometryFault(track, validation)} Čvor je ipak dodan — povucite ga na željeno mjesto.`,
        !validation.legal);
    return true;
}

// Commits a finished vertex drag or insertion. Dragging can move stations
// (reprojection), so the pipeline also refetches their catchments.
//
// The old whole-track incline warning that used to fire here is gone: it
// flashed and overwrote the specific message the edit had just produced, and
// standing steep ramps are now shown continuously by the red outline that
// afterTrackGeometryChange schedules.
function finalizeTrackVertexDrag(track) {
    afterTrackGeometryChange(track, { refetchCatchments: true });
}


// ─── Edit Mode ──────────────────────────────────────────────────────────────
function syncExclusiveEditInteractivity() {
    const editing = currentMode === 'edit';
    mapContainer.classList.toggle('edit-mode', editing);
    if (editing) hoveringObject = false;

    for (const track of project.tracks || []) {
        for (const layer of [track.layer, track.hitLayer]) {
            layer?.getElement()?.classList.remove('route-edit-target');
        }
    }
    for (const line of project.lines || []) {
        for (const layer of [line.layer, line.hitLayer]) {
            layer?.getElement()?.classList.remove('route-edit-target');
        }
    }

    if (editing) {
        for (const track of project.tracks || []) {
            const target = track.hitLayer || track.layer;
            target?.bringToFront?.();
            target?.getElement()?.classList.add('route-edit-target');
        }
    }

    // Leaflet's marker drag handler can begin before a click is emitted. It
    // therefore has to be disabled explicitly, not merely ignored by the
    // click dispatcher, while edit mode owns map interaction.
    for (const station of project.stations || []) {
        const marker = station.markerLayer;
        const markerElement = marker?.getElement();
        markerElement?.classList.remove('station-edit-target', 'station-edit-active');
        if (editing) {
            markerElement?.classList.remove('station-marker-hover');
            markerElement?.classList.add('station-edit-target');
        }
        if (!marker?.dragging) continue;
        if (editing) marker.dragging.enable();
        else marker.dragging.disable();
    }
    if (editing) {
        for (const line of project.lines || []) {
            for (const train of line.trains || []) {
                const element = train.marker?.getElement();
                if (element) element.style.filter = '';
            }
        }
    }
}

function enterEditMode() {
    if ((project.tracks || []).length === 0) {
        setStatusMessage('Nema mreže za uređivanje. Nacrtajte prvo trasu.', true);
        return false;
    }
    // One history belongs to one uninterrupted editor session. Outside edits
    // (especially elevation-profile changes) must never be rolled back by an
    // old map snapshot when the editor is opened again later.
    clearRouteEditUndoHistory();
    if (selectedObject) deselectObject();
    map.closePopup();
    setMode('edit');
    ensureVertexHandleViewportWatch();
    showAllTrackVertexHandles();
    refreshTrackProblemOutlines();
    syncExclusiveEditInteractivity();
    renderSelectionSheet();
    setStatusMessage('Uređivanje mreže: povucite čvorove ili stanice, kliknite trasu za novi čvor. Ctrl/Cmd+Z poništava zadnju izmjenu. Završite gumbom „Završi” na karti.');
    return true;
}

function finishEditMode() {
    if (currentMode !== 'edit') return;
    setMode('explore');
    refreshTrackProblemOutlines();
    closeSelectionDisplay();
    setStatusMessage('Uređivanje mreže završeno. Klikovi na kartu ponovno služe pregledu i Šetnji.');
}

// Live legality while a station is being dragged, mirroring what vertex drags
// already do. The dragend guard rejects a drop that bends the route through an
// underground station's box and snaps the marker back — which is fine as a rule
// but was invisible until it happened, so the station appeared to jump on its
// own. Showing the illegal state DURING the gesture makes the rejection the
// expected outcome of what you can already see.
//
// Throttled: the check resamples the whole smoothed centreline, which is far too
// expensive at drag-frame rate on a long route.
let stationDragLegalityAtMs = 0;
let stationDragLegal = true;
const STATION_DRAG_LEGALITY_INTERVAL_MS = 120;
function updateStationDragLegalityPreview(station, track, marker) {
    const element = marker.getElement();
    if (!element) return;
    if (!track || getStationStructureKind(track, station) !== 'tunnel') {
        element.classList.remove('station-marker-illegal');
        stationDragLegal = true;
        return;
    }
    const nowMs = performance.now();
    if (nowMs - stationDragLegalityAtMs >= STATION_DRAG_LEGALITY_INTERVAL_MS) {
        stationDragLegalityAtMs = nowMs;
        const alignment = getUndergroundStationAlignment(track, station.latlng);
        const before = station._moveStartAlignment;
        const allowedDriftM = Math.max(
            before?.driftM ?? 0,
            UNDERGROUND_STATION_STRAIGHT_TOLERANCE_METERS,
        );
        stationDragLegal = alignment.driftM <= allowedDriftM + STATION_ALIGNMENT_EPSILON_M;
    }
    element.classList.toggle('station-marker-illegal', !stationDragLegal);
}

function attachStationDrag(station) {
    const marker = station.markerLayer;
    if (!marker) return;
    marker.options.draggable = true;
    if (marker.dragging) marker.dragging.disable();

    marker.on('dragstart', () => {
        if (currentMode !== 'edit') return;
        draggingVertex = true;
        station._moveStartLatLng = [station.latlng[0], station.latlng[1]];
        const startTrack = project.tracks.find(t => t.id === station.trackId);
        station._moveUndoSnapshot = startTrack ? captureRouteEditTrackSnapshot(startTrack) : null;
        station._moveStartAlignment = startTrack
            && getStationStructureKind(startTrack, station) === 'tunnel'
            ? getUndergroundStationAlignment(startTrack, station.latlng)
            : null;
        stationDragLegal = true;
        stationDragLegalityAtMs = 0;   // evaluate on the first drag frame
        marker.getElement()?.classList.add('station-edit-active');
        if (snapMarker) { map.removeLayer(snapMarker); snapMarker = null; }
        clearPreviewCatchment();
        clearPreviewStationDistances();
    });

    marker.on('drag', () => {
        if (currentMode !== 'edit') return;
        const track = project.tracks.find(t => t.id === station.trackId);
        if (!track) return;
        const pos = marker.getLatLng();
        const bounds = getStationOrderOffsetBounds(track, station);
        const snapped = nearestPointOnTrackWithinOffsets(track, pos.lat, pos.lng, bounds);
        if (snapped) {
            setStationMapPosition(station, [snapped.lat, snapped.lon]);
        } else {
            marker.setLatLng(station.latlng);
            return;
        }
        const dragPos = [snapped.lat, snapped.lon];

        // Update station latlng live so trains track the station during drag
        const line = station.lineId != null ? project.lines.find(l => l.id === station.lineId) : null;
        if (line) {
            rebuildLineProfilePreservingTrains(line);
        }

        const nearAny = project.stations.some(s =>
            s.id !== station.id &&
            distanceMetersLatLng(dragPos[0], dragPos[1], s.latlng[0], s.latlng[1]) <= TRANSFER_LINK_RADIUS_METERS
        );
        const el = marker.getElement();
        if (el) el.classList.toggle('station-marker-near-transfer', nearAny);
        updateStationDragLegalityPreview(station, track, marker);
    });

    marker.on('dragend', () => {
        if (currentMode !== 'edit') return;
        draggingVertex = false;
        const track = project.tracks.find(t => t.id === station.trackId);
        const pos = marker.getLatLng();
        const bounds = track ? getStationOrderOffsetBounds(track, station) : null;
        const snapped = track ? nearestPointOnTrackWithinOffsets(track, pos.lat, pos.lng, bounds) : null;
        const finalPos = snapped ? [snapped.lat, snapped.lon] : [pos.lat, pos.lng];
        setStationMapPosition(station, finalPos);
        const el = marker.getElement();
        if (el) el.classList.remove('station-marker-near-transfer', 'station-edit-active', 'station-marker-illegal');

        // An underground station carries its 170 m straight box with it. A
        // station that was already on a bad alignment may still be dragged —
        // just never to a worse spot — so it can be walked onto a good one.
        //
        // Straightness only: the level check that used to sit here read the
        // PRE-move profile (setStationMapPosition only SCHEDULES the re-solve,
        // debounced), so it judged the move against a grade the station's own
        // span had not yet flattened, and bounced legitimate moves back. The
        // solver owns levelling; see isUndergroundStationPlaceable in transit.js.
        if (track && getStationStructureKind(track, station) === 'tunnel') {
            const alignment = getUndergroundStationAlignment(track, station.latlng);
            const before = station._moveStartAlignment;
            const allowedDriftM = Math.max(
                before?.driftM ?? 0,
                UNDERGROUND_STATION_STRAIGHT_TOLERANCE_METERS,
            );
            if (alignment.driftM > allowedDriftM + STATION_ALIGNMENT_EPSILON_M) {
                const startLatLng = station._moveStartLatLng;
                if (startLatLng) setStationMapPosition(station, startLatLng);
                marker.setLatLng(station.latlng);
                delete station._moveStartLatLng;
                delete station._moveStartAlignment;
                delete station._moveUndoSnapshot;
                refreshTrackStationLevels(track);
                showUndergroundStationAlignmentFault(
                    track,
                    alignment,
                    `${getStationDisplayName(station)} ne može stajati ovdje: `
                    + `trasa skreće ${alignment.driftM.toFixed(1)} m od osi stanice. `
                    + 'Podzemna stanica traži ravnu trasu po cijeloj svojoj duljini.',
                );
                return;
            }
        }
        delete station._moveStartAlignment;
        if (track) refreshTrackStationLevels(track);
        const movedM = station._moveStartLatLng
            ? distanceMetersLatLng(...station._moveStartLatLng, ...finalPos)
            : 0;
        const undoSnapshot = station._moveUndoSnapshot;
        delete station._moveStartLatLng;
        delete station._moveUndoSnapshot;
        setStatusMessage(`${getStationDisplayName(station)} pomaknuta ${Math.round(movedM)} m.`);
        finalizeStationDrag(station);
        if (undoSnapshot && movedM > 0.05) {
            pushRouteEditUndoSnapshot(
                undoSnapshot,
                `pomicanje stanice ${getStationDisplayName(station)}`,
                `${getStationDisplayName(station)} vraćena je na prethodno mjesto.`,
            );
        }
    });
}

async function finalizeStationDrag(station) {
    const line = project.lines.find(l => l.id === station.lineId);
    const deferTransferOffer = currentMode === 'edit';

    // Break transfer links that are now too far
    const brokenLinkIds = project.transferLinks
        .filter(l => l.stationIdA === station.id || l.stationIdB === station.id)
        .filter(l => {
            const otherId = l.stationIdA === station.id ? l.stationIdB : l.stationIdA;
            const other = _stationById.get(otherId);
            return other && distanceMetersLatLng(station.latlng[0], station.latlng[1], other.latlng[0], other.latlng[1]) > TRANSFER_LINK_RADIUS_METERS;
        })
        .map(l => l.id);
    for (const linkId of brokenLinkIds) removeTransferLink(linkId);
    if (brokenLinkIds.length > 0) setStatusMessage('Presjedanje uklonjeno — stanice su predaleko.');

    // Same per-station token as refreshTrackStationCatchments: a newer refresh
    // (another drag, a vertex edit on this track) invalidates this one.
    station._catchmentRefreshId = (station._catchmentRefreshId || 0) + 1;
    const catchmentToken = station._catchmentRefreshId;
    if (station.catchmentLayer) {
        map.removeLayer(station.catchmentLayer);
        station.catchmentLayer = null;
    }

    try {
        const data = station.walkMinutes > 0
            ? await fetchCachedStationCatchment(station.latlng[0], station.latlng[1], station.walkMinutes)
            : { catchmentPolygon: null, catchmentPopulation: 0, catchmentJobs: 0 };
        if (station._catchmentRefreshId === catchmentToken) {
            station.catchmentPolygon = data.catchmentPolygon;
            station.catchmentPopulation = data.catchmentPopulation;
            station.catchmentJobs = data.catchmentJobs;
            station.catchmentLayer = createStationCatchmentLayer(data.catchmentPolygon);
        }
    } catch (err) {
        if (station._catchmentRefreshId === catchmentToken) {
            station.catchmentPolygon = null;
            station.catchmentPopulation = 0;
            station.catchmentJobs = 0;
        }
    }

    if (line) rebuildLineProfilePreservingTrains(line);
    updateProjectSummary();

    if (selectedObject && selectedObject.type === 'station' && selectedObject.ref === station) {
        selectObject('station', station.id, station);
    }

    // Offer new transfer links to nearby stations on different lines not already connected
    const alreadyConnected = new Set(
        project.transferLinks
            .filter(l => l.stationIdA === station.id || l.stationIdB === station.id)
            .map(l => l.stationIdA === station.id ? l.stationIdB : l.stationIdA)
    );
    const nearbyLinkable = project.stations.filter(s =>
        s.id !== station.id &&
        s.trackId !== station.trackId &&
        !alreadyConnected.has(s.id) &&
        distanceMetersLatLng(station.latlng[0], station.latlng[1], s.latlng[0], s.latlng[1]) <= TRANSFER_LINK_RADIUS_METERS
    );
    if (!deferTransferOffer && nearbyLinkable.length > 0) showTransferLinkPopup(station, nearbyLinkable);
}

function blockSidebarRouteActionDuringEdit() {
    if (currentMode !== 'edit') return false;
    removeSidebarHighlight();
    setStatusMessage('Najprije završite uređivanje mreže.');
    return true;
}
