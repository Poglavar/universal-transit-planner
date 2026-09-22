import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../web/city-capabilities.js', import.meta.url), 'utf8');
const module = { exports: {} };
vm.runInContext(source, vm.createContext({ module, globalThis: {} }));
const capabilities = module.exports;

test('capabilities resolve only explicit true declarations', () => {
    const resolved = capabilities.resolve({ features: { terrain: true, routing: false } });
    assert.equal(resolved.terrain, true);
    assert.equal(resolved.routing, false);
    assert.equal(resolved.terrainTiles, false);
    assert.equal(resolved.persistence, false);
    assert.equal(resolved.campaigns, false);
});

test('comma-separated requirements require every capability', () => {
    const resolved = capabilities.resolve({ features: { population: true, jobs: false } });
    assert.equal(capabilities.supports(resolved, 'population'), true);
    assert.equal(capabilities.supports(resolved, 'population,jobs'), false);
});

test('campaigns stay unavailable even if hostile runtime input enables them', () => {
    assert.equal(capabilities.resolve({ features: { campaigns: true } }).campaigns, false);
});
