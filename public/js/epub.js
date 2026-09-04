// EPUB 导入。一等公民，处理可靠。
//
// EPUB 本质就是一个 zip 里装着 XHTML，段落和章节都是显式标出来的 ——
// 不像 PDF 要靠坐标猜。所以这条路几乎不会出错，用户拿不准的书
// 一律建议他去找 EPUB 版。

import { normalizeText } from './text.js';
import { blocksFrom, titleFrom } from './html.js';

const parser = new DOMParser();

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

  const chapters = [];
  for (let i = 0; i < spine.length; i++) {
    const path = resolvePath(opfPath, spine[i].href.split('#')[0]);
    const key = findKey(files, path);
    if (!key) continue;
    let doc;
    try {
      doc = parser.parseFromString(txt(files, key), 'application/xhtml+xml');
      if (doc.querySelector('parsererror')) throw new Error('xhtml');
    } catch {
      doc = parser.parseFromString(txt(files, key), 'text/html');   // 有些书的 XHTML 并不严格合法
    }
    const paras = blocksFrom(doc);
    if (paras.length) {
      const title = titleFrom(doc, `第 ${chapters.length + 1} 章`);
      // 标题那个 <h1> 同时也是一个块，blocksFrom 会把它当成第一段抓进来，
      // 不去掉的话正文开头会把标题原样重复一遍
      const body = paras[0] === title ? paras.slice(1) : paras;
      if (body.length) chapters.push({ title, paras: body });
    }
    if (onProgress) onProgress(i + 1, spine.length);
  }

  if (!chapters.length) throw new Error('EPUB 里抽不出任何正文');
  return { title, author, chapters, flags: [] };
}
