// 「正文从哪开始」+「按章选读」。
//
// 盯的是一个实测出来的体验问题：EPUB 的 spine 头几项是封面、版权页、目录，
// 从第 0 节打开等于让人一上来读出版说明。规范里 landmarks / guide 明写了
// 正文起点，只认 spine 就会全书错位。
//
// 三份测试件对应三种线索强度（EPUB3 nav、EPUB2 ncx+guide、什么都没有），
// 外加一份没有前置内容的书 —— 盯启发式别过头，把正文第一章当成版权页跳掉。
const { chromium } = require('playwright');
const path = require('path');
const F = path.join(__dirname, 'fixtures');
const U = 'http://localhost:5173/';

const CASES = [
  { f: 'fm-nav.epub',   skip: 3, firstT: /Chapter 1/, why: 'EPUB3：nav + landmarks(bodymatter)' },
  { f: 'fm-ncx.epub',   skip: 3, firstT: /Chapter 1/, why: 'EPUB2：toc.ncx + guide type="text"' },
  { f: 'fm-bare.epub',  skip: 3, firstT: /Chapter 1/, why: '无任何标准字段，只能靠标题猜' },
  { f: 'div-para.epub', skip: 0, firstT: /Chapter 1/, why: '没有前置内容的书（启发式不许乱跳）' },
  // PDF 只吃「书自己带了书签目录」这一种。没书签的 single.pdf 走字号那条老路，
  // 一节都不许跳 —— PDF 没有 landmarks 那样的标准字段兜底，猜错就是把正文跳掉
  { f: 'outline.pdf', skip: 3, firstT: /Chapter 1/, why: 'PDF：自带书签目录' },
  { f: 'single.pdf',  skip: 0, firstT: /./,         why: 'PDF：没有书签目录（不许猜前置内容）', oneChap: true },
];
let bad = 0;
const fail = (m) => { console.log('  ✗ ' + m); bad++; };

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  for (const c of CASES) {
    console.log('\n=== ' + c.why + '（' + c.f + '）');
    await p.goto(U, { waitUntil: 'networkidle' });
    await p.evaluate(async () => {
      for (const db of await indexedDB.databases()) indexedDB.deleteDatabase(db.name);
      localStorage.clear();
    });
    await p.goto(U, { waitUntil: 'networkidle' });
    await p.setInputFiles('#filepick', path.join(F, c.f));
    await p.waitForSelector('#view-import.on .preview p, #view-import.on .flag.bad', { timeout: 180000 });

    // 1. 跳过起点这件事，导入预览里必须说出来
    const flags = await p.$$eval('.flag', (ns) => ns.map((n) => n.textContent.replace(/\s+/g, ' ').trim()));
    const skipFlag = flags.find((x) => /前置内容/.test(x));
    if (c.skip && !skipFlag) fail('没有告诉用户跳过了前置内容（悄悄跳过 = 悄悄丢失）');
    if (!c.skip && skipFlag) fail('这本书没有前置内容，却报了「' + skipFlag + '」');
    if (skipFlag) console.log('  提示：' + skipFlag);

    await p.click('[data-act="accept"]');
    await p.waitForSelector('#view-home.on .shelf', { timeout: 180000 });

    // 2. cur 必须落在第一节正文上，且前置内容一节都没少
    const st = await p.evaluate(() => {
      const S = JSON.parse(localStorage.getItem('gloss_state_v1'));
      const id = Object.keys(S.books)[0];
      const m = S.books[id];
      return { id, cur: m.cur, n: m.n, chaps: m.chaps };
    });
    const front = (st.chaps || []).filter((x) => x.kind === 'front');
    const frontSecs = front.reduce((n, x) => n + x.n, 0);
    console.log(`  共 ${st.n} 节 / ${st.chaps.length} 章，其中前置 ${front.length} 章 ${frontSecs} 节，起点 cur=${st.cur}`);
    if (frontSecs !== c.skip) fail(`前置内容认成 ${frontSecs} 节，应该是 ${c.skip} 节`);
    if (st.cur !== frontSecs) fail(`起点是第 ${st.cur} 节，应该是第 ${frontSecs} 节（第一节正文）`);
    // 前置内容只是不作为起点，绝不能被删掉
    if (c.skip && st.n <= 6) fail(`总节数只有 ${st.n}，前置内容像是被丢弃了而不是跳过`);

    // 3. 打开这本书，第一屏必须是正文而不是版权页
    await p.click('.shelf .item');
    await p.waitForSelector('#view-read.on .sec-t, #view-words.on', { timeout: 180000 });
    if (await p.$('#view-words.on')) {          // 先过词的流程，跳到读
      await p.click('#view-words .wordprog [data-act="home"]');
      await p.waitForSelector('#view-home.on', { timeout: 30000 });
      await p.evaluate(() => document.querySelector('[data-act="onlyread"]').click());
      await p.waitForSelector('#view-read.on .sec-t', { timeout: 180000 });
    }
    const t1 = (await p.textContent('#view-read .sec-t')).trim();
    console.log('  打开后第一屏：' + t1);
    if (!c.firstT.test(t1)) fail(`第一屏是「${t1}」，应该匹配 ${c.firstT}`);
    if (/copyright|版权|contents|cover/i.test(t1)) fail('第一屏还是前置内容');

    // 4. 目录。只有一章的文档不该有这个入口 —— 点开就一行，是纯噪音
    if (c.oneChap) {
      if (await p.$('#view-read [data-act="toc"]')) fail('只有一章却露了目录入口');
      await p.click('#view-read [data-act="home"]');
      await p.waitForSelector('#view-home.on .shelf', { timeout: 30000 });
      if (await p.$('.shelf .tocbtn')) fail('只有一章，书架上却露了目录入口');
      console.log('  只有一章，两处目录入口都没露 ✓');
      continue;
    }
    await p.click('#view-read [data-act="toc"]');
    await p.waitForSelector('#sheet.on .toclist', { timeout: 30000 });
    const rows = await p.$$eval('#sheet .toclist button .n', (ns) => ns.map((n) => n.textContent.trim()));
    console.log('  目录（默认展开的部分）：' + rows.slice(0, 4).join(' / ') + (rows.length > 4 ? ' …' : ''));
    if (rows.some((x) => /^(Copyright|Contents|Cover)$/i.test(x))) fail('前置内容默认就摊在目录里');
    if (!rows.some((x) => /Chapter 1/.test(x))) fail('目录里找不到 Chapter 1');
    if (c.skip) {
      const toggle = await p.$('#sheet [data-act="tocfront"]');
      if (!toggle) fail('前置内容没有可展开的入口 —— 那就是真丢了');
      else {
        await toggle.click();
        await p.waitForSelector('#sheet.on .toclist', { timeout: 30000 });
        const all = await p.$$eval('#sheet .toclist button .n', (ns) => ns.map((n) => n.textContent.trim()));
        if (!all.some((x) => /Copyright/i.test(x))) fail('展开之后仍然看不到版权页');
        else console.log('  展开后能看到：' + all.filter((x) => /Copyright|Contents|Cover/i.test(x)).join(' / '));
      }
    }

    // 5. 点目录里的一章，要真的跳过去
    const target = rows.findIndex((x) => /Chapter 3/.test(x));
    if (target >= 0) {
      const btns = await p.$$('#sheet .toclist button');
      const idx = (await p.$$eval('#sheet .toclist button .n', (ns) => ns.map((n) => n.textContent.trim())))
        .findIndex((x) => /Chapter 3/.test(x));
      await btns[idx].click();
      await p.waitForSelector('#view-read.on .sec-t', { timeout: 180000 });
      const t3 = (await p.textContent('#view-read .sec-t')).trim();
      console.log('  点「Chapter 3」跳到：' + t3);
      if (!/Chapter 3/.test(t3)) fail(`点 Chapter 3 跳到了「${t3}」`);
    }
  }

  await b.close();
  if (errs.length) {
    console.log('\n⚠️ 报错：');
    [...new Set(errs)].slice(0, 8).forEach((e) => console.log('  ' + e));
  } else console.log('\n无控制台报错。');
  if (bad) { console.log(`\n✗ ${bad} 项不符`); process.exit(1); }
  console.log('\n全部符合预期。');
})();
