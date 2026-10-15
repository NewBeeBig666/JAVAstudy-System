# -*- coding: utf-8 -*-
# 零依赖解析 xlsx（zip + xml.etree），输出「智能Java编程-课程知识点.xlsx」全部单元格内容到 UTF-8 文本
import zipfile, re, io
import xml.etree.ElementTree as ET

path = u"e:\\AI Space\\JavaStudySystem Demo\\本地资料库\\智能Java编程-课程知识点.xlsx"
out = io.open(u"e:\\AI Space\\JavaStudySystem Demo\\learning-agent-demo\\tools\\kp-xlsx-dump.txt", 'w', encoding='utf-8')
M = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}

z = zipfile.ZipFile(path)
shared = []
if 'xl/sharedStrings.xml' in z.namelist():
    root = ET.fromstring(z.read('xl/sharedStrings.xml'))
    for si in root.findall('m:si', NS):
        shared.append(u''.join(t.text or u'' for t in si.iter(M + 't')))

wb = ET.fromstring(z.read('xl/workbook.xml'))
rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
relmap = dict((rel.get('Id'), rel.get('Target')) for rel in rels)
sheets = []
for s in wb.iter(M + 'sheet'):
    rid = s.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
    target = relmap.get(rid, u'')
    if not target.startswith('xl/'):
        target = u'xl/' + target
    sheets.append((s.get('name'), target))

def col_of(ref):
    m = re.match(r'([A-Z]+)', ref or u'')
    if not m: return 0
    col = 0
    for ch in m.group(1):
        col = col * 26 + ord(ch) - 64
    return col

for name, target in sheets:
    out.write(u'======== Sheet: ' + name + u' ========\n')
    root = ET.fromstring(z.read(target))
    rows = []
    for row in root.iter(M + 'row'):
        cells = {}
        for c in row.findall('m:c', NS):
            t = c.get('t', u'')
            v = c.find('m:v', NS)
            if v is None:
                isEl = c.find('m:is', NS)
                val = u''.join(x.text or u'' for x in isEl.iter(M + 't')) if isEl is not None else u''
            else:
                val = shared[int(v.text)] if t == 's' else (v.text or u'')
            cells[col_of(c.get('r', u''))] = (val or u'').strip()
        rows.append(cells)
    maxc = 0
    for r in rows:
        if r: maxc = max(maxc, max(r.keys()))
    for i, r in enumerate(rows):
        line = u' | '.join(r.get(c, u'') for c in range(1, maxc + 1))
        out.write(u'R%02d | %s\n' % (i + 1, line))
z.close()
out.close()
print('dump done')
