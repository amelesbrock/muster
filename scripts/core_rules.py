"""Extract weapon abilities ([BLAST], [SUSTAINED HITS X], …) from Wahapedia's core rules page
into core.json as {"weaponAbilities": {"SUSTAINED HITS": {"n": "[SUSTAINED HITS]", "d": html}}}."""
import json, os, re

D = 'site/data'
SRC = f'{D}/core-rules.html'


def key(name):
    k = re.sub(r'[\[\]]', '', name).upper().strip()
    k = re.sub(r'\s+(X|D?\d+\+?|\d+")$', '', k)  # [SUSTAINED HITS X] -> SUSTAINED HITS
    return re.sub(r'\s+', ' ', k)


def main():
    if not os.path.exists(SRC):
        print('!! core rules page missing; skipping weapon abilities')
        return
    h = open(SRC, encoding='utf-8').read()
    out = {}
    starts = [m.start() for m in re.finditer(r'<div class="abWrap', h)]
    for i, st in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else st + 20000
        chunk = h[st:end]
        cut = re.search(r'<span id="tooltip_content|<a name=|<h2', chunk[20:])
        if cut:
            chunk = chunk[:20 + cut.start()]
        nm = re.search(r'class="abName">(.*?)<span class="h_number"', chunk, re.S) or re.search(r'class="abName">(.*?)</div>', chunk, re.S)
        if not nm:
            continue
        name = re.sub(r'<[^>]+>', '', nm.group(1)).strip()
        if not name.startswith('['):
            continue  # unit abilities are already in the CSV export
        body = re.sub(r'^.*?class="abNameWrap">.*?</div></div>', '', chunk, count=1, flags=re.S)
        body = re.sub(r'<script.*?</script>', '', body, flags=re.S)
        k = key(name)
        if k not in out or len(body) > len(out[k]['d']):
            out[k] = {'n': name, 'd': body}
    # Actions such as INDIRECT SHOOTING / ASSAULT SHOOTING that weapon abilities point to
    actions = {}
    for m in re.finditer(r'class="str11HeadBlock str11Name"[^>]*>(.*?)<span class="h_number">', h, re.S):
        name = re.sub(r'<[^>]+>', '', m.group(1)).strip().upper()
        rest = h[m.end():m.end() + 30000]
        stop = re.search(r'<a name=|class="str11HeadBlock str11Name"', rest)
        if stop:
            rest = rest[:stop.start()]
        t0 = rest.find('<div class="str11Text">')
        if t0 < 0:
            continue
        t1 = rest.find('<div class="str11Bg', t0)
        body = re.sub(r'<script.*?</script>', '', rest[t0:t1 if t1 > 0 else None], flags=re.S)
        if name and (name not in actions or len(body) > len(actions[name])):
            actions[name] = body
    # Whole core rules as a searchable reference: every numbered heading with the text under it
    body_h = h
    marks = []
    for m in re.finditer(r'<h1[^>]*>(.*?)</h1>', body_h, re.S):
        marks.append((m.start(), 'chapter', re.sub(r'<[^>]+>', ' ', m.group(1)).strip(), '', m.end()))
    for m in re.finditer(r'<(h2|h3|div)([^>]*)>([^<]{2,90})<span class="h_number">([\d.]+)</span>', body_h):
        marks.append((m.start(), m.group(1), m.group(3).strip(), m.group(4), m.end()))
    marks.sort()
    # tooltips repeat some headings: keep the first copy of each numbered heading that isn't inside a tooltip
    seen_num, kept = set(), []
    for mk in marks:
        if mk[1] != 'chapter':
            if 'id="tooltip_content' in body_h[max(0, mk[0] - 400):mk[0]] or mk[3] in seen_num:
                continue
            seen_num.add(mk[3])
        kept.append(mk)
    marks = kept
    CH = {'01': 'Core concepts', '02': 'Datasheets', '03': 'Moving and setting up', '04': 'Making attacks',
          '05': 'Attack sequence', '06': 'Visibility and mortal wounds', '07': 'The battle round', '08': 'Command phase',
          '09': 'Movement phase', '10': 'Shooting phase', '11': 'Charge phase', '12': 'Fight phase', '13': 'Terrain',
          '14': 'Objectives', '15': 'Core stratagems', '16': 'Actions', '17': 'Monsters and vehicles', '18': 'Transports',
          '19': 'Attached units', '20': 'Strategic reserves', '21': 'Surge moves and flying', '22': 'Auras and faction abilities',
          '23': 'Big models', '24': 'Core and weapon abilities', '25': 'Mustering your army'}
    tt = body_h.find('<div class="tooltip_templates"')
    rules, chapter = [], ''
    for i, (pos, kind, title, num, endpos) in enumerate(marks):
        if kind == 'chapter':
            chapter = re.sub(r'\s+', ' ', title)
            continue
        nxt = marks[i + 1][0] if i + 1 < len(marks) else min(endpos + 15000, tt if tt > endpos else len(body_h))
        seg = body_h[endpos:nxt]
        seg = re.sub(r'<script.*?</script>', '', seg, flags=re.S)
        seg = re.sub(r'^\s*</(div|h2|h3)>', '', seg)
        title_clean = re.sub(r'\s+', ' ', title)
        rules.append({'num': num, 'n': title_clean, 'ch': (num.split('.')[0] + ' · ' + CH[num.split('.')[0]]) if num.split('.')[0] in CH else (chapter or num.split('.')[0]), 'lvl': 3 if kind == 'h3' or num.count('.') > 1 else 2, 'd': seg})
    path = f'{D}/core.json'
    core = json.load(open(path, encoding='utf-8')) if os.path.exists(path) else {}
    core['weaponAbilities'] = out
    core['actions'] = actions
    core['coreRules'] = rules
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(core, fh, ensure_ascii=False, separators=(',', ':'))
    os.remove(SRC)
    print('weapon abilities:', len(out), sorted(out))
    print('actions:', len(actions), sorted(actions)[:60])
    chs = []
    for r in rules:
        if not chs or chs[-1][0] != r['ch']:
            chs.append([r['ch'], 0])
        chs[-1][1] += 1

    print('core rules:', len(rules), 'sections in', len(chs), 'chapters:', chs)
    print('sizes:', sorted(len(r['d']) for r in rules)[-5:], 'marks', len(marks), 'h1', len(re.findall(r'<h1', body_h)))


if __name__ == '__main__':
    main()
