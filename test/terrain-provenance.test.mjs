import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(
    new URL('../web/planner-grade/vertical-profile.js', import.meta.url),
    'utf8',
);
const module = { exports: {} };
vm.runInContext(source, vm.createContext({
    module,
    require: () => ({}),
    globalThis: {},
}));
const verticalProfile = module.exports;

test('stored vertical profiles preserve normalized terrain provenance and revision', () => {
    const inputRevision = 'terrain-bilinear-v5|copernicus-glo30|copernicus-dem-aws-2021';
    const built = verticalProfile.buildVerticalProfile({
        pvis: [
            { dM: 0, elevAslM: 35, locked: false },
            { dM: 20, elevAslM: 36, locked: false },
        ],
        steps: [
            { elevAslM: 35, terrainAslM: 34.5, regime: 'at-grade' },
            { elevAslM: 36, terrainAslM: 35.5, regime: 'at-grade' },
        ],
        violations: [],
        structureConstraints: [],
    }, {
        stepM: 20,
        geomHash: 'abc123',
        inputRevision,
        terrainProvenance: {
            requestedSource: 'copernicus-glo30',
            horizontalCrs: 'EPSG:4326',
            verticalReference: 'EPSG:3855 (EGM2008)',
            surfaceType: 'surface',
            unit: 'm',
            revision: 'copernicus-dem-aws-2021',
            quality: 'preliminary',
            sources: [{
                key: 'copernicus-glo30',
                provider: 'Copernicus',
                product: 'Copernicus DEM GLO-30 Public',
                revision: 'AWS Open Data 2021 release',
                resolutionM: 30,
                horizontalCrs: 'EPSG:4326 (WGS84-G1150)',
                verticalReference: 'EPSG:3855 (EGM2008 orthometric height)',
                surfaceType: 'surface',
            }],
        },
    });

    const parsed = verticalProfile.parseVerticalProfile(built);
    assert.equal(parsed.inputRevision, inputRevision);
    assert.equal(parsed.terrainProvenance.requestedSource, 'copernicus-glo30');
    assert.equal(parsed.terrainProvenance.sources[0].resolutionM, 30);
    assert.equal(parsed.terrainProvenance.sources[0].horizontalCrs, 'EPSG:4326 (WGS84-G1150)');

    const runtime = verticalProfile.runtimeTerrainProfileFromSavedProfile(parsed, {
        geomHash: 'abc123',
        source: 'copernicus-glo30',
        inputRevision,
    });
    assert.equal(runtime.provenance.revision, 'copernicus-dem-aws-2021');
    assert.equal(verticalProfile.runtimeTerrainProfileFromSavedProfile(parsed, {
        geomHash: 'abc123',
        source: 'copernicus-glo30',
        inputRevision: `${inputRevision}-changed`,
    }), null);
});
