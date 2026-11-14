# Muster — army list builder & battle tracker

An installable web app (PWA) for building army lists from the community BattleScribe data (BSData) and tracking games. It runs offline once installed. Lists and games are stored on your device.

## Put it online (one-time, free)

The app has to be served over HTTPS before phones can install it. Pick one of these:

### Option A: Netlify Drop (easiest, needs a computer)
1. Unzip `muster.zip`.
2. Go to https://app.netlify.com/drop and drag the **muster** folder onto the page.
3. Sign up for a free account when it offers, so the site stays up. You get a link like `https://something.netlify.app`. You can rename it in Site settings.

### Option B: GitHub Pages
1. Create a free GitHub account and a new **public** repository, e.g. `muster`.
2. Upload the files from this folder (Add file → Upload files). `index.html` should sit at the top level of the repo.
3. Go to Settings → Pages → Source: *Deploy from a branch* → `main` / root → Save.
4. After a minute the app is at `https://<your-username>.github.io/muster/`.

## Install on phones
- **iPhone**: open the link in **Safari** → Share → **Add to Home Screen**.
- **Android**: open the link in **Chrome** → tap **Install** in the app, or ⋮ menu → **Install app**.

Send your friends the same link. Each person's lists stay on their own phone. To swap lists, use **⋯ → Share code** and paste it into **Import**.

## Points updates
Go to **Data → Update downloaded factions**. The app re-downloads the latest community data, shows you what changed, and every list recalculates automatically. If a unit's points ever look wrong, open it in your list and use **"Points look wrong? Set them manually"**.

## Updating the app itself
If you change any app file, also change `VERSION` in `sw.js` (e.g. `muster-v2`) so installed copies pick up the update.

## Notes
- Unofficial fan tool, not affiliated with or endorsed by Games Workshop. Data comes from the volunteer BSData project (github.com/BSData), so check anything important against your official rules.
- The data source (owner/repo/branch) can be changed under **Data → Data source**, for when a new edition repository appears.
