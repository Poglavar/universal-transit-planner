import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const webUrl = new URL('../web/', import.meta.url);
const readWeb = path => readFile(new URL(path, webUrl), 'utf8');

test('the map host consumes Station3D public package entries only', async () => {
    const [html, transit] = await Promise.all([readWeb('transit.html'), readWeb('transit.js')]);
    assert.match(html, /vendor\/station3d\/loader\.js/);
    assert.match(html, /vendor\/station3d\/planning\.js/);
    assert.match(transit, /vendor\/station3d\/planning\.js/);
    assert.match(transit, /vendor\/station3d\/debug\.js/);
    assert.doesNotMatch(`${html}\n${transit}`, /import\(['"]\.\/station-3d\//);
    assert.doesNotMatch(html, /station3d-redirect\.js|station3d-prijevoz\.js/);
});

test('the extracted web tree contains no copied Station3D engine or authored campaign assets', async () => {
    const entries = await readdir(webUrl, { withFileTypes: true });
    assert.equal(entries.some(entry => entry.name === 'station-3d'), false);
    assert.equal(entries.some(entry => entry.name === 'sloboda'), false);
    assert.equal(entries.some(entry => entry.name === 'campaigns'), false);
    const links = await readWeb('station3d-links.js');
    assert.doesNotMatch(links, /campaignId|checkpointId|campaign-menu/);
});

test('every checked-in local script and stylesheet referenced by the planner shell exists', async () => {
    const html = await readWeb('transit.html');
    const refs = [...html.matchAll(/(?:src|href)="([^"?#]+)(?:\?[^"#]*)?"/g)]
        .map(match => match[1])
        .filter(path => !/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(path))
        .filter(path => !path.startsWith('vendor/'))
        .filter(path => path !== 'city-config.generated.js');
    for (const path of refs) {
        assert.equal((await stat(new URL(path, webUrl))).isFile(), true, path);
    }
});

test('the reusable planner metadata and header have no deployment-specific public identity', async () => {
    const [html, social] = await Promise.all([
        readWeb('transit.html'),
        readWeb('transit-social-preview.svg'),
    ]);
    assert.doesNotMatch(html, /og:url|rel="canonical"|zagreb-logo\.svg/);
    assert.doesNotMatch(social, /zagreb\.lol|\/prijevoz|zagreb-logo\.svg/);
    assert.match(html, /city-capabilities\.js/);
    assert.match(html, /city-branding\.js/);
});
