// Geographic registry of PREPARED locations — the supported cities/served areas.
// A location is a curated data bundle, NOT a live OSM pull: buildings, the DGU
// elevation grid, decor and census data are ingested/shipped ahead of time (see
// docs/adding-a-location.md), so planning is only meaningful inside these areas.
//
// bbox = [west, south, east, north], the SERVED-AREA extent (Split's covers
// Split–Trogir, the DGU DEM footprint), used to detect a project's location
// from its geometry and — Phase 2 — to keep one project within one region.
//
// Exposed as window.__locationRegistry for classic scripts (transit.js).
// Keep ids/bbox aligned with station-3d/core/locations.js LOCATIONS, which
// holds the render config (building source, terrain files) for the same ids.
(function (root) {
    'use strict';

    // A long-distance line's served area is a CORRIDOR, not a rectangle: the
    // Zagreb–Split bounding box is 26,000 km² of Bosnia, Kvarner and open sea
    // around a 422 km railway whose 5 km corridor is 1,273 km². The path below is
    // the M202+M604 centreline sampled about every 2 km (scripts/build-rail-corridor.mjs
    // --coarse-step-m 2000); a 2.5 km half-width does not notice the difference.
    const ZAGREB_SPLIT_PATH = [
        [15.9726,45.8041],[15.9554,45.7918],[15.9581,45.7743],[15.9364,45.7626],[15.9136,45.7533],
        [15.8912,45.7440],[15.8678,45.7344],[15.8325,45.7199],[15.8097,45.7105],[15.7959,45.6957],
        [15.7704,45.6890],[15.7444,45.6822],[15.7167,45.6751],[15.6905,45.6683],[15.6536,45.6587],
        [15.6329,45.6344],[15.6277,45.6154],[15.6220,45.5945],[15.6167,45.5767],[15.6003,45.5613],
        [15.5820,45.5450],[15.5658,45.5309],[15.5482,45.5176],[15.5448,45.5005],[15.5545,45.4828],
        [15.5551,45.4657],[15.5308,45.4644],[15.5062,45.4653],[15.4926,45.4537],[15.4996,45.4385],
        [15.4792,45.4223],[15.4709,45.4062],[15.4423,45.4036],[15.4259,45.3904],[15.4100,45.3707],
        [15.4098,45.3703],[15.3944,45.3573],[15.3769,45.3457],[15.3643,45.3308],[15.3657,45.3206],
        [15.3547,45.3057],[15.3392,45.2958],[15.3193,45.2890],[15.3029,45.2760],[15.3113,45.2615],
        [15.3229,45.2456],[15.3321,45.2302],[15.3303,45.2257],[15.3199,45.2291],[15.2962,45.2344],
        [15.2803,45.2244],[15.2851,45.2090],[15.2909,45.1914],[15.3004,45.1786],[15.3163,45.1659],
        [15.3325,45.1526],[15.3470,45.1389],[15.3613,45.1242],[15.3597,45.1032],[15.3595,45.1019],
        [15.3638,45.0959],[15.3728,45.0908],[15.3731,45.0895],[15.3615,45.0748],[15.3566,45.0727],
        [15.3565,45.0722],[15.3581,45.0692],[15.3695,45.0579],[15.3894,45.0558],[15.4080,45.0455],
        [15.4100,45.0312],[15.3914,45.0303],[15.3993,45.0149],[15.4023,45.0113],[15.4108,44.9947],
        [15.4236,44.9824],[15.4381,44.9676],[15.4388,44.9657],[15.4463,44.9594],[15.4485,44.9547],
        [15.4518,44.9467],[15.4604,44.9341],[15.4640,44.9298],[15.4640,44.9286],[15.4636,44.9279],
        [15.4566,44.9139],[15.4721,44.8996],[15.4852,44.8858],[15.4904,44.8691],[15.4746,44.8670],
        [15.4547,44.8632],[15.4450,44.8597],[15.4268,44.8488],[15.4104,44.8415],[15.3874,44.8405],
        [15.3752,44.8248],[15.3748,44.8090],[15.3749,44.7917],[15.3875,44.7767],[15.3645,44.7740],
        [15.3595,44.7667],[15.3625,44.7544],[15.3654,44.7380],[15.3469,44.7282],[15.3498,44.7145],
        [15.3546,44.6974],[15.3566,44.6925],[15.3564,44.6913],[15.3578,44.6744],[15.3802,44.6599],
        [15.3917,44.6402],[15.4086,44.6268],[15.4182,44.6103],[15.4168,44.5923],[15.4116,44.5743],
        [15.4076,44.5558],[15.3894,44.5408],[15.4073,44.5279],[15.4274,44.5166],[15.4491,44.5037],
        [15.4694,44.4923],[15.4864,44.4765],[15.5004,44.4618],[15.5253,44.4532],[15.5509,44.4431],
        [15.5733,44.4345],[15.5972,44.4206],[15.6189,44.4087],[15.6422,44.3951],[15.6576,44.3804],
        [15.6776,44.3684],[15.7005,44.3592],[15.7227,44.3508],[15.7460,44.3394],[15.7667,44.3247],
        [15.7890,44.3155],[15.8155,44.3034],[15.8272,44.2905],[15.8501,44.2836],[15.8729,44.2770],
        [15.8957,44.2712],[15.9118,44.2600],[15.9134,44.2594],[15.9223,44.2614],[15.9404,44.2595],
        [15.9405,44.2601],[15.9404,44.2608],[15.9386,44.2629],[15.9383,44.2634],[15.9386,44.2646],
        [15.9596,44.2664],[15.9820,44.2673],[15.9914,44.2667],[15.9942,44.2618],[16.0008,44.2549],
        [16.0242,44.2518],[16.0439,44.2598],[16.0640,44.2497],[16.0759,44.2348],[16.0817,44.2170],
        [16.0892,44.1999],[16.0890,44.1872],[16.0972,44.1717],[16.1010,44.1656],[16.0931,44.1535],
        [16.1097,44.1400],[16.1319,44.1354],[16.1232,44.1207],[16.1089,44.1079],[16.1119,44.0909],
        [16.1251,44.0751],[16.1437,44.0633],[16.1629,44.0561],[16.1766,44.0710],[16.1963,44.0814],
        [16.1966,44.0657],[16.1943,44.0615],[16.1956,44.0444],[16.2062,44.0291],[16.2079,44.0105],
        [16.2045,43.9926],[16.2055,43.9741],[16.2120,43.9567],[16.2038,43.9392],[16.2039,43.9219],
        [16.2097,43.9016],[16.2043,43.8844],[16.1912,43.8695],[16.1783,43.8556],[16.1824,43.8412],
        [16.1630,43.8522],[16.1468,43.8447],[16.1437,43.8267],[16.1490,43.8101],[16.1590,43.7936],
        [16.1673,43.7763],[16.1863,43.7648],[16.1789,43.7499],[16.1814,43.7318],[16.1975,43.7192],
        [16.1834,43.7077],[16.1641,43.7013],[16.1459,43.6877],[16.1240,43.6802],[16.1087,43.6665],
        [16.1182,43.6526],[16.1413,43.6476],[16.1604,43.6365],[16.1817,43.6397],[16.1936,43.6318],
        [16.2153,43.6273],[16.2260,43.6128],[16.2254,43.5952],[16.2346,43.5786],[16.2341,43.5753],
        [16.2488,43.5656],[16.2719,43.5620],[16.2955,43.5622],[16.3165,43.5709],[16.3401,43.5688],
        [16.3630,43.5638],[16.3848,43.5555],[16.4093,43.5508],[16.4339,43.5487],[16.4565,43.5425],
        [16.4791,43.5353],[16.4753,43.5243],[16.4505,43.5219],[16.4424,43.5088],[16.4431,43.5048]
    ];

    // Zagreb Gk – Sisak, the M502 down the Sava plain, sampled every 2 km
    // (scripts/build-rail-corridor.mjs --corridor zagreb-sisak --coarse-step-m 2000).
    // Only 23 points: the line is nearly straight, so a coarse path costs nothing
    // in accuracy against a 2.5 km half-width.
    const ZAGREB_SISAK_PATH = [
        [15.9788,45.8045],[15.9583,45.7958],[15.9591,45.7788],[15.9749,45.7603],[15.9987,45.7432],
        [16.0264,45.7233],[16.0467,45.7087],[16.0650,45.6955],[16.0870,45.6797],[16.1055,45.6663],
        [16.1271,45.6508],[16.1493,45.6347],[16.1731,45.6175],[16.1941,45.6023],[16.2139,45.5880],
        [16.2354,45.5724],[16.2537,45.5591],[16.2786,45.5410],[16.2966,45.5280],[16.3214,45.5099],
        [16.3411,45.4977],[16.3692,45.4928],[16.3734,45.4921],
    ];

    // Nizinska pruga Karlovac – Rijeka: the DESIGNED new line (EIA
    // reconstruction, not OSM track), Karlovac through the Kapela tunnels to
    // Krasica. Generated from scripts/legacy-rail/nizinska-*/network.geojson
    // (corridors/nizinska-pruga-coarse.geojson, ~1 km + turn keeps).
    const NIZINSKA_PRUGA_PATH = [
        [15.5462,45.4951],[15.551,45.4868],[15.5564,45.4787],[15.5573,45.4698],[15.5549,45.4608],
        [15.5524,45.4519],[15.5489,45.4432],[15.543,45.4352],[15.5343,45.4284],[15.5252,45.4218],
        [15.5162,45.4152],[15.5092,45.4076],[15.5028,45.3998],[15.4944,45.393],[15.4836,45.3879],
        [15.4715,45.385],[15.459,45.3826],[15.4466,45.38],[15.4352,45.3756],[15.4262,45.369],
        [15.4202,45.3609],[15.417,45.3522],[15.414,45.3434],[15.411,45.3347],[15.4066,45.3263],
        [15.3993,45.3187],[15.39,45.3123],[15.3807,45.306],[15.3727,45.2991],[15.3669,45.291],
        [15.3631,45.2824],[15.3596,45.2738],[15.3561,45.2651],[15.3525,45.2565],[15.3494,45.2477],
        [15.3456,45.2392],[15.3396,45.2312],[15.3332,45.2234],[15.3266,45.2156],[15.3181,45.2087],
        [15.3088,45.2022],[15.2995,45.1958],[15.2903,45.1893],[15.2811,45.1827],[15.2708,45.1771],
        [15.2594,45.1726],[15.2472,45.1694],[15.2345,45.1674],[15.2218,45.1654],[15.209,45.1634],
        [15.1963,45.1615],[15.1836,45.1595],[15.1708,45.1575],[15.1581,45.1555],[15.1454,45.1535],
        [15.1326,45.1516],[15.1199,45.1496],[15.1071,45.1479],[15.0942,45.1468],[15.0812,45.1459],
        [15.0682,45.1455],[15.0551,45.1451],[15.0421,45.1446],[15.0291,45.144],[15.0161,45.1436],
        [15.0031,45.1432],[14.9901,45.1428],[14.9771,45.1423],[14.964,45.1419],[14.951,45.1415],
        [14.938,45.141],[14.925,45.1406],[14.912,45.1402],[14.899,45.1397],[14.8859,45.1393],
        [14.8729,45.1396],[14.8601,45.1412],[14.8477,45.1439],[14.8357,45.1476],[14.8238,45.1513],
        [14.8119,45.155],[14.7999,45.1587],[14.788,45.1624],[14.7767,45.167],[14.7665,45.1727],
        [14.7577,45.1795],[14.7494,45.1866],[14.741,45.1937],[14.7327,45.2008],[14.7244,45.2079],
        [14.7155,45.2146],[14.7054,45.2205],[14.6948,45.2258],[14.6837,45.2307],[14.6726,45.2356],
        [14.6615,45.2404],[14.6501,45.2449],[14.6386,45.2492],[14.6279,45.2545],[14.6185,45.2609],
        [14.6102,45.268],[14.6019,45.2752],[14.5937,45.2823],[14.5847,45.289],[14.5747,45.2949],
        [14.5645,45.3007],[14.5543,45.3064],[14.5523,45.3075],
    ];

    const REGISTRY = {
        zagreb: {
            id: 'zagreb',
            label: 'Zagreb',
            bbox: [15.70, 45.68, 16.25, 45.92],
            // What's prepared for this location (drives expectations, not code).
            prepared: { buildings: 'gdi', terrain: true, census: true },
            // Relief-map rendering may use the preprocessed LiDAR pyramid, while
            // simulation/profile requests stay on the established 20 m grid
            // until their movement-performance preprocessing is complete.
            terrainMapSource: 'best-available',
            simulationTerrainSource: 'dgu-dtm-20m',
        },
        split: {
            id: 'split',
            label: 'Split',
            bbox: [16.18, 43.43, 16.58, 43.64],   // Split–Trogir, DGU DEM footprint
            prepared: { buildings: 'overture', terrain: true, census: false },
            // First location simulating on the 1 m LiDAR DMR (imported for the
            // Trogir–Split corridor 2026-08-06): the real Divulje road-tunnel
            // cuttings exist in it, so portals and approaches follow the true
            // ground instead of a 20 m smoothing of the hill.
            terrainMapSource: 'best-available',
            simulationTerrainSource: 'best-available',
        },
        rijeka: {
            id: 'rijeka',
            label: 'Rijeka',
            // Rijeka bay, Opatija–Bakar: frames the Sušak–Brajdica tunnel
            // reconstruction with room for the rest of the Rijeka node. Widen
            // toward Istria only when an Istrian project actually needs it —
            // detection is first-bbox-wins and nothing else claims Kvarner.
            bbox: [14.28, 45.28, 14.62, 45.42],
            prepared: { buildings: 'overture', terrain: true, census: false },
            terrainSource: 'dgu-dtm-20m',
        },
        istria: {
            id: 'istria',
            label: 'Istra',
            // Istrian main line R101 (Pula–Pazin–Buzet) plus the Lupoglav–Raša
            // branch (L213). Its own claim rather than widening Rijeka, as the
            // Rijeka block anticipates: the two networks are ~50 km apart and
            // rail-connected only via Slovenia. East edge 14.22 stops short of
            // Rijeka's 14.28 so first-bbox-wins detection stays unambiguous.
            bbox: [13.72, 44.80, 14.22, 45.50],
            prepared: { buildings: 'overture', terrain: true, census: false },
            terrainSource: 'dgu-dtm-20m',
        },
        'sjeverna-dalmacija': {
            id: 'sjeverna-dalmacija',
            label: 'Sjeverna Dalmacija',
            // Zadar–Šibenik–Knin: the served area of the M606, M607 and L211
            // reconstructions. The south edge stops at 43.65, one hundredth of a
            // degree above Split's north edge, so no point can belong to both —
            // detectByLatLng returns the first bbox that matches.
            bbox: [15.15, 43.65, 16.30, 44.20],
            prepared: { buildings: 'overture', terrain: true, census: false },
            terrainSource: 'dgu-dtm-20m',
        },
        // A CORRIDOR location: its served area is the 5 km strip along the
        // Zagreb–Split railway, not a rectangle. It deliberately runs THROUGH
        // the city locations above, so detection has to be ordered — a city box
        // always wins, and the corridor picks up everything between them.
        'zagreb-split': {
            id: 'zagreb-split',
            label: 'Zagreb – Split (pruga)',
            corridor: { path: ZAGREB_SPLIT_PATH, widthM: 5000 },
            // bbox is the corridor's envelope, kept only for map framing and
            // whole-area queries. It is NOT the served area and must never be
            // used for detection — it covers Bosnia, Kvarner and open sea.
            bbox: [15.016, 43.45, 16.55, 45.85],
            prepared: { buildings: 'overture', terrain: true, census: false },
            terrainSource: 'dgu-dtm-20m',
        },
        // Nizinska pruga Karlovac – Rijeka: the planned new line. Karlovac's
        // stretch overlaps the zagreb-split corridor, and corridors are checked
        // in registry order, so this entry sits BEFORE zagreb-sisak but AFTER
        // zagreb-split — the legacy corridor keeps what it always served and
        // this one picks up the new alignment's own territory (Belaj–Tounj and
        // the whole Skradnik–Krasica middle). Rijeka's city box wins at the
        // coastal end, exactly as cities do everywhere else.
        'nizinska-pruga': {
            id: 'nizinska-pruga',
            label: 'Nizinska pruga (Karlovac – Rijeka)',
            corridor: { path: NIZINSKA_PRUGA_PATH, widthM: 5000 },
            // Envelope only, for map framing — never for detection.
            bbox: [14.52, 45.11, 15.59, 45.52],
            prepared: { buildings: 'overture', terrain: true, census: false },
            terrainSource: 'dgu-dtm-20m',
        },
        // Zagreb Gk – Sisak. Zagreb's own box already covers as far as Velika
        // Gorica, and detection is ordered, so this corridor only ever wins south
        // of it — which is exactly the stretch that had no prepared ground data.
        'zagreb-sisak': {
            id: 'zagreb-sisak',
            label: 'Zagreb – Sisak (pruga)',
            corridor: { path: ZAGREB_SISAK_PATH, widthM: 5000 },
            // Envelope only, for map framing — never for detection.
            bbox: [15.94, 45.44, 16.45, 45.82],
            prepared: { buildings: 'overture', terrain: true, census: false },
            terrainSource: 'dgu-dtm-20m',
        },
        croatia: {
            id: 'croatia',
            label: 'Hrvatska',
            // Envelope for map framing only. Point detection uses the exact
            // country geometry loaded from OSM relation 214885.
            bbox: [13.49, 42.39, 19.45, 46.56],
            country: true,
            prepared: { buildings: 'resolved', terrain: true, census: false },
            terrainMapSource: 'best-available',
            simulationTerrainSource: 'dgu-dtm-20m',
        },
    };

    const inBbox = (bbox, lat, lng) =>
        lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];

    const EARTH_RADIUS_M = 6371000;
    const DEG_TO_RAD = Math.PI / 180;
    const METRES_PER_DEGREE_LAT = DEG_TO_RAD * EARTH_RADIUS_M;

    // Metre distance from a point to one path segment, equirectangular about the
    // segment's latitude. Croatia is small enough for that to be exact to
    // centimetres, and this runs per drawing click.
    function distanceToSegmentM(lat, lng, a, b) {
        const scaleLon = METRES_PER_DEGREE_LAT * Math.max(0.05, Math.cos((a[1] + b[1]) / 2 * DEG_TO_RAD));
        const ax = a[0] * scaleLon, ay = a[1] * METRES_PER_DEGREE_LAT;
        const bx = b[0] * scaleLon, by = b[1] * METRES_PER_DEGREE_LAT;
        const px = lng * scaleLon, py = lat * METRES_PER_DEGREE_LAT;
        const dx = bx - ax, dy = by - ay;
        const lengthSq = dx * dx + dy * dy;
        const t = lengthSq > 0
            ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq))
            : 0;
        return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    }

    function distanceToCorridorM(corridor, lat, lng) {
        let best = Infinity;
        const path = corridor.path;
        for (let index = 0; index < path.length - 1; index += 1) {
            const distanceM = distanceToSegmentM(lat, lng, path[index], path[index + 1]);
            if (distanceM < best) best = distanceM;
        }
        return best;
    }

    const cityIds = () => Object.keys(REGISTRY).filter(id =>
        !REGISTRY[id].corridor && !REGISTRY[id].country
    );
    const corridorIds = () => Object.keys(REGISTRY).filter(id => REGISTRY[id].corridor);

    function pointInRing(lng, lat, ring) {
        let inside = false;
        for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
            const a = ring[index];
            const b = ring[previous];
            const crosses = (a[1] > lat) !== (b[1] > lat)
                && lng < (b[0] - a[0]) * (lat - a[1]) / (b[1] - a[1]) + a[0];
            if (crosses) inside = !inside;
        }
        return inside;
    }

    function pointInPolygon(lng, lat, polygon) {
        if (!polygon?.length || !pointInRing(lng, lat, polygon[0])) return false;
        for (let hole = 1; hole < polygon.length; hole += 1) {
            if (pointInRing(lng, lat, polygon[hole])) return false;
        }
        return true;
    }

    function isInCroatia(lat, lng) {
        const geometry = root.__croatiaBoundaryGeometry;
        if (!geometry || geometry.type !== 'MultiPolygon') return false;
        return geometry.coordinates.some(polygon => pointInPolygon(lng, lat, polygon));
    }

    // Cities first, corridors second: inside Zagreb you are in Zagreb, even
    // though the Split line starts there.
    function detectByLatLng(lat, lng) {
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        for (const id of cityIds()) {
            if (inBbox(REGISTRY[id].bbox, lat, lng)) return id;
        }
        for (const id of corridorIds()) {
            const { corridor } = REGISTRY[id];
            if (distanceToCorridorM(corridor, lat, lng) <= corridor.widthM / 2) return id;
        }
        if (isInCroatia(lat, lng)) return 'croatia';
        return null;
    }

    // Which prepared CITY a point looks like, for a corridor location that has no
    // style of its own: the containing city, else the nearest one. That is what
    // makes a 422 km ride farmland at the Zagreb end and karst at the Split end
    // instead of committing the whole line to one look.
    function nearestCityId(lat, lng) {
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        let best = null;
        let bestDistanceM = Infinity;
        for (const id of cityIds()) {
            const [west, south, east, north] = REGISTRY[id].bbox;
            if (inBbox(REGISTRY[id].bbox, lat, lng)) return id;
            const clampedLng = Math.min(east, Math.max(west, lng));
            const clampedLat = Math.min(north, Math.max(south, lat));
            const distanceM = distanceToSegmentM(lat, lng,
                [clampedLng, clampedLat], [clampedLng, clampedLat]);
            if (distanceM < bestDistanceM) { bestDistanceM = distanceM; best = id; }
        }
        return best;
    }

    // Detect a location from a set of [lat, lng] points (a project's track
    // vertices) via their centroid.
    function detectByPoints(points) {
        let sumLat = 0, sumLng = 0, n = 0;
        for (const p of points || []) {
            const lat = Number(p && p[0]);
            const lng = Number(p && p[1]);
            if (Number.isFinite(lat) && Number.isFinite(lng)) { sumLat += lat; sumLng += lng; n += 1; }
        }
        return n ? detectByLatLng(sumLat / n, sumLng / n) : null;
    }

    function isKnown(id) {
        return typeof id === 'string' && Object.prototype.hasOwnProperty.call(REGISTRY, id);
    }

    root.__locationRegistry = {
        REGISTRY,
        ids: Object.keys(REGISTRY),
        cityIds,
        corridorIds,
        detectByLatLng,
        detectByPoints,
        distanceToCorridorM,
        isKnown,
        nearestCityId,
        isInCroatia,
    };
}(typeof self !== 'undefined' ? self : this));
