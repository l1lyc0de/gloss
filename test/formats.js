// 各种格式 / 各种「结构不老实」的文档，都得导得进来且不掉内容。
// 这一组用例每一条都对应一个真出过的 bug，别删。
const { chromium } = require('playwright');
const path = require('path');
const F = path.join(__dirname, 'fixtures');
const R = path.join(__dirname, '..', '..');

const CASES = [
  { f: path.join(F, 'contract.txt'),  min: 10, why: '纯文本合同' },
  { f: path.join(F, 'contract.docx'), min: 10, why: 'Word 合同' },
  { f: path.join(F, 'div-para.epub'), min: 30, why: '段落用 <div> 的 EPUB' },
  { f: path.join(F, 'prefixed.epub'), min: 25, why: 'OPF 带 opf: 前缀' },
  { f: path.join(F, 'cjk.epub'),      min: 30, why: '中文 EPUB（曾经只剩 1 节）', wantWarn: true },
  { f: path.join(R, '岸見一郎-被讨厌的勇气.epub'), min: 50, why: '真实中文书（曾经只剩 1 节）', wantWarn: true },
];
let bad = 0;

(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
  await p.goto('http://localhost:5173/', { waitUntil:'networkidle' });
  for (const { f, min, why, wantWarn } of CASES) {
    await p.goto('http://localhost:5173/', { waitUntil:'networkidle' });
    await p.evaluate(async () => { for (const db of await indexedDB.databases()) indexedDB.deleteDatabase(db.name); localStorage.clear(); });
    await p.goto('http://localhost:5173/', { waitUntil:'networkidle' });
    await p.setInputFiles('#filepick', f);
    await p.waitForSelector('#view-import.on .preview p, #view-import.on .flag.bad', { timeout:180000 });
    const r = await p.evaluate(() => ({
      rejected: !document.querySelector('.preview'),
      meta: (document.querySelector('.impmeta .s')||{}).textContent,
      title: (document.querySelector('.impmeta .t')||{}).textContent,
      flags: [...document.querySelectorAll('.flag')].map(n=>n.textContent.replace(/\s+/g,' ').trim()),
      first: (document.querySelector('.preview p')||{}).textContent,
    }));
    console.log('\n=== ' + why + '（' + path.basename(f) + '）');
    if (r.rejected) { console.log('  ✗ 被拒：' + r.flags.join(' ')); bad++; continue; }
    const meta = (r.meta||'').replace(/\s+/g,' ').trim();
    console.log('  ' + (r.title||'').trim() + '  |  ' + meta);
    r.flags.forEach(x=>console.log('  提示：'+x));
    console.log('  首段：' + String(r.first).slice(0,80));
    const secs = +((meta.match(/(\d+) 节/)||[])[1] || 0);
    if (secs < min) { console.log(`  ✗ 只分出 ${secs} 节，至少该有 ${min} 节 —— 内容被丢了`); bad++; }
    if (wantWarn && !r.flags.some(x=>/几乎没有英文/.test(x))) {
      console.log('  ✗ 该提示「几乎没有英文」却没提示'); bad++;
    }
  }
  await b.close();
  if (errs.length) { console.log('\n⚠️ 报错：'); [...new Set(errs)].slice(0,8).forEach(e=>console.log('  '+e)); }
  else console.log('\n无控制台报错。');
  if (bad) { console.log(`✗ ${bad} 项不符`); process.exit(1); }
  console.log('全部符合预期。');
})();
