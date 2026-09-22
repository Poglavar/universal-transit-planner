import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function commonJsApi(path) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    const module = { exports: {} };
    const context = vm.createContext({ module, URL, Promise, console });
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
            station3d: { worldProfile: { id: 'example-world', buildings: 'overture' } },
        },
    });
    assert.equal(calls[0][1].id, 'transit-planner-example');
    assert.equal(calls[0][1].worldProfile.id, 'example-world');
    assert.equal(calls[1][1].name, 'Example City Transit Planner');
    assert.equal(calls[1][1].campaigns, false);
});

test('default world profile selects the global terrain provider contract', async () => {
    const adapter = await commonJsApi('../web/station3d-planner.js');
    assert.equal(adapter.DEFAULT_WORLD_PROFILE.terrain.source, 'copernicus-glo30');
});
