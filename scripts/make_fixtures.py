#!/usr/bin/env python3
"""生成导入功能的测试样张：EPUB / DOCX / PDF / HTML / TXT（含 GBK）。"""
import os, zipfile, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'tests', 'fixtures')
os.makedirs(OUT, exist_ok=True)
p = lambda n: os.path.join(OUT, n)

CH1 = """<h1>Chapter One: Why Context Wins</h1>
<p>Most people learn vocabulary by memorizing isolated words. Yet research shows that a
word is far easier to retain when it is encountered inside a meaningful sentence.</p>
<p>Consider the word resilient. A dictionary tells you it means able to recover quickly.
But when you meet it in a story about a city rebuilding after a flood, the word acquires
weight and colour that no definition can supply.</p>"""

CH2 = """<h1>Chapter Two: Reading Widely</h1>
<p>This is why reading widely matters. Every sentence you finish quietly rewires the way
you remember language.</p>
<p>Learners who read a little every day consistently outperform those who cram once a week.</p>"""

NAV = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head><body><nav epub:type="toc"><ol>
<li><a href="ch1.xhtml">Chapter One</a></li><li><a href="ch2.xhtml">Chapter Two</a></li>
</ol></nav></body></html>"""


def make_epub():
    path = p('sample.epub')
    with zipfile.ZipFile(path, 'w') as z:
        # mimetype 必须是第一个且不压缩
        z.writestr(zipfile.ZipInfo('mimetype'), 'application/epub+zip', zipfile.ZIP_STORED)
        z.writestr('META-INF/container.xml', """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>""", zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/content.opf', """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>A Book About Reading</dc:title>
    <dc:creator>Test Author</dc:creator>
    <dc:identifier id="bookid">urn:uuid:test-0001</dc:identifier>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>""", zipfile.ZIP_DEFLATED)
        for name, body in [('ch1.xhtml', CH1), ('ch2.xhtml', CH2), ('nav.xhtml', NAV)]:
            z.writestr('OEBPS/' + name,
                       '<?xml version="1.0" encoding="utf-8"?>\n'
                       '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title>'
                       '<link rel="stylesheet" href="style.css"/></head><body>'
                       + body + '</body></html>', zipfile.ZIP_DEFLATED)
        z.writestr('OEBPS/style.css', 'body{font-family:serif}', zipfile.ZIP_DEFLATED)
    print('  epub ', os.path.getsize(path), 'bytes')


def make_docx():
    from docx import Document
    doc = Document()
    doc.core_properties.title = 'A Word Document About Reading'
    doc.add_heading('Reading and Memory', level=1)
    doc.add_paragraph('Vocabulary is remembered best when it is met in context rather than in a list.')
    doc.add_paragraph('Learners who read every day consistently outperform those who cram once a week.')
    doc.add_paragraph('A single well-chosen sentence can do more than twenty flashcards.')
    path = p('sample.docx')
    doc.save(path)
    print('  docx ', os.path.getsize(path), 'bytes')


def _pdf_escape(s):
    return s.replace('\\', r'\\').replace('(', r'\(').replace(')', r'\)')


def make_pdf():
    """手写一个用标准 Type1 字体的多页 PDF —— 不嵌字体，文本提取最可靠。"""
    pages = [
        ["Reading in Context", "",
         "Most people learn vocabulary by memorizing isolated words.",
         "Yet research shows that a word is far easier to retain when it",
         "is encountered inside a meaningful sentence."],
        ["Why It Matters", "",
         "Consider the word resilient. A dictionary tells you it means",
         "able to recover quickly. But context gives it weight and colour.",
         "Learners who read daily consistently outperform those who cram."],
    ]
    objs = {}
    n_pages = len(pages)
    page_ids = [4 + i * 2 for i in range(n_pages)]
    content_ids = [5 + i * 2 for i in range(n_pages)]

    objs[1] = "<< /Type /Catalog /Pages 2 0 R >>"
    objs[2] = ("<< /Type /Pages /Kids [" + " ".join(f"{i} 0 R" for i in page_ids) +
               f"] /Count {n_pages} >>")
    objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
    for i, lines in enumerate(pages):
        pid, cid = page_ids[i], content_ids[i]
        objs[pid] = (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                     f"/Resources << /Font << /F1 3 0 R >> >> /Contents {cid} 0 R >>")
        parts = ["BT", "/F1 14 Tf", "72 720 Td", "18 TL"]
        for k, ln in enumerate(lines):
            if k:
                parts.append("T*")
            parts.append(f"({_pdf_escape(ln)}) Tj")
        parts.append("ET")
        stream = "\n".join(parts)
        objs[cid] = f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream"

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = {}
    for num in sorted(objs):
        offsets[num] = len(out)
        out += f"{num} 0 obj\n{objs[num]}\nendobj\n".encode('latin-1')
    xref = len(out)
    mx = max(objs) + 1
    out += f"xref\n0 {mx}\n".encode()
    out += b"0000000000 65535 f \n"
    for num in range(1, mx):
        out += f"{offsets.get(num, 0):010d} 00000 n \n".encode()
    out += (f"trailer\n<< /Size {mx} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").encode()
    path = p('paper.pdf')
    open(path, 'wb').write(bytes(out))
    print('  pdf  ', os.path.getsize(path), 'bytes')


if __name__ == '__main__':
    print('生成测试样张 →', OUT)
    make_epub()
    make_docx()
    make_pdf()
    # 顺便用 cupsfilter 生成一个「真实排版器输出的 PDF」，更难解析
    src = p('sample.txt')
    if os.path.exists(src) and not os.path.exists(p('cups.pdf')):
        subprocess.run(f'cupsfilter -m application/pdf "{src}" > "{p("cups.pdf")}"',
                       shell=True, capture_output=True)
        if os.path.exists(p('cups.pdf')):
            print('  pdf(cups)', os.path.getsize(p('cups.pdf')), 'bytes')
    print('完成')
