import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateCityManifest } from '../scripts/lib/city-manifest.mjs';

async function readManifest(id) {
    return JSON.parse(await readFile(new URL(`../config/cities/${id}.json`, import.meta.url), 'utf8'));
}

const [zagreb, example] = await Promise.all([
    readManifest('zagreb'),
    readManifest('example'),
]);

test('checked-in city manifests satisfy the runtime contract', () => {
    assert.deepEqual(validateCityManifest(zagreb, 'zagreb'), []);
    assert.deepEqual(validateCityManifest(example, 'example'), []);
});

test('provider attribution records require a name', () => {
    const invalid = structuredClone(example);
    invalid.attributions = [{}];
    assert.match(validateCityManifest(invalid).join('\n'), /attributions\[0\]\.name/);
});

test('portable example city enables the implemented Copernicus profile provider', () => {
    assert.equal(example.locale, 'en');
    assert.deepEqual(example.providers.terrain, ['copernicus-glo30']);
    assert.equal(example.providers.apiBaseUrl, '/api');
    assert.equal(example.features.terrain, true);
    assert.equal(example.features.terrainTiles, false);
    assert.equal(example.terrainReference.verticalReference, 'EPSG:3855 (EGM2008)');
    assert.equal(example.terrainReference.surfaceType, 'surface');
    assert.deepEqual(
        Object.entries(example.providerOperations.terrain)
            .filter(([, enabled]) => enabled)
            .map(([operation]) => operation),
        ['metadata', 'coverage', 'point', 'profile', 'grid'],
    );
    assert.ok(Object.entries(example.features)
        .filter(([feature]) => feature !== 'terrain')
        .every(([, value]) => value === false));
    assert.doesNotMatch(JSON.stringify(example), /zagreb|dgu/i);
});

test('enabled capabilities require a backing provider or dataset', () => {
    const invalid = structuredClone(example);
    invalid.features.terrain = true;
    delete invalid.providers.terrain;
    assert.ok(validateCityManifest(invalid, 'example').some(error => (
        error.includes('features.terrain requires')
    )));
});

test('terrain capability requires the complete provider operation contract', () => {
    const invalid = structuredClone(example);
    invalid.providerOperations.terrain.grid = false;
    assert.ok(validateCityManifest(invalid, 'example').some(error => (
        error.includes('providerOperations.terrain.grid')
    )));

    const invalidTiles = structuredClone(example);
    invalidTiles.features.terrainTiles = true;
    assert.ok(validateCityManifest(invalidTiles, 'example').some(error => (
        error.includes('providerOperations.terrain.tiles')
    )));

    const invalidReference = structuredClone(example);
    delete invalidReference.terrainReference.revision;
    assert.ok(validateCityManifest(invalidReference, 'example').some(error => (
        error.includes('terrainReference.revision')
    )));
});

test('campaign capability cannot be enabled', () => {
    const invalid = structuredClone(example);
    invalid.features.campaigns = true;
    assert.ok(validateCityManifest(invalid).some(error => error.includes('campaigns must be false')));
});

test('city-pack script phases accept only safe relative JavaScript paths', () => {
    const invalid = structuredClone(example);
    invalid.cityPack = { prePlanner: ['../private.js'] };
    assert.ok(validateCityManifest(invalid).some(error => error.includes('safe relative')));

    const valid = structuredClone(example);
    valid.cityPack = { prePlanner: ['registry.js'], simulation: ['sim/tram.js'] };
    assert.deepEqual(validateCityManifest(valid, 'example'), []);
});

test('local terrain configuration declares source identity', () => {
    assert.deepEqual(zagreb.providers.terrain, ['best-available', 'dgu-dtm-20m']);
    assert.equal(zagreb.station3d.worldProfile.terrain.source, 'dgu-dtm-20m');
    assert.equal(zagreb.station3d.worldProfile.terrain.detail.source, 'best-available');
    assert.equal(
        zagreb.attributions.find(attribution => attribution.name === 'Državna geodetska uprava')?.license,
        'Use approved separately for this deployment',
    );
});
