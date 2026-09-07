// 阅读设置的即时应用、持久化、旧数据兼容和小屏布局。
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://localhost:5173/');
    await page.setInputFiles('#filepick', path.join(__dirname, 'fixtures/div-para.epub'));
    await page.click('[data-act="accept"]');
    await page.click('.tonight');
    await page.waitForSelector('#view-read.on .para');
    await page.click('#view-read [data-act="readsettings"]');
    await page.click('[aria-label="增大字号"]');
    await page.click('[data-act="lineheight"][data-value="2"]');
    await page.click('[data-act="theme"][data-value="light"]');
    const appearance = await page.locator('.para .en').first().evaluate(e => ({
      fs: getComputedStyle(e).fontSize, line: getComputedStyle(e).lineHeight,
      paper: getComputedStyle(document.body).backgroundColor,
    }));
    assert.deepEqual(appearance, { fs: '19px', line: '38px', paper: 'rgb(246, 243, 236)' });
    for (let i = 0; i < 5; i++) await page.click('[aria-label="增大字号"]');
    assert(await page.locator('[aria-label="增大字号"]').isDisabled());
    await page.setViewportSize({ width: 320, height: 568 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.click('[data-act="theme"][data-value="system"]');
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(21, 26, 36)');
    await page.keyboard.press('Escape');
    await page.reload();
    await page.click('.tonight');
    assert.equal(await page.locator('.para .en').first().evaluate(e => getComputedStyle(e).fontSize), '24px');
    await page.click('#view-read .back');
    await page.click('[data-tab="me"]');
    await page.click('#view-me [data-act="readsettings"]');
    assert.equal(await page.locator('#fsv').textContent(), '24px');
    await page.keyboard.press('Escape');
    await page.getByText('手动备份', { exact: true }).click();
    await page.fill('#iobox', JSON.stringify({ vocab: {}, settings: { fs: 20 } }));
    await page.click('[data-act="import"]');
    await page.click('#view-me [data-act="readsettings"]');
    assert.equal(await page.locator('#fsv').textContent(), '20px');
    assert.equal(await page.locator('[data-act="lineheight"][data-value="1.75"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-act="theme"][data-value="system"]').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(errors, []);
    console.log('✓ 阅读设置即时应用、字号边界、主题覆盖、持久化、320px 布局和旧备份兼容');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
