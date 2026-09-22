import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createCopernicusDemProvider,
    samplePolyline,
    tileIdForCoordinate,
    tileUrlForCoordinate,
} from '../server/terrain/copernicus-dem.mjs';

test('Copernicus tile names follow the one-degree RasterPixelIsPoint grid', () => {
    assert.equal(
        tileIdForCoordinate(52.52, 13.405),
        'Copernicus_DSM_COG_10_N52_00_E013_00_DEM',
    );
    assert.equal(
        tileIdForCoordinate(-33.87, 151.21),
        'Copernicus_DSM_COG_10_S34_00_E151_00_DEM',
    );
    assert.equal(
        tileIdForCoordinate(52, 13),
        'Copernicus_DSM_COG_10_N51_00_E013_00_DEM',
    );
    assert.match(
        tileUrlForCoordinate(52.52, 13.405),
        /copernicus-dem-30m\.s3\.amazonaws\.com\/.+N52_00_E013_00_DEM\.tif$/,
    );
});

test('route sampling uses a stable metric chainage and includes both ends', () => {
    const sampled = samplePolyline([[13.4, 52.5], [13.4, 52.501]], 40);
    assert.equal(sampled.points[0].dM, 0);
    assert.ok(sampled.totalLengthM > 110 && sampled.totalLengthM < 112);
    assert.equal(sampled.points.at(-1).dM, sampled.totalLengthM);
    assert.equal(sampled.points.length, 4);
});

test('GLO-30 falls back per sample to GLO-90 and preserves real zero elevation', async () => {
    const calls = [];
    const store = {
        async sampleMany(source, coordinates) {
            calls.push({ source, coordinates });
            if (source === 'copernicus-glo30') {
                return coordinates.map(([lon]) => (lon < 13.5 ? 0 : null));
            }
            return coordinates.map(() => 91.25);
        },
    };
    const provider = createCopernicusDemProvider({ store });
    const seaLevel = await provider.point({ lat: 52.5, lon: 13.4 });
    const fallback = await provider.point({ lat: 52.5, lon: 13.6 });

    assert.equal(seaLevel.elevationM, 0);
    assert.equal(seaLevel.source.key, 'copernicus-glo30');
    assert.equal(fallback.elevationM, 91.25);
    assert.equal(fallback.source.key, 'copernicus-glo90');
    assert.deepEqual(calls.map(call => call.source), [
        'copernicus-glo30',
        'copernicus-glo30',
        'copernicus-glo90',
    ]);
});

test('profile and grid return explicit provenance and null NoData', async () => {
    const store = {
        async sampleMany(source, coordinates) {
            if (source === 'copernicus-glo30') {
                return coordinates.map(([, lat], index) => (index === 1 ? null : lat * 10));
            }
            return coordinates.map(() => null);
        },
    };
    const provider = createCopernicusDemProvider({ store });
    const profile = await provider.profile({
        coordinates: [[13.4, 52.5], [13.4, 52.5005]],
        stepM: 30,
    });
    assert.equal(profile.points.length, 3);
    assert.equal(profile.points[1].elevAslM, null);
    assert.equal(profile.points[1].sourceKey, null);
    assert.equal(profile.surfaceType, 'surface');
    assert.match(profile.datum, /EGM2008/);

    const grid = await provider.grid({
        bbox: [13.4, 52.5, 13.41, 52.51],
        width: 2,
        height: 2,
    });
    assert.equal(grid.values.length, 4);
    assert.equal(grid.values[1], null);
    assert.equal(grid.sourceIndexes[1], null);
    assert.equal(grid.sources[0].key, 'copernicus-glo30');
});

test('metadata advertises required operations but not optional rendered tiles', () => {
    const metadata = createCopernicusDemProvider({
        store: { sampleMany: async () => [] },
    }).metadata();
    assert.deepEqual(metadata.operations, ['metadata', 'coverage', 'point', 'profile', 'grid']);
    assert.equal(metadata.tiles, false);
    assert.deepEqual(metadata.stack.map(source => source.key), [
        'copernicus-glo30',
        'copernicus-glo90',
    ]);
    assert.ok(metadata.stack.every(source => source.surfaceType === 'surface'));
});

test('missing coordinates are rejected instead of being coerced to zero', async () => {
    const provider = createCopernicusDemProvider({
        store: { sampleMany: async () => [123] },
    });
    await assert.rejects(
        provider.point({ lat: null, lon: null }),
        /latitude must be finite|longitude must be finite/,
    );
});
