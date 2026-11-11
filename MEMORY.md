# Project memory

- The portable default uses the server-side Copernicus GLO-30 COG adapter with GLO-90 fallback because the public AWS buckets do not expose browser CORS.
- Planned buildings in a `future=1` walk (2026-11-11) come from the city's world profile (`station3d.worldProfile.plannedBuildings`, an endpoint below the planner API) and are fetched by Station3D itself, so the planner only passes the request on and holds no building data.
