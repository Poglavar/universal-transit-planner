import { TerrainInputError } from './copernicus-dem.mjs';

const MAX_BODY_BYTES = 1_000_000;

function setCommonHeaders(response) {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Vary', 'Origin');
}

function sendJson(response, status, value, cacheControl = 'no-store') {
    const body = JSON.stringify(value);
    response.statusCode = status;
    response.setHeader('Cache-Control', cacheControl);
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Length', Buffer.byteLength(body));
    response.end(body);
}

async function readJson(request) {
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
        length += chunk.length;
        if (length > MAX_BODY_BYTES) throw new TerrainInputError('request body is too large');
        chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new TerrainInputError('request body must be valid JSON');
    }
}

function queryPoint(url) {
    return {
        lat: url.searchParams.get('lat'),
        lon: url.searchParams.get('lon'),
        source: url.searchParams.get('source') || undefined,
    };
}

export function createTerrainHttpHandler(provider, options = {}) {
    if (!provider) throw new TypeError('terrain provider is required');
    const prefix = String(options.prefix || '/api/terrain').replace(/\/+$/, '');

    return async function handleTerrainRequest(request, response, parsedUrl = null) {
        const url = parsedUrl || new URL(request.url || '/', 'http://localhost');
        if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
        setCommonHeaders(response);
        if (request.method === 'OPTIONS') {
            response.writeHead(204).end();
            return true;
        }

        const operation = url.pathname.slice(prefix.length).replace(/^\/+/, '');
        try {
            if (request.method === 'GET' && operation === 'metadata') {
                sendJson(
                    response,
                    200,
                    provider.metadata(url.searchParams.get('source') || undefined),
                    'public, max-age=86400',
                );
                return true;
            }
            if (request.method === 'GET' && operation === 'coverage') {
                sendJson(response, 200, await provider.coverage(queryPoint(url)), 'public, max-age=86400');
                return true;
            }
            if (request.method === 'GET' && (operation === 'point' || operation === 'elevation')) {
                sendJson(response, 200, await provider.point(queryPoint(url)), 'public, max-age=86400');
                return true;
            }
            if (request.method === 'POST' && operation === 'profile') {
                sendJson(response, 200, await provider.profile(await readJson(request)));
                return true;
            }
            if (request.method === 'POST' && operation === 'grid') {
                sendJson(response, 200, await provider.grid(await readJson(request)));
                return true;
            }
            sendJson(response, 404, { error: 'Unknown terrain operation' });
        } catch (error) {
            const status = Number(error?.statusCode) || 500;
            if (status >= 500) console.error('[terrain]', error?.stack || error);
            sendJson(response, status, {
                error: status >= 500 ? 'Terrain provider unavailable' : error.message,
            });
        }
        return true;
    };
}
