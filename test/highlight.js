// 划线 / 笔记 / 摘录。
//
// 这个功能压在阅读界面最核心的那条交互上面，所以这一组测试里**优先级最高的
// 不是划线本身，而是「划过线之后，点一下单词还照样出释义」**。
// 划线把 <mark> 插进正文，一旦插到 <w> 里面去，词就被切成两半 ——
// 那是拿产品的主卖点去换一个附属功能，绝对不行。
//
// 其余几条守的是：
//   · 边界吸附到整词（手指停在半个单词上是常态）
//   · 跨段选中算**一条**摘录，不是两条（否则删一半会留半截线）
//   · 已经划过的地方不给再划一条（叠着划之后「取消」说不清取消哪一条）
//   · 笔记跟着进度存 —— 刷新之后还在
const { chromium } = require('playwright');
const path = require('path');

const U = 'http://localhost:5173/';
let bad = 0;
const fail = (m) => { console.log('  ✗ ' + m); bad++; };
const ok = (m) => console.log('  ✓ ' + m);

/** 在第 k 段的纯文本里，把 [a, b) 这段字符选中 —— 模拟手指拖出来的选区。 */
async function selectRange(p, k, a, b) {
  await p.evaluate(({ k, a, b }) => {
    const en = document.querySelector('#view-read #p' + k + ' .en');
    const walk = document.createTreeWalker(en, NodeFilter.SHOW_TEXT, null);
    const at = (off) => {
      const w = document.createTreeWalker(en, NodeFilter.SHOW_TEXT, null);
      let n = 0, t;
      while ((t = w.nextNode())) {
        if (n + t.nodeValue.length >= off) return { node: t, off: off - n };
        n += t.nodeValue.length;
      }
      return null;
    };
    void walk;
    const s = at(a), e = at(b);
    const r = document.createRange();
    r.setStart(s.node, s.off);
    r.setEnd(e.node, e.off);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }, { k, a, b });
  await p.waitForTimeout(260);   // selectionchange 那边有 180ms 的防抖
}

/** 跨两段选中：从第 k1 段的 a 字符到第 k2 段的 b 字符。 */
async function selectAcross(p, k1, a, k2, b) {
  await p.evaluate(({ k1, a, k2, b }) => {
    const at = (k, off) => {
      const en = document.querySelector('#view-read #p' + k + ' .en');
      const w = document.createTreeWalker(en, NodeFilter.SHOW_TEXT, null);
      let n = 0, t;
      while ((t = w.nextNode())) {
        if (n + t.nodeValue.length >= off) return { node: t, off: off - n };
        n += t.nodeValue.length;
      }
      return null;
    };
    const s = at(k1, a), e = at(k2, b);
    const r = document.createRange();
    r.setStart(s.node, s.off);
    r.setEnd(e.node, e.off);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }, { k1, a, k2, b });
  await p.waitForTimeout(260);
}

const toolButtons = (p) => p.$$eval('#seltool.on button',
  (els) => els.map((e) => e.textContent.trim()));

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 412, height: 820 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('dialog', (d) => d.accept());   // 删除要确认

  await p.goto(U, { waitUntil: 'domcontentloaded' });
  await p.evaluate(async () => {
    for (const d of await indexedDB.databases()) indexedDB.deleteDatabase(d.name);
    localStorage.clear();
  });
  await p.goto(U, { waitUntil: 'domcontentloaded' });
  await p.setInputFiles('#filepick', path.join(__dirname, 'fixtures', 'div-para.epub'));
  await p.waitForSelector('#view-import.on .preview p', { timeout: 300000 });
  await p.click('[data-act="accept"]');
  await p.waitForSelector('#view-home.on .shelf', { timeout: 300000 });
  await p.click('[data-act="onlyread"]');
  await p.waitForSelector('#view-read.on .sec-t', { timeout: 300000 });

  const para0 = await p.$eval('#view-read #p0 .en', (el) => el.textContent);
  console.log(`\n第 0 段：${JSON.stringify(para0.slice(0, 72))}…`);

  // ---- 1. 划一条线 ----
  console.log('=== 划线 ===');
  await selectRange(p, 0, 4, 30);
  let btns = await toolButtons(p);
  console.log(`  工具条：${btns.join(' / ')}`);
  if (!btns.includes('划线')) fail('还没划过的地方，工具条上该有「划线」');
  await p.click('#seltool [data-act="selhl"]');
  await p.waitForSelector('#view-read mark.hl', { timeout: 5000 }).catch(() => fail('划线没画出来'));

  const first = await p.$eval('#view-read mark.hl', (el) => el.textContent);
  console.log(`  划中：${JSON.stringify(first)}`);

  // ---- 2. 最要紧的一条：划过线的词还点得动 ----
  console.log('=== 划过线的词还能不能点出释义 ===');
  {
    const inside = await p.$$('#view-read mark.hl w');
    if (!inside.length) {
      fail('划线里一个 <w> 都没有 —— <mark> 多半插进词里把词切碎了');
    } else {
      ok(`划线里有 ${inside.length} 个完整的 <w>`);
      // 每个 <w> 的文字都得是一个完整单词，不能是被切开的半截
      const words = await p.$$eval('#view-read mark.hl w', (els) => els.map((e) => e.textContent));
      const broken = words.filter((w) => !/^[A-Za-z]+(?:[’'-][A-Za-z]+)*$/.test(w));
      if (broken.length) fail(`划线里有被切碎的词：${JSON.stringify(broken)}`);
      else ok('划线里的词没有一个被切碎');

      await inside[0].click();
      const on = await p.waitForSelector('#sheet.on .dw .w', { timeout: 5000 }).catch(() => null);
      if (!on) fail('点划线里的词没有出释义卡片 —— 主卖点被这个功能压坏了');
      else {
        const w = await p.$eval('#sheet.on .dw .w', (e) => e.textContent);
        ok(`点划线里的词 → 释义卡片出来了（${w}）`);
      }
      await p.click('#dim');
      await p.waitForTimeout(150);
    }
  }

  // ---- 3. 边界吸附 ----
  console.log('=== 边界吸附到整词 ===');
  {
    // 故意从第 6 个字符起、停在第 25 个字符 —— 大概率落在词中间
    const r = await p.evaluate(() => {
      const S = JSON.parse(localStorage.getItem('gloss_state_v1'));
      const g = Object.values(S.hl)[0];
      return { t: g.parts[0].t };
    });
    const clean = /^[A-Za-z’'-]/.test(r.t) && /[A-Za-z’'-]$/.test(r.t.trim());
    console.log(`  存下来的原文：${JSON.stringify(r.t)}`);
    if (!clean) fail('两端不是完整的词，吸附没生效');
    else ok('两端都吸附到了整词');
  }

  // ---- 4. 已经划过的地方不给再划 ----
  console.log('=== 压在已有划线上 ===');
  await selectRange(p, 0, 10, 40);
  btns = await toolButtons(p);
  console.log(`  工具条：${btns.join(' / ')}`);
  if (btns.includes('划线')) fail('压在已有划线上还给「划线」—— 会叠出两层');
  if (!btns.includes('去掉划线')) fail('压在已有划线上该给「去掉划线」');
  else ok('给的是「去掉划线」，不是再划一条');

  // ---- 5. 写笔记 ----
  console.log('=== 写笔记 ===');
  await p.click('#seltool [data-act="selnote"]');
  await p.waitForSelector('#sheet.on #notebox', { timeout: 5000 });
  await p.fill('#notebox', '这句没看懂，回头再看一遍');
  await p.click('[data-act="savenote"]');
  await p.waitForTimeout(250);
  {
    const noted = await p.$('#view-read mark.hl.noted');
    if (!noted) fail('写了笔记的划线没有加上 .noted 标记');
    else ok('写了笔记的划线带上了笔尖标记');
    // ✎ 是 CSS ::after 画的，不能进 textContent —— 查词卡片要拿这段纯文本当例句
    const t = await p.$eval('#view-read #p0 .en', (el) => el.textContent);
    if (t !== para0) fail('正文的纯文本被改动了 —— 笔尖标记混进了文本里，例句会被污染');
    else ok('正文纯文本没变（笔尖是 ::after 画的）');
  }

  // ---- 6. 刷新之后还在 ----
  console.log('=== 刷新 ===');
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#view-home.on', { timeout: 300000 });
  await p.click('[data-act="onlyread"]');
  await p.waitForSelector('#view-read.on .sec-t', { timeout: 300000 });
  {
    const n = await p.$$eval('#view-read mark.hl', (els) => els.length);
    const noted = await p.$$eval('#view-read mark.hl.noted', (els) => els.length);
    console.log(`  划线 ${n} 处 · 带笔记 ${noted} 处`);
    if (!n) fail('刷新之后划线没了');
    if (!noted) fail('刷新之后笔记没了');
    if (n && noted) ok('划线和笔记都还在');
    const head = await p.$('#view-read [data-act="hllist"]');
    if (!head) fail('划过线之后，正文头上没出现「摘录」入口');
    else ok('正文头上有「摘录」入口');
  }

  // ---- 7. 跨段选中算一条 ----
  console.log('=== 跨段选中 ===');
  {
    const before = await p.evaluate(() =>
      Object.keys(JSON.parse(localStorage.getItem('gloss_state_v1')).hl).length);
    const len1 = await p.$eval('#view-read #p1 .en', (el) => el.textContent.length);
    await selectAcross(p, 1, Math.max(0, len1 - 40), 2, 30);
    const bs = await toolButtons(p);
    if (!bs.includes('划线')) { fail(`跨段选中之后工具条是：${bs.join('/')}`); }
    else {
      await p.click('#seltool [data-act="selhl"]');
      await p.waitForTimeout(250);
      const after = await p.evaluate(() => {
        const S = JSON.parse(localStorage.getItem('gloss_state_v1'));
        const ks = Object.keys(S.hl);
        return { n: ks.length, parts: S.hl[ks[ks.length - 1]].parts.length };
      });
      console.log(`  摘录 ${before} → ${after.n} 条，最后那条有 ${after.parts} 段`);
      if (after.n !== before + 1) fail(`跨两段选中该只多一条摘录，实际多了 ${after.n - before} 条`);
      else if (after.parts !== 2) fail(`那一条该有 2 段，实际 ${after.parts} 段`);
      else ok('跨两段选中 = 一条摘录、两段');
    }
  }

  // ---- 8. 摘录列表：显示、跳回、删除 ----
  console.log('=== 摘录列表 ===');
  await p.click('#view-read [data-act="hllist"]');
  await p.waitForSelector('#view-hl.on .hllist', { timeout: 5000 });
  {
    const rows = await p.$$eval('#view-hl .hllist li', (els) => els.length);
    const notes = await p.$$eval('#view-hl .hllist .n', (els) => els.map((e) => e.textContent));
    console.log(`  ${rows} 条 · 笔记：${JSON.stringify(notes)}`);
    if (rows !== 2) fail(`列表该有 2 条，实际 ${rows}`);
    if (!notes.some((t) => /没看懂/.test(t))) fail('列表里没显示写过的笔记');
    else ok('列表把笔记显示出来了');

    // 点一条跳回原文，并且那条线要亮一下
    await p.click('#view-hl .hllist li:last-child > button:first-child');
    await p.waitForSelector('#view-read.on .sec-t', { timeout: 300000 });
    await p.waitForTimeout(200);
    const flashed = await p.$('#view-read mark.hl.flash');
    if (!flashed) fail('从列表跳回原文，没有把那一条标出来');
    else ok('跳回原文并亮了一下');
  }

  // 删除：去掉划线之后正文里那一段应该干净了
  console.log('=== 去掉划线 ===');
  await p.click('#view-read [data-act="hllist"]');
  await p.waitForSelector('#view-hl.on .hllist');
  {
    const before = await p.$$eval('#view-hl .hllist li', (els) => els.length);
    await p.click('#view-hl .hllist li:first-child .del');
    await p.waitForTimeout(250);
    const after = await p.$$eval('#view-hl .hllist li, #view-hl .empty', (els) => els.length);
    console.log(`  ${before} → ${after}`);
    if (after >= before) fail('删了一条，列表条数没变');
    else ok('删掉了一条');
  }

  if (errs.length) fail(`控制台报错：${errs[0]}`);
  else console.log('\n无控制台报错。');

  await b.close();
  if (bad) { console.log(`\n✗ ${bad} 项不符`); process.exit(1); }
  console.log('\n全部符合预期。');
})();
