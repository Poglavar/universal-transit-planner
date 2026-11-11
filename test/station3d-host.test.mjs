import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function commonJsApi(path) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    const module = { exports: {} };
    const context = vm.createContext({ module, URL, URLSearchParams, Promise, console });
    vm.runInContext(source, context, { filename: path });
    return module.exports;
}

test('planner configures Station3D without exposing campaigns', async () => {
    const adapter = await commonJsApi('../web/station3d-planner.js');
    const calls = [];
    const station3D = {
        configureWorld: value => calls.push(['world', value]),
        configureHost: value => calls.push(['host', value]),
    };
    adapter.configure(station3D, {
        apiBaseUrl: 'https://example.test/api',
        city: {
            id: 'example',
            name: 'Example City',
            bounds: { west: 1, south: 2, east: 3, north: 4 },
            attributions: [{ name: 'Example data' }],
            station3d: {
                worldProfile: { id: 'example-world', buildings: 'overture' },
                loadingScreen: {
                    logoUrl: 'city-pack/example-logo.svg',
                    logoAlt: 'Example Transit',
                    background: '#102030',
                    foreground: '#f8fafc',
                    accent: '#38bdf8',
                },
            },
        },
    });
    assert.equal(calls[0][1].id, 'transit-planner-example');
    assert.equal(calls[0][1].worldProfile.id, 'example-world');
    assert.equal(calls[1][1].name, 'Example City Transit Planner');
    assert.equal(calls[1][1].loadingScreen.logoUrl, 'city-pack/example-logo.svg');
    assert.equal(calls[1][1].loadingScreen.logoAlt, 'Example Transit');
    assert.equal(calls[1][1].loadingScreen.background, '#102030');
    assert.equal(calls[1][1].loadingScreen.foreground, '#f8fafc');
    assert.equal(calls[1][1].loadingScreen.accent, '#38bdf8');
    assert.equal(calls[1][1].campaigns, false);
    assert.deepEqual({ ...calls[1][1].loadingScreen }, {
        logoUrl: 'city-pack/example-logo.svg',
        logoAlt: 'Example Transit',
        background: '#102030',
        foreground: '#f8fafc',
        accent: '#38bdf8',
    });
});

test('default world profile selects the global terrain provider contract', async () => {
    const adapter = await commonJsApi('../web/station3d-planner.js');
    assert.equal(adapter.DEFAULT_WORLD_PROFILE.terrain.source, 'copernicus-glo30');
});

test('a walk link asks for planned buildings only with future=1', async () => {
    const links = await commonJsApi('../web/station3d-links.js');
    const link = links.parseSessionQuery('?st3d=walk&lat=45.8&lon=15.9&future=1');
    assert.equal(link.mode, 'walk');
    assert.equal(link.plannedBuildings, true);
    assert.equal(links.parseSessionQuery('?st3d=walk&lat=45.8&lon=15.9').plannedBuildings, false);
    assert.equal(links.parseSessionQuery('?st3d=walk&lat=45.8&lon=15.9&future=0').plannedBuildings, false);
    assert.equal(links.parseSessionQuery('?st3d=walk&lat=45.8&lon=15.9&future=true').plannedBuildings, false);
});

test('the walk deeplink hands the planned-buildings request to Station3D', async () => {
    const transit = await readFile(new URL('../web/transit.js', import.meta.url), 'utf8');
    const from = transit.indexOf('async function applyWalk3DLink');
    const to = transit.indexOf('function consensusApiBaseForWalkLink', from);
    assert.ok(from !== -1 && to !== -1, 'applyWalk3DLink is in transit.js');
    const body = transit.slice(from, to);
    assert.match(body, /plannedBuildings = false,\s*\} = options;/);
    assert.match(body, /station3D\.openWalk\(lat, lon, \{[^}]*\bplannedBuildings,\s*\}\);/);
    assert.match(
        transit,
        /applyWalk3DLink\(\{[^}]*plannedBuildings: station3DSessionLink\.plannedBuildings,\s*\}\)/,
    );
});

test('legacy explorer links hand off only when a deployment configures a host', async () => {
    const links = await commonJsApi('../web/station3d-links.js');
    const source = 'https://planner.example/?st3d=gta&lat=45.8&lon=15.9#view';
    assert.equal(links.legacyExplorerRedirect(source), null);
    assert.equal(
        links.legacyExplorerRedirect(source, { baseUrl: '/explore/' }),
        'https://planner.example/explore/?st3d=gta&lat=45.8&lon=15.9#view',
    );
    assert.equal(
        links.legacyExplorerRedirect('https://planner.example/?st3d=walk', { baseUrl: '/explore/' }),
        null,
    );
});
