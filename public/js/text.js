// 文本清洗与分节。EPUB 和 PDF 两条路最后都汇到这里。

// 连字（ligature）：PDF 里 fi/fl 常常是单个字形，抽出来是 ﬁ 而不是 f+i，
// 不还原的话 "difficult" 会变成查不到的 "diﬃcult"。
const LIGATURES = {
  'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬀ': 'ff', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'ft', 'ﬆ': 'st',
  'Ĳ': 'IJ', 'ĳ': 'ij', 'œ': 'oe', 'Œ': 'OE', 'æ': 'ae', 'Æ': 'AE',
};

export function normalizeText(s) {
  return String(s)
    .replace(/[ﬁﬂﬀﬃﬄﬅﬆĲĳœŒæÆ]/g, (c) => LIGATURES[c] || c)
    .replace(/­/g, '')                    // 软连字符，只是排版提示，删掉
    .replace(/[‐‑]/g, '-')           // 各种连字符统一成 ASCII 的
    .replace(/[‘’‛]/g, '’')
    .replace(/[“”]/g, '"')
    .replace(/…/g, '…')
    .replace(/ﬀ/g, 'ff')
    .replace(/ /g, ' ')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** 拼接续行：行末连字符要接回去，别的用空格连。 */
export function joinLines(lines) {
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i].trim();
    if (!cur) continue;
    if (!out) { out = cur; continue; }
    if (/[-‐‑]$/.test(out) && /^[a-z]/.test(cur)) {
      out = out.replace(/[-‐‑]$/, '') + cur;   // inter-\npersonal → interpersonal
    } else {
      out += ' ' + cur;
    }
  }
  return out;
}

export const WORD_RE = /[A-Za-z]+(?:[’'-][A-Za-z]+)*/g;

/** 英文词数。用来估阅读时间、算生词密度——凡是和「学英语」有关的都用它。 */
export function countWords(s) {
  const m = String(s).match(WORD_RE);
  return m ? m.length : 0;
}

// 中日韩统一表意文字 + 假名 + 谚文
const CJK_RE = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/g;

/**
 * 「这段文字有多少内容」——分节和「短到可以丢掉」都必须用它，不能用 countWords。
 *
 * ⚠️ 这是一个真出过事的坑：原来分节直接拿 countWords 判断章节长短，
 * 于是中文（以及任何非拉丁文字）的章节一律算 0 词，被当成版权页整章丢掉。
 * 实测一本 72 章的中文 EPUB 导进来只剩 1 节 —— 表现就是「只能导入第一页」，
 * 而且不报任何错。
 *
 * 一个汉字的阅读时间大约相当于 0.6 个英文词，按这个折算成统一的体量。
 */
export function textWeight(s) {
  const str = String(s);
  const en = (str.match(WORD_RE) || []).length;
  const cjk = (str.match(CJK_RE) || []).length;
  return en + cjk * 0.6;
}

/** 断句。用于挑例句和查词时截取上下文。 */
export function sentences(text) {
  const out = [];
  const re = /[^.!?…]+[.!?…]+["'’”)\]]*|[^.!?…]+$/g;
  let m;
  while ((m = re.exec(text))) {
    const s = m[0].trim();
    if (s) out.push(s);
  }
  return out.length ? out : [text.trim()];
}

/** 含该词的句子里挑最短的那句——最短通常也最好懂，当例句正好。 */
export function pickSentence(text, word, max = 240) {
  const re = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
  let best = null;
  for (const s of sentences(text)) {
    if (!re.test(s)) continue;
    if (!best || s.length < best.length) best = s;
  }
  if (!best) return '';
  return best.length > max ? best.slice(0, max).trim() + '…' : best;
}

const TARGET_WORDS = 900;   // 一节大约读五到八分钟，正好是碎片时间的长度
const MIN_TAIL = 320;       // 尾巴太短就并回上一节，别留个只有两段的零头

/**
 * 把章节切成「节」。粒度是刻意选的：产品的单位是「今晚这一节」，
 * 不是「这本书」——目标是每次打开都有个能读完的东西。
 *
 * @param chapters [{title, paras:[string]}]
 * @returns [{title, chapter, paras:[string], words}]
 */
export function makeSections(chapters, target = TARGET_WORDS) {
  const secs = [];
  for (const ch of chapters) {
    const paras = ch.paras.filter((p) => p && p.trim());
    if (!paras.length) continue;
    // 用体量而不是英文词数判断，否则整章非拉丁文字的内容会被当成版权页丢掉
    if (paras.reduce((n, p) => n + textWeight(p), 0) < 20) continue;

    const pieces = [];
    let cur = [], curW = 0;
    for (const p of paras) {
      cur.push(p);
      curW += textWeight(p);
      if (curW >= target) { pieces.push({ paras: cur }); cur = []; curW = 0; }
    }
    if (cur.length) {
      if (pieces.length && curW < MIN_TAIL) {
        pieces[pieces.length - 1].paras.push(...cur);   // 尾巴太短就并回上一节
      } else {
        pieces.push({ paras: cur });
      }
    }
    pieces.forEach((pc, i) => {
      secs.push({
        title: pieces.length > 1 ? `${ch.title}（${i + 1}/${pieces.length}）` : ch.title,
        chapter: ch.title,
        paras: pc.paras,
        // words 一律是**英文词数**：它只拿来估阅读时间和显示，分节靠的是上面的体量
        words: pc.paras.reduce((n, p) => n + countWords(p), 0),
      });
    });
  }
  return secs;
}

/** 英文占比。太低说明这份文档不是英文的，查词帮不上忙，该在预览页说清楚。 */
export function englishRatio(sections) {
  let en = 0, w = 0;
  for (const s of sections) {
    for (const p of s.paras) { en += countWords(p); w += textWeight(p); }
  }
  return w > 0 ? en / w : 0;
}
