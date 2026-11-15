# NM Hydrograph Explorer

Composite groundwater-level hydrographs for New Mexico wells, from the NM Unified Water Data API.
This folder is complete: upload all of it and the site has everything it needs.

## What's here

| File | What it is |
|---|---|
| `index.html` | The whole app. Built from `source/`; don't edit it by hand. |
| `kriged/` | HUC-10 boundaries and the precomputed kriged basin averages (its own README explains the method). |
| `readings-snapshot.bin` | Every reading, packed, so the page loads fast. The weekly workflow rebuilds it. |
| `nm-site-metadata.json` | Well details the API doesn't serve, including each well's vertical datum. |
| `literature-readings.csv` | Readings from NMBGMR open-file reports that the API doesn't have yet. |
| `nm-water-table.bin` | Regional water-table grid (NMBGMR 2026 Depth to Water Map v2). |
| `water-systems.js` | Data for the water-systems screen (see below). |
| `source/page.html`, `app.js`, `styles.css`, `data.js` | The app's source: layout and help, code, styling, built-in boundaries and the published numbers the area comparisons use (Myers 2022, Technical Report 34, Rinehart et al. 2016). |
| `source/water-systems-screen-*` | Code and styling for the water-systems screen (see below). |
| `build.mjs`, `package.json` | `node build.mjs` rebuilds `index.html` from `source/`; `package.json` has shortcuts for the commands. |
| `tools/` | `build-snapshot.mjs` (readings snapshot), `build-water-systems.py` (water-systems data), `regress.py` + two `.json` files (regression test). |
| `.github/workflows/` | `pages.yml` publishes the site and rebuilds the snapshot every Sunday; `build-check.yml` checks `index.html` matches `source/`. |

## Water-systems screen
The screen for small community water systems (from another session) is included but not connected to the app, as it was before.
Connecting it adds a "Water systems" tab.

## Upload to GitHub
1. Delete the old files and folders in the repository.
2. Upload everything in this folder, keeping the folders.
3. Settings → Pages → Source: **GitHub Actions** (one time).

## Changing the app
Edit the files in `source/`, run `node build.mjs`, and upload `index.html` with the changed source file.
`node build.mjs --check` tells you whether `index.html` is up to date.

## Testing
```
python3 -m http.server 8765        # in this folder
python3 tools/regress.py            # in another terminal
```
