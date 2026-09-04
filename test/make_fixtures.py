#!/usr/bin/env python3
"""造三份 PDF 测试件，都用低层 canvas 逐行 drawString ——
故意模拟 PDF 的本质：它只是「在坐标 (x,y) 画字符」，没有段落概念。

  single.pdf   单栏 + 页眉 + 页码 + 首行缩进 + 行末连字符断词（该能读）
  twocol.pdf   双栏（该被提示）
  scanned.pdf  只有图形没有文字层（该被直接拒绝）
"""
import json, os, sys
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter

ROOT = '/Users/lily/code/english_learning'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
os.makedirs(OUT, exist_ok=True)
W, H = letter
FONT, SIZE, LEAD = 'Times-Roman', 11, 15.5

book = json.load(open(os.path.join(ROOT, 'data', 'book.json'), encoding='utf-8'))
paras = []
for p in book['parts']:
    for s in p['sections']:
        for x in s['paras']:
            t = x['en'].replace('\n', ' ').strip()
            if len(t) > 80:
                paras.append(t)
paras = paras[:150]
TITLE = 'THE COURAGE TO BE DISLIKED'


def wrap(c, text, width):
    """按实际字宽折行；偶尔在长词中间断开并补连字符，制造真实的续行。"""
    words, lines, cur = text.split(), [], ''
    for w in words:
        trial = (cur + ' ' + w).strip()
        if c.stringWidth(trial, FONT, SIZE) <= width:
            cur = trial
        else:
            # 长词就地断开，行末留连字符 —— joinLines 必须能把它接回去
            if len(w) >= 10 and c.stringWidth(cur, FONT, SIZE) < width * 0.72:
                for cut in range(len(w) - 3, 3, -1):
                    head = (cur + ' ' + w[:cut] + '-').strip()
                    if c.stringWidth(head, FONT, SIZE) <= width:
                        lines.append(head)
                        cur = w[cut:]
                        break
                else:
                    lines.append(cur); cur = w
            else:
                lines.append(cur); cur = w
    if cur:
        lines.append(cur)
    return lines


def single(path, two_col=False):
    c = canvas.Canvas(path, pagesize=letter)
    top, bottom = H - 78, 70
    if two_col:
        cols = [(60, 232), (320, 232)]
    else:
        cols = [(72, W - 144)]

    ci, y, page = 0, top, 1

    def header():
        c.setFont('Times-Italic', 8.5)
        c.drawCentredString(W / 2, H - 48, TITLE)          # 每页重复的页眉
        c.drawCentredString(W / 2, 44, str(page))          # 页码

    header()
    for para in paras:
        x, cw = cols[ci]
        lines = wrap(c, para, cw)
        for i, line in enumerate(lines):
            if y < bottom:
                ci += 1
                if ci >= len(cols):
                    c.showPage(); page += 1; ci = 0; header()
                y = top
                x, cw = cols[ci]
            c.setFont(FONT, SIZE)
            # 段首行缩进 —— linesToParagraphs 靠这个判断新段开始
            c.drawString(x + (14 if i == 0 else 0), y, line)
            y -= LEAD
        y -= 4
    c.save()
    print(f'{os.path.basename(path)}: {page} 页')


def scanned(path):
    """扫描件：整页都是图形，一个文字都不画。"""
    c = canvas.Canvas(path, pagesize=letter)
    for _ in range(6):
        c.setFillGray(0.93)
        c.rect(72, 90, W - 144, H - 180, fill=1, stroke=0)
        c.setFillGray(0.55)
        for i in range(28):                                 # 假装是拍下来的文字行
            c.rect(92, H - 130 - i * 20, (W - 200) * (0.6 + 0.35 * ((i * 7) % 5) / 5), 7, fill=1, stroke=0)
        c.showPage()
    c.save()
    print(f'{os.path.basename(path)}: 6 页（无文字层）')


single(os.path.join(OUT, 'single.pdf'))
single(os.path.join(OUT, 'twocol.pdf'), two_col=True)
scanned(os.path.join(OUT, 'scanned.pdf'))
