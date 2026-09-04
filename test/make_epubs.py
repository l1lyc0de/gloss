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
