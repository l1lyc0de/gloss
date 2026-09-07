# 测试

需要 playwright，并且 `node gloss/server.js` 已经在 5173 端口跑着。

```bash
cd gloss/test
npm install && npx playwright install chromium
python3 make_fixtures.py     # 四份 PDF 测试件（需要 reportlab）
python3 make_epubs.py        # 结构不老实的 EPUB + 前置内容三件套 + 合同 txt/docx
npm run all
```

| 用例 | 盯的是什么 |
|---|---|
| `dict.js` | ECDICT 的四个原形数据错误（does→doe、also→conjurer、some→an、always→alway），以及 cannot / huh 这两个洞。**这个尤其别删**：一旦「取原词形 ∪ 原形标签的并集」那个修法被改回去，它会立刻红 |
| `formats.js` | 各种格式和「结构不老实」的文档导进来会不会掉内容。每一条用例都对应一个真出过的 bug —— 中文 EPUB 曾经整本只剩 1 节 |
| `toc.js` | 「正文从哪开始」和「按章选读」。三份 EPUB 对应三种线索强度（EPUB3 nav+landmarks / EPUB2 ncx+guide / 什么都没有），加带书签的 PDF。**反向用例别删**：`div-para.epub` 和 `single.pdf` 盯的是启发式不许乱跳 —— 为了跳版权页把正文第一章跳掉，比不跳严重得多 |
| `readnav.js` | 翻页/目录浮层什么时候**不该**出现 —— 浮在正文上的东西，出现时机错了比没有还烦 |
| `download.js` | 三张平台卡和首页入口。**「没有一种平台是什么都没有的」这条别放宽**：入口只挂在 UA 判断上就是那个 bug 的样子 |
| `demo.js` | 「点一下就出释义」那句演示。两条硬约束：演示里的释义要和 `public/dict/` 逐字一致（否则广告写一套、装完是另一套），以及**演示期间不许请求任何词典分片** —— 为了演示先下 1.6 MB，正好把要证明的事情证伪 |
| `highlight.js` | 划线、笔记、摘录。**最要紧的一条不是划线本身，是划过线的词还点不点得出释义** —— `<mark>` 一旦插进 `<w>` 里，词就被切成两半，那是拿主卖点换一个附属功能 |
| `lookup.js` | 词典页直接查词、粘贴一段英文 |
| `pdf.js` | 单栏读得通 / 双栏要提示 / 扫描件要拒绝 |
| `e2e.js` | 全流程：导入 → 过词 → 阅读 → 查词 → 复习 → 同步 |

`e2e.js` 默认用项目根目录那本英文 EPUB，也可以传一个文件路径进去。
