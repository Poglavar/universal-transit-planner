import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function attributionApi() {
    const source = await readFile(new URL('../web/provider-attribution.js', import.meta.url), 'utf8');
    const module = { exports: {} };
    vm.runInContext(source, vm.createContext({ module, URL, globalThis: {} }));
    return module.exports;
}

test('provider attribution renders source and licence links safely', async () => {
    const api = await attributionApi();
    const rendered = api.format({
        name: 'Example <data>',
        url: 'https://example.test/source',
        license: 'Open & reusable',
        licenseUrl: 'https://example.test/license',
    });
    assert.match(rendered, /Example &lt;data&gt;/);
    assert.match(rendered, /Open &amp; reusable/);
    assert.match(rendered, /https:\/\/example\.test\/source/);
    assert.match(rendered, /https:\/\/example\.test\/license/);
    assert.doesNotMatch(rendered, /<data>/);
});

test('provider attribution rejects unsafe links and empty records', async () => {
    const api = await attributionApi();
    assert.equal(api.format({ name: '' }), null);
    assert.equal(api.format({ name: 'Provider', url: 'javascript:alert(1)' }), 'Provider');
    assert.deepEqual(
        Array.from(api.formatAll([{ name: 'Provider' }, { name: 'Provider' }, null])),
        ['Provider'],
    );
});

test('provider attribution produces a labelled list for the help dialog', async () => {
    const api = await attributionApi();
    const rendered = api.section([{ name: 'Provider' }], 'Sources & licences');
    assert.match(rendered, /data-provider-attributions/);
    assert.match(rendered, /Sources &amp; licences/);
    assert.match(rendered, /<li>Provider<\/li>/);
});
