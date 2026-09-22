# City manifest

`config/cities/<id>.json` selects the deployment’s city and provider stack.
`TRANSIT_CITY=<id> npm run build` validates the manifest and capability/provider
relationships, then emits a single-city `dist/` build and its generated runtime
configuration. With no `TRANSIT_CITY`, the portable `example` manifest is used.

Its stable core is:

- `id`, `name`, `center`, `bounds`;
- `locale`, `timezone`, `currency`, `units`;
- `providers` and `features`;
- visible `attributions`, each with a `name` and optional source/licence links;
- `dataRevision`;
- optional Station3D world profile and static compatibility datasets.

A feature flag describes honest availability, not UI preference. If `jobs` is
false, the interface must hide or mark job metrics unavailable. A provider must
not return zero to make a feature appear supported.

Every manifest declares all capability flags: `routing`, `terrain`,
`terrainTiles`, `population`, `jobs`, `referenceTransit`, `referenceRail`,
`station3d`, `persistence` and `campaigns`. The last is always `false`.
`terrainTiles` describes the optional rendered Leaflet overlay and may remain
false while point/profile/grid terrain is fully available. Enabling a
capability without its provider, static dataset or world profile fails the
build.

`config/cities/example.json` is the minimal portable fixture. It enables the
implemented Copernicus GLO-30 provider through `/api`, with GLO-90 fallback.
Its `providerOperations.terrain` declaration makes the required five
operations explicit and leaves optional rendered tiles disabled.
`terrainReference` declares the canonical horizontal/vertical reference,
surface type, unit and revision used to invalidate saved derived profiles.

## Provider families

| Provider | Core operation |
| --- | --- |
| routing | walking/transit isochrone for an origin and duration |
| terrain | metadata, coverage, point, profile, grid and optional tiles |
| population | aggregate a versioned population surface inside a polygon |
| jobs/activity | optional aggregate; never inferred from population |
| reference transit | GTFS stops, routes and shapes; optional realtime |
| world | roads, buildings, water and decoration for Station3D |
| persistence | save, load, list and compare versioned projects |

The Zagreb manifest is the compatibility reference, not the universal default.
See [provider-contracts.md](provider-contracts.md) for operation and result
requirements.

## Optional city pack

`cityPack.prePlanner` and `cityPack.simulation` list safe relative JavaScript
paths inside `city-packs/<city-id>/`. The build copies only the selected pack to
`dist/city-pack/`. Pre-planner scripts may install a richer prepared-area
registry before the generic manifest registry runs; simulation scripts load
after the planner composition root. Core HTML must never name a pack script or
dataset directly.

Local static-data URLs in the manifest point at `city-pack/data/...`. Network
defaults such as electrification, API compatibility field names and provider
labels are manifest data rather than branches on `city.id`.
