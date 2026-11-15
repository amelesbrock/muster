"""Compile Wahapedia's CSV export into small per-faction JSON files for the app.

Input:  site/data/*.csv  (downloaded by fetch-data.sh)
Output: site/data/index.json, site/data/core.json, site/data/f/<FACTION_ID>.json
The raw CSVs are removed afterwards so only what the app needs is published.
"""
import csv, json, os, re, sys, collections, datetime

D = 'site/data'
csv.field_size_limit(10**9)


def rows(name):
    p = f'{D}/{name}.csv'
    if not os.path.exists(p):
        print(f'!! missing {name}.csv')
        return []
    with open(p, encoding='utf-8-sig', newline='') as fh:
        lines = fh.read().split('\n')
    header = lines[0].rstrip('\r').split('|')
    n = len(header)
    out, buf = [], ''
    for line in lines[1:]:
        line = line.rstrip('\r')
        buf = line if not buf else buf + '\n' + line
        if buf.count('|') < n - 1:
            continue  # field contained a newline; keep reading
        parts = buf.split('|')
        if len(parts) > n:  # stray pipes in text: merge extras into the longest text field
            parts = parts[: n - 1] + ['|'.join(parts[n - 1:])]
        out.append({h: (parts[i] if i < len(parts) else '') for i, h in enumerate(header) if h})
        buf = ''
    return out


def num(s):
    try:
        return int(re.sub(r'[^0-9]', '', s or '') or 0)
    except ValueError:
        return 0


HEADERS = collections.Counter()


def plain_text(h):
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', h or '')).strip()


def plus(v):
    v = (v or '').strip()
    return v + '+' if re.fullmatch(r'\d', v) else v


def rng(v):
    v = (v or '').strip()
    return v + '"' if re.fullmatch(r'\d+', v) else v


factions = rows('Factions')
sources = {r['id']: r for r in rows('Source')}
datasheets = rows('Datasheets')
detachments = rows('Detachments')
det_by_id = {d['id']: d for d in detachments}
BA = {d['id'] for d in detachments if 'boarding' in (d.get('type') or '').lower()}

by_ds = collections.defaultdict(lambda: collections.defaultdict(list))
for name in ('Datasheets_models', 'Datasheets_models_cost', 'Datasheets_wargear', 'Datasheets_abilities',
             'Datasheets_keywords', 'Datasheets_unit_composition', 'Datasheets_options', 'Datasheets_enhancements'):
    for r in rows(name):
        by_ds[r['datasheet_id']][name].append(r)
leads = collections.defaultdict(list)
led_by = collections.defaultdict(list)
for r in rows('Datasheets_leader'):
    leads[r['leader_id']].append(r['attached_id'])
    led_by[r['attached_id']].append(r['leader_id'])
abilities = {}
for r in rows('Abilities'):
    abilities.setdefault(r['id'], r)

strats = rows('Stratagems')
enhs = rows('Enhancements')
detab = rows('Detachment_abilities')


def unit(ds):
    g = by_ds[ds['id']]
    src = sources.get(ds['source_id'], {})
    models = [{
        'n': m['name'], 'M': m['M'], 'T': m['T'], 'Sv': m['Sv'], 'inv': plus(m['inv_sv']) if m['inv_sv'] not in ('', '-') else '',
        'invd': m['inv_sv_descr'], 'W': m['W'], 'Ld': m['Ld'], 'OC': m['OC'], 'base': m['base_size'],
    } for m in sorted(g['Datasheets_models'], key=lambda r: num(r['line']))]
    # Costs come in blocks: a header row (no cost) then size rows. 11th edition adds
    # stepped blocks (e.g. a higher cost for the 2nd/3rd unit of the same datasheet).
    blocks = []
    for c in sorted(g['Datasheets_models_cost'], key=lambda r: num(r['line'])):
        if not c['cost'].strip():
            blocks.append({'label': plain_text(c['description']), 'rows': []})
            HEADERS[plain_text(c['description'])] += 1
            continue
        if not blocks:
            blocks.append({'label': '', 'rows': []})
        m = re.search(r'(\d+)\s+models?', c['description'])
        blocks[-1]['rows'].append({'d': c['description'], 'pts': num(c['cost']), 'models': int(m.group(1)) if m else None})
    blocks = [b for b in blocks if b['rows']]
    step_re = re.compile(r'(\d+)\s*(?:st|nd|rd|th)\s*\+', re.I)
    base, steps, extras = None, [], []
    for b in blocks:
        o = step_re.search(b['label'])
        if o:
            steps.append({'label': b['label'], 'from': int(o.group(1)), 'rows': b['rows']})
        elif base is None:
            base = b
        elif all(r['models'] is not None for r in b['rows']) and not b['label'].upper().startswith('WARGEAR'):
            base['rows'].extend(b['rows'])  # alternative unit compositions are just more size options
        else:
            extras.append({'label': b['label'], 'rows': b['rows']})
    costs = base['rows'] if base else []
    weapons, seen = [], set()
    for w in sorted(g['Datasheets_wargear'], key=lambda r: (num(r['line']), num(r['line_in_wargear']))):
        key = (w['name'], w['range'], w['A'], w['BS_WS'], w['S'], w['AP'], w['D'], w['description'])
        if key in seen:
            continue
        seen.add(key)
        weapons.append({'n': w['name'], 't': 'melee' if w['type'].lower().startswith('melee') else 'ranged',
                        'r': rng(w['range']), 'A': w['A'], 's': plus(w['BS_WS']), 'S': w['S'], 'AP': w['AP'],
                        'D': w['D'], 'k': w['description']})
    ab, refs = [], {}
    for a in sorted(g['Datasheets_abilities'], key=lambda r: num(r['line'])):
        if a['ability_id']:
            base = abilities.get(a['ability_id'])
            if not base:
                continue
            refs[a['ability_id']] = {'n': base['name'], 'd': base['description']}
            ab.append({'ref': a['ability_id'], 't': a['type'], 'p': a['parameter'], 'mdl': a['model']})
        else:
            ab.append({'n': a['name'], 'd': a['description'], 't': a['type'], 'p': a['parameter'], 'mdl': a['model']})
    # unit keywords: those with no model, or marked for ALL MODELS
    kw = []
    for k in g['Datasheets_keywords']:
        if k['is_faction_keyword'] != 'true' and (not k['model'] or k['model'].strip().upper() == 'ALL MODELS') and k['keyword'] not in kw:
            kw.append(k['keyword'])
    mkw = sorted({f"{k['model']}: {k['keyword']}" for k in g['Datasheets_keywords'] if k['is_faction_keyword'] != 'true' and k['model'] and k['model'].strip().upper() != 'ALL MODELS'})
    fkw = sorted({k['keyword'] for k in g['Datasheets_keywords'] if k['is_faction_keyword'] == 'true'})
    kwl = [k.lower() for k in kw]
    return {
        'id': ds['id'], 'n': ds['name'], 'role': ds['role'] or 'Other',
        'src': src.get('name', ''), 'srcEd': src.get('edition', ''), 'srcType': src.get('type', ''),
        'legends': 'legends' in src.get('name', '').lower(),
        'sup': ds['is_support'] == 'true', 'lh': ds['leader_head'], 'lf': ds['leader_footer'],
        'load': ds['loadout'], 'tr': ds['transport'],
        'dmg': {'w': ds['damaged_w'], 'd': ds['damaged_description']} if ds['damaged_w'] else None,
        'link': ds['link'], 'm': models, 'c': costs, 'cs': steps, 'cx': extras, 'w': weapons, 'ab': ab, 'refs': refs,
        'kw': kw, 'mkw': mkw, 'fkw': fkw,
        'character': 'character' in kwl or 'character' in ds['role'].lower() or any(m.lower().endswith(': character') for m in mkw),
        'epic': 'epic hero' in kwl or 'epic hero' in ds['role'].lower(), 'battleline': 'battleline' in kwl,
        'dt': 'dedicated transport' in kwl or ds['role'] == 'Dedicated Transports',
        'comp': [c['description'] for c in sorted(g['Datasheets_unit_composition'], key=lambda r: num(r['line']))],
        'opt': [o['description'] for o in sorted(g['Datasheets_options'], key=lambda r: num(r['line']))],
        'leads': leads.get(ds['id'], []), 'ledBy': led_by.get(ds['id'], []),
        'enh': sorted({e['enhancement_id'] for e in g['Datasheets_enhancements']}),
    }


def dedupe_strats(lst):
    """Wahapedia keeps some older copies of the same stratagem; keep the newest (highest id) per name+detachment."""
    best = {}
    for s in lst:
        k = (s['n'].strip().upper(), s['det'])
        if k not in best or s['id'] > best[k]['id']:
            best[k] = s
    return list(best.values())


def strat(s):
    return {'id': s['id'], 'n': s['name'], 'type': s['type'], 'cp': s['cp_cost'], 'turn': s['turn'], 'ph': s['phase'],
            'det': s['detachment_id'], 'dn': s['detachment'], 'fac': s['faction_id'], 'd': s['description']}


os.makedirs(f'{D}/f', exist_ok=True)
index = []
stats = collections.Counter()
for fac in factions:
    fid = fac['id']
    units = [unit(ds) for ds in datasheets if ds['faction_id'] == fid and ds.get('virtual') != 'true']
    # move shared ability texts to a faction-level dictionary
    refs = {}
    for u in units:
        refs.update(u.pop('refs'))
    # Units borrowed from another faction (e.g. Astra Militarum in Genestealer Cults) are only
    # allowed with the detachment that brings them in: find it by the borrowed faction's name/keywords.
    def src_base(x):
        return re.sub(r'\s*\((Warhammer Legends|Forge World)\)', '', x or '').strip()
    own_kw = collections.Counter(k for u in units if src_base(u['src']) == fac['name'] for k in u['fkw'])
    det_text = {d['id']: plain_text(' '.join(a['name'] + ' ' + a['description'] for a in detab if a['detachment_id'] == d['id']))
                for d in detachments if d['faction_id'] == fid and d['id'] not in BA}
    crossovers = []
    for grp in sorted({src_base(u['src']) for u in units} - {fac['name'], ''}):
        members = [u for u in units if src_base(u['src']) == grp]
        kws = sorted({k for u in members for k in u['fkw'] if k not in own_kw}) or [grp]
        unlock = [did for did, txt in det_text.items() if any(re.search(re.escape(k), txt, re.I) for k in kws + [grp])]
        for u in members:
            u['xg'] = grp
            u['xu'] = unlock
        crossovers.append({'n': grp, 'kw': kws, 'units': len(members), 'unlock': unlock})
    dets = []
    for d in detachments:
        if d['faction_id'] != fid or d['id'] in BA:
            continue
        dets.append({
            'id': d['id'], 'n': d['name'], 'dp': num(d['dp']),
            'fd': [x.strip() for x in (d['force_disposition'] or '').split(',') if x.strip()],
            'rules': [{'n': a['name'], 'd': a['description']} for a in detab if a['detachment_id'] == d['id']],
        })
    fac_enh = [{
        'id': e['id'], 'n': e['name'], 'pts': num(e['cost']), 'det': e['detachment_id'], 'dn': e['detachment'],
        'up': e['upgrade'] == 'true', 'sl': e['support_leader'], 'd': e['description'],
    } for e in enhs if e['faction_id'] == fid and e['detachment_id'] not in BA]
    fac_str = dedupe_strats([strat(s) for s in strats if s['faction_id'] == fid and s['detachment_id'] not in BA
                             and 'boarding' not in (s['type'] or '').lower()])
    army_rules = {}
    for u in units:
        if u.get('xg'):
            continue  # borrowed units bring their own faction's army rule
        for a in u['ab']:
            if a.get('t') == 'Faction' and a.get('ref'):
                army_rules[a['ref']] = refs[a['ref']]
    out = {'id': fid, 'n': fac['name'], 'units': units, 'detachments': dets, 'enhancements': fac_enh,
           'stratagems': fac_str, 'abilities': refs, 'armyRules': list(army_rules.values()), 'crossovers': crossovers}
    with open(f'{D}/f/{fid}.json', 'w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))
    size = os.path.getsize(f'{D}/f/{fid}.json')
    index.append({'id': fid, 'n': fac['name'], 'units': len(units), 'detachments': len(dets), 'bytes': size})
    stats['units'] += len(units)
    print(f"{fid:5} {fac['name'][:22]:22} units={len(units):4} dets={len(dets):3} enh={len(fac_enh):3} strats={len(fac_str):4} {size//1024}KB "
          f"legends={sum(u['legends'] for u in units)} crossovers={[(c['n'], c['units'], len(c['unlock'])) for c in crossovers]}")

core = [strat(s) for s in strats if not s['faction_id'] and not s['detachment_id'] and 'boarding' not in (s['type'] or '').lower()
        and s['name']]
core = dedupe_strats(core)
print('core', len(core), collections.Counter(s['type'] for s in core))
with open(f'{D}/core.json', 'w', encoding='utf-8') as fh:
    json.dump({'stratagems': core}, fh, ensure_ascii=False, separators=(',', ':'))

last = rows('Last_update')
manifest = json.load(open(f'{D}/manifest.json')) if os.path.exists(f'{D}/manifest.json') else {}
with open(f'{D}/index.json', 'w', encoding='utf-8') as fh:
    json.dump({
        'built': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
        'wahapediaUpdate': (last[0]['last_update'] if last else ''),
        'source': manifest.get('source', ''),
        'factions': sorted(index, key=lambda f: f['n']),
    }, fh, ensure_ascii=False, indent=1)
print('Cost headers:', HEADERS.most_common(15))
print('Sources:', sorted({(s['name'], s['type'], s['edition']) for s in sources.values()}))
# publish only compiled JSON
for f in os.listdir(D):
    if f.endswith('.csv'):
        os.remove(f'{D}/{f}')
if stats['units'] == 0:
    print('!! no units compiled — failing so the previous deployment stays live')
    sys.exit(1)
