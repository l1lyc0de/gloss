// 「点一下单词，释义直接出来」——这句话的现场演示。
//
// 这是整个产品最该说清的一件事，而它恰好是三秒内可以自证的：
// 与其写形容词，不如摆一句英文让人当场点一下。
// 下载页（还没装的人）和首页空态（装了但还没导文档的人）用的是这同一份，
// 抄两份必然会写歪 —— 所以数据和卡片渲染都只在这里。
//
// **六条词典条目硬编码在下面**，是故意的，有两个理由：
//   1. 演示必须是瞬时的。真词典按首两字母分片，这六个词落在六片上，
//      加起来 1.6 MB —— 为了演示先下 1.6 MB，正好把要证明的事情证伪了。
//      （真实阅读里之所以点一下就出，是因为进一节之前 ensureSectionDict
//      已经把这一节要用的分片准备好了；演示自带数据是同一个道理。）
//   2. 下载页不该为了这一句演示去依赖整套词典和 IndexedDB。
//
// 条目是从 public/dict/ 里原样抄的，一个字没改：装完之后点同一个词，
// 看到的就是这段字。改动这里之前先去分片里对一遍。

import { TAGMAP, stars } from './dict.js';

/** 演示句。[显示形态, 词典里的词]，第二项为空 = 不带虚线、点了没反应 ——
 *  和真实阅读里「认为你已经会的词不标」是同一条规矩。 */
export const SENT = [
  ['The', ''], ['detective', 'detective'], ['examined', 'examine'], ['the', ''],
  ['peculiar', 'peculiar'], ['fragments', 'fragment'], ['gleaming', 'gleam'],
  ['on', ''], ['the', ''], ['threshold', 'threshold'],
];

/** 句末标点。单独放着是因为它不该是一个可点的 token。 */
export const END = '.';

export const ENTRIES = {
  detective: { t: "n. 侦探\na. 侦探的",
    p: "di'tektiv", g: "gk cet6 ky toefl ielts", s: 3 },
  examine: { t: "v. 检查, 调查, 考试",
    p: "ig'zæmin", g: "zk gk cet4 cet6 ky", s: 4 },
  peculiar: { t: "a. 奇特的, 罕见的, 特殊的, 特别的\nn. 特有财产, 特权",
    p: "pi'kju:ljә", g: "cet4 cet6 ky toefl ielts", s: 2 },
  fragment: { t: "n. 碎片, 破片, 片段\n[计] 段落; 片段; 分段",
    p: "'frægmәnt", g: "cet4 cet6 ky toefl ielts gre", s: 2 },
  gleam: { t: "n. 光束, 微光, 反光\nvi. 闪烁, 隐约地闪现\nvt. 使发微光, 使闪烁",
    p: "gli:m", g: "cet6 toefl ielts gre", s: 2 },
  threshold: { t: "n. 门槛, 入口, 开端, 阈\n[计] 阈; 阈值",
    p: "'θreʃәuld", g: "cet6 ky toefl ielts", s: 2 },
};

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** 演示句的 HTML。可点的词就是应用里那个 <w>，虚线也是同一条 CSS。 */
export function sentHTML() {
  return SENT.map(([raw, key], i) => (i ? ' ' : '') + (key
    ? `<w class="hard" data-w="${esc(raw)}" data-k="${esc(key)}">${esc(raw)}</w>`
    : esc(raw))).join('') + END;
}

/**
 * 释义卡的内容。字段顺序和读书界面里的查词卡片一致（词、音标、标签、释义、原文形态），
 * 少的只有「发音」和「收入生词本」两个按钮 —— 演示不该往生词本里塞东西。
 */
export function cardHTML(raw, key) {
  const e = ENTRIES[key];
  if (!e) return '';
  const tags = (e.g || '').split(/\s+/).map((t) => TAGMAP[t]).filter(Boolean);
  const st = stars(e);
  let h = `<div class="dw"><span class="w">${esc(key)}</span>`;
  if (e.p) h += `<span class="ph">/${esc(e.p)}/</span>`;
  h += `</div>`;
  if (tags.length || st) {
    h += `<div class="dtags">${tags.map((t) => `<i>${esc(t)}</i>`).join('')}` +
      `${st ? `<i>常用度 ${st}</i>` : ''}</div>`;
  }
  h += `<div class="dt">${esc(e.t)}</div>`;
  // 点的是 examined，出来的是 examine —— 词形还原也是「一下就到」的一部分
  if (raw.toLowerCase() !== key) h += `<div class="db">原文形态 ${esc(raw)}</div>`;
  return h;
}

/**
 * 把一块演示接上事件。容器里要有 .demo-en 和 .demo-card 两个元素。
 * 两个页面共用，免得一边改了另一边忘。
 */
export function wireDemo(root) {
  const line = root.querySelector('.demo-en');
  const card = root.querySelector('.demo-card');
  if (!line || !card) return;
  line.innerHTML = sentHTML();
  line.querySelectorAll('w').forEach((el) => {
    el.onclick = () => {
      line.querySelectorAll('w').forEach((x) => x.classList.remove('lit'));
      el.classList.add('lit');
      card.innerHTML = cardHTML(el.dataset.w, el.dataset.k);
      card.classList.add('on');
    };
  });
}
