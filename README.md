# Muster — 11th edition army builder, battle tracker & stratagems

An installable web app for building Warhammer 40,000 army lists, tracking games and looking up stratagems. It's for personal use by a small group, not for redistribution.

**App:** https://amelesbrock.github.io/muster/

## Install on a phone
- **iPhone:** open the link in Safari → Share → **Add to Home Screen**.
- **Android:** open the link in Chrome → **Install** (or ⋮ → Install app).

## Where the data comes from
Every night (03:17 UTC) a GitHub Action downloads Wahapedia's public data export, compiles it into small per-faction files and republishes the site. Data powered by [Wahapedia](https://wahapedia.ru).

- To update straight away (e.g. after a points change): on GitHub open **Actions → Build and deploy Muster → Run workflow**. Then in the app: ⚙ → **Update data on this phone**.
- If Wahapedia can't be reached, the build fails on purpose and the previous version stays live.

## Layout
- `app/` — the web app (HTML/CSS/JS, no build step)
- `scripts/fetch-data.sh` — downloads the CSV export
- `scripts/compile.py` — turns it into `data/index.json`, `data/core.json` and `data/f/<faction>.json`
- `.github/workflows/deploy.yml` — build and deploy to GitHub Pages

Unofficial fan tool, not affiliated with or endorsed by Games Workshop.
