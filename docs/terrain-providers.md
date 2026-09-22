# Terrain providers

Terrain providers must report product/version, horizontal CRS, vertical
reference, surface type (`terrain` or `surface`), native resolution, licence,
attribution and intended quality.

Required operations are coverage, point elevation, route profile and grid.
Tiles are optional. Samples are either a finite elevation with provenance or
`null`; NoData is never zero.

## Default global stack

The bundled default is Copernicus DEM GLO-30 with per-sample GLO-90 fallback.
It reads the public 2021 AWS Open Data Cloud Optimized GeoTIFFs server-side and
exposes normalized JSON through the terrain HTTP contract. It is a
roughly 30 m digital **surface** model, not a bare-earth engineering DTM. The UI
must label grades derived from it as preliminary. Local DTM/LiDAR providers,
such as Zagreb’s DGU data, override it through the same interface.

The interface and provider code are MIT-licensed software; that does not grant
rights to any terrain dataset connected to them. Zagreb's DGU data is not part
of this repository or a reusable provider pack. DGU separately approved the
maintainer's deployment, and every other use requires its own DGU approval.

The source grid uses WGS84-G1150 (`EPSG:4326`) horizontally and orthometric
EGM2008 (`EPSG:3855`) heights in metres. The adapter samples the
RasterPixelIsPoint grid bilinearly. A missing GLO-30 tile or cell is retried
against GLO-90; missing coverage after both sources remains `null`, not an
assumed zero.

The public buckets support unsigned HTTP range requests but do not enable CORS,
so the reusable COG reader belongs in `server/terrain/`, not in browser code.
`npm run dev` mounts it in the normal development server, while
`npm run terrain:serve` runs only the API.

## Copernicus notice

When the provider is enabled, the planner displays the required source notice:

> © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.

The organisations in charge of the Copernicus programme by law or by
delegation do not incur any liability for any use of the Copernicus
WorldDEM-30 or WorldDEM-90. The API metadata returns the corresponding exact
notice for each product. See the Copernicus GLO-30/GLO-90 licence linked from
the city manifest.

Before combining sources with a local datum, transform every sample into the
city manifest’s canonical vertical reference. Cache identities include provider stack,
product/data revision, requested resolution, vertical operation and water-mask
revision.

The one resolved result feeds map relief, route profiles, Station3D ground,
roads, rails, buildings, support and collision. Provider-specific world rules
are forbidden.
