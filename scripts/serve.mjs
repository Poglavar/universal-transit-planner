import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCopernicusDemProvider } from '../server/terrain/copernicus-dem.mjs';
import { createTerrainHttpHandler } from '../server/terrain/http.mjs';

const web = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const port = Number(process.env.PORT || process.argv[2] || 8091);
const types = new Map([
    ['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
    ['.svg', 'image/svg+xml'], ['.wasm', 'application/wasm'],
    ['.geojson', 'application/geo+json; charset=utf-8'],
]);
const terrainProvider = createCopernicusDemProvider({
    baseUrls: {
        'copernicus-glo30': process.env.COPERNICUS_DEM_30M_BASE_URL,
        'copernicus-glo90': process.env.COPERNICUS_DEM_90M_BASE_URL,
    },
});
const handleTerrain = createTerrainHttpHandler(terrainProvider);

const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (await handleTerrain(request, response, url)) return;
    const relative = decodeURIComponent(url.pathname === '/' ? '/transit.html' : url.pathname).replace(/^\/+/, '');
    const path = resolve(web, relative);
    if (path !== web && !path.startsWith(`${web}${sep}`)) {
        response.writeHead(400).end('Invalid path');
        return;
    }
    try {
        if (!statSync(path).isFile()) throw new Error('not a file');
    } catch {
        response.writeHead(404).end('Not found');
        return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', types.get(extname(path)) || 'application/octet-stream');
    createReadStream(path).pipe(response);
});
server.listen(port, '127.0.0.1', () => {
    console.log(`Universal Transit Planner: http://127.0.0.1:${server.address().port}`);
});
