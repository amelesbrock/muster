# Tests

Browser tests (Playwright + Chrome) that run against a local copy of the built site on http://localhost:8765:

- `rules.test.mjs` — 28 scripted army lists checking the 11th edition army-building rules (points, DP, unit limits, Battleline, Epic Heroes, enhancements, Warlord, Leader/Support, allied units and their points caps, detachment tags, stepped costs, share codes).
- `e2e-factions.test.mjs` — builds a list for every faction, opens every unit screen and tab, taps weapon keywords, filters stratagems by phase; fails on any JS error.
- `e2e-flows.test.mjs` — battle, missions, secondaries, trackers, collection, backup, share codes, back button, offline.

Serve `site/` (app + compiled `data/`) on port 8765, then `node tests/<file>`.
