// Gloss —— 主程序：路由、各个页面、导入流程。
//
// 贯穿全篇的第一原则：**降低每次打开的阻力。**
// 真正的敌人不是「看不懂单词」，是半途而废。所以功能可以多，选择不能多 ——
// 首页只有一个主按钮，App 自己知道今晚该干什么（过词 → 读这一节），
// 「只想过词」「直接读」放在旁边当次要入口，不摆成一道选择题。

import { $, $$, esc, toast, busy, speak, copyText, relTime, fmtSize, yieldFrame } from './util.js';
import * as store from './store.js';
import { S, save, touchDay, streak } from './store.js';
import * as db from './db.js';
import * as dict from './dict.js';
import { parseEpub } from './epub.js';
import { parsePdf } from './pdf.js';
import { parseTextDoc, parseHtmlDoc, parseDocx } from './doc.js';
import { makeSections, englishRatio, WORD_RE, pickSentence } from './text.js';
import * as vocab from './vocab.js';
import { NATIVE } from './env.js';

/* ================= 全局 ================= */

let CUR = { id: null, book: null, index: null };   // 当前打开的书 + 它的词汇索引
let pending = null;                                 // 预览闸门上待确认的书
const IVL = [0, 1, 3, 7, 14, 30, 60];               // 间隔重复的天数

const KIND_LABEL = { epub: 'EPUB', pdf: 'PDF', docx: 'Word', html: '网页', text: '文本', paste: '粘贴' };

/* ---------- 安卓安装包 ---------- */
// 只有网页版需要这个入口 —— 已经装成 App 的人没理由再下一遍。
// 服务器上没放包时 available 为 false，入口整个不出现，不给一个点了 404 的链接。
const IS_ANDROID = /Android/i.test(navigator.userAgent);
let APK = null;

async function loadApkInfo() {
  if (NATIVE) return;
  try {
    const j = await (await fetch('/api/apk')).json();
    APK = j && j.available ? j : null;
  } catch { APK = null; }
}

const apkLabel = () => `${APK.version ? 'v' + APK.version + ' · ' : ''}${fmtSize(APK.bytes)}`;

const bookMeta = (id) => S.books[id];

/** 值不值得给这份文档露一个「目录」入口。只有一章的话，目录里就一行，是纯噪音。 */
const hasToc = (m) => !m.chaps || m.chaps.length > 1;

/**
 * 把节按章聚合，给「按章选读」用。返回 [{t, ci, kind, si, n}]，si 是这一章第一节的序号。
 *
 * 老书（这个功能之前导进来的）身上没有 ci，退回按章名变化分组 —— 效果一样，
 * 只是遇到两章重名会并成一章。为这个去做数据迁移不值当。
 */
function chaptersOf(sections) {
  const out = [];
  sections.forEach((s, si) => {
    const ci = Number.isInteger(s.ci) ? s.ci : -1;
    const t = s.chapter || s.title || `第 ${si + 1} 节`;
    const last = out[out.length - 1];
    if (last && (ci >= 0 ? last.ci === ci : last.ci < 0 && last.t === t)) { last.n++; return; }
    out.push({ t, ci, kind: s.kind || 'body', si, n: 1 });
  });
  return out;
}

/**
 * 第一节正文在哪。EPUB 里封面、版权页、致谢、目录都在正文前面，
 * 从第 0 节打开等于让人读出版说明 —— 这是实测中最伤的一个体验问题。
 *
 * 找不到正文就退回 0：宁可从版权页开始，也不能打开一本空书。
 */
function firstBodyIdx(sections) {
  const i = sections.findIndex((s) => (s.kind || 'body') === 'body');
  return i > 0 ? i : 0;
}
const bookIds = () => Object.keys(S.books).sort((a, b) => S.books[b].addedAt - S.books[a].addedAt);

async function loadBook(id) {
  if (CUR.id === id && CUR.book) return CUR;
  const book = await db.getBook(id);
  if (!book) return null;
  let index = await db.getVocabIndex(id);
  // 索引是按某一档水平算出来的。换过水平（或者从别的设备恢复了数据）之后，
  // 旧索引挑出来的生词就不算数了 —— 在这里补算，比让人看到一份错的词表强。
  if (index && index.level !== S.settings.level) {
    try { index = await rebuildIndex(book); } catch { /* 算不出来就先用旧的 */ }
  }
  CUR = { id, book, index: index || null };
  return CUR;
}

/** 重算一本书的生词索引，并把首页要用的计数一起更新。 */
async function rebuildIndex(book, msg) {
  const idx = await vocab.buildIndex(book, (phase, d, t) =>
    busy.show(msg || '正在按你的水平重算生词…', t ? d / t : null));
  idx.id = book.id;
  idx.level = S.settings.level;
  await db.putVocabIndex(idx);
  const m = S.books[book.id];
  if (m) {
    m.secWords = idx.bySection.map((a) => a.length);
    m.coreWords = idx.stats.core;
    save();
  }
  busy.hide();
  return idx;
}

/* ================= 路由 ================= */

const RENDER = {
  home: renderHome, import: renderImport, read: renderRead,
  words: renderWords, vocab: renderVocab, review: renderReview, me: renderMe,
};

let route = { view: 'home' };

function go(view, params = {}) {
  route = { view, ...params };
  $$('.view').forEach((v) => v.classList.remove('on'));
  $('#view-' + view).classList.add('on');
  const tab = { home: 'home', vocab: 'vocab', review: 'review', me: 'me' }[view];
  $$('#tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('#tabbar').classList.toggle('hide', view === 'import' || view === 'words');
  RENDER[view](params);
  window.scrollTo(0, 0);
}

$$('#tabbar button').forEach((b) => (b.onclick = () => go(b.dataset.tab)));

/* ================= 文档列表 ================= */

function renderHome() {
  updateBadges();
  const ids = bookIds();
  let h = `<div class="brand"><div class="zh-t">Gloss</div>
    <div class="en-t">自己带文档的离线阅读器 · 点词即出释义</div></div>`;
  h += `<div class="streakline ui"><b>${streak()}</b><span>连续天数</span>
    <span style="margin-left:auto">生词 ${Object.keys(S.vocab).length} 个</span></div>`;

  if (ids.length) {
    // 今晚读哪份：最近打开过的那份。这里不给选择，选择留给下面的列表。
    const id = ids.slice().sort((a, b) => (S.books[b].lastOpen || 0) - (S.books[a].lastOpen || 0))[0];
    const m = S.books[id];
    const si = Math.min(m.cur || 0, m.n - 1);
    const wordN = m.secWords ? (m.secWords[si] || 0) : 0;
    const mins = vocab.estimateMinutes(wordN, m.secLen ? m.secLen[si] || 900 : 900);
    const done = m.learned && m.learned[si];
    h += `<button class="tonight ui" data-act="tonight" data-id="${id}">
      <div class="eyebrow">今晚</div>
      <div class="t">${esc(m.title)} · 第 ${si + 1} 节</div>
      <div class="zt">${m.secWords
        ? (done ? `词已过完 · 约 ${mins} 分钟读完这一节` : `${wordN} 个新词 · 约 ${mins} 分钟`)
        : '继续阅读'}</div></button>`;
    // 这两个不是一对平级选项：读才是目的，过词只是助跑。等宽并排会让人以为
    // 得在两者之间挑一个，所以「直接读」占主位，「只想过词」缩成一个小入口。
    h += `<div class="subacts ui">
      <button class="go" data-act="onlyread" data-id="${id}">直接读这一节</button>
      <button class="quiet" data-act="onlywords" data-id="${id}" ${m.secWords ? '' : 'disabled'}>只想过词</button></div>`;

    // 生词是按某一档水平挑的。默认那档不可能对所有人都准，所以在他第一次
    // 看到词数的地方说一句 —— 只说一次，选过之后不再出现。
    if (!S.settings.levelSet) {
      h += `<button class="lvhint ui" data-act="level">
        生词按「${esc(dict.level().name)}」的水平挑的<span>换一个</span></button>`;
    }

    h += `<ul class="shelf">`;
    for (const bid of ids) {
      const b = S.books[bid];
      const readN = Object.keys(b.read || {}).length;
      h += `<li><button class="item" data-act="open" data-id="${bid}">
        <span class="cover"></span>
        <span class="meta">
          <span class="bt">${esc(b.title)}</span>
          <span class="bs">${b.author ? esc(b.author) + ' · ' : ''}${KIND_LABEL[b.kind] || ''} · ${b.n} 节 · 已读 ${readN}</span>
          <span class="nbar"><i style="width:${b.n ? (readN / b.n) * 100 : 0}%"></i></span>
        </span></button>${hasToc(b) ? `<button class="tocbtn" data-act="toc" data-id="${bid}"
          aria-label="目录">目录</button>` : ''}</li>`;
    }
    h += `</ul>`;
  }

  h += `<button class="addbook ui" data-act="add">
    <b>＋ 导入文档</b>
    EPUB、Word、网页、纯文本，或者单栏有文字层的 PDF
    <span class="dnd">也可以把文件直接拖进窗口</span>
    <span>文件只在这台设备上读取和存储，不会上传</span></button>
    <button class="pastebtn ui" data-act="paste">或者直接粘贴一段英文</button>`;

  // 只对安卓浏览器露出。iPhone 和电脑上摆一个装不了的按钮是纯粹的噪音，
  // 那两种人在「进度」页里能找到它。
  if (!NATIVE && APK && IS_ANDROID) {
    h += `<a class="apkbar ui" href="/download/gloss.apk" download>
      <b>装成安卓 App</b>
      <span>词典一起装进去，以后读书不用开着这台电脑 · ${esc(apkLabel())}</span></a>`;
  }

  if (!ids.length) {
    h += `<div class="note" style="margin-top:14px">
      原版书、英文合同、说明书、论文、网页文章都行 —— 挡在人前面的从来不只有书。<br>
      扫描件 PDF（整页是图片、选不中文字）取不出文字，导入会被直接拒绝。</div>`;
  }
  $('#view-home').innerHTML = h;
  wire('#view-home');
}

/* ================= 导入 ================= */

$('#filepick').onchange = async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';           // 同一个文件也能再选一次
  if (file) await importFile(file);
};

// 认得的格式。收得比「书」宽，是因为挡在人前面的从来不只有原版书 ——
// 英文合同、说明书、论文、网页文章，一样是一屏生词。
const KINDS = [
  { re: /\.epub$/i,            kind: 'epub', label: 'EPUB' },
  { re: /\.pdf$/i,             kind: 'pdf',  label: 'PDF' },
  { re: /\.docx$/i,            kind: 'docx', label: 'Word' },
  { re: /\.(html?|xhtml)$/i,   kind: 'html', label: '网页' },
  { re: /\.(txt|md|markdown|text)$/i, kind: 'text', label: '文本' },
];

function kindOf(name, type) {
  const hit = KINDS.find((k) => k.re.test(name));
  if (hit) return hit;
  if (type === 'application/pdf') return KINDS[1];
  if (type === 'application/epub+zip') return KINDS[0];
  if ((type || '').startsWith('text/')) return KINDS[4];
  return null;
}

async function importFile(file) {
  const k = kindOf(file.name, file.type);
  if (!k) return toast('支持 EPUB / PDF / Word / 网页 / 纯文本');

  importing = true;
  busy.show(`正在读${k.label}…`, 0);
  try {
    const onP = (d, t) => busy.show(
      k.kind === 'pdf' ? `正在抽取文字 ${d}/${t} 页` : `正在解析 ${d}/${t} 章`, d / t);
    let parsed;
    if (k.kind === 'pdf') parsed = await parsePdf(await file.arrayBuffer(), file.name, onP);
    else if (k.kind === 'epub') parsed = await parseEpub(await file.arrayBuffer(), file.name, onP);
    else if (k.kind === 'docx') parsed = await parseDocx(await file.arrayBuffer(), file.name);
    else if (k.kind === 'html') parsed = parseHtmlDoc(await file.text(), file.name);
    else parsed = parseTextDoc(await file.text(), file.name);

    await stageImport(parsed, k, file.size);
  } catch (err) {
    busy.hide();
    pending = { error: err };
    go('import');
  } finally {
    importing = false;
  }
}

/** 解析完 → 分节 → 摆上预览闸门。所有格式最后都汇到这里。 */
async function stageImport(parsed, k, size) {
  busy.show('正在分节…', null);
  await yieldFrame();
  const sections = makeSections(parsed.chapters);
  if (!sections.length) throw new Error('抽出来的正文太少，分不出可读的内容');

  const flags = [...(parsed.flags || [])];
  // 英文占比太低 —— 整个应用的作用就是查英文词，这时候要说清楚，
  // 而不是让人导进来才发现点哪个词都没反应
  const ratio = englishRatio(sections);
  if (ratio < 0.15) {
    flags.push({
      level: 'warn',
      text: '这份文档里几乎没有英文。Gloss 的查词只对英文有用，导进来也点不出释义。',
    });
  }
  pending = {
    title: parsed.title, author: parsed.author, kind: k.kind, label: k.label,
    sections, flags, size,
  };
  busy.hide();
  go('import');
}

/**
 * 粘贴面板。刻意不用 prompt() —— 手机上那是个单行小框，
 * 粘一段合同进去根本看不见自己粘了什么。
 */
function openPasteSheet() {
  $('#sheet').innerHTML = `<div class="pastewrap">
    <div class="dw"><span class="w" style="font-size:20px">粘贴一段英文</span></div>
    <div class="note" style="margin:8px 0 12px">
      合同条款、邮件、报错信息、网页上抄来的一段——不值得存成文件的那些。</div>
    <textarea id="pastebox" placeholder="把英文粘到这里…"></textarea>
    <div class="dacts ui">
      <button data-act="closesheet">取消</button>
      <button class="pri" data-act="pastego">下一步</button>
    </div></div>`;
  $('#sheet').classList.add('on');
  $('#dim').classList.add('on');
  wire('#sheet');
  setTimeout(() => { const b = $('#pastebox'); if (b) b.focus(); }, 60);
}

/** 粘贴一段英文直接读。合同片段、邮件、报错信息——不值得存成文件的那些。 */
async function importPasted(text) {
  const t = String(text || '').trim();
  if (t.length < 40) return toast('太短了，粘贴一段完整的文字');
  busy.show('正在处理…', null);
  try {
    const parsed = parseTextDoc(t, '');
    if (!parsed.title || parsed.title === '未命名文档') {
      parsed.title = t.replace(/\s+/g, ' ').slice(0, 40) + (t.length > 40 ? '…' : '');
    }
    await stageImport(parsed, { kind: 'paste', label: '粘贴' }, 0);
  } catch (err) {
    busy.hide();
    pending = { error: err };
    go('import');
  }
}

/* ================= 英语水平 ================= */

// 这个应用做的判断只有一个：哪些词他不认识。判错了整件事就垮了 ——
// 标多了满屏虚线不敢读，标少了真正拦住他的词反而没标出来。
// 而这条线在谁身上都不一样，所以它必须是他自己说了算。

/** 水平选择面板。进度页和首页那行提示都开它，只此一份实现。 */
function openLevelSheet() {
  const cur = S.settings.level;
  let h = `<div class="lvwrap">
    <div class="dw"><span class="w" style="font-size:20px">你的英语水平</span></div>
    <div class="note" style="margin:8px 0 14px">
      这决定了哪些词会被当成生词标出来。选高了满屏虚线，选低了真正拦住你的词反而不标。
      拿不准就选你最近考过的那个 —— 随时能改，改完会重算已导入的文档。</div>
    <ul class="lvlist">`;
  for (const l of dict.LEVELS) {
    h += `<li><button data-act="setlevel" data-id="${l.id}" class="${l.id === cur ? 'on' : ''}">
      <span class="n">${esc(l.name)}</span>
      <span class="h">${esc(l.hint)}</span>
      <span class="ck">${l.id === cur ? '✓' : ''}</span></button></li>`;
  }
  h += `</ul><div class="dacts ui"><button data-act="closesheet">先不改</button></div></div>`;
  $('#sheet').innerHTML = h;
  $('#sheet').classList.add('on');
  $('#dim').classList.add('on');
  wire('#sheet');
}

/**
 * 换一档水平。麻烦的地方在于：已导入文档的生词索引是按旧水平算出来的，
 * 不重算的话首页写着「17 个新词」，点进去还是那批老词 —— 那比不给选更糟。
 * 所以这里当场把每本书都重算一遍，几秒钟换一个诚实的数字。
 */
async function setLevel(id) {
  const changed = id !== S.settings.level;
  S.settings.level = id;
  S.settings.levelSet = true;      // 他自己选过了，首页那行提示就不用再出现
  save();
  dict.setLevel(id);

  const ids = bookIds();
  if (changed && ids.length) {
    let i = 0;
    for (const bid of ids) {
      i++;
      try {
        const book = await db.getBook(bid);
        if (!book) continue;
        const idx = await rebuildIndex(book, `正在按新水平重算生词 ${i}/${ids.length}…`);
        if (CUR.id === bid) CUR.index = idx;
      } catch (err) {
        console.error(err);
      }
    }
    busy.hide();
  }
  if (changed) toast(`已按「${dict.level().name}」的水平挑生词`);
  go(route.view === 'me' ? 'me' : 'home');
}

/* ---------- 拖拽导入 ---------- */

// 桌面上最顺手的动作，是把文件从文件夹里直接拖进窗口。以前不接这个事件，
// 浏览器会把拖进来的文件当成一次导航直接打开，整个应用被顶掉、正在读的那一节
// 也一起没了 —— 那比「不支持拖拽」还糟。所以这里既接住文件，也接住误落的拖拽。
let importing = false;
let dragDepth = 0;                                  // dragenter/dragleave 会在每个子元素上各来一次

const dragHasFiles = (dt) => !!dt && [...(dt.types || [])].includes('Files');

function endDrag() {
  dragDepth = 0;
  $('#drop').classList.remove('on');
}

window.addEventListener('dragenter', (e) => {
  if (!dragHasFiles(e.dataTransfer)) return;
  e.preventDefault();
  dragDepth++;
  if (!importing) $('#drop').classList.add('on');
});

window.addEventListener('dragover', (e) => {
  if (!dragHasFiles(e.dataTransfer)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';               // 光标显示「复制」，别显示「移动」
});

window.addEventListener('dragleave', (e) => {
  if (dragDepth && --dragDepth <= 0) endDrag();
});

window.addEventListener('drop', (e) => {
  // 往输入框里拖文字（比如粘贴面板）交给浏览器自己处理，别抢
  if (e.target && e.target.closest && e.target.closest('textarea, input')) return endDrag();
  e.preventDefault();
  endDrag();
  handleDrop(e.dataTransfer);
});

async function handleDrop(dt) {
  if (!dt) return;

  // isDirectory 只能在事件这一拍里同步取，await 之后 items 就空了
  const hasDir = [...(dt.items || [])].some((it) => {
    const en = it.webkitGetAsEntry && it.webkitGetAsEntry();
    return en && en.isDirectory;
  });
  const files = [...(dt.files || [])];

  if (files.length || hasDir) {
    if (importing) return toast('上一份还在读，等它读完');
    const ok = files.filter((f) => kindOf(f.name, f.type));
    if (!ok.length) {
      if (hasDir) return toast('整个文件夹读不了，拖一个文件进来');
      return toast('支持 EPUB / PDF / Word / 网页 / 纯文本');
    }
    // 一次只收一份：预览闸门是要人一眼一眼看的，攒一堆反而没法确认
    if (files.length > 1 || hasDir) toast(`一次导一份，先读「${ok[0].name}」`);
    return importFile(ok[0]);
  }

  // 从别的网页里拖一段选中的文字过来，等于粘贴
  const text = dt.getData('text/plain');
  if (text && text.trim()) importPasted(text);
}

function renderImport() {
  const v = $('#view-import');
  if (!pending) return go('home');

  if (pending.error) {
    const e = pending.error;
    v.innerHTML = `<div class="impwrap">
      <h2>这份文档导不进来</h2>
      <div class="flag bad">${esc(e.message || '解析失败')}</div>
      ${e.scanned ? `<div class="note">扫描件是把纸拍成图片，页面上没有任何可选中的文字，
        程序也就无从取词。这类书去找一个 EPUB 版基本都能找到，而 EPUB 我们处理得又稳又好。</div>` : ''}
      <div class="row" style="margin-top:22px">
        <button class="btn" data-act="home">返回</button>
        <button class="btn pri" data-act="add">换一份</button></div></div>`;
    wire('#view-import');
    return;
  }

  const totalWords = pending.sections.reduce((n, s) => n + s.words, 0);
  const preview = [];
  for (const sec of pending.sections) {
    for (const p of sec.paras) {
      preview.push(p);
      if (preview.length >= 8) break;
    }
    if (preview.length >= 8) break;
  }

  let h = `<div class="impwrap">
    <h2>先看一眼抽出来的效果</h2>
    <div class="note">这一步只有人眼能做。程序能判断的只有「有没有文字层」，
      至于句子连不连贯、有没有乱码，你扫两眼就知道了。</div>
    <div class="impmeta">
      <div class="t">${esc(pending.title)}</div>
      <div class="s">${pending.author ? esc(pending.author) + ' · ' : ''}${esc(pending.label || '')} ·
        ${pending.sections.length} 节 · 约 ${totalWords.toLocaleString()} 个英文词${
        pending.size ? ' · ' + fmtSize(pending.size) : ''}</div>
    </div>`;
  for (const f of pending.flags) {
    h += `<div class="flag ${f.level === 'warn' ? 'bad' : ''}">${esc(f.text)}</div>`;
  }
  // 跳过起点这件事必须说出来。悄悄跳过和悄悄丢弃，用户是分不出来的 ——
  // 而这个项目在「悄悄少掉内容」上栽过一次（见 text.js 里 textWeight 的注释）
  const skipN = pending.sections.filter((s) => s.kind === 'front').length;
  if (skipN) {
    const names = [...new Set(pending.sections.filter((s) => s.kind === 'front')
      .map((s) => s.chapter))].slice(0, 3).join('、');
    h += `<div class="flag">开头 ${skipN} 节是${names ? esc(names) + '这类' : ''}前置内容，`
      + `会从第 ${firstBodyIdx(pending.sections) + 1} 节正文开始读。这些内容一节都没少，在目录里能翻到。</div>`;
  }
  h += `<div class="preview">${preview.map((p) => `<p>${esc(p)}</p>`).join('')}</div>
    <div class="askline">这几段读得通吗？<small>句子连贯、没有乱码、没有夹进页眉页码，就可以开始了</small></div>
    <button class="btn pri" data-act="accept">读得通，导入</button>
    <div class="row" style="margin-top:10px">
      <button class="btn" data-act="home">先算了</button>
      <button class="btn" data-act="add">读不通，换一份</button></div>
    </div>`;
  v.innerHTML = h;
  wire('#view-import');
}

async function acceptImport() {
  const p = pending;
  const id = 'b_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const book = { id, title: p.title, author: p.author, kind: p.kind, sections: p.sections };

  busy.show('正在存到本地…', null);
  await db.requestPersist();     // 尽量别被 iOS 当缓存清掉
  await db.putBook(book);

  touchDay();   // 导进一本书本身就是「今天动过了」，连续天数不该从 0 起步
  S.books[id] = {
    title: p.title, author: p.author, kind: p.kind,
    n: p.sections.length, addedAt: Date.now(), lastOpen: Date.now(),
    // 从第一节正文开始，不是第 0 节。前置内容一节都没丢，只是不作为起点 ——
    // 目录里随时能翻回去看
    cur: firstBodyIdx(p.sections), read: {}, learned: {},
    secLen: p.sections.map((s) => s.words),
    chaps: chaptersOf(p.sections),
  };
  save();
  CUR = { id, book, index: null };

  // 词汇索引现在就算好，之后每次打开都是现成的
  try {
    const idx = await vocab.buildIndex(book, (phase, d, t) => {
      const msg = phase === 'scan' ? '正在扫全书词形…' : '正在查词典…';
      busy.show(msg, t ? d / t : null);
    });
    idx.id = id;
    idx.level = S.settings.level;
    await db.putVocabIndex(idx);
    CUR.index = idx;
    S.books[id].secWords = idx.bySection.map((a) => a.length);
    S.books[id].coreWords = idx.stats.core;
    save();
    busy.hide();
    toast(`导入完成 · 全书 ${Object.keys(idx.words).length} 个生词，其中 ${idx.stats.core} 个反复出现`);
  } catch (err) {
    busy.hide();
    console.error(err);
    toast('文档导入好了，但生词表没算成功，仍然可以正常阅读');
  }
  pending = null;
  go('home');
}

/* ================= 阅读器 ================= */

/** 渲染前先把这一节用得到的词典分片拉齐，之后 tokenize 就是纯同步的了。 */
async function ensureSectionDict(sec) {
  const shards = new Set();
  for (const para of sec.paras) {
    for (const m of para.match(WORD_RE) || []) {
      for (const s of dict.candidateShards(m)) shards.add(s);
    }
  }
  await dict.ensureShards(shards);
  // 原形常常落在别的分片里（better → good）；整词查不到的还要拆词（cannot → can+not）。
  // 两样都得补一轮，否则正文里这些词点下去是「没查到」。
  const more = new Set();
  for (const para of sec.paras) {
    for (const m of para.match(WORD_RE) || []) {
      const e = dict.raw(dict.normalize(m));
      if (e && e.x) more.add(dict.shardOf(e.x));
      else if (!dict.get(m)) for (const s of dict.compoundShards(m)) more.add(s);
    }
  }
  if (more.size) await dict.ensureShards(more);
}

function tokenize(text) {
  let out = '', last = 0, m;
  WORD_RE.lastIndex = 0;
  while ((m = WORD_RE.exec(text))) {
    out += esc(text.slice(last, m.index));
    const r = dict.get(m[0]);
    if (!r) out += esc(m[0]);
    else {
      const key = r.lemmaEntry ? r.lemma : r.word;
      // 句中的大写基本就是人名地名。词典里认不出的名字（Adler、Ichiro）
      // 也能靠这一条挡掉 —— 标一堆名字只会让虚线下划线失去意义。
      const before = text.slice(Math.max(0, m.index - 3), m.index);
      const midSentenceCap = /^[A-Z]/.test(m[0]) && m.index > 0 && !/[.!?…"'’”)\]]\s*$/.test(before);
      const hard = S.settings.markHard && !midSentenceCap && dict.isHard(r);
      const cls = S.vocab[key] ? 'saved' : (hard ? 'hard' : '');
      out += `<w class="${cls}"${hard ? ' data-hard="1"' : ''} data-w="${esc(m[0])}">${esc(m[0])}</w>`;
    }
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

async function openSection(id, si, opts = {}) {
  const c = await loadBook(id);
  if (!c) return toast('这份文档的正文不在了，请重新导入');
  const sec = c.book.sections[si];
  if (!sec) return toast('没有这一节');
  S.books[id].cur = si;
  S.books[id].lastOpen = Date.now();
  save();
  touchDay();
  busy.show('正在准备这一节的词典…', null);
  await ensureSectionDict(sec);
  busy.hide();
  go('read', { id, si, ...opts });
}

function renderRead({ id, si }) {
  const book = CUR.book;
  const sec = book.sections[si];
  const m = bookMeta(id);
  const isDone = !!(m.read && m.read[si]);

  let h = `<div class="rhead ui">
    <button class="back" data-act="home">‹</button>
    <span class="where">${esc(book.title)} · ${si + 1}/${book.sections.length}</span>
    <button class="act" data-act="secwords" data-id="${id}" data-si="${si}">过词</button></div>
    <div class="rbody">
    <div class="sec-eyebrow ui">第 ${si + 1} 节 · ${sec.words} 词</div>
    <h1 class="sec-t">${esc(sec.title)}</h1>`;
  sec.paras.forEach((p, k) => {
    h += `<div class="para" id="p${k}"><div class="en">${tokenize(p)}</div>
      <div class="ptools ui"><button class="tts" data-k="${k}">🔊 朗读</button></div></div>`;
  });
  h += `<button class="donebtn ui ${isDone ? 'done' : ''}" data-act="done">
      ${isDone ? '已读完 ✓' : '读完这一节 ✓'}</button>
    <div class="secnav ui">
      <button data-act="sec" data-si="${si - 1}" ${si <= 0 ? 'disabled' : ''}>‹ 上一节</button>
      ${hasToc(m) ? `<button data-act="toc" data-id="${id}">目录</button>` : ''}
      <button data-act="sec" data-si="${si + 1}" ${si >= book.sections.length - 1 ? 'disabled' : ''}>下一节 ›</button>
    </div></div>`;

  const v = $('#view-read');
  v.innerHTML = h;
  $$('.tts', v).forEach((b) => (b.onclick = () => speak(sec.paras[b.dataset.k], 0.9)));
  $$('w', v).forEach((w) => (w.onclick = (ev) => {
    ev.stopPropagation();
    $$('w.lit').forEach((x) => x.classList.remove('lit'));
    w.classList.add('lit');
    openSheet(w.dataset.w, w.closest('.para').querySelector('.en').textContent, id, si);
  }));
  wire('#view-read');
}

function markSectionDone(id, si) {
  const m = bookMeta(id);
  if (m.read[si]) return;
  m.read[si] = 1;
  touchDay();
  save();
  const b = $('#view-read .donebtn');
  if (b) { b.textContent = '已读完 ✓'; b.classList.add('done'); }
  toast(`第 ${si + 1}/${m.n} 节完成 · 连续 ${streak()} 天`);
}

/* ================= 查词卡片 ================= */

let sheetCtx = null;

function openSheet(raw, contextText, bookId, si) {
  const r = dict.get(raw);
  if (!r) { toast('这个词没查到'); return; }
  const key = r.lemmaEntry ? r.lemma : r.word;
  const main = r.lemmaEntry || r.entry;
  sheetCtx = { key, src: pickSentence(contextText || '', raw), bookId, si };

  let h = `<div class="dw"><span class="w">${esc(key)}</span>`;
  if (main.p) h += `<span class="ph">/${esc(main.p)}/</span>`;
  h += `</div>`;
  const tags = dict.tagsOf(r);
  const st = dict.stars(main);
  // 常用度只显示 ★ —— 数值来自开源词库，但星级标准是别人的商标，不打品牌名
  if (tags.length || st) {
    h += `<div class="dtags">${tags.map((t) => `<i>${esc(t)}</i>`).join('')}
      ${st ? `<i>常用度 ${st}</i>` : ''}</div>`;
  }
  h += `<div class="dtrans">${esc(main.t || '')}</div>`;
  if (key !== dict.normalize(raw)) {
    h += `<div class="dbase">原文形态 ${esc(raw)}${
      r.entry.t && r.entry !== main ? '：' + esc(dict.firstLine(r.entry.t)) : ''}</div>`;
  }
  if (sheetCtx.src) h += `<div class="dsrc">“${esc(sheetCtx.src)}”</div>`;
  const saved = !!S.vocab[key];
  h += `<div class="dacts ui">
    <button data-act="say">🔊 发音</button>
    <button class="${saved ? 'rm' : 'pri'}" data-act="savew">${saved ? '移出生词本' : '＋ 收入生词本'}</button>
    </div>`;
  $('#sheet').innerHTML = h;
  $('#sheet').classList.add('on');
  $('#dim').classList.add('on');
  wire('#sheet');
}

function toggleSave() {
  const k = sheetCtx.key;
  if (S.vocab[k]) { delete S.vocab[k]; toast('已移出生词本'); }
  else {
    S.vocab[k] = {
      ts: Date.now(), due: Date.now(), lvl: 0,
      src: sheetCtx.src || '', book: sheetCtx.bookId || '', sec: sheetCtx.si ?? 0,
    };
    touchDay();
    toast('已收入生词本');
  }
  save();
  closeSheet();
  refreshMarks();
  updateBadges();
}

function refreshMarks() {
  $$('#view-read w').forEach((w) => {
    const r = dict.get(w.dataset.w);
    if (!r) return;
    const key = r.lemmaEntry ? r.lemma : r.word;
    const saved = !!S.vocab[key];
    w.classList.toggle('saved', saved);
    // 用渲染时记下的判断，别在这里重算 —— 重算拿不到「句中大写」那个上下文，
    // 取消收藏之后人名就会重新冒出虚线来
    w.classList.toggle('hard', !saved && w.dataset.hard === '1');
  });
}

// ---------- 目录（按章选读）----------
let tocCtx = null;
let tocOpenFront = false;

async function openTocSheet(id) {
  const m = bookMeta(id);
  if (!m) return;
  let chaps = m.chaps;
  if (!chaps || !chaps.length) {
    // 这个功能之前导进来的书，元数据里没有章目录。翻一次正文补上，之后就是现成的。
    const c = await loadBook(id);
    if (!c) return toast('这份文档的正文不在了，请重新导入');
    chaps = chaptersOf(c.book.sections);
    m.chaps = chaps;
    save();
  }
  tocCtx = id;
  const read = m.read || {};
  const cur = Math.min(m.cur || 0, m.n - 1);
  const body = chaps.filter((c) => c.kind !== 'front');
  const front = chaps.filter((c) => c.kind === 'front');

  const row = (c) => {
    let done = 0;
    for (let k = c.si; k < c.si + c.n; k++) if (read[k]) done++;
    const here = cur >= c.si && cur < c.si + c.n;
    const fin = done === c.n;
    return `<li><button data-act="gosec" data-id="${id}" data-si="${c.si}" class="${here ? 'here' : ''}">
      <span class="n">${esc(c.t)}</span>
      <span class="h">${c.n} 节${done ? ` · 已读 ${done}/${c.n}` : ''}${here ? ' · 读到这里' : ''}</span>
      <span class="ck">${fin ? '✓' : (here ? '●' : '')}</span></button></li>`;
  };

  let h = `<div class="lvwrap">
    <div class="dw"><span class="w" style="font-size:20px">目录</span></div>
    <div class="note" style="margin:8px 0 14px">${body.length} 章 · 共 ${m.n} 节。点哪一章就从哪一章开始。</div>
    <ul class="lvlist toclist">${body.map(row).join('')}</ul>`;
  if (front.length) {
    h += `<button class="tocfront" data-act="tocfront">${tocOpenFront ? '收起' : '展开'}开头的
      ${front.length} 项 · 封面、版权页、目录这些</button>`;
    if (tocOpenFront) h += `<ul class="lvlist toclist" style="margin-top:10px">${front.map(row).join('')}</ul>`;
  }
  h += `<div class="dacts ui"><button data-act="closesheet">关闭</button></div></div>`;
  $('#sheet').innerHTML = h;
  $('#sheet').classList.add('on');
  $('#dim').classList.add('on');
  wire('#sheet');
}

function closeSheet() {
  $('#sheet').classList.remove('on');
  $('#dim').classList.remove('on');
  $$('w.lit').forEach((x) => x.classList.remove('lit'));
}
$('#dim').onclick = closeSheet;

/* ================= 过词 ================= */

let wordQueue = [], wordPos = 0, wordCtx = null;

async function startWords(id, si, thenRead) {
  const c = await loadBook(id);
  if (!c) return toast('这份文档的正文不在了，请重新导入');
  if (!c.index) return toast('这份文档还没算过生词表');
  const list = vocab.wordsForSection(c.index, si);
  if (!list.length) {
    toast('这一节没有新词，直接读吧');
    return openSection(id, si);
  }
  await dict.ensureWords(list.map((w) => w.w));
  wordQueue = list;
  wordPos = 0;
  wordCtx = { id, si, thenRead };
  go('words');
}

function renderWords() {
  const v = $('#view-words');
  const { id, si } = wordCtx;

  if (wordPos >= wordQueue.length) {
    const m = bookMeta(id);
    m.learned[si] = 1;
    touchDay();
    save();
    v.innerHTML = `<div class="wordwrap">
      <div class="empty ui" style="padding-top:60px"><div class="g">词</div>
        这一节的 ${wordQueue.length} 个词过完了<br>
        <span style="font-size:12px">接着读，刚学的这些词马上会全部撞见</span></div>
      <button class="btn pri" data-act="sec" data-si="${si}">开始读第 ${si + 1} 节 ›</button>
      <div class="row" style="margin-top:10px">
        <button class="btn" data-act="home">返回</button>
        <button class="btn" data-act="againwords">再过一遍</button></div></div>`;
    wire('#view-words');
    return;
  }

  const w = wordQueue[wordPos];
  const saved = !!S.vocab[w.w];
  const egHtml = w.eg
    ? esc(w.eg).replace(new RegExp(`\\b(${w.w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\w*)\\b`, 'ig'), '<b>$1</b>')
    : '';
  v.innerHTML = `<div class="wordwrap">
    <div class="wordprog ui"><button data-act="home" style="color:var(--ink-faint)">✕</button>
      <span class="nbar"><i style="width:${(wordPos / wordQueue.length) * 100}%"></i></span>
      <span>${wordPos + 1}/${wordQueue.length}</span></div>
    <div class="wcard">
      <div class="w">${esc(w.w)}</div>
      ${w.p ? `<div class="ph">/${esc(w.p)}/</div>` : ''}
      ${(w.tags.length || w.stars) ? `<div class="tags">${w.tags.map((t) => `<i>${esc(t)}</i>`).join('')}
        ${w.stars ? `<i>常用度 ${w.stars}</i>` : ''}</div>` : ''}
      <div class="tr">${esc(w.t)}</div>
      ${egHtml ? `<div class="eg">“${egHtml}”</div>` : ''}
      <div class="cnt">这份文档里出现 ${w.n} 次${w.core ? ' · 后面还会反复撞见' : ''}</div>
    </div>
    <div class="wacts ui">
      <button data-act="sayw">🔊</button>
      <button data-act="keepw">${saved ? '已在生词本' : '＋ 生词本'}</button>
      <button class="pri" data-act="nextw">${wordPos === wordQueue.length - 1 ? '过完了 ›' : '下一个 ›'}</button>
    </div></div>`;
  wire('#view-words');
}

/* ================= 词典 + 生词本 ================= */

// 这一页有两层用途：上面是一本能直接查的词典，下面是攒下来的生词。
// 不给它单开一个 tab —— 「功能可以多，选择不能多」，查词和生词本本来就是一回事。

async function renderVocab() {
  updateBadges();
  const words = Object.entries(S.vocab).sort((a, b) => b[1].ts - a[1].ts);
  const v = $('#view-vocab');
  let h = `<div class="pagehead ui"><h2>词典</h2><small>生词 ${words.length} 个</small></div>
    <div class="lookup ui">
      <input id="lookupin" placeholder="查任意英文单词" autocapitalize="none"
        autocorrect="off" spellcheck="false" enterkeyhint="search">
      <button data-act="lookup">查</button>
    </div>
    <div id="lookupout"></div>`;
  if (!words.length) {
    h += `<div class="empty ui"><div class="g">词</div>上面可以直接查词<br>
      读文档时点任意单词也能查，再点「收入生词本」</div>`;
    v.innerHTML = h;
    wire('#view-vocab');
    wireLookup();
    return;
  }
  v.innerHTML = h + `<div class="empty ui">正在查词典…</div>`;
  await dict.ensureWords(words.map(([w]) => w));
  h += `<ul class="vlist">`;
  for (const [w, item] of words) {
    const r = dict.get(w);
    const t = r ? dict.firstLine((r.lemmaEntry || r.entry).t) : '';
    h += `<li><button data-act="openw" data-w="${esc(w)}">
      <span class="w">${esc(w)}</span><span class="m">${esc(t)}</span>
      <span class="due ui">${item.due <= Date.now() ? '待复习' : ''}</span></button></li>`;
  }
  v.innerHTML = h + `</ul>`;
  wire('#view-vocab');
  wireLookup();
}

function wireLookup() {
  const inp = $('#lookupin');
  if (inp) inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); doLookup(); } };
}

/** 直接查一个词。查词是这个应用的本事，没有理由非得先导一份文档进来才能用。 */
async function doLookup() {
  const inp = $('#lookupin');
  const raw = (inp.value || '').trim();
  const out = $('#lookupout');
  if (!raw) { out.innerHTML = ''; return; }

  out.innerHTML = `<div class="note" style="padding:14px 2px">正在查…</div>`;
  await dict.ensureWords([raw]);
  let r = dict.get(raw);
  if (r && r.entry.x) {
    await dict.ensureWords([r.entry.x]);       // 原形常常在别的分片里
    r = dict.get(raw);
  } else if (!r) {
    await dict.ensureShards(dict.compoundShards(raw));   // 拆词兜底
    r = dict.get(raw);
  }

  if (!r) {
    out.innerHTML = `<div class="empty ui" style="padding:26px 10px">
      没查到「${esc(raw)}」<br>
      <span style="font-size:12px">词典只收单词，词组和中文查不了</span></div>`;
    return;
  }

  const key = r.lemmaEntry ? r.lemma : r.word;
  const main = r.lemmaEntry || r.entry;
  const tags = dict.tagsOf(r);
  const st = dict.stars(main);
  const saved = !!S.vocab[key];
  out.innerHTML = `<div class="lookupcard">
    <div class="dw"><span class="w">${esc(key)}</span>
      ${main.p ? `<span class="ph">/${esc(main.p)}/</span>` : ''}</div>
    ${(tags.length || st) ? `<div class="dtags">${tags.map((t) => `<i>${esc(t)}</i>`).join('')}
      ${st ? `<i>常用度 ${st}</i>` : ''}</div>` : ''}
    <div class="dtrans">${esc(main.t || '')}</div>
    ${key !== dict.normalize(raw) ? `<div class="dbase">你查的是 ${esc(raw)}</div>` : ''}
    <div class="dacts ui">
      <button data-act="sayq" data-w="${esc(key)}">🔊 发音</button>
      <button class="${saved ? 'rm' : 'pri'}" data-act="keepq" data-w="${esc(key)}">
        ${saved ? '移出生词本' : '＋ 收入生词本'}</button>
    </div></div>`;
  wire('#lookupout');
}

/* ================= 复习 ================= */

let rvQueue = [];

async function renderReview() {
  updateBadges();
  const due = Object.entries(S.vocab).filter(([, v]) => v.due <= Date.now()).sort((a, b) => a[1].due - b[1].due);
  rvQueue = due.map(([w]) => w);
  if (rvQueue.length) await dict.ensureWords(rvQueue);
  nextCard();
}

function nextCard() {
  const v = $('#view-review');
  if (!rvQueue.length) {
    const total = Object.keys(S.vocab).length;
    v.innerHTML = `<div class="pagehead ui"><h2>复习</h2></div>
      <div class="empty ui"><div class="g">忆</div>${total
        ? '今天的复习完成了 ✓<br>到期的词会自动出现在这里'
        : '生词本还是空的<br>去读一节，点几个词收进来'}</div>`;
    updateBadges();
    return;
  }
  const w = rvQueue[0];
  const item = S.vocab[w];
  const r = dict.get(w);
  const main = r ? (r.lemmaEntry || r.entry) : {};
  v.innerHTML = `<div class="pagehead ui"><h2>复习</h2><small>还剩 ${rvQueue.length} 个</small></div>
    <div class="rvwrap"><div class="card">
      <div class="w">${esc(w)}</div>
      ${main.p ? `<div class="ph">/${esc(main.p)}/</div>` : ''}
      <div id="cardans"></div></div>
    <button class="showans ui" data-act="showans">显示释义</button>
    <div class="rvbtns ui" id="grades" hidden>
      <button class="b-again" data-act="grade" data-g="0">忘了</button>
      <button class="b-hard" data-act="grade" data-g="1">模糊</button>
      <button class="b-good" data-act="grade" data-g="2">认识</button>
    </div></div>`;
  v._ctx = { w, item, main };
  wire('#view-review');
}

function grade(g) {
  const { w } = $('#view-review')._ctx;
  const it = S.vocab[w];
  if (g === 0) { it.lvl = 0; it.due = Date.now() + 10 * 60 * 1000; }
  else if (g === 1) { it.due = Date.now() + 24 * 3600 * 1000; }
  else { it.lvl = Math.min(it.lvl + 1, IVL.length - 1); it.due = Date.now() + IVL[it.lvl] * 86400000; }
  S.nrev = (S.nrev || 0) + 1;
  touchDay();
  save();
  rvQueue.shift();
  nextCard();
}

/* ================= 进度 / 设置 ================= */

async function renderMe() {
  updateBadges();
  const readN = Object.values(S.books).reduce((n, b) => n + Object.keys(b.read || {}).length, 0);
  const st = store.syncStatus;
  const label = { idle: '尚未同步', syncing: '同步中…', ok: '已备份 · ' + relTime(st.at), offline: '离线，联网后自动重试' }[st.state];

  let h = `<div class="pagehead ui"><h2>进度</h2></div>
    <div class="stats ui">
      <div class="stat"><b>${streak()}</b><span>连续天数</span></div>
      <div class="stat"><b>${readN}</b><span>已读小节</span></div>
      <div class="stat"><b>${Object.keys(S.vocab).length}</b><span>生词</span></div>
    </div>`;

  // 单机版没有服务器，同步码这一整块不该出现 —— 换设备走下面的「手动备份」。
  if (!NATIVE) h += `<div class="mrow ui"><h3>云端备份 · 同步码</h3>
      <div class="synccode"><span class="code">${esc(store.SYNC_CODE)}</span>
        <button class="copy ui" data-act="copycode">复制</button></div>
      <div class="syncstatus ${st.state === 'ok' ? 'ok' : (st.state === 'offline' ? 'err' : '')} ui">
        <span class="dot"></span>${label}</div>
      <div class="note" style="margin-top:8px">这串码是这台设备的备份钥匙，不用记密码。
        换设备或清过浏览器数据后，在下面输入它就能取回进度和生词本。
        <b>文档本身不在备份里</b> —— 文档重新导入一次就有，进度丢了人就不读了。</div>
      <div class="syncrestore" style="margin-top:14px">
        <input id="syncin" placeholder="输入同步码恢复，如 K7M4X-9QPTR" maxlength="11" autocapitalize="characters">
        <button class="btn" style="margin-top:8px" data-act="restore">用这个码恢复数据</button></div></div>`;

  if (!NATIVE && APK) {
    h += `<div class="mrow ui"><h3>安卓 App</h3>
      <a class="btn ghost apkdl" href="/download/gloss.apk" download>下载 APK · ${esc(apkLabel())}</a>
      <div class="note" style="margin-top:8px">${IS_ANDROID
        ? '装完之后词典在本机，读书不用再连这台服务器。'
        : '这是安卓安装包，在安卓手机上打开这个页面才装得了。'}
        安装包里没有申请联网权限，装完就是彻底离线的。</div></div>`;
  }

  h += `<div class="mrow ui"><h3>离线词典</h3><div class="dlbox" id="dlbox">正在检查…</div></div>

    <div class="mrow ui"><h3>英语水平</h3>
      <button class="lvpick ui" data-act="level">
        <span class="n">${esc(dict.level().name)}</span>
        <span class="h">${esc(dict.level().hint)}</span>
        <span class="ck">改</span></button>
      <div class="note" style="margin-top:8px">这条线决定哪些词算生词：正文里标虚线的、
        过词时要过的，都按它来。改完会把已导入的文档重算一遍。</div></div>

    <div class="mrow ui"><h3>正文字号</h3><div class="fsbtns">
      <button data-act="fs" data-d="-1">A−</button><button data-act="fs" data-d="1">A＋</button>
      <span id="fsv">${S.settings.fs}px</span></div></div>

    <div class="mrow ui"><h3>手动备份</h3>
      <textarea class="iobox" id="iobox" placeholder="导出后复制保存；换设备时粘贴到这里再点导入"></textarea>
      <div class="row" style="margin-top:8px">
        <button class="btn" data-act="export">导出到上方</button>
        <button class="btn" data-act="import">从上方导入</button></div></div>`;

  if (bookIds().length) {
    h += `<div class="mrow ui"><h3>我的文档</h3><ul class="vlist">`;
    for (const id of bookIds()) {
      const b = S.books[id];
      h += `<li><button data-act="delbook" data-id="${id}">
        <span class="w" style="min-width:auto;flex:1;font-size:14px">${esc(b.title)}</span>
        <span class="due ui" style="color:var(--warn)">删除</span></button></li>`;
    }
    h += `</ul></div>`;
  }

  h += `<div class="foot">Gloss · 自己带文档，读得下去<br>
    词典数据来自开源项目 ECDICT（MIT 协议）<br>
    文档内容不离开这台设备</div>`;

  const v = $('#view-me');
  v.innerHTML = h;
  wire('#view-me');
  renderDictBox();
}

async function renderDictBox() {
  const box = $('#dlbox');
  if (!box) return;
  try {
    const man = await dict.loadManifest();
    if (NATIVE) {
      // 词典随安装包一起装进来了，既没得下载也没得清除。
      box.innerHTML = `<div class="t">${man.words.toLocaleString()} 词 · ${fmtSize(man.bytes)}</div>
        <div class="s">词典已随 App 装在本机，查词不联网、不下载、不占额外空间。</div>`;
      return;
    }
    const have = await dict.downloadedBytes();
    const pct = Math.round((have / man.bytes) * 100);
    box.innerHTML = `<div class="t">${man.words.toLocaleString()} 词 · 共 ${fmtSize(man.bytes)}</div>
      <div class="s">已缓存 ${fmtSize(have)}（${pct}%）。查过的词会自动留在本地；
        整本下下来之后，查词永久离线、永久免费。建议在 Wi-Fi 下进行。</div>
      <button class="btn ghost" data-act="dldict">${pct >= 99 ? '已全部下载 · 重新校验' : '下载完整词典'}</button>
      ${have > 0 ? `<button class="btn" style="margin-top:8px" data-act="cleardict">清除已下载的词典</button>` : ''}`;
    wire('#dlbox');
  } catch {
    box.textContent = NATIVE ? '词典读不出来，安装包可能不完整。' : '词典清单读不到，请确认服务器在运行。';
  }
}

/* ================= 事件绑定 ================= */

// 所有按钮都用 data-act 声明意图，在这里统一分发，省掉一堆零散的 onclick。
const ACTIONS = {
  home: () => go('home'),
  add: () => $('#filepick').click(),
  paste: () => openPasteSheet(),
  pastego: () => {
    const t = $('#pastebox').value;
    closeSheet();
    importPasted(t);
  },
  lookup: () => doLookup(),
  sayq: (el) => speak(el.dataset.w, 0.85),
  keepq: (el) => {
    const w = el.dataset.w;
    if (S.vocab[w]) { delete S.vocab[w]; toast('已移出生词本'); }
    else {
      S.vocab[w] = { ts: Date.now(), due: Date.now(), lvl: 0, src: '', book: '', sec: 0 };
      touchDay();
      toast('已收入生词本');
    }
    save();
    const q = $('#lookupin') ? $('#lookupin').value : '';
    renderVocab().then(() => { if (q) { $('#lookupin').value = q; doLookup(); } });
  },
  accept: () => acceptImport(),
  level: () => openLevelSheet(),
  setlevel: (el) => { closeSheet(); setLevel(el.dataset.id); },
  open: (el) => {
    const id = el.dataset.id;
    S.books[id].lastOpen = Date.now();
    save();
    openSection(id, Math.min(S.books[id].cur || 0, S.books[id].n - 1));
  },
  tonight: (el) => {
    const id = el.dataset.id, m = S.books[id];
    const si = Math.min(m.cur || 0, m.n - 1);
    // 一个主按钮，App 自己决定今晚该干什么：词没过就先过词，过完了就读
    if (m.secWords && m.secWords[si] && !m.learned[si]) startWords(id, si, true);
    else openSection(id, si);
  },
  onlywords: (el) => {
    const id = el.dataset.id, m = S.books[id];
    startWords(id, Math.min(m.cur || 0, m.n - 1), false);
  },
  onlyread: (el) => {
    const id = el.dataset.id, m = S.books[id];
    openSection(id, Math.min(m.cur || 0, m.n - 1));
  },
  secwords: (el) => startWords(el.dataset.id, +el.dataset.si, false),
  sec: (el) => {
    const si = +el.dataset.si;
    const id = wordCtx && route.view === 'words' ? wordCtx.id : route.id;
    openSection(id, si);
  },
  done: () => {
    markSectionDone(route.id, route.si);
    const m = bookMeta(route.id);
    if (route.si + 1 < m.n) { m.cur = route.si + 1; save(); }
  },
  closesheet: () => closeSheet(),
  toc: (el) => openTocSheet(el.dataset.id || route.id),
  tocfront: () => { tocOpenFront = !tocOpenFront; openTocSheet(tocCtx); },
  gosec: (el) => { closeSheet(); openSection(el.dataset.id, +el.dataset.si); },
  say: () => speak(sheetCtx.key, 0.85),
  savew: () => toggleSave(),
  sayw: () => speak(wordQueue[wordPos].w, 0.85),
  keepw: () => {
    const w = wordQueue[wordPos];
    if (!S.vocab[w.w]) {
      S.vocab[w.w] = {
        ts: Date.now(), due: Date.now(), lvl: 0,
        src: w.eg || '', book: wordCtx.id, sec: wordCtx.si,
      };
      touchDay();
      save();
      toast('已收入生词本');
      renderWords();
    }
  },
  nextw: () => { wordPos++; renderWords(); },
  againwords: () => { wordPos = 0; renderWords(); },
  openw: async (el) => {
    const w = el.dataset.w;
    await dict.ensureWords([w]);
    const item = S.vocab[w] || {};
    openSheet(w, item.src || '', item.book, item.sec);
  },
  showans: () => {
    const { item, main } = $('#view-review')._ctx;
    $('#cardans').innerHTML = `<div class="ans">${esc(main.t || '')}</div>
      ${item.src ? `<div class="src">“${esc(item.src)}”</div>` : ''}`;
    $('#view-review [data-act="showans"]').hidden = true;
    $('#grades').hidden = false;
    speak($('#view-review')._ctx.w, 0.85);
  },
  grade: (el) => grade(+el.dataset.g),
  copycode: () => copyText(store.SYNC_CODE),
  restore: async () => {
    const raw = ($('#syncin').value || '').trim().toUpperCase();
    if (!store.SYNC_RE.test(raw)) return toast('码的格式不对，请检查');
    if (raw === store.SYNC_CODE) return toast('这就是当前设备的码');
    if (!confirm('这会用该同步码里保存的数据，覆盖本设备当前的进度和生词本，确定吗？')) return;
    busy.show('正在恢复…', null);
    const r = await store.pullSync(raw, { force: true });
    busy.hide();
    if (r.ok && r.found) {
      store.setSyncCode(raw);
      toast('已恢复。文档需要在这台设备上重新导入一次');
      go('me');
    } else if (r.ok) toast('没有找到这个码对应的数据');
    else toast('网络异常，请稍后重试');
  },
  fs: (el) => {
    S.settings.fs = Math.min(24, Math.max(14, S.settings.fs + +el.dataset.d));
    save();
    document.documentElement.style.setProperty('--fs', S.settings.fs + 'px');
dict.setLevel(S.settings.level);
    $('#fsv').textContent = S.settings.fs + 'px';
  },
  export: () => {
    const box = $('#iobox');
    box.value = JSON.stringify(S);
    box.select();
    copyText(box.value);
  },
  import: () => {
    try {
      const s = JSON.parse($('#iobox').value);
      if (!s.vocab || !s.settings) throw 0;
      store.replaceState(s);
      toast('导入成功');
      go('me');
    } catch { toast('数据格式不对，导入失败'); }
  },
  dldict: async () => {
    const man = await dict.loadManifest();
    if (!confirm(`将下载完整词典约 ${fmtSize(man.bytes)}，之后查词永久离线。继续吗？`)) return;
    busy.show('正在下载词典…', 0);
    await dict.downloadAll((d, t) => busy.show(`正在下载词典 ${d}/${t}`, d / t));
    busy.hide();
    toast('词典已全部存到本地');
    renderDictBox();
  },
  cleardict: async () => {
    if (!confirm('清除后需要联网才能查词，确定吗？')) return;
    await dict.clearDownload();
    toast('已清除');
    renderDictBox();
  },
  delbook: async (el) => {
    const id = el.dataset.id;
    if (!confirm(`删除「${S.books[id].title}」？\n\n进度和生词本会保留，重新导入同一个文件就能接着读。`)) return;
    await db.delBook(id);
    await db.delVocabIndex(id);
    delete S.books[id];
    save();
    if (CUR.id === id) CUR = { id: null, book: null, index: null };
    toast('已删除');
    go('me');
  },
};

function wire(root) {
  $$('[data-act]', $(root)).forEach((el) => {
    el.onclick = (ev) => {
      ev.stopPropagation();
      const fn = ACTIONS[el.dataset.act];
      if (fn) fn(el, ev);
    };
  });
}

function updateBadges() {
  const n = Object.values(S.vocab).filter((v) => v.due <= Date.now()).length;
  const b = $('#rbadge');
  b.hidden = !n;
  b.textContent = n;
}

/* ================= 启动 ================= */

document.documentElement.style.setProperty('--fs', S.settings.fs + 'px');
dict.setLevel(S.settings.level);
store.onSync(() => { if (route.view === 'me') renderMe(); });
go('home');

// 硬件返回键：页面没用 history，goBack() 是空的，所以「返回」的语义在这里定义 ——
// 先关浮层，再退回首页，两样都没有才让壳把 App 收到后台。
if (NATIVE) {
  window.__glossBack = () => {
    if ($('#sheet').classList.contains('on')) { closeSheet(); return true; }
    if (route.view !== 'home') { go('home'); return true; }
    return false;
  };
}

loadApkInfo().then(() => { if (route.view === 'home') renderHome(); });

dict.loadManifest().catch(() => toast(NATIVE ? '词典加载失败，安装包可能不完整' : '词典清单加载失败，请确认服务器在运行'));
store.initSync();
// 单机版的资源本来就在本地，Service Worker 只剩添乱（还会拦截 assets 请求）。
if (!NATIVE && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
