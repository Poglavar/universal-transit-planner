import { createServer } from 'node:http';
import { createCopernicusDemProvider } from '../server/terrain/copernicus-dem.mjs';
import { createTerrainHttpHandler } from '../server/terrain/http.mjs';

const port = Number(process.env.PORT || process.argv[2] || 3001);
const provider = createCopernicusDemProvider({
    baseUrls: {
        'copernicus-glo30': process.env.COPERNICUS_DEM_30M_BASE_URL,
        'copernicus-glo90': process.env.COPERNICUS_DEM_90M_BASE_URL,
    },
});
const handleTerrain = createTerrainHttpHandler(provider);

const server = createServer(async (request, response) => {
    try {
        const url = new URL(request.url || '/', 'http://localhost');
        if (await handleTerrain(request, response, url)) return;
        response.writeHead(404).end('Not found');
    } catch (error) {
        console.error('[terrain-server]', error?.stack || error);
        if (!response.headersSent) response.writeHead(500);
        response.end('Internal server error');
    }
});

server.listen(port, '127.0.0.1', () => {
    console.log(`Copernicus terrain API: http://127.0.0.1:${server.address().port}/api/terrain`);
});
