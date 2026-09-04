// PDF 导入。
//
// PDF 不是文档格式，是**打印指令格式**——它只记录「在坐标 (x,y) 画字符 A」，
// 段落和章节的概念根本不存在，得靠启发式猜回来。而它的失败方式是**静默的**：
// 字体缺 ToUnicode 表时抽出来是乱码，但程序不会报错，只会安静地生成一本
// 看起来像那么回事的垃圾书。
//
// 所以这里的分工是：
//   程序只判断一件事 —— 有没有文字层（getTextContent 返回 0 项就是扫描件，直接拒绝）；
//   页眉页脚、连字符、ligature 这些确定性的脏活照做；
//   剩下的「这本书抽得对不对」交给预览页让人眼看。
// 人眼判断这个是零成本、零误判的，比一堆启发式规则准得多。

import { normalizeText, joinLines } from './text.js';

let pdfjsP = null;
function pdfjs() {
  if (!pdfjsP) {
    pdfjsP = import('/vendor/pdf.min.mjs').then((m) => {
      m.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
      return m;
    });
  }
  return pdfjsP;
}

const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};
const quantile = (a, q) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};

/** pdf.js 给的是一堆带坐标的碎片，先按 y 归成行，再按 x 拼成文字。 */
function itemsToLines(items, viewport) {
  const raw = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const t = it.transform;
    raw.push({
      x: t[4],
      y: t[5],
      w: it.width || 0,
      fs: Math.abs(t[3]) || it.height || 10,
      s: it.str,
    });
  }
  if (!raw.length) return [];
  const tol = Math.max(1.5, median(raw.map((r) => r.fs)) * 0.5);
  raw.sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const lines = [];
  let cur = null;
  for (const r of raw) {
    if (!cur || Math.abs(cur.y - r.y) > tol) {
      cur = { y: r.y, parts: [r], fs: r.fs };
      lines.push(cur);
    } else {
      cur.parts.push(r);
      cur.fs = Math.max(cur.fs, r.fs);
    }
  }
  return lines.map((ln) => {
    ln.parts.sort((a, b) => a.x - b.x);
    let text = '';
    let prevRight = null;
    for (const p of ln.parts) {
      if (prevRight != null) {
        const gap = p.x - prevRight;
        const charW = p.w && p.s.length ? p.w / p.s.length : p.fs * 0.5;
        // pdf.js 有时把词间空格丢掉，只留下坐标上的空隙，得自己补回来
        if (gap > charW * 0.28 && !/\s$/.test(text) && !/^\s/.test(p.s)) text += ' ';
      }
      text += p.s;
      prevRight = p.x + p.w;
    }
    const left = ln.parts[0].x;
    const right = prevRight;
    return {
      text: normalizeText(text),
      x: left,
      right,
      y: ln.y,
      fs: ln.fs,
      pageW: viewport.width,
    };
  }).filter((l) => l.text);
}

/** 页眉页脚：同一位置反复出现的那一行。归一化时把数字抹成 #，页码才认得出来。 */
function headerFooterKeys(pages) {
  const count = new Map();
  const bump = (k) => count.set(k, (count.get(k) || 0) + 1);
  const norm = (t) => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  for (const lines of pages) {
    if (lines.length < 3) continue;
    for (const ln of lines.slice(0, 2)) bump('T|' + norm(ln.text));
    for (const ln of lines.slice(-2)) bump('B|' + norm(ln.text));
  }
  const threshold = Math.max(3, Math.floor(pages.length * 0.3));
  const drop = new Set();
  for (const [k, n] of count) {
    const body = k.slice(2);
    if (n >= threshold && body.length > 0 && body.length < 100) drop.add(k);
  }
  return { drop, norm };
}

const BINS = 128;   // 中缝往往只有页宽的 4~5%，分辨率低了就被抹平了

/**
 * 双栏检测：找版心中间那条**没有字的竖直空档**（gutter）。
 *
 * ⚠️ 不能用「行首 x 分两簇」来判断 —— 双栏排版里左右两栏的行 y 坐标是一样的，
 * 归行的时候就已经被并成一行了，行首 x 永远只剩左栏那一个值，看不出两簇。
 * （这个「左右串成一句」正是双栏抽出来读不通的原因本身。）
 * 所以必须在归行**之前**、直接在字符碎片的横向覆盖上做判断。
 *
 * 只作为预览页上的提示，不拦人 —— 双栏书本来就不在我们支持的范围里，
 * 读不通就换书，这个判断交给人眼最省事。
 */
function looksTwoColumn(cov) {
  const max = Math.max(...cov);
  if (max <= 0) return false;
  const lo = Math.floor(BINS * 0.2), hi = Math.ceil(BINS * 0.8);

  // 判据是「相对落差」而不是「绝对空」：单栏正文的覆盖是从左到右缓慢下滑的
  // （每段最后一行短，越靠右的位置被覆盖到的次数越少），实测中段大约在
  // 中位数的 85%；双栏的中缝则直接掉到 0。用中位数比一个绝对阈值稳得多。
  const interior = [...cov].slice(lo, hi).sort((a, b) => a - b);
  const mid = interior[interior.length >> 1];
  if (!mid) return false;

  let min = Infinity, at = -1;
  for (let i = lo; i < hi; i++) if (cov[i] < min) { min = cov[i]; at = i; }
  if (min > mid * 0.25) return false;

  // 两侧都得是实打实的正文，否则那只是页边距或者一张插图
  const mean = (a, b) => {
    let n = 0;
    for (let i = a; i < b; i++) n += cov[i];
    return b > a ? n / (b - a) : 0;
  };
  return mean(0, at) > max * 0.25 && mean(at + 1, BINS) > max * 0.25;
}

/** 行 → 段落。这是 PDF 路径上最容易出错的一步，判据都写在下面。 */
function linesToParagraphs(all) {
  if (!all.length) return { paras: [], bodyFs: 12 };

  const gaps = [];
  for (let i = 1; i < all.length; i++) {
    if (all[i].page === all[i - 1].page) {
      const g = all[i - 1].y - all[i].y;
      if (g > 0 && g < 200) gaps.push(g);
    }
  }
  const medGap = median(gaps) || 14;
  const bodyLeft = quantile(all.map((l) => l.x), 0.25);
  const medRight = median(all.map((l) => l.right));
  const bodyFs = median(all.map((l) => l.fs)) || 12;
  const colWidth = Math.max(50, medRight - bodyLeft);

  const paras = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.lines.length) paras.push({ text: joinLines(cur.lines), fs: cur.fs, isHead: cur.isHead });
    cur = null;
  };

  for (let i = 0; i < all.length; i++) {
    const ln = all[i];
    const prev = i > 0 ? all[i - 1] : null;
    // 标题行：明显比正文大的一小段，拿来当章节名
    const isHead = ln.fs > bodyFs * 1.18 && ln.text.length < 80;

    let brk = !prev || isHead || (cur && cur.isHead);
    if (!brk && prev) {
      if (prev.page === ln.page) {
        const gap = prev.y - ln.y;
        if (gap > medGap * 1.55) brk = true;                       // 段间距明显变大
        if (ln.x > bodyLeft + Math.max(6, colWidth * 0.025)) brk = true;  // 首行缩进
      }
      // 上一行没排满又以句号收尾 → 那是段落的最后一行（跨页也成立）
      if (!brk && prev.right < medRight - colWidth * 0.12 && /[.!?"’”)]$/.test(prev.text)) brk = true;
    }
    if (brk) flush();
    if (!cur) cur = { lines: [], fs: ln.fs, isHead };
    cur.lines.push(ln.text);
  }
  flush();
  return { paras, bodyFs };
}

export async function parsePdf(arrayBuffer, fileName, onProgress) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(arrayBuffer), isEvalSupported: false }).promise;
  const nPages = doc.numPages;

  const pages = [];
  const cov = new Float64Array(BINS);   // 全书字符在横向上的覆盖，用来找双栏的中缝
  let emptyPages = 0;
  for (let p = 1; p <= nPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = it.transform[5];
      // 只统计版心：居中的页眉页码横跨整页，正好压在双栏的中缝上，
      // 算进来会把那条空档填平，双栏就检不出来了。
      if (y > viewport.height * 0.88 || y < viewport.height * 0.12) continue;
      const x0 = it.transform[4], x1 = x0 + (it.width || 0);
      const b0 = Math.max(0, Math.min(BINS - 1, Math.floor((x0 / viewport.width) * BINS)));
      const b1 = Math.max(0, Math.min(BINS - 1, Math.floor((x1 / viewport.width) * BINS)));
      for (let b = b0; b <= b1; b++) cov[b] += 1;
    }
    const lines = itemsToLines(tc.items, viewport);
    // ⚠️ 这就是唯一需要程序判断的那件事：有没有文字层。
    if (!tc.items.length || lines.join('').length < 20) emptyPages++;
    pages.push(lines);
    page.cleanup();
    if (onProgress) onProgress(p, nPages);
  }

  // 扫描件没有文字层，抽出来必然是空的。直接拒绝，不硬着头皮往下走：
  // 支持一种烂 PDF 的成本是无底洞，拒绝的成本是常数，而被拒的用户
  // 去找一个 EPUB 版基本都能找到，那条路我们走得又稳又好。
  if (emptyPages >= nPages * 0.8) {
    const e = new Error('这份 PDF 没有文字层，是扫描出来的图片，取不出任何文字。');
    e.scanned = true;
    throw e;
  }

  const { drop, norm } = headerFooterKeys(pages);
  const all = [];
  for (let i = 0; i < pages.length; i++) {
    const lines = pages[i];
    lines.forEach((ln, k) => {
      const top = k < 2, bot = k >= lines.length - 2;
      if (lines.length >= 3) {
        if (top && drop.has('T|' + norm(ln.text))) return;
        if (bot && drop.has('B|' + norm(ln.text))) return;
        if ((top || bot) && /^[\divxlcIVXLC—\-—.\s]{1,12}$/.test(ln.text)) return;  // 光秃秃的页码
      }
      all.push({ ...ln, page: i });
    });
  }

  const { paras } = linesToParagraphs(all);

  // 标题行开一个新章；一本 PDF 检不出任何标题就整本当一章，交给字数分节
  const chapters = [];
  let cur = null;
  for (const p of paras) {
    const t = p.text.trim();
    if (!t) continue;
    if (p.isHead) {
      cur = { title: t.slice(0, 80), paras: [] };
      chapters.push(cur);
    } else {
      if (!cur) { cur = { title: '正文', paras: [] }; chapters.push(cur); }
      cur.paras.push(t);
    }
  }
  const kept = chapters.filter((c) => c.paras.length);
  if (!kept.length) throw new Error('这份 PDF 里抽不出成段的正文');

  const flags = [];
  if (looksTwoColumn(cov)) {
    flags.push({
      level: 'warn',
      text: '这份 PDF 看起来是双栏排版。双栏抽出来的句子常常左右两栏串在一起，' +
            '请在下面的预览里重点确认句子是不是连贯的。',
    });
  }
  const letters = paras.reduce((n, p) => n + (p.text.match(/[A-Za-z]/g) || []).length, 0);
  const total = paras.reduce((n, p) => n + p.text.length, 0);
  if (total > 0 && letters / total < 0.55) {
    flags.push({
      level: 'warn',
      text: '抽出来的内容里字母占比偏低，可能是字体缺 ToUnicode 表导致的乱码。' +
            '如果下面预览是一堆认不出的字符，建议换一个 EPUB 版本。',
    });
  }

  const title = (await doc.getMetadata().catch(() => null))?.info?.Title;
  const author = (await doc.getMetadata().catch(() => null))?.info?.Author;
  await doc.destroy();

  return {
    title: normalizeText(title || '') || fileName.replace(/\.pdf$/i, ''),
    author: normalizeText(author || ''),
    chapters: kept,
    flags,
  };
}
