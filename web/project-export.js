// Portable export for one saved transit project.
//
// Geometry uses RFC 7946 GeoJSON with the conventional third coordinate for
// elevation. The horizontal CRS is OGC:CRS84 (longitude, latitude); saved
// project heights are orthometric metres above sea level, stated explicitly as
// a foreign GeoJSON member so they are never mistaken for ellipsoidal height.
// Service topology has no useful GeoJSON primitive, so it lives in lines.json
// and refers to stable feature ids from the two GeoJSON files.
//
// UMD: leaderboard.html gets window.__transitProjectExport; node tests require
// the same pure implementation. No DOM, fetch or external ZIP dependency.
(function (root, factory) {
    let verticalProfileApi = root && root.__verticalProfile;
    if (!verticalProfileApi && typeof module === 'object' && module.exports) {
        verticalProfileApi = require('./planner-grade/vertical-profile.js');
    }
    const api = factory(verticalProfileApi);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.__transitProjectExport = api;
}(typeof self !== 'undefined' ? self : this, function (verticalProfileApi) {
    'use strict';

    const EARTH_RADIUS_M = 6371000;
    const ZIP_UTF8_FLAG = 0x0800;
    const ZIP_STORE_METHOD = 0;
    const GAUGE_MM = Object.freeze({ g1000: 1000, g1435: 1435 });

    function finiteOrNull(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (typeof value === 'string' && value.trim() !== '') {
            const number = Number(value);
            return Number.isFinite(number) ? number : null;
        }
        return null;
    }

    function integerOrNull(value) {
        const number = Number(value);
        return Number.isInteger(number) ? number : null;
    }

    function normalizedLatLng(value) {
        if (!Array.isArray(value) || value.length < 2) return null;
        const lat = finiteOrNull(value[0]);
        const lon = finiteOrNull(value[1]);
        if (lat === null || lon === null) return null;
        return { lat, lon, elevationM: finiteOrNull(value[2]) };
    }

    function parseProjectData(projectRecord) {
        const raw = projectRecord?.project_data ?? projectRecord?.projectData ?? projectRecord;
        if (typeof raw === 'string') {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') throw new Error('Projekt nema valjane podatke.');
            return parsed;
        }
        if (!raw || typeof raw !== 'object') throw new Error('Projekt nema valjane podatke.');
        return raw;
    }

    function slugify(value) {
        return String(value || '')
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 72);
    }

    function trackFeatureId(index) {
        return `track-${index + 1}`;
    }

    function stationFeatureId(index) {
        return `station-${index + 1}`;
    }

    function lineId(index) {
        return `line-${index + 1}`;
    }

    function validTrackSource(projectData) {
        const explicit = Array.isArray(projectData.tracks) ? projectData.tracks : [];
        if (explicit.length > 0) return { tracks: explicit, explicit: true };
        const legacyLines = Array.isArray(projectData.lines) ? projectData.lines : [];
        return { tracks: legacyLines, explicit: false };
    }

    function profileForTrack(track) {
        if (!track?.verticalProfile || !verticalProfileApi?.parseVerticalProfile) return null;
        return verticalProfileApi.parseVerticalProfile(track.verticalProfile);
    }

    function vertexChainages(latlngs) {
        if (verticalProfileApi?.vertexChainagesMeters) {
            return verticalProfileApi.vertexChainagesMeters(latlngs);
        }
        const radians = Math.PI / 180;
        const chainages = [0];
        for (let index = 1; index < latlngs.length; index += 1) {
            const from = normalizedLatLng(latlngs[index - 1]);
            const to = normalizedLatLng(latlngs[index]);
            if (!from || !to) {
                chainages.push(chainages[index - 1]);
                continue;
            }
            const dLat = (to.lat - from.lat) * radians;
            const dLon = (to.lon - from.lon) * radians;
            const h = Math.sin(dLat / 2) ** 2
                + Math.cos(from.lat * radians) * Math.cos(to.lat * radians)
                    * Math.sin(dLon / 2) ** 2;
            chainages.push(chainages[index - 1]
                + 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h)));
        }
        return chainages;
    }

    function elevationAtChainage(profile, chainageM) {
        if (!profile || !verticalProfileApi?.elevAtChainage) return null;
        return finiteOrNull(verticalProfileApi.elevAtChainage(profile, chainageM));
    }

    function geoJsonPosition(point, elevationM) {
        return elevationM === null
            ? [point.lon, point.lat]
            : [point.lon, point.lat, elevationM];
    }

    function exportedVerticalProfile(profile) {
        if (!profile) return null;
        return {
            vertical_datum: profile.datum === 'asl' ? 'mean_sea_level' : profile.datum,
            input_revision: profile.inputRevision,
            sample_step_m: profile.stepM,
            profile_length_m: finiteOrNull(profile.pvis.at(-1)?.dM),
            profile_nodes: profile.pvis.map(point => ({
                chainage_m: point.dM,
                elevation_m_asl: point.elevAslM,
                locked: !!point.locked,
            })),
            rail_elevation_m_asl_by_sample: profile.elevAslM.slice(),
            terrain_elevation_m_asl_by_sample: Array.isArray(profile.terrainAslM)
                ? profile.terrainAslM.slice() : null,
            regime_by_sample: profile.regimes.slice(),
            structure_constraints: Array.isArray(profile.structureConstraints)
                ? profile.structureConstraints.map(constraint => ({ ...constraint })) : [],
            violations: Array.isArray(profile.violations)
                ? profile.violations.map(violation => ({ ...violation })) : [],
        };
    }

    function trackFeature(track, index) {
        const points = (track?.latlngs || []).map(normalizedLatLng).filter(Boolean);
        if (points.length < 2) return null;
        const sourceLatLngs = points.map(point => [point.lat, point.lon]);
        const chainages = vertexChainages(sourceLatLngs);
        const profile = profileForTrack(track);
        let elevatedNodeCount = 0;
        const coordinates = points.map((point, pointIndex) => {
            const savedElevation = point.elevationM;
            const profileElevation = elevationAtChainage(profile, chainages[pointIndex]);
            const elevationM = profileElevation ?? savedElevation;
            if (elevationM !== null) elevatedNodeCount += 1;
            return geoJsonPosition(point, elevationM);
        });
        const gauge = String(track?.gauge || (track?.type === 'underground'
            ? 'g1435' : track?.type === 'overground' ? 'g1000' : ''));
        const levels = Array.isArray(track?.levels)
            ? track.levels.map(value => finiteOrNull(value))
            : track?.type === 'underground' ? points.map(() => -1)
                : track?.type === 'overground' ? points.map(() => 0) : null;
        const properties = {
            track_index: index,
            gauge: gauge || null,
            gauge_mm: GAUGE_MM[gauge] ?? null,
            track_count: finiteOrNull(track?.trackCount),
            track_arrangement: track?.trackArrangement ?? null,
            level_by_node: levels,
            legacy_type: track?.type ?? null,
            electrified: typeof track?.electrified === 'boolean' ? track.electrified : null,
            voltage_v: finiteOrNull(track?.voltage),
            frequency_hz: finiteOrNull(track?.frequency),
            electrification_segments: Array.isArray(track?.electrificationSegments)
                ? track.electrificationSegments.map(segment => ({ ...segment })) : [],
            reference: track?.reference && typeof track.reference === 'object'
                ? { ...track.reference } : null,
            elevation_source: profile
                ? 'saved_vertical_profile'
                : elevatedNodeCount > 0 ? 'coordinate_z' : 'unavailable',
            vertical_datum: profile ? 'mean_sea_level' : null,
            vertical_profile: exportedVerticalProfile(profile),
        };
        return {
            type: 'Feature',
            id: trackFeatureId(index),
            geometry: { type: 'LineString', coordinates },
            properties,
            elevatedNodeCount,
        };
    }

    function lineTrackIndex(line, lineIndex, trackCount, hasExplicitTracks) {
        if (!hasExplicitTracks) return lineIndex < trackCount ? lineIndex : null;
        const requested = integerOrNull(line?.trackIndex);
        if (requested !== null && requested >= 0 && requested < trackCount) return requested;
        return trackCount === 1 ? 0 : null;
    }

    function stationTrackIndex(station, stationIndex, lines, trackCount, hasExplicitTracks) {
        const requested = integerOrNull(station?.trackIndex);
        if (requested !== null && requested >= 0 && requested < trackCount) return requested;
        const stationLineIndex = integerOrNull(station?.lineIndex);
        if (stationLineIndex !== null && stationLineIndex >= 0 && stationLineIndex < lines.length) {
            return lineTrackIndex(
                lines[stationLineIndex],
                stationLineIndex,
                trackCount,
                hasExplicitTracks,
            );
        }
        return trackCount === 1 ? 0 : null;
    }

    // Chainage of a point projected to the nearest segment of a WGS84 polyline.
    // The local metric projection is centred on the point, so the approximation
    // is sub-centimetre over a station footprint and avoids any GIS dependency.
    function pointChainageOnTrack(latlngs, stationLatLng) {
        const station = normalizedLatLng(stationLatLng);
        const points = (latlngs || []).map(normalizedLatLng).filter(Boolean);
        if (!station || points.length < 2) return null;
        const radians = Math.PI / 180;
        const cosLat = Math.cos(station.lat * radians);
        const metric = points.map(point => ({
            x: (point.lon - station.lon) * radians * EARTH_RADIUS_M * cosLat,
            y: (point.lat - station.lat) * radians * EARTH_RADIUS_M,
        }));
        const chainages = vertexChainages(points.map(point => [point.lat, point.lon]));
        let best = null;
        for (let index = 0; index < metric.length - 1; index += 1) {
            const from = metric[index];
            const to = metric[index + 1];
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const lengthSq = dx * dx + dy * dy;
            const t = lengthSq > 1e-9
                ? Math.max(0, Math.min(1, -(from.x * dx + from.y * dy) / lengthSq))
                : 0;
            const x = from.x + dx * t;
            const y = from.y + dy * t;
            const distanceSq = x * x + y * y;
            if (best && best.distanceSq <= distanceSq) continue;
            best = {
                distanceSq,
                chainageM: chainages[index]
                    + (chainages[index + 1] - chainages[index]) * t,
            };
        }
        return best?.chainageM ?? null;
    }

    function lineStationIndices(line, lineIndex, stations) {
        const explicit = Array.isArray(line?.stationIndices)
            ? line.stationIndices.filter(index => Number.isInteger(index)
                && index >= 0 && index < stations.length)
            : [];
        if (explicit.length > 0) return explicit;
        return stations.flatMap((station, stationIndex) => (
            integerOrNull(station?.lineIndex) === lineIndex ? [stationIndex] : []
        ));
    }

    function stationLineIds(stationIndex, station, lines, stations) {
        const ids = [];
        const directLineIndex = integerOrNull(station?.lineIndex);
        if (directLineIndex !== null && directLineIndex >= 0 && directLineIndex < lines.length) {
            ids.push(lineId(directLineIndex));
        }
        lines.forEach((line, lineIndex) => {
            if (lineStationIndices(line, lineIndex, stations).includes(stationIndex)) {
                ids.push(lineId(lineIndex));
            }
        });
        return [...new Set(ids)];
    }

    function stationFeature(station, index, context) {
        const point = normalizedLatLng(station?.latlng ?? station?.latLng);
        if (!point) return null;
        const trackIndex = stationTrackIndex(
            station,
            index,
            context.lines,
            context.tracks.length,
            context.hasExplicitTracks,
        );
        const track = trackIndex === null ? null : context.tracks[trackIndex];
        const profile = profileForTrack(track);
        const chainageM = track
            ? pointChainageOnTrack(track.latlngs, [point.lat, point.lon]) : null;
        const explicitElevationM = finiteOrNull(
            station?.elevationM ?? station?.elevM ?? point.elevationM,
        );
        const profileElevationM = chainageM === null
            ? null : elevationAtChainage(profile, chainageM);
        const elevationM = profileElevationM ?? explicitElevationM;
        return {
            type: 'Feature',
            id: stationFeatureId(index),
            geometry: {
                type: 'Point',
                coordinates: geoJsonPosition(point, elevationM),
            },
            properties: {
                station_index: index,
                name: station?.name == null || station.name === '' ? null : String(station.name),
                station_type: station?.stationType ?? null,
                structure_kind: station?.structureKind ?? null,
                level: finiteOrNull(station?.level),
                auto_named: typeof station?.autoNamed === 'boolean' ? station.autoNamed : null,
                track_id: trackIndex === null ? null : trackFeatureId(trackIndex),
                line_ids: stationLineIds(index, station, context.lines, context.stations),
                chainage_m: chainageM,
                elevation_m_asl: elevationM,
                elevation_source: profileElevationM !== null
                    ? 'saved_vertical_profile'
                    : explicitElevationM !== null ? 'coordinate_or_station_field' : 'unavailable',
                vertical_datum: elevationM === null ? null : 'mean_sea_level',
            },
            hasElevation: elevationM !== null,
        };
    }

    function foreignGeoJsonMetadata(projectRecord, projectData, generatedAt) {
        return {
            format: 'RFC 7946 GeoJSON',
            horizontal_crs: 'OGC:CRS84',
            coordinate_order: ['longitude', 'latitude', 'elevation_m'],
            vertical_datum: 'mean_sea_level where a third coordinate is present',
            project_id: projectRecord?.id ?? null,
            project_name: projectRecord?.author_name ?? null,
            source_project_version: projectData?.version ?? null,
            generated_at: generatedAt,
        };
    }

    function buildLinesDocument(projectRecord, projectData, context, generatedAt) {
        const lineDocuments = context.lines.map((line, index) => {
            const trackIndex = lineTrackIndex(
                line,
                index,
                context.tracks.length,
                context.hasExplicitTracks,
            );
            const stationIndices = lineStationIndices(line, index, context.stations);
            const depotIndex = integerOrNull(line?.depotStationIndex);
            return {
                id: lineId(index),
                line_index: index,
                name: line?.name == null ? null : String(line.name),
                color: line?.color == null ? null : String(line.color),
                track_id: trackIndex === null ? null : trackFeatureId(trackIndex),
                station_ids: stationIndices.map(stationFeatureId),
                depot_station_id: depotIndex !== null
                    && depotIndex >= 0 && depotIndex < context.stations.length
                    ? stationFeatureId(depotIndex) : null,
                vehicle_count: finiteOrNull(line?.trainCount),
            };
        });
        const transferLinks = (Array.isArray(projectData.transferLinks)
            ? projectData.transferLinks : []).flatMap((link, index) => {
            const fromIndex = integerOrNull(link?.stationAIndex);
            const toIndex = integerOrNull(link?.stationBIndex);
            if (fromIndex === null || toIndex === null
                || fromIndex < 0 || toIndex < 0
                || fromIndex >= context.stations.length || toIndex >= context.stations.length) {
                return [];
            }
            return [{
                id: `transfer-${index + 1}`,
                from_station_id: stationFeatureId(fromIndex),
                to_station_id: stationFeatureId(toIndex),
                link_type: link?.linkType ?? null,
            }];
        });
        return {
            type: 'TransitNetwork',
            format: 'universal-transit-planner project',
            format_version: 1,
            generated_at: generatedAt,
            project: {
                id: projectRecord?.id ?? null,
                name: projectRecord?.author_name ?? null,
                source_project_version: projectData?.version ?? null,
                purpose: projectData?.purpose ?? null,
                access: projectData?.access ?? null,
                reference_kind: projectData?.referenceKind ?? null,
                location: projectData?.location ?? projectRecord?.location ?? null,
                walk_minutes: finiteOrNull(projectData?.walkMinutes),
                created_at: projectRecord?.created_at ?? null,
                provenance: projectData?.provenance ?? null,
            },
            coordinate_reference_system: {
                horizontal: 'OGC:CRS84',
                vertical: 'mean_sea_level where elevation is available',
                units: 'degrees, degrees, metres',
            },
            files: {
                tracks: 'tracks.geojson',
                stations: 'stations.geojson',
            },
            tracks: context.tracks.map((track, index) => ({
                id: trackFeatureId(index),
                feature_id: trackFeatureId(index),
            })),
            stations: context.stations.map((station, index) => ({
                id: stationFeatureId(index),
                feature_id: stationFeatureId(index),
            })),
            lines: lineDocuments,
            transfer_links: transferLinks,
        };
    }

    function jsonFile(name, value) {
        return {
            name,
            mimeType: name.endsWith('.geojson') ? 'application/geo+json' : 'application/json',
            text: `${JSON.stringify(value, null, 2)}\n`,
        };
    }

    function createProjectExportFiles(projectRecord, options = {}) {
        const projectData = parseProjectData(projectRecord);
        const generatedAt = options.generatedAt instanceof Date
            ? options.generatedAt.toISOString()
            : String(options.generatedAt || new Date().toISOString());
        const { tracks, explicit: hasExplicitTracks } = validTrackSource(projectData);
        const lines = Array.isArray(projectData.lines) ? projectData.lines : [];
        const stations = Array.isArray(projectData.stations) ? projectData.stations : [];
        const context = { tracks, lines, stations, hasExplicitTracks };

        const builtTrackFeatures = tracks.map(trackFeature).filter(Boolean);
        const builtStationFeatures = stations.map((station, index) => (
            stationFeature(station, index, context)
        )).filter(Boolean);
        const metadata = foreignGeoJsonMetadata(projectRecord, projectData, generatedAt);
        const tracksGeoJson = {
            type: 'FeatureCollection',
            name: 'tracks',
            ...metadata,
            features: builtTrackFeatures.map(({ elevatedNodeCount, ...feature }) => feature),
        };
        const stationsGeoJson = {
            type: 'FeatureCollection',
            name: 'stations',
            ...metadata,
            features: builtStationFeatures.map(({ hasElevation, ...feature }) => feature),
        };
        const linesDocument = buildLinesDocument(
            projectRecord,
            projectData,
            context,
            generatedAt,
        );
        return {
            files: [
                jsonFile('tracks.geojson', tracksGeoJson),
                jsonFile('stations.geojson', stationsGeoJson),
                jsonFile('lines.json', linesDocument),
            ],
            summary: {
                trackCount: builtTrackFeatures.length,
                stationCount: builtStationFeatures.length,
                lineCount: linesDocument.lines.length,
                tracksWithoutElevation: builtTrackFeatures.filter(feature => (
                    feature.elevatedNodeCount < feature.geometry.coordinates.length
                )).length,
                stationsWithoutElevation: builtStationFeatures.filter(feature => (
                    !feature.hasElevation
                )).length,
            },
        };
    }

    let crcTable = null;
    function getCrcTable() {
        if (crcTable) return crcTable;
        crcTable = new Uint32Array(256);
        for (let index = 0; index < 256; index += 1) {
            let value = index;
            for (let bit = 0; bit < 8; bit += 1) {
                value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
            }
            crcTable[index] = value >>> 0;
        }
        return crcTable;
    }

    function crc32(bytes) {
        const table = getCrcTable();
        let crc = 0xffffffff;
        for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
        return (crc ^ 0xffffffff) >>> 0;
    }

    function dosTimestamp(date) {
        const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
        return {
            time: (date.getUTCHours() << 11)
                | (date.getUTCMinutes() << 5)
                | Math.floor(date.getUTCSeconds() / 2),
            date: ((year - 1980) << 9)
                | ((date.getUTCMonth() + 1) << 5)
                | date.getUTCDate(),
        };
    }

    function copyBytes(target, offset, source) {
        target.set(source, offset);
        return offset + source.length;
    }

    // A standards-compliant ZIP using the STORE method. Its purpose is one
    // portable click for three already compact text files; avoiding a bundled
    // compressor keeps the exporter dependency-free and auditable.
    function createStoredZip(files, modifiedAt = new Date()) {
        const encoder = new TextEncoder();
        const timestamp = dosTimestamp(modifiedAt);
        const entries = files.map(file => {
            const nameBytes = encoder.encode(String(file.name));
            const dataBytes = file.bytes instanceof Uint8Array
                ? file.bytes : encoder.encode(String(file.text ?? ''));
            if (nameBytes.length > 0xffff || dataBytes.length > 0xffffffff) {
                throw new Error('Datoteka je prevelika za ovaj ZIP izvoz.');
            }
            return {
                nameBytes,
                dataBytes,
                crc: crc32(dataBytes),
                localOffset: 0,
            };
        });
        const localSize = entries.reduce((sum, entry) => (
            sum + 30 + entry.nameBytes.length + entry.dataBytes.length
        ), 0);
        const centralSize = entries.reduce((sum, entry) => (
            sum + 46 + entry.nameBytes.length
        ), 0);
        const output = new Uint8Array(localSize + centralSize + 22);
        const view = new DataView(output.buffer);
        let offset = 0;

        for (const entry of entries) {
            entry.localOffset = offset;
            view.setUint32(offset, 0x04034b50, true); offset += 4;
            view.setUint16(offset, 20, true); offset += 2;
            view.setUint16(offset, ZIP_UTF8_FLAG, true); offset += 2;
            view.setUint16(offset, ZIP_STORE_METHOD, true); offset += 2;
            view.setUint16(offset, timestamp.time, true); offset += 2;
            view.setUint16(offset, timestamp.date, true); offset += 2;
            view.setUint32(offset, entry.crc, true); offset += 4;
            view.setUint32(offset, entry.dataBytes.length, true); offset += 4;
            view.setUint32(offset, entry.dataBytes.length, true); offset += 4;
            view.setUint16(offset, entry.nameBytes.length, true); offset += 2;
            view.setUint16(offset, 0, true); offset += 2;
            offset = copyBytes(output, offset, entry.nameBytes);
            offset = copyBytes(output, offset, entry.dataBytes);
        }

        const centralOffset = offset;
        for (const entry of entries) {
            view.setUint32(offset, 0x02014b50, true); offset += 4;
            view.setUint16(offset, 20, true); offset += 2;
            view.setUint16(offset, 20, true); offset += 2;
            view.setUint16(offset, ZIP_UTF8_FLAG, true); offset += 2;
            view.setUint16(offset, ZIP_STORE_METHOD, true); offset += 2;
            view.setUint16(offset, timestamp.time, true); offset += 2;
            view.setUint16(offset, timestamp.date, true); offset += 2;
            view.setUint32(offset, entry.crc, true); offset += 4;
            view.setUint32(offset, entry.dataBytes.length, true); offset += 4;
            view.setUint32(offset, entry.dataBytes.length, true); offset += 4;
            view.setUint16(offset, entry.nameBytes.length, true); offset += 2;
            view.setUint16(offset, 0, true); offset += 2;
            view.setUint16(offset, 0, true); offset += 2;
            view.setUint16(offset, 0, true); offset += 2;
            view.setUint16(offset, 0, true); offset += 2;
            view.setUint32(offset, 0, true); offset += 4;
            view.setUint32(offset, entry.localOffset, true); offset += 4;
            offset = copyBytes(output, offset, entry.nameBytes);
        }
        const writtenCentralSize = offset - centralOffset;
        view.setUint32(offset, 0x06054b50, true); offset += 4;
        view.setUint16(offset, 0, true); offset += 2;
        view.setUint16(offset, 0, true); offset += 2;
        view.setUint16(offset, entries.length, true); offset += 2;
        view.setUint16(offset, entries.length, true); offset += 2;
        view.setUint32(offset, writtenCentralSize, true); offset += 4;
        view.setUint32(offset, centralOffset, true); offset += 4;
        view.setUint16(offset, 0, true);
        return output;
    }

    function createProjectExportArchive(projectRecord, options = {}) {
        const generatedAt = options.generatedAt instanceof Date
            ? options.generatedAt
            : options.generatedAt ? new Date(options.generatedAt) : new Date();
        if (Number.isNaN(generatedAt.getTime())) throw new Error('Neispravan datum izvoza.');
        const projectName = String(options.projectName || projectRecord?.author_name || '').trim();
        const projectId = projectRecord?.id == null ? 'project' : String(projectRecord.id);
        const baseName = slugify(projectName);
        const { files, summary } = createProjectExportFiles(projectRecord, { generatedAt });
        return {
            filename: baseName
                ? `project-${projectId}-${baseName}.zip`
                : `project-${projectId}.zip`,
            mimeType: 'application/zip',
            bytes: createStoredZip(files, generatedAt),
            files,
            summary,
        };
    }

    return {
        createProjectExportArchive,
        createProjectExportFiles,
        createStoredZip,
        pointChainageOnTrack,
        slugify,
    };
}));
