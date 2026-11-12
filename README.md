# Power / Place: Canada's data centre buildout

An interactive data story about where Canada's data centres are planned, how much power they report, and the provincial grids around them.

Personal project, views my own. Built during SheBuilds (November 2026).

## Data

All data files are in `public/data/`. See [METHODS.md](METHODS.md) for sources, columns and judgement calls. No numbers are estimated or filled in: if a source doesn't report a value, the site shows "Not disclosed".

| File | What it is | Source |
| --- | --- | --- |
| `projects.csv` | 51 named data centre projects | Government of Alberta, AESO, company releases, municipal files, news (link on every row) |
| `provinces.csv` | Planned MW and grid rules by province | York University (SSRN 6464099), grid operators, government and law-firm summaries |
| `energy_mix_2025.csv` | 2025 electricity generation by source | Statistics Canada, Table 25-10-0015-01 |
| `power-lines.geojson` | Transmission lines with voltage where matched | NRCan CanVec 1:250K + © OpenStreetMap contributors (ODbL) |
| `clean-power-stations.geojson` | 1,078 operating clean power stations | NRCan Clean Energy Resources and Projects (CERP) |
| `drainage-areas.geojson` | Major drainage areas (watersheds) | NRCan Atlas of Canada |

## Run it

```bash
pnpm install
pnpm dev
```

Pushing to `main` deploys to GitHub Pages automatically (turn on Pages with source "GitHub Actions" in repo Settings → Pages).
