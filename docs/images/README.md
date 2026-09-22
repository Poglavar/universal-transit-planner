# Media provenance

`sibenik-cab.gif` is a 640 × 338, six-frame-per-second derivative of the
26-second `media/sibenik-cab.mp4` loop used by
[Šibenik 2066](https://zagreb.lol/sibenik-2066/). The source is a canvas-only
recording from Universal Transit Planner project 141, captured in Station3D
without browser chrome or user-entered text. It is used as the README's lead
visual.

The screenshots in this directory were captured from the live Zagreb planner on
21 September 2026 at a 1600 × 1000 viewport. They document the Zagreb
compatibility pack; they are examples of the universal planner's map, vertical
alignment and Station3D workflows rather than hard-coded universal defaults.

OpenStreetMap contributors provide the map and much of the visible world data.
The rendered views retain the in-product attribution and controls where they are
visible.

## Reproduction

| Image | Saved project and view |
| --- | --- |
| `sibenik-cab.gif` | [Šibenik 2066](https://zagreb.lol/sibenik-2066/) canvas loop, project 141. |
| `zagreb-network-map.png` | [Project 146 — five-line Zagreb proposal](https://zagreb.lol/prijevoz/?project=146&reduceMotion=1) |
| `zagreb-elevation-profile-editor.png` | [Project 153 — Zagreb–Karlovac reconstruction](https://zagreb.lol/prijevoz/?project=153&elevation=1&reduceMotion=1); select **Trasa 1** to open the profile editor and close the optional 3D relief inset. |
| `zagreb-elevated-railway.png` | [Project 153 Station3D ride at chainage 3+310](https://zagreb.lol/prijevoz/?project=153&st3d=planner-cab&line=1&offset=3310&dir=1&elevation=1&time=14&reduceMotion=1); pause with **P**, switch to the exterior camera with **C**, and raise the bird's-eye camera slightly with the mouse wheel. |
| `zagreb-tunnel-portal.png` | [Project 146 Station3D ride at chainage 1+750](https://zagreb.lol/prijevoz/?project=146&st3d=planner-cab&line=1&offset=1750&dir=-1&elevation=1&time=14&reduceMotion=1); pause with **P** and switch to the exterior camera with **C**. |

Station3D streams world data asynchronously, so background detail can vary
slightly between captures. The train, alignment, terrain and civil structures
come from the saved project and the same runtime used by the planner.
