(function () {
    const contentDiv = document.getElementById('content');
    const feedbackDiv = document.getElementById('feedback');
    const openPricesBtn = document.getElementById('openPrices');
    const backToPlannerLink = document.getElementById('backToPlannerLink');
    const pricesModal = document.getElementById('pricesModal');
    const pricesGrid = document.getElementById('pricesGrid');
    const resetPricesBtn = document.getElementById('resetPrices');
    const cancelPricesBtn = document.getElementById('cancelPrices');
    const savePricesBtn = document.getElementById('savePrices');

    const pricingApi = window.TransitPricing || null;
    const projectExportApi = window.__transitProjectExport || null;
    // Timestamp formatting/comparison lives in leaderboard-format.js so it is
    // unit-testable without a browser (see leaderboard-format.test.mjs).
    const {
        displayProjectName,
        leaderboardTabQueryValue,
        findProjectById,
        formatCreatedAt,
        normalizeLeaderboardTab,
        timestampValue,
    } = window.__leaderboardFormat;
    const i18n = window.__transitI18n;
    const UI_LOCALE = i18n?.locale || 'en';
    const isCroatian = i18n?.currentLanguage === 'hr';
    const ui = (english, croatian) => isCroatian ? croatian : english;
    const APP_CONFIG = window.__TRANSIT_RUNTIME_CONFIG__ || {};
    const TEST_CONFIG = window.__TRANSIT_TEST_CONFIG ?? window.__TRANSIT_TEST_CONFIG__ ?? {};
    const API_BASE_URL = APP_CONFIG.apiBaseUrl;
    if (!APP_CONFIG.capabilities?.persistence || !API_BASE_URL) {
        contentDiv.innerHTML = `<div class="empty">${ui(
            'This city does not provide shared project storage or a leaderboard.',
            'Ovaj grad nema spremanje dijeljenih projekata ni ljestvicu.',
        )}</div>`;
        document.querySelector('.leaderboard-tabs')?.setAttribute('hidden', '');
        openPricesBtn?.setAttribute('hidden', '');
        return;
    }
    const pendingVotes = new Set();
    const pendingExports = new Set();
    const projectDetailCache = new Map();
    const RANK_MEDALS = ['🥇', '🥈', '🥉'];
    const VOTE_STORAGE_KEY = 'transit-leaderboard-votes-v1';
    const DEFAULT_PRICING = pricingApi ? { ...pricingApi.DEFAULT_PRICING } : {
        undergroundTrackPerKm: 150_000_000,
        undergroundStation: 50_000_000,
        undergroundDepot: 200_000_000,
        overgroundTrackPerKm: 15_000_000,
        overgroundStation: 5_000_000,
        overgroundDepot: 30_000_000,
    };

    const SORTABLE_COLUMNS = [
        { key: 'author_name', label: ui('Author', 'Autor'), defaultDir: 'asc', type: 'string' },
        { key: 'total_length_km', label: ui('Length', 'Duljina'), defaultDir: 'asc' },
        { key: 'total_cost_eur', label: ui('Cost', 'Cijena'), defaultDir: 'asc' },
        { key: 'station_count', label: ui('Stations', 'Stanica'), defaultDir: 'desc' },
        { key: 'total_population', label: ui('Pop.', 'Stan.'), defaultDir: 'desc' },
        { key: 'total_jobs', label: ui('Jobs', 'Radna mj.'), defaultDir: 'desc' },
        { key: 'cost_per_person', label: ui('EUR/person', 'EUR/stan.'), defaultDir: 'asc' },
        { key: 'cost_per_job', label: ui('EUR/job', 'EUR/r.mj.'), defaultDir: 'asc' },
        { key: 'vote_score', label: ui('Popularity', 'Popularnost'), defaultDir: 'desc' },
        { key: 'created_at', label: ui('Added', 'Dodano'), defaultDir: 'desc', type: 'date' },
    ];
    const SORTABLE_KEYS = new Set(SORTABLE_COLUMNS.map(c => c.key));

    let currentSortKey = 'cost_per_person';
    let currentSortDir = 'asc';
    let activePricing = pricingApi ? pricingApi.loadPricing() : { ...DEFAULT_PRICING };
    let serverProjects = [];
    let currentProjects = [];

    // Ranked / Unranked / Postojeće tabs. Membership is not exclusive: a saved
    // reference railway can also be unranked because it has no ridership data.
    const tabRankedBtn = document.getElementById('tabRanked');
    const tabUnrankedBtn = document.getElementById('tabUnranked');
    const tabExistingBtn = document.getElementById('tabExisting');
    let activeTab = 'ranked';
    let unrankedProjects = [];
    let existingProjects = [];
    const rankingIds = new Set(); // projects with an in-flight rank calculation
    const TAB_LABELS = Object.freeze({
        ranked: ui('Ranked', 'Rangirani'),
        unranked: ui('Unranked', 'Nerangirani'),
        existing: ui('Existing', 'Postojeće'),
    });

    function formatNumber(value) {
        return Math.round(value).toLocaleString(UI_LOCALE);
    }

    function formatCost(eur) {
        if (eur >= 1e9) return `${(eur / 1e9).toFixed(2)} ${ui('B', 'mlrd')}`;
        if (eur >= 1e6) return `${(eur / 1e6).toFixed(1)} ${ui('M', 'mil.')}`;
        return formatNumber(eur);
    }

    function formatMetric(value) {
        return Number.isFinite(Number(value)) ? formatNumber(Number(value)) : '&mdash;';
    }

    function formatCurrencyMetric(value) {
        return Number.isFinite(Number(value)) ? `${formatNumber(Number(value))} &euro;` : '&mdash;';
    }

    function formatVoteScore(score) {
        const normalized = Number(score) || 0;
        return normalized > 0 ? `+${normalized}` : String(normalized);
    }

    function getRankMarkup(rank) {
        const medal = RANK_MEDALS[rank - 1];
        if (medal) {
            const rankLabel = ui(`Rank ${rank}`, `${rank}. mjesto`);
            return `<span class="rank-badge" title="${rankLabel}" aria-label="${rankLabel}">${medal}</span>`;
        }
        return `<span class="rank-number">${rank}</span>`;
    }

    // Generate a small SVG thumbnail of the project's transit network.
    // Black lines for tracks/lines, red dots for stations.
    function generateNetworkThumbnail(projectData, width = 60, height = 40) {
        if (!projectData) return '';
        const pad = 3;
        const stationRadius = 1.5;

        // Extract polylines and station points from v2 or v6 format
        const polylines = [];
        const points = [];

        const tracks = Array.isArray(projectData.tracks) ? projectData.tracks : [];
        const lines = Array.isArray(projectData.lines) ? projectData.lines : [];
        const stations = Array.isArray(projectData.stations) ? projectData.stations : [];

        // Split a v7 track (per-vertex levels) into runs so underground stretches
        // can be drawn dashed while the rest stays solid.
        function pushTrackRuns(lls, levels) {
            let runUnderground = null;
            let runPts = [];
            const flush = () => {
                if (runPts.length >= 2) polylines.push({ lls: runPts, underground: runUnderground });
                runPts = [];
            };
            for (let i = 0; i < lls.length - 1; i++) {
                const segUnderground = (levels[i] < 0) || (levels[i + 1] < 0);
                if (segUnderground !== runUnderground) {
                    flush();
                    runUnderground = segUnderground;
                    runPts = [lls[i]];
                }
                runPts.push(lls[i + 1]);
            }
            flush();
        }

        for (const t of (tracks.length > 0 ? tracks : lines)) {
            const lls = Array.isArray(t.latlngs) ? t.latlngs : [];
            if (lls.length < 2) continue;
            if (t.gauge) {
                const levels = Array.isArray(t.levels) && t.levels.length === lls.length ? t.levels : lls.map(() => 0);
                pushTrackRuns(lls, levels);
            } else {
                // Legacy v2-v6: whole track is one type
                polylines.push({ lls, underground: t.type === 'underground' });
            }
        }

        for (const s of stations) {
            const ll = s.latlng || s.latLng;
            if (Array.isArray(ll) && ll.length >= 2) points.push(ll);
        }

        if (polylines.length === 0 && points.length === 0) return '';

        // Compute bounding box from all coordinates
        let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
        const updateBounds = (lat, lng) => {
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
        };
        for (const { lls } of polylines) {
            for (const pt of lls) {
                if (Array.isArray(pt) && pt.length >= 2) updateBounds(pt[0], pt[1]);
            }
        }
        for (const pt of points) updateBounds(pt[0], pt[1]);

        const dLat = maxLat - minLat || 0.001;
        const dLng = maxLng - minLng || 0.001;
        const innerW = width - pad * 2;
        const innerH = height - pad * 2;
        const scale = Math.min(innerW / dLng, innerH / dLat);
        const offsetX = pad + (innerW - dLng * scale) / 2;
        const offsetY = pad + (innerH - dLat * scale) / 2;

        const toX = lng => offsetX + (lng - minLng) * scale;
        const toY = lat => offsetY + (maxLat - lat) * scale; // flip Y

        let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="background:white;border-radius:3px">`;

        // Draw track/line polylines — underground stretches are dotted, the rest solid.
        for (const { lls, underground } of polylines) {
            const d = lls.filter(pt => Array.isArray(pt) && pt.length >= 2)
                .map((pt, i) => `${i === 0 ? 'M' : 'L'}${toX(pt[1]).toFixed(1)},${toY(pt[0]).toFixed(1)}`)
                .join('');
            const dashAttr = underground ? ' stroke-dasharray="1.5,1.5"' : '';
            if (d) svg += `<path d="${d}" fill="none" stroke="#333" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"${dashAttr}/>`;
        }

        // Draw station dots
        for (const pt of points) {
            svg += `<circle cx="${toX(pt[1]).toFixed(1)}" cy="${toY(pt[0]).toFixed(1)}" r="${stationRadius}" fill="#e53e3e"/>`;
        }

        svg += '</svg>';
        return svg;
    }

    function compareNullableNumbers(left, right) {
        const normalizedLeft = Number.isFinite(Number(left)) ? Number(left) : null;
        const normalizedRight = Number.isFinite(Number(right)) ? Number(right) : null;
        if (normalizedLeft === null && normalizedRight === null) return 0;
        if (normalizedLeft === null) return 1;
        if (normalizedRight === null) return -1;
        return normalizedLeft - normalizedRight;
    }

    function sortProjects(projects, key, dir) {
        const multiplier = dir === 'desc' ? -1 : 1;
        const col = SORTABLE_COLUMNS.find(c => c.key === key);
        const isString = col && col.type === 'string';
        const isDate = col && col.type === 'date';
        projects.sort((left, right) => {
            let primary;
            if (isString) {
                const leftValue = key === 'author_name'
                    ? displayProjectName(left[key]) : String(left[key] || '');
                const rightValue = key === 'author_name'
                    ? displayProjectName(right[key]) : String(right[key] || '');
                primary = leftValue.localeCompare(rightValue, 'hr') * multiplier;
            } else if (isDate) {
                primary = compareNullableNumbers(
                    timestampValue(left[key]), timestampValue(right[key]),
                ) * multiplier;
            } else {
                primary = compareNullableNumbers(left[key], right[key]) * multiplier;
            }
            if (primary !== 0) return primary;
            return Number(right.id) - Number(left.id);
        });
        return projects;
    }

    // Quote-safe so the output is also correct in attribute context, matching escapeAttribute.
    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeAttribute(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function getStoredVotes() {
        try {
            const raw = window.localStorage.getItem(VOTE_STORAGE_KEY);
            const parsed = raw ? JSON.parse(raw) : {};
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (error) {
            return {};
        }
    }

    function getStoredVote(projectId) {
        const votes = getStoredVotes();
        return votes[String(projectId)] || null;
    }

    function storeVote(projectId, direction) {
        const votes = getStoredVotes();
        votes[String(projectId)] = direction;
        try {
            window.localStorage.setItem(VOTE_STORAGE_KEY, JSON.stringify(votes));
        } catch (error) {
        }
    }

    function showFeedback(message, isError = false) {
        if (!message) {
            feedbackDiv.textContent = '';
            feedbackDiv.className = 'feedback hidden';
            return;
        }
        feedbackDiv.textContent = message;
        feedbackDiv.className = isError ? 'feedback error' : 'feedback';
    }

    function hasCustomPricing() {
        return pricingApi ? pricingApi.hasCustomPricing(activePricing) : false;
    }

    function updatePriceButtonLabel() {
        if (!openPricesBtn) return;
        openPricesBtn.textContent = hasCustomPricing() ? 'Uredi cijene' : 'Postavi cijene';
    }

    function getPageDirectoryPath() {
        const pathname = String(window.location.pathname || '');
        if (pathname.endsWith('/')) {
            return pathname;
        }

        return pathname.replace(/[^/]*$/, '') || '/';
    }

    function isHtmlFilePath(pathname) {
        return /\.[^/]+$/.test(String(pathname || ''));
    }

    function getPlannerBaseHref() {
        const pathname = String(window.location.pathname || '');
        const pageDirectory = getPageDirectoryPath();
        if (pageDirectory !== '/') {
            return `${pageDirectory}transit.html`;
        }

        return isHtmlFilePath(pathname) ? 'transit.html' : 'transit';
    }

    function getPlannerProjectHref(projectId) {
        const separator = getPlannerBaseHref().includes('?') ? '&' : '?';
        return `${getPlannerBaseHref()}${separator}project=${encodeURIComponent(projectId)}&lang=${encodeURIComponent(i18n?.currentLanguage || 'en')}`;
    }

    function getLeaderboardTabHref(tab) {
        const url = new URL(window.location.href);
        url.searchParams.set('tab', leaderboardTabQueryValue(tab));
        return `${url.pathname}${url.search}${url.hash}`;
    }

    function projectNameMarkup(project) {
        const href = escapeAttribute(getPlannerProjectHref(project.id));
        return `<a class="project-link" href="${href}">${escapeHtml(displayProjectName(project.author_name))}</a>`;
    }

    if (TEST_CONFIG.exposeLeaderboardPathHelpers) {
        window.__LEADERBOARD_TEST_HOOKS__ = {
            getLeaderboardTabHref,
            getPlannerBaseHref,
            getPlannerProjectHref,
        };
    }

    function cloneProject(project) {
        return { ...project };
    }

    function cacheProjectDetail(detail) {
        const projectId = Number(detail?.id);
        if (!Number.isInteger(projectId)) return;

        const cachedDetail = {};
        if (detail.project_data) {
            cachedDetail.project_data = detail.project_data;
        }
        if (detail.computed_data) {
            cachedDetail.computed_data = detail.computed_data;
        }
        if (Object.keys(cachedDetail).length > 0) {
            projectDetailCache.set(projectId, cachedDetail);
        }
    }

    function applyCachedProjectDetail(project) {
        const projectId = Number(project?.id);
        if (!Number.isInteger(projectId)) return project;
        const cachedDetail = projectDetailCache.get(projectId);
        if (!cachedDetail) return project;
        return {
            ...project,
            ...cachedDetail,
        };
    }

    async function fetchProjectDetail(projectId) {
        const response = await fetch(`${API_BASE_URL}/transit/projects/${projectId}`, {
            cache: 'no-store',
        });
        if (!response.ok) {
            throw new Error(`Projekt ${projectId} nije dostupan (${response.status})`);
        }
        const detail = await response.json();
        cacheProjectDetail(detail);
        return detail;
    }

    function exportButtonMarkup(project) {
        const projectId = Number(project?.id);
        const pending = pendingExports.has(projectId);
        const name = displayProjectName(project?.author_name) || `Projekt ${projectId}`;
        return `<button type="button" class="export-btn" data-export-id="${projectId}"
            title="Preuzmi prenosive trase, stanice i linije"
            aria-label="Preuzmi podatke projekta ${escapeAttribute(name)}" ${pending ? 'disabled' : ''}>
            ${pending ? 'Pripremam…' : 'Preuzmi ZIP'}
        </button>`;
    }

    function setExportButtonPending(projectId, pending) {
        contentDiv.querySelectorAll(`.export-btn[data-export-id="${projectId}"]`).forEach(button => {
            button.disabled = pending;
            button.textContent = pending ? 'Pripremam…' : 'Preuzmi ZIP';
        });
    }

    function saveArchiveToDisk(archive) {
        const blob = new Blob([archive.bytes], { type: archive.mimeType });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = archive.filename;
        link.hidden = true;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function downloadProjectExport(projectId) {
        if (pendingExports.has(projectId)) return;
        if (!projectExportApi) {
            showFeedback('Izvoz podataka nije učitan. Osvježite stranicu i pokušajte ponovno.', true);
            return;
        }
        pendingExports.add(projectId);
        setExportButtonPending(projectId, true);
        try {
            let project = findProjectById(
                projectId,
                currentProjects,
                serverProjects,
                unrankedProjects,
                existingProjects,
            );
            if (!project?.project_data) {
                const detail = await fetchProjectDetail(projectId);
                project = project ? { ...project, ...detail } : detail;
            }
            if (!project?.project_data) throw new Error('Projekt nema spremljenu definiciju mreže.');
            const cleanName = displayProjectName(project.author_name);
            const archive = projectExportApi.createProjectExportArchive(
                { ...project, author_name: cleanName },
                { projectName: cleanName },
            );
            saveArchiveToDisk(archive);
            const missingTracks = archive.summary.tracksWithoutElevation;
            const missingStations = archive.summary.stationsWithoutElevation;
            const elevationNote = missingTracks || missingStations
                ? ` ${missingTracks} trasa i ${missingStations} stanica nema spremljenu apsolutnu visinu pa ostaje 2D.`
                : '';
            showFeedback(
                `Preuzet je ZIP s tracks.geojson, stations.geojson i lines.json.${elevationNote}`,
            );
        } catch (error) {
            showFeedback(`Preuzimanje nije uspjelo: ${error.message}`, true);
        } finally {
            pendingExports.delete(projectId);
            setExportButtonPending(projectId, false);
        }
    }

    function attachExportButtons() {
        contentDiv.querySelectorAll('.export-btn').forEach(button => {
            button.addEventListener('click', event => {
                event.stopPropagation();
                const projectId = Number(button.dataset.exportId);
                if (Number.isInteger(projectId)) downloadProjectExport(projectId);
            });
        });
    }

    // ─── Bill of civil objects (📋 per row) ─────────────────────────────────
    // The same table the planner shows, for a project you have not opened: what
    // this proposal is actually made of, structure by structure. Detection runs
    // off the saved project_data — a solved vertical profile gives all five
    // object kinds, an older save falls back to its three level states.

    const objectsModal = document.getElementById('objectsModal');
    const objectsContent = document.getElementById('objectsContent');
    const objectsTitle = document.getElementById('objectsModalTitle');
    const closeObjectsBtn = document.getElementById('closeObjects');
    let objectsProjectId = null;

    const GAUGE_LABELS = {
        monorail: '🚝 Monorail',
        g1000: '🚊 Uskotračna (1000 mm)',
        g1435: '🚇 Normalna (1435 mm)',
    };

    // Sits next to the cost, because it is what the cost is made of.
    function objectsButtonMarkup(projectId) {
        return `<button type="button" class="objects-btn" data-objects-id="${projectId}"
            title="Popis objekata: vijadukti, usjeci, tuneli, nasipi i stanice"
            aria-label="Popis objekata">📋</button>`;
    }

    function projectObjectEntries(project) {
        const civil = window.__civilObjects;
        if (!civil || !pricingApi || !project?.project_data) return [];
        const scope = pricingApi.objectCostScope(project.id);
        const overrides = pricingApi.getObjectCosts(scope);
        const normalized = pricingApi.normalizeProjectData(project.project_data);
        const entries = normalized.tracks.map((track, index) => ({
            label: `Trasa ${track.id != null ? track.id : index + 1}`,
            gaugeLabel: GAUGE_LABELS[track.gauge] || track.gauge,
            lengthM: pricingApi.computePolylineLengthKm(track.latlngs) * 1000,
            rates: pricingApi.getObjectRates(track.gauge, activePricing),
            overrides,
            coarse: !track.verticalProfile,
            objects: pricingApi.detectTrackObjects(track),
        }));
        // Stations and transfer links are priced per unit, not per track, so
        // they get their own section rather than being attributed to a route.
        if (normalized.stations.length > 0) {
            entries.push({
                label: 'Stanice',
                gaugeLabel: '',
                lengthM: 0,
                rates: pricingApi.getObjectRates(normalized.stations[0].gauge, activePricing),
                overrides,
                objects: normalized.stations.map((station, index) => ({
                    kind: 'station',
                    stationKind: station.stationKind,
                    stationType: station.stationType,
                    name: '',
                    dM0: null,
                    dM1: null,
                    lengthM: 0,
                    heightM: null,
                    avgHeightM: null,
                    count: 1,
                    key: `station|${index}`,
                })),
            });
        }
        if (normalized.transferLinks.length > 0) {
            entries.push({
                label: 'Presjedanja',
                gaugeLabel: '',
                lengthM: 0,
                rates: pricingApi.getObjectRates('g1000', activePricing),
                overrides,
                objects: normalized.transferLinks.map((link, index) =>
                    civil.transferObject(link, index)),
            });
        }
        return entries;
    }

    // Chainage order is what the detector produces and how a railway reads a
    // line, so the table opens on it. The headers are clickable here too — a
    // sortable-looking column that does nothing is worse than a plain one.
    let objectsSort = { key: 'chainage', direction: 'asc' };

    function renderObjectsModal(project) {
        if (!objectsContent || !window.__civilObjectsView) return;
        objectsContent.innerHTML = window.__civilObjectsView.render(
            projectObjectEntries(project),
            // The table's own currency, since the leaderboard's formatCost drops
            // the unit (its columns carry a separate € glyph).
            {
                editable: true,
                sort: objectsSort,
                formatCost: (eur) => `${formatCost(eur)} EUR`,
            },
        );
        window.__civilObjectsView.attach(objectsContent, {
            onSort: (key) => {
                if (!window.__civilObjectsView.SORT_KEYS.includes(key)) return;
                objectsSort = objectsSort.key === key
                    ? { key, direction: objectsSort.direction === 'asc' ? 'desc' : 'asc' }
                    : { key, direction: 'asc' };
                renderObjectsModal(project);
            },
            onCommit: (key, costEur) => {
                const scope = pricingApi.objectCostScope(project.id);
                if (key && costEur === null) pricingApi.clearObjectCost(scope, key);
                else if (key && Number.isFinite(costEur)) pricingApi.setObjectCost(scope, key, costEur);
                renderObjectsModal(project);
            },
        });
    }

    async function openObjectsModal(projectId) {
        if (!objectsModal) return;
        objectsProjectId = projectId;
        objectsModal.classList.remove('hidden');
        objectsContent.innerHTML = '<div class="loading">Ucitavam...</div>';
        let project = findProjectById(
            projectId,
            currentProjects,
            serverProjects,
            unrankedProjects,
            existingProjects,
        );
        const updateObjectsTitle = () => {
            if (!objectsTitle) return;
            objectsTitle.textContent = project
                ? `Objekti — ${displayProjectName(project.author_name)}`
                : 'Objekti na mreži';
        };
        updateObjectsTitle();
        try {
            if (!project?.project_data) {
                const detail = await fetchProjectDetail(Number(projectId));
                if (project) Object.assign(project, detail);
                else project = detail;
            }
        } catch (error) {
            objectsContent.innerHTML = '<p class="civil-objects-empty">Projekt nije moguce ucitati.</p>';
            return;
        }
        // A second 📋 click while this one was loading wins.
        if (objectsProjectId !== projectId) return;
        updateObjectsTitle();
        renderObjectsModal(project);
    }

    function closeObjectsModal() {
        objectsProjectId = null;
        if (objectsModal) objectsModal.classList.add('hidden');
    }

    if (closeObjectsBtn) closeObjectsBtn.addEventListener('click', closeObjectsModal);
    if (objectsModal) {
        objectsModal.addEventListener('click', (event) => {
            if (event.target === objectsModal) closeObjectsModal();
        });
    }
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && objectsModal && !objectsModal.classList.contains('hidden')) {
            closeObjectsModal();
        }
    });

    async function ensureProjectDataForPricing(projects) {
        const missingProjects = projects.filter(project => !project.project_data);
        if (missingProjects.length === 0) return;

        const results = await Promise.allSettled(missingProjects.map(async project => {
            const detail = await fetchProjectDetail(Number(project.id));
            if (!detail?.project_data) {
                throw new Error(`Projekt ${project.id} nema definiciju trase.`);
            }
            project.project_data = detail.project_data;
            if (detail.computed_data) {
                project.computed_data = detail.computed_data;
            }
        }));

        const failedResults = results.filter(result => result.status === 'rejected');
        if (failedResults.length > 0) {
            throw new Error('Lokalni preracun nije uspio jer dio projekata nije mogao biti ucitan.');
        }
    }

    function repriceProject(project) {
        if (!pricingApi || !project.project_data) {
            return cloneProject(project);
        }

        const metrics = pricingApi.computeProjectMetrics(project.project_data, {
            total_population: project.total_population,
            total_jobs: project.total_jobs,
        }, activePricing);

        return {
            ...project,
            total_length_km: metrics.totalLengthKm,
            total_cost_eur: metrics.totalCostEur,
            station_count: metrics.stationCount,
            transfer_link_count: metrics.transferLinkCount,
            cost_per_person: metrics.costPerPerson,
            cost_per_job: metrics.costPerJob,
        };
    }

    async function rebuildCurrentProjects() {
        const baseProjects = serverProjects.map(cloneProject);

        if (!hasCustomPricing()) {
            currentProjects = baseProjects;
            renderLeaderboard();
            return;
        }

        try {
            await ensureProjectDataForPricing(serverProjects);
            currentProjects = serverProjects.map(repriceProject);
            renderLeaderboard();
        } catch (error) {
            currentProjects = baseProjects;
            renderLeaderboard();
            throw error;
        }
    }

    // ---- Ranked / Unranked tabs -------------------------------------------
    function syncTabLinks() {
        for (const [tab, link] of [
            ['ranked', tabRankedBtn],
            ['unranked', tabUnrankedBtn],
            ['existing', tabExistingBtn],
        ]) {
            if (!link) continue;
            link.href = getLeaderboardTabHref(tab);
            link.classList.toggle('active', activeTab === tab);
            link.setAttribute('aria-selected', String(activeTab === tab));
        }
    }

    function tabLink(tab) {
        if (tab === 'unranked') return tabUnrankedBtn;
        if (tab === 'existing') return tabExistingBtn;
        return tabRankedBtn;
    }

    function updateTabCount(tab, count) {
        const link = tabLink(tab);
        if (!link) return;
        const normalizedCount = Math.max(0, Number(count) || 0);
        link.innerHTML = `${TAB_LABELS[tab]} <span class="lb-tab-count">${normalizedCount}</span>`;
    }

    function tabCountUrl(tab) {
        if (tab === 'unranked') return `${API_BASE_URL}/transit/unranked`;
        if (tab === 'existing') return `${API_BASE_URL}/transit/reference-projects`;
        return `${API_BASE_URL}/transit/leaderboard?sort=${encodeURIComponent(currentSortKey)}`;
    }

    // Populate all three counters without forcing the reader to open every tab.
    // The active tab's normal loader owns its count; only the other two are
    // prefetched, and a failed auxiliary count never blocks the visible list.
    function prefetchInactiveTabCounts() {
        for (const tab of ['ranked', 'unranked', 'existing']) {
            if (tab === activeTab) continue;
            fetch(tabCountUrl(tab), { cache: 'no-store' })
                .then(response => (response.ok ? response.json() : []))
                .then(projects => updateTabCount(tab, Array.isArray(projects) ? projects.length : 0))
                .catch(() => {});
        }
    }

    function setActiveTab(tab, options = {}) {
        activeTab = normalizeLeaderboardTab(tab);
        if (options.updateUrl) {
            window.history.pushState(
                { leaderboardTab: activeTab },
                '',
                getLeaderboardTabHref(activeTab),
            );
        }
        syncTabLinks();
        if (activeTab === 'unranked') loadUnranked();
        else if (activeTab === 'existing') loadExisting();
        else loadLeaderboard(currentSortKey);
    }

    function attachTabLink(link, tab) {
        link?.addEventListener('click', (event) => {
            if (
                event.defaultPrevented
                || event.button !== 0
                || event.metaKey
                || event.ctrlKey
                || event.shiftKey
                || event.altKey
            ) return;
            event.preventDefault();
            setActiveTab(tab, { updateUrl: true });
        });
    }

    // ---- Postojeće (reconstructed existing lines) --------------------------
    // The ranked tab sorts through currentSortKey/currentSortDir. These two tabs
    // had no sorting at all, so they get their own state — the default order
    // stays exactly what the API returned until a header is clicked.
    const secondaryTabSort = {
        existing: { key: null, dir: 'desc' },
        unranked: { key: null, dir: 'desc' },
    };

    function secondaryThTag(tab, label, key) {
        if (!key) return `<th>${label}</th>`;
        const state = secondaryTabSort[tab];
        const cls = state.key === key ? `sortable sort-${state.dir}` : 'sortable';
        return `<th class="${cls}" data-sort-key="${key}">${label}</th>`;
    }

    function applySecondaryTabSort(tab, projects) {
        const state = secondaryTabSort[tab];
        if (state.key) sortProjects(projects, state.key, state.dir);
        return projects;
    }

    function attachSecondaryTabSort(tab, rerender) {
        contentDiv.querySelectorAll('th.sortable').forEach((th) => {
            th.addEventListener('click', () => {
                const key = th.dataset.sortKey;
                if (!key || !SORTABLE_KEYS.has(key)) return;
                const state = secondaryTabSort[tab];
                if (state.key === key) {
                    state.dir = state.dir === 'asc' ? 'desc' : 'asc';
                } else {
                    const col = SORTABLE_COLUMNS.find(c => c.key === key);
                    state.key = key;
                    state.dir = col ? col.defaultDir : 'asc';
                }
                rerender();
            });
        });
    }

    // Only the reconstructions we have processed and stored as projects. The
    // existing rail the sims and the 3D world draw as reference geometry is NOT
    // a project and never appears here.
    async function loadExisting() {
        contentDiv.innerHTML = '<div class="loading">Ucitavam...</div>';
        try {
            const response = await fetch(`${API_BASE_URL}/transit/reference-projects`, { cache: 'no-store' });
            if (!response.ok) throw new Error(`Greska: ${response.status}`);
            existingProjects = await response.json();
        } catch (error) {
            contentDiv.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
            return;
        }
        updateTabCount('existing', existingProjects.length);
        renderExisting();
    }

    function renderExisting() {
        if (activeTab !== 'existing') return;
        if (existingProjects.length === 0) {
            contentDiv.innerHTML = '<div class="empty">Nema rekonstruiranih postojećih pruga.</div>';
            return;
        }
        applySecondaryTabSort('existing', existingProjects);
        let html = `<div class="table-scroll" role="region" aria-label="Postojeće pruge" tabindex="0"><table>
            <thead><tr>
                <th>Mreža</th>${secondaryThTag('existing', 'Pruga', 'author_name')}<th>Oznaka</th><th>Lokacija</th>
                ${secondaryThTag('existing', 'Duljina', 'total_length_km')}${secondaryThTag('existing', 'Cijena', 'total_cost_eur')}
                ${secondaryThTag('existing', 'Dodano', 'created_at')}<th>Podaci</th>
            </tr></thead><tbody>`;
        existingProjects.forEach((project) => {
            const refs = Array.isArray(project.refs) ? project.refs : [];
            html += `<tr class="project-row" data-project-id="${project.id}">
                <td class="network-thumb">${generateNetworkThumbnail(project.project_data)}</td>
                <td class="author-cell">${projectNameMarkup(project)}</td>
                <td class="existing-ref">${escapeHtml(refs.join(', '))}</td>
                <td>${escapeHtml(project.location || '')}</td>
                <td>${Number(project.total_length_km).toFixed(1)} km</td>
                <td>${formatCost(project.total_cost_eur)} &euro; ${objectsButtonMarkup(project.id)}</td>
                <td class="created-cell">${formatCreatedAt(project.created_at, UI_LOCALE)}</td>
                <td>${exportButtonMarkup(project)}</td>
            </tr>`;
        });
        html += '</tbody></table></div>';
        contentDiv.innerHTML = html;
        attachObjectsButtons();
        attachExportButtons();
        attachSecondaryTabSort('existing', renderExisting);
        attachProjectRowLinks();
    }

    async function loadUnranked() {
        contentDiv.innerHTML = '<div class="loading">Ucitavam...</div>';
        try {
            const response = await fetch(`${API_BASE_URL}/transit/unranked`, { cache: 'no-store' });
            if (!response.ok) throw new Error(`Greska: ${response.status}`);
            unrankedProjects = await response.json();
        } catch (error) {
            contentDiv.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
            return;
        }
        updateTabCount('unranked', unrankedProjects.length);
        renderUnranked();
    }

    function renderUnranked() {
        if (activeTab !== 'unranked') return;
        if (unrankedProjects.length === 0) {
            contentDiv.innerHTML = '<div class="empty">Nema nerangiranih projekata.</div>';
            return;
        }
        applySecondaryTabSort('unranked', unrankedProjects);
        let html = `<div class="table-scroll" role="region" aria-label="Nerangirani projekti" tabindex="0"><table>
            <thead><tr>
                <th>Mreža</th>${secondaryThTag('unranked', 'Autor', 'author_name')}
                ${secondaryThTag('unranked', 'Duljina', 'total_length_km')}${secondaryThTag('unranked', 'Cijena', 'total_cost_eur')}
                ${secondaryThTag('unranked', 'Stanica', 'station_count')}<th>Status</th>
                ${secondaryThTag('unranked', 'Dodano', 'created_at')}<th>Radnje</th>
            </tr></thead><tbody>`;
        unrankedProjects.forEach((project) => {
            const isRanking = rankingIds.has(project.id);
            html += `<tr class="project-row" data-project-id="${project.id}">
                <td class="network-thumb">${generateNetworkThumbnail(project.project_data)}</td>
                <td class="author-cell">${projectNameMarkup(project)}</td>
                <td>${Number(project.total_length_km).toFixed(1)} km</td>
                <td>${formatCost(project.total_cost_eur)} &euro; ${objectsButtonMarkup(project.id)}</td>
                <td>${project.station_count}</td>
                <td class="unranked-status">${isRanking
                    ? '<span class="unranked-status-pending">Računam…</span>'
                    : `<span class="unranked-reason">${project.metrics_status === 'ready'
                        ? 'Bez podataka o dosegu' : 'Čeka izračun'}</span>`}</td>
                <td class="created-cell">${formatCreatedAt(project.created_at, UI_LOCALE)}</td>
                <td><div class="row-actions">${exportButtonMarkup(project)}
                    <button class="rank-btn" type="button" data-rank-id="${project.id}" ${isRanking ? 'disabled' : ''}>Rangiraj</button>
                </div></td>
            </tr>`;
        });
        html += '</tbody></table></div>';
        contentDiv.innerHTML = html;
        attachObjectsButtons();
        attachExportButtons();
        attachSecondaryTabSort('unranked', renderUnranked);
        // Row click -> open on map (same as ranked); button click -> rank.
        contentDiv.querySelectorAll('.rank-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                rankProject(Number(btn.dataset.rankId));
            });
        });
        attachProjectRowLinks();
    }

    // Trigger a metrics (re)calculation and poll until it settles. On success
    // the project gains ridership metrics and moves to the ranked tab; if it
    // comes back with zero population it has no data for its location.
    async function rankProject(id) {
        if (rankingIds.has(id)) return;
        rankingIds.add(id);
        renderUnranked();
        try {
            const post = await fetch(`${API_BASE_URL}/transit/projects/${id}/rank`, { method: 'POST' });
            if (!post.ok) throw new Error(`Greska: ${post.status}`);

            // Poll the project until metrics_status leaves 'pending'/'processing'.
            const deadline = Date.now() + 45000;
            let project = null;
            while (Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 1500));
                const res = await fetch(`${API_BASE_URL}/transit/projects/${id}`, { cache: 'no-store' });
                if (!res.ok) continue;
                project = await res.json();
                if (project.metrics_status === 'ready') break;
            }
            rankingIds.delete(id);

            if (!project || project.metrics_status !== 'ready') {
                showFeedback('Izračun još traje — Valhalla je možda nedostupna. Pokušajte kasnije.', true);
                renderUnranked();
                return;
            }
            if (Number(project.total_population) > 0) {
                showFeedback(`Projekt je rangiran i premješten na ljestvicu.`);
                serverProjects = [];
                setActiveTab('ranked');
                prefetchInactiveTabCounts();
            } else {
                // Mark this row as having no location data.
                const row = unrankedProjects.find((p) => p.id === id);
                if (row) row.metrics_status = 'ready';
                renderUnranked();
                const cell = contentDiv.querySelector(`.project-row[data-project-id="${id}"] .unranked-status`);
                if (cell) cell.innerHTML = '<span class="unranked-reason no-data">Nema podataka o stanovništvu/radnim mjestima za ovu lokaciju</span>';
            }
        } catch (error) {
            rankingIds.delete(id);
            showFeedback(`Rangiranje nije uspjelo: ${error.message}`, true);
            renderUnranked();
        }
    }

    function renderLeaderboard() {
        if (currentProjects.length === 0) {
            contentDiv.innerHTML = `<div class="empty">Nema projekata. <a href="${escapeAttribute(getPlannerBaseHref())}">Kreirajte prvi!</a></div>`;
            return;
        }

        sortProjects(currentProjects, currentSortKey, currentSortDir);

        function thTag(label, sortKey) {
            if (!sortKey) return `<th>${label}</th>`;
            const cls = currentSortKey === sortKey
                ? `sortable sort-${currentSortDir}`
                : 'sortable';
            return `<th class="${cls}" data-sort-key="${sortKey}">${label}</th>`;
        }

        let html = `<div class="table-scroll" role="region" aria-label="Ljestvica projekata" tabindex="0"><table>
            <thead><tr>
                ${thTag('#', null)}<th>Mreža</th>${thTag('Autor', 'author_name')}${thTag('Duljina', 'total_length_km')}${thTag('Cijena', 'total_cost_eur')}
                ${thTag('Stanica', 'station_count')}${thTag('Broj veza', 'transfer_link_count')}${thTag('Stan.', 'total_population')}${thTag('Radna mj.', 'total_jobs')}
                ${thTag('EUR/stan.', 'cost_per_person')}${thTag('EUR/r.mj.', 'cost_per_job')}${thTag('Popularnost', 'vote_score')}
                ${thTag('Dodano', 'created_at')}<th>Podaci</th>
            </tr></thead><tbody>`;

        currentProjects.forEach((project, index) => {
            const rank = index + 1;
            const storedVote = getStoredVote(project.id);
            const isPending = pendingVotes.has(project.id);
            html += `<tr class="project-row" data-project-id="${project.id}">
                <td class="rank">${getRankMarkup(rank)}</td>
                <td class="network-thumb">${generateNetworkThumbnail(project.project_data)}</td>
                <td class="author-cell">${projectNameMarkup(project)}</td>
                <td>${Number(project.total_length_km).toFixed(1)} km</td>
                <td>${formatCost(project.total_cost_eur)} &euro; ${objectsButtonMarkup(project.id)}</td>
                <td>${project.station_count}</td>
                <td>${Number(project.transfer_link_count) || 0}</td>
                <td>${formatMetric(project.total_population)}</td>
                <td>${formatMetric(project.total_jobs)}</td>
                <td>${formatCurrencyMetric(project.cost_per_person)}</td>
                <td>${formatCurrencyMetric(project.cost_per_job)}</td>
                <td class="popularity-cell">
                    <div class="vote-controls">
                        <button
                            type="button"
                            class="vote-btn ${storedVote === 'up' ? 'active-up' : ''}"
                            data-project-id="${project.id}"
                            data-direction="up"
                            aria-label="Glasaj pozitivno za ${escapeAttribute(displayProjectName(project.author_name))}"
                            ${isPending ? 'disabled' : ''}
                        >&#9650;</button>
                        <span class="vote-score">${formatVoteScore(project.vote_score)}</span>
                        <button
                            type="button"
                            class="vote-btn ${storedVote === 'down' ? 'active-down' : ''}"
                            data-project-id="${project.id}"
                            data-direction="down"
                            aria-label="Glasaj negativno za ${escapeAttribute(displayProjectName(project.author_name))}"
                            ${isPending ? 'disabled' : ''}
                        >&#9660;</button>
                    </div>
                </td>
                <td class="created-cell">${formatCreatedAt(project.created_at, UI_LOCALE)}</td>
                <td>${exportButtonMarkup(project)}</td>
            </tr>`;
        });

        html += '</tbody></table></div>';
        contentDiv.innerHTML = html;
        attachLeaderboardEvents();
    }

    // The whole row navigates to the planner, so the 📋 must swallow its click.
    function attachObjectsButtons() {
        contentDiv.querySelectorAll('.objects-btn').forEach((button) => {
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                openObjectsModal(Number(button.dataset.objectsId));
            });
        });
    }

    function attachProjectRowLinks() {
        contentDiv.querySelectorAll('.project-row').forEach((row) => {
            row.addEventListener('click', (event) => {
                if (event.target.closest('a, button')) return;
                window.location.href = getPlannerProjectHref(row.dataset.projectId);
            });
        });
    }

    function attachLeaderboardEvents() {
        attachObjectsButtons();
        attachExportButtons();
        contentDiv.querySelectorAll('th.sortable').forEach(th => {
            th.addEventListener('click', () => {
                const key = th.dataset.sortKey;
                if (!key || !SORTABLE_KEYS.has(key)) return;
                if (currentSortKey === key) {
                    currentSortDir = currentSortDir === 'asc' ? 'desc' : 'asc';
                } else {
                    const col = SORTABLE_COLUMNS.find(c => c.key === key);
                    currentSortKey = key;
                    currentSortDir = col ? col.defaultDir : 'asc';
                }
                renderLeaderboard();
            });
        });

        attachProjectRowLinks();

        contentDiv.querySelectorAll('.vote-btn').forEach(button => {
            button.addEventListener('click', event => {
                event.stopPropagation();
                const projectId = Number(button.dataset.projectId);
                const direction = button.dataset.direction;
                if (!Number.isInteger(projectId) || !direction) return;
                handleVote(projectId, direction);
            });
        });
    }

    function getPricingFieldValue(field, pricing) {
        const value = Number(pricing[field.key] || 0) / field.scale;
        const rounded = Number(value.toFixed(2));
        return Number.isInteger(rounded) ? String(rounded) : String(rounded);
    }

    function formatPricingPreview(field, value) {
        if (!Number.isFinite(value)) {
            return 'Nije ukljuceno u izracun.';
        }
        if (field.group === 'object') {
            return `Trenutno: ×${value}`;
        }
        if (field.key.endsWith('TrackPerKm')) {
            return `Trenutno: ${formatCost(value)} EUR/km`;
        }
        return `Trenutno: ${formatCost(value)} EUR`;
    }

    function renderPricingGroupCards(fields) {
        return fields.map(field => {
            const isConfigurable = field.configurable !== false;
            // A locked field is either not implemented yet (vehicles) or fixed by
            // definition (the ground-level multiplier, which IS the base price).
            // Showing "Uskoro" for the latter reads as a missing feature.
            const isFixed = !isConfigurable && field.fixedValue != null;
            const helpText = isConfigurable
                ? formatPricingPreview(field, activePricing[field.key])
                : (field.fixedHelp || 'Jos nije moguce podesavati ovu stavku.');
            const lockedValue = isFixed ? `×${field.fixedValue}` : 'Uskoro';

            return `<div class="price-card ${isConfigurable ? '' : 'disabled'}">
                <div class="price-card-header">
                    <span class="price-card-icon" aria-hidden="true">${field.icon}</span>
                    <div>
                        <div class="price-card-title">${escapeHtml(field.label)}</div>
                        <span class="price-card-unit">${escapeHtml(field.unitLabel)}</span>
                    </div>
                </div>
                <input
                    class="price-card-input"
                    ${isConfigurable ? 'type="number" min="0" step="0.1" inputmode="decimal"' : 'type="text" disabled'}
                    ${isConfigurable ? `data-price-key="${field.key}"` : `value="${lockedValue}"`}
                >
                <div class="price-card-help" data-price-help-key="${field.key}">${escapeHtml(helpText)}</div>
            </div>`;
        }).join('');
    }

    function renderPricingCards() {
        if (!pricingApi) return;

        pricesGrid.innerHTML = pricingApi.FIELD_GROUPS.map(group => `
            <div class="price-group">
                <div class="price-group-title">${group.title}</div>
                ${renderPricingGroupCards(group.fields)}
            </div>`).join('');

        fillPricingForm(activePricing);
    }

    function fillPricingForm(pricing) {
        if (!pricingApi) return;

        pricingApi.CONFIGURABLE_FIELDS.forEach(field => {
            const input = pricesGrid.querySelector(`[data-price-key="${field.key}"]`);
            if (!input) return;
            input.value = getPricingFieldValue(field, pricing);
        });

        pricingApi.DISPLAY_FIELDS.forEach(field => {
            const help = pricesGrid.querySelector(`[data-price-help-key="${field.key}"]`);
            if (!help) return;
            if (field.configurable === false) {
                help.textContent = field.fixedHelp || 'Jos nije moguce podesavati ovu stavku.';
                return;
            }
            help.textContent = formatPricingPreview(field, pricing[field.key]);
        });
    }

    function openPricesModal() {
        renderPricingCards();
        pricesModal.classList.remove('hidden');
    }

    function closePricesModal() {
        pricesModal.classList.add('hidden');
    }

    function readPricingForm() {
        if (!pricingApi) return { ...DEFAULT_PRICING };

        const nextPricing = {};
        for (const field of pricingApi.CONFIGURABLE_FIELDS) {
            const input = pricesGrid.querySelector(`[data-price-key="${field.key}"]`);
            const normalizedValue = Number(input?.value);
            if (!Number.isFinite(normalizedValue) || normalizedValue < 0) {
                throw new Error(`Neispravna vrijednost za "${field.label}".`);
            }
            // Multipliers (scale 1) keep decimals; money fields round to whole EUR
            nextPricing[field.key] = field.scale === 1 ? normalizedValue : Math.round(normalizedValue * field.scale);
        }
        return nextPricing;
    }

    async function savePricingSettings() {
        if (!pricingApi) return;

        let nextPricing;
        try {
            nextPricing = readPricingForm();
        } catch (error) {
            showFeedback(error.message, true);
            return;
        }

        if (pricingApi.hasCustomPricing(nextPricing)) {
            activePricing = pricingApi.savePricing(nextPricing);
        } else {
            pricingApi.clearPricing();
            activePricing = pricingApi.loadPricing();
        }
        updatePriceButtonLabel();
        closePricesModal();
        savePricesBtn.disabled = true;
        showFeedback('Spremam lokalne cijene i ponovno racunam ljestvicu...');

        try {
            await rebuildCurrentProjects();
            showFeedback(hasCustomPricing()
                ? 'Lokalne cijene su spremljene i ljestvica je ponovno izracunata u ovom pregledniku.'
                : 'Koriste se zadane cijene planera.');
        } catch (error) {
            showFeedback(error.message, true);
        } finally {
            savePricesBtn.disabled = false;
        }
    }

    function updateProjectsVoteData(projectId, payload) {
        [serverProjects, currentProjects].forEach(projects => {
            const project = projects.find(entry => Number(entry.id) === projectId);
            if (!project) return;
            project.upvotes = payload.upvotes;
            project.downvotes = payload.downvotes;
            project.vote_score = payload.vote_score;
            project.popularity = payload.vote_score;
        });
    }

    async function loadLeaderboard(sort, options = {}) {
        const { preserveContent = false } = options;
        if (!preserveContent) {
            contentDiv.innerHTML = '<div class="loading">Ucitavam...</div>';
        }

        try {
            const response = await fetch(`${API_BASE_URL}/transit/leaderboard?sort=${sort}`, { cache: 'no-store' });
            if (!response.ok) throw new Error(`Greska: ${response.status}`);
            const payload = await response.json();
            serverProjects = (Array.isArray(payload) ? payload : []).map(project => {
                cacheProjectDetail(project);
                return applyCachedProjectDetail(project);
            });
            updateTabCount('ranked', serverProjects.length);
        } catch (error) {
            contentDiv.innerHTML = `<div class="error">${error.message}</div>`;
            showFeedback('Ucitavanje ljestvice nije uspjelo.', true);
            return;
        }

        try {
            await rebuildCurrentProjects();
            showFeedback(hasCustomPricing()
                ? 'Prikazane su lokalne cijene spremljene u ovom pregledniku.'
                : '');
        } catch (error) {
            showFeedback(error.message, true);
        }
    }

    async function handleVote(projectId, direction) {
        if (pendingVotes.has(projectId)) return;
        if (getStoredVote(projectId) === direction) return;

        pendingVotes.add(projectId);
        renderLeaderboard();

        try {
            const response = await fetch(`${API_BASE_URL}/transit/projects/${projectId}/vote`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ direction }),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(payload.error || `Greska: ${response.status}`);
            }

            updateProjectsVoteData(projectId, payload);
            storeVote(projectId, direction);
            renderLeaderboard();
            showFeedback(direction === 'up' ? 'Glas za projekt je spremljen.' : 'Negativan glas je spremljen.');
        } catch (error) {
            showFeedback(error.message, true);
        } finally {
            pendingVotes.delete(projectId);
            renderLeaderboard();
        }
    }

    openPricesBtn?.addEventListener('click', () => openPricesModal());
    cancelPricesBtn?.addEventListener('click', () => closePricesModal());
    resetPricesBtn?.addEventListener('click', () => fillPricingForm(DEFAULT_PRICING));
    savePricesBtn?.addEventListener('click', () => savePricingSettings());
    pricesModal?.addEventListener('click', event => {
        if (event.target === pricesModal) {
            closePricesModal();
        }
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && pricesModal && !pricesModal.classList.contains('hidden')) {
            closePricesModal();
        }
    });

    updatePriceButtonLabel();
    if (backToPlannerLink) {
        const fromProjectId = new URLSearchParams(window.location.search).get('from');
        backToPlannerLink.href = fromProjectId
            ? getPlannerProjectHref(fromProjectId)
            : getPlannerBaseHref();
    }
    attachTabLink(tabRankedBtn, 'ranked');
    attachTabLink(tabUnrankedBtn, 'unranked');
    attachTabLink(tabExistingBtn, 'existing');
    setActiveTab(new URLSearchParams(window.location.search).get('tab'));
    prefetchInactiveTabCounts();

    window.addEventListener('popstate', () => {
        setActiveTab(new URLSearchParams(window.location.search).get('tab'));
    });

    // Reload data when browser restores page from bfcache (back/forward navigation)
    // so a project saved just before navigating here is visible immediately.
    window.addEventListener('pageshow', (event) => {
        if (event.persisted) {
            serverProjects = [];
            currentProjects = [];
            if (activeTab === 'unranked') loadUnranked();
            else if (activeTab === 'existing') loadExisting();
            else loadLeaderboard(currentSortKey, { preserveContent: true });
            prefetchInactiveTabCounts();
        }
    });
})();
