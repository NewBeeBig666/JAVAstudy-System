/* 测试数据准备：教师上传图片资源（覆盖图片打开即完成场景）+ 列出学生未完成资源
 * 用法: node tools/res-scroll-prep.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:8080/api';

// 生成最小合法 PNG（1x1 红色像素）——若已有测试图片则复用
const pngPath = path.join(__dirname, 'test-image.png');
if (!fs.existsSync(pngPath)) {
  // 67 字节最小 PNG：IHDR + IDAT + IEND（红色像素）
  const buf = Buffer.from(
    '89504e470d0a1a0a0000000d494844520000000100000001080200000090775' +
    '3de0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082', 'hex');
  // 修正：手工 hex 可能不合法，改用 zlib 动态生成
  const zlib = await import('node:zlib');
  function crc32(buf) {
    let c, table = [];
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
    let crc = 0xffffffff;
    for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2; // 1x1, 8bit, truecolor
  const raw = Buffer.from([0, 255, 0, 0]); // filter 0 + RGB 红
  const png = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(pngPath, png);
  console.log('生成测试图片 test-image.png (' + png.length + 'B)');
}

const login = async u => (await (await fetch(BASE + '/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: u, password: '123456' })
})).json()).data.token;

const tToken = await login('teacher');
// 上传图片资源（标题唯一便于识别）
const fd = new FormData();
fd.append('title', '滚动测试图片资源-' + Date.now());
fd.append('file', new Blob([fs.readFileSync(pngPath)], { type: 'image/png' }), 'test-image.png');
fd.append('kpCodes', '');
const up = await fetch(BASE + '/teacher/resources', {
  method: 'POST', headers: { 'Authorization': 'Bearer ' + tToken }, body: fd
});
const upj = await up.json();
if (upj.code !== 0) throw new Error('图片上传失败: ' + upj.msg);
console.log('[1] 图片资源上传 OK: id=' + upj.data.id + ' title=' + upj.data.title);

// 列出学生端资源（未完成清单，供浏览器测试选用）
const sToken = await login('student');
const list = (await (await fetch(BASE + '/resources', {
  headers: { 'Authorization': 'Bearer ' + sToken }
})).json()).data;
const undone = list.filter(r => !(r.myProgress && r.myProgress.completed));
console.log('[2] 学生未完成资源 ' + undone.length + ' 个:');
undone.forEach(r => console.log('    id=' + r.id + ' [' + r.fileType + '] ' + r.title));
