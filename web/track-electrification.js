// Resolves OSM-compatible track electrification fields into one deterministic,
// DOM-free contract shared by the planner, OSM checker, and Station3D.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.__trackElectrification = api;
}(typeof self !== 'undefined' ? self : globalThis, function () {
    'use strict';

    const STATUS = Object.freeze({
        OVERHEAD: 'overhead',
        CONDUCTOR_RAIL: 'conductor-rail',
        NONE: 'none',
        UNKNOWN: 'unknown',
    });

    const STATUS_LABELS_HR = Object.freeze({
        [STATUS.OVERHEAD]: 'Kontaktni vod',
        [STATUS.CONDUCTOR_RAIL]: 'Treća tračnica',
        [STATUS.NONE]: 'Nije elektrificirana',
        [STATUS.UNKNOWN]: 'Nepoznato',
    });

    const PROVENANCE_LABELS_HR = Object.freeze({
        osm: 'OSM',
        authored: 'Autorski podatak',
        'network-default': 'Pretpostavljeno prema zadanoj vrijednosti mreže',
    });

    const MAP_STYLES = Object.freeze({
        [STATUS.OVERHEAD]: Object.freeze({ color: '#06b6d4', dashArray: null }),
        [STATUS.CONDUCTOR_RAIL]: Object.freeze({ color: '#f59e0b', dashArray: '10 5' }),
        [STATUS.NONE]: Object.freeze({ color: '#64748b', dashArray: null }),
        [STATUS.UNKNOWN]: Object.freeze({ color: '#991b1b', dashArray: '7 6' }),
    });

    function sourceTags(source) {
        return source && typeof source.tags === 'object' ? source.tags : {};
    }

    function sourceValue(source, key) {
        if (source && Object.prototype.hasOwnProperty.call(source, key)) return source[key];
        return sourceTags(source)[key];
    }

    function parseFiniteMeasurement(value, kind) {
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (typeof value !== 'string') return null;
        for (const candidate of value.split(';')) {
            const match = candidate.trim().replace(',', '.').match(
                /^([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s*(kv|v|hz)?$/i,
            );
            if (!match) continue;
            let number = Number(match[1]);
            if (!Number.isFinite(number)) continue;
            if (kind === 'voltage' && String(match[2] || '').toLowerCase() === 'kv') {
                number *= 1000;
            }
            return number;
        }
        return null;
    }

    function explicitStatus(value) {
        const normalized = String(value == null ? '' : value).trim().toLowerCase();
        if (normalized === 'contact_line') return STATUS.OVERHEAD;
        if (normalized === 'rail') return STATUS.CONDUCTOR_RAIL;
        if (normalized === 'no') return STATUS.NONE;
        if (normalized === 'yes') return STATUS.UNKNOWN;
        return null;
    }

    function resolve(source = {}, context = {}) {
        const rawElectrified = sourceValue(source, 'electrified');
        const status = explicitStatus(rawElectrified);
        const explicit = status !== null;
        const networkDefault = context.networkDefault || {};
        const defaultStatus = explicitStatus(sourceValue(networkDefault, 'electrified'));
        const usesNetworkDefault = !explicit && defaultStatus !== null;
        const provenance = explicit
            ? (context.provenance === 'authored' ? 'authored' : 'osm')
            : usesNetworkDefault
                ? 'network-default'
                : (context.provenance === 'authored' ? 'authored' : 'osm');
        return Object.freeze({
            status: explicit
                ? status
                : usesNetworkDefault ? defaultStatus : STATUS.UNKNOWN,
            voltageV: explicit
                ? parseFiniteMeasurement(sourceValue(source, 'voltage'), 'voltage')
                : usesNetworkDefault
                    ? parseFiniteMeasurement(sourceValue(networkDefault, 'voltage'), 'voltage')
                    : null,
            frequencyHz: explicit
                ? parseFiniteMeasurement(sourceValue(source, 'frequency'), 'frequency')
                : usesNetworkDefault
                    ? parseFiniteMeasurement(sourceValue(networkDefault, 'frequency'), 'frequency')
                    : null,
            provenance,
        });
    }

    function trackModeFor(source = {}, fallback = '') {
        const railway = String(
            sourceValue(source, 'railway_type')
            || sourceValue(source, 'railway')
            || fallback
            || '',
        ).toLowerCase();
        if (railway === 'tram' || source.gauge === 'g1000') return 'tram';
        if (railway === 'rail' || source.gauge === 'g1435') return 'rail';
        return railway || 'rail';
    }

    function resolveFeature(feature, context = {}) {
        const properties = feature?.properties || feature || {};
        return resolve(properties, {
            ...context,
            trackMode: context.trackMode || trackModeFor(properties),
        });
    }

    function finiteRangeValue(value) {
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function segmentAtDistance(source, distanceM) {
        const distance = Number(distanceM);
        if (!Number.isFinite(distance)) return null;
        const segments = Array.isArray(source?.electrificationSegments)
            ? source.electrificationSegments
            : [];
        return segments.find((segment, index) => {
            const fromM = finiteRangeValue(segment?.fromM);
            const toM = finiteRangeValue(segment?.toM);
            if (fromM == null || toM == null) return false;
            const last = index === segments.length - 1;
            return distance >= Math.min(fromM, toM)
                && (distance < Math.max(fromM, toM)
                    || (last && distance <= Math.max(fromM, toM)));
        }) || null;
    }

    function resolveAtDistance(source = {}, distanceM, context = {}) {
        const segment = segmentAtDistance(source, distanceM);
        return resolve(segment || source, context);
    }

    function normalizeAuthoredFields(source = {}) {
        const status = explicitStatus(sourceValue(source, 'electrified'));
        if (status === null) return Object.freeze({
            electrified: null,
            voltage: null,
            frequency: null,
        });
        const electrified = {
            [STATUS.OVERHEAD]: 'contact_line',
            [STATUS.CONDUCTOR_RAIL]: 'rail',
            [STATUS.NONE]: 'no',
            [STATUS.UNKNOWN]: 'yes',
        }[status];
        const voltageV = parseFiniteMeasurement(sourceValue(source, 'voltage'), 'voltage');
        const frequencyHz = parseFiniteMeasurement(sourceValue(source, 'frequency'), 'frequency');
        return Object.freeze({
            electrified,
            voltage: voltageV,
            frequency: frequencyHz,
        });
    }

    function normalizeElectrificationSegments(segments, lengthM = Infinity) {
        if (!Array.isArray(segments)) return Object.freeze([]);
        const maximum = Number.isFinite(Number(lengthM)) ? Math.max(0, Number(lengthM)) : Infinity;
        const normalized = segments.map((segment) => {
            const fromM = finiteRangeValue(segment?.fromM);
            const toM = finiteRangeValue(segment?.toM);
            if (fromM == null || toM == null || fromM === toM) return null;
            const start = Math.max(0, Math.min(fromM, toM));
            const end = Math.min(maximum, Math.max(fromM, toM));
            if (!(end > start)) return null;
            const fields = normalizeAuthoredFields(segment);
            return Object.freeze({
                fromM: start,
                toM: end,
                electrified: fields.electrified,
                voltage: fields.voltage,
                frequency: fields.frequency,
                source: typeof segment.source === 'string' ? segment.source : undefined,
            });
        }).filter(Boolean).sort((left, right) => left.fromM - right.fromM || left.toM - right.toM);
        return Object.freeze(normalized);
    }

    function sameSegmentFields(left, right, { includeSource = true } = {}) {
        const leftFields = normalizeAuthoredFields(left || {});
        const rightFields = normalizeAuthoredFields(right || {});
        return leftFields.electrified === rightFields.electrified
            && leftFields.voltage === rightFields.voltage
            && leftFields.frequency === rightFields.frequency
            && (!includeSource || left?.source === right?.source);
    }

    function coalesceElectrificationSegments(segments) {
        const result = [];
        for (const segment of segments || []) {
            const previous = result[result.length - 1];
            if (previous
                && Math.abs(previous.toM - segment.fromM) < 1e-6
                && sameSegmentFields(previous, segment)) {
                previous.toM = segment.toM;
                continue;
            }
            result.push({ ...segment });
        }
        return Object.freeze(result.map(segment => Object.freeze(segment)));
    }

    // Produces a complete, non-overlapping partition of a track. Exact saved
    // runs win; uncovered distance inherits the track-level fields.
    function partitionElectrificationSegments(segments, lengthM, fallback = {}) {
        const totalM = Math.max(0, Number(lengthM) || 0);
        if (!(totalM > 0)) return Object.freeze([]);
        const exact = normalizeElectrificationSegments(segments, totalM);
        const boundaries = [...new Set([
            0,
            totalM,
            ...exact.flatMap(segment => [segment.fromM, segment.toM]),
        ])].sort((left, right) => left - right);
        const fallbackFields = normalizeAuthoredFields(fallback);
        const partition = [];
        for (let index = 0; index < boundaries.length - 1; index++) {
            const fromM = boundaries[index];
            const toM = boundaries[index + 1];
            if (!(toM > fromM)) continue;
            const midpointM = (fromM + toM) / 2;
            const sourceSegment = segmentAtDistance(
                { electrificationSegments: exact },
                midpointM,
            );
            const fields = sourceSegment
                ? normalizeAuthoredFields(sourceSegment)
                : fallbackFields;
            partition.push({
                fromM,
                toM,
                electrified: fields.electrified,
                voltage: fields.voltage,
                frequency: fields.frequency,
                source: sourceSegment?.source
                    || (typeof fallback?.source === 'string' ? fallback.source : undefined),
            });
        }
        return coalesceElectrificationSegments(partition);
    }

    // Replaces only the requested chainage range. Existing sub-runs outside it
    // remain exact, while the edited range becomes one authored value.
    function applyElectrificationRange(
        segments,
        fromM,
        toM,
        fields,
        lengthM,
        fallback = {},
    ) {
        const totalM = Math.max(0, Number(lengthM) || 0);
        const startM = Math.max(0, Math.min(totalM, Number(fromM) || 0));
        const endM = Math.max(0, Math.min(totalM, Number(toM) || 0));
        const rangeFromM = Math.min(startM, endM);
        const rangeToM = Math.max(startM, endM);
        const current = partitionElectrificationSegments(segments, totalM, fallback);
        if (!(rangeToM > rangeFromM)) return current;
        const editFields = normalizeAuthoredFields(fields);
        const boundaries = [...new Set([
            0,
            totalM,
            rangeFromM,
            rangeToM,
            ...current.flatMap(segment => [segment.fromM, segment.toM]),
        ])].sort((left, right) => left - right);
        const updated = [];
        for (let index = 0; index < boundaries.length - 1; index++) {
            const intervalFromM = boundaries[index];
            const intervalToM = boundaries[index + 1];
            if (!(intervalToM > intervalFromM)) continue;
            const midpointM = (intervalFromM + intervalToM) / 2;
            const edited = midpointM >= rangeFromM && midpointM < rangeToM;
            const existing = segmentAtDistance(
                { electrificationSegments: current },
                midpointM,
            );
            const selectedFields = edited
                ? editFields
                : normalizeAuthoredFields(existing || {});
            updated.push({
                fromM: intervalFromM,
                toM: intervalToM,
                electrified: selectedFields.electrified,
                voltage: selectedFields.voltage,
                frequency: selectedFields.frequency,
                source: edited ? 'authored' : existing?.source,
            });
        }
        return coalesceElectrificationSegments(updated);
    }

    function summarizeElectrificationSegments(segments, lengthM, fallback = {}) {
        const partition = partitionElectrificationSegments(segments, lengthM, fallback);
        const lengthsM = {
            overhead: 0,
            conductorRail: 0,
            none: 0,
            unknown: 0,
        };
        for (const segment of partition) {
            const length = segment.toM - segment.fromM;
            const status = explicitStatus(segment.electrified) || STATUS.UNKNOWN;
            if (status === STATUS.OVERHEAD) lengthsM.overhead += length;
            else if (status === STATUS.CONDUCTOR_RAIL) lengthsM.conductorRail += length;
            else if (status === STATUS.NONE) lengthsM.none += length;
            else lengthsM.unknown += length;
        }
        const totalM = Object.values(lengthsM).reduce((sum, length) => sum + length, 0);
        const active = Object.entries(lengthsM).filter(([, length]) => length > 1e-6);
        const status = active.length === 1
            ? ({
                overhead: STATUS.OVERHEAD,
                conductorRail: STATUS.CONDUCTOR_RAIL,
                none: STATUS.NONE,
                unknown: STATUS.UNKNOWN,
            }[active[0][0]])
            : 'mixed';
        return Object.freeze({
            status,
            totalM,
            electrifiedM: lengthsM.overhead + lengthsM.conductorRail,
            ...lengthsM,
        });
    }

    function remapChainage(distanceM, oldChainages, newChainages) {
        const oldValues = Array.isArray(oldChainages) ? oldChainages.map(Number) : [];
        const newValues = Array.isArray(newChainages) ? newChainages.map(Number) : [];
        if (oldValues.length < 2 || oldValues.length !== newValues.length) {
            return Number(distanceM) || 0;
        }
        const oldTotalM = oldValues[oldValues.length - 1] || 0;
        const targetM = Math.max(0, Math.min(oldTotalM, Number(distanceM) || 0));
        let edgeIndex = oldValues.length - 2;
        for (let index = 0; index < oldValues.length - 1; index++) {
            if (targetM <= oldValues[index + 1] + 1e-6) {
                edgeIndex = index;
                break;
            }
        }
        const oldSpanM = oldValues[edgeIndex + 1] - oldValues[edgeIndex];
        const ratio = oldSpanM > 1e-9
            ? (targetM - oldValues[edgeIndex]) / oldSpanM
            : 0;
        return newValues[edgeIndex]
            + ratio * (newValues[edgeIndex + 1] - newValues[edgeIndex]);
    }

    // Used after moving a geometry node. A boundary at that node stays at the
    // node; a finer imported boundary keeps its fractional position on its edge.
    function remapElectrificationSegments(segments, oldChainages, newChainages) {
        const totalM = Number(newChainages?.[newChainages.length - 1]) || 0;
        return normalizeElectrificationSegments((segments || []).map(segment => ({
            ...segment,
            fromM: remapChainage(segment.fromM, oldChainages, newChainages),
            toM: remapChainage(segment.toM, oldChainages, newChainages),
        })), totalM);
    }

    // Removing one node joins its two adjacent edges. Boundaries inside that
    // span retain their relative position; later boundaries shift by the exact
    // difference between the old two-edge path and the new chord.
    function remapElectrificationSegmentsAfterVertexRemoval(
        segments,
        oldChainages,
        newChainages,
        removedIndex,
    ) {
        const oldValues = Array.isArray(oldChainages) ? oldChainages.map(Number) : [];
        const newValues = Array.isArray(newChainages) ? newChainages.map(Number) : [];
        const index = Number(removedIndex);
        if (!Number.isInteger(index)
            || index <= 0
            || index >= oldValues.length - 1
            || newValues.length !== oldValues.length - 1) {
            return normalizeElectrificationSegments(segments, newValues.at(-1));
        }
        const oldFromM = oldValues[index - 1];
        const oldToM = oldValues[index + 1];
        const newFromM = newValues[index - 1];
        const newToM = newValues[index];
        const mapDistance = (rawDistanceM) => {
            const distanceM = Number(rawDistanceM) || 0;
            if (distanceM <= oldFromM) return distanceM;
            if (distanceM >= oldToM) return distanceM + (newToM - oldToM);
            const oldSpanM = oldToM - oldFromM;
            const ratio = oldSpanM > 1e-9 ? (distanceM - oldFromM) / oldSpanM : 0;
            return newFromM + ratio * (newToM - newFromM);
        };
        return normalizeElectrificationSegments((segments || []).map(segment => ({
            ...segment,
            fromM: mapDistance(segment.fromM),
            toM: mapDistance(segment.toM),
        })), newValues[newValues.length - 1]);
    }

    function authoredDefaultFields(gauge) {
        return String(gauge) === 'g1000'
            ? Object.freeze({ electrified: 'contact_line', voltage: null, frequency: null })
            : Object.freeze({ electrified: null, voltage: null, frequency: null });
    }

    function fieldsForAuthoredChoice(choice) {
        const normalized = String(choice || '').trim().toLowerCase();
        if (normalized === 'contact_line') {
            return Object.freeze({ electrified: 'contact_line', voltage: null, frequency: null });
        }
        if (normalized === 'no') {
            return Object.freeze({ electrified: 'no', voltage: null, frequency: null });
        }
        return Object.freeze({ electrified: 'yes', voltage: null, frequency: null });
    }

    function shouldRenderOverhead(resolved) {
        return resolved?.status === STATUS.OVERHEAD;
    }

    function statusLabelHr(status) {
        return STATUS_LABELS_HR[status] || STATUS_LABELS_HR[STATUS.UNKNOWN];
    }

    function provenanceLabelHr(provenance) {
        return PROVENANCE_LABELS_HR[provenance] || PROVENANCE_LABELS_HR.osm;
    }

    function mapStyle(status) {
        return MAP_STYLES[status] || MAP_STYLES[STATUS.UNKNOWN];
    }

    return Object.freeze({
        STATUS,
        STATUS_LABELS_HR,
        PROVENANCE_LABELS_HR,
        MAP_STYLES,
        parseFiniteMeasurement,
        explicitStatus,
        resolve,
        resolveFeature,
        resolveAtDistance,
        segmentAtDistance,
        trackModeFor,
        normalizeAuthoredFields,
        normalizeElectrificationSegments,
        partitionElectrificationSegments,
        applyElectrificationRange,
        summarizeElectrificationSegments,
        remapElectrificationSegments,
        remapElectrificationSegmentsAfterVertexRemoval,
        authoredDefaultFields,
        fieldsForAuthoredChoice,
        shouldRenderOverhead,
        statusLabelHr,
        provenanceLabelHr,
        mapStyle,
    });
}));
