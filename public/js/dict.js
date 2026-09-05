// 分片离线词典。
//
// 完整词典是 32 万词、26 MB 的 JSON，直接 JSON.parse 会让手机卡死甚至崩掉。
// 所以按首两字母切成 647 个几十 KB 的分片（ab.json、ac.json…），
// 查词时只加载对应那一片，用 Cache API 存起来，查过的常驻内存 ——
// 「点一下秒出」这个核心体验就是靠这个保住的。

import { pMap } from './util.js';
import { NATIVE } from './env.js';

const DICT_BASE = '/dict/';
const CACHE_NAME = 'gloss-dict-v1';

const mem = new Map();        // 分片名 -> {word: entry}
const pending = new Map();    // 分片名 -> Promise，防止同一片被并发拉两次
let manifest = null;
let cacheP = null;

function cache() {
  // 单机版里 647 个分片就躺在安装包内，读一次是本地磁盘 IO；
  // 再往 Cache Storage 抄一份只是白占 30 MB，所以那边直接不缓存。
  if (NATIVE) return Promise.resolve(null);
  if (!cacheP) cacheP = ('caches' in window) ? caches.open(CACHE_NAME) : Promise.resolve(null);
  return cacheP;
}

export async function loadManifest() {
  if (manifest) return manifest;
  manifest = await fetchJSON(DICT_BASE + 'manifest.json');
  return manifest;
}

export function getManifest() { return manifest; }

async function fetchJSON(url) {
  const c = await cache();
  if (c) {
    const hit = await c.match(url);
    if (hit) return hit.json();
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error('fetch failed ' + url);
  if (c) { try { await c.put(url, res.clone()); } catch { /* 配额满了就只走内存 */ } }
  return res.json();
}

/** 词 -> 它所在的分片名。规则必须和 build_dict.py 里的 shard_key 完全一致。 */
export function shardOf(word) {
  const w = (word.toLowerCase() + '__').slice(0, 2);
  return [...w].map((c) => (c >= 'a' && c <= 'z' ? c : '_')).join('');
}

async function loadShard(name) {
  if (mem.has(name)) return mem.get(name);
  if (pending.has(name)) return pending.get(name);
  const p = (async () => {
    let data = {};
    try {
      if (!manifest) await loadManifest();
      if (manifest.shards[name]) data = await fetchJSON(DICT_BASE + name + '.json');
    } catch { data = {}; }   // 拿不到就当这一片是空的，查不到词好过整个页面炸掉
    mem.set(name, data);
    pending.delete(name);
    return data;
  })();
  pending.set(name, p);
  return p;
}

/** 提前把这批词会用到的分片都拉下来，之后 get() 就是纯内存同步操作。 */
export async function ensureWords(words, onProgress) {
  const need = new Set();
  for (const w of words) need.add(shardOf(w));
  return ensureShards(need, onProgress);
}

/** 同上，但直接给分片名。 */
export async function ensureShards(names, onProgress) {
  await loadManifest();
  const list = [...names].filter((s) => !mem.has(s) && manifest.shards[s]);
  let done = 0;
  await pMap(list, 8, async (name) => {
    await loadShard(name);
    if (onProgress) onProgress(++done, list.length);
  });
  return list.length;
}

/** 把整本词典抓进 Cache API，之后彻底离线。用户显式点了才会跑，不偷偷下载。 */
export async function downloadAll(onProgress) {
  await loadManifest();
  const names = Object.keys(manifest.shards);
  let done = 0;
  await pMap(names, 6, async (name) => {
    const url = DICT_BASE + name + '.json';
    const c = await cache();
    if (c && await c.match(url)) { onProgress && onProgress(++done, names.length); return; }
    try {
      const res = await fetch(url);
      if (res.ok && c) await c.put(url, res.clone());
    } catch { /* 断网就下次再说 */ }
    onProgress && onProgress(++done, names.length);
  });
}

export async function downloadedBytes() {
  await loadManifest();
  const c = await cache();
  if (!c) return 0;
  let n = 0;
  for (const [name, info] of Object.entries(manifest.shards)) {
    if (await c.match(DICT_BASE + name + '.json')) n += info.b;
  }
  return n;
}

export async function clearDownload() {
  if ('caches' in window) await caches.delete(CACHE_NAME);
  cacheP = null;
  mem.clear();
}

/** 同步取原始词条。要求所在分片已经通过 ensureWords / lookup 加载过。 */
export function raw(word) {
  const s = mem.get(shardOf(word));
  return s ? s[word] || null : null;
}

/* ---------- 词形归一 ---------- */

const CONTRACTIONS = { "won't": 'will', "shan't": 'shall', "ain't": 'be', "can't": 'can' };

export function normalize(raw) {
  return String(raw).toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z'-]/g, '');
}

/** 一个词可能落在哪些分片里（含各种还原候选），用来提前批量加载。 */
export function candidateShards(surface) {
  const out = new Set();
  for (const c of candidates(surface)) out.add(shardOf(c));
  return out;
}

/**
 * 拆词要用到的分片：后半段（cannot 的 not 在 no 分片里，和 cannot 自己不同片）。
 *
 * 故意不并进 candidateShards —— 那样每个 6 字以上的词都要多拉十来个分片，
 * 等于把整本词典拖下来。正确用法是**只对整词查不到的那几十个词**补这一轮。
 */
export function compoundShards(surface) {
  const w = normalize(surface);
  const out = new Set();
  if (w.length < 6 || w.length > 16 || w.includes("'") || w.includes('-')) return out;
  for (let i = 3; i <= w.length - 3; i++) out.add(shardOf(w.slice(i)));
  return out;
}

/** 从表层词形推出所有值得一试的查询候选，从最可信到最将就。 */
function candidates(surface) {
  const w = normalize(surface);
  const out = [];
  // 允许单字母：I'm 的词干就是 i，它在 i_ 分片里，滤掉就查不着了
  const push = (x) => { if (x && x.length >= 1 && !out.includes(x)) out.push(x); };
  push(w);
  if (CONTRACTIONS[w]) push(CONTRACTIONS[w]);
  if (w.endsWith("'s") || w.endsWith("s'")) push(w.slice(0, -2));   // 所有格：father's → father
  if (w.endsWith("n't")) push(w.slice(0, -3));                       // mustn't → must
  const ap = w.indexOf("'");
  if (ap > 0) push(w.slice(0, ap));                                  // there's → there
  // 规则式后缀还原，只在 ECDICT 里查不到原词时才用得上
  for (const [suf, reps] of [['ies', ['y']], ['es', ['', 'e']], ['s', ['']],
    ['ing', ['', 'e']], ['ed', ['', 'e']], ['er', ['', 'e']], ['est', ['', 'e']], ['ly', ['']]]) {
    if (w.endsWith(suf) && w.length > suf.length + 2) {
      const stem = w.slice(0, -suf.length);
      for (const r of reps) push(stem + r);
      if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) push(stem.slice(0, -1)); // running → run
    }
  }
  return out;
}

/**
 * 查一个词。返回 null 表示查不到。
 *   word       实际命中的词形
 *   entry      它的词条
 *   lemma      原形（可能等于 word）
 *   lemmaEntry 原形的词条
 *   parts      连字符复合词拆开后的各段（father-in-law 这种）
 *
 * ⚠️ 注意 lemma 不一定对：ECDICT 的 exchange 字段本身有数据错误
 * （does→doe 母鹿、also→conjurer 魔术师、some→an）。所以判断难易度时
 * 一律走下面 isSimple 的「并集」逻辑，绝不能把表层词形直接换成原形。
 */
export function get(surface) {
  for (const c of candidates(surface)) {
    const e = raw(c);
    if (e && e.t) return withLemma(c, e);
  }
  // 连字符复合词：整体查不到就拆开，各段都查得到就拼一个合成结果
  const w = normalize(surface);
  if (w.includes('-')) {
    const segs = w.split('-').filter(Boolean);
    const hits = segs.map((s) => {
      for (const c of candidates(s)) { const e = raw(c); if (e && e.t) return { w: c, e }; }
      return null;
    });
    if (hits.length > 1 && hits.every(Boolean)) {
      return {
        word: w,
        entry: { t: hits.map((h) => h.w + '：' + firstLine(h.e.t)).join('\n') },
        lemma: w, lemmaEntry: null,
        parts: hits.map((h) => h.w),
      };
    }
  }

  // 没有连字符的拼接词。ECDICT 里 cannot 既没标签也没词频，收词时被滤掉了，
  // 点它会查不到 —— 这类词拆成两个简单词就讲得通，合成一条给它。
  // 只在整词查不到时才走到这里（能查到的词轮不到拆），所以不会出现
  // therapist 被拆成 the + rapist 那种笑话。两段都必须是简单词。
  const split = splitCompound(w);
  if (split) {
    return {
      word: w,
      entry: { t: split.map((h) => h.w + '：' + firstLine(h.e.t)).join('\n'), g: 'cet4' },
      lemma: w, lemmaEntry: null,
      parts: split.map((h) => h.w),
    };
  }
  return null;
}

/** 拆成两个**简单**词。返回 null 表示拆不开。 */
function splitCompound(w) {
  if (w.length < 6 || w.length > 16 || w.includes("'") || w.includes('-')) return null;
  for (let i = 3; i <= w.length - 3; i++) {
    const a = raw(w.slice(0, i)), b = raw(w.slice(i));
    if (a && b && a.t && b.t && easyEntry(a) && easyEntry(b)) {
      return [{ w: w.slice(0, i), e: a }, { w: w.slice(i), e: b }];
    }
  }
  return null;
}

function easyEntry(e) {
  return EASY_TAGS.test(e.g || '') ||
    (e.f > 0 && e.f <= LEVEL.rank) || (e.n > 0 && e.n <= LEVEL.rank);
}

function withLemma(word, entry) {
  let lemma = word, lemmaEntry = null;
  if (entry.x) {
    const le = raw(entry.x);
    if (le && le.t) { lemma = entry.x; lemmaEntry = le; }
  }
  return { word, entry, lemma, lemmaEntry, parts: null };
}

export function firstLine(t) {
  return String(t || '').split('\n')[0].trim();
}

/* ---------- 难易度 ---------- */

export const TAGMAP = {
  zk: '中考', gk: '高考', cet4: '四级', cet6: '六级', ky: '考研',
  toefl: '托福', ielts: '雅思', gre: 'GRE',
};

/* ---------- 英语水平 ---------- */

// 「哪个词算生词」这件事没有客观答案，它取决于读的人。以前这条线焊死在四级上，
// 等于替所有人做了主：高中生看满屏虚线不敢读，考完 GRE 的人被标出一堆早会的词。
// 所以做成一档一档的，每一档两条判据：
//   tags —— 认为「他已经会了」的考纲标签
//   rank —— 词频排名在这个数以内的一律当认识（词频连续、覆盖全部词，
//            比考纲词表可靠：cannot / center 在 ECDICT 里根本没有标签）
//   wpm  —— 这一档的精读速度，用来估「约 X 分钟」
export const LEVELS = [
  { id: 'zk',   name: '初中',     hint: '中考词汇打底',         tags: ['zk'],                                        rank: 1500,  wpm: 90 },
  { id: 'gk',   name: '高中',     hint: '高考词汇打底',         tags: ['zk', 'gk'],                                  rank: 2200,  wpm: 110 },
  { id: 'cet4', name: '四级',     hint: '大学四级打底',         tags: ['zk', 'gk', 'cet4'],                          rank: 3000,  wpm: 130 },
  { id: 'cet6', name: '六级',     hint: '大学六级打底',         tags: ['zk', 'gk', 'cet4', 'cet6'],                  rank: 4500,  wpm: 150 },
  { id: 'ky',   name: '考研 / 雅思托福', hint: '这三张词表打底', tags: ['zk', 'gk', 'cet4', 'cet6', 'ky', 'toefl', 'ielts'], rank: 7000,  wpm: 170 },
  { id: 'gre',  name: '专八 / GRE', hint: '只标真正生僻的词',   tags: ['zk', 'gk', 'cet4', 'cet6', 'ky', 'toefl', 'ielts', 'gre'], rank: 12000, wpm: 190 },
];

// 默认停在四级：中文用户里这一档人最多，而且宁可多标几个词（多看一眼不亏），
// 也别少标 —— 少标的那个词就是他今晚卡住的地方。
export const DEFAULT_LEVEL = 'cet4';

let LEVEL = null;
let EASY_TAGS = null;

/** 换一档水平。返回这一档的定义，调用方拿它去写文案。 */
export function setLevel(id) {
  LEVEL = LEVELS.find((l) => l.id === id) || LEVELS.find((l) => l.id === DEFAULT_LEVEL);
  EASY_TAGS = new RegExp('\\b(' + LEVEL.tags.join('|') + ')\\b');
  return LEVEL;
}
setLevel(DEFAULT_LEVEL);

export const level = () => LEVEL;

/**
 * ⚠️ 这个函数是整个词汇模式的地基，改之前先读这段。
 *
 * ECDICT 的 exchange 字段有数据错误，会把 always 的原形说成 alway（古体）、
 * does 的说成 doe、also 的说成 conjurer。危害不在释义（点 always 弹出的
 * 仍然是 always 自己），而在**标签会跟着一起丢**：always 本身标着 zk gk，
 * 一旦归并到 alway 就没有任何标签，于是被判成「四级以上生词」排进要背的列表。
 * does / some / also 全是这么混进来的。
 *
 * 修法：判断难易度时取「原词形 ∪ 原形」的并集，任一为简单词就算简单。
 */
// 拟声词和感叹词。它们不是词汇量的一部分，背它没有意义，
// 而 ECDICT 给 huh 的词频排名是 3926（超出「已掌握」线），不特殊处理
// 就会被判成生词，在正文里挂一条虚线。
export const NOISE = new Set([
  'huh', 'hmm', 'hm', 'uh', 'um', 'er', 'ah', 'oh', 'ha', 'hey', 'yeah', 'yep', 'nope',
  'wow', 'ugh', 'eh', 'ow', 'ouch', 'shh', 'psst', 'aha', 'oops', 'hooray', 'alas',
  'whoa', 'yikes', 'phew', 'tsk', 'mmm', 'haha', 'hah', 'heh', 'hmph', 'ahem',
]);

export function isSimple(res) {
  if (!res) return false;
  if (NOISE.has(res.word)) return true;

  const { entry, lemmaEntry } = res;
  // e:1 是构建时打的「由两个简单词拼成」，cannot / somewhere 这类靠它
  if (entry.e || (lemmaEntry && lemmaEntry.e)) return true;
  // ⚠️ 这里的**并集**就是修法本身，见上面那段警告。
  const tags = (entry.g || '') + ' ' + ((lemmaEntry && lemmaEntry.g) || '');
  if (EASY_TAGS.test(tags)) return true;

  const ranks = [entry.f, entry.n, lemmaEntry && lemmaEntry.f, lemmaEntry && lemmaEntry.n]
    .filter((x) => typeof x === 'number' && x > 0);
  if (ranks.length && Math.min(...ranks) <= LEVEL.rank) return true;

  // 缩写和所有格按**词干**判断。ECDICT 给 wouldn't / isn't / one's 这类词条
  // 的是「常用度 5、没有考纲标签、词频排名 0」——三条判据全都落空，
  // 于是满篇的 wouldn't、isn't、I'm 都被标成超纲词，虚线密到没法看。
  // 而它们的词干 would / is / one 明明白白标着 zk gk。
  if (res.word.includes("'")) {
    for (const stem of apostropheStems(res.word)) {
      const e = raw(stem);
      if (e && easyEntry(e)) return true;
    }
  }

  // 常用度顶格的词就是常用词，不必再要求它同时出现在某张考纲词表里
  if ((entry.s || 0) >= 5) return true;

  // cannot / anymore / everyone 这类由两个简单词拼起来的，算简单词
  return !!splitCompound(res.word);
}

function apostropheStems(w) {
  const out = [];
  if (w.endsWith("'s") || w.endsWith("s'")) out.push(w.slice(0, -2));
  if (w.endsWith("n't")) out.push(w.slice(0, -3));
  const ap = w.indexOf("'");
  if (ap > 0) out.push(w.slice(0, ap));
  return out.filter(Boolean);
}

/**
 * 整条释义都在说「这是个名字」的词条 —— ECDICT 里长这样：
 *   Schuster → n. (Schuster)人名；(英、德、匈、捷、瑞典)舒斯特
 * 人名地名不是生词，标出来只是噪音。要求**每一行**都是名字义项，
 * 免得把 China、Turkey 这种既是地名又有普通义的词也误伤了。
 */
export function isProperNoun(entry) {
  const lines = String((entry && entry.t) || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((l) => /(人名|地名|姓氏)/.test(l));
}

/** 阅读时给超纲词加的那条虚线下划线。 */
export function isHard(res) {
  if (!res) return false;
  if (isProperNoun(res.lemmaEntry || res.entry)) return false;
  return !isSimple(res);
}

/** 常用度 ★ —— 只用数值，不出现任何品牌名。 */
export function stars(entry) {
  const s = (entry && entry.s) || 0;
  return s > 0 ? '★'.repeat(s) : '';
}

export function tagsOf(res) {
  if (!res) return [];
  const g = (res.entry.g || '') + ' ' + ((res.lemmaEntry && res.lemmaEntry.g) || '');
  return [...new Set(g.split(/\s+/).filter((t) => TAGMAP[t]))].map((t) => TAGMAP[t]);
}
