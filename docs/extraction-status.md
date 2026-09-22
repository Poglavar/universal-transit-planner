# Extraction status

## Completed in the initial extraction

- Created a standalone repository layout and deterministic local build.
- Kept `zagreb.lol/prijevoz` untouched as the production owner.
- Consumed Station3D only through its packaged public entries.
- Disabled campaign availability at the planner host boundary.
- Removed campaign routes and campaign assets from the extracted repository.
- Added a build-selected city manifest and neutral runtime API names.
- Made initial map centre, zoom, basemap, API URLs and Station3D world profile
  manifest-driven.
- Added human and agent architecture documentation plus headless contract tests.

## Completed in the generalization pass

- Added strict manifest validation for identity, geography and capabilities.
- Added a non-Croatian example city that exercises the portable
  build path.
- Made capability-gated controls disappear when the selected city lacks their
  backing provider.
- Removed deployment-specific branding and URLs from the reusable HTML shell.
- Defined initial routing, terrain, demand, reference-data, persistence and 3D
  provider contracts.

## Completed in the portable-baseline pass

- Made the portable example the default build and development target.
- Changed builds to generate a clean `dist/` containing only the selected city
  pack instead of serving the mixed source tree.
- Moved the Croatian prepared-area registry, Zagreb simulators and their static
  datasets into `city-packs/zagreb/`.
- Replaced city-ID decisions for location fallback, reference simulation and
  electrification with manifest declarations.
- Made terrain labels, API compatibility fields, time zone and export identity
  configuration-driven.
- Added English/Croatian UI selection and a contract test that rejects Zagreb
  assets and runtime fallbacks in the portable core.

## Completed in the global-terrain pass

- Added a server-side Copernicus DEM GLO-30 COG reader with GLO-90 fallback.
- Implemented metadata, coverage, point, route-profile and grid operations with
  per-sample provenance and explicit `null` NoData.
- Persisted normalized terrain provenance and folded provider revision into
  vertical-profile freshness checks.
- Enabled preliminary terrain profiles in the portable example while keeping
  optional rendered terrain tiles disabled and hidden.
- Added a standalone terrain API entry point and mounted the same handler in
  the local development server.
- Documented EGM2008, DSM quality, AWS 2021 revision and Copernicus attribution.

## Completed in the public-alpha preparation pass

- Added the MIT licence, community files and checked-in data/media provenance.
- Confirmed HŽPP GTFS reuse permission and the project-authored Zagreb logo.
- Recorded that DGU separately approved the maintainer's deployed use of its
  terrain data; the data is not redistributed or offered as reusable, while
  all project-authored provider code remains MIT licensed.
- Pinned Station3D to public tag `v0.1.0-alpha.1`, which builds its distribution
  during a Git install and no longer requires a sibling checkout.
- Verified `npm ci`, tests, the portable build and the documented demo command
  from a fresh clone.

## Remaining Zagreb couplings

1. `web/transit.js` is still a large composition root with compatibility UI strings.
2. pricing, gauges, vehicle parameters and fare assumptions remain product data.
3. reference rail and leaderboard endpoints still implement legacy API semantics.
4. population/jobs depend on the existing Zagreb building database.
5. the backend, database migrations and workers are not yet extracted.
6. the project schema and cost engine are not yet shared between browser/API.
7. generic OSM/Valhalla bootstrap does not yet exist.

## Next iterations

1. Extract a shared project schema, migrations and pricing package.
2. Extract the minimal API, including city-scoped storage.
3. Implement generic OSM/Valhalla city bootstrap.
4. Add GTFS and GHSL adapters plus a fully working demonstration city.
5. Replace the remaining compatibility string translator with message keys and
   add a fully working non-Croatian demonstration city.
