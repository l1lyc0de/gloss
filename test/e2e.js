// Gloss 端到端验证：真导入一本 EPUB，走完 预览 → 过词 → 阅读 → 查词 → 收生词 → 复习。
const { chromium } = require('playwright');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BOOK = process.argv[2] || path.join(ROOT, 'The Courage to be Disliked How to Change Your Life and Achieve Real Happiness by Ichiro Kishimi Fumitake Koga (z-lib.org).epub');
const SHOT = __dirname;

const log = (...a) => console.log(...a);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => { errors.push('pageerror: ' + e.message); });
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  log('✓ 首页加载');

  // 导入
  await page.setInputFiles('#filepick', BOOK);
  await page.waitForSelector('#view-import.on .preview p', { timeout: 180000 });
  const meta = await page.textContent('.impmeta .s');
  const previewParas = await page.$$eval('.preview p', (ns) => ns.map((n) => n.textContent));
  log('✓ 预览闸门：' + meta.replace(/\s+/g, ' ').trim());
  log('  首段：' + previewParas[0].slice(0, 110) + '…');
  const flags = await page.$$eval('.flag', (ns) => ns.map((n) => n.textContent.trim()));
  if (flags.length) log('  提示：' + flags.join(' | '));

  // 确认导入 → 会跑全书词形扫描
  await page.click('[data-act="accept"]');
  await page.waitForSelector('#view-home.on .tonight', { timeout: 300000 });
  const tonight = (await page.textContent('.tonight')).replace(/\s+/g, ' ').trim();
  log('✓ 导入完成，今晚主按钮：' + tonight);

  const stats = await page.evaluate(async () => {
    const req = indexedDB.open('gloss');
    const db = await new Promise((r) => { req.onsuccess = () => r(req.result); });
    const idx = await new Promise((r) => {
      const t = db.transaction('vocabIndex').objectStore('vocabIndex').getAll();
      t.onsuccess = () => r(t.result[0]);
    });
    const perSec = idx.bySection.map((a) => a.length).filter((n) => n > 0).sort((a, b) => a - b);
    const top = Object.values(idx.words).sort((a, b) => b.n - a.n).slice(0, 6);
    return {
      stats: idx.stats,
      sections: idx.bySection.length,
      medianPerSection: perSec[perSec.length >> 1],
      min: perSec[0], max: perSec[perSec.length - 1],
      top: top.map((w) => `${w.w}(${w.n})`),
      sampleEg: top[0] && top[0].eg,
    };
  });
  log('✓ 词汇索引漏斗：');
  log(`  ${stats.stats.forms} unique 词形 → ${stats.stats.merged} 查到词典 → ${stats.stats.candidates} 生词 → ${stats.stats.core} 核心词`);
  log(`  ${stats.sections} 节，每节新词 中位数 ${stats.medianPerSection}（${stats.min}–${stats.max}）`);
  log('  书内 Top: ' + stats.top.join(' '));
  log('  例句样本：' + String(stats.sampleEg).slice(0, 120));

  // 主按钮 → 过词
  await page.click('.tonight');
  await page.waitForSelector('#view-words.on .wcard', { timeout: 60000 });
  const card = await page.evaluate(() => ({
    w: document.querySelector('.wcard .w').textContent,
    ph: (document.querySelector('.wcard .ph') || {}).textContent,
    tags: [...document.querySelectorAll('.wcard .tags i')].map((n) => n.textContent),
    tr: document.querySelector('.wcard .tr').textContent.split('\n')[0],
    eg: (document.querySelector('.wcard .eg') || {}).textContent,
    cnt: document.querySelector('.wcard .cnt').textContent,
    prog: document.querySelector('.wordprog span:last-child').textContent,
  }));
  log('✓ 过词卡片 ' + card.prog + '：' + card.w + ' ' + (card.ph || ''));
  log('  ' + card.tags.join(' ') + ' | ' + card.tr);
  log('  例句 ' + String(card.eg).slice(0, 130));
  log('  ' + card.cnt);
  await page.screenshot({ path: path.join(SHOT, 'shot-words.png') });

  // 收进生词本，再翻两个词
  await page.click('[data-act="keepw"]');
  await page.click('[data-act="nextw"]');
  await page.click('[data-act="nextw"]');
  log('✓ 过词交互（收藏 + 翻页）正常');

  // 直接跳到阅读
  await page.click('#view-words [data-act="home"]');
  await page.waitForSelector('#view-home.on');
  await page.click('[data-act="onlyread"]');
  await page.waitForSelector('#view-read.on .para w', { timeout: 60000 });
  const readInfo = await page.evaluate(() => ({
    where: document.querySelector('.rhead .where').textContent,
    title: document.querySelector('.sec-t').textContent,
    paras: document.querySelectorAll('.para').length,
    words: document.querySelectorAll('w').length,
    hard: document.querySelectorAll('w.hard').length,
    saved: document.querySelectorAll('w.saved').length,
    first: document.querySelector('.para .en').textContent.slice(0, 100),
  }));
  log('✓ 阅读器：' + readInfo.where + ' · ' + readInfo.title);
  log(`  ${readInfo.paras} 段 / ${readInfo.words} 个可点词 / ${readInfo.hard} 个标了虚线 / ${readInfo.saved} 个已收藏`);
  log('  ' + readInfo.first + '…');

  // 点一个超纲词查词
  const target = await page.$('w.hard');
  const targetWord = await target.textContent();
  await target.click();
  await page.waitForSelector('#sheet.on .dtrans');
  const sheet = await page.evaluate(() => ({
    w: document.querySelector('#sheet .w').textContent,
    ph: (document.querySelector('#sheet .ph') || {}).textContent,
    tags: [...document.querySelectorAll('#sheet .dtags i')].map((n) => n.textContent),
    tr: document.querySelector('#sheet .dtrans').textContent.split('\n')[0],
    base: (document.querySelector('#sheet .dbase') || {}).textContent,
    src: (document.querySelector('#sheet .dsrc') || {}).textContent,
  }));
  log(`✓ 点词「${targetWord}」→ ${sheet.w} ${sheet.ph || ''} ${sheet.tags.join(' ')}`);
  log('  ' + sheet.tr);
  if (sheet.base) log('  ' + sheet.base);
  log('  出处 ' + String(sheet.src).slice(0, 100));
  await page.screenshot({ path: path.join(SHOT, 'shot-read.png') });

  await page.click('[data-act="savew"]');
  await page.waitForSelector('#sheet:not(.on)');
  log('✓ 收入生词本');

  // 读完这一节
  await page.click('[data-act="done"]');
  await page.waitForFunction(() => document.querySelector('.donebtn').classList.contains('done'));
  log('✓ 打卡「读完这一节」');

  // 生词本 + 复习
  await page.click('[data-tab="vocab"]');
  await page.waitForSelector('#view-vocab.on .vlist li', { timeout: 30000 });
  const vn = await page.$$eval('#view-vocab .vlist li', (n) => n.length);
  const vfirst = (await page.textContent('#view-vocab .vlist li')).replace(/\s+/g, ' ').trim();
  log(`✓ 生词本 ${vn} 个词，例：${vfirst}`);

  await page.click('[data-tab="review"]');
  await page.waitForSelector('#view-review.on .card .w', { timeout: 30000 });
  await page.click('[data-act="showans"]');
  await page.waitForSelector('#cardans .ans');
  const rv = (await page.textContent('#view-review .card')).replace(/\s+/g, ' ').trim();
  log('✓ 复习卡：' + rv.slice(0, 120));
  await page.click('[data-act="grade"][data-g="2"]');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => JSON.parse(localStorage.gloss_state_v1));
  const graded = Object.values(after.vocab).find((v) => v.lvl > 0);
  log(`✓ 评分后间隔重复生效：lvl=${graded.lvl}，下次 ${Math.round((graded.due - Date.now()) / 86400000)} 天后`);

  // 进度页 + 同步
  await page.click('[data-tab="me"]');
  await page.waitForSelector('#view-me.on #dlbox .t', { timeout: 30000 });
  const me = await page.evaluate(() => ({
    stats: [...document.querySelectorAll('.stat')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
    code: document.querySelector('.synccode .code').textContent,
    sync: document.querySelector('.syncstatus').textContent.trim(),
    dict: document.querySelector('#dlbox .t').textContent,
    dictS: document.querySelector('#dlbox .s').textContent.replace(/\s+/g, ' ').trim(),
  }));
  log('✓ 进度页：' + me.stats.join(' | '));
  log('  同步码 ' + me.code + ' · ' + me.sync);
  log('  词典 ' + me.dict + ' — ' + me.dictS.slice(0, 60));
  await page.screenshot({ path: path.join(SHOT, 'shot-me.png') });

  // 服务器上真的落盘了吗
  const synced = await page.evaluate(async (c) => {
    for (let i = 0; i < 40; i++) {
      const j = await (await fetch('/api/sync/' + c)).json();
      if (j.found) return j;
      await new Promise((r) => setTimeout(r, 250));
    }
    return { found: false };
  }, me.code);
  log(`✓ 同步码落盘：found=${synced.found}，服务器上有 ${Object.keys(synced.data ? synced.data.vocab : {}).length} 个生词，${Object.keys(synced.data ? synced.data.books : {}).length} 本书的进度`);
  if (!synced.found) throw new Error('同步没有落盘');

  await browser.close();
  if (errors.length) {
    console.log('\n⚠️ 控制台报错：');
    errors.slice(0, 12).forEach((e) => console.log('  ' + e));
    process.exit(1);
  }
  console.log('\n全部通过，无控制台报错。');
})().catch((e) => { console.error('✗ 失败：', e.message); process.exit(1); });
