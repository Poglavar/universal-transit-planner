// Zagreb railway object viewer (objekti.html): tabbed lists over configured
// tunnel-comparison and railway-reference datasets with a shared map. List
// rows and map features select each other. The upper map can show configured
// reconstructed routes; the lower pane shows terrain and, when a deployment
// supplies it, an orthophoto provider. Pure rendering — dataset production and
// provider authorization stay outside this open-source city-pack page.
(function () {
    'use strict';

    // ---------------------------------------------------------------- maps --
    const map = L.map('objMap', { preferCanvas: true }).setView([45.2, 16.2], 7);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);

    const APP_CONFIG = window.__TRANSIT_RUNTIME_CONFIG__ || {};
    const OBJECT_BROWSER_CONFIG = APP_CONFIG.city?.objectBrowser || {};

    // Optional lower pane: an orthophoto provider on the Croatian EPSG:3765
    // WMTS grid. Provider URLs and credentials are deployment configuration,
    // never defaults in the open-source city pack.
    // fractional zoom (zoomSnap 0) so its scale can match the main map's
    // ground resolution exactly. Zooming either map drives the other; the
    // pair always settles on an integer OSM zoom with the ortho at the
    // matching fractional DOF zoom.
    const DOF_RESOLUTIONS = [1400, 700, 280, 140, 70, 28, 14, 7, 2.8, 1.4, 0.7, 0.28, 0.14];
    const dofCrs = new L.Proj.CRS('EPSG:3765',
        '+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 '
        + '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
        { origin: [-203224.0, 5429184.0], resolutions: DOF_RESOLUTIONS });
    // Leaflet's own wheel zoom is off: with zoomSnap 0 it moves fractions of
    // a level that the reverse sync below rubber-bands straight back (flicker,
    // no net zoom). A custom handler further down steps whole levels instead.
    const orthoMap = L.map('orthoMap', { crs: dofCrs, zoomSnap: 0, scrollWheelZoom: false });
    // The DOF WMTS grid is NOT a single-origin pyramid: levels 5+ declare a
    // TopLeftCorner 7.2–8.5 km SOUTH of the common one (per GetCapabilities),
    // each an integer number of rows on the common grid (residuals sub-pixel).
    // Leaflet's CRS has one origin, so the tile layer subtracts the per-level
    // row offset — without this the imagery lands ~8 km south of the truth at
    // every zoom above 4.
    const DOF_ROW_OFFSETS = [0, 0, 0, 0, 0, 1, 2, 4, 11, 23, 47, 119, 238];
    const DofTileLayer = L.TileLayer.extend({
        getTileUrl(coords) {
            const shifted = new L.Point(coords.x, coords.y - DOF_ROW_OFFSETS[coords.z]);
            shifted.z = coords.z;
            return L.TileLayer.prototype.getTileUrl.call(this, shifted);
        },
    });
    // All DOF vintages share this exact grid (verified in GetCapabilities).
    // Only 2017/18 and 2019/20 cover the whole country; later cycles fly half
    // of it (east/west alternating) and serve WHITE tiles outside coverage —
    // which is why they can't be stacked and are offered as a choice instead.
    const DOF_VINTAGES = Array.isArray(OBJECT_BROWSER_CONFIG.orthophoto?.vintages)
        ? OBJECT_BROWSER_CONFIG.orthophoto.vintages : [];
    const DEFAULT_VINTAGE = Math.max(0, Math.min(
        DOF_VINTAGES.length - 1,
        Number(OBJECT_BROWSER_CONFIG.orthophoto?.defaultVintage) || 0,
    ));
    const hasOrthophoto = DOF_VINTAGES.length > 0;
    let dofLayer = null;
    function setDofVintage(index) {
        const vintage = DOF_VINTAGES[index];
        if (dofLayer) orthoMap.removeLayer(dofLayer);
        dofLayer = new DofTileLayer(vintage.url, {
            minZoom: 0, maxZoom: DOF_RESOLUTIONS.length - 1,
            attribution: vintage.attribution || vintage.label,
        }).addTo(orthoMap);
    }
    const vintageSelect = document.getElementById('dofVintage');
    DOF_VINTAGES.forEach((vintage, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = vintage.label;
        if (index === DEFAULT_VINTAGE) option.selected = true;
        vintageSelect.append(option);
    });
    vintageSelect.addEventListener('change', () => setDofVintage(Number(vintageSelect.value)));
    if (hasOrthophoto) setDofVintage(DEFAULT_VINTAGE);

    // Alternative lower-pane view: DGU relief exactly as the /prijevoz map
    // draws it — the API's hypsometric terrain tiles at 0.72 opacity over the
    // OSM basemap. Those tiles are EPSG:3857, so the relief lives in its own
    // stacked follower map and the toggle switches which one is visible.
    const TERRAIN_API = window.TerrainMapLayer;
    const reliefMap = L.map('reliefMap').setView([45.2, 16.2], 7);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(reliefMap);
    if (TERRAIN_API) {
        L.tileLayer(TERRAIN_API.tileUrlTemplate(APP_CONFIG.apiBaseUrl, TERRAIN_API.DEFAULT_SOURCE), {
            ...TERRAIN_API.TILE_REQUEST_OPTIONS,
            opacity: 0.72,
            minZoom: 8,
            maxNativeZoom: 17,
            maxZoom: 19,
            crossOrigin: true,
            attribution: 'Visine &copy; DGU',
        }).addTo(reliefMap);
    }

    // EPSG:3857 ground resolution (m/px) at a latitude for a given zoom.
    const EQUATOR_RESOLUTION = 156543.03392804097;
    function osmResolution(zoom, lat) {
        return EQUATOR_RESOLUTION * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
    }
    // Ask the CRS itself for the fractional zoom at a resolution, so the
    // interpolation is exactly the one Leaflet renders with.
    function dofZoomForResolution(resolution) {
        const zoom = dofCrs.zoom(1 / resolution);
        if (!Number.isFinite(zoom)) return zoom > 0 ? DOF_RESOLUTIONS.length - 1 : 0;
        return Math.max(0, Math.min(DOF_RESOLUTIONS.length - 1, zoom));
    }

    // Sync rules: live-follow while the main map pans, but during an animated
    // zoom wait for zoomend — a hard ortho zoom reset per animation frame can
    // wedge the main map's own zoom animation. The reverse direction settles
    // on moveend. The lock stops synchronous ping-pong between the two maps.
    let syncingMaps = false;
    function withSyncLock(fn) {
        if (syncingMaps) return;
        syncingMaps = true;
        try { fn(); } finally { syncingMaps = false; }
    }
    function syncOrthoToMain() {
        withSyncLock(() => {
            const center = map.getCenter();
            const resolution = osmResolution(map.getZoom(), center.lat);
            const zoom = dofZoomForResolution(resolution);
            if (Math.abs(zoom - orthoMap.getZoom()) < 0.001
                && orthoMap.getCenter().distanceTo(center) < resolution) return;
            orthoMap.setView(center, zoom, { animate: false });
        });
    }
    // Only the visible lower map follows; the hidden one catches up on toggle.
    let lowerView = hasOrthophoto ? 'ortho' : 'relief';
    if (!hasOrthophoto) {
        document.querySelector('[data-lower="ortho"]')?.setAttribute('hidden', '');
        document.querySelector('[data-lower="relief"]')?.classList.add('is-active');
        document.getElementById('orthoMap').hidden = true;
        document.getElementById('reliefMap').hidden = false;
        document.getElementById('dofVintage').hidden = true;
    }
    function syncReliefToMain() {
        withSyncLock(() => {
            const center = map.getCenter();
            const zoom = map.getZoom();
            if (zoom === reliefMap.getZoom()
                && reliefMap.getCenter().distanceTo(center) < osmResolution(zoom, center.lat)) return;
            reliefMap.setView(center, zoom, { animate: false });
        });
    }
    function syncLowerToMain() {
        if (lowerView === 'ortho') syncOrthoToMain();
        else syncReliefToMain();
    }
    let mainZoomAnimating = false;
    map.on('zoomstart', () => { mainZoomAnimating = true; });
    map.on('zoomend', () => { mainZoomAnimating = false; syncLowerToMain(); });
    map.on('move', () => { if (!mainZoomAnimating) syncLowerToMain(); });
    map.on('moveend', syncLowerToMain);
    // Panning or zooming the ortho pane drives the main map: its resolution
    // maps to the nearest integer OSM zoom, then the ortho snaps to that
    // zoom's exact fractional match so the panes stay identical.
    orthoMap.on('moveend', () => {
        if (lowerView !== 'ortho') return; // hidden follower must never drive
        withSyncLock(() => {
            const center = orthoMap.getCenter();
            const orthoResolution = 1 / dofCrs.scale(orthoMap.getZoom());
            const wanted = Math.round(Math.log2(
                EQUATOR_RESOLUTION * Math.cos(center.lat * Math.PI / 180) / orthoResolution));
            const zoom = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), wanted));
            if (zoom !== map.getZoom()
                || map.getCenter().distanceTo(center) >= osmResolution(zoom, center.lat)) {
                map.setView(center, zoom, { animate: false });
            }
            // Always restore the exact pairing — a zoom too small to move the
            // main map a whole level rubber-bands back to the matched scale.
            const matched = dofZoomForResolution(osmResolution(zoom, center.lat));
            if (Math.abs(matched - orthoMap.getZoom()) > 0.001) {
                orthoMap.setView(center, matched, { animate: false });
            }
        });
    });
    // The relief map shares the main map's CRS and integer zooms, so its
    // reverse sync is a plain view copy.
    reliefMap.on('moveend', () => {
        if (lowerView !== 'relief') return; // hidden follower must never drive
        withSyncLock(() => {
            const center = reliefMap.getCenter();
            const zoom = Math.round(reliefMap.getZoom());
            if (zoom === map.getZoom()
                && map.getCenter().distanceTo(center) < osmResolution(zoom, center.lat)) return;
            map.setView(center, zoom, { animate: false });
        });
    });

    // Trackpad/wheel zoom on the ortho pane. Each fractional wheel step the
    // stock handler produced rounded to the SAME integer OSM zoom, so the
    // reverse sync above undid it immediately. Accumulated wheel travel
    // instead steps the pair one whole OSM level around the cursor — the same
    // stepping the upper map's wheel zoom has.
    const orthoWheelStepper = window.__orthoPaneZoom.createWheelStepper();
    orthoMap.getContainer().addEventListener('wheel', event => {
        event.preventDefault(); // the pane must never scroll the page
        // Firefox line-mode wheels report lines, not pixels.
        const deltaY = event.deltaMode === 1 ? event.deltaY * 20 : event.deltaY;
        const step = orthoWheelStepper.push(event.timeStamp, deltaY);
        if (!step) return;
        const zoom = Math.max(map.getMinZoom(),
            Math.min(map.getMaxZoom(), map.getZoom() + step));
        if (zoom === map.getZoom()) return;
        // Put the ortho at the fractional level matching the target OSM zoom,
        // keeping the point under the cursor fixed; its moveend reverse-sync
        // then drags the main map to that integer zoom.
        const matched = dofZoomForResolution(osmResolution(zoom, orthoMap.getCenter().lat));
        orthoMap.setZoomAround(orthoMap.mouseEventToContainerPoint(event), matched,
            { animate: false });
    }, { passive: false });

    function setLowerView(view) {
        if (view === lowerView) return;
        lowerView = view;
        for (const button of document.querySelectorAll('#lowerViewToggle button')) {
            button.classList.toggle('is-active', button.dataset.lower === view);
        }
        document.getElementById('orthoMap').hidden = view !== 'ortho';
        document.getElementById('reliefMap').hidden = view !== 'relief';
        document.getElementById('dofVintage').hidden = view !== 'ortho';
        const shown = view === 'ortho' ? orthoMap : reliefMap;
        // invalidateSize can fire moveend — keep it under the lock so the
        // newly shown map's stale view cannot reverse-sync the main map.
        withSyncLock(() => shown.invalidateSize({ animate: false }));
        syncLowerToMain();
    }
    document.getElementById('lowerViewToggle').addEventListener('click', event => {
        const button = event.target.closest('button[data-lower]');
        if (button) setLowerView(button.dataset.lower);
    });

    // Upper map: a background click offers the /prijevoz 3D walk at that
    // point (transit.html lives in the same directory here and on prod).
    // elevation=1 is the walk world's explicit terrain opt-in: the DGU 20 m
    // grid covers the whole country, so even a spawn outside every prepared
    // area stands on real relief instead of the flat plane.
    map.on('click', event => {
        if (performance.now() < suppressWalkPopupUntil) return;
        const link = document.createElement('a');
        link.href = 'transit.html?st3d=walk&elevation=1'
            + `&lat=${event.latlng.lat.toFixed(6)}&lon=${event.latlng.lng.toFixed(6)}`;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'Šetnja (3D)';
        const wrap = document.createElement('div');
        wrap.className = 'walk-link-popup';
        wrap.append(link);
        L.popup().setLatLng(event.latlng).setContent(wrap).openOn(map);
    });

    // Relief map: a click reads the DGU elevation at that point — same API
    // and presentation as the /prijevoz readout.
    let elevationRequestId = 0;
    reliefMap.on('click', async event => {
        if (!TERRAIN_API) return;
        const requestId = ++elevationRequestId;
        const popup = L.popup().setLatLng(event.latlng)
            .setContent('<div class="elevation-popup">Visina…</div>').openOn(reliefMap);
        try {
            const response = await fetch(TERRAIN_API.elevationUrl(
                APP_CONFIG.apiBaseUrl, event.latlng.lat, event.latlng.lng,
                TERRAIN_API.DEFAULT_SOURCE));
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const presentation = TERRAIN_API.elevationPresentation(await response.json());
            if (requestId !== elevationRequestId) return; // superseded by a newer click
            const div = document.createElement('div');
            div.className = 'elevation-popup';
            div.title = presentation.title;
            const value = document.createElement('strong');
            value.textContent = presentation.valueText;
            const meta = document.createElement('span');
            meta.className = 'elevation-meta';
            meta.textContent = presentation.metaText;
            div.append(value, ' ', meta);
            popup.setContent(div);
        } catch (error) {
            if (requestId !== elevationRequestId) return;
            popup.setContent('<div class="elevation-popup">Visina nedostupna</div>');
            console.warn(`[${new Date().toISOString()}] elevacija: ${error.message}`);
        }
    });

    syncLowerToMain();
    // Debug handle for probing view sync from the console.
    window.__objektiMaps = { map, orthoMap, reliefMap };

    // -------------------------------------------------------- tab plumbing --
    // tab -> { name, group, items, selected, ids }; selection is per tab.
    // Every list item registers a stable id so it can be deep-linked as
    // #<tab>/<encodeURIComponent(id)> — selection keeps the address bar in
    // sync (replaceState), and the hash is applied back on load/hashchange.
    const tabs = {};
    for (const name of ['tuneli', 'pruge', 'stanice', 'zcpr', 'tablice']) {
        tabs[name] = { name, group: L.layerGroup(), items: [], selected: null, ids: new Map() };
    }

    // The source data contains a few literally duplicated entries (same id
    // twice) — the second occurrence gets a "~2" suffix so ids stay unique.
    function registerItem(tab, item, id) {
        let unique = id;
        for (let n = 2; tab.ids.has(unique); n++) unique = `${id}~${n}`;
        item.id = unique;
        tab.ids.set(unique, item);
    }
    let activeTab = 'tuneli';
    let mapView = 'data';
    const summaries = {};
    const metas = {};
    tabs.tuneli.group.addTo(map);

    const legend = L.control({ position: 'bottomleft' });
    legend.onAdd = () => {
        const div = L.DomUtil.create('div', 'map-legend');
        div.innerHTML = '<span class="legend-osm"></span> OSM (boja = pouzdanost)'
            + '<br><span class="legend-popis"></span> popis (uz prugu)';
        return div;
    };
    function syncLegend() {
        legend.remove();
        if (mapView === 'data' && activeTab === 'tuneli') legend.addTo(map);
    }
    syncLegend();

    function updateHeader() {
        document.getElementById('objSummary').textContent = summaries[activeTab] || '';
        document.getElementById('objMeta').textContent = metas[activeTab] || '';
        document.getElementById('tunnelsFilters').hidden = activeTab !== 'tuneli';
    }

    function clearSelection(tab) {
        if (!tab.selected) return;
        tab.selected.tr.classList.remove('is-selected');
        tab.selected.restoreStyle?.();
        tab.selected = null;
    }

    // Feature clicks bubble to the map click handler below — selection stamps
    // a short suppression window so the walk popup only opens on background
    // clicks.
    let suppressWalkPopupUntil = 0;

    function selectItem(tab, item, { scrollList = false, zoom = true, updateHash = true } = {}) {
        suppressWalkPopupUntil = performance.now() + 150;
        clearSelection(tab);
        tab.selected = item;
        item.tr.classList.add('is-selected');
        if (scrollList) item.tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
        item.highlight?.();
        if (zoom && item.zoomTo) item.zoomTo();
        item.openPopup?.();
        if (updateHash && item.id) {
            history.replaceState(null, '', `#${tab.name}/${encodeURIComponent(item.id)}`);
        }
    }

    function badge(text, color, title) {
        const span = document.createElement('span');
        span.className = 'badge';
        span.textContent = text;
        if (color) span.style.background = color;
        if (title) span.title = title;
        return span;
    }

    function cell(tr, content, className) {
        const td = document.createElement('td');
        if (className) td.className = className;
        if (content instanceof Node) td.append(content);
        else if (content !== null && content !== undefined) td.textContent = content;
        tr.append(td);
        return td;
    }

    // ------------------------------------------------- tab: tuneli vs OSM --
    const CONFIDENCE_LABELS = { high: 'visoka', medium: 'srednja', low: 'niska' };
    const POPIS_COLOR = '#e53935';
    const tunnelState = { data: null, filter: 'all' };

    function statusOf(row) {
        return row.matched ? row.confidence : 'missing';
    }

    function statusColor(status) {
        return {
            high: '#2e7d32', medium: '#f9a825', low: '#e65100',
            missing: '#c62828', extra: '#607d8b',
        }[status] || '#607d8b';
    }

    function lengthDiffBad(row) {
        return row.lengthDiffM !== null
            && Math.abs(row.lengthDiffM) > Math.max(15, 0.1 * (row.lengthM || 0));
    }

    function isDifference(row) {
        return !row.matched || row.confidence === 'low' || lengthDiffBad(row)
            || (row.stacDiffKm !== null && Math.abs(row.stacDiffKm) > 0.5);
    }

    function wayLinks(cellEl, wayIds) {
        (wayIds || []).forEach((id, index) => {
            if (index) cellEl.append(' ');
            const link = document.createElement('a');
            link.href = `https://www.openstreetmap.org/way/${id}`;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = id;
            link.addEventListener('click', event => event.stopPropagation());
            cellEl.append(link);
        });
    }

    function formatKm(km) {
        return km === null || km === undefined ? '' : km.toFixed(3);
    }

    function popupHtml(item) {
        const row = item.row;
        const escape = value => String(value).replace(/[&<>"']/g,
            c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const lines = [`<strong>${escape(row.name || row.osmName || '(bez imena)')}</strong> · ${escape(row.line)}`];
        if (item.kind === 'row') {
            lines.push(`Popis: ${row.lengthM} m` + (row.stacAKm !== null ? ` na km ${formatKm(row.stacAKm)}` : ''));
        }
        if (row.osmLengthM) {
            lines.push(`OSM: ${escape(row.osmName || '(bez imena)')}, ${row.osmLengthM} m`
                + (row.osmStacKm !== null && row.osmStacKm !== undefined ? ` na km ${formatKm(row.osmStacKm)}` : ''));
        }
        if (row.lengthDiffM !== null && row.lengthDiffM !== undefined) {
            lines.push(`Δduljina: ${row.lengthDiffM > 0 ? '+' : ''}${row.lengthDiffM} m`);
        }
        return lines.join('<br>');
    }

    function addTunnelMapItem(item) {
        const tab = tabs.tuneli;
        const geometry = tunnelState.data.tunnelGeometry[item.row.chainIndex];
        const popis = item.row.popisGeometry;
        if (!geometry && !popis) return;
        const select = () => selectItem(tab, item, { scrollList: true, zoom: false });
        const color = statusColor(item.status);
        if (geometry) {
            item.polyline = L.polyline(geometry.map(c => [c[1], c[0]]),
                { color, weight: 6, opacity: 0.9 }).addTo(tab.group);
            item.polyline.on('click', select);
        }
        if (popis) {
            item.popisLine = L.polyline(popis.map(c => [c[1], c[0]]), {
                color: POPIS_COLOR, weight: 4, opacity: 0.9,
            }).addTo(tab.group);
            item.popisLine.on('click', select);
        }
        // One marker per tunnel: on the OSM chain when it exists, else on the
        // red popis segment so missing tunnels stay clickable on the map.
        const markerSource = geometry || popis;
        const latlngs = markerSource.map(c => [c[1], c[0]]);
        item.marker = L.circleMarker(latlngs[Math.floor(latlngs.length / 2)], {
            radius: 6, color: '#fff', weight: 1.5, fillColor: color, fillOpacity: 0.95,
        }).addTo(tab.group);
        item.marker.on('click', select);
        item.marker.bindTooltip(`${item.row.name || item.row.osmName || '?'} (${item.row.line})`);
        item.highlight = () => {
            if (item.polyline) {
                item.polyline.setStyle({ weight: 10, color: '#1565c0' });
                item.polyline.bringToFront();
            }
            if (item.popisLine) {
                item.popisLine.setStyle({ weight: 7 });
                item.popisLine.bringToFront();
            }
        };
        item.restoreStyle = () => {
            if (item.polyline) item.polyline.setStyle({ weight: 6, color });
            if (item.popisLine) item.popisLine.setStyle({ weight: 4 });
        };
        item.bounds = () => {
            let bounds = null;
            for (const layer of [item.polyline, item.popisLine]) {
                if (!layer) continue;
                bounds = bounds ? bounds.extend(layer.getBounds()) : layer.getBounds();
            }
            return bounds;
        };
        item.openPopup = () => {
            if (item.bounds()) item.marker.bindPopup(popupHtml(item)).openPopup();
        };
    }

    function tunnelZoomTo(item) {
        const bounds = item.bounds ? item.bounds() : null;
        if (bounds) {
            map.fitBounds(bounds.pad(0.6), { maxZoom: 15 });
        } else {
            // Nothing to draw: show the line so the reported chainage area is visible.
            const line = tunnelState.data.lineGeometry[item.row.line];
            if (line) map.fitBounds(L.latLngBounds(line.map(c => [c[1], c[0]])));
        }
    }

    function rowVisible(item) {
        if (item.kind !== 'row') return true;
        if (tunnelState.filter === 'diff') return isDifference(item.row);
        if (tunnelState.filter === 'missing') return !item.row.matched;
        return true;
    }

    function applyFilter() {
        for (const item of tabs.tuneli.items) {
            if (item.kind === 'row') item.tr.hidden = !rowVisible(item);
        }
    }

    function buildTunnelRow(row) {
        const status = statusOf(row);
        const tr = document.createElement('tr');
        if (!row.matched) tr.classList.add('is-missing');
        cell(tr, row.line).title = row.lineName;
        const nameCell = cell(tr, row.name);
        if (row.note) {
            nameCell.title = row.note;
            nameCell.textContent += ' *';
        }
        cell(tr, formatKm(row.stacAKm), 'num');
        cell(tr, row.lengthM, 'num');
        wayLinks(cell(tr, null), row.osmWayIds);
        cell(tr, formatKm(row.osmStacKm), 'num');
        cell(tr, row.osmLengthM, 'num');
        const deltaCell = cell(tr, null, 'num');
        if (row.lengthDiffM !== null && row.lengthDiffM !== undefined) {
            const span = document.createElement('span');
            span.textContent = `${row.lengthDiffM > 0 ? '+' : ''}${row.lengthDiffM}`;
            if (lengthDiffBad(row)) span.className = 'delta-bad';
            deltaCell.append(span);
        }
        const confidence = document.createElement('span');
        confidence.className = `confidence ${status}`;
        confidence.textContent = row.matched ? CONFIDENCE_LABELS[row.confidence] : 'nema u OSM';
        if (row.signals) {
            confidence.title = `ime ${row.signals.name} · duljina ${row.signals.length} · `
                + `pozicija ${row.signals.position} (${row.signals.positionBasis || '—'})`;
        }
        cell(tr, confidence);
        return { tr, status };
    }

    function buildExtraRow(extra) {
        const tr = document.createElement('tr');
        cell(tr, extra.line);
        cell(tr, extra.osmName || '(bez imena)');
        wayLinks(cell(tr, null), extra.osmWayIds);
        cell(tr, formatKm(extra.osmStacKm), 'num');
        cell(tr, extra.osmLengthM, 'num');
        cell(tr, extra.osmRailway);
        return tr;
    }

    function renderTunnels(data) {
        tunnelState.data = data;
        const tab = tabs.tuneli;
        const summary = data.summary;
        summaries.tuneli = `${summary.matched}/${summary.csvRows} pronađeno u OSM-u `
            + `(visoka ${summary.byConfidence.high}, srednja ${summary.byConfidence.medium}, `
            + `niska ${summary.byConfidence.low}), ${summary.missing} nema`;
        metas.tuneli = `Izvor: ${data.source.csv} + OSM snimka ${data.source.osm} `
            + `(${(data.source.osmSnapshotDate || '').slice(0, 10)}), izračun ${data.generatedAt.slice(0, 10)}. `
            + '* = redak ima napomenu u izvorniku.';

        for (const [ref, coordinates] of Object.entries(data.lineGeometry)) {
            L.polyline(coordinates.map(c => [c[1], c[0]]), {
                color: '#78909c', weight: 2, opacity: 0.8, interactive: false,
            }).addTo(tab.group).bindTooltip(ref);
        }

        const body = document.getElementById('tunnelsBody');
        for (const row of data.rows) {
            const { tr, status } = buildTunnelRow(row);
            const item = { kind: 'row', row, tr, status };
            item.zoomTo = () => tunnelZoomTo(item);
            registerItem(tab, item, `${row.line} ${row.name}`);
            tr.addEventListener('click', () => selectItem(tab, item));
            body.append(tr);
            tab.items.push(item);
            addTunnelMapItem(item);
        }

        const extrasBody = document.getElementById('extrasBody');
        document.getElementById('extrasCount').textContent = data.extras.length;
        for (const extra of data.extras) {
            const tr = buildExtraRow(extra);
            const item = {
                kind: 'extra', status: 'extra', tr,
                row: { ...extra, name: extra.osmName, matched: true },
            };
            item.zoomTo = () => tunnelZoomTo(item);
            registerItem(tab, item, `extra ${(extra.osmWayIds || [])[0] || extra.osmName}`);
            tr.addEventListener('click', () => selectItem(tab, item));
            extrasBody.append(tr);
            tab.items.push(item);
            addTunnelMapItem(item);
        }
        updateHeader();
        tryApplyHash();
    }

    document.getElementById('tunnelsFilters').addEventListener('click', event => {
        const button = event.target.closest('button[data-filter]');
        if (!button) return;
        tunnelState.filter = button.dataset.filter;
        for (const other of button.parentElement.querySelectorAll('button')) {
            other.classList.toggle('is-active', other === button);
        }
        applyFilter();
    });

    // --------------------------------------- tabs: HŽ reference (repozdrav) --
    const CATEGORY_COLORS = {
        'Magistralne': '#1565c0',
        'Zagrebački čvor': '#6a1b9a',
        'Regionalne': '#2e7d32',
        'Lokalne': '#e65100',
    };
    const STATION_TYPE_COLORS = {
        K: '#1565c0', S: '#43a047', R: '#6a1b9a', DG: '#c62828',
        O: '#00838f', X: '#757575',
    };
    const STATION_TYPE_TITLES = {
        K: 'kolodvor', S: 'stajalište', R: 'rasputnica', DG: 'državna granica',
        O: 'otpremništvo', X: 'izvan uporabe?',
    };
    const ZCPR_COLOR = '#c62828';
    const SELECT_COLOR = '#f59e0b';

    function pointItem(tab, row, latlng, color, zoomLevel, tooltip) {
        const marker = L.circleMarker(latlng, {
            radius: 5, color: '#fff', weight: 1, fillColor: color, fillOpacity: 0.9,
        }).addTo(tab.group);
        if (tooltip) marker.bindTooltip(tooltip);
        const item = {
            row,
            marker,
            highlight() { marker.setStyle({ radius: 8, color: SELECT_COLOR, weight: 3 }); },
            restoreStyle() { marker.setStyle({ radius: 5, color: '#fff', weight: 1 }); },
            zoomTo() { map.setView(latlng, Math.max(map.getZoom(), zoomLevel)); },
        };
        marker.on('click', () => selectItem(tab, item, { scrollList: true, zoom: false }));
        return item;
    }

    function buildPruge(data) {
        const tab = tabs.pruge;
        const body = document.getElementById('body-pruge');
        for (const line of data.pruge) {
            const color = CATEGORY_COLORS[line.category] || '#455a64';
            const polyline = L.polyline(line.latlngs, {
                color, weight: 3, opacity: 0.85,
            }).addTo(tab.group).bindTooltip(`${line.code} ${line.title}`);
            const tr = document.createElement('tr');
            cell(tr, badge(line.category, color));
            cell(tr, line.code);
            cell(tr, line.title);
            cell(tr, line.lengthKm.toFixed(1), 'num');
            const item = {
                row: line,
                tr,
                highlight() { polyline.setStyle({ weight: 7, color: SELECT_COLOR }); polyline.bringToFront(); },
                restoreStyle() { polyline.setStyle({ weight: 3, color }); },
                zoomTo() { map.fitBounds(polyline.getBounds().pad(0.15)); },
            };
            registerItem(tab, item, line.code);
            polyline.on('click', () => selectItem(tab, item, { scrollList: true, zoom: false }));
            tr.addEventListener('click', () => selectItem(tab, item));
            body.append(tr);
            tab.items.push(item);
        }
    }

    function buildStanice(data) {
        const tab = tabs.stanice;
        const body = document.getElementById('body-stanice');
        for (const station of data.stanice) {
            const type = station.type || '';
            const color = STATION_TYPE_COLORS[type.split('/')[0]] || '#757575';
            const name = (station.subline ? `${station.subline} ` : '') + station.name;
            const item = pointItem(tab, station, [station.lat, station.lng], color, 14,
                `${name} (${station.line})`);
            const tr = document.createElement('tr');
            cell(tr, station.line).title = station.lineTitle;
            cell(tr, station.chain || '', 'num');
            cell(tr, name);
            cell(tr, type ? badge(type, color, STATION_TYPE_TITLES[type.split('/')[0]]) : null);
            registerItem(tab, item,
                [station.line, station.chain, name].filter(Boolean).join(' '));
            tr.addEventListener('click', () => selectItem(tab, item));
            item.tr = tr;
            body.append(tr);
            tab.items.push(item);
        }
    }

    function buildZcpr(data) {
        const tab = tabs.zcpr;
        const body = document.getElementById('body-zcpr');
        for (const crossing of data.zcpr) {
            const item = pointItem(tab, crossing, [crossing.lat, crossing.lng], ZCPR_COLOR, 15,
                `${crossing.name || crossing.key} (${crossing.line} ${crossing.chain})`);
            const tr = document.createElement('tr');
            cell(tr, crossing.line);
            cell(tr, crossing.chain, 'num');
            cell(tr, crossing.key || '—');
            cell(tr, crossing.name);
            registerItem(tab, item,
                crossing.key || `${crossing.line} ${crossing.chain}`);
            tr.addEventListener('click', () => selectItem(tab, item));
            item.tr = tr;
            body.append(tr);
            tab.items.push(item);
        }
    }

    function buildTablice(data) {
        const tab = tabs.tablice;
        const body = document.getElementById('body-tablice');
        const pointsByKey = new Map(data.zcpr.filter(c => c.key).map(c => [c.key, c]));
        const linesByCode = new Map(data.pruge.map(line => [line.code, line]));
        for (const row of data.tablice) {
            const point = row.key ? pointsByKey.get(row.key) : null;
            // Fallback: no geocoded point yet — fit the whole line (exact code
            // match, else its sub-lines, e.g. M604 -> M604-1..5).
            const lines = linesByCode.has(row.line)
                ? [linesByCode.get(row.line)]
                : data.pruge.filter(line => line.code.startsWith(`${row.line}-`));
            const item = point
                ? pointItem(tab, row, [point.lat, point.lng], ZCPR_COLOR, 15,
                    `${row.key} ${row.desc || ''} (${row.line} ${row.km})`)
                : {
                    row,
                    zoomTo: lines.length ? () => {
                        const bounds = lines.reduce((acc, line) => {
                            const b = L.latLngBounds(line.latlngs);
                            return acc ? acc.extend(b) : b;
                        }, null);
                        map.fitBounds(bounds.pad(0.1));
                    } : null,
                };
            const tr = document.createElement('tr');
            if (!point) tr.classList.add('no-location');
            cell(tr, row.key || row.rbr);
            cell(tr, row.line).title = row.lineName;
            cell(tr, row.km, 'num');
            cell(tr, row.road);
            cell(tr, row.county);
            cell(tr, row.municipality);
            cell(tr, row.protection);
            const descCell = cell(tr, row.desc);
            if (!point) descCell.title = 'Bez točke na karti — prikazuje cijelu prugu';
            registerItem(tab, item, row.key || `rbr ${row.rbr}`);
            tr.addEventListener('click', () => selectItem(tab, item));
            item.tr = tr;
            body.append(tr);
            tab.items.push(item);
        }
    }

    function renderRepo(data) {
        buildPruge(data);
        buildStanice(data);
        buildZcpr(data);
        buildTablice(data);
        const pointKeys = new Set(data.zcpr.filter(c => c.key).map(c => c.key));
        const matched = data.tablice.filter(row => pointKeys.has(row.key)).length;
        summaries.pruge = `${data.pruge.length} pruga`;
        summaries.stanice = `${data.stanice.length} stanica`;
        summaries.zcpr = `${data.zcpr.length} geokodiranih ŽCPR točaka`;
        summaries.tablice = `${data.tablice.length} redaka registra (${matched} s točkom na karti)`;
        const repoMeta = `Izvor: output/repozdrav/ (${Object.values(data.source).join(', ')}), `
            + `izračun ${data.generatedAt.slice(0, 10)}.`;
        for (const name of ['pruge', 'stanice', 'zcpr', 'tablice']) metas[name] = repoMeta;
        updateHeader();
        tryApplyHash();
    }

    // -------------------------------------------- Rekonstrukcija map view --
    // The reconstructed routes exactly as the /prijevoz 2D map draws them
    // (grey base track + display-regime coloured runs). Non-interactive by
    // design: no legend, no popups, just pan/zoom.
    const REGIME_MAP_COLORS = {
        tunnel: '#26262b',
        cut: '#8a6d3b',
        'at-grade': '#2e7dd1',
        fill: '#c9a227',
        viaduct: '#2e9e4f',
    };
    let routeGroup = null;
    let routeLoadPromise = null;

    function buildRouteGroup(runsData) {
        const group = L.layerGroup();
        for (const project of runsData.projects) {
            L.polyline(project.runs.map(run => run.latlngs), {
                color: '#6b7280', weight: 5, opacity: 0.7, interactive: false,
            }).addTo(group);
            for (const run of project.runs) {
                L.polyline(run.latlngs, {
                    color: REGIME_MAP_COLORS[run.regime] || REGIME_MAP_COLORS['at-grade'],
                    weight: 4, opacity: 1, lineCap: 'round', lineJoin: 'round',
                    interactive: false,
                }).addTo(group);
            }
        }
        return group;
    }

    function ensureRouteGroup() {
        if (!routeLoadPromise) {
            routeLoadPromise = fetch(OBJECT_BROWSER_CONFIG.datasets?.reconstructionRuns
                || 'json/rail-reconstruction-runs.json')
                .then(response => {
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    return response.json();
                })
                .then(runsData => {
                    routeGroup = buildRouteGroup(runsData);
                    return routeGroup;
                });
        }
        return routeLoadPromise;
    }

    // ------------------------------------------------- tab / view switching --
    function setMapView(view) {
        if (view === mapView) return;
        mapView = view;
        for (const button of document.querySelectorAll('#mapViewToggle button')) {
            button.classList.toggle('is-active', button.dataset.view === view);
        }
        if (view === 'route') {
            map.removeLayer(tabs[activeTab].group);
            map.closePopup();
            ensureRouteGroup()
                .then(group => { if (mapView === 'route') group.addTo(map); })
                .catch(error => {
                    console.error(`[${new Date().toISOString()}] rekonstrukcija: ${error.message}`);
                });
        } else {
            if (routeGroup) map.removeLayer(routeGroup);
            tabs[activeTab].group.addTo(map);
        }
        syncLegend();
    }

    document.getElementById('mapViewToggle').addEventListener('click', event => {
        const button = event.target.closest('button[data-view]');
        if (button) setMapView(button.dataset.view);
    });

    function setTab(name, { updateHash = true } = {}) {
        if (name !== activeTab) {
            document.getElementById(`panel-${activeTab}`).hidden = true;
            if (mapView === 'data') map.removeLayer(tabs[activeTab].group);
            activeTab = name;
            document.getElementById(`panel-${name}`).hidden = false;
            if (mapView === 'data') tabs[name].group.addTo(map);
            for (const button of document.querySelectorAll('#objTabs button')) {
                button.classList.toggle('is-active', button.dataset.tab === name);
            }
            map.closePopup();
            syncLegend();
            updateHeader();
        }
        if (updateHash) history.replaceState(null, '', `#${name}`);
    }

    document.getElementById('objTabs').addEventListener('click', event => {
        const button = event.target.closest('button[data-tab]');
        if (button) setTab(button.dataset.tab);
    });

    // ----------------------------------------------------------- deep links --
    // #<tab> opens a tab, #<tab>/<id> also selects and zooms to the item.
    // Returns false when the id is not registered yet (data still loading).
    function applyHash() {
        let raw;
        try {
            raw = decodeURIComponent(location.hash.slice(1));
        } catch {
            return true; // malformed percent-encoding — ignore the hash
        }
        if (!raw) return true;
        const slash = raw.indexOf('/');
        const tabName = slash < 0 ? raw : raw.slice(0, slash);
        if (!tabs[tabName]) return true;
        setTab(tabName, { updateHash: false });
        if (slash < 0) return true;
        const item = tabs[tabName].ids.get(raw.slice(slash + 1));
        if (!item) return false;
        selectItem(tabs[tabName], item, { scrollList: true, updateHash: false });
        return true;
    }
    let hashApplied = !location.hash;
    function tryApplyHash() {
        if (!hashApplied) hashApplied = applyHash();
    }
    window.addEventListener('hashchange', applyHash);

    // ------------------------------------------------------------- loading --
    function loadJson(url) {
        return fetch(url).then(response => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        });
    }

    loadJson(OBJECT_BROWSER_CONFIG.datasets?.tunnels || 'json/rail-tunnels-osm.json')
        .then(renderTunnels).catch(error => {
            summaries.tuneli = `Greška pri učitavanju podataka: ${error.message}`;
            updateHeader();
        });
    loadJson(OBJECT_BROWSER_CONFIG.datasets?.railwayObjects || 'json/repozdrav.json')
        .then(renderRepo).catch(error => {
            for (const name of ['pruge', 'stanice', 'zcpr', 'tablice']) {
                summaries[name] = `Greška pri učitavanju podataka: ${error.message}`;
            }
            updateHeader();
        });
})();
