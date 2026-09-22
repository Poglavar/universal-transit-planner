# Provider contracts

Providers turn a city manifest into capabilities. A provider may run in the
browser, behind an HTTP API, or as a preprocessing pipeline, but the planner
must observe the same operation and provenance contract.

## Capability rules

- `features.<name>` is `true` only when the deployment can complete that
  operation with the selected provider and dataset.
- Missing coverage returns an explicit unavailable/NoData result. It is never
  represented as zero population, zero jobs, or zero elevation.
- Every derived value carries provider identity and data revision so cached
  results can be invalidated safely.
- Provider-specific behavior stops at the adapter. The planner domain and
  Station3D engine must not branch on city IDs.
- `campaigns` is permanently `false`; authored campaigns are outside this
  product.

## Provider families

| Capability | Required operations | Result essentials |
| --- | --- | --- |
| `routing` | isochrone(origin, duration, mode) | polygon, duration, mode, provider revision |
| `terrain` | metadata, coverage, point, profile, grid | elevation or NoData, CRS, vertical reference, resolution, surface type, provenance |
| `population` | aggregate(polygon, revision) | count or NoData, source year/revision, coverage |
| `jobs` | aggregate(polygon, revision) | count or NoData, source year/revision, coverage |
| `referenceTransit` | stops, routes, shapes; optional realtime | stable source IDs, geometry, service/data revision |
| `referenceRail` | tracks, stations and optional authored projects | stable source IDs, geometry, data revision |
| `persistence` | save, load, list, compare | city ID, project schema version, immutable project ID/revision |
| `station3d` | world profile plus resolved network handoff | world/source revisions and the same terrain provenance used by the planner |

## Terrain stack

Terrain is a provider stack, not a hard-coded endpoint. The implemented global
default is Copernicus DEM GLO-30 with GLO-90 fallback; a local bare-earth DTM or
LiDAR source can override it where coverage and datum transformation are known.
The resolved surface must be shared by profiles, map relief and Station3D.

The bundled HTTP shape is:

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/api/terrain/metadata?source=…` | stack metadata and supported operations |
| `GET` | `/api/terrain/coverage?lat=…&lon=…&source=…` | availability and selected source |
| `GET` | `/api/terrain/point?lat=…&lon=…&source=…` | elevation or `null` plus provenance |
| `POST` | `/api/terrain/profile` | `{coordinates, stepM, source}` → chainage samples |
| `POST` | `/api/terrain/grid` | `{bbox, width, height, source}` → row-major values |

`/elevation` is retained as an alias for `/point` because the extracted map
host already uses that URL. Rendered terrain tiles remain optional.
The planner stores the resolved source/revision/datum summary beside each
derived vertical profile and includes the configured terrain revision in its
freshness hash.

See [terrain-providers.md](terrain-providers.md) for the detailed metadata and
vertical-reference requirements.

## Adapter boundary

City manifests select adapters by stable IDs. Credentials, hostnames and
deployment overrides belong in runtime configuration; dataset identity,
coverage and attribution belong in the manifest/provider metadata. A provider
adapter should expose plain data to a pure domain module, leaving DOM, Leaflet
and Three.js concerns in their hosts.
