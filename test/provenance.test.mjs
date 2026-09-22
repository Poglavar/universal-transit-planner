import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const rootUrl = new URL('../', import.meta.url);

test('every checked-in Zagreb data extract has a provenance record', async () => {
    const notice = await readFile(new URL('THIRD_PARTY_NOTICES.md', rootUrl), 'utf8');
    const entries = await readdir(new URL('city-packs/zagreb/data/', rootUrl), { withFileTypes: true });
    for (const entry of entries.filter(value => value.isFile())) {
        assert.match(notice, new RegExp(`city-packs/zagreb/data/${entry.name.replaceAll('.', '\\.')}`));
    }
    assert.match(notice, /HŽPP publishes the feed[\s\S]*free reuse permission was confirmed directly with HŽPP/);
    assert.match(notice, /zagreb-logo\.svg[\s\S]*project-authored media[\s\S]*MIT licence/);
    assert.match(notice, /zagreb-prijevoz-logo\.svg[\s\S]*project-authored media[\s\S]*MIT licence/);
    assert.match(notice, /DGU approved that\s+deployment separately[\s\S]*every other use or deployment must obtain its own approval/);
    assert.match(notice, /terrain-provider interfaces and integration code are project-authored\s+MIT code/);
    assert.doesNotMatch(notice, /Not release-cleared: confirm permission or remove before public release/);
});

test('every checked-in documentation image has a provenance record', async () => {
    const provenance = await readFile(new URL('docs/images/README.md', rootUrl), 'utf8');
    const entries = await readdir(new URL('docs/images/', rootUrl), { withFileTypes: true });
    for (const entry of entries.filter(value => value.isFile() && /\.(?:gif|jpe?g|png|webp)$/i.test(value.name))) {
        assert.match(provenance, new RegExp(entry.name.replaceAll('.', '\\.')));
    }
});

test('the public object browser does not redistribute deployment-only datasets', async () => {
    const entries = await readdir(new URL('city-packs/zagreb/object-browser/', rootUrl), {
        withFileTypes: true,
    });
    assert.equal(entries.some(entry => entry.name === 'json'), false);
    const notice = await readFile(new URL('THIRD_PARTY_NOTICES.md', rootUrl), 'utf8');
    assert.match(notice, /object-browser[\s\S]*deployment-supplied[\s\S]*not\s+redistributed/);
});

test('package metadata and repository licence agree on MIT', async () => {
    const packageJson = JSON.parse(await readFile(new URL('package.json', rootUrl), 'utf8'));
    const license = await readFile(new URL('LICENSE', rootUrl), 'utf8');
    assert.equal(packageJson.license, 'MIT');
    assert.match(license, /^MIT License$/m);
});
