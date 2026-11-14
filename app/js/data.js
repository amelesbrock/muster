// Muster — downloading BattleScribe data from GitHub and compiling factions
import { xmlToTree, compileFaction, catalogueDeps, isLibraryFile, cleanFactionName, diffPoints } from './bsdata.js';
import * as store from './store.js';

export const DEFAULT_SOURCE = { owner: 'BSData', repo: 'wh40k-10e', branch: 'main' };

// Used when the GitHub API can't be reached (rate limits etc.)
const FALLBACK_FILES = [
  'Aeldari - Craftworlds.cat', 'Aeldari - Drukhari.cat', 'Aeldari - Ynnari.cat',
  'Chaos - Chaos Daemons.cat', 'Chaos - Chaos Knights.cat', 'Chaos - Chaos Space Marines.cat',
  'Chaos - Death Guard.cat', "Chaos - Emperor's Children.cat", 'Chaos - Thousand Sons.cat',
  'Chaos - World Eaters.cat', 'Genestealer Cults.cat', 'Imperium - Adepta Sororitas.cat',
  'Imperium - Adeptus Custodes.cat', 'Imperium - Adeptus Mechanicus.cat',
  'Imperium - Agents of the Imperium.cat', 'Imperium - Astra Militarum.cat',
  'Imperium - Black Templars.cat', 'Imperium - Blood Angels.cat', 'Imperium - Dark Angels.cat',
  'Imperium - Deathwatch.cat', 'Imperium - Grey Knights.cat', 'Imperium - Imperial Knights.cat',
  'Imperium - Space Marines.cat', 'Imperium - Space Wolves.cat', 'Leagues of Votann.cat',
  'Necrons.cat', 'Orks.cat', "T'au Empire.cat", 'Tyranids.cat',
];

const enc = (s) => s.split('/').map(encodeURIComponent).join('/');

export function rawUrl(src, ref, file) {
  return `https://raw.githubusercontent.com/${src.owner}/${src.repo}/${encodeURIComponent(ref)}/${enc(file)}`;
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub said ${r.status}`);
  return r.json();
}

// Latest commit on the branch: {sha, date}
export async function latestCommit(src) {
  const j = await fetchJson(`https://api.github.com/repos/${src.owner}/${src.repo}/commits/${encodeURIComponent(src.branch)}`);
  return { sha: j.sha, date: j.commit?.committer?.date || j.commit?.author?.date || '' };
}

export function groupOf(file) {
  const m = file.match(/^(Imperium|Chaos|Aeldari|Xenos)\s+-\s+/);
  if (m) return m[1] === 'Aeldari' ? 'Xenos' : m[1];
  if (/unaligned|titan/i.test(file)) return 'Other';
  return 'Xenos';
}

export function factionLabel(file) {
  return cleanFactionName(file.replace(/\.cat$/i, ''));
}

// List of selectable faction catalogues
export async function listFactions(src, ref) {
  let files;
  try {
    const j = await fetchJson(`https://api.github.com/repos/${src.owner}/${src.repo}/contents/?ref=${encodeURIComponent(ref || src.branch)}`);
    files = j.filter((x) => x.type === 'file' && /\.cat$/i.test(x.name)).map((x) => x.name);
  } catch {
    files = FALLBACK_FILES;
  }
  return files
    .filter((f) => !isLibraryFile(f) && !/^Library\s+-/i.test(f))
    .map((file) => ({ file, name: factionLabel(file), group: groupOf(file) }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}

async function fetchText(src, ref, file, onProgress) {
  const key = `${src.owner}/${src.repo}@${ref}/${file}`;
  const cached = await store.get('raw', key);
  if (cached) return cached;
  onProgress && onProgress(`Downloading ${file}…`);
  const r = await fetch(rawUrl(src, ref, file), { cache: 'no-cache' });
  if (!r.ok) throw new Error(`Couldn't download “${file}” (${r.status})`);
  const text = await r.text();
  await store.set('raw', key, text);
  return text;
}

async function findGst(src, ref) {
  try {
    const j = await fetchJson(`https://api.github.com/repos/${src.owner}/${src.repo}/contents/?ref=${encodeURIComponent(ref)}`);
    const g = j.find((x) => /\.gst$/i.test(x.name));
    if (g) return g.name;
  } catch { /* ignore */ }
  return 'Warhammer 40,000.gst';
}

// Download + compile one faction. Returns {faction, changes}
export async function buildFaction(src, file, { ref, onProgress } = {}) {
  let commit = null;
  if (!ref) {
    try {
      commit = await latestCommit(src);
      ref = commit.sha;
    } catch {
      ref = src.branch;
    }
  }
  // Drop cached downloads from older data versions
  for (const k of await store.keys('raw')) {
    if (!String(k).includes(`@${ref}/`)) await store.del('raw', k);
  }
  const gstName = (await store.get('kv', `gst:${src.owner}/${src.repo}`)) || (await findGst(src, ref));
  await store.set('kv', `gst:${src.owner}/${src.repo}`, gstName);
  const yieldUi = () => new Promise((r) => setTimeout(r, 0));
  const gstXml = await fetchText(src, ref, gstName, onProgress);
  onProgress && onProgress('Reading core rules…');
  await yieldUi();
  const gst = xmlToTree(gstXml);
  const mainXml = await fetchText(src, ref, file, onProgress);
  onProgress && onProgress(`Reading ${factionLabel(file)}…`);
  await yieldUi();
  const main = xmlToTree(mainXml);
  // Libraries, transitively
  const libs = [];
  const seen = new Set([main.a.id]);
  const queue = catalogueDeps(main);
  const warnings = [];
  while (queue.length) {
    const dep = queue.shift();
    if (seen.has(dep.id)) continue;
    seen.add(dep.id);
    try {
      const xml = await fetchText(src, ref, `${dep.name}.cat`, onProgress);
      await yieldUi();
      const t = xmlToTree(xml);
      libs.push(t);
      queue.push(...catalogueDeps(t));
    } catch (e) {
      warnings.push(`Linked catalogue “${dep.name}” could not be loaded`);
    }
  }
  onProgress && onProgress('Building datasheets…');
  await yieldUi();
  const faction = compileFaction({ main, libs, gst }, { file, source: `${src.owner}/${src.repo}@${ref.slice(0, 7)}` });
  faction.commitDate = commit?.date || '';
  faction.warnings = warnings;
  const old = await store.get('factions', file);
  const changes = diffPoints(old, faction);
  await store.set('factions', file, faction);
  return { faction, changes };
}

export async function clearRawCache() {
  await store.clear('raw');
}
