// HTML/XHTML → 段落。EPUB、网页、docx 三条路都用这一份。

import { normalizeText } from './text.js';

// 块级标签。**必须包含 div/section 这些容器**：用 <div> 当段落的 EPUB 和网页
// 一点都不少见，只认 <p> 的话那种文档会一段正文都抽不出来。
export const BLOCK = 'p, div, section, article, li, blockquote, pre, center, dd, dt, td,' +
  ' figcaption, h1, h2, h3, h4, h5, h6';

const JUNK = 'script, style, nav, svg, figure, table, sup.footnote, aside, header, footer, noscript';

export function blocksFrom(doc) {
  doc.querySelectorAll(JUNK).forEach((n) => n.remove());
  const body = doc.body || doc.documentElement;
  if (!body) return [];

  // 只取「叶子块」：自己是块级、里面又不再套块级的元素。<div><p>…</p></div>
  // 这样只会取到里层那个 p，不会把同一段文字重复算两遍。
  const out = [];
  for (const n of body.querySelectorAll(BLOCK)) {
    if (n.querySelector(BLOCK)) continue;
    const t = normalizeText((n.textContent || '').replace(/\s+/g, ' '));
    if (t) out.push(t);
  }

  // 兜底：如果叶子块加起来还不到正文的六成，说明这份文档的结构我们没看懂
  // （比如文字直接裸在 div 里、和块级子元素混排）。这时按空行切原始文本，
  // 宁可段落分得糙一点，也不能悄悄少掉大半篇内容。
  const full = normalizeText((body.textContent || '').replace(/[ \t]+/g, ' '));
  const got = out.join('').replace(/\s/g, '').length;
  const want = full.replace(/\s/g, '').length;
  if (want > 0 && got < want * 0.6) {
    const split = splitPlain(full);
    if (split.length > out.length) return split;
    if (!out.length && full.trim()) return [full.replace(/\s+/g, ' ').trim()];
  }
  return out;
}

/** 纯文本切段：先按空行，没有空行就按单换行。 */
export function splitPlain(text) {
  const t = String(text).replace(/\r\n?/g, '\n');
  let parts = t.split(/\n[ \t]*\n+/);
  if (parts.length < 3) parts = t.split(/\n/);   // 没有空行的文档，只能按行切
  return parts.map((s) => normalizeText(s.replace(/\s+/g, ' '))).filter(Boolean);
}

export function titleFrom(doc, fallback) {
  for (const sel of ['h1', 'h2', 'h3', 'title']) {
    const el = doc.querySelector(sel);
    const t = el && normalizeText(el.textContent || '');
    if (t && t.length < 120) return t;
  }
  return fallback;
}
