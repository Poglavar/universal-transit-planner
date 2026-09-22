import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createTerrainHttpHandler } from '../server/terrain/http.mjs';

function request(method, url, body = null) {
    const stream = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))]);
    stream.method = method;
    stream.url = url;
    return stream;
}

function response() {
    return {
        headers: new Map(),
        statusCode: null,
        body: '',
        setHeader(name, value) {
            this.headers.set(String(name).toLowerCase(), value);
        },
        writeHead(status) {
            this.statusCode = status;
            return this;
        },
        end(body = '') {
            this.body += body;
        },
    };
}

test('terrain HTTP handler exposes the legacy elevation alias and JSON profile contract', async () => {
    const provider = {
        metadata: source => ({ id: source || 'default' }),
        coverage: async input => ({ available: input.lat === '1' }),
        point: async input => ({ elevationM: Number(input.lat) + Number(input.lon) }),
        profile: async input => ({ points: input.coordinates }),
        grid: async input => ({ values: new Array(input.width * input.height).fill(null) }),
    };
    const handler = createTerrainHttpHandler(provider);

    const elevationResponse = response();
    assert.equal(await handler(
        request('GET', '/api/terrain/elevation?lat=1&lon=2'),
        elevationResponse,
    ), true);
    assert.equal(elevationResponse.statusCode, 200);
    assert.deepEqual(JSON.parse(elevationResponse.body), { elevationM: 3 });
    assert.equal(elevationResponse.headers.get('access-control-allow-origin'), '*');

    const profileResponse = response();
    await handler(
        request('POST', '/api/terrain/profile', { coordinates: [[1, 2], [3, 4]] }),
        profileResponse,
    );
    assert.equal(profileResponse.statusCode, 200);
    assert.deepEqual(JSON.parse(profileResponse.body), { points: [[1, 2], [3, 4]] });
});

test('terrain HTTP handler leaves unrelated routes to the host server', async () => {
    const handler = createTerrainHttpHandler({});
    assert.equal(await handler(request('GET', '/transit.html'), response()), false);
});
