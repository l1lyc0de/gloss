// 划线与笔记（界面上叫「摘录」）。
//
// 定位：读书时**第二类**收集动作。第一类是点一个词收进生词本，
// 这一类是划一段话、并且可以写一句自己的话。两者的性质一样 ——
// 都是「以后还想再看到」，所以都跟着进度走 localStorage + 同步码，
// 而不是跟着正文进 IndexedDB（正文丢了重新导一次就有，划的线丢了就真没了）。
//
// ---- 锚点为什么是「段序号 + 字符偏移」----
//
// 正文不存 HTML，只存段落纯文本；同一个文件导入两次，切出来的段落是一样的。
// 所以一条划线记 {p, s, e} 就够复原，不需要 XPath 那一套脆弱的 DOM 路径。
// 另外把划中的原文一起存下来（text），有两个用处：
//   1. 摘录列表不用把整本书读回来就能显示；
//   2. 万一偏移对不上（换了个版本的同一本书），还能靠文本回找。
//
// ---- 边界一律吸附到整词 ----
//
// 手指拖出来的选区常常停在半个单词上。不吸附的话，<mark> 会切进 <w> 里，
// 一个词被拆成两半 —— 点一下就出释义的核心体验当场破功。
// 所以起点往左吸到词头、终点往右吸到词尾，和 Kindle 的做法一致。

import { S, save, touchDay } from './store.js';
import { WORD_RE } from './text.js';

/** 一条笔记最多存这么多字。理由不是屏幕，是同步：整个 S 要塞进一个
 *  256 KB 的请求体（server.js 的 MAX_BODY），不设上限的话，
 *  某一天备份会毫无征兆地开始失败。 */
export const NOTE_MAX = 1000;

let seq = 0;
function uid() {
  // 不用 crypto.randomUUID：APK 里的 WebView 版本无法预期（见 app.css 里同样的顾虑）。
  seq += 1;
  return Date.now().toString(36) + '-' + seq.toString(36) + '-' +
    Math.floor(Math.random() * 1e6).toString(36);
}

/* ---------- 读 ---------- */

/** 这一节里的划线，按段落分好组：{ [段序号]: [{gid, s, e, note}] }，段内按起点排序。 */
export function bySection(bookId, si) {
  const out = {};
  for (const gid of Object.keys(S.hl)) {
    const g = S.hl[gid];
    if (g.book !== bookId || g.sec !== si) continue;
    for (const part of g.parts) {
      (out[part.p] = out[part.p] || []).push({ gid, s: part.s, e: part.e, note: g.note });
    }
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.s - b.s);
  return out;
}

/** 某本书（不传就是全部）的摘录，新的在前。 */
export function list(bookId) {
  return Object.keys(S.hl)
    .filter((gid) => !bookId || S.hl[gid].book === bookId)
    .map((gid) => ({ gid, ...S.hl[gid] }))
    .sort((a, b) => b.ts - a.ts);
}

export function get(gid) { return S.hl[gid] || null; }

export function count(bookId) {
  return Object.keys(S.hl).filter((gid) => !bookId || S.hl[gid].book === bookId).length;
}

/** 一条摘录显示成一行时的文字。跨段的用空格接起来。 */
export function textOf(g) {
  return g.parts.map((p) => p.t).join(' ');
}

/* ---------- 写 ---------- */

/**
 * 存一条划线。parts 是 [{p, s, e, t}]，跨段选中就是多段 ——
 * 但它们是**一条**摘录：列表里显示成一条，删也是一起删。
 * 分成多条的话，删一半留一半，正文里就会出现半截线。
 */
export function add(bookId, si, parts) {
  if (!parts.length) return null;
  const gid = uid();
  S.hl[gid] = { book: bookId, sec: si, parts, note: '', ts: Date.now() };
  touchDay();
  save();
  return gid;
}

export function remove(gid) {
  if (!S.hl[gid]) return false;
  delete S.hl[gid];
  save();
  return true;
}

export function setNote(gid, note) {
  const g = S.hl[gid];
  if (!g) return false;
  g.note = String(note || '').slice(0, NOTE_MAX);
  touchDay();
  save();
  return true;
}

/* ---------- 选区 → 锚点 ---------- */

/**
 * range 的端点在 el 的纯文本里是第几个字符。
 * el.textContent 和存下来的段落原文是同一串 —— 正文里除了 <w> 和 <mark>
 * 没有别的元素，两者都不贡献文本。
 */
export function offsetIn(el, node, nodeOffset) {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  let n = 0;
  let t;
  while ((t = walk.nextNode())) {
    if (t === node) return n + nodeOffset;
    n += t.nodeValue.length;
  }
  // 端点落在元素上（选区停在 <w> 边界时会这样）：数到那个元素之前为止
  const r = document.createRange();
  r.selectNodeContents(el);
  try { r.setEnd(node, nodeOffset); } catch { return n; }
  return r.toString().length;
}

/** 把 [a, b) 吸附到整词，并去掉两端空白。返回 null 表示这段选区没内容。 */
export function snap(text, a, b) {
  let s = Math.max(0, Math.min(a, b));
  let e = Math.min(text.length, Math.max(a, b));
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(text))) {
    const ws = m.index;
    const we = m.index + m[0].length;
    if (s > ws && s < we) s = ws;      // 起点落在词中间 → 退到词头
    if (e > ws && e < we) e = we;      // 终点落在词中间 → 推到词尾
    if (ws >= e) break;
  }
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  return e > s ? { s, e } : null;
}

/** 这一段里和 [s, e) 有交叠的划线，返回它们的 gid（去重）。 */
export function overlapping(bookId, si, p, s, e) {
  const hit = [];
  for (const gid of Object.keys(S.hl)) {
    const g = S.hl[gid];
    if (g.book !== bookId || g.sec !== si) continue;
    for (const part of g.parts) {
      if (part.p === p && part.s < e && s < part.e) { hit.push(gid); break; }
    }
  }
  return hit;
}
