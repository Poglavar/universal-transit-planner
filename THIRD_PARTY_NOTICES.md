# Third-party notices and data provenance

The repository's MIT licence covers the project code, documentation and
project-authored documentation media. It does not replace the licences of
dependencies, provider data or city-pack datasets listed below.

## Browser and server dependencies

The build copies browser distributions from installed packages. Their package
versions are pinned in `package-lock.json` and retain their own licences.

| Package | Licence |
| --- | --- |
| Leaflet | BSD-2-Clause |
| Leaflet.heat | BSD-2-Clause |
| Turf | MIT |
| html2canvas | MIT |
| GeoTIFF.js | MIT |
| Station3D | MIT; packaged media retain the terms in Station3D's own `THIRD_PARTY_NOTICES.md` |

## Global providers

| Provider | Use | Terms and attribution |
| --- | --- | --- |
| OpenStreetMap | Default basemap and geographic source data | © OpenStreetMap contributors, [ODbL 1.0](https://www.openstreetmap.org/copyright). |
| Copernicus DEM GLO-30/GLO-90 | Default global surface-height provider | Copernicus WorldDEM free licence and the product notice linked from `config/cities/example.json`; see `docs/terrain-providers.md`. |

## Zagreb compatibility data

The following datasets are compatibility-pack inputs, not MIT-licensed project
code. The repository itself is the machine-readable offer for the checked-in
derived extracts.

| Files | Source | Terms | Release status |
| --- | --- | --- | --- |
| `city-packs/zagreb/data/zagreb_tram_tracks_osm.geojson` | OpenStreetMap tram ways | ODbL 1.0; © OpenStreetMap contributors | Cleared with attribution |
| `city-packs/zagreb/data/zagreb_rail_tracks.geojson` | OpenStreetMap rail ways | ODbL 1.0; © OpenStreetMap contributors | Cleared with attribution |
| `city-packs/zagreb/data/zagreb_tram_segments_osm.json` | Derived from OSM track geometry and ZET stop/schedule inputs | ODbL 1.0 plus the ZET Open Licence notice below | Cleared with attribution |
| `city-packs/zagreb/data/zagreb_tram_switch_rules.json` | Project-authored routing decisions keyed to OSM track geometry | Distributed as part of the ODbL-derived Zagreb track database | Cleared with attribution |
| `city-packs/zagreb/data/zagreb_tram_stops.json` | ZET GTFS static feed | [Open Licence – The Republic of Croatia](https://data.gov.hr/otvorena-dozvola); source notice at [ZET](https://www.zet.hr/preuzimanja/odredbe/datoteke-u-gtfs-formatu/669) | Cleared with attribution |
| `city-packs/zagreb/data/zagreb_tram_tracks_gtfs.geojson` | ZET GTFS shapes | Open Licence – The Republic of Croatia | Cleared with attribution |
| `city-packs/zagreb/data/zagreb_tram_segments_gtfs.json` | Derived from ZET GTFS shapes, stops and schedules | Open Licence – The Republic of Croatia | Cleared with attribution |
| `city-packs/zagreb/data/zagreb_rail_schedule.json` | HŽPP GTFS timetable | [HŽPP publishes the feed](https://hzpp.hr/hr/vozni-red); free reuse permission was confirmed directly with HŽPP and the correspondence is retained privately by the project maintainer | Cleared by direct permission |

Zagreb's DGU terrain data is accessed only by the maintainer's existing
deployment and is not redistributed by this repository. DGU approved that
deployment separately. The approval does not make the terrain data reusable:
every other use or deployment must obtain its own approval from DGU. The
planner, terrain-provider interfaces and integration code are project-authored
MIT code and may be reused independently of the DGU data.

`city-packs/zagreb/zagreb-logo.svg` is project-authored media created by the
project maintainer and released under the repository's MIT licence. It is a
legacy compatibility logo and is not referenced by the current runtime.

## Documentation media

The screenshots and Šibenik animation under `docs/images/` were captured by
the project maintainer from the planner and Station3D. They are project-authored
documentation media under MIT. Visible or rendered OpenStreetMap-derived
content retains the attribution above. Capture details and reproducible links
are in `docs/images/README.md`.
