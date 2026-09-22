import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const rootUrl = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, rootUrl), 'utf8');

test('the portable example is the default build and the dev server serves dist', async () => {
    const [build, serve] = await Promise.all([
        read('scripts/build.mjs'),
        read('scripts/serve.mjs'),
    ]);
    assert.match(build, /process\.env\.TRANSIT_CITY \|\| 'example'/);
    assert.match(build, /city-packs/);
    assert.match(build, /resolve\(root, 'dist'\)/);
    assert.match(serve, /new URL\('\.\.\/dist\//);
});

test('the generic web source has no Zagreb assets or Zagreb runtime fallbacks', async () => {
    const entries = await readdir(new URL('../web/', import.meta.url), { withFileTypes: true });
    assert.deepEqual(entries.filter(entry => /zagreb|croatia/i.test(entry.name)).map(entry => entry.name), []);

    const [html, transit, worldMode, electrification, locationContext] = await Promise.all([
        read('web/transit.html'),
        read('web/transit.js'),
        read('web/world-mode.js'),
        read('web/track-electrification.js'),
        read('web/planner-location-context.js'),
    ]);
    const runtime = [html, transit, worldMode, electrification, locationContext].join('\n');
    assert.doesNotMatch(runtime, /zagreb_(?:tram|rail)|zagreb-transit|dgu-dtm-20m/);
    assert.doesNotMatch(runtime, /(?:===|fallback:)\s*['"]zagreb['"]/);
    assert.doesNotMatch(html, /croatia-boundary|tram-sim\.js|railway-sim\.js/);
    assert.match(html, /__transitCityPack\.load\('prePlanner'\)/);
    assert.match(html, /__transitCityPack\.load\('simulation'\)/);
});

test('city-pack loader exposes only validated scripts from the requested phase', async () => {
    const source = await read('web/city-pack-loader.js');
    const module = { exports: {} };
    vm.runInContext(source, vm.createContext({ module, globalThis: {} }));
    const loader = module.exports;
    const city = {
        cityPack: {
            prePlanner: ['city-pack/registry.js', '../escape.js', 'https://bad.test/a.js'],
            simulation: ['city-pack/sim/tram.js'],
        },
    };
    assert.deepEqual(
        Array.from(loader.scriptsForPhase(city, 'prePlanner')),
        ['city-pack/registry.js'],
    );
    assert.deepEqual(
        Array.from(loader.scriptsForPhase(city, 'simulation')),
        ['city-pack/sim/tram.js'],
    );
    assert.deepEqual(Array.from(loader.scriptsForPhase(city, 'unknown')), []);
});

test('reference simulation policy is declared by the selected city pack', async () => {
    const source = await read('web/world-mode.js');
    const module = { exports: {} };
    vm.runInContext(source, vm.createContext({ module, globalThis: {}, URLSearchParams }));
    const worldMode = module.exports;
    const registry = { detectByLatLng: () => 'local-area' };
    const city = { id: 'demo', referenceSimulation: { locationIds: ['demo'] } };
    assert.equal(worldMode.shouldAutoLoadReferenceSimulation('', registry, city), true);
    assert.equal(worldMode.shouldAutoLoadReferenceSimulation('?lat=1&lon=2', registry, city), false);
    assert.equal(worldMode.shouldAutoLoadReferenceSimulation('', registry, { id: 'demo' }), false);
});

test('electrification defaults come from configuration rather than a city name', async () => {
    const source = await read('web/track-electrification.js');
    const module = { exports: {} };
    vm.runInContext(source, vm.createContext({ module, globalThis: {} }));
    const electrification = module.exports;
    const resolved = electrification.resolve({}, {
        trackMode: 'tram',
        networkDefault: { electrified: 'contact_line', voltage: 750, frequency: 0 },
    });
    assert.equal(resolved.status, 'overhead');
    assert.equal(resolved.voltageV, 750);
    assert.equal(resolved.frequencyHz, 0);
    assert.equal(resolved.provenance, 'network-default');
});
