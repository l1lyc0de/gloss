// 词汇模式：扫全书词形，算出「今晚这一节的 N 个词」。
//
// 粒度是刻意选的：**不做「这本书的单词表」，做「今晚这一节的 17 个词」。**
// 实测一本社科书每小节首次出现的生词中位数是 17 个，过一遍三到五分钟。
// 流程是连着的：先花三分钟过这一节的词，接着读这一节，刚学的词立刻全部撞见。
//
// 三个好处是同一件事的三个面：时间不够就只做前半段；刚背的词几分钟后在
// 真实语境里遇到，形成背单词 App 给不了的正反馈；它让下一节读起来更容易。
//
// 例句用书里的原句 —— 这是自带全文最大的免费优势。扇贝、墨墨的例句来自
// 不知何处，背完在生活里遇不到；我们的例句是他今晚就要读到的那一句。

import * as dict from './dict.js';
import { WORD_RE, pickSentence } from './text.js';
import { yieldFrame } from './util.js';

// 出现 >= 3 次的算「骨架词」，值得单独标出来。
//
// ⚠️ 这不是节内词表的门槛，别拿它去过滤 bySection。
// 一开始按「>= 3 次」筛节内词表，结果是每节中位数 2 个词 —— 全书核心词
// 总共才一百多个，摊到几十节上当然没剩几个。但产品要的是「今晚这一节的
// 17 个词」：目的是让**今晚这一节**读起来省力，不是攒一辈子的词汇量。
// 只出现一次的词，今晚照样会撞见，先看一眼照样有用。
// 所以节内词表收全部生词，按书内频次降序排 —— 时间不够就只做前半段，
// 排在前面的本来就是最值得学的。
export const CORE_COUNT = 3;

/** 一段里的词，带上「是不是句首」——判断专有名词要靠这个。 */
function tokensOf(text) {
  const out = [];
  let m;
  WORD_RE.lastIndex = 0;
  while ((m = WORD_RE.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 3), m.index);
    // 句首的大写不说明任何问题，句中的大写才是专有名词的信号
    const atSentenceStart = m.index === 0 || /[.!?…"'’”)\]]\s*$/.test(before) || /^\s*$/.test(before);
    out.push({ w: m[0], cap: /^[A-Z]/.test(m[0]), atStart: atSentenceStart });
  }
  return out;
}

/**
 * 扫全书，产出词汇索引。要跑几秒，中途会 yield 让页面保持响应。
 * @returns {{ words: Object, bySection: string[][], stats: Object }}
 */
export async function buildIndex(book, onProgress) {
  const report = (phase, done, total) => onProgress && onProgress(phase, done, total);

  /* 1. 扫词形 */
  const surf = new Map();   // 小写词形 -> {n, midCap, midN, firstSec, firstPara}
  book.sections.forEach((sec, si) => {
    sec.paras.forEach((para, pi) => {
      for (const t of tokensOf(para)) {
        const key = t.w.toLowerCase().replace(/[’]/g, "'");
        let r = surf.get(key);
        if (!r) { r = { n: 0, midCap: 0, midN: 0, firstSec: si, firstPara: pi }; surf.set(key, r); }
        r.n++;
        if (!t.atStart) { r.midN++; if (t.cap) r.midCap++; }
      }
    });
  });
  const forms = [...surf.keys()];
  report('scan', forms.length, forms.length);

  /* 2. 把这些词会用到的词典分片拉下来 */
  const shards = new Set();
  for (const f of forms) { for (const s of dict.candidateShards(f)) shards.add(s); }
  await dict.ensureShards(shards, (d, t) => report('dict', d, t));

  /* 3. 查词 + 归并原形。原形可能来自别的分片，所以要再拉一轮。 */
  const looked = new Map();
  const lemmaNeed = new Set();
  for (let i = 0; i < forms.length; i++) {
    const res = dict.get(forms[i]);
    looked.set(forms[i], res);
    if (res && res.entry.x) lemmaNeed.add(res.entry.x);
    if ((i & 1023) === 0) await yieldFrame();
  }
  // 整词查不到的（几十个），再给它们补一轮拆词要用的分片
  const compound = new Set();
  for (const [f, r] of looked) if (!r) for (const s of dict.compoundShards(f)) compound.add(s);
  await dict.ensureShards(compound);
  await dict.ensureWords([...lemmaNeed], (d, t) => report('dict2', d, t));
  for (const f of forms) {
    const res = dict.get(f);   // 分片补齐后重查一次，这次原形和拆词才认得出来
    looked.set(f, res);
  }

  /* 4. 过滤 + 按原形合并 */
  const merged = new Map();   // 原形 -> {n, forms:Set, firstSec, firstPara}
  let nMerged = 0, nDropped = 0;
  for (const [f, r] of surf) {
    const res = looked.get(f);
    if (!res) { nDropped++; continue; }                                  // 词典里查不到，教不了
    nMerged++;
    if (f.includes("'")) { nDropped++; continue; }                        // 缩写和所有格
    if (dict.NOISE.has(f)) { nDropped++; continue; }                      // 拟声词、感叹词
    if (r.midN >= 1 && r.midCap / r.midN > 0.9) { nDropped++; continue; } // 专有名词
    // 难易度：一律走并集判断，绝不能拿原形去顶替原词形 —— 见 dict.js 里那段警告
    if (dict.isSimple(res)) { nDropped++; continue; }

    const key = res.lemmaEntry ? res.lemma : res.word;
    let m = merged.get(key);
    if (!m) { m = { n: 0, forms: new Set(), firstSec: r.firstSec, firstPara: r.firstPara }; merged.set(key, m); }
    m.n += r.n;
    m.forms.add(f);
    if (r.firstSec < m.firstSec || (r.firstSec === m.firstSec && r.firstPara < m.firstPara)) {
      m.firstSec = r.firstSec;
      m.firstPara = r.firstPara;
    }
  }

  /* 5. 生词落到它第一次出现的那一节；例句也从那一节里挑 */
  const words = {};
  const bySection = book.sections.map(() => []);
  let nCore = 0;
  for (const [key, m] of merged) {
    const res = dict.get(key);
    if (!res) continue;
    if (m.n >= CORE_COUNT) nCore++;
    words[key] = {
      w: key,
      n: m.n,
      core: m.n >= CORE_COUNT,
      sec: m.firstSec,
      p: res.entry.p || (res.lemmaEntry && res.lemmaEntry.p) || '',
      t: (res.lemmaEntry || res.entry).t || '',
      tags: dict.tagsOf(res),
      stars: dict.stars(res.lemmaEntry || res.entry),
      eg: exampleFor(book, m),
    };
    bySection[m.firstSec].push(key);
  }
  // ⚠️ 频次**不设上限**。高频词恰恰是全书的概念骨架：实测一本阿德勒心理学的书
  // Top 5 是 interpersonal(147) inferiority(94) superiority(40) self-acceptance(25)
  // trauma(23)，正是它的核心概念。一个词出现 147 次，学一次回本 147 次；
  // 只出现一次的学了再也遇不到。设上限会砍掉最该学的那几个。
  // 所以这里按频次降序排 —— 这个顺序本身就是学习顺序。
  for (const list of bySection) list.sort((a, b) => words[b].n - words[a].n);

  return {
    words,
    bySection,
    stats: {
      forms: forms.length,
      merged: nMerged,
      candidates: merged.size,
      core: nCore,
      dropped: nDropped,
    },
  };
}

/** 例句：它第一次出现的那一节里，含这个词的最短的一句。 */
function exampleFor(book, m) {
  const sec = book.sections[m.firstSec];
  if (!sec) return '';
  let best = '';
  for (const form of m.forms) {
    for (const para of sec.paras) {
      const s = pickSentence(para, form);
      if (s && (!best || s.length < best.length)) best = s;
    }
  }
  return best;
}

/** 这一节今晚要过的词。 */
export function wordsForSection(index, si) {
  if (!index || !index.bySection[si]) return [];
  return index.bySection[si].map((k) => index.words[k]).filter(Boolean);
}

/** 三分钟一个词左右，取整到分钟，用来在主按钮上写「约 X 分钟」。 */
export function estimateMinutes(nWords, nBookWords) {
  const wordMin = nWords * 0.2;                 // 过一个词约 12 秒
  const readMin = nBookWords / dict.level().wpm; // 精读速度按他选的水平算
  return Math.max(1, Math.round(wordMin + readMin));
}
