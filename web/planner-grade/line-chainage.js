// The chainage view of a LINE: reconstruction segments joined end to end, split
// at stations into inter-station sections, each carrying what we computed beside
// what the infrastructure manager publishes.
//
// Why sections and not structures or kilometre buckets: this is the unit the
// network statement itself uses, so annex 2.18 (ruling gradient) and annex 2.13
// (permitted speed) can be laid alongside our own figures row for row. A
// disagreement between the two columns is then a finding rather than a mystery.
//
// Segments are joined on TOUCHING ENDPOINTS, not on a shared ref. Zagreb Gk–Odra
// carries ref M101 (it leaves the station over the M101 throat) while Odra–Sisak
// carries M502-1/M502-2, so a ref match would refuse to join the two halves of
// one 50 km journey. Refs are labels here, not the join key.

(function (root, factory) {
    const api = factory(
        typeof require === 'function' ? require('./line-speed.js') : root.__lineSpeed,
    );
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.__lineChainage = api;
}(typeof self !== 'undefined' ? self : this, function (lineSpeed) {
    'use strict';

    const EARTH_RADIUS_M = 6371000;
    const DEG_TO_RAD = Math.PI / 180;
    // Two segment ends this close are the same place. Odra is shared to the
    // seventh decimal, but an OSM-snapped endpoint can sit a few metres off.
    const JOIN_TOLERANCE_M = 60;
    // A station has to be near the line to belong to it: the extractor works from
    // a bbox, so it also returns stations on other lines through the same area.
    const STATION_MAX_OFFSET_M = 250;
    // Same for a level crossing — anything further away crosses a different line.
    const CROSSING_MAX_OFFSET_M = 60;
    // Beyond this the "join" doubles back — two routes out of one terminus, not a line.
    const MAX_JOIN_TURN_DEG = 100;

    function metresBetween(aLon, aLat, bLon, bLat) {
        const midLat = ((aLat + bLat) / 2) * DEG_TO_RAD;
        const dx = (bLon - aLon) * DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(midLat);
        const dy = (bLat - aLat) * DEG_TO_RAD * EARTH_RADIUS_M;
        return Math.hypot(dx, dy);
    }

    function normalizeElectrificationSegments(segments, lengthM, fallback = null) {
        const totalM = Math.max(0, Number(lengthM) || 0);
        const source = Array.isArray(segments) && segments.length
            ? segments
            : fallback && totalM > 0 ? [{ fromM: 0, toM: totalM, ...fallback }] : [];
        return source.map((segment) => {
            const fromM = Number(segment?.fromM);
            const toM = Number(segment?.toM);
            if (![fromM, toM].every(Number.isFinite) || fromM === toM) return null;
            const startM = Math.max(0, Math.min(totalM, Math.min(fromM, toM)));
            const endM = Math.max(0, Math.min(totalM, Math.max(fromM, toM)));
            if (!(endM > startM)) return null;
            const voltage = segment?.voltage == null ? null : Number(segment.voltage);
            const frequency = segment?.frequency == null ? null : Number(segment.frequency);
            return {
                fromM: startM,
                toM: endM,
                electrified: segment?.electrified ?? null,
                voltage: Number.isFinite(voltage) ? voltage : null,
                frequency: Number.isFinite(frequency) ? frequency : null,
                source: segment?.source || null,
            };
        }).filter(Boolean).sort((left, right) => left.fromM - right.fromM);
    }

    function reverseElectrificationSegments(segments, lengthM) {
        const totalM = Math.max(0, Number(lengthM) || 0);
        return normalizeElectrificationSegments(segments, totalM)
            .map(segment => ({
                ...segment,
                fromM: totalM - segment.toM,
                toM: totalM - segment.fromM,
            }))
            .reverse();
    }

    function orientSegment(segment, reverse = false) {
        if (!reverse) return segment;
        const nodeLengthM = Math.max(0, ...segment.nodes.map(node => Number(node.dM) || 0));
        const lengthM = Number(segment.lengthM) > 0 ? Number(segment.lengthM) : nodeLengthM;
        return {
            ...segment,
            fromName: segment.toName || null,
            toName: segment.fromName || null,
            nodes: [...segment.nodes].reverse(),
            lengthM,
            electrificationSegments: reverseElectrificationSegments(
                segment.electrificationSegments,
                lengthM,
            ),
        };
    }

    function summarizeElectrificationSegments(segments, fromM, toM) {
        const startM = Math.min(Number(fromM), Number(toM));
        const endM = Math.max(Number(fromM), Number(toM));
        const lengthM = Math.max(0, endM - startM);
        const runs = (segments || []).map(segment => {
            const clippedStartM = Math.max(startM, Number(segment.fromM));
            const clippedEndM = Math.min(endM, Number(segment.toM));
            return clippedEndM > clippedStartM
                ? { ...segment, fromM: clippedStartM, toM: clippedEndM }
                : null;
        }).filter(Boolean);
        const isElectric = run => ['contact_line', 'rail'].includes(run.electrified);
        const isKnown = run => isElectric(run) || run.electrified === 'no';
        const electrifiedLengthM = runs.filter(isElectric)
            .reduce((sum, run) => sum + run.toM - run.fromM, 0);
        const knownLengthM = runs.filter(isKnown)
            .reduce((sum, run) => sum + run.toM - run.fromM, 0);
        const values = key => [...new Set(runs.filter(isElectric)
            .map(run => run[key]).filter(Number.isFinite))];
        let status = 'unknown';
        if (lengthM > 0 && electrifiedLengthM >= lengthM - 0.5) status = 'full';
        else if (electrifiedLengthM > 0) status = 'partial';
        else if (knownLengthM >= lengthM - 0.5 && runs.length) status = 'none';
        return {
            status,
            lengthM,
            electrifiedLengthM,
            overheadLengthM: runs.filter(run => run.electrified === 'contact_line')
                .reduce((sum, run) => sum + run.toM - run.fromM, 0),
            conductorRailLengthM: runs.filter(run => run.electrified === 'rail')
                .reduce((sum, run) => sum + run.toM - run.fromM, 0),
            voltages: values('voltage'),
            frequencies: values('frequency'),
            runs,
        };
    }

    // ── Joining segments ──────────────────────────────────────────────────────
    // Greedy chain from the segment that no other segment continues. Each segment
    // is {id, name, refs, nodes:[{dM,x,y,z,terrainZ,gradePermille,structure}]}.
    function joinSegments(segments, options = {}) {
        const tolerance = Number(options.joinToleranceM ?? JOIN_TOLERANCE_M);
        const pool = (segments || []).filter(segment => (segment?.nodes?.length || 0) >= 2);
        if (pool.length === 0) return { nodes: [], segments: [], refs: [], seams: [] };
        const endpoints = segment => [segment.nodes[0], segment.nodes[segment.nodes.length - 1]];
        const near = (a, b) => metresBetween(a.x, a.y, b.x, b.y) <= tolerance;

        // Bearing of a segment's first (or last) step, degrees clockwise from north.
        const bearing = (from, to) => {
            const midLat = ((from.y + to.y) / 2) * DEG_TO_RAD;
            const dx = (to.x - from.x) * Math.cos(midLat);
            const dy = to.y - from.y;
            return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
        };
        const turnBetween = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

        // The chain grows in BOTH directions. Growing only forward from a head
        // stranded everything upstream of it: anchored at Odra, the Zagreb Gk–Odra
        // half of the line was reported "unjoined" instead of prepended.
        const ordered = [pool[0]];
        const remaining = pool.slice(1);
        const nodesOf = segment => segment.nodes;
        const attach = (atEnd) => {
            let grew = true;
            while (grew && remaining.length) {
                grew = false;
                const chainSegment = atEnd ? ordered[ordered.length - 1] : ordered[0];
                const chainNodes = nodesOf(chainSegment);
                const joint = atEnd ? chainNodes[chainNodes.length - 1] : chainNodes[0];
                const inbound = atEnd
                    ? bearing(chainNodes[chainNodes.length - 2], joint)
                    : bearing(chainNodes[1], joint);
                for (let index = 0; index < remaining.length; index += 1) {
                    const candidate = remaining[index];
                    const ends = [candidate.nodes[0], candidate.nodes[candidate.nodes.length - 1]];
                    const attachAtStart = near(ends[0], joint);
                    const attachAtEnd = near(ends[1], joint);
                    if (!attachAtStart && !attachAtEnd) continue;
                    const attached = orientSegment(candidate, attachAtStart !== atEnd);
                    const nodes = attached.nodes;
                    // A hairpin is not a continuation. Two lines that both START at
                    // one terminus (Zagreb Gk) would otherwise be welded into a
                    // single "line" that doubles back on itself.
                    const outbound = atEnd
                        ? bearing(nodes[0], nodes[1])
                        : bearing(nodes[nodes.length - 1], nodes[nodes.length - 2]);
                    if (turnBetween(inbound, outbound) > MAX_JOIN_TURN_DEG) continue;
                    remaining.splice(index, 1);
                    // `nodes` is ALREADY oriented for this side by the expression
                    // above — appending wants the candidate to start at the joint,
                    // prepending wants it to end there. Reversing again here joined
                    // the two halves end-to-wrong-end and opened an 8 km seam.
                    if (atEnd) ordered.push(attached);
                    else ordered.unshift(attached);
                    grew = true;
                    break;
                }
            }
        };
        attach(true);
        attach(false);

        // Direction is arbitrary once the chain is built, and the chainage a reader
        // expects is not: Zagreb Gk – Sisak should start at Zagreb. `startNear`
        // flips the whole chain if the far end is the nearer one.
        const anchor = options.startNear;
        if (Array.isArray(anchor) && anchor.length === 2) {
            const firstNode = nodesOf(ordered[0])[0];
            const lastSegment = nodesOf(ordered[ordered.length - 1]);
            const lastNode = lastSegment[lastSegment.length - 1];
            const toAnchor = node => metresBetween(node.x, node.y, anchor[0], anchor[1]);
            if (toAnchor(lastNode) < toAnchor(firstNode)) {
                ordered.reverse();
                for (let index = 0; index < ordered.length; index += 1) {
                    ordered[index] = orientSegment(ordered[index], true);
                }
            }
        }

        // Chainage is re-derived from the GEOMETRY, not carried over from each
        // segment's stored dM. A flipped segment keeps its original dM values in
        // reversed order, so rebasing them produced chainage that ran BACKWARDS
        // (a 2 km line ending at 0 m). Walking the joined node list also makes the
        // seams part of the same measurement instead of a correction to it.
        const nodes = [];
        const seams = [];
        const spans = [];
        for (const segment of ordered) {
            const startM = nodes.length ? nodes[nodes.length - 1].dM : 0;
            if (nodes.length) {
                const previous = nodes[nodes.length - 1];
                const first = segment.nodes[0];
                seams.push({
                    afterM: startM,
                    seamM: metresBetween(previous.x, previous.y, first.x, first.y),
                    into: segment.id,
                });
            }
            for (const node of segment.nodes) {
                const previous = nodes[nodes.length - 1];
                const stepM = previous ? metresBetween(previous.x, previous.y, node.x, node.y) : 0;
                nodes.push({
                    ...node,
                    dM: previous ? previous.dM + stepM : 0,
                    segmentId: segment.id,
                });
            }
            const toM = nodes[nodes.length - 1].dM;
            const sourceLengthM = Number(segment.lengthM) > 0
                ? Number(segment.lengthM)
                : Math.max(0, ...segment.nodes.map(node => Number(node.dM) || 0));
            const scale = sourceLengthM > 0 ? (toM - startM) / sourceLengthM : 1;
            spans.push({
                id: segment.id,
                name: segment.name,
                fromName: segment.fromName || null,
                toName: segment.toName || null,
                fromM: startM,
                toM,
                electrificationSegments: (segment.electrificationSegments || []).map(run => ({
                    ...run,
                    fromM: startM + Number(run.fromM) * scale,
                    toM: startM + Number(run.toM) * scale,
                })),
            });
        }
        const refs = [...new Set(ordered.flatMap(segment => segment.refs || []).filter(Boolean))];
        const electrificationSegments = spans.flatMap(span => span.electrificationSegments || []);
        return {
            nodes,
            segments: spans,
            electrificationSegments,
            refs,
            seams,
            unjoined: remaining.map(s => s.id),
        };
    }

    // ── Where the stations are ────────────────────────────────────────────────
    function nearestOnLine(nodes, lat, lon) {
        let best = null;
        for (const node of nodes) {
            const distanceM = metresBetween(node.x, node.y, lon, lat);
            if (!best || distanceM < best.distanceM) best = { distanceM, dM: node.dM };
        }
        return best;
    }

    // Stations that actually sit on this line, in chainage order, deduplicated:
    // the extractor returns a bbox, so it includes stations on other lines and
    // sometimes both a node and a stop_position for the same place.
    function stationsOnLine(nodes, stations, options = {}) {
        const maxOffset = Number(options.stationMaxOffsetM ?? STATION_MAX_OFFSET_M);
        const found = [];
        for (const station of stations || []) {
            const lat = Number(station.lat);
            const lon = Number(station.lng ?? station.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
            const hit = nearestOnLine(nodes, lat, lon);
            if (!hit || hit.distanceM > maxOffset) continue;
            found.push({
                name: String(station.name || '').trim(),
                stopType: station.stopType || null,
                dM: hit.dM,
                offsetM: hit.distanceM,
            });
        }
        found.sort((left, right) => left.dM - right.dM);
        const unique = [];
        for (const station of found) {
            const previous = unique[unique.length - 1];
            if (previous && previous.name === station.name) {
                if (station.offsetM < previous.offsetM) unique[unique.length - 1] = station;
                continue;
            }
            unique.push(station);
        }
        return unique;
    }

    // ── Matching the official tables ──────────────────────────────────────────
    // Names differ in diacritics, case, and decorations like "(S)" or
    // "(stajalište)", so the key is normalised. Both orders are accepted: the
    // annex lists a section in the line's own direction, which may be the
    // opposite of the way we joined it.
    function normaliseName(name) {
        return String(name || '')
            .normalize('NFD')
            .replace(/\p{Diacritic}/gu, '')
            .replace(/\([^)]*\)/g, ' ')
            .replace(/[^a-z0-9]+/gi, ' ')
            .trim()
            .toLowerCase();
    }

    function sectionKey(from, to) {
        return `${normaliseName(from)}|${normaliseName(to)}`;
    }

    // Project labels occasionally stop just short of an official place
    // ("Knin north approach"). It is still the only usable endpoint anchor when
    // OSM has no station nodes anywhere on that reconstructed project.
    function endpointKey(name) {
        return normaliseName(name)
            .replace(/\b(?:north|south|east|west) approach\b/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function routeNameEndpoints(name) {
        const parts = String(name || '').split(/\s+[–—]\s+/).map(part => part.trim()).filter(Boolean);
        return parts.length === 2 ? parts : [];
    }

    function addSegmentEndpointStations(stations, joined, toleranceM = STATION_MAX_OFFSET_M) {
        const result = [...(stations || [])];
        const add = (name, dM) => {
            if (!name || !Number.isFinite(dM)) return;
            const alreadyMapped = result.some(station => (
                endpointKey(station.name) === endpointKey(name)
                || Math.abs(station.dM - dM) <= toleranceM
            ));
            if (!alreadyMapped) {
                result.push({
                    name,
                    stopType: 'project_endpoint',
                    dM,
                    offsetM: 0,
                    virtual: true,
                });
            }
        };
        for (const segment of joined.segments || []) {
            add(segment.fromName, segment.fromM);
            add(segment.toName, segment.toM);
        }
        return result.sort((left, right) => left.dM - right.dM);
    }

    // Entries sharing a key are MERGED, not dropped. The two annexes name the same
    // stretch differently — "Lekenik – Greda" with an en dash in 2.18, "Lekenik -
    // Greda" with a hyphen in 2.13 — so both normalise to one key. Keeping only the
    // first meant whichever annex happened to come first shadowed the other, and
    // Lekenik–Greda silently lost its published gradient the moment the rows
    // arrived in a different order (concatenated files vs the API's ORDER BY).
    // Merging field-by-field makes the result independent of input order.
    function mergeOfficial(existing, incoming) {
        if (!existing) return incoming;
        const merged = { ...existing };
        for (const [field, value] of Object.entries(incoming)) {
            if (merged[field] == null && value != null) merged[field] = value;
        }
        return merged;
    }

    function officialIndex(sections) {
        const index = new Map();
        for (const section of sections || []) {
            const parts = String(section.section || section.name || '').split(/\s[–-]\s/);
            if (parts.length < 2) continue;
            const key = sectionKey(parts[0], parts[1]);
            const reversed = sectionKey(parts[1], parts[0]);
            index.set(key, mergeOfficial(index.get(key), section));
            if (reversed !== key) index.set(reversed, mergeOfficial(index.get(reversed), section));
        }
        return index;
    }

    function officialEndpoints(entry) {
        if (entry?.fromName && entry?.toName) return [entry.fromName, entry.toName];
        const parts = String(entry?.section || entry?.name || '').split(/\s[–-]\s/);
        return parts.length >= 2 ? [parts[0], parts.slice(1).join(' - ')] : [];
    }

    function officialSectionLengthM(entry) {
        const [fromName, toName] = officialEndpoints(entry);
        // A chainage equation such as 0+815= → 5+852 changes the printed km
        // without traversing 5.037 km of railway. Keep it as a zero-length graph
        // connector so it cannot distort the mapped project distance.
        if (/^-?\d+\+\d+=?$/.test(String(fromName || '').trim())
            && /^-?\d+\+\d+=?$/.test(String(toName || '').trim())
            && (String(fromName).includes('=') || String(toName).includes('='))) return 0;
        const stated = entry?.sectionLengthM;
        if (typeof stated === 'number' && Number.isFinite(stated) && stated >= 0) return stated;
        const first = entry?.speeds?.[0];
        const fromKm = railwayKmMetres(first?.sectionFromKm);
        const toKm = railwayKmMetres(first?.sectionToKm);
        return Number.isFinite(fromKm) && Number.isFinite(toKm)
            ? Math.abs(toKm - fromKm)
            : null;
    }

    // Annex 2.13 often names several signal/operating points between two OSM
    // stations. Treat those published sections as a graph: a local
    // Gospić–Lovinac row can then follow Gospić–Bilaj–Medak–Raduč–Lovinac and
    // retain every speed change even though the intermediate places have no
    // coordinates in our station table.
    function officialSpeedGraph(sections) {
        const adjacency = new Map();
        const add = (key, edge) => {
            if (!adjacency.has(key)) adjacency.set(key, []);
            adjacency.get(key).push(edge);
        };
        for (const entry of sections || []) {
            if (!Array.isArray(entry?.speeds) || entry.speeds.length === 0) continue;
            const [fromName, toName] = officialEndpoints(entry);
            const fromKey = endpointKey(fromName);
            const toKey = endpointKey(toName);
            const lengthM = officialSectionLengthM(entry);
            if (!fromKey || !toKey || fromKey === toKey || !Number.isFinite(lengthM)) continue;
            add(fromKey, {
                entry,
                fromName,
                toName,
                fromKey,
                toKey,
                lengthM,
            });
            add(toKey, {
                entry,
                fromName: toName,
                toName: fromName,
                fromKey: toKey,
                toKey: fromKey,
                lengthM,
            });
        }
        return adjacency;
    }

    function officialSpeedPath(graph, fromName, toName) {
        const fromKey = endpointKey(fromName);
        const toKey = endpointKey(toName);
        if (!fromKey || !toKey || fromKey === toKey || !graph?.has(fromKey)) return null;
        const distances = new Map([[fromKey, 0]]);
        const previous = new Map();
        const queue = [{ key: fromKey, distance: 0 }];
        while (queue.length) {
            queue.sort((left, right) => left.distance - right.distance);
            const current = queue.shift();
            if (current.distance !== distances.get(current.key)) continue;
            if (current.key === toKey) break;
            for (const edge of graph.get(current.key) || []) {
                const distance = current.distance + Math.max(0, edge.lengthM);
                if (distance >= (distances.get(edge.toKey) ?? Infinity)) continue;
                distances.set(edge.toKey, distance);
                previous.set(edge.toKey, { key: current.key, edge });
                queue.push({ key: edge.toKey, distance });
            }
        }
        if (!previous.has(toKey)) return null;
        const edges = [];
        let key = toKey;
        while (key !== fromKey) {
            const step = previous.get(key);
            if (!step) return null;
            edges.push(step.edge);
            key = step.key;
        }
        edges.reverse();
        return {
            edges,
            lengthM: edges.reduce((sum, edge) => sum + edge.lengthM, 0),
        };
    }

    function mergeSpeedSubranges(ranges) {
        return [...ranges].sort((left, right) => left.fromM - right.fromM)
            .reduce((merged, range) => {
                if (!(range.toM > range.fromM) || !Number.isFinite(range.speedKph)) return merged;
                const previous = merged[merged.length - 1];
                if (previous && previous.speedKph === range.speedKph
                    && range.fromM <= previous.toM + 0.5) {
                    previous.toM = Math.max(previous.toM, range.toM);
                    return merged;
                }
                merged.push({ ...range });
                return merged;
            }, []);
    }

    function mapOfficialSpeedPath(path, fromM, toM) {
        const localLengthM = toM - fromM;
        if (!path?.edges?.length || !(localLengthM > 0) || !(path.lengthM > 0)) return null;
        // A shortest path that bears no physical resemblance to the local row is
        // a same-name collision elsewhere in the network, not evidence.
        const scale = localLengthM / path.lengthM;
        if (scale < 0.35 || scale > 2.5) return null;
        let publishedM = 0;
        const ranges = [];
        for (const edge of path.edges) {
            const edgeFromM = fromM + (publishedM / path.lengthM) * localLengthM;
            publishedM += edge.lengthM;
            const edgeToM = fromM + (publishedM / path.lengthM) * localLengthM;
            if (!(edgeToM > edgeFromM)) continue;
            const mapped = officialSpeedSubranges(
                edge.entry,
                edge.fromName,
                edge.toName,
                edgeFromM,
                edgeToM,
            );
            if (mapped.length) {
                ranges.push(...mapped);
                continue;
            }
            const speedKph = officialTimingSpeedKph({
                restrictedSpeedKph: edge.entry.minSpeedKph
                    ?? edge.entry.restrictedSpeedKph,
                permittedSpeedKph: edge.entry.maxSpeedKph
                    ?? edge.entry.permittedSpeedKph,
            });
            if (Number.isFinite(speedKph)) {
                ranges.push({
                    fromM: edgeFromM,
                    toM: edgeToM,
                    speedKph,
                    direction: edge.fromName === officialEndpoints(edge.entry)[0]
                        ? 'A→B'
                        : 'B→A',
                });
            }
        }
        const merged = mergeSpeedSubranges(ranges);
        if (!merged.length) return null;
        const values = merged.map(range => range.speedKph);
        return {
            ranges: merged,
            minSpeedKph: Math.min(...values),
            maxSpeedKph: Math.max(...values),
            inherited: path.edges.length > 1,
            sourceSections: path.edges.map(edge => edge.entry.name || edge.entry.section),
        };
    }

    // ── The sections ──────────────────────────────────────────────────────────
    // Structure runs, with their boundaries at the MIDPOINT between the last node
    // of one structure and the first of the next. Measuring a run from its own
    // first node to its own last node loses half a sample step at each end, which
    // reported a 400 m tunnel as 300 m — and understated every tunnel and viaduct
    // on the line by roughly one sample step.
    function structuresIn(nodes) {
        const runs = [];
        nodes.forEach((node, index) => {
            const previous = runs[runs.length - 1];
            if (previous && previous.type === node.structure) {
                previous.lastNodeM = node.dM;
                previous.toM = index + 1 < nodes.length
                    ? (node.dM + nodes[index + 1].dM) / 2
                    : node.dM;
                return;
            }
            if (previous) previous.toM = (previous.lastNodeM + node.dM) / 2;
            runs.push({
                type: node.structure,
                fromM: previous ? (previous.lastNodeM + node.dM) / 2 : node.dM,
                toM: index + 1 < nodes.length ? (node.dM + nodes[index + 1].dM) / 2 : node.dM,
                lastNodeM: node.dM,
            });
        });
        const lengthOf = type => runs
            .filter(run => run.type === type)
            .reduce((sum, run) => sum + (run.toM - run.fromM), 0);
        const countOf = type => runs.filter(run => run.type === type && run.toM > run.fromM).length;
        const relative = nodes
            .filter(node => typeof node.terrainZ === 'number' && Number.isFinite(node.terrainZ))
            .map(node => node.z - node.terrainZ);
        return {
            tunnels: countOf('tunnel'),
            tunnelLengthM: lengthOf('tunnel'),
            bridges: countOf('bridge') + countOf('viaduct'),
            bridgeLengthM: lengthOf('bridge') + lengthOf('viaduct'),
            deepestCutM: relative.length ? Math.min(...relative) : null,
            highestFillM: relative.length ? Math.max(...relative) : null,
        };
    }

    function gradeStats(nodes) {
        const grades = nodes.map(node => Number(node.gradePermille)).filter(Number.isFinite);
        if (!grades.length) return { averageGradePermille: null, maxGradePermille: null };
        // Average of the ABSOLUTE grade: a section that falls 5‰ then rises 5‰ is
        // not a level section, and averaging the signed values would say it was.
        const absolute = grades.map(Math.abs);
        return {
            averageGradePermille: absolute.reduce((sum, value) => sum + value, 0) / absolute.length,
            maxGradePermille: Math.max(...absolute),
        };
    }

    // ── From a saved project ──────────────────────────────────────────────────
    // The dialog runs in the browser against what the API serves, NOT against the
    // profile JSONs: those are build inputs and are deliberately excluded from the
    // deploy. A saved legacy-rail track carries everything needed — latlngs, and a
    // verticalProfile with elevAslM, terrainAslM and regimes.
    //
    // gradePermille is derived here rather than read, because the project does not
    // store it. It is measured over a BASELINE for the same reason the audit is:
    // adjacent nodes can be half a metre apart and elevations are quantised to the
    // centimetre, so node-to-node slope is quantisation noise (±20‰), not gradient.
    const GRADE_BASELINE_M = 20;

    function segmentFromProject(project, options = {}) {
        const data = project?.project_data || project || {};
        const track = (data.tracks || [])[options.trackIndex ?? 0];
        const latlngs = track?.latlngs || [];
        const profile = track?.verticalProfile || {};
        const elevations = profile.elevAslM || [];
        const terrain = profile.terrainAslM || [];
        const regimes = profile.regimes || [];
        if (latlngs.length < 2 || elevations.length !== latlngs.length) return null;

        const chainage = [0];
        for (let index = 1; index < latlngs.length; index += 1) {
            chainage.push(chainage[index - 1] + metresBetween(
                Number(latlngs[index - 1][1]), Number(latlngs[index - 1][0]),
                Number(latlngs[index][1]), Number(latlngs[index][0]),
            ));
        }
        const lengthM = chainage[chainage.length - 1];
        const electrificationSegments = normalizeElectrificationSegments(
            track?.electrificationSegments,
            lengthM,
            track && Object.prototype.hasOwnProperty.call(track, 'electrified')
                ? {
                    electrified: track.electrified,
                    voltage: track.voltage,
                    frequency: track.frequency,
                    source: 'project',
                }
                : null,
        );
        const [fromName = null, toName = null] = routeNameEndpoints(track?.legacy?.name);
        const baseline = Number(options.gradeBaselineM ?? GRADE_BASELINE_M);
        const gradeAt = (index) => {
            let back = index;
            while (back > 0 && chainage[index] - chainage[back] < baseline / 2) back -= 1;
            let forward = index;
            while (forward < latlngs.length - 1 && chainage[forward] - chainage[index] < baseline / 2) forward += 1;
            const run = chainage[forward] - chainage[back];
            if (run <= 0) return 0;
            const rise = Number(elevations[forward]) - Number(elevations[back]);
            return Number.isFinite(rise) ? (rise / run) * 1000 : 0;
        };
        return {
            id: track?.legacy?.profileId || `project-${project?.id ?? 'unsaved'}`,
            name: track?.legacy?.name || project?.author_name || 'line',
            fromName,
            toName,
            refs: [track?.legacy?.ref].filter(Boolean),
            projectId: project?.id ?? null,
            lengthM,
            electrificationSegments,
            nodes: latlngs.map((latlng, index) => ({
                dM: chainage[index],
                x: Number(latlng[1]),
                y: Number(latlng[0]),
                z: Number(elevations[index]),
                // Missing terrain stays null: it must never become 0 via Number().
                terrainZ: typeof terrain[index] === 'number' && Number.isFinite(terrain[index])
                    ? terrain[index]
                    : null,
                gradePermille: gradeAt(index),
                structure: regimes[index] || 'at-grade',
            })),
        };
    }

    function officialTimingSpeedKph(official) {
        const restricted = Number(official?.restrictedSpeedKph);
        if (Number.isFinite(restricted) && restricted > 0) return restricted;
        const permitted = Number(official?.permittedSpeedKph);
        return Number.isFinite(permitted) && permitted > 0 ? permitted : null;
    }

    function railwayKmMetres(value) {
        const match = String(value || '').match(/^(-?)(\d+)\+(\d+)$/);
        if (!match) return null;
        const metres = Number(match[2]) * 1000 + Number(match[3]);
        return match[1] === '-' ? -metres : metres;
    }

    // Register Annex 2.13's absolute railway-km subranges to this reconstructed
    // station-to-station section. The table publishes A→B and B→A independently;
    // use the one matching the route's current direction, clip every range to
    // the official-place endpoints, then linearly map it onto local chainage.
    function officialSpeedSubranges(entry, routeFrom, routeTo, fromM, toM) {
        const speeds = Array.isArray(entry?.speeds) ? entry.speeds : [];
        if (!speeds.length || !(toM > fromM)) return [];
        const entryFrom = entry.fromName
            || String(entry.section || entry.name || '').split(/\s[–-]\s/)[0];
        const entryTo = entry.toName
            || String(entry.section || entry.name || '').split(/\s[–-]\s/).slice(1).join(' - ');
        const forward = normaliseName(routeFrom) === normaliseName(entryFrom)
            && normaliseName(routeTo) === normaliseName(entryTo);
        const reverse = normaliseName(routeFrom) === normaliseName(entryTo)
            && normaliseName(routeTo) === normaliseName(entryFrom);
        if (!forward && !reverse) return [];
        const directionKey = forward ? 'forward' : 'reverse';
        const sectionFromKm = railwayKmMetres(speeds[0]?.sectionFromKm);
        const sectionToKm = railwayKmMetres(speeds[0]?.sectionToKm);
        if (![sectionFromKm, sectionToKm].every(Number.isFinite)
            || sectionFromKm === sectionToKm) return [];
        const officialStartKm = forward ? sectionFromKm : sectionToKm;
        const officialEndKm = forward ? sectionToKm : sectionFromKm;
        const sectionLowKm = Math.min(sectionFromKm, sectionToKm);
        const sectionHighKm = Math.max(sectionFromKm, sectionToKm);
        const localLengthM = toM - fromM;
        const mapped = [];

        for (const published of speeds) {
            const range = published?.[directionKey];
            if (!range) continue;
            const rangeFromKm = railwayKmMetres(range.fromKm);
            const rangeToKm = railwayKmMetres(range.toKm);
            const values = Array.isArray(range.speedValuesKph)
                ? range.speedValuesKph.map(Number).filter(Number.isFinite)
                : [];
            const speedKph = values.length
                ? Math.min(...values)
                : Number(range.speedKph);
            if (![rangeFromKm, rangeToKm, speedKph].every(Number.isFinite)
                || !(speedKph > 0) || rangeFromKm === rangeToKm) continue;
            const lowKm = Math.max(sectionLowKm, Math.min(rangeFromKm, rangeToKm));
            const highKm = Math.min(sectionHighKm, Math.max(rangeFromKm, rangeToKm));
            if (!(highKm > lowKm)) continue;
            const ratioA = (lowKm - officialStartKm) / (officialEndKm - officialStartKm);
            const ratioB = (highKm - officialStartKm) / (officialEndKm - officialStartKm);
            const localA = fromM + ratioA * localLengthM;
            const localB = fromM + ratioB * localLengthM;
            mapped.push({
                fromM: Math.max(fromM, Math.min(toM, Math.min(localA, localB))),
                toM: Math.max(fromM, Math.min(toM, Math.max(localA, localB))),
                speedKph,
                sourceFromKm: range.fromKm,
                sourceToKm: range.toKm,
                direction: forward ? 'A→B' : 'B→A',
            });
        }
        mapped.sort((left, right) => left.fromM - right.fromM);
        return mapped.reduce((merged, range) => {
            if (!(range.toM > range.fromM)) return merged;
            const previous = merged[merged.length - 1];
            if (previous && previous.speedKph === range.speedKph
                && range.fromM <= previous.toM + 0.5) {
                previous.toM = Math.max(previous.toM, range.toM);
                return merged;
            }
            merged.push({ ...range });
            return merged;
        }, []);
    }

    // Apply the published infrastructure ceiling to the same continuous limit
    // profile used by the acceleration/braking solver. The physical limit is
    // retained so the table can still show what the reconstructed geometry
    // could support after renewal.
    function capSpeedLimitProfile(limits, sections) {
        return (limits || []).map((entry) => {
            const caps = (sections || [])
                .filter((section) => {
                    const fromM = Number(section.fromM ?? section.from?.dM);
                    const toM = Number(section.toM ?? section.to?.dM);
                    return entry.dM >= fromM && entry.dM <= toM;
                })
                .flatMap((section) => {
                    const ranges = section.official?.speedSubranges || [];
                    if (ranges.length) {
                        const matching = ranges
                            .filter(range => entry.dM >= range.fromM && entry.dM <= range.toM)
                            .map(range => range.speedKph);
                        return matching.length
                            ? matching
                            : [officialTimingSpeedKph(section.official)];
                    }
                    return [officialTimingSpeedKph(section.official)];
                })
                .filter(Number.isFinite);
            const officialLimitKph = caps.length ? Math.min(...caps) : null;
            const physicalLimitKph = Number(entry.physicalLimitKph ?? entry.limitKph);
            const limitKph = Number.isFinite(officialLimitKph)
                ? Math.min(physicalLimitKph, officialLimitKph)
                : physicalLimitKph;
            return {
                ...entry,
                physicalLimitKph,
                officialLimitKph,
                limitKph,
                limitedBy: limitKph < physicalLimitKph - 1e-9
                    ? 'official'
                    : entry.limitedBy,
            };
        });
    }

    function buildLineChainage(input, options = {}) {
        const joined = joinSegments(input.segments, options);
        if (joined.nodes.length < 2) return null;
        const stations = addSegmentEndpointStations(
            stationsOnLine(joined.nodes, input.stations, options),
            joined,
        );
        const gradientIndex = officialIndex(input.officialGradients);
        const speedIndex = officialIndex(input.officialSpeeds);
        const speedGraph = officialSpeedGraph(input.officialSpeeds);
        const crossingMaxOffset = Number(options.crossingMaxOffsetM ?? CROSSING_MAX_OFFSET_M);
        const crossings = (input.levelCrossings || [])
            .map((crossing) => {
                const hit = nearestOnLine(joined.nodes, Number(crossing.lat), Number(crossing.lng));
                return hit && hit.distanceM <= crossingMaxOffset
                    ? { ...crossing, dM: hit.dM } : null;
            })
            .filter(Boolean);

        // Resolve the official metadata BEFORE running the train: permitted
        // speed is an input to the timing model, not a decorative table cell.
        const sectionFrames = [];
        for (let index = 0; index + 1 < stations.length; index += 1) {
            const from = stations[index];
            const to = stations[index + 1];
            const nodes = joined.nodes.filter(node => node.dM >= from.dM && node.dM <= to.dM);
            if (nodes.length < 2) continue;
            // The annexes split a line at KOLODVOR only (status 01), while these
            // rows split at every station and halt — so an exact name match finds
            // an official figure for barely one row in ten. Where there is no
            // direct match, the value is inherited from the coarse official
            // section that ENCLOSES this row (Velika Gorica–Turopolje covers our
            // Velika Gorica–Mraclin and Mraclin–Turopolje), and marked inherited
            // so the table never implies the annex names this stretch.
            const key = sectionKey(from.name, to.name);
            // `carries` matters now that both annexes live in ONE table: a row can
            // hold a permitted speed and no ruling gradient, or the reverse. Without
            // it the gradient lookup stopped at the first enclosing row it found —
            // a speed-only one — and reported "no published gradient" for sections
            // that have one. Ten rows became two.
            const enclosing = (index2, carries) => {
                const has = entry => entry && entry[carries] != null;
                const direct = index2.get(key);
                if (has(direct)) return { entry: direct, inherited: false };
                for (let back = index; back >= 0; back -= 1) {
                    for (let forward = index + 1; forward < stations.length; forward += 1) {
                        if (back === index && forward === index + 1) continue;
                        const entry = index2.get(sectionKey(stations[back].name, stations[forward].name));
                        if (has(entry)) return { entry, inherited: true };
                    }
                }
                return { entry: null, inherited: false };
            };
            const gradient = enclosing(gradientIndex, 'rulingGradePermille');
            const speed = enclosing(speedIndex, 'maxSpeedKph');
            const pathSpeed = mapOfficialSpeedPath(
                officialSpeedPath(speedGraph, from.name, to.name),
                from.dM,
                to.dM,
            );
            const official = {
                rulingGradePermille: gradient.entry?.rulingGradePermille ?? null,
                rulingGradeInherited: gradient.inherited,
                rulingGradeSection: gradient.entry?.section ?? null,
                permittedSpeedKph: pathSpeed?.maxSpeedKph
                    ?? speed.entry?.maxSpeedKph
                    ?? null,
                restrictedSpeedKph: pathSpeed?.minSpeedKph
                    ?? speed.entry?.minSpeedKph
                    ?? null,
                speedInherited: pathSpeed?.inherited ?? speed.inherited,
                speedSection: pathSpeed
                    ? pathSpeed.sourceSections.join(' + ')
                    : (speed.entry?.name ?? null),
                // Only meaningful on a direct match: an enclosing section's length
                // is not this row's length.
                lengthM: pathSpeed?.inherited || speed.inherited
                    ? null
                    : (speed.entry?.sectionLengthM ?? null),
                loadingGauge: speed.entry?.loadingGauge ?? null,
            };
            official.timingSpeedKph = officialTimingSpeedKph(official);
            official.speedSubranges = pathSpeed?.ranges
                || (speed.inherited ? [] : officialSpeedSubranges(
                    speed.entry,
                    from.name,
                    to.name,
                    from.dM,
                    to.dM,
                ));
            sectionFrames.push({ from, to, nodes, official });
        }

        // The run is computed ONCE over the whole line and then sliced, not per
        // section. Acceleration and braking carry across section boundaries;
        // only the line's own ends are at rest. The second run preserves the
        // uncapped engineering comparison while the primary run obeys HŽ's
        // published limit wherever one was matched.
        const physicalLimits = lineSpeed.speedLimitProfile(joined.nodes, options);
        const physicalRun = lineSpeed.runProfile(physicalLimits, options);
        const lineLimits = capSpeedLimitProfile(physicalLimits, sectionFrames);
        const lineRun = lineSpeed.runProfile(lineLimits, options);
        const speedAt = new Map(lineLimits.map((entry, index) => [entry.dM, lineRun.speedsKph[index]]));
        const physicalSpeedAt = new Map(
            physicalLimits.map((entry, index) => [entry.dM, physicalRun.speedsKph[index]]),
        );
        const sliceSeconds = (inside, speeds) => {
            let seconds = 0;
            for (let index = 1; index < inside.length; index += 1) {
                const ds = inside[index].dM - inside[index - 1].dM;
                const mean = ((speeds.get(inside[index - 1].dM) || 0)
                    + (speeds.get(inside[index].dM) || 0)) / 2 / 3.6;
                if (ds > 0 && mean > 0) seconds += ds / mean;
            }
            return seconds;
        };
        const sliceRun = (from, to) => {
            const inside = lineLimits.filter(entry => entry.dM >= from && entry.dM <= to);
            if (inside.length < 2) return null;
            const seconds = sliceSeconds(inside, speedAt);
            const possibleSeconds = sliceSeconds(inside, physicalSpeedAt);
            const achieved = inside.map(entry => speedAt.get(entry.dM) || 0);
            const physicalLimitsKph = inside.map(entry => entry.physicalLimitKph);
            const appliedLimitsKph = inside.map(entry => entry.limitKph);
            const radii = inside.map(entry => entry.radiusM).filter(Number.isFinite);
            const lengthM = inside[inside.length - 1].dM - inside[0].dM;
            return {
                lengthM,
                seconds,
                averageSpeedKph: seconds > 0 ? (lengthM / seconds) * 3.6 : null,
                averagePossibleSpeedKph: possibleSeconds > 0
                    ? (lengthM / possibleSeconds) * 3.6
                    : null,
                maxPossibleSpeedKph: Math.max(...physicalLimitsKph),
                minPossibleSpeedKph: Math.min(...physicalLimitsKph),
                maxAppliedLimitKph: Math.max(...appliedLimitsKph),
                maxAchievedSpeedKph: Math.max(...achieved),
                tightestRadiusM: radii.length ? Math.min(...radii) : null,
                limitedBy: inside.reduce((counts, entry) => {
                    counts[entry.limitedBy] = (counts[entry.limitedBy] || 0) + 1;
                    return counts;
                }, {}),
            };
        };

        const sections = [];
        for (const frame of sectionFrames) {
            const { from, to, nodes, official } = frame;
            const sectionCrossings = crossings.filter(c => c.dM >= from.dM && c.dM < to.dM);
            sections.push({
                from: from.name,
                to: to.name,
                fromM: from.dM,
                toM: to.dM,
                lengthM: to.dM - from.dM,
                ...gradeStats(nodes),
                speed: sliceRun(from.dM, to.dM),
                structures: structuresIn(nodes),
                electrification: summarizeElectrificationSegments(
                    joined.electrificationSegments,
                    from.dM,
                    to.dM,
                ),
                levelCrossings: {
                    total: sectionCrossings.length,
                    byProtection: sectionCrossings.reduce((counts, crossing) => {
                        counts[crossing.protection] = (counts[crossing.protection] || 0) + 1;
                        return counts;
                    }, {}),
                },
                official,
            });
        }
        const lengthM = joined.nodes[joined.nodes.length - 1].dM;
        const electrification = summarizeElectrificationSegments(
            joined.electrificationSegments,
            0,
            lengthM,
        );
        return {
            refs: joined.refs,
            lengthM,
            segments: joined.segments,
            electrificationSegments: joined.electrificationSegments,
            electrification,
            seams: joined.seams,
            unjoined: joined.unjoined,
            stations,
            sections,
            // Whole-line totals, so the dialog's header does not have to re-add
            // the rows (and cannot disagree with them).
            totals: {
                seconds: lineRun.seconds,
                possibleSeconds: physicalRun.seconds,
                officialSpeedLengthM: sectionFrames
                    .filter(section => Number.isFinite(section.official.timingSpeedKph))
                    .reduce((sum, section) => sum + section.to.dM - section.from.dM, 0),
                levelCrossings: crossings.length,
                tunnels: sections.reduce((sum, section) => sum + section.structures.tunnels, 0),
                bridges: sections.reduce((sum, section) => sum + section.structures.bridges, 0),
                electrifiedLengthM: electrification.electrifiedLengthM,
            },
        };
    }

    return {
        JOIN_TOLERANCE_M,
        MAX_JOIN_TURN_DEG,
        STATION_MAX_OFFSET_M,
        CROSSING_MAX_OFFSET_M,
        joinSegments,
        segmentFromProject,
        GRADE_BASELINE_M,
        stationsOnLine,
        normaliseName,
        sectionKey,
        endpointKey,
        routeNameEndpoints,
        addSegmentEndpointStations,
        officialIndex,
        officialSpeedGraph,
        officialSpeedPath,
        mapOfficialSpeedPath,
        officialTimingSpeedKph,
        officialSpeedSubranges,
        capSpeedLimitProfile,
        structuresIn,
        gradeStats,
        normalizeElectrificationSegments,
        reverseElectrificationSegments,
        summarizeElectrificationSegments,
        buildLineChainage,
    };
}));
