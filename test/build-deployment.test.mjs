import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);

test('Zagreb deployment build emits branded metadata and isolated asset base', async () => {
    const output = await mkdtemp(join(tmpdir(), 'utp-build-'));
    try {
        await run(process.execPath, ['scripts/build.mjs'], {
            cwd: new URL('..', import.meta.url),
            env: {
                ...process.env,
                TRANSIT_CITY: 'zagreb',
                TRANSIT_DIST_DIR: output,
                TRANSIT_ASSET_BASE_PATH: '/prijevoz/utp/',
                TRANSIT_PUBLIC_URL: 'https://zagreb.lol/prijevoz/',
                TRANSIT_API_BASE_URL: '/prijevoz/api',
                TRANSIT_EXTERNAL_EXPLORER_URL: '/sloboda/',
            },
        });
        const [html, deployment, cityConfig] = await Promise.all([
            readFile(join(output, 'transit.html'), 'utf8'),
            readFile(join(output, 'deployment-config.generated.js'), 'utf8'),
            readFile(join(output, 'city-config.generated.js'), 'utf8'),
        ]);
        assert.match(html, /<base href="\/prijevoz\/utp\/">/);
        assert.match(html, /<title>Planer javnog prijevoza za Zagreb \| zagreb\.lol<\/title>/);
        assert.match(html, /rel="canonical" href="https:\/\/zagreb\.lol\/prijevoz\/"/);
        assert.match(html, /property="og:url" content="https:\/\/zagreb\.lol\/prijevoz\/"/);
        assert.match(html, /<html lang="hr">/);
        assert.equal([...html.matchAll(/<h1[\s>]/g)].length, 1);
        const head = html.split('</head>')[0];
        const meta = key => head.match(new RegExp(`<meta[^>]*(?:name|property)="${key}"[^>]*content="([^"]*)"`))?.[1];
        const description = meta('description');
        assert.ok(description.length >= 70 && description.length <= 160, `description length ${description.length}`);
        assert.equal(meta('og:description'), description);
        assert.match(meta('robots'), /^index, follow/);
        assert.equal(meta('og:locale'), 'hr_HR');
        assert.equal(meta('og:image'), 'https://zagreb.lol/prijevoz/og-image.png?v=20261017-1');
        assert.equal(meta('twitter:image'), meta('og:image'));
        assert.equal(meta('og:image:type'), 'image/png');
        assert.equal(meta('og:image:width'), '1200');
        assert.equal(meta('og:image:height'), '630');
        assert.equal(meta('twitter:image:alt'), meta('og:image:alt'));
        assert.equal(meta('theme-color'), '#007bff');
        const ld = JSON.parse(head.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
        assert.equal(ld.url, 'https://zagreb.lol/prijevoz/');
        assert.equal(ld.description, description);
        assert.equal(ld.name, 'Planer javnog prijevoza za Zagreb');
        assert.deepEqual(ld.breadcrumb.itemListElement.map(item => item.item), ['https://zagreb.lol/', 'https://zagreb.lol/prijevoz/']);
        assert.match(deployment, /"apiBaseUrl": "\/prijevoz\/api"/);
        assert.match(deployment, /"externalExplorerBaseUrl": "\/sloboda\/"/);
        assert.match(cityConfig, /"logoUrl": "city-pack\/zagreb-prijevoz-logo\.svg"/);
        await Promise.all([
            access(join(output, 'objekti.html')),
            access(join(output, 'objekti.js')),
            access(join(output, 'objekti.css')),
            access(join(output, 'city-pack/zagreb-prijevoz-logo.svg')),
        ]);
        await assert.rejects(access(join(output, 'json/rail-tunnels-osm.json')));
    } finally {
        await rm(output, { recursive: true, force: true });
    }
});
