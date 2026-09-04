// 针对产品构想里点名的那几个 ECDICT 数据 bug 的回归测试。
const { chromium } = require('playwright');

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto('http://localhost:5173/', { waitUntil: 'networkidle' });

  const out = await p.evaluate(async () => {
    const dict = await import('/js/dict.js');
    // 文档点名的四个错原形 + 拼接词 + 几个应该判成生词的对照组
    const words = ['does', 'also', 'some', 'always', 'cannot', 'anymore', 'center', 'huh',
      'running', 'better', 'went', 'children',
      'interpersonal', 'inferiority', 'blush', 'teleology', 'etiology'];
    await dict.ensureWords(words);
    const lemmas = new Set(); const comp = new Set();
    for (const w of words) {
      const r = dict.get(w);
      if (r && r.entry.x) lemmas.add(r.entry.x);
      if (!r) for (const s of dict.compoundShards(w)) comp.add(s);
    }
    await dict.ensureWords([...lemmas]);
    await dict.ensureShards(comp);
    return words.map((w) => {
      const r = dict.get(w);
      if (!r) return { w, found: false };
      return {
        w,
        found: true,
        hit: r.word,
        ecdictLemma: r.entry.x || '(无)',
        usedLemma: r.lemmaEntry ? r.lemma : '(不归并)',
        surfaceTags: r.entry.g || '',
        lemmaTags: (r.lemmaEntry && r.lemmaEntry.g) || '',
        simple: dict.isSimple(r),
      };
    });
  });

  const EXPECT_SIMPLE = new Set(['does', 'also', 'some', 'always', 'cannot', 'anymore',
    'center', 'huh', 'running', 'better', 'went', 'children']);
  let bad = 0;
  console.log('词        ECDICT说的原形   用到的原形    原词形标签      原形标签     判定    期望');
  for (const r of out) {
    if (!r.found) { console.log(`${r.w.padEnd(14)} 查不到`); bad++; continue; }
    const want = EXPECT_SIMPLE.has(r.w);
    const ok = r.simple === want;
    if (!ok) bad++;
    console.log(
      r.w.padEnd(10) + String(r.ecdictLemma).padEnd(16) + String(r.usedLemma).padEnd(14) +
      String(r.surfaceTags || '—').padEnd(15) + String(r.lemmaTags || '—').padEnd(13) +
      (r.simple ? '简单' : '生词') + '    ' + (want ? '简单' : '生词') + (ok ? '  ✓' : '  ✗ 不符'));
  }
  await b.close();
  console.log(bad ? `\n✗ ${bad} 个不符` : '\n全部符合预期。');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
