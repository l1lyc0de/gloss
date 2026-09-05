// 下载页和各平台的入口。
//
// 起因是一个真实反馈：安卓 Chrome 上看不到下载入口，自带浏览器能看到。
// 根因没能复现（多半是当时服务器上还没放包），但结论是对的 ——
// **入口不该只挂在 UA 判断上**。UA 认错、包还没传、缓存时机不对，
// 任何一样都会让人以为「这东西没有手机版」。下载页是个固定地址，发给谁都能开。
const { chromium } = require('playwright');
const U = 'http://localhost:5173';

const UAS = {
  android: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  androidOld: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
  ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  desktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};
let bad = 0;
const fail = (m) => { console.log('  ✗ ' + m); bad++; };

(async () => {
  const b = await chromium.launch();

  // 1. 路由。/download 和 /download/ 都得是页面，而安装包那条路不能被抢走
  console.log('=== 路由 ===');
  {
    const p = await (await b.newContext()).newPage();
    for (const [path, want] of [['/download', 'text/html'], ['/download/', 'text/html'],
                                ['/download.html', 'text/html'],
                                ['/download/gloss.apk', 'android.package-archive']]) {
      const r = await p.request.get(U + path);
      const ct = r.headers()['content-type'] || '';
      const ok = r.status() === 200 && ct.includes(want);
      console.log(`  ${path.padEnd(22)} ${r.status()} ${ct.split(';')[0]}`);
      if (!ok) fail(`${path} 应该是 200 + ${want}`);
    }
  }

  // 2. 下载页本身：三张卡都在，安卓那张显示的版本号要和 /api/apk 对得上
  console.log('=== 下载页 ===');
  for (const [name, ua] of Object.entries(UAS)) {
    const ctx = await b.newContext({ userAgent: ua, viewport: { width: 412, height: 900 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(U + '/download', { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#apkbody .dl-btn', { timeout: 30000 });
    const r = await p.evaluate(async () => {
      const j = await (await fetch('/api/apk')).json();
      return {
        cards: document.querySelectorAll('.dl-card').length,
        apkHref: (document.querySelector('#apkbody a[href$=".apk"]') || {}).getAttribute
          ? document.querySelector('#apkbody a[href$=".apk"]').getAttribute('href') : null,
        text: document.querySelector('#apkbody').textContent.replace(/\s+/g, ' '),
        ver: j.version,
        // 这一页绝不能继承 app.css 里 .card（复习卡片）的居中排版
        align: getComputedStyle(document.querySelector('.dl-card p')).textAlign,
      };
    });
    const verOk = r.text.includes('v' + r.ver);
    console.log(`  ${name.padEnd(11)} 卡片 ${r.cards} 张 · 版本 v${r.ver} ${verOk ? '✓' : '✗'} · 对齐 ${r.align}`);
    if (r.cards !== 3) fail(`${name}: 应该有 3 张卡（安卓 / iOS / 浏览器），实际 ${r.cards}`);
    if (!verOk) fail(`${name}: 页面上没显示 /api/apk 报的版本号 v${r.ver}`);
    if (r.apkHref !== '/download/gloss.apk') fail(`${name}: 下载链接是 ${r.apkHref}`);
    if (r.align !== 'left') fail(`${name}: 卡片内文字是 ${r.align} —— 撞上了 app.css 的 .card`);
    if (errs.length) fail(`${name}: 控制台报错 ${errs[0]}`);
    await ctx.close();
  }

  // 3. 首页入口：安卓直给安装包，其余平台给下载页。**没有一种平台是什么都没有的**
  console.log('=== 首页入口 ===');
  for (const [name, ua] of Object.entries(UAS)) {
    const ctx = await b.newContext({ userAgent: ua, viewport: { width: 412, height: 900 } });
    const p = await ctx.newPage();
    await p.goto(U + '/', { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#view-home.on', { timeout: 30000 });
    await p.waitForFunction(() => document.querySelector('.apkbar, .getbar'), { timeout: 30000 })
      .catch(() => {});
    const r = await p.evaluate(() => ({
      apkbar: !!document.querySelector('.apkbar'),
      getbar: !!document.querySelector('.getbar'),
      getHref: (document.querySelector('.getbar') || {}).getAttribute
        ? document.querySelector('.getbar').getAttribute('href') : null,
    }));
    const isAndroid = /Android/i.test(ua);
    console.log(`  ${name.padEnd(11)} apkbar=${r.apkbar} getbar=${r.getbar}`);
    if (!r.apkbar && !r.getbar) fail(`${name}: 首页一个入口都没有 —— 这正是那个 bug 的样子`);
    if (isAndroid && !r.apkbar) fail(`${name}: 安卓该直接给安装包`);
    if (!isAndroid && !r.getbar) fail(`${name}: 非安卓该给下载页入口`);
    if (r.getbar && r.getHref !== '/download') fail(`${name}: 下载页入口指向 ${r.getHref}`);
    await ctx.close();
  }

  await b.close();
  if (bad) { console.log(`\n✗ ${bad} 项不符`); process.exit(1); }
  console.log('\n全部符合预期。');
})();
