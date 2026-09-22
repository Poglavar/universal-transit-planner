// The live 3D preview: embeds the hr-reljef viewer (?embed=1) in a dialog and
// feeds it the WORKING project — drafts included — over postMessage, keeping
// the camera on the node last edited. Read-only: nothing flows back from the
// viewer. The working state is read from transit.js's own globals (project,
// buildCanonicalProjectData), so no editor code path needed changing.
//
// UMD so the pure helpers (edit diffing, chainage walking) run under the node
// tests; the DOM wiring only engages in the page.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__reliefPreview = api;
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // How often the working project is compared against what the viewer has.
    // Polling, deliberately: geometry mutates in a dozen places (vertex drags,
    // inserts, deletions, stripe PVI edits, undo) and instrumenting each one
    // couples this preview to all of them; a snapshot diff catches every path,
    // including ones added later.
    const POLL_MS = 600;

    const EARTH_RADIUS_M = 6371000;
    function haversineM(a, b) {
        const toRad = (d) => (d * Math.PI) / 180;
        const dLat = toRad(b[0] - a[0]);
        const dLon = toRad(b[1] - a[1]);
        const s = Math.sin(dLat / 2) ** 2
            + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
        return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(s));
    }

    // The latlng a chainage lands on, walking the polyline. Self-contained so
    // the preview does not reach into transit.js's chainage machinery.
    function chainageToLatLng(latlngs, dM) {
        if (!Array.isArray(latlngs) || latlngs.length === 0) return null;
        if (!(dM > 0)) return { lat: latlngs[0][0], lon: latlngs[0][1] };
        let walked = 0;
        for (let i = 0; i + 1 < latlngs.length; i++) {
            const leg = haversineM(latlngs[i], latlngs[i + 1]);
            if (walked + leg >= dM && leg > 0) {
                const t = (dM - walked) / leg;
                return {
                    lat: latlngs[i][0] + (latlngs[i + 1][0] - latlngs[i][0]) * t,
                    lon: latlngs[i][1] + (latlngs[i + 1][1] - latlngs[i][1]) * t,
                };
            }
            walked += leg;
        }
        const last = latlngs[latlngs.length - 1];
        return { lat: last[0], lon: last[1] };
    }

    // Where the latest edit happened, from two snapshots of project_data
    // tracks: the first vertex whose coordinates differ, a vertex inserted or
    // removed, or — when the geometry is unchanged — the profile point that
    // moved, located along the line by its chainage. Null when nothing
    // locatable changed (a removed track, a metadata edit).
    function findEditedNode(previousTracks, nextTracks) {
        const prev = previousTracks || [];
        const next = nextTracks || [];
        for (let t = 0; t < next.length; t++) {
            const nextTrack = next[t] || {};
            const prevTrack = prev[t];
            const nextLatlngs = nextTrack.latlngs || [];
            if (!prevTrack) {
                // A whole new track: look at its far end, where drawing goes on.
                const last = nextLatlngs[nextLatlngs.length - 1];
                return last ? { lat: last[0], lon: last[1] } : null;
            }
            const prevLatlngs = prevTrack.latlngs || [];
            const shared = Math.min(prevLatlngs.length, nextLatlngs.length);
            for (let i = 0; i < shared; i++) {
                if (prevLatlngs[i][0] !== nextLatlngs[i][0]
                    || prevLatlngs[i][1] !== nextLatlngs[i][1]) {
                    return { lat: nextLatlngs[i][0], lon: nextLatlngs[i][1] };
                }
            }
            if (nextLatlngs.length !== prevLatlngs.length) {
                // Insert or delete past the shared prefix: the edit is at the
                // first differing position, clamped into the surviving line.
                const at = Math.min(shared, nextLatlngs.length - 1);
                const node = nextLatlngs[at];
                return node ? { lat: node[0], lon: node[1] } : null;
            }
            const edited = editedProfilePoint(prevTrack, nextTrack);
            if (edited) return chainageToLatLng(nextLatlngs, edited.dM);
        }
        return null;
    }

    // The chainage of a profile edit: a PVI that moved, appeared or vanished —
    // matched by position in metres, because the stripe identifies nodes by
    // chainage, not by index.
    function editedProfilePoint(prevTrack, nextTrack) {
        const prevPvis = prevTrack.verticalProfile?.pvis || [];
        const nextPvis = nextTrack.verticalProfile?.pvis || [];
        const byChainage = new Map(prevPvis.map((pvi) => [Math.round(pvi.dM), pvi]));
        for (const pvi of nextPvis) {
            const before = byChainage.get(Math.round(pvi.dM));
            if (!before || before.elevAslM !== pvi.elevAslM || before.locked !== pvi.locked) {
                return { dM: pvi.dM };
            }
            byChainage.delete(Math.round(pvi.dM));
        }
        const removed = byChainage.values().next().value;
        return removed ? { dM: removed.dM } : null;
    }


    // The nearest point on any track to a clicked spot, with its distance —
    // how a map click decides whether it was aimed at the line. Equirectangular
    // locally: at click scales the error is negligible.
    function nearestOnTracks(tracks, lat, lon) {
        const mPerDegLat = 111320;
        const mPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
        let best = null;
        for (const track of tracks || []) {
            const pts = track.latlngs || [];
            for (let i = 0; i + 1 < pts.length; i++) {
                const ax = (pts[i][1] - lon) * mPerDegLon;
                const ay = (pts[i][0] - lat) * mPerDegLat;
                const bx = (pts[i + 1][1] - lon) * mPerDegLon;
                const by = (pts[i + 1][0] - lat) * mPerDegLat;
                const dx = bx - ax;
                const dy = by - ay;
                const lengthSq = dx * dx + dy * dy;
                const t = lengthSq > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / lengthSq)) : 0;
                const px = ax + t * dx;
                const py = ay + t * dy;
                const distanceM = Math.hypot(px, py);
                if (!best || distanceM < best.distanceM) {
                    best = {
                        distanceM,
                        lat: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t,
                        lon: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t,
                    };
                }
            }
        }
        return best;
    }

    const api = { findEditedNode, chainageToLatLng, editedProfilePoint, nearestOnTracks };


    // ---- page wiring (skipped entirely under node) ---------------------------
    if (typeof document === 'undefined') return api;

    // A docked companion, not a modal: the map and the elevation stripe stay
    // fully interactive beside it, and the panel follows the editing — the
    // clicked node or station, a dragged vertex, a stripe elevation edit — by
    // watching the planner's own state each tick. Close-up by default: the
    // panel is small, so it earns its pixels by being zoomed in.
    const POLL_STATE_MS = 250;
    const FOCUS_DISTANCE_M = 260;
    // Interaction-aware pacing. Streaming every hover position into the
    // iframe made IT the load: each focus can reselect tiles and rebuild
    // geometry, and that GPU churn janked the parent's own pointer. So focus
    // is sent on a TRAILING debounce (the spot where the pointer settles),
    // and the heavier project sync runs only in pointer-quiet gaps, from an
    // idle callback.
    const FOCUS_SETTLE_MS = 220;
    const SYNC_QUIET_MS = 350;

    let panel = null;
    let iframe = null;
    let viewerOrigin = '';
    let viewerReady = false;
    let pollTimer = null;
    let lastSerialized = '';
    let lastTracks = null;
    let lastFocusKey = '';
    let lastPointerAt = 0;
    let focusTimer = null;
    let pendingFocus = null;
    let syncQueued = false;

    function notePointer() { lastPointerAt = performance.now(); }

    function reliefEmbedUrl() {
        const base = (window.ReliefViewerLink?.reliefViewerBaseUrl(window.location)) || '/reljef';
        // The experiment knob: extra viewer params the embed opens with —
        // currently the OSM drape, so the track reads against streets and
        // place names. (Earlier tried: izohipse=20 contour bands.)
        return `${base.replace(/\/+$/, '')}/?embed=1&basemap=osm`;
    }

    function workingPayload() {
        if (typeof buildCanonicalProjectData !== 'function') return null;
        const projectData = buildCanonicalProjectData();
        if (!projectData?.tracks?.length) return null;
        const name = document.getElementById('projectNameLabel')?.textContent?.trim();
        return { id: 'draft', author_name: name || 'Radna verzija', project_data: projectData };
    }

    function send(message) {
        if (!viewerReady || !iframe?.contentWindow) return;
        iframe.contentWindow.postMessage(message, viewerOrigin);
    }

    function sendFocus(lat, lon) {
        send({ type: 'reljef:focus', lon, lat, distanceM: FOCUS_DISTANCE_M });
    }

    // Trailing debounce: the LAST pointed spot wins, once pointing pauses.
    function scheduleFocus(focus) {
        pendingFocus = focus;
        clearTimeout(focusTimer);
        focusTimer = setTimeout(() => {
            if (!pendingFocus) return;
            sendFocus(pendingFocus.lat, pendingFocus.lon);
            lastFocusKey = pendingFocus.key;
            pendingFocus = null;
        }, FOCUS_SETTLE_MS);
    }

    // The editing spot the user has POINTED AT, in priority order: the vertex
    // whose popup is open, a freshly inserted vertex, the selected station.
    // These are transit.js/route-edit.js top-level bindings — classic scripts
    // share one global lexical scope, so they are readable here without any
    // instrumentation of the editor.
    // A map click aimed at the line (within this many metres of it) drives
    // the focus to the nearest point ON the line.
    const MAP_CLICK_SNAP_M = 400;
    let mapClickFocus = null;

    function onMapClick(event) {
        try {
            const hit = nearestOnTracks(project?.tracks, event.latlng.lat, event.latlng.lng);
            if (hit && hit.distanceM <= MAP_CLICK_SNAP_M) {
                mapClickFocus = { key: `m:${hit.lat.toFixed(5)}:${hit.lon.toFixed(5)}`, lat: hit.lat, lon: hit.lon };
            }
        } catch { /* project mid-mutation */ }
    }

    function pointedFocus() {
        try {
            // The stripe drives first: transit.js already mirrors the strip
            // pointer onto the map as elevationHoverMarker, live during drags
            // too — its position IS "the part of the track being pointed at".
            if (typeof elevationHoverMarker !== 'undefined' && elevationHoverMarker) {
                const at = elevationHoverMarker.getLatLng();
                return { key: `h:${at.lat.toFixed(5)}:${at.lng.toFixed(5)}`, lat: at.lat, lon: at.lng };
            }
            if (mapClickFocus) return mapClickFocus;
            if (typeof activeVertexSelection !== 'undefined' && activeVertexSelection?.track) {
                const { track, vertexIndex } = activeVertexSelection;
                const node = track.latlngs?.[vertexIndex];
                if (node) {
                    return { key: `v:${project.tracks.indexOf(track)}:${vertexIndex}`, lat: node[0], lon: node[1] };
                }
            }
            if (typeof freshVertex !== 'undefined' && freshVertex) {
                const track = project.tracks.find((t) => t.id === freshVertex.trackId);
                const node = track?.latlngs?.[freshVertex.vertexIndex];
                if (node) {
                    return { key: `f:${freshVertex.trackId}:${freshVertex.vertexIndex}`, lat: node[0], lon: node[1] };
                }
            }
            if (typeof selectedObject !== 'undefined' && selectedObject?.type === 'station'
                && selectedObject.ref?.latlng) {
                const [lat, lon] = selectedObject.ref.latlng;
                return { key: `s:${selectedObject.id}`, lat, lon };
            }
        } catch { /* editor state mid-mutation — try again next tick */ }
        return null;
    }

    // Whether the preview has anything to point at: a track or station is
    // selected for editing. The button follows this.
    function editingContextExists() {
        return typeof selectedObject !== 'undefined' && !!selectedObject
            && (selectedObject.type === 'track' || selectedObject.type === 'station')
            && typeof project === 'object' && project?.tracks?.length > 0;
    }

    // The cheap per-tick half: notice what is being pointed at, and queue the
    // heavy sync for a quiet moment. Never does serialization work itself.
    function tick() {
        const pointed = pointedFocus();
        if (pointed && pointed.key !== lastFocusKey && pointed.key !== pendingFocus?.key) {
            scheduleFocus(pointed);
        }
        if (syncQueued || performance.now() - lastPointerAt < SYNC_QUIET_MS) return;
        syncQueued = true;
        const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 60));
        idle(() => { syncQueued = false; syncProject(false); }, { timeout: 700 });
    }

    // The heavy half: serialize the working project, ship it if it changed,
    // and locate the edit for the fallback focus. Runs idle-time only.
    function syncProject(initial) {
        const payload = workingPayload();
        if (!payload) return;
        const serialized = JSON.stringify(payload.project_data);
        const changed = serialized !== lastSerialized;
        if (initial || changed) {
            send({ type: 'reljef:project', payload });
        }
        if (changed && !initial && !pendingFocus) {
            const edited = findEditedNode(lastTracks, payload.project_data.tracks);
            if (edited) {
                scheduleFocus({ key: '', lat: edited.lat, lon: edited.lon });
            }
        } else if (initial) {
            const pointed = pointedFocus();
            if (pointed) {
                scheduleFocus(pointed);
            } else {
                const tracks = payload.project_data.tracks;
                const latlngs = tracks[tracks.length - 1]?.latlngs || [];
                const last = latlngs[latlngs.length - 1];
                if (last) scheduleFocus({ key: '', lat: last[0], lon: last[1] });
            }
        }
        if (changed || initial) {
            lastSerialized = serialized;
            lastTracks = payload.project_data.tracks;
        }
    }

    function onMessage(event) {
        if (event.origin !== viewerOrigin || event.source !== iframe?.contentWindow) return;
        if (event.data?.type === 'reljef:ready') {
            viewerReady = true;
            syncProject(true);
        }
    }

    function close() {
        clearInterval(pollTimer);
        pollTimer = null;
        clearTimeout(focusTimer);
        pendingFocus = null;
        window.removeEventListener('pointermove', notePointer, { capture: true });
        window.removeEventListener('pointerdown', notePointer, { capture: true });
        window.removeEventListener('message', onMessage);
        try { map.off('click', onMapClick); } catch { /* map already gone */ }
        mapClickFocus = null;
        // Removing the iframe is what actually frees the embedded WebGL
        // context and its GPU memory; hiding it would keep both.
        panel?.remove();
        panel = null;
        iframe = null;
        viewerReady = false;
        lastSerialized = '';
        lastTracks = null;
        lastFocusKey = '';
    }

    // Dragging by the header, so the panel goes wherever it is least in the
    // way — it deliberately has no backdrop and takes no focus.
    function makeDraggable(handle, box) {
        let start = null;
        handle.addEventListener('pointerdown', (event) => {
            if (event.target.closest('.relief-preview-close')) return;
            start = { x: event.clientX, y: event.clientY, rect: box.getBoundingClientRect() };
            handle.setPointerCapture(event.pointerId);
        });
        handle.addEventListener('pointermove', (event) => {
            if (!start) return;
            box.style.left = `${start.rect.left + event.clientX - start.x}px`;
            box.style.top = `${start.rect.top + event.clientY - start.y}px`;
            box.style.right = 'auto';
        });
        handle.addEventListener('pointerup', () => { start = null; });
    }

    function open() {
        if (panel) return;
        const url = reliefEmbedUrl();
        viewerOrigin = new URL(url, window.location.href).origin;
        panel = document.createElement('div');
        panel.className = 'relief-preview-panel';
        panel.innerHTML = `
            <div class="relief-preview-header">
                <h3>3D pregled</h3>
                <button type="button" class="relief-preview-close" aria-label="Zatvori">×</button>
            </div>
            <iframe class="relief-preview-iframe" title="3D reljef trase" allow="fullscreen"></iframe>`;
        iframe = panel.querySelector('iframe');
        iframe.src = url;
        panel.querySelector('.relief-preview-close').addEventListener('click', () => { closedByUser = true; close(); });
        makeDraggable(panel.querySelector('.relief-preview-header'), panel);
        window.addEventListener('message', onMessage);
        try { map.on('click', onMapClick); } catch { /* map not up yet */ }
        document.body.appendChild(panel);
        window.addEventListener('pointermove', notePointer, { capture: true, passive: true });
        window.addEventListener('pointerdown', notePointer, { capture: true, passive: true });
        pollTimer = setInterval(tick, POLL_STATE_MS);
    }

    // The panel follows the STRIPE's lifecycle: it opens when the elevation
    // dock appears, its × closes it (and is remembered until the dock goes
    // away), and the dock's own button brings it back.
    let closedByUser = false;

    function wireButton() {
        const button = document.getElementById('openReliefPreview');
        if (button) {
            button.addEventListener('click', () => { closedByUser = false; open(); });
        }
        setInterval(() => {
            const dock = document.getElementById('elevationDock');
            const dockVisible = !!dock && !dock.classList.contains('hidden');
            if (dockVisible && !panel && !closedByUser) open();
            if (!dockVisible) {
                closedByUser = false;
                if (panel) close();
            }
        }, 800);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wireButton);
    } else {
        wireButton();
    }

    return api;
}));
