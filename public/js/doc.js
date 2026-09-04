// 纯文本 / Markdown / HTML / Word 文档的导入。
//
// 为什么不止收「书」：真正要解决的是「读英文读不下去」，而挡在人前面的
// 不只有原版书 —— 英文合同、说明书、论文、邮件、网页文章，一样是一屏生词。
// 这些格式都是拿到文字就完事，比 PDF 那条路简单得多，没有理由不支持。

import { normalizeText } from './text.js';
import { blocksFrom, splitPlain, titleFrom } from './html.js';

const parser = new DOMParser();

/* ---------- 纯文本 / Markdown ---------- */

// 像标题的行：编号条款（合同、法规）、全大写的短行、Markdown 的 #
const NUMBERED = /^\s*(?:(?:Article|Section|Chapter|Clause|Part|Appendix|Schedule|Exhibit)\b|\d+(?:\.\d+)*[.)、]?\s|[IVXLC]+[.)]\s|[（(]?[一二三四五六七八九十]+[)）、.]\s)/i;

function looksLikeHeading(line) {
  const t = line.trim();
  if (!t || t.length > 90) return false;
  if (/^#{1,6}\s/.test(t)) return true;
  if (NUMBERED.test(t)) return true;
  // 全大写而且不带句末标点的短行
  if (t.length < 70 && t === t.toUpperCase() && /[A-Z]/.test(t) && !/[.!?;:,]$/.test(t)) return true;
  return false;
}

function stripMd(s) {
  return s
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')          // 图片
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')       // 链接留文字
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .trim();
}

/**
 * 把一串段落按「像标题的行」切成章。切不出来就整篇一章，
 * 交给 makeSections 按体量分节 —— 那条路总是走得通的。
 */
function chapterize(paras, fallbackTitle) {
  const chapters = [];
  let cur = null;
  for (const raw of paras) {
    const p = raw.trim();
    if (!p) continue;
    if (looksLikeHeading(p)) {
      cur = { title: stripMd(p).slice(0, 90) || fallbackTitle, paras: [] };
      chapters.push(cur);
      continue;
    }
    if (!cur) { cur = { title: fallbackTitle, paras: [] }; chapters.push(cur); }
    cur.paras.push(stripMd(p));
  }
  const kept = chapters.filter((c) => c.paras.length);
  return kept.length ? kept : [{ title: fallbackTitle, paras: paras.map(stripMd).filter(Boolean) }];
}

export function parseTextDoc(text, fileName) {
  const clean = normalizeText(String(text).replace(/\r\n?/g, '\n'));
  if (!clean.trim()) throw new Error('这份文档是空的');
  const paras = splitPlain(clean);
  const base = (fileName || '').replace(/\.(txt|md|markdown|text)$/i, '') || '未命名文档';
  // 第一行如果像个标题，就拿它当文档名
  const first = paras[0] || '';
  const title = (first.length < 90 && paras.length > 1) ? stripMd(first) : base;
  return { title: title || base, author: '', chapters: chapterize(paras, base), flags: [] };
}

/* ---------- HTML ---------- */

export function parseHtmlDoc(html, fileName) {
  const doc = parser.parseFromString(String(html), 'text/html');
  const paras = blocksFrom(doc);
  if (!paras.length) throw new Error('这个网页里抽不出正文');
  const base = (fileName || '').replace(/\.(html?|xhtml)$/i, '') || '未命名文档';
  const title = titleFrom(doc, base);
  const body = paras[0] === title ? paras.slice(1) : paras;
  return { title, author: '', chapters: chapterize(body, title), flags: [] };
}

/* ---------- Word (.docx) ---------- */

function unzip(buf) {
  return new Promise((resolve, reject) => {
    fflate.unzip(new Uint8Array(buf), (err, files) => (err ? reject(err) : resolve(files)));
  });
}

export async function parseDocx(arrayBuffer, fileName) {
  let files;
  try {
    files = await unzip(arrayBuffer);
  } catch {
    throw new Error('这个 .docx 打不开，可能是旧版 .doc 格式——用 Word 另存为 .docx 再试');
  }
  const key = Object.keys(files).find((k) => k.toLowerCase() === 'word/document.xml');
  if (!key) throw new Error('这不像是一个 Word 文档（缺 word/document.xml）');

  const xml = new TextDecoder('utf-8').decode(files[key]);
  const doc = parser.parseFromString(xml, 'application/xml');
  // docx 全篇带 w: 前缀，一律按 localName 取
  const all = [...doc.getElementsByTagName('*')];

  const paras = [];
  for (const p of all.filter((e) => e.localName === 'p')) {
    let s = '';
    for (const n of p.getElementsByTagName('*')) {
      if (n.localName === 't') s += n.textContent || '';
      else if (n.localName === 'tab') s += ' ';
      else if (n.localName === 'br') s += ' ';
    }
    // 标题样式（Heading1 之类）在 pStyle 里，拿来当章节名比猜格式准
    const style = p.getElementsByTagName('*');
    let heading = false;
    for (const n of style) {
      if (n.localName === 'pStyle') {
        const v = n.getAttribute('w:val') || n.getAttribute('val') || '';
        if (/^heading|^Title$/i.test(v)) heading = true;
      }
    }
    const t = normalizeText(s.replace(/\s+/g, ' '));
    if (t) paras.push(heading ? '# ' + t : t);   // 用 md 的 # 标一下，chapterize 认得
  }
  if (!paras.length) throw new Error('这个 Word 文档里抽不出正文');

  const base = (fileName || '').replace(/\.docx$/i, '') || '未命名文档';
  const first = stripMd(paras[0] || '');
  const title = (first && first.length < 90 && paras.length > 1) ? first : base;
  return { title, author: '', chapters: chapterize(paras, base), flags: [] };
}
