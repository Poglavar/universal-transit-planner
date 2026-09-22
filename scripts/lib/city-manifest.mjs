const CAPABILITY_PROVIDER_PATHS = Object.freeze({
    routing: ['providers.routing'],
    terrain: ['providers.terrain'],
    terrainTiles: ['providers.terrain'],
    population: ['providers.population'],
    jobs: ['providers.jobs'],
    referenceTransit: ['providers.referenceTransit', 'staticData.tramStops'],
    referenceRail: ['providers.referenceRail', 'staticData.railTracks'],
    station3d: ['station3d.worldProfile'],
    persistence: ['providers.persistence'],
});

export const CAPABILITY_KEYS = Object.freeze([
    ...Object.keys(CAPABILITY_PROVIDER_PATHS),
    'campaigns',
]);

function valueAtPath(value, path) {
    return path.split('.').reduce((current, key) => current?.[key], value);
}

function isPresent(value) {
    return Array.isArray(value) ? value.length > 0 : value != null && value !== '';
}

function isSafePackScript(value) {
    return typeof value === 'string'
        && /^(?:[a-z0-9][a-z0-9._-]*\/)*[a-z0-9][a-z0-9._-]*\.js$/i.test(value)
        && !value.split('/').includes('..');
}

function isSafeRelativePath(value) {
    return typeof value === 'string'
        && value.length > 0
        && !value.startsWith('/')
        && !value.split('/').includes('..')
        && /^[a-z0-9][a-z0-9._/-]*$/i.test(value);
}

export function validateCityManifest(city, expectedId = null) {
    const errors = [];
    const add = message => errors.push(message);

    if (!city || typeof city !== 'object' || Array.isArray(city)) {
        return ['manifest must be a JSON object'];
    }

    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(city.id || '')) add('id must be kebab-case');
    if (expectedId && city.id !== expectedId) add(`id ${city.id} does not match ${expectedId}`);
    if (typeof city.name !== 'string' || !city.name.trim()) add('name must be a non-empty string');
    if (!Array.isArray(city.center) || city.center.length !== 2
        || !Number.isFinite(city.center[0]) || city.center[0] < -90 || city.center[0] > 90
        || !Number.isFinite(city.center[1]) || city.center[1] < -180 || city.center[1] > 180) {
        add('center must be [latitude, longitude]');
    }
    if (!Number.isFinite(city.zoom) || city.zoom < 0 || city.zoom > 24) add('zoom must be between 0 and 24');

    const bounds = city.bounds || {};
    if (![bounds.west, bounds.south, bounds.east, bounds.north].every(Number.isFinite)) {
        add('bounds must contain finite west, south, east and north values');
    } else {
        if (bounds.west >= bounds.east) add('bounds.west must be less than bounds.east');
        if (bounds.south >= bounds.north) add('bounds.south must be less than bounds.north');
    }

    for (const key of ['locale', 'timezone', 'currency', 'dataRevision']) {
        if (typeof city[key] !== 'string' || !city[key].trim()) add(`${key} must be a non-empty string`);
    }
    if (!['metric', 'imperial'].includes(city.units)) add('units must be metric or imperial');
    if (!city.providers || typeof city.providers !== 'object') add('providers must be an object');
    if (!isPresent(city.providers?.basemap?.url)) add('providers.basemap.url is required');
    if (!Array.isArray(city.attributions)) {
        add('attributions must be an array');
    } else {
        city.attributions.forEach((attribution, index) => {
            if (!attribution || typeof attribution !== 'object' || Array.isArray(attribution)) {
                add(`attributions[${index}] must be an object`);
                return;
            }
            if (typeof attribution.name !== 'string' || !attribution.name.trim()) {
                add(`attributions[${index}].name must be a non-empty string`);
            }
            for (const field of ['url', 'license', 'licenseUrl']) {
                if (attribution[field] !== undefined
                    && (typeof attribution[field] !== 'string' || !attribution[field].trim())) {
                    add(`attributions[${index}].${field} must be a non-empty string when present`);
                }
            }
        });
    }
    if (city.cityPack !== undefined) {
        if (!city.cityPack || typeof city.cityPack !== 'object' || Array.isArray(city.cityPack)) {
            add('cityPack must be an object');
        } else {
            for (const phase of ['prePlanner', 'simulation']) {
                const scripts = city.cityPack[phase];
                if (scripts === undefined) continue;
                if (!Array.isArray(scripts) || !scripts.every(isSafePackScript)) {
                    add(`cityPack.${phase} must contain safe relative JavaScript paths`);
                }
            }
            if (city.cityPack.publicAssets !== undefined) {
                if (!Array.isArray(city.cityPack.publicAssets)) {
                    add('cityPack.publicAssets must be an array');
                } else {
                    city.cityPack.publicAssets.forEach((asset, index) => {
                        if (!asset || typeof asset !== 'object' || Array.isArray(asset)
                            || !isSafeRelativePath(asset.source)
                            || !isSafeRelativePath(asset.target)) {
                            add(`cityPack.publicAssets[${index}] must contain safe source and target paths`);
                        }
                    });
                }
            }
            for (const phase of Object.keys(city.cityPack)) {
                if (!['prePlanner', 'simulation', 'publicAssets'].includes(phase)) {
                    add(`cityPack.${phase} is not a supported loading phase`);
                }
            }
        }
    }
    if (city.objectBrowser !== undefined) {
        if (!city.objectBrowser || typeof city.objectBrowser !== 'object'
            || !isSafeRelativePath(city.objectBrowser.path)) {
            add('objectBrowser.path must be a safe relative path');
        }
    }

    if (!city.features || typeof city.features !== 'object') {
        add('features must be an object');
    } else {
        for (const capability of CAPABILITY_KEYS) {
            if (typeof city.features[capability] !== 'boolean') {
                add(`features.${capability} must be boolean`);
            }
        }
        if (city.features.campaigns !== false) add('features.campaigns must be false');
        for (const [capability, paths] of Object.entries(CAPABILITY_PROVIDER_PATHS)) {
            if (city.features[capability] === true && !paths.some(path => isPresent(valueAtPath(city, path)))) {
                add(`features.${capability} requires one of: ${paths.join(', ')}`);
            }
        }
        if (city.features.terrainTiles === true && city.features.terrain !== true) {
            add('features.terrainTiles requires features.terrain');
        }
        if (city.features.terrain === true) {
            const operations = city.providerOperations?.terrain;
            for (const operation of ['metadata', 'coverage', 'point', 'profile', 'grid']) {
                if (operations?.[operation] !== true) {
                    add(`features.terrain requires providerOperations.terrain.${operation}`);
                }
            }
            const reference = city.terrainReference;
            for (const field of ['horizontalCrs', 'verticalReference', 'unit', 'revision']) {
                if (typeof reference?.[field] !== 'string' || !reference[field].trim()) {
                    add(`features.terrain requires terrainReference.${field}`);
                }
            }
            if (!['terrain', 'surface'].includes(reference?.surfaceType)) {
                add('features.terrain requires terrainReference.surfaceType terrain or surface');
            }
        }
        if (city.features.terrainTiles === true
            && city.providerOperations?.terrain?.tiles !== true) {
            add('features.terrainTiles requires providerOperations.terrain.tiles');
        }
    }

    return errors;
}

export function assertValidCityManifest(city, expectedId = null) {
    const errors = validateCityManifest(city, expectedId);
    if (errors.length) {
        throw new Error(`Invalid city manifest:\n- ${errors.join('\n- ')}`);
    }
    return city;
}
