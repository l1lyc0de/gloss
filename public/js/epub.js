// EPUB 导入。一等公民，处理可靠。
//
// EPUB 本质就是一个 zip 里装着 XHTML，段落和章节都是显式标出来的 ——
// 不像 PDF 要靠坐标猜。所以这条路几乎不会出错，用户拿不准的书
// 一律建议他去找 EPUB 版。
//
// spine 是「文件在书里的排列顺序」，不是「目录」，更不是「正文从哪开始」。
// 这三件事 EPUB 规范里分别有地方写：
//
//   目录       nav[epub:type=toc]（EPUB3） / toc.ncx 的 navMap（EPUB2）
//   正文起点   nav[epub:type=landmarks] 里的 bodymatter（EPUB3）
//              / <guide><reference type="text">（EPUB2）
//   每节性质   文档自己身上的 epub:type（frontmatter / copyright-page / …）
//
// 不读这三处，spine 头几项就是封面、版权页、致谢、目录 —— 打开一本书
// 第一屏是出版说明，这是实测中最伤的体验问题。下面全部按规范读，
// 读不到才退回启发式。

import { normalizeText, FRONT_RE, BACK_RE } from './text.js';
import { blocksFrom, titleFrom } from './html.js';

const parser = new DOMParser();
const OPS_NS = 'http://www.idpf.org/2007/ops';

function unzip(buf) {
  return new Promise((resolve, reject) => {
    fflate.unzip(new Uint8Array(buf), (err, files) => (err ? reject(err) : resolve(files)));
  });
}

const dec = new TextDecoder('utf-8');
const txt = (files, path) => (files[path] ? dec.decode(files[path]) : null);

/** zip 里的路径不带前导斜杠，还要处理 ../ */
function resolvePath(base, rel) {
  const stack = base.split('/').slice(0, -1);
  for (const part of rel.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function findKey(files, path) {
  if (files[path]) return path;
  const want = decodeURIComponent(path).toLowerCase();
  for (const k of Object.keys(files)) {
    if (decodeURIComponent(k).toLowerCase() === want) return k;
  }
  return null;
}

/** 路径归一。TOC 的 href 和 spine 的 href 常常大小写、转义都不一样，得对得上。 */
const normPath = (p) => decodeURIComponent(String(p || '')).toLowerCase();
const dropFrag = (href) => String(href || '').split('#')[0];

/**
 * epub:type 可能写成 epub:type、带命名空间、或者（不合规但确实有）光秃秃的 type。
 * 三种都认，认不出返回空串。
 */
function epubType(el) {
  if (!el || !el.getAttribute) return '';
  let v = '';
  try { v = el.getAttributeNS(OPS_NS, 'type') || ''; } catch { /* HTML 解析出来的 doc 没有 NS */ }
  return (v || el.getAttribute('epub:type') || el.getAttribute('type') || '').toLowerCase();
}

/** EPUB3 的导航文档：一份 XHTML，里面若干 <nav>，靠 epub:type 区分用途。 */
function readNav(files, navKey) {
  const raw = txt(files, navKey);
  if (!raw) return null;
  let doc;
  try {
    doc = parser.parseFromString(raw, 'application/xhtml+xml');
    if (doc.querySelector('parsererror')) throw new Error('xhtml');
  } catch {
    doc = parser.parseFromString(raw, 'text/html');
  }

  const navs = [...doc.getElementsByTagName('*')].filter((e) => e.localName === 'nav');
  const pick = (want) => navs.find((n) => epubType(n).split(/\s+/).includes(want)) || null;

  const toc = [];
  // 没有标 epub:type="toc" 的话，退回第一个 nav —— 绝大多数书的第一个 nav 就是目录
  // 没标 epub:type="toc" 时退回第一个「没有别的用途」的 nav ——
  // 直接取 navs[0] 有可能取到 landmarks，那里面全是「正文开始」这类跳转项
  const tocNav = pick('toc') || navs.find((n) => !epubType(n)) || navs[0] || null;
  if (tocNav) {
    for (const a of tocNav.querySelectorAll('a[href]')) {
      const title = normalizeText(a.textContent || '');
      // 层级：数一数外面套了几层 <ol>，用来区分「章」和「章里的小节」
      let depth = 0;
      for (let p = a.parentElement; p && p !== tocNav; p = p.parentElement) {
        if (p.localName === 'ol' || p.localName === 'ul') depth++;
      }
      if (title) toc.push({ href: a.getAttribute('href'), title, depth: Math.max(0, depth - 1) });
    }
  }

  // landmarks：规范里专门用来标「正文从这里开始」的地方
  const marks = {};
  const lm = pick('landmarks');
  if (lm) {
    for (const a of lm.querySelectorAll('a[href]')) {
      for (const t of epubType(a).split(/\s+/)) {
        if (t && !marks[t]) marks[t] = a.getAttribute('href');
      }
    }
  }
  return { navKey, toc, marks, source: 'nav' };
}

/** EPUB2 的 toc.ncx。结构比 nav 老实，navPoint 直接带 playOrder。 */
function readNcx(files, ncxKey) {
  const raw = txt(files, ncxKey);
  if (!raw) return null;
  const doc = parser.parseFromString(raw, 'application/xml');
  if (doc.querySelector('parsererror')) return null;

  const toc = [];
  const walk = (el, depth) => {
    for (const np of [...el.children].filter((c) => c.localName === 'navPoint')) {
      const label = [...np.getElementsByTagName('*')].find((e) => e.localName === 'text');
      const content = [...np.getElementsByTagName('*')].find((e) => e.localName === 'content');
      const title = label ? normalizeText(label.textContent || '') : '';
      const href = content ? content.getAttribute('src') : null;
      if (title && href) toc.push({ href, title, depth });
      walk(np, depth + 1);
    }
  };
  const navMap = [...doc.getElementsByTagName('*')].find((e) => e.localName === 'navMap');
  if (navMap) walk(navMap, 0);
  return { navKey: ncxKey, toc, marks: {}, source: 'ncx' };
}

// epub:type 里出现这些就是前置/后置，规范说了算，不用猜
const FRONT_TYPES = new Set(['frontmatter', 'cover', 'titlepage', 'copyright-page', 'colophon',
  'toc', 'landmarks', 'dedication', 'epigraph', 'acknowledgments', 'foreword', 'preface', 'imprint']);
const BACK_TYPES = new Set(['backmatter', 'index', 'bibliography', 'glossary', 'appendix',
  'endnotes', 'afterword', 'colophon']);

export async function parseEpub(arrayBuffer, fileName, onProgress) {
  const files = await unzip(arrayBuffer);

  // container.xml → OPF 的位置
  const containerKey = findKey(files, 'META-INF/container.xml');
  if (!containerKey) throw new Error('这不像是一个 EPUB 文件（缺 META-INF/container.xml）');
  const container = parser.parseFromString(txt(files, containerKey), 'application/xml');
  const rootEl = container.querySelector('rootfile');
  const opfPath = rootEl && rootEl.getAttribute('full-path');
  if (!opfPath) throw new Error('EPUB 结构不完整，找不到 OPF');

  const opfKey = findKey(files, opfPath);
  const opf = parser.parseFromString(txt(files, opfKey), 'application/xml');

  // ⚠️ 一律按 localName 找元素，不能用 getElementsByTagName('itemref')。
  // 有的 EPUB 的 OPF 写成 <opf:itemref>，那时候 tagName 是 'opf:itemref'，
  // 按标签名找会一个都匹配不上，整本书直接报「没有找到正文章节」。
  const byName = (name) => [...opf.getElementsByTagName('*')].filter((e) => e.localName === name);

  const metaText = (tag) => {
    const els = byName(tag);
    const el = els.find((e) => e.namespaceURI && e.namespaceURI.includes('dc/elements')) || els[0];
    return el ? normalizeText(el.textContent || '') : '';
  };
  const title = metaText('title') || fileName.replace(/\.epub$/i, '');
  const author = metaText('creator');

  // manifest: id → href / media-type
  const manifest = {};
  for (const item of byName('item')) {
    const id = item.getAttribute('id');
    if (!id) continue;
    manifest[id] = {
      href: item.getAttribute('href'),
      type: item.getAttribute('media-type') || '',
      props: item.getAttribute('properties') || '',
    };
  }
  // spine 才是阅读顺序，manifest 的顺序不作数
  const spine = byName('itemref')
    .map((r) => manifest[r.getAttribute('idref')])
    .filter((m) => m && m.href && /xhtml|html/.test(m.type) && !/nav/.test(m.props));

  if (!spine.length) throw new Error('EPUB 里没有找到正文章节');

  // ---- 目录与正文起点 ----------------------------------------------------
  // EPUB3 的 nav 优先（有层级、标题更准），没有再退 EPUB2 的 ncx。
  let nav = null;
  const navItem = Object.values(manifest).find((m) => /\bnav\b/.test(m.props || ''));
  if (navItem) {
    const k = findKey(files, resolvePath(opfPath, dropFrag(navItem.href)));
    if (k) { try { nav = readNav(files, k); } catch { nav = null; } }
  }
  if (!nav || !nav.toc.length) {
    const spineEl = byName('spine')[0];
    const ncxId = spineEl && spineEl.getAttribute('toc');
    const ncxItem = ncxId ? manifest[ncxId] : Object.values(manifest).find((m) => /ncx/.test(m.type));
    if (ncxItem && ncxItem.href) {
      const k = findKey(files, resolvePath(opfPath, dropFrag(ncxItem.href)));
      if (k) { try { nav = readNcx(files, k) || nav; } catch { /* 坏了就当没有 */ } }
    }
  }

  // TOC 的 href 相对于导航文档自己，spine 的 href 相对于 OPF —— 各自解析成 zip 路径再比
  const tocByPath = new Map();
  const tocOrder = [];
  if (nav) {
    for (const e of nav.toc) {
      const p = normPath(resolvePath(nav.navKey, dropFrag(e.href)));
      tocOrder.push(p);
      if (!tocByPath.has(p)) tocByPath.set(p, e);   // 一个文件里多个锚点，取第一个当章名
    }
  }

  // 正文起点：EPUB3 landmarks 的 bodymatter，或 EPUB2 guide 的 type="text"
  let bodyStart = null;
  if (nav && nav.marks && nav.marks.bodymatter) {
    bodyStart = normPath(resolvePath(nav.navKey, dropFrag(nav.marks.bodymatter)));
  }
  if (!bodyStart) {
    const ref = byName('reference').find((r) => (r.getAttribute('type') || '').toLowerCase() === 'text');
    if (ref && ref.getAttribute('href')) {
      bodyStart = normPath(resolvePath(opfPath, dropFrag(ref.getAttribute('href'))));
    }
  }
  const spinePaths = spine.map((s) => normPath(resolvePath(opfPath, dropFrag(s.href))));
  // 起点落在第 0 项等于没说，当作没有这个信息（很多书的 guide 就是随手指向封面）
  let bodyStartIdx = bodyStart ? spinePaths.indexOf(bodyStart) : -1;
  if (bodyStartIdx <= 0) bodyStartIdx = -1;

  // ---- 逐节抽正文 --------------------------------------------------------
  const chapters = [];
  for (let i = 0; i < spine.length; i++) {
    const path = resolvePath(opfPath, dropFrag(spine[i].href));
    const key = findKey(files, path);
    if (!key) continue;
    let doc;
    try {
      doc = parser.parseFromString(txt(files, key), 'application/xhtml+xml');
      if (doc.querySelector('parsererror')) throw new Error('xhtml');
    } catch {
      doc = parser.parseFromString(txt(files, key), 'text/html');   // 有些书的 XHTML 并不严格合法
    }

    // 文档自己声明的性质。要在 blocksFrom 之前读 —— 它会把 nav/header 这些删掉
    const selfType = [
      epubType(doc.body || doc.documentElement),
      epubType(doc.querySelector('section')),
    ].join(' ').split(/\s+/).filter(Boolean);

    const paras = blocksFrom(doc);
    if (!paras.length) continue;

    const p = normPath(path);
    const tocEntry = tocByPath.get(p);
    // 章名优先用目录里的（出版社写的），其次才是文里的 h1
    const chTitle = (tocEntry && tocEntry.title) || titleFrom(doc, `第 ${chapters.length + 1} 章`);

    // 性质判定，从可信到不可信依次覆盖
    let kind = 'body';
    if (bodyStartIdx >= 0) kind = i < bodyStartIdx ? 'front' : 'body';
    if (selfType.some((t) => FRONT_TYPES.has(t))) kind = 'front';
    else if (selfType.some((t) => BACK_TYPES.has(t))) kind = 'back';
    else if (bodyStartIdx < 0 && !selfType.length) {
      // 规范里什么都没写，只能看标题猜。而且只在正文开始之前猜前置内容 ——
      // 一旦已经进了正文，后面再出现叫「Notes」的东西也可能是正文的一章
      if (!chapters.some((c) => c.kind === 'body') && FRONT_RE.test(chTitle)) kind = 'front';
      else if (BACK_RE.test(chTitle)) kind = 'back';
    } else if (bodyStartIdx >= 0 && kind === 'body' && BACK_RE.test(chTitle)) {
      kind = 'back';
    }

    // 标题那个 <h1> 同时也是一个块，blocksFrom 会把它当成第一段抓进来，
    // 不去掉的话正文开头会把标题原样重复一遍
    const body = paras[0] === chTitle ? paras.slice(1) : paras;
    if (body.length) {
      chapters.push({
        title: chTitle,
        kind,
        depth: tocEntry ? tocEntry.depth : 0,
        inToc: !!tocEntry,
        paras: body,
      });
    }
    if (onProgress) onProgress(i + 1, spine.length);
  }

  if (!chapters.length) throw new Error('EPUB 里抽不出任何正文');

  // 全书被判成前置内容说明判定错了（比如整本书都没有 body 标记），
  // 这时宁可一节不跳，也不能让人打开一本书是空的
  if (!chapters.some((c) => c.kind === 'body')) {
    for (const c of chapters) c.kind = 'body';
  }

  return {
    title,
    author,
    chapters,
    flags: [],
    toc: { source: nav ? nav.source : 'none', hasBodyStart: bodyStartIdx >= 0 },
  };
}
