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
        const [html, deployment] = await Promise.all([
            readFile(join(output, 'transit.html'), 'utf8'),
            readFile(join(output, 'deployment-config.generated.js'), 'utf8'),
        ]);
        assert.match(html, /<base href="\/prijevoz\/utp\/">/);
        assert.match(html, /<title>Zagreb transit planner<\/title>/);
        assert.match(html, /rel="canonical" href="https:\/\/zagreb\.lol\/prijevoz\/"/);
        assert.match(html, /property="og:url" content="https:\/\/zagreb\.lol\/prijevoz\/"/);
        assert.match(deployment, /"apiBaseUrl": "\/prijevoz\/api"/);
        assert.match(deployment, /"externalExplorerBaseUrl": "\/sloboda\/"/);
        await Promise.all([
            access(join(output, 'objekti.html')),
            access(join(output, 'objekti.js')),
            access(join(output, 'objekti.css')),
        ]);
        await assert.rejects(access(join(output, 'json/rail-tunnels-osm.json')));
    } finally {
        await rm(output, { recursive: true, force: true });
    }
});
