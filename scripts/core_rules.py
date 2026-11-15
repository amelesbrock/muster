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
    path = f'{D}/core.json'
    core = json.load(open(path, encoding='utf-8')) if os.path.exists(path) else {}
    core['weaponAbilities'] = out
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(core, fh, ensure_ascii=False, separators=(',', ':'))
    os.remove(SRC)
    print('weapon abilities:', len(out), sorted(out))


if __name__ == '__main__':
    main()
