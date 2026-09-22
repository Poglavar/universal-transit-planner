# Architecture

## Runtime layers

1. **City manifest** — identity, locale, bounds, providers, capabilities,
   attribution and data revision.
   Optional city-pack scripts and static datasets are copied only for the
   selected manifest; the generic source does not load them directly.
2. **Planner domain** — projects, topology, pricing, vertical alignment and
   metrics. This layer is being extracted from `web/transit.js`.
3. **Provider adapters** — routing, terrain, demand, reference transit,
   buildings, roads, water and persistence.
4. **Map host** — Leaflet editing and product UI.
5. **Station3D host adapter** — sends the selected world and host configuration
   into the independently versioned engine.

UI language is a reader preference independent of the city manifest's data
locale. Detection, persistence and URL propagation are described in
[internationalization.md](internationalization.md).

The manifest validator prevents capabilities from being enabled without a
corresponding provider or dataset. Terrain additionally declares its required
operation matrix, and the optional `terrainTiles` capability is independent of
point/profile/grid availability. The browser resolves the same capability set
and removes unavailable controls before feature modules initialize. Provider
operation/result contracts are documented in
[provider-contracts.md](provider-contracts.md).

`npm run build` produces `dist/` for the portable example. A named build such
as `npm run build:zagreb` starts from the same generic `web/` source, copies the
selected pack to `dist/city-pack/`, and rewrites only its declared phase paths.
The development server serves `dist/`, never the mixed source tree.

The map and immersive world are two views of the same proposed network. Terrain
is therefore not a visual extra: the profile solver, map relief, Station3D
ground, formations and collision must consume the same resolved surface and
provenance.

## Repository boundary

Station3D remains an external dependency. This repository calls its public
`planning.js`, `debug.js` and browser facade entries. It must not reach into
`station3d/website/station-3d/core` or carry a copied engine tree.


The application currently talks to a compatible HTTP API. The API extraction
will introduce neutral endpoints and shared project/schema packages before the
Zagreb deployment switches consumers.

The first standalone provider slice lives in `server/terrain/`: a reusable
Copernicus COG reader and HTTP handler. The development server mounts it under
`/api/terrain`; `npm run terrain:serve` runs the same handler independently.
Remote raster access stays server-side because the public AWS Open Data buckets
support byte ranges but do not enable browser CORS.

## Migration strategy

Use a strangler extraction:

1. lock current Zagreb behavior with fixtures;
2. extract pure planner modules;
3. replace a hard-coded source with a manifest capability/provider;
4. prove the same module with Zagreb and one non-Croatian fixture;
5. remove the legacy path.

No compatibility branch should silently calculate different costs or metrics.
