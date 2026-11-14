# Prints a compact structural summary of the data export to the build log (for development).
import csv, sys, collections, os
csv.field_size_limit(10**9)
D = 'site/data'
def rows(name):
    p = f'{D}/{name}.csv'
    if not os.path.exists(p): return []
    with open(p, encoding='utf-8-sig', newline='') as fh:
        return list(csv.DictReader(fh, delimiter='|', quoting=csv.QUOTE_NONE))
def cut(s, n=90): s = (s or '').replace('\n', ' '); return s if len(s) <= n else s[:n] + '…'
print('==== INSPECT ====')
fac = rows('Factions'); print('FACTIONS', [(r['id'], r['name']) for r in fac])
st = rows('Stratagems')
for k in ('type', 'turn', 'phase', 'legend', 'cp_cost'):
    print('STRAT', k, collections.Counter(r[k] for r in st).most_common(25))
print('STRAT faction blank', sum(1 for r in st if not r['faction_id']), 'detachment blank', sum(1 for r in st if not r['detachment_id']))
for r in [x for x in st if not x['detachment_id']][:4] + [x for x in st if x['faction_id'] in ('GC','LoV')][:3]:
    print('STRAT row', {k: cut(v) for k, v in r.items()})
det = rows('Detachments')
print('DET type', collections.Counter(r['type'] for r in det).most_common(), 'dp', collections.Counter(r['dp'] for r in det).most_common(), 'fd', collections.Counter(r['force_disposition'] for r in det).most_common(12))
for r in [x for x in det if x['faction_id'] in ('GC', 'LoV')]: print('DET', {k: cut(v, 40) for k, v in r.items()})
for r in rows('Detachment_abilities')[:2]: print('DETAB', {k: cut(v) for k, v in r.items()})
en = rows('Enhancements'); print('ENH upgrade', collections.Counter(r['upgrade'] for r in en).most_common(5), 'support', collections.Counter(r['support_leader'] for r in en).most_common(5))
for r in en[:2]: print('ENH', {k: cut(v) for k, v in r.items()})
ds = rows('Datasheets')
print('DS role', collections.Counter(r['role'] for r in ds).most_common(), 'virtual', collections.Counter(r['virtual'] for r in ds).most_common(), 'support', collections.Counter(r['is_support'] for r in ds).most_common(), 'legend', collections.Counter(bool(r['legend']) for r in ds).most_common())
src = {r['id']: r for r in rows('Source')}
for r in [x for x in ds if x['faction_id'] == 'LoV'][:3]: print('DS', {k: cut(v, 60) for k, v in r.items()})
print('SOURCE types', collections.Counter(r['type'] for r in src.values()).most_common(), [ (r['id'], r['name'], r['edition']) for r in list(src.values())[:12]])
ids = [x['id'] for x in ds if x['faction_id'] == 'LoV'][:2]
for name in ('Datasheets_models', 'Datasheets_models_cost', 'Datasheets_wargear', 'Datasheets_abilities', 'Datasheets_keywords', 'Datasheets_unit_composition', 'Datasheets_options'):
    rs = [r for r in rows(name) if r['datasheet_id'] in ids][:6]
    for r in rs: print(name, {k: cut(v, 70) for k, v in r.items()})
ab = rows('Datasheets_abilities'); print('DSAB type', collections.Counter(r['type'] for r in ab).most_common())
print('ABIL', [ {k: cut(v,50) for k,v in r.items()} for r in rows('Abilities')[:3]])
print('==== END ====')
