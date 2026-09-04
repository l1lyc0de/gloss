# 测试

需要 playwright，并且 `node gloss/server.js` 已经在 5173 端口跑着。

```bash
cd gloss/test
npm install && npx playwright install chromium
python3 make_fixtures.py     # 三份 PDF 测试件（需要 reportlab）
python3 make_epubs.py        # 结构不老实的 EPUB + 合同 txt/docx
npm run all
```

| 用例 | 盯的是什么 |
|---|---|
| `dict.js` | ECDICT 的四个原形数据错误（does→doe、also→conjurer、some→an、always→alway），以及 cannot / huh 这两个洞。**这个尤其别删**：一旦「取原词形 ∪ 原形标签的并集」那个修法被改回去，它会立刻红 |
| `formats.js` | 各种格式和「结构不老实」的文档导进来会不会掉内容。每一条用例都对应一个真出过的 bug —— 中文 EPUB 曾经整本只剩 1 节 |
| `lookup.js` | 词典页直接查词、粘贴一段英文 |
| `pdf.js` | 单栏读得通 / 双栏要提示 / 扫描件要拒绝 |
| `e2e.js` | 全流程：导入 → 过词 → 阅读 → 查词 → 复习 → 同步 |

`e2e.js` 默认用项目根目录那本英文 EPUB，也可以传一个文件路径进去。
