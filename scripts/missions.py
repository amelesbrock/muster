"""Compile Wahapedia's Chapter Approved mission deck page into site/data/missions.json.

The page keeps each card as an HTML string inside JavaScript arrays
(ContentFD, ContentPM, ContentSM, ContentTW, ContentDP). We read those arrays and keep:
  - the Force Disposition matchup table (your disposition x opponent's -> your primary mission)
  - primary missions, secondary missions, twists and deployment maps with their card text.
Deployment map images are downloaded so the app can show them offline.
"""
import json, os, re, sys, urllib.request

D = 'site/data'
SRC = f'{D}/mission-deck.html'
BASE = 'https://wahapedia.ru'
UA = 'Mozilla/5.0 (compatible; MusterApp/1.0; personal list builder)'


def arrays(html):
    out = {}
    for m in re.finditer(r"var (Content\w+)\s*=\s*\[(.*?)\];", html, re.S):
        items = re.findall(r"'((?:[^'\\]|\\.)*)'", m.group(2))
        out[m.group(1)] = [re.sub(r"\\(.)", r"\1", it) for it in items]
    return out


def text(h):
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', h or '')).strip()


def name_of(card):
    m = re.search(r'class="ca7Name">(.*?)</div>', card, re.S)
    return text(m.group(1)) if m else ''


def fluff(card):
    m = re.search(r'class="ShowFluff ca7Legend">(.*?)</p>', card, re.S)
    return text(m.group(1)) if m else ''


def body(card):
    i = card.find('<div class="ca7Body">')
    return card[i:] if i >= 0 else ''


def title_case(s):
    small = {'and', 'the', 'of', 'on', 'a', 'to', 'in'}
    words = s.lower().split()
    return ' '.join(w if (i and w in small) else w[:1].upper() + w[1:] for i, w in enumerate(words))


def main():
    if not os.path.exists(SRC):
        print('!! mission deck page missing; skipping missions')
        return
    html = open(SRC, encoding='utf-8').read()
    A = arrays(html)
    fds, matrix = [], {}
    for card in A.get('ContentFD', []):
        fd = name_of(card)
        fds.append({'n': fd, 'fluff': fluff(card)})
        for row in card.split('class="caFdRow"')[1:]:
            who = re.findall(r'title="Force Disposition: ([^"]+)"', row)
            mn = re.search(r'class="caFdMissionName">(.*)', row, re.S)
            if len(who) >= 2 and mn:
                matrix.setdefault(who[0], {})[who[1]] = title_case(text(mn.group(1)))
    prim = []
    for card in A.get('ContentPM', []):
        fd = re.search(r'ca7HeadPM ca7Head(\w+)', card)
        prim.append({'n': title_case(name_of(card)), 'fdKey': fd.group(1) if fd else '', 'fluff': fluff(card), 'd': body(card)})
    sec = []
    for card in A.get('ContentSM', []):
        b = body(card)
        sec.append({'n': title_case(name_of(card)), 'fluff': fluff(card), 'd': b, 'fixed': 'FIXED' in text(b).upper()})
    tw = [{'n': title_case(name_of(c)), 'fluff': fluff(c), 'd': body(c)} for c in A.get('ContentTW', [])]
    dep = []
    os.makedirs(f'{D}/maps', exist_ok=True)
    for c in A.get('ContentDP', []):
        img = re.search(r'<img src="([^"]+)"', c)
        local = ''
        if img:
            fn = os.path.basename(img.group(1))
            try:
                req = urllib.request.Request(BASE + img.group(1), headers={'User-Agent': UA})
                with urllib.request.urlopen(req, timeout=60) as r, open(f'{D}/maps/{fn}', 'wb') as fh:
                    fh.write(r.read())
                local = f'maps/{fn}'
            except Exception as e:  # map image is a nice-to-have
                print('!! map image', fn, e)
        dep.append({'n': title_case(name_of(c)), 'img': local})
    out = {'fds': fds, 'matrix': matrix, 'primary': prim, 'secondary': sec, 'twists': tw, 'deployments': dep}
    with open(f'{D}/missions.json', 'w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))
    os.remove(SRC)
    print('missions:', len(fds), 'dispositions,', sum(len(v) for v in matrix.values()), 'matchups,', len(prim), 'primary,',
          len(sec), 'secondary (', sum(s['fixed'] for s in sec), 'fixed ),', len(tw), 'twists,', len(dep), 'deployments')
    print('matrix', json.dumps(matrix))
    missing = {m for row in matrix.values() for m in row.values()} - {p['n'] for p in prim}
    if missing:
        print('!! matchup missions with no card:', missing)


if __name__ == '__main__':
    main()
