# NM Hydrograph Explorer

Composite groundwater-level hydrographs for New Mexico wells, from the NM Unified Water Data API.

## What's here

| File | What it is |
|---|---|
| `index.html` | The whole app. Built from `source/`; don't edit it by hand. |
| `nm-water-table.bin` | Regional water-table grid (NMBGMR 2026 Depth to Water Map v2). |
| `source/page.html` | Page layout and help text. |
| `source/app.js` | All of the app's code. |
| `source/styles.css` | All of the styling. |
| `source/data.js` | Built-in boundaries and well attributes. |
| `build.mjs` | Rebuilds `index.html` from `source/`. |
| `tools/build-snapshot.mjs` | Downloads every reading into `readings-snapshot.bin` (the weekly workflow runs it). |
| `tools/regress.py` + two `.json` files | The regression test and its reference data (Myers 2022, State Engineer TR 34). |
| `.github/workflows/pages.yml` | Publishes the site and rebuilds the readings snapshot every Sunday. |

These also live in the GitHub repository and are left alone: `boundaries/`, `literature-readings.csv`, `nm-site-metadata.json`. `readings-snapshot.bin` is made by the workflow and never committed.

## Upload to GitHub

1. In the repository, delete the old `src/`, `tests/`, `workflows/` folders, `package.json` and `HOW-TO-UPLOAD.txt` (and `.github/workflows/snapshot.yml` if it's still there).
2. Upload everything in this folder, keeping the `source/`, `tools/` and `.github/workflows/` folders.
3. Settings → Pages → Source: **GitHub Actions** (one time).

## Changing the app

Edit the files in `source/`, run `node build.mjs`, and upload `index.html` along with the changed source file.
`node build.mjs --check` tells you whether `index.html` is up to date.

## Testing

```
python3 -m http.server 8765        # in this folder
python3 tools/regress.py            # in another terminal
```
