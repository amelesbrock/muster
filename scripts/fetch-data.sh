#!/usr/bin/env bash
# Downloads Wahapedia's public data export into site/data for the app to read.
# Runs inside GitHub Actions; never fails the build if a file is missing.
set -u
BASE="${WAHAPEDIA_BASE:-https://wahapedia.ru/wh40k11ed}"
OUT="site/data"
mkdir -p "$OUT"
FILES="Last_update Factions Source Datasheets Datasheets_abilities Datasheets_keywords Datasheets_models Datasheets_options Datasheets_wargear Datasheets_unit_composition Datasheets_models_cost Datasheets_stratagems Datasheets_enhancements Datasheets_detachment_abilities Datasheets_leader Stratagems Abilities Enhancements Detachment_abilities Detachments Datasheets_detachments Force_dispositions Detachments_force_dispositions"
UA="Mozilla/5.0 (compatible; MusterApp/1.0; personal list builder)"
echo '{"files":{' > "$OUT/manifest.json.tmp"
first=1
for f in $FILES; do
  if curl -fsSL --retry 2 --connect-timeout 20 --max-time 90 -A "$UA" "$BASE/$f.csv" -o "$OUT/$f.csv"; then
    size=$(wc -c < "$OUT/$f.csv")
    rows=$(wc -l < "$OUT/$f.csv")
    header=$(head -n1 "$OUT/$f.csv" | tr -d '\r\n\357\273\277' | sed 's/\\/\\\\/g; s/"/\\"/g')
    [ $first -eq 1 ] || echo ',' >> "$OUT/manifest.json.tmp"
    first=0
    printf '"%s":{"bytes":%s,"rows":%s,"header":"%s"}' "$f" "$size" "$rows" "$header" >> "$OUT/manifest.json.tmp"
    echo "ok   $f ($rows rows)"
  else
    rm -f "$OUT/$f.csv"
    echo "miss $f"
  fi
done
printf '},"fetched":"%s","source":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$BASE" >> "$OUT/manifest.json.tmp"
mv "$OUT/manifest.json.tmp" "$OUT/manifest.json"
cat "$OUT/manifest.json"
