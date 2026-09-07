// 「点一下就出释义」的现场演示。
//
// 这句话是整个产品的重点宣传口径，而演示是它唯一的证据 —— 所以这里守三件事：
//
//   1. **演示里的释义必须和真词典逐字一致。** demo.js 为了瞬时把六条词条
//      硬编码在自己文件里，这就有了两份数据。一旦分片重新生成而这里忘了跟，
//      就成了「广告上写一套、装完是另一套」。这一条是纯文本比对，不开浏览器。
//   2. 两个页面（下载页、首页空态）都真的能点出释义来。摆一句点不动的英文
//      比不摆更糟。
//   3. 演示**不能触发任何词典分片请求**。六个词分散在六个分片上，加起来 1.6 MB；
//      要是演示走了网络，正好把「点一下就出」这件事证伪。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const U = 'http://localhost:5173';
const ROOT = path.join(__dirname, '..');
let bad = 0;
const fail = (m) => { console.log('  ✗ ' + m); bad++; };

// demo.js 是 ES module，测试是 CommonJS —— 只取那两个常量，用不着搬进 import。
function readDemo() {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/demo.js'), 'utf8');
  const grab = (name) => {
    const i = src.indexOf(`export const ${name} = `);
    if (i < 0) throw new Error(`demo.js 里找不到 ${name}`);
    // 从字面量的第一个括号起数配对，别去猜它在第几行结束
    const from = src.indexOf('=', i) + 1;
    const open = src.slice(from).search(/[[{]/) + from;
    const close = { '[': ']', '{': '}' }[src[open]];
    let depth = 0, str = null, end = -1;
    for (let j = open; j < src.length; j++) {
      const c = src[j];
      if (str) { if (c === '\\') j++; else if (c === str) str = null; continue; }
      if (c === '"' || c === "'" || c === '`') { str = c; continue; }
      if (c === src[open]) depth++;
      else if (c === close && --depth === 0) { end = j; break; }
    }
    if (end < 0) throw new Error(`demo.js 里的 ${name} 没闭合`);
    return eval('(' + src.slice(open, end + 1) + ')');
  };
  return { SENT: grab('SENT'), ENTRIES: grab('ENTRIES') };
}

function shardOf(word) {
  const w = (word.toLowerCase() + '__').slice(0, 2);
  return [...w].map((c) => (c >= 'a' && c <= 'z' ? c : '_')).join('');
}

(async () => {
  const { SENT, ENTRIES } = readDemo();

  // 1. 硬编码的释义 vs 真词典
  console.log('=== 演示词条 vs public/dict ===');
  const keys = SENT.filter(([, k]) => k).map(([, k]) => k);
  for (const k of keys) {
    const e = ENTRIES[k];
    if (!e) { fail(`句子里点得到 ${k}，但 ENTRIES 里没有它`); continue; }
    const shard = path.join(ROOT, 'public/dict', shardOf(k) + '.json');
    const real = JSON.parse(fs.readFileSync(shard, 'utf8'))[k];
    if (!real) { fail(`词典分片 ${shardOf(k)}.json 里没有 ${k}`); continue; }
    const diff = ['t', 'p', 'g'].filter((f) => (real[f] || '') !== (e[f] || ''))
      .concat((real.s || 0) !== (e.s || 0) ? ['s'] : []);
    console.log(`  ${k.padEnd(11)} ${diff.length ? '✗ ' + diff.join(',') : '✓'}`);
    if (diff.length) fail(`${k}: 演示里的 ${diff.join('/')} 和词典对不上 —— 装完看到的会是另一套`);
  }
  for (const k of Object.keys(ENTRIES)) {
    if (!keys.includes(k)) fail(`ENTRIES 里的 ${k} 没在句子里用到，删掉或用上`);
  }

  const b = await chromium.launch();

  // 2 + 3. 两个页面上真的点得动，且点的过程中一个分片都没请求
  for (const [where, url] of [
    ['下载页', U + '/download'],
    // 首页的演示只在「一份文档都没有」时出现 —— 这正是新用户第一眼看到的状态
    ['首页空态', U + '/'],
  ]) {
    console.log(`=== ${where} ===`);
    const ctx = await b.newContext({ viewport: { width: 412, height: 900 } });
    const p = await ctx.newPage();
    const errs = [];
    const dictHits = [];
    p.on('pageerror', (e) => errs.push(e.message));
    p.on('request', (r) => { if (/\/dict\/[a-z_]{2}\.json/.test(r.url())) dictHits.push(r.url()); });
    await p.goto(url, { waitUntil: 'domcontentloaded' });

    let ok = true;
    try {
      await p.waitForSelector('.demo w', { timeout: 15000 });
    } catch {
      fail(`${where}: 演示没渲染出来`);
      ok = false;
    }

    if (ok) {
      const n = await p.$$eval('.demo w', (els) => els.length);
      if (n !== keys.length) fail(`${where}: 可点的词有 ${n} 个，句子里定义了 ${keys.length} 个`);

      // 挨个点一遍，每个都得出对应的释义
      for (const k of keys) {
        const el = await p.$(`.demo w[data-k="${k}"]`);
        if (!el) { fail(`${where}: 点不到 ${k}`); continue; }
        await el.click();
        const r = await p.evaluate(() => {
          const c = document.querySelector('.demo-card');
          return { on: c.classList.contains('on'), w: (c.querySelector('.dw .w') || {}).textContent,
                   t: (c.querySelector('.dt') || {}).textContent };
        });
        const good = r.on && r.w === k && r.t === ENTRIES[k].t;
        if (!good) fail(`${where}: 点 ${k} 出来的是 ${JSON.stringify(r)}`);
      }

      // 词形还原：点 examined 出的得是 examine，且卡片上要注明原文形态
      await (await p.$('.demo w[data-w="examined"]')).click();
      const lem = await p.$eval('.demo-card', (c) => ({
        w: (c.querySelector('.dw .w') || {}).textContent,
        base: (c.querySelector('.db') || {}).textContent,
      }));
      if (lem.w !== 'examine') fail(`${where}: examined 该出 examine，实际 ${lem.w}`);
      if (!/examined/.test(lem.base || '')) fail(`${where}: 没标出原文形态 examined`);
      console.log(`  ${keys.length} 个词全部点得出释义 ✓ · 词形还原 examined → ${lem.w} ✓`);
    }

    if (dictHits.length) {
      fail(`${where}: 演示期间请求了 ${dictHits.length} 个词典分片（${dictHits[0]}）` +
           ` —— 演示必须自带数据，否则「点一下就出」当场被证伪`);
    } else {
      console.log('  没有请求任何词典分片 ✓');
    }
    if (errs.length) fail(`${where}: 控制台报错 ${errs[0]}`);
    await ctx.close();
  }

  // 4. 导过文档的人不该再看到演示 —— 那时候它就成了占地方的广告
  console.log('=== 首页有文档时 ===');
  {
    const ctx = await b.newContext({ viewport: { width: 412, height: 900 } });
    const p = await ctx.newPage();
    await p.goto(U + '/', { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#view-home.on', { timeout: 30000 });
    await p.evaluate(() => {
      const k = 'gloss_state_v1';
      const s = JSON.parse(localStorage.getItem(k) || '{}');
      s.books = s.books || {};
      s.books.fake = { title: '占位', kind: 'text', n: 3, words: 300, addedAt: Date.now(),
                       cur: 0, read: {}, learned: {}, lastOpen: Date.now() };
      localStorage.setItem(k, JSON.stringify(s));
    });
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#view-home.on', { timeout: 30000 });
    const still = await p.$('#homedemo');
    console.log(`  演示${still ? '仍然显示 ✗' : '已隐去 ✓'}`);
    if (still) fail('已经有文档了，首页还在放演示');
    await ctx.close();
  }

  await b.close();
  if (bad) { console.log(`\n✗ ${bad} 项不符`); process.exit(1); }
  console.log('\n全部符合预期。');
})();
