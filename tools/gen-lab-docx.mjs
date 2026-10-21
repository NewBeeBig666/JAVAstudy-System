/* 生成实验报告功能端到端测试用的最小 docx（store 无压缩 ZIP + 最小 OOXML）
 * 用法: node tools/gen-lab-docx.mjs <输出目录>
 * 生成: lab-template.docx（教师模板） / lab-report.docx（学生报告）
 */
import fs from 'node:fs';
import path from 'node:path';

// ---- CRC32 ----
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---- 最小 store ZIP ----
function zip(entries) { // entries: [{name, data(Uint8Array)}]
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameB = new TextEncoder().encode(e.name);
    const crc = crc32(e.data);
    const local = Buffer.alloc(30 + nameB.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);       // version
    local.writeUInt16LE(0, 6);        // flags
    local.writeUInt16LE(0, 8);        // method: store
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12); // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameB.length, 26);
    local.writeUInt16LE(0, 28);
    local.set(nameB, 30);
    chunks.push(local, Buffer.from(e.data));
    const cd = Buffer.alloc(46 + nameB.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(e.data.length, 20); cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameB.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    cd.set(nameB, 46);
    central.push(cd);
    offset += local.length + e.data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// ---- OOXML 部件 ----
function documentXml(paragraphs) {
  const body = paragraphs.map(t =>
    '<w:p><w:r><w:t xml:space="preserve">' + t.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</w:t></w:r></w:p>'
  ).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' + body + '</w:body></w:document>';
}
const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';
const RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

function makeDocx(paragraphs) {
  const enc = s => new TextEncoder().encode(s);
  return zip([
    { name: '[Content_Types].xml', data: enc(CONTENT_TYPES) },
    { name: '_rels/.rels', data: enc(RELS) },
    { name: 'word/document.xml', data: enc(documentXml(paragraphs)) }
  ]);
}

const outDir = process.argv[2] || '.';
fs.mkdirSync(outDir, { recursive: true });

// 教师模板：一、二、三为实验要求，底部为评分表与评语区
const template = makeDocx([
  'Java 面向对象程序设计 实验报告',
  '实验名称：类的封装与构造方法',
  '一、实验目的',
  '1. 掌握 Java 类的定义与对象的创建；',
  '2. 理解封装性，学会使用 private 与公有访问器；',
  '3. 掌握构造方法的重载与 this 关键字的用法。',
  '二、实验环境',
  'JDK 21，IntelliJ IDEA 或任意文本编辑器。',
  '三、实验内容与要求',
  '1. 定义 Student 类，包含 name、score 两个私有字段；',
  '2. 提供带参与无参两个构造方法；',
  '3. 提供 getter/setter，setter 中对 score 做 0-100 范围校验；',
  '4. 编写 main 方法创建两个学生对象并打印信息。',
  '四、实验步骤与过程',
  '（请在此填写你的实验步骤与完整代码）',
  '五、实验结果与分析',
  '（请在此填写运行结果与分析）',
  '六、实验总结',
  '（请在此填写心得体会）',
  '评分：________（百分制）',
  '评语：'
]);
fs.writeFileSync(path.join(outDir, 'lab-template.docx'), template);

// 学生报告：复用模板要求（一二三）+ 已完成的作答（四五六）+ 底部评分评语区
const report = makeDocx([
  'Java 面向对象程序设计 实验报告',
  '实验名称：类的封装与构造方法',
  '一、实验目的',
  '1. 掌握 Java 类的定义与对象的创建；',
  '2. 理解封装性，学会使用 private 与公有访问器；',
  '3. 掌握构造方法的重载与 this 关键字的用法。',
  '二、实验环境',
  'JDK 21，IntelliJ IDEA。',
  '三、实验内容与要求',
  '1. 定义 Student 类，包含 name、score 两个私有字段；',
  '2. 提供带参与无参两个构造方法；',
  '3. 提供 getter/setter，setter 中对 score 做 0-100 范围校验；',
  '4. 编写 main 方法创建两个学生对象并打印信息。',
  '四、实验步骤与过程',
  '定义了 Student 类：name 与 score 均为 private；编写了无参构造方法（默认值 张三/60）与带参构造方法（使用 this.name = name 赋值）；setter 中当 score 超出 0-100 时抛出 IllegalArgumentException。',
  'public class Student {',
  '    private String name;',
  '    private int score;',
  '    public Student() { this("张三", 60); }',
  '    public Student(String name, int score) { this.name = name; setScore(score); }',
  '    public void setScore(int score) {',
  '        if (score < 0 || score > 100) throw new IllegalArgumentException("分数必须在0-100之间");',
  '        this.score = score;',
  '    }',
  '}',
  '五、实验结果与分析',
  'main 方法创建了 Student("李四", 88) 与 new Student() 两个对象并打印，输出符合预期；尝试 setScore(150) 时正确抛出异常，验证了封装与校验逻辑。',
  '六、实验总结',
  '通过本次实验理解了封装的意义，构造方法重载让对象创建更灵活，this 关键字用于区分成员变量与参数。',
  '评分：________（百分制）',
  '评语：'
]);
fs.writeFileSync(path.join(outDir, 'lab-report.docx'), report);
console.log('OK: ' + path.join(outDir, 'lab-template.docx') + ' (' + template.length + 'B), ' +
  path.join(outDir, 'lab-report.docx') + ' (' + report.length + 'B)');
