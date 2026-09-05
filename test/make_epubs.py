#!/usr/bin/env python3
"""造几种「结构不老实」的 EPUB / 文档测试件。

真实世界的 EPUB 五花八门：有的用 <div> 当段落、有的整本书塞在一个 XHTML 里、
有的 OPF 带命名空间前缀。这些都不是罕见情况，而现实是它们各自会用不同的方式
悄悄失败——不报错，只是内容少了一大截。所以要有测试件盯着。

  div-para.epub    段落用 <div> 而不是 <p>
  single-file.epub 整本书一个 XHTML 文件
  prefixed.epub    OPF 用 opf: 前缀写 manifest/spine
  cjk.epub         中英混排（中文为主）——曾经导致整本书只剩 1 节
  contract.txt     一份英文合同（纯文本）
  contract.docx    同一份合同的 docx

「正文从哪开始」的三份，对应三种线索强度。真实的书这三种都有，
而只认 spine 的话三份都会把人扔在版权页上：

  fm-nav.epub      EPUB3：nav 有 toc + landmarks(bodymatter)——最强线索，照读就行
  fm-ncx.epub      EPUB2：toc.ncx + <guide type="text">——老书的标准写法
  fm-bare.epub     什么都没有，只有「Copyright」「Contents」这种标题——只能靠猜
"""
import os, zipfile, html

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
os.makedirs(OUT, exist_ok=True)

PARA = ("The party of the first part shall indemnify and hold harmless the party of the "
        "second part against any liabilities arising from the aforementioned obligations, "
        "notwithstanding any provision to the contrary contained herein. ")
CJK = "阿德勒心理学明确否定心理创伤。这一点非常有新意，也具有划时代的意义。当然，弗洛伊德的创伤理论的确很有趣。"

CONTAINER = '''<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>'''


def write_epub(name, opf, docs):
    path = os.path.join(OUT, name)
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('mimetype', 'application/epub+zip')
        z.writestr('META-INF/container.xml', CONTAINER)
        z.writestr('OEBPS/content.opf', opf)
        for fn, body in docs.items():
            z.writestr('OEBPS/' + fn, body)
    print(f'{name}: {len(docs)} 个 XHTML，{os.path.getsize(path)//1024} KB')


def xhtml(title, blocks):
    return f'''<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>{html.escape(title)}</title></head>
<body>{"".join(blocks)}</body></html>'''


def opf_for(files, prefix=''):
    p = prefix + ':' if prefix else ''
    ns = f' xmlns:{prefix}="http://www.idpf.org/2007/opf"' if prefix else ''
    items = ''.join(
        f'<{p}item id="c{i}" href="{fn}" media-type="application/xhtml+xml"/>'
        for i, fn in enumerate(files))
    refs = ''.join(f'<{p}itemref idref="c{i}"/>' for i in range(len(files)))
    return f'''<?xml version="1.0" encoding="utf-8"?>
<{p}package xmlns="http://www.idpf.org/2007/opf"{ns} version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>结构测试书</dc:title><dc:creator>测试</dc:creator>
  </metadata>
  <{p}manifest>{items}</{p}manifest>
  <{p}spine>{refs}</{p}spine>
</{p}package>'''


# 1. 段落用 <div> —— 很常见，而固定标签列表会漏掉它
files, docs = [], {}
for c in range(40):
    blocks = [f'<h2>Chapter {c + 1}</h2>'] + [f'<div>{PARA * 2}</div>' for _ in range(6)]
    fn = f'ch{c}.xhtml'
    files.append(fn); docs[fn] = xhtml(f'Chapter {c + 1}', blocks)
write_epub('div-para.epub', opf_for(files), docs)

# 2. 整本书一个文件
blocks = []
for c in range(40):
    blocks.append(f'<h2>Chapter {c + 1}</h2>')
    blocks += [f'<p>{PARA * 2}</p>' for _ in range(6)]
write_epub('single-file.epub', opf_for(['book.xhtml']), {'book.xhtml': xhtml('整本书', blocks)})

# 3. OPF 带命名空间前缀
files, docs = [], {}
for c in range(30):
    fn = f'ch{c}.xhtml'
    files.append(fn)
    docs[fn] = xhtml(f'Chapter {c + 1}',
                     [f'<h2>Chapter {c + 1}</h2>'] + [f'<p>{PARA * 2}</p>' for _ in range(6)])
write_epub('prefixed.epub', opf_for(files, prefix='opf'), docs)

# 4. 中英混排，中文为主 —— 这就是「整本书只剩 1 节」的那个案例
files, docs = [], {}
for c in range(40):
    fn = f'ch{c}.xhtml'
    files.append(fn)
    docs[fn] = xhtml(f'第 {c + 1} 章',
                     [f'<h2>第 {c + 1} 章</h2>'] + [f'<p>{CJK * 3}</p>' for _ in range(6)])
write_epub('cjk.epub', opf_for(files), docs)

# 5/6. 英文合同：纯文本 + docx
contract = "CONSULTING SERVICES AGREEMENT\n\n"
for i in range(1, 16):
    contract += f"{i}. {'DEFINITIONS' if i == 1 else 'OBLIGATIONS'}\n\n{PARA * 3}\n\n"
open(os.path.join(OUT, 'contract.txt'), 'w', encoding='utf-8').write(contract)
print(f'contract.txt: {len(contract)} 字符')

DOCX_RELS = '''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>'''
CT = '''<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>'''
paras = ''.join(
    f'<w:p><w:r><w:t xml:space="preserve">{html.escape(line)}</w:t></w:r></w:p>'
    for line in contract.split('\n\n') if line.strip())
doc_xml = ('<?xml version="1.0" encoding="UTF-8"?>'
           '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
           f'<w:body>{paras}</w:body></w:document>')
with zipfile.ZipFile(os.path.join(OUT, 'contract.docx'), 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', CT)
    z.writestr('_rels/.rels', DOCX_RELS)
    z.writestr('word/document.xml', doc_xml)
print('contract.docx: 已生成')


# ---------------------------------------------------------------------------
# 「正文从哪开始」三件套
#
# 前置内容必须写得够长（textWeight ≥ 20），否则会被 makeSections 当成太短直接丢掉，
# 那样测的就不是「跳过起点」而是「丢弃内容」了 —— 两件完全不同的事。
FRONT = {
    'cover.xhtml': ('Cover', 'Gloss Test Book. A Novel. Published by the Test House. '
                             'Cover design by nobody in particular, set in Test Serif.'),
    'copy.xhtml': ('Copyright', 'Copyright (c) 2026 by the Test House. All rights reserved. '
                                'No part of this book may be reproduced in any form without '
                                'written permission from the publisher. First edition. '
                                'Printed in a test suite. ISBN 000-0-00-000000-0.'),
    'toc.xhtml': ('Contents', 'Chapter One, in which the party of the first part is '
                              'introduced. Chapter Two, concerning obligations. Chapter '
                              'Three, concerning liabilities. Chapter Four, concerning '
                              'provisions to the contrary. Chapter Five. Chapter Six. '
                              'Index. About the Author. Also by this author.'),
}
BACK = {'index.xhtml': ('Index', 'agreement, 12, 34. indemnify and hold harmless, 34, 56. '
                                 'liability arising from obligations, 56. party of the first '
                                 'part, 78, 90. provision to the contrary, 90. notwithstanding '
                                 'any provision contained herein, 101, 112.')}
BODY_N = 6


def fm_docs():
    """前置 3 篇 + 正文 6 章 + 后置 1 篇，返回 (文件名顺序, 文档表, 章名表)"""
    files, docs, titles = [], {}, {}
    for fn, (t, body) in FRONT.items():
        files.append(fn); titles[fn] = t
        docs[fn] = xhtml(t, [f'<h1>{t}</h1>', f'<p>{body}</p>'])
    for c in range(BODY_N):
        fn = f'ch{c}.xhtml'; t = f'Chapter {c + 1}'
        files.append(fn); titles[fn] = t
        docs[fn] = xhtml(t, [f'<h1>{t}</h1>'] + [f'<p>{PARA * 2}</p>' for _ in range(4)])
    for fn, (t, body) in BACK.items():
        files.append(fn); titles[fn] = t
        docs[fn] = xhtml(t, [f'<h1>{t}</h1>', f'<p>{body}</p>'])
    return files, docs, titles


# 7. EPUB3：nav 文档带 toc + landmarks。landmarks 里的 bodymatter 就是「正文从这里开始」
files, docs, titles = fm_docs()
nav_items = ''.join(f'<li><a href="{fn}">{html.escape(titles[fn])}</a></li>' for fn in files)
docs['nav.xhtml'] = f'''<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Navigation</title></head><body>
<nav epub:type="toc"><h1>Contents</h1><ol>{nav_items}</ol></nav>
<nav epub:type="landmarks"><ol>
  <li><a epub:type="cover" href="cover.xhtml">Cover</a></li>
  <li><a epub:type="bodymatter" href="ch0.xhtml">Start of Content</a></li>
</ol></nav></body></html>'''
items = ''.join(f'<item id="c{i}" href="{fn}" media-type="application/xhtml+xml"/>'
                for i, fn in enumerate(files))
refs = ''.join(f'<itemref idref="c{i}"/>' for i in range(len(files)))
opf3 = f'''<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>正文起点测试书（EPUB3）</dc:title><dc:creator>测试</dc:creator>
  </metadata>
  <manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>{items}</manifest>
  <spine>{refs}</spine>
</package>'''
write_epub('fm-nav.epub', opf3, docs)

# 8. EPUB2：toc.ncx + <guide><reference type="text">。老书全是这么写的
files, docs, titles = fm_docs()
points = ''.join(
    f'<navPoint id="n{i}" playOrder="{i + 1}"><navLabel><text>{html.escape(titles[fn])}</text></navLabel>'
    f'<content src="{fn}"/></navPoint>' for i, fn in enumerate(files))
docs['toc.ncx'] = f'''<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="test"/></head>
<docTitle><text>正文起点测试书（EPUB2）</text></docTitle>
<navMap>{points}</navMap></ncx>'''
items = ''.join(f'<item id="c{i}" href="{fn}" media-type="application/xhtml+xml"/>'
                for i, fn in enumerate(files))
refs = ''.join(f'<itemref idref="c{i}"/>' for i in range(len(files)))
opf2 = f'''<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>正文起点测试书（EPUB2）</dc:title><dc:creator>测试</dc:creator>
  </metadata>
  <manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>{items}</manifest>
  <spine toc="ncx">{refs}</spine>
  <guide>
    <reference type="cover" title="Cover" href="cover.xhtml"/>
    <reference type="text" title="Beginning" href="ch0.xhtml"/>
  </guide>
</package>'''
write_epub('fm-ncx.epub', opf2, docs)

# 9. 什么线索都没有：没 nav、没 ncx、没 guide。只剩标题能看 ——
#    这份是用来盯启发式别过头的，Chapter 1..6 一章都不能被当成前置内容
files, docs, titles = fm_docs()
write_epub('fm-bare.epub', opf_for(files), docs)
