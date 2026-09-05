// 阅读页的节间导航：滚动时浮出来，停手后自己淡走。
//
// 起因：翻页和目录原来只在正文末尾那一排，想跳走得先把整节滚完 ——
// 而「我不想读这节了」恰恰是最需要马上能走的时候。
//
// 这一组盯的主要是「什么时候**不该**出现」。一个浮在正文上的东西，
// 出现时机错了比没有还烦。
const { chromium } = require('playwright');
const path = require('path');
const U = 'http://localhost:5173/';
let bad = 0;
const fail = (m) => { console.log('  ✗ ' + m); bad++; };
const ok = (m) => console.log('  ✓ ' + m);
const shown = (p) => p.evaluate(() => {
  const el = document.querySelector('#floatnav');
  return !!el && el.classList.contains('on');
});

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 412, height: 820 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));

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

  // 1. 进入一节先亮一下 —— 不滚动的人否则永远发现不了有这个东西
  await p.waitForTimeout(150);
  (await shown(p)) ? ok('进入一节时亮起') : fail('进入一节时没亮，不滚动的人发现不了');

  // 2. 停手之后自己走
  await p.waitForTimeout(2200);
  (await shown(p)) ? fail('停手 2.2 秒后还赖着不走') : ok('停手后自动淡走');

  // 3. 滚动时浮出来
  await p.mouse.wheel(0, 500);
  await p.waitForTimeout(200);
  (await shown(p)) ? ok('滚动时浮出') : fail('滚动时没浮出');
  await p.waitForTimeout(2200);
  (await shown(p)) ? fail('滚动停下后还亮着') : ok('滚动停下后淡走');

  // 4. 内容有多长就该能翻到哪 —— 浮层里的位置要跟着当前节走
  const label = await p.textContent('#floatnav .mid');
  if (!/目录 · \d+\/\d+/.test(label.replace(/\s+/g, ' '))) fail(`浮层中间写的是「${label}」`);
  else ok(`浮层显示位置：${label.replace(/\s+/g, ' ').trim()}`);

  // 5. 滚到底时不该和正文末尾那一排重复出现 ——
  //    同一个功能同时出现两次，人会以为是两个不同的东西
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await p.waitForTimeout(400);
  (await shown(p)) ? fail('滚到底了还浮着，和末尾那一排重复') : ok('末尾那排可见时不重复出现');

  // 6. 查词卡片开着时不出现 —— 那会儿人在看释义，不是在找路
  await p.evaluate(() => window.scrollTo(0, 600));
  await p.waitForTimeout(200);
  await p.click('#view-read w');
  await p.waitForSelector('#sheet.on', { timeout: 30000 });
  (await shown(p)) ? fail('查词卡片开着时还浮着，两个都在屏幕下方会打架') : ok('查词卡片打开时收起');
  await p.mouse.wheel(0, 200);
  await p.waitForTimeout(250);
  (await shown(p)) ? fail('卡片开着时一滚又冒出来了') : ok('卡片开着时滚动也不出现');
  await p.click('#dim');
  await p.waitForTimeout(200);

  // 7. 浮层和提示条都停在屏幕底部，位置必须错开
  const geo = await p.evaluate(() => {
    const t = document.querySelector('#toast');
    t.classList.add('on');
    const off = parseFloat(getComputedStyle(t).bottom);
    document.body.classList.add('fnav-on');
    const on = parseFloat(getComputedStyle(t).bottom);
    t.classList.remove('on');
    return { off, on };
  });
  // 浮层自身占 76px 起、约 42px 高
  if (geo.on < 118) fail(`浮层在时提示条 bottom=${geo.on}px，仍落在浮层那条带里（76–118px）`);
  else ok(`提示条会让位：${geo.off}px → ${geo.on}px`);

  // 8. 点浮层里的「下一节」真的翻页
  await p.evaluate(() => window.scrollTo(0, 400));
  await p.waitForTimeout(200);
  const before = (await p.textContent('#view-read .sec-t')).trim();
  await p.evaluate(() => document.querySelector('#floatnav [data-act="sec"]:last-child').click());
  await p.waitForTimeout(800);
  const after = (await p.textContent('#view-read .sec-t')).trim();
  after !== before ? ok(`翻页可用：${before} → ${after}`) : fail('点「下一节」没翻过去');

  await b.close();
  if (errs.length) {
    console.log('\n⚠️ 报错：');
    [...new Set(errs)].slice(0, 5).forEach((e) => console.log('  ' + e));
  } else console.log('\n无控制台报错。');
  if (bad) { console.log(`\n✗ ${bad} 项不符`); process.exit(1); }
  console.log('\n全部符合预期。');
})();
