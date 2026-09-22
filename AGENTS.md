# Instructions for coding agents

Read `README.md`, `docs/architecture.md`, `docs/city-manifest.md`,
`docs/terrain-providers.md` and `docs/extraction-status.md` before changing
boundaries or shared data formats.

## Mission

Build a city-agnostic transit network design and infrastructure scenario
planner. Keep the Zagreb compatibility pack working while removing assumptions
from core code one tested seam at a time.

## Ownership boundaries

- Station3D owns terrain/surface precedence, ground removal and backstops,
  roads, rails, curbs, collision, streaming, movement and generic rendering.
- This repository owns planner domain logic, product UI, project persistence
  contracts, provider orchestration and city-pack integration.
- City packs own local datasets, prices, labels, reference networks and provider
  selection. A city name must not select generic runtime behavior.
- Authored campaigns do not belong here. Campaign hosts may consume Station3D
  separately; the planner always configures `campaigns: false`.

Do not solve a missing provider by returning invented zeroes. Missing elevation,
population or jobs are unavailable capabilities and must be represented as such.

## Current migration reality

`web/transit.js` remains the extracted legacy composition root. Prefer moving
pure logic into small modules with Node tests when touching it. Do not rewrite
the application wholesale or break the Zagreb fixture while abstraction work is
in progress.

Station3D is pinned to the exact public tag declared in `package.json`. Consume
it through `vendor/station3d/` public entries only. Never import from a sibling
source path or edit its generated package contents under `node_modules/`.

## Commands

```sh
npm test
npm run build
npm run dev
```

Do not run browser test suites unless the user explicitly asks. For a visual
change, inspect it in a dedicated headed browser and close that browser after.

## Change discipline

- Add or update a city-manifest capability when making provider behavior optional.
- Keep project, pricing and metric revisions reproducible.
- Preserve `null` as terrain NoData; never coerce it to sea level or zero.
- Keep vertical datum and surface type in elevation provenance.
- Keep attribution visible and update data notices when adding a source.
- Do not commit generated `web/vendor/` or `web/city-config.generated.js`.
- Do not commit, push, publish or deploy unless explicitly requested.
