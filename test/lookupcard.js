// 阅读页那张查词卡片怎么关掉。
//
// 起因：别的卡片背后都压着 #dim，点一下就走；这一张没有 —— 它要让正文一直看得见，
// 于是原来只剩右上角那个 ×。查一个词就得去够一次那个小按钮，连着查十个词就是十次。
//
// 这一组盯的主要是「关掉之外的事不许被顺手关掉」：点另一个词是换词，
// 点卡片自己是在看释义，拖着选文字是要划线 —— 这三件都不该算「点空白处」。
const { chromium } = require('playwright');
const path = require('path');
const U = 'http://localhost:5173/';
let bad = 0;
const fail = (m) => { console.log('  ✗ ' + m); bad++; };
const ok = (m) => console.log('  ✓ ' + m);
const open = (p) => p.evaluate(() => document.querySelector('#sheet').classList.contains('on'));
const word = (p) => p.evaluate(() => (document.querySelector('#sheet .dw .w') || {}).textContent);

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

  const ws = await p.$$('#view-read w');
  await ws[3].click();
  await p.waitForTimeout(300);
  (await open(p)) ? ok('点词出释义：' + (await word(p))) : fail('点词没出释义');

  // 1. 正题：正文上的空白处点一下就该走
  await p.click('#view-read .sec-t');
  await p.waitForTimeout(200);
  (await open(p)) ? fail('点正文空白处没关掉 —— 又退回只能够右上角那个 ×') : ok('点正文空白处关掉了');

  // 2. 卡片自己不算空白 —— 释义要能划、能滚、能点开例句
  await ws[3].click();
  await p.waitForTimeout(300);
  await p.click('#sheet .dtrans');
  await p.waitForTimeout(200);
  (await open(p)) ? ok('点卡片内容不关') : fail('点释义正文把卡片关掉了');

  // 3. 点另一个词是换词。关掉再让人点第二遍，等于把连着查词这件事拆成两步
  await ws[6].click();
  await p.waitForTimeout(300);
  const w2 = await word(p);
  (await open(p)) && w2 ? ok('点另一个词换成：' + w2) : fail('点另一个词把卡片关了');

  // 4. 卡片里的按钮照常好用（收藏之后是它自己关的，不是被空白处关的）
  const key = await word(p);
  await p.click('#sheet [data-act="savew"]');
  await p.waitForTimeout(300);
  const saved = await p.evaluate(
    (k) => !!(JSON.parse(localStorage.getItem('gloss_state_v1') || '{}').vocab || {})[k], key);
  saved && !(await open(p)) ? ok('卡片按钮照常好用：收入生词本并自动关卡片') : fail('卡片按钮失灵');

  // 5. 卡片开着时点头上那一排，一下就该走到那儿 ——
  //    「先关卡片再点一次」是最容易被顺手做出来的退步
  await ws[3].click();
  await p.waitForTimeout(300);
  await p.click('#view-read .rhead .back');
  await p.waitForTimeout(300);
  const onHome = await p.evaluate(() => document.querySelector('#view-home').classList.contains('on'));
  const closed = !(await open(p));
  onHome && closed ? ok('点返回：卡片关掉且回到了文档页') : fail(`点返回 onHome=${onHome} closed=${closed}`);

  // 6. 拖着选文字松手也会来一发 click。这时候关卡片，顺带把人的选区也打断了
  await p.click('[data-act="onlyread"]');
  await p.waitForSelector('#view-read.on .sec-t');
  const ws2 = await p.$$('#view-read w');
  await ws2[3].click();
  await p.waitForTimeout(300);
  await p.evaluate(() => {
    const en = document.querySelector('#view-read .para .en');
    const r = document.createRange();
    r.setStart(en.firstChild, 0);
    r.setEnd(en.childNodes[2] || en.firstChild, 1);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  });
  await p.waitForTimeout(400);
  await p.evaluate(() => document.querySelector('#view-read .sec-t').click());
  await p.waitForTimeout(200);
  (await open(p)) ? ok('有选区时不误关') : fail('拖着选文字松手就把卡片关了');

  console.log(errs.length ? '\n控制台报错：' + errs.join(' | ') : '\n无控制台报错。');
  await b.close();
  console.log(bad ? `\n${bad} 处不符合预期。` : '\n全部符合预期。');
  process.exit(bad || errs.length ? 1 : 0);
})();
