# -*- coding: utf-8 -*-
# 从 kp-xlsx-dump.txt（Excel 结构化导出）生成 V10 迁移 SQL：
# 全量插入课程知识点树（一~七级、模块归属、父级挂接、PRE 依赖、说明），
# 旧节点标记 LEGACY 兼容保留，并按同名映射把旧掌握度复制到新节点。
import io, re

SRC = u"e:\\AI Space\\JavaStudySystem Demo\\learning-agent-demo\\tools\\kp-xlsx-dump.txt"
DST = u"e:\\AI Space\\JavaStudySystem Demo\\backend\\src\\main\\resources\\db\\migration\\V10__knowledge_graph_full.sql"

def esc(s):
    return (s or u'').replace(u"'", u"''").replace(u"\n", u" ")

lines = io.open(SRC, 'r', encoding='utf-8').read().splitlines()
rows = []
for ln in lines:
    if ln.startswith(u'R') and u' | ' in ln:
        rows.append(ln.split(u' | '))
body = rows[2:]  # 跳过标题行与表头行

entries = []
path = {}
dep_pairs = []
seq = 0
for cells in body:
    while len(cells) < 16:
        cells.append(u'')
    lv = 0; lv_name = None
    for i in range(1, 8):
        v = cells[i].strip()
        if v:
            for j in range(i, 8):
                path.pop(j, None)
            path[i] = v
            lv = i; lv_name = v
            break
    if not lv_name:
        continue
    pre_col = cells[7].strip()
    link_col = cells[9].strip()
    desc_col = cells[15].strip()
    seq += 1
    if pre_col:
        for p in re.split(u'[;；]', pre_col):
            if p.strip():
                dep_pairs.append((lv_name, p.strip()))
    if link_col:
        for p in re.split(u'[;；]', link_col):
            if p.strip():
                dep_pairs.append((lv_name, p.strip()))
    entries.append({'seq': seq, 'level': lv, 'name': lv_name,
                   'parent': path.get(lv - 1) if lv > 1 else None, 'desc': desc_col})

# 模块序号（按出现顺序）
module_no = {}
cur_mod = None
no = 0
for e in entries:
    if e['level'] == 1:
        no += 1
        module_no[e['name']] = no
        cur_mod = e
    e['module'] = cur_mod['name']

# 生成唯一 code：kp-m{模块}-l{层级}-{序}
code_of = {}
counters = {}
for e in entries:
    m = module_no[e['module']]
    key = (m, e['level'])
    counters[key] = counters.get(key, 0) + 1
    e['code'] = u'kp-m%d-l%d-%03d' % (m, e['level'], counters[key])
    code_of[(e['module'], e['level'], e['name'])] = e['code']
for e in entries:
    e['mcode'] = code_of[(e['module'], 1, e['module'])]
    e['pcode'] = code_of.get((e['module'], e['level'] - 1, e['parent'])) if e['level'] > 1 else None

def code_by_name(n):
    for e in entries:
        if e['name'] == n:
            return e['code']
    return None

out = io.open(DST, 'w', encoding='utf-8')
out.write(u"""-- V10: 知识图谱全量重构 —— 以《智能Java编程-课程知识点.xlsx》为唯一数据源
-- 1) knowledge_point 增加 module_code（一级模块归属）与 source（XLSX=课程体系节点 / LEGACY=历史兼容）
-- 2) 全量插入 Excel 知识树（一~七级，父级挂接，按 Excel 行序保证父先于子）
-- 3) kp_dependency 写入显式前置/关联依赖（模块间递进 + 抽象类/接口→多态）
-- 4) 按同名映射将旧节点的掌握度复制到对应新节点，学生图谱即有数据可展示
-- 旧节点保留（source=LEGACY），历史练习/掌握度/会话数据不受影响，不进图谱与出题选项

ALTER TABLE `knowledge_point`
  ADD COLUMN module_code VARCHAR(50) NULL COMMENT '一级模块归属 kp_code',
  ADD COLUMN source VARCHAR(10) NOT NULL DEFAULT 'XLSX' COMMENT 'XLSX=课程体系节点 / LEGACY=历史兼容节点';

UPDATE `knowledge_point` SET `source` = 'LEGACY';

""")

for e in entries:
    pcode = e['pcode']
    if pcode:
        out.write(u"SELECT @pf := id FROM `knowledge_point` WHERE kp_code = '%s';\n" % pcode)
        parent_val = u'@pf'
    else:
        parent_val = u'NULL'
    out.write(u"INSERT INTO `knowledge_point` (kp_code, name, parent_id, level, module_code, sort_order, description, source) VALUES ('%s', '%s', %s, %d, '%s', %d, '%s', 'XLSX');\n"
              % (e['code'], esc(e['name']), parent_val, e['level'], e['mcode'], e['seq'], esc(e['desc'])))

out.write(u"\n-- 显式前置/关联依赖（PRE）\n")
seen = set()
for a, b in dep_pairs:
    ca, cb = code_by_name(a), code_by_name(b)
    if ca and cb and (ca, cb) not in seen:
        seen.add((ca, cb))
        out.write(u"INSERT INTO `kp_dependency` (kp_id, dep_kp_id, dep_type) SELECT id, (SELECT id FROM `knowledge_point` WHERE kp_code = '%s'), 'PRE' FROM `knowledge_point` WHERE kp_code = '%s';\n" % (cb, ca))

out.write(u"""
-- 同名映射：旧节点掌握度复制到对应新节点（学生图谱展示用；不覆盖已有记录）
INSERT INTO `mastery` (user_id, kp_id, mastery_value, updated_at)
SELECT m.user_id, n.id, m.mastery_value, NOW()
FROM `mastery` m
JOIN `knowledge_point` o ON o.id = m.kp_id AND o.source = 'LEGACY'
JOIN `knowledge_point` n ON n.name = o.name AND n.source = 'XLSX'
WHERE NOT EXISTS (SELECT 1 FROM `mastery` x WHERE x.user_id = m.user_id AND x.kp_id = n.id);
""")
out.close()
print('entries=%d deps=%d' % (len(entries), len(seen)))
