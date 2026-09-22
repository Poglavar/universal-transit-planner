// Pricing model for the transit planner. ONE cost model, driven by the discrete
// civil objects a route is made of (planner-grade/civil-objects.js): per-gauge
// base prices for track/station/depot at ground level, multiplied by what the
// object actually is — viaduct, embankment, cut or tunnel. Ground-level track
// has no multiplier because it IS the base.
//
// This replaced a per-segment integration over track "levels" with ±1 level
// multipliers. Levels could only say underground/surface/elevated, so a 6 m open
// cut and a 6 m embankment both priced as plain surface, and the number in the
// planner had no relationship to the list of structures it showed you.
//
// Shared between transit.js (planner), leaderboard.js (metrics + pricing editor)
// and scripts/backfill-project-costs.mjs (node). Object detection is resolved
// lazily off `root` (__civilObjects, __verticalProfile) exactly the way
// profile-strip.js resolves __profileRender, so node callers can inject them.
(function (root) {
    'use strict';

    const STORAGE_KEY = 'transit-pricing-v4';
    // Hand-typed per-object prices. Deliberately a SEPARATE key from the price
    // list: the price list is a model anyone can reproduce, these are one
    // person's opinion about one specific structure, and they never leave this
    // browser (nothing writes them to the server).
    const OBJECT_COST_STORAGE_KEY = 'transit-object-costs-v1';
    const MILLION = 1_000_000;
    const GAUGE_KEYS = Object.freeze(['monorail', 'g1000', 'g1435']);
    const GAUGE_MAX_INCLINE_PCT = Object.freeze({ monorail: 8, g1000: 6, g1435: 4 });

    const DEFAULT_PRICING = Object.freeze({
        monorailTrackPerKm: 12 * MILLION,
        monorailStation: 4 * MILLION,
        monorailDepot: 25 * MILLION,
        g1000TrackPerKm: 15 * MILLION,
        g1000Station: 5 * MILLION,
        g1000Depot: 30 * MILLION,
        g1435TrackPerKm: 20 * MILLION,
        g1435Station: 6 * MILLION,
        g1435Depot: 40 * MILLION,
        // × the ground-level price of the same gauge. Tunnel and viaduct keep
        // the numbers the retired level multipliers used, so a route that is all
        // tunnel still costs what it always did; cut and fill are new and sit
        // between plain surface and a structure.
        viaductMultiplier: 2.5,
        fillMultiplier: 1.3,
        cutMultiplier: 2,
        tunnelMultiplier: 8,
        transferLinkUnderground: 20 * MILLION,
        transferLinkOverground: 0,
    });
    // Multiplier keys hold small factors (not EUR amounts) and are sanitized as decimals.
    const MULTIPLIER_KEYS = Object.freeze(new Set([
        'viaductMultiplier', 'fillMultiplier', 'cutMultiplier', 'tunnelMultiplier',
    ]));
    // Object kind -> its multiplier field. 'at-grade' is absent on purpose: it is
    // the base price, so its multiplier is 1 by definition and not editable.
    const OBJECT_MULTIPLIER_KEYS = Object.freeze({
        viaduct: 'viaductMultiplier',
        fill: 'fillMultiplier',
        cut: 'cutMultiplier',
        tunnel: 'tunnelMultiplier',
    });
    // A station's structural form decides which object it is priced as — the
    // same forms getStationStructureKind() reports in the planner.
    const STATION_KIND_OBJECT = Object.freeze({
        tunnel: 'tunnel',
        covered: 'tunnel',      // still a box under the ground
        cut: 'cut',
        elevated: 'viaduct',
        surface: 'at-grade',
    });

    function buildGaugeFields(gaugeKey, icons) {
        return [
            {
                key: `${gaugeKey}TrackPerKm`,
                icon: icons.track,
                label: 'Trasa (na terenu)',
                unitLabel: 'mil. EUR/km',
                scale: MILLION,
                group: gaugeKey,
            },
            {
                key: `${gaugeKey}Station`,
                icon: '🏘️',
                label: 'Stanica (na terenu)',
                unitLabel: 'mil. EUR',
                scale: MILLION,
                group: gaugeKey,
            },
            {
                key: `${gaugeKey}Depot`,
                icon: '🏠',
                label: 'Remiza (na terenu)',
                unitLabel: 'mil. EUR',
                scale: MILLION,
                group: gaugeKey,
            },
            {
                key: `${gaugeKey}Vehicle`,
                icon: icons.vehicle,
                label: 'Vozilo',
                unitLabel: 'nije dostupno',
                scale: MILLION,
                group: gaugeKey,
                configurable: false,
            },
        ];
    }

    const MONORAIL_FIELDS = Object.freeze(buildGaugeFields('monorail', { track: '🚝', vehicle: '🚝' }));
    const G1000_FIELDS = Object.freeze(buildGaugeFields('g1000', { track: '🚊', vehicle: '🚋' }));
    const G1435_FIELDS = Object.freeze(buildGaugeFields('g1435', { track: '🚇', vehicle: '🚆' }));
    // One row per object kind the planner can detect, in the same vertical order
    // the object list uses, so the two screens read the same way.
    const OBJECT_FIELDS = Object.freeze([
        {
            key: 'viaductMultiplier',
            icon: '🌉',
            label: 'Vijadukt',
            unitLabel: '× cijena na terenu',
            scale: 1,
            group: 'object',
        },
        {
            key: 'fillMultiplier',
            icon: '🧱',
            label: 'Nasip',
            unitLabel: '× cijena na terenu',
            scale: 1,
            group: 'object',
        },
        {
            key: 'cutMultiplier',
            icon: '⛰️',
            label: 'Usjek',
            unitLabel: '× cijena na terenu',
            scale: 1,
            group: 'object',
        },
        {
            key: 'tunnelMultiplier',
            icon: '🚇',
            label: 'Tunel',
            unitLabel: '× cijena na terenu',
            scale: 1,
            group: 'object',
        },
        {
            key: 'atGradeMultiplier',
            icon: '🛤️',
            label: 'Ravni teren',
            unitLabel: '× cijena na terenu',
            scale: 1,
            group: 'object',
            configurable: false,
            // Not "coming soon" — fixed by definition. Ground-level track IS the
            // base price, so a settable multiplier here would let the price list
            // contradict its own basis.
            fixedValue: 1,
            fixedHelp: 'Osnovica — cijena trase na terenu je sama po sebi ×1.',
        },
    ]);
    const TRANSFER_FIELDS = Object.freeze([
        {
            key: 'transferLinkUnderground',
            icon: '🔗',
            label: 'Presjedanje (podzemno)',
            unitLabel: 'mil. EUR',
            scale: MILLION,
            group: 'transfer',
        },
        {
            key: 'transferLinkOverground',
            icon: '🔗',
            label: 'Presjedanje (nadzemno)',
            unitLabel: 'mil. EUR',
            scale: MILLION,
            group: 'transfer',
        },
    ]);
    const FIELD_GROUPS = Object.freeze([
        { key: 'monorail', title: '🚝 Monorail', fields: MONORAIL_FIELDS },
        { key: 'g1000', title: '🚊 Uskotračna (1000 mm)', fields: G1000_FIELDS },
        { key: 'g1435', title: '🚇 Normalna (1435 mm)', fields: G1435_FIELDS },
        { key: 'object', title: '🏗️ Po vrsti objekta', fields: OBJECT_FIELDS },
        { key: 'transfer', title: '🔗 Presjedanja', fields: TRANSFER_FIELDS },
    ]);
    const DISPLAY_FIELDS = Object.freeze(FIELD_GROUPS.flatMap(group => group.fields));
    const CONFIGURABLE_FIELDS = Object.freeze(DISPLAY_FIELDS.filter(f => f.configurable !== false));

    function sanitizePrice(key, rawValue, fallback) {
        const value = Number(rawValue);
        if (!Number.isFinite(value) || value < 0) {
            return fallback;
        }
        return MULTIPLIER_KEYS.has(key) ? Math.round(value * 100) / 100 : Math.round(value);
    }

    function sanitizePricing(rawPricing) {
        const raw = rawPricing && typeof rawPricing === 'object' ? rawPricing : {};
        const result = {};
        for (const key of Object.keys(DEFAULT_PRICING)) {
            result[key] = sanitizePrice(key, raw[key], DEFAULT_PRICING[key]);
        }
        return result;
    }

    function readStorage(key) {
        try {
            return localStorage.getItem(key);
        } catch (error) {
            return null;    // node, or a browser in private mode
        }
    }

    function writeStorage(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (error) {
            /* private mode — the setting just won't persist */
        }
    }

    function loadPricing() {
        const raw = readStorage(STORAGE_KEY);
        if (!raw) return sanitizePricing();
        try {
            return sanitizePricing(JSON.parse(raw));
        } catch (error) {
            return sanitizePricing();
        }
    }

    function savePricing(pricing) {
        const sanitized = sanitizePricing(pricing);
        writeStorage(STORAGE_KEY, JSON.stringify(sanitized));
        return sanitized;
    }

    function clearPricing() {
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch (error) {
            /* nothing to clear */
        }
    }

    function hasCustomPricing(pricing) {
        const candidate = sanitizePricing(pricing || loadPricing());
        return Object.keys(DEFAULT_PRICING).some(key => candidate[key] !== DEFAULT_PRICING[key]);
    }

    // ─── Hand-typed per-object prices (this browser only) ───────────────────
    // Stored as { scope: { objectKey: eur } }. The scope separates one saved
    // project's structures from another's, since object keys are only unique
    // within a project (they start with the track id).

    function objectCostScope(projectId) {
        return projectId == null || projectId === '' ? 'draft' : `project:${projectId}`;
    }

    function loadObjectCosts() {
        const raw = readStorage(OBJECT_COST_STORAGE_KEY);
        if (!raw) return {};
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (error) {
            return {};
        }
    }

    function getObjectCosts(scope) {
        const all = loadObjectCosts();
        const bucket = all[scope];
        if (!bucket || typeof bucket !== 'object') return {};
        const result = {};
        for (const [key, value] of Object.entries(bucket)) {
            const eur = Number(value);
            if (Number.isFinite(eur) && eur >= 0) result[key] = Math.round(eur);
        }
        return result;
    }

    function setObjectCost(scope, objectKey, costEur) {
        const eur = Number(costEur);
        if (!objectKey || !Number.isFinite(eur) || eur < 0) return getObjectCosts(scope);
        const all = loadObjectCosts();
        all[scope] = { ...(all[scope] || {}), [objectKey]: Math.round(eur) };
        writeStorage(OBJECT_COST_STORAGE_KEY, JSON.stringify(all));
        return getObjectCosts(scope);
    }

    function clearObjectCost(scope, objectKey) {
        const all = loadObjectCosts();
        if (all[scope]) {
            delete all[scope][objectKey];
            if (Object.keys(all[scope]).length === 0) delete all[scope];
            writeStorage(OBJECT_COST_STORAGE_KEY, JSON.stringify(all));
        }
        return getObjectCosts(scope);
    }

    function clearObjectCosts(scope) {
        const all = loadObjectCosts();
        delete all[scope];
        writeStorage(OBJECT_COST_STORAGE_KEY, JSON.stringify(all));
        return {};
    }

    function hasObjectCosts(scope) {
        return Object.keys(getObjectCosts(scope)).length > 0;
    }

    // ─── The model ──────────────────────────────────────────────────────────

    function normalizeGauge(rawGauge) {
        return GAUGE_KEYS.includes(rawGauge) ? rawGauge : 'g1000';
    }

    function normalizeStationKind(rawKind) {
        return Object.prototype.hasOwnProperty.call(STATION_KIND_OBJECT, rawKind)
            ? rawKind
            : 'surface';
    }

    // Ground-level track is the base, so its multiplier is exactly 1 and is not
    // a setting — making it one would let the price list contradict itself.
    function getObjectMultiplier(objectKind, pricing) {
        const candidate = sanitizePricing(pricing || loadPricing());
        const key = OBJECT_MULTIPLIER_KEYS[objectKind];
        if (!key) return 1;
        const value = Number(candidate[key]);
        return Number.isFinite(value) && value >= 0 ? value : 1;
    }

    // Base per-km price of a gauge at ground level.
    function getTrackBasePerKm(gauge, pricing) {
        const candidate = sanitizePricing(pricing || loadPricing());
        return candidate[`${normalizeGauge(gauge)}TrackPerKm`];
    }

    function getTrackUnitPricePerKm(gauge, objectKind, pricing) {
        const candidate = sanitizePricing(pricing || loadPricing());
        return getTrackBasePerKm(gauge, candidate) * getObjectMultiplier(objectKind, candidate);
    }

    function getStationUnitPrice(stationType, gauge, stationKind, pricing) {
        const candidate = sanitizePricing(pricing || loadPricing());
        const baseKey = stationType === 'depot'
            ? `${normalizeGauge(gauge)}Depot`
            : `${normalizeGauge(gauge)}Station`;
        const objectKind = STATION_KIND_OBJECT[normalizeStationKind(stationKind)];
        return candidate[baseKey] * getObjectMultiplier(objectKind, candidate);
    }

    function getTransferLinkPrice(linkType, pricing) {
        const candidate = sanitizePricing(pricing || loadPricing());
        return linkType === 'underground' ? candidate.transferLinkUnderground : candidate.transferLinkOverground;
    }

    // The rate table civil-objects.js prices against, for one gauge.
    function getObjectRates(gauge, pricing) {
        const candidate = sanitizePricing(pricing || loadPricing());
        const perMeterBase = getTrackBasePerKm(gauge, candidate) / 1000;
        const perMeterEur = { 'at-grade': perMeterBase };
        for (const kind of Object.keys(OBJECT_MULTIPLIER_KEYS)) {
            perMeterEur[kind] = perMeterBase * getObjectMultiplier(kind, candidate);
        }
        const stationEur = {};
        const depotEur = {};
        for (const kind of Object.keys(STATION_KIND_OBJECT)) {
            stationEur[kind] = getStationUnitPrice('normal', gauge, kind, candidate);
            depotEur[kind] = getStationUnitPrice('depot', gauge, kind, candidate);
        }
        const transferEur = {
            underground: getTransferLinkPrice('underground', candidate),
            overground: getTransferLinkPrice('overground', candidate),
        };
        return { perMeterEur, stationEur, depotEur, transferEur };
    }

    function normalizeLatLngTuple(value) {
        if (Array.isArray(value) && value.length >= 2) {
            const lat = Number(value[0]);
            const lng = Number(value[1]);
            if (Number.isFinite(lat) && Number.isFinite(lng)) {
                return [lat, lng];
            }
        }

        if (value && typeof value === 'object') {
            const lat = Number(value.lat);
            const lng = Number(value.lng);
            if (Number.isFinite(lat) && Number.isFinite(lng)) {
                return [lat, lng];
            }
        }

        return null;
    }

    function toRadians(value) {
        return value * Math.PI / 180;
    }

    function computeDistanceKm(left, right) {
        const earthRadiusKm = 6371;
        const latDelta = toRadians(right[0] - left[0]);
        const lngDelta = toRadians(right[1] - left[1]);
        const leftLat = toRadians(left[0]);
        const rightLat = toRadians(right[0]);
        const haversine = Math.sin(latDelta / 2) ** 2
            + Math.cos(leftLat) * Math.cos(rightLat) * Math.sin(lngDelta / 2) ** 2;
        return 2 * earthRadiusKm * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
    }

    function computePolylineLengthKm(latlngs) {
        let totalLengthKm = 0;
        let previousPoint = null;

        for (const point of Array.isArray(latlngs) ? latlngs : []) {
            const normalizedPoint = normalizeLatLngTuple(point);
            if (!normalizedPoint) continue;
            if (previousPoint) {
                totalLengthKm += computeDistanceKm(previousPoint, normalizedPoint);
            }
            previousPoint = normalizedPoint;
        }

        return totalLengthKm;
    }

    function vertexChainagesMeters(latlngs) {
        const out = [0];
        for (let i = 1; i < (latlngs || []).length; i++) {
            out.push(out[i - 1] + computeDistanceKm(latlngs[i - 1], latlngs[i]) * 1000);
        }
        return out;
    }

    // The structures on one track. A solved vertical profile gives all five
    // kinds; a track that only has levels gives the three it can express. The
    // caller may pass stationMarks to get the station rows too — costing does
    // NOT, because stations are priced individually and would double-count.
    function detectTrackObjects(track, options) {
        const civil = root.__civilObjects;
        if (!civil) return [];
        const opts = options || {};
        const latlngs = (Array.isArray(track?.latlngs) ? track.latlngs : [])
            .map(normalizeLatLngTuple)
            .filter(Boolean);
        if (latlngs.length < 2) return [];
        const chainagesM = vertexChainagesMeters(latlngs);
        const lengthM = chainagesM[chainagesM.length - 1];
        const shared = {
            lengthM,
            trackId: track.id,
            stationMarks: opts.stationMarks || [],
        };
        const vertical = root.__verticalProfile;
        const profile = vertical && track.verticalProfile
            ? vertical.parseVerticalProfile(track.verticalProfile)
            : null;
        if (profile) {
            return civil.detectTrackObjects({
                ...shared,
                profile,
                displayRegimes: vertical.displayRegimes(profile),
            });
        }
        const levels = Array.isArray(track?.levels) && track.levels.length === latlngs.length
            ? track.levels
            : latlngs.map(() => 0);
        return civil.detectTrackObjectsFromLevels({ ...shared, levels, chainagesM });
    }

    // Construction cost of one track: the sum of its structures. Stations are
    // priced separately by the caller (they are objects too, but they belong to
    // the station, not to the track under them).
    function computeTrackCostEur(track, pricing, overrides) {
        const civil = root.__civilObjects;
        if (!civil) return 0;
        const candidate = sanitizePricing(pricing || loadPricing());
        const rates = getObjectRates(track?.gauge, candidate);
        return detectTrackObjects(track).reduce(
            (sum, object) => sum + civil.objectCostEur(object, rates, overrides), 0,
        );
    }

    function mapLegacyType(rawType) {
        // Pre-v7 formats stored type: underground (metro) / overground (tram).
        return rawType === 'underground'
            ? { gauge: 'g1435', level: -1 }
            : { gauge: 'g1000', level: 0 };
    }

    // A saved station records its level; v12+ also records the structural form
    // the planner classified it as, which is the thing that prices it (a station
    // in an open cut is level 0 but costs more than one on flat ground).
    function stationKindFromLevel(level) {
        const normalized = Number(level);
        if (!Number.isFinite(normalized)) return 'surface';
        if (normalized <= -0.5) return 'tunnel';
        if (normalized >= 0.5) return 'elevated';
        return 'surface';
    }

    function normalizeProjectData(rawProjectData) {
        const rawStations = Array.isArray(rawProjectData?.stations) ? rawProjectData.stations : [];
        const rawTransferLinks = Array.isArray(rawProjectData?.transferLinks) ? rawProjectData.transferLinks : [];
        const version = Number(rawProjectData?.version) || 0;

        // v5+ has separate tracks; v4 and below embed geometry in lines
        const hasExplicitTracks = Array.isArray(rawProjectData?.tracks) && rawProjectData.tracks.length > 0;
        const rawTrackSource = hasExplicitTracks ? rawProjectData.tracks : (Array.isArray(rawProjectData?.lines) ? rawProjectData.lines : []);

        const tracks = rawTrackSource.map((track, index) => {
            const latlngs = Array.isArray(track?.latlngs)
                ? track.latlngs.map(normalizeLatLngTuple).filter(Boolean)
                : [];
            if (latlngs.length < 2) return null;
            const id = track?.id != null ? track.id : index + 1;
            if (version >= 7 || track?.gauge) {
                const levels = Array.isArray(track?.levels) && track.levels.length === latlngs.length
                    ? track.levels.map(Number)
                    : latlngs.map(() => 0);
                return {
                    id,
                    gauge: normalizeGauge(track?.gauge),
                    latlngs,
                    levels,
                    // v10+ carries the solved profile, which is what upgrades the
                    // objects from three kinds to five.
                    verticalProfile: track?.verticalProfile || null,
                };
            }
            const legacy = mapLegacyType(track?.type);
            return {
                id,
                gauge: legacy.gauge,
                latlngs,
                levels: latlngs.map(() => legacy.level),
                verticalProfile: null,
            };
        }).filter(Boolean);

        let lineToTrackIndex;
        if (hasExplicitTracks) {
            const rawLines = Array.isArray(rawProjectData?.lines) ? rawProjectData.lines : [];
            lineToTrackIndex = rawLines.map(line => {
                const idx = Number.isInteger(line?.trackIndex) ? line.trackIndex : 0;
                return idx >= 0 && idx < tracks.length ? idx : 0;
            });
        } else {
            lineToTrackIndex = tracks.map((_, i) => i);
        }

        return {
            tracks,
            stations: rawStations.map(station => {
                let trackIndex = Number.isInteger(station?.trackIndex) ? station.trackIndex : -1;
                if (trackIndex < 0) {
                    const lineIndex = Number(station?.lineIndex);
                    trackIndex = Number.isInteger(lineIndex) && lineIndex >= 0 && lineIndex < lineToTrackIndex.length
                        ? lineToTrackIndex[lineIndex] : 0;
                }
                const track = tracks[trackIndex] || tracks[0] || null;
                // v7 stations persist their level; legacy stations inherit the track's first level.
                const level = station?.level !== undefined
                    ? Number(station.level)
                    : (track ? Number(track.levels[0]) : 0);
                return {
                    stationType: station?.stationType === 'depot' ? 'depot' : 'normal',
                    gauge: track ? track.gauge : 'g1000',
                    stationKind: station?.structureKind
                        ? normalizeStationKind(station.structureKind)
                        : stationKindFromLevel(level),
                };
            }),
            transferLinks: rawTransferLinks.map(link => ({
                linkType: link?.linkType === 'underground' ? 'underground' : 'overground',
            })),
        };
    }

    function normalizeBaseMetric(rawValue) {
        const value = Number(rawValue);
        return Number.isFinite(value) && value >= 0 ? value : 0;
    }

    function computeProjectMetrics(projectData, baseMetrics, pricing, overrides) {
        const normalizedProjectData = normalizeProjectData(projectData);
        const candidatePricing = sanitizePricing(pricing || loadPricing());
        const normalizedMetrics = baseMetrics && typeof baseMetrics === 'object' ? baseMetrics : {};
        let totalLengthKm = 0;
        let totalCostEur = 0;

        normalizedProjectData.tracks.forEach(track => {
            totalLengthKm += computePolylineLengthKm(track.latlngs);
            totalCostEur += computeTrackCostEur(track, candidatePricing, overrides);
        });

        normalizedProjectData.stations.forEach(station => {
            totalCostEur += getStationUnitPrice(
                station.stationType, station.gauge, station.stationKind, candidatePricing,
            );
        });

        (normalizedProjectData.transferLinks || []).forEach(link => {
            totalCostEur += getTransferLinkPrice(link.linkType, candidatePricing);
        });

        const totalPopulation = normalizeBaseMetric(
            normalizedMetrics.totalPopulation ?? normalizedMetrics.total_population
        );
        const totalJobs = normalizeBaseMetric(
            normalizedMetrics.totalJobs ?? normalizedMetrics.total_jobs
        );

        return {
            totalLengthKm,
            totalCostEur,
            stationCount: normalizedProjectData.stations.length,
            transferLinkCount: (normalizedProjectData.transferLinks || []).length,
            costPerPerson: totalPopulation > 0 ? totalCostEur / totalPopulation : null,
            costPerJob: totalJobs > 0 ? totalCostEur / totalJobs : null,
        };
    }

    root.TransitPricing = Object.freeze({
        STORAGE_KEY,
        OBJECT_COST_STORAGE_KEY,
        MILLION,
        GAUGE_KEYS,
        GAUGE_MAX_INCLINE_PCT,
        DEFAULT_PRICING,
        CONFIGURABLE_FIELDS,
        DISPLAY_FIELDS,
        FIELD_GROUPS,
        OBJECT_FIELDS,
        TRANSFER_FIELDS,
        STATION_KIND_OBJECT,
        clearPricing,
        computePolylineLengthKm,
        computeProjectMetrics,
        computeTrackCostEur,
        detectTrackObjects,
        getObjectMultiplier,
        getObjectRates,
        getTrackBasePerKm,
        getTrackUnitPricePerKm,
        getStationUnitPrice,
        getTransferLinkPrice,
        hasCustomPricing,
        loadPricing,
        normalizeProjectData,
        savePricing,
        stationKindFromLevel,
        vertexChainagesMeters,
        // Hand-typed per-object prices (browser-local)
        objectCostScope,
        getObjectCosts,
        setObjectCost,
        clearObjectCost,
        clearObjectCosts,
        hasObjectCosts,
    });
}(typeof self !== 'undefined' ? self : this));
