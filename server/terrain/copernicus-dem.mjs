import { fromUrl } from 'geotiff';

const EARTH_RADIUS_M = 6_371_008.8;
const DEFAULT_STEP_M = 30;
const MAX_PROFILE_VERTICES = 500;
const MAX_PROFILE_SAMPLES = 20_000;
const MAX_GRID_SIDE = 256;
const MAX_GRID_CELLS = 65_536;
const DEFAULT_CACHE_SIZE = 12;
const DEFAULT_CONCURRENCY = 4;

const GLO30_NOTICE = '© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.';
const GLO90_NOTICE = '© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.';
const LICENSE_URL = 'https://dataspace.copernicus.eu/sites/default/files/media/files/2025-06/copernicus_contributing_mission_data_access_v2_cop_dem_licenses.pdf';

const DATASETS = Object.freeze({
    'copernicus-glo30': Object.freeze({
        key: 'copernicus-glo30',
        provider: 'Copernicus',
        product: 'Copernicus DEM GLO-30 Public',
        revision: 'AWS Open Data 2021 release',
        resolutionM: 30,
        spacingArcSeconds: 1,
        resolutionToken: '10',
        bucketUrl: 'https://copernicus-dem-30m.s3.amazonaws.com',
        attribution: GLO30_NOTICE,
        liabilityNotice: 'The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30.',
    }),
    'copernicus-glo90': Object.freeze({
        key: 'copernicus-glo90',
        provider: 'Copernicus',
        product: 'Copernicus DEM GLO-90',
        revision: 'AWS Open Data 2021 release',
        resolutionM: 90,
        spacingArcSeconds: 3,
        resolutionToken: '30',
        bucketUrl: 'https://copernicus-dem-90m.s3.amazonaws.com',
        attribution: GLO90_NOTICE,
        liabilityNotice: 'The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-90.',
    }),
});

const SOURCE_STACKS = Object.freeze({
    'copernicus-glo30': Object.freeze(['copernicus-glo30', 'copernicus-glo90']),
    'copernicus-glo90': Object.freeze(['copernicus-glo90']),
});

export class TerrainInputError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TerrainInputError';
        this.statusCode = 400;
    }
}

export class TerrainUpstreamError extends Error {
    constructor(message, cause = null) {
        super(message, cause ? { cause } : undefined);
        this.name = 'TerrainUpstreamError';
        this.statusCode = 502;
    }
}

function finiteNumber(value, name) {
    if (value == null || (typeof value === 'string' && value.trim() === '')) {
        throw new TerrainInputError(`${name} must be finite`);
    }
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TerrainInputError(`${name} must be finite`);
    return number;
}

function coordinate(value, index = null) {
    if (!Array.isArray(value) || value.length < 2) {
        throw new TerrainInputError(`${index == null ? 'coordinate' : `coordinates[${index}]`} must be [longitude, latitude]`);
    }
    const lon = finiteNumber(value[0], 'longitude');
    const lat = finiteNumber(value[1], 'latitude');
    if (lat < -90 || lat > 90) throw new TerrainInputError('latitude must be between -90 and 90');
    if (lon < -180 || lon > 180) throw new TerrainInputError('longitude must be between -180 and 180');
    return { lon, lat };
}

function sourceStack(source) {
    const key = String(source || 'copernicus-glo30');
    const stack = SOURCE_STACKS[key];
    if (!stack) throw new TerrainInputError(`unsupported terrain source: ${key}`);
    return { key, stack };
}

function pad(value, width) {
    return String(Math.abs(value)).padStart(width, '0');
}

function latitudeTileDegree(latitude) {
    if (latitude === 90) return 89;
    if (Number.isInteger(latitude) && latitude > -90) return latitude - 1;
    return Math.floor(latitude);
}

function longitudeTileDegree(longitude) {
    if (longitude === 180) return 179;
    return Math.floor(longitude);
}

export function tileIdForCoordinate(latitude, longitude, source = 'copernicus-glo30') {
    const lat = finiteNumber(latitude, 'latitude');
    const lon = finiteNumber(longitude, 'longitude');
    if (lat < -90 || lat > 90) throw new TerrainInputError('latitude must be between -90 and 90');
    if (lon < -180 || lon > 180) throw new TerrainInputError('longitude must be between -180 and 180');
    const dataset = DATASETS[source];
    if (!dataset) throw new TerrainInputError(`unsupported terrain source: ${source}`);
    const south = latitudeTileDegree(lat);
    const west = longitudeTileDegree(lon);
    const northing = `${south < 0 ? 'S' : 'N'}${pad(south, 2)}_00`;
    const easting = `${west < 0 ? 'W' : 'E'}${pad(west, 3)}_00`;
    return `Copernicus_DSM_COG_${dataset.resolutionToken}_${northing}_${easting}_DEM`;
}

export function tileUrlForCoordinate(latitude, longitude, source = 'copernicus-glo30', baseUrl = null) {
    const dataset = DATASETS[source];
    if (!dataset) throw new TerrainInputError(`unsupported terrain source: ${source}`);
    const tileId = tileIdForCoordinate(latitude, longitude, source);
    const root = String(baseUrl || dataset.bucketUrl).replace(/\/+$/, '');
    return `${root}/${tileId}/${tileId}.tif`;
}

function publicMetadata(dataset) {
    return Object.freeze({
        key: dataset.key,
        provider: dataset.provider,
        product: dataset.product,
        revision: dataset.revision,
        horizontalCrs: 'EPSG:4326 (WGS84-G1150)',
        verticalReference: 'EPSG:3855 (EGM2008 orthometric height)',
        datum: 'EGM2008 (EPSG:3855)',
        surfaceType: 'surface',
        resolutionM: dataset.resolutionM,
        spacingArcSeconds: dataset.spacingArcSeconds,
        quality: 'preliminary planning surface',
        license: 'Copernicus WorldDEM free licence',
        licenseUrl: LICENSE_URL,
        attribution: dataset.attribution,
        liabilityNotice: dataset.liabilityNotice,
    });
}

function cacheTouch(cache, key, value) {
    cache.delete(key);
    cache.set(key, value);
}

function evictOldest(cache, maximum) {
    while (cache.size > maximum) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
    }
}

async function mapLimit(items, limit, worker) {
    const values = Array.from(items);
    const results = new Array(values.length);
    let cursor = 0;
    async function run() {
        while (cursor < values.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await worker(values[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
    return results;
}

function validElevation(value, noData) {
    if (value == null) return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number <= -1e20) return null;
    if (Number.isFinite(noData) && number === noData) return null;
    return number;
}

function weightedElevation(values, weights, noData) {
    let weighted = 0;
    let totalWeight = 0;
    for (let index = 0; index < values.length; index += 1) {
        const elevation = validElevation(values[index], noData);
        if (elevation == null || weights[index] <= 0) continue;
        weighted += elevation * weights[index];
        totalWeight += weights[index];
    }
    return totalWeight > 0 ? weighted / totalWeight : null;
}

export class CopernicusCogStore {
    constructor(options = {}) {
        this.fetchImpl = options.fetchImpl || globalThis.fetch;
        this.fromUrlImpl = options.fromUrlImpl || fromUrl;
        this.cacheSize = Math.max(1, Number(options.cacheSize) || DEFAULT_CACHE_SIZE);
        this.concurrency = Math.max(1, Number(options.concurrency) || DEFAULT_CONCURRENCY);
        this.baseUrls = Object.freeze({ ...(options.baseUrls || {}) });
        this.images = new Map();
    }

    async imageFor(dataset, point) {
        const tileId = tileIdForCoordinate(point.lat, point.lon, dataset.key);
        const key = `${dataset.key}:${tileId}`;
        if (this.images.has(key)) {
            const cached = this.images.get(key);
            cacheTouch(this.images, key, cached);
            return cached;
        }
        const pending = this.loadImage(dataset, point, tileId).catch((error) => {
            this.images.delete(key);
            throw error;
        });
        cacheTouch(this.images, key, pending);
        evictOldest(this.images, this.cacheSize);
        return pending;
    }

    async loadImage(dataset, point, tileId) {
        const url = tileUrlForCoordinate(
            point.lat,
            point.lon,
            dataset.key,
            this.baseUrls[dataset.key],
        );
        let response;
        try {
            response = await this.fetchImpl(url, { method: 'HEAD' });
        } catch (error) {
            throw new TerrainUpstreamError(`Copernicus DEM coverage check failed for ${tileId}`, error);
        }
        if (response.status === 403 || response.status === 404) return null;
        if (!response.ok) {
            throw new TerrainUpstreamError(`Copernicus DEM coverage check returned HTTP ${response.status}`);
        }
        try {
            const tiff = await this.fromUrlImpl(url);
            const image = await tiff.getImage();
            return Object.freeze({ image, tileId, url });
        } catch (error) {
            throw new TerrainUpstreamError(`Could not open Copernicus DEM tile ${tileId}`, error);
        }
    }

    async sampleMany(source, rawCoordinates) {
        const dataset = DATASETS[source];
        if (!dataset) throw new TerrainInputError(`unsupported terrain source: ${source}`);
        const points = rawCoordinates.map((value, index) => ({
            ...coordinate(value, index),
            index,
        }));
        const output = new Array(points.length).fill(null);
        const tileGroups = new Map();
        for (const point of points) {
            const tileId = tileIdForCoordinate(point.lat, point.lon, source);
            if (!tileGroups.has(tileId)) tileGroups.set(tileId, []);
            tileGroups.get(tileId).push(point);
        }

        await mapLimit(tileGroups.values(), this.concurrency, async (group) => {
            const opened = await this.imageFor(dataset, group[0]);
            if (!opened) return;
            await this.sampleImageGroup(opened.image, group, output);
        });
        return output;
    }

    async sampleImageGroup(image, points, output) {
        const width = image.getWidth();
        const height = image.getHeight();
        const [originX, originY] = image.getOrigin();
        const [resolutionX, resolutionY] = image.getResolution();
        const tileWidth = Math.max(1, image.getTileWidth());
        const tileHeight = Math.max(1, image.getTileHeight());
        const rawNoData = image.getGDALNoData();
        const noData = rawNoData == null ? null : Number(rawNoData);
        const blocks = new Map();

        for (const point of points) {
            const rawX = (point.lon - originX) / resolutionX;
            const rawY = (point.lat - originY) / resolutionY;
            if (!Number.isFinite(rawX) || !Number.isFinite(rawY)
                || rawX < -1e-7 || rawY < -1e-7
                || rawX > width - 1 + 1e-7 || rawY > height - 1 + 1e-7) continue;
            const x = Math.max(0, Math.min(width - 1, rawX));
            const y = Math.max(0, Math.min(height - 1, rawY));
            const x0 = Math.max(0, Math.min(width - 1, Math.floor(x + 1e-10)));
            const y0 = Math.max(0, Math.min(height - 1, Math.floor(y + 1e-10)));
            const sample = {
                ...point,
                x0,
                y0,
                x1: Math.min(width - 1, x0 + 1),
                y1: Math.min(height - 1, y0 + 1),
                tx: Math.max(0, Math.min(1, x - x0)),
                ty: Math.max(0, Math.min(1, y - y0)),
            };
            const blockKey = `${Math.floor(x0 / tileWidth)}:${Math.floor(y0 / tileHeight)}`;
            if (!blocks.has(blockKey)) blocks.set(blockKey, []);
            blocks.get(blockKey).push(sample);
        }

        await mapLimit(blocks.values(), this.concurrency, async (samples) => {
            const left = Math.min(...samples.map(sample => sample.x0));
            const top = Math.min(...samples.map(sample => sample.y0));
            const right = Math.max(...samples.map(sample => sample.x1)) + 1;
            const bottom = Math.max(...samples.map(sample => sample.y1)) + 1;
            const rasters = await image.readRasters({
                window: [left, top, right, bottom],
                samples: [0],
            });
            const band = rasters[0];
            const rasterWidth = Number(rasters.width) || (right - left);
            const at = (x, y) => band[(y - top) * rasterWidth + (x - left)];
            for (const sample of samples) {
                const weights = [
                    (1 - sample.tx) * (1 - sample.ty),
                    sample.tx * (1 - sample.ty),
                    (1 - sample.tx) * sample.ty,
                    sample.tx * sample.ty,
                ];
                output[sample.index] = weightedElevation([
                    at(sample.x0, sample.y0),
                    at(sample.x1, sample.y0),
                    at(sample.x0, sample.y1),
                    at(sample.x1, sample.y1),
                ], weights, noData);
            }
        });
    }
}

function toRadians(value) {
    return value * Math.PI / 180;
}

function toDegrees(value) {
    return value * 180 / Math.PI;
}

function haversineMeters(a, b) {
    const lat1 = toRadians(a.lat);
    const lat2 = toRadians(b.lat);
    const dLat = lat2 - lat1;
    const dLon = toRadians(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function greatCirclePoint(a, b, fraction) {
    if (fraction <= 0) return { ...a };
    if (fraction >= 1) return { ...b };
    const lat1 = toRadians(a.lat);
    const lon1 = toRadians(a.lon);
    const lat2 = toRadians(b.lat);
    const lon2 = toRadians(b.lon);
    const angularDistance = haversineMeters(a, b) / EARTH_RADIUS_M;
    if (angularDistance < 1e-12) return { ...a };
    const sinDistance = Math.sin(angularDistance);
    const weightA = Math.sin((1 - fraction) * angularDistance) / sinDistance;
    const weightB = Math.sin(fraction * angularDistance) / sinDistance;
    const x = weightA * Math.cos(lat1) * Math.cos(lon1)
        + weightB * Math.cos(lat2) * Math.cos(lon2);
    const y = weightA * Math.cos(lat1) * Math.sin(lon1)
        + weightB * Math.cos(lat2) * Math.sin(lon2);
    const z = weightA * Math.sin(lat1) + weightB * Math.sin(lat2);
    return {
        lon: toDegrees(Math.atan2(y, x)),
        lat: toDegrees(Math.atan2(z, Math.sqrt(x * x + y * y))),
    };
}

export function samplePolyline(rawCoordinates, requestedStepM = DEFAULT_STEP_M) {
    if (!Array.isArray(rawCoordinates) || rawCoordinates.length < 2) {
        throw new TerrainInputError('coordinates must contain at least two positions');
    }
    if (rawCoordinates.length > MAX_PROFILE_VERTICES) {
        throw new TerrainInputError(`coordinates may contain at most ${MAX_PROFILE_VERTICES} positions`);
    }
    const coordinates = rawCoordinates.map((value, index) => coordinate(value, index));
    const stepM = Math.max(5, Math.min(500, finiteNumber(requestedStepM, 'stepM')));
    const cumulative = [0];
    for (let index = 1; index < coordinates.length; index += 1) {
        cumulative.push(cumulative[index - 1] + haversineMeters(coordinates[index - 1], coordinates[index]));
    }
    const totalLengthM = cumulative[cumulative.length - 1];
    if (totalLengthM <= 0) throw new TerrainInputError('coordinates must describe a non-zero route');
    const sampleCount = Math.ceil(totalLengthM / stepM) + 1;
    if (sampleCount > MAX_PROFILE_SAMPLES) {
        throw new TerrainInputError(`profile would exceed ${MAX_PROFILE_SAMPLES} samples; increase stepM or split the route`);
    }
    const distances = [];
    for (let distance = 0; distance < totalLengthM; distance += stepM) distances.push(distance);
    distances.push(totalLengthM);
    let segment = 1;
    return {
        stepM,
        totalLengthM,
        points: distances.map((dM) => {
            while (segment < cumulative.length - 1 && cumulative[segment] < dM) segment += 1;
            const startD = cumulative[segment - 1];
            const endD = cumulative[segment];
            const fraction = (dM - startD) / Math.max(1e-9, endD - startD);
            return { dM, ...greatCirclePoint(coordinates[segment - 1], coordinates[segment], fraction) };
        }),
    };
}

function gridDefinition(rawBbox, rawWidth, rawHeight) {
    if (!Array.isArray(rawBbox) || rawBbox.length !== 4) {
        throw new TerrainInputError('bbox must be [west, south, east, north]');
    }
    const [west, south, east, north] = rawBbox.map((value, index) => finiteNumber(value, `bbox[${index}]`));
    if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) {
        throw new TerrainInputError('bbox must be an ordered EPSG:4326 extent');
    }
    const width = Math.floor(finiteNumber(rawWidth, 'width'));
    const height = Math.floor(finiteNumber(rawHeight, 'height'));
    if (width < 1 || height < 1 || width > MAX_GRID_SIDE || height > MAX_GRID_SIDE
        || width * height > MAX_GRID_CELLS) {
        throw new TerrainInputError(`grid dimensions must be between 1 and ${MAX_GRID_SIDE} with at most ${MAX_GRID_CELLS} cells`);
    }
    const longitudes = Array.from({ length: width }, (_, index) => (
        width === 1 ? (west + east) / 2 : west + (east - west) * index / (width - 1)
    ));
    const latitudes = Array.from({ length: height }, (_, index) => (
        height === 1 ? (south + north) / 2 : north - (north - south) * index / (height - 1)
    ));
    const coordinates = latitudes.flatMap(lat => longitudes.map(lon => [lon, lat]));
    return { bbox: [west, south, east, north], width, height, longitudes, latitudes, coordinates };
}

function rounded(value, digits = 3) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

export function createCopernicusDemProvider(options = {}) {
    const store = options.store || new CopernicusCogStore(options);

    async function resolveSamples(source, coordinates) {
        const request = sourceStack(source);
        const resolved = new Array(coordinates.length).fill(null);
        let unresolved = coordinates.map((_, index) => index);
        for (const datasetKey of request.stack) {
            if (unresolved.length === 0) break;
            const values = await store.sampleMany(datasetKey, unresolved.map(index => coordinates[index]));
            const next = [];
            unresolved.forEach((originalIndex, valueIndex) => {
                const elevationM = validElevation(values[valueIndex], null);
                if (elevationM == null) next.push(originalIndex);
                else resolved[originalIndex] = { elevationM, sourceKey: datasetKey };
            });
            unresolved = next;
        }
        return { requestedSource: request.key, samples: resolved };
    }

    function metadata(source = 'copernicus-glo30') {
        const request = sourceStack(source);
        return Object.freeze({
            id: request.key,
            stack: Object.freeze(request.stack.map(key => publicMetadata(DATASETS[key]))),
            operations: Object.freeze(['metadata', 'coverage', 'point', 'profile', 'grid']),
            tiles: false,
            interpolation: 'bilinear',
            noData: null,
        });
    }

    async function point({ lat, lon, source = 'copernicus-glo30' }) {
        const pointCoordinate = coordinate([lon, lat]);
        const resolved = await resolveSamples(source, [[pointCoordinate.lon, pointCoordinate.lat]]);
        const sample = resolved.samples[0];
        return {
            elevationM: sample ? rounded(sample.elevationM) : null,
            datum: 'EGM2008 (EPSG:3855)',
            requestedSource: resolved.requestedSource,
            source: sample ? publicMetadata(DATASETS[sample.sourceKey]) : null,
        };
    }

    async function coverage(input) {
        const result = await point(input);
        return {
            available: result.elevationM != null,
            requestedSource: result.requestedSource,
            source: result.source,
        };
    }

    async function profile({ coordinates, stepM = DEFAULT_STEP_M, source = 'copernicus-glo30' }) {
        const route = samplePolyline(coordinates, stepM);
        const resolved = await resolveSamples(source, route.points.map(point => [point.lon, point.lat]));
        const sourceKeys = [...new Set(resolved.samples.filter(Boolean).map(sample => sample.sourceKey))];
        return {
            points: route.points.map((routePoint, index) => ({
                dM: rounded(routePoint.dM),
                lon: rounded(routePoint.lon, 7),
                lat: rounded(routePoint.lat, 7),
                elevAslM: resolved.samples[index] ? rounded(resolved.samples[index].elevationM) : null,
                sourceKey: resolved.samples[index]?.sourceKey || null,
            })),
            stepM: route.stepM,
            totalLengthM: rounded(route.totalLengthM),
            source: resolved.requestedSource,
            sources: sourceKeys.map(key => publicMetadata(DATASETS[key])),
            datum: 'EGM2008 (EPSG:3855)',
            surfaceType: 'surface',
            quality: 'preliminary',
        };
    }

    async function grid({ bbox, width, height, source = 'copernicus-glo30' }) {
        const definition = gridDefinition(bbox, width, height);
        const resolved = await resolveSamples(source, definition.coordinates);
        const sourceKeys = [...new Set(resolved.samples.filter(Boolean).map(sample => sample.sourceKey))];
        const sourceIndex = new Map(sourceKeys.map((key, index) => [key, index]));
        return {
            bbox: definition.bbox,
            width: definition.width,
            height: definition.height,
            longitudes: definition.longitudes.map(value => rounded(value, 7)),
            latitudes: definition.latitudes.map(value => rounded(value, 7)),
            values: resolved.samples.map(sample => sample ? rounded(sample.elevationM) : null),
            sourceIndexes: resolved.samples.map(sample => sample ? sourceIndex.get(sample.sourceKey) : null),
            source: resolved.requestedSource,
            sources: sourceKeys.map(key => publicMetadata(DATASETS[key])),
            datum: 'EGM2008 (EPSG:3855)',
            surfaceType: 'surface',
            quality: 'preliminary',
        };
    }

    return Object.freeze({ metadata, coverage, point, profile, grid });
}

export const COPERNICUS_DEM_DATASETS = DATASETS;
export const COPERNICUS_DEM_SOURCE_STACKS = SOURCE_STACKS;
