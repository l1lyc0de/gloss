// PDF 三种情况的验证：单栏该读得通、双栏该被提示、扫描件该被直接拒绝。
const { chromium } = require('playwright');
const path = require('path');
const HERE = path.join(__dirname, 'fixtures');

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  for (const [file, label] of [['single.pdf', '单栏'], ['twocol.pdf', '双栏'], ['scanned.pdf', '扫描件']]) {
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
    page.on('pageerror', (e) => errors.push(`${file} pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${file} console: ${m.text()}`); });
    await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
    await page.setInputFiles('#filepick', path.join(HERE, file));
    await page.waitForSelector('#view-import.on .preview p, #view-import.on .flag.bad', { timeout: 180000 });

    console.log(`\n===== ${label}（${file}）=====`);
    const res = await page.evaluate(() => ({
      rejected: !document.querySelector('.preview'),
      head: (document.querySelector('.impwrap h2') || {}).textContent,
      meta: (document.querySelector('.impmeta .s') || {}).textContent,
      flags: [...document.querySelectorAll('.flag')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
      paras: [...document.querySelectorAll('.preview p')].map((n) => n.textContent),
    }));
    console.log('标题：' + res.head);
    if (res.meta) console.log('元信息：' + res.meta.replace(/\s+/g, ' ').trim());
    res.flags.forEach((f) => console.log('提示：' + f));

    if (!res.rejected) {
      res.paras.slice(0, 3).forEach((p, i) => console.log(`  段${i + 1}: ${p.slice(0, 190)}`));
      const joined = res.paras.join(' ');
      // 该被清掉的东西
      console.log('  页眉残留 THE COURAGE TO BE DISLIKED：' + /THE COURAGE TO BE DISLIKED/.test(joined));
      console.log('  行末连字符残留（xx- yy）：' + /[a-z]-\s[a-z]/.test(joined));
      console.log('  孤立页码残留：' + res.paras.some((p) => /^\d{1,3}$/.test(p.trim())));
    }
    await page.close();
  }

  await browser.close();
  if (errors.length) { console.log('\n⚠️ 报错：'); errors.slice(0, 10).forEach((e) => console.log('  ' + e)); }
  else console.log('\n无控制台报错。');
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
