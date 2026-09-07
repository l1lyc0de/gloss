// 词典页直接查词 + 粘贴一段英文。
const { chromium } = require('playwright');
let bad = 0;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport:{width:420,height:900} });
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: '+e.message));
  p.on('console', m => { if (m.type()==='error') errs.push('console: '+m.text()); });
  await p.goto('http://localhost:5173/', { waitUntil:'networkidle' });
  if (await p.locator('.streakline').count()) { console.log('✗ 空书架不应显示零统计'); bad++; }
  if (!await p.locator('.addbook.primary').isVisible()) { console.log('✗ 空书架缺少主要导入入口'); bad++; }

  // ---- 词典直接查词 ----
  await p.click('[data-tab="vocab"]');
  await p.waitForSelector('#lookupin');
  for (const w of ['indemnify', 'running', 'cannot', 'wouldn\'t', 'zzzznotaword']) {
    await p.fill('#lookupin', w);
    await p.click('[data-act="lookup"]');
    await p.waitForFunction(() => {
      const o = document.querySelector('#lookupout');
      return o && !/正在查/.test(o.textContent);
    }, { timeout: 30000 });
    const r = await p.evaluate(() => {
      const c = document.querySelector('.lookupcard');
      if (!c) return { miss: document.querySelector('#lookupout').textContent.replace(/\s+/g,' ').trim() };
      return {
        w: c.querySelector('.w').textContent,
        ph: (c.querySelector('.ph')||{}).textContent || '',
        tags: [...c.querySelectorAll('.dtags i')].map(n=>n.textContent).join(' '),
        tr: c.querySelector('.dtrans').textContent.split('\n')[0],
      };
    });
    console.log(r.miss ? `  查「${w}」→ ${r.miss.slice(0,50)}`
      : `  查「${w}」→ ${r.w} ${r.ph} [${r.tags}] ${r.tr}`);
    const shouldHit = w !== 'zzzznotaword';
    if (shouldHit === !!r.miss) { console.log('    ✗ 结果不符预期'); bad++; }
    if (w === 'cannot' && !r.miss && !/不能|无法/.test(r.tr)) {
      console.log('    ✗ cannot 该给出自己的释义，而不是拆成 can + not'); bad++;
    }
  }

  // 收入生词本
  await p.fill('#lookupin', 'indemnify');
  await p.click('[data-act="lookup"]');
  await p.waitForSelector('.lookupcard [data-act="keepq"]');
  await p.click('.lookupcard [data-act="keepq"]');
  await p.waitForTimeout(600);
  const n = await p.evaluate(() => Object.keys(JSON.parse(localStorage.gloss_state_v1).vocab).length);
  console.log('  收入生词本后，生词数 =', n);
  if (n !== 1) { console.log('    ✗ 应该正好 1 个'); bad++; }

  // ---- 粘贴一段英文 ----
  const TEXT = 'TERMINATION CLAUSE\n\n' + ('Either party may terminate this agreement upon thirty days written notice, provided that all outstanding obligations shall survive such termination and remain enforceable notwithstanding any provision herein. ').repeat(6);
  await p.click('[data-tab="home"]');
  await p.click('[data-act="paste"]');
  await p.waitForSelector('#pastebox');
  await p.fill('#pastebox', TEXT);
  await p.click('[data-act="pastego"]');
  await p.waitForSelector('#view-import.on .preview p', { timeout:60000 });
  const imp = await p.evaluate(() => ({
    title: document.querySelector('.impmeta .t').textContent,
    meta: document.querySelector('.impmeta .s').textContent.replace(/\s+/g,' ').trim(),
  }));
  console.log('  粘贴导入 →', imp.title.trim(), '|', imp.meta);
  await p.click('[data-act="accept"]');
  await p.waitForSelector('#view-home.on .tonight', { timeout:120000 });
  const bar = await p.locator('.shelf .nbar').boundingBox();
  if (!bar || bar.width <= 0 || bar.height <= 0) { console.log('✗ 书架进度条不可见'); bad++; }
  await p.click('.tonight');
  await p.waitForSelector('#view-read.on .para w', { timeout:60000 });
  const rd = await p.evaluate(() => ({
    where: document.querySelector('.rhead .where').textContent,
    words: document.querySelectorAll('w').length,
    hard: document.querySelectorAll('w.hard').length,
  }));
  console.log('  粘贴的内容可读：', rd.where, `${rd.words} 个可点词，${rd.hard} 个超纲`);
  if (rd.words < 50) { console.log('    ✗ 粘贴的正文没进去'); bad++; }

  // 未过词时主卡片也直接阅读；查词后正文继续可点，新卡片的收藏不能串词。
  await p.locator('#view-read w').filter({ hasText: /^party$/ }).first().click();
  await p.waitForSelector('#sheet.on');
  if (await p.locator('#dim').isVisible()) { console.log('✗ 阅读查词仍被遮罩阻挡'); bad++; }
  await p.locator('#view-read w').filter({ hasText: /^agreement$/ }).first().click();
  const word = await p.locator('#sheet .dw .w').textContent();
  if (word !== 'agreement') { console.log('✗ 连续点词未更新释义'); bad++; }
  await p.click('[data-act="savew"]');
  const saved = await p.evaluate(() => JSON.parse(localStorage.gloss_state_v1).vocab);
  if (!saved.agreement || saved.party) { console.log('✗ 连续点词后收藏串词'); bad++; }
  await p.locator('#view-read w').filter({ hasText: /^party$/ }).last().click();
  await p.waitForTimeout(250);
  const lastVisible = await p.evaluate(() => {
    const w = document.querySelector('#view-read w.lit').getBoundingClientRect();
    const sheet = document.querySelector('#sheet').getBoundingClientRect();
    return w.bottom < sheet.top && w.top >= 0;
  });
  if (!lastVisible) { console.log('✗ 文末选中词被卡片遮住'); bad++; }
  await p.keyboard.press('Escape');
  if (await p.locator('#sheet.on').count()) { console.log('✗ Escape 未关闭释义'); bad++; }
  await p.locator('#view-read w').filter({ hasText: /^party$/ }).first().click();
  await p.click('#view-read .back');
  if (await p.locator('#sheet.on').count()) { console.log('✗ 离开阅读页后卡片仍打开'); bad++; }
  await p.click('[data-act="paste"]');
  if (!await p.locator('#dim').isVisible()) { console.log('✗ 粘贴窗口丢失遮罩'); bad++; }
  await p.keyboard.press('Escape');
  console.log('  已检查连续查词、收藏归属、文末可见、Escape 和弹窗切换');

  await b.close();
  if (errs.length) { console.log('\n⚠️ 报错：'); [...new Set(errs)].slice(0,8).forEach(e=>console.log('  '+e)); process.exit(1); }
  console.log('\n无控制台报错。');
  if (bad) { console.log(`✗ ${bad} 项不符`); process.exit(1); }
  console.log('全部符合预期。');
})().catch(e=>{ console.error('✗', e.message); process.exit(1); });
