// 做「M73 L 標記」測試檔：從一個 .gcode.3mf 取前 N 層，在第 2 層之後每隔 K 段擠出插一個 M73 L<標記>，
// 看印表機回報的 layer_num 會不會跟著變。
//   node tools/make-marker-test.mjs <輸入.gcode.3mf> <輸出.gcode.3mf> [層數=5] [間隔=15]
import { readFileSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const [, , IN, OUT, NL = '5', EVERY = '15'] = process.argv;
const LAYERS = +NL, K = +EVERY, BASE = 100;   // 標記從 L101 開始，跟真的層數分開

// ---- 讀 zip ----
const buf = readFileSync(IN);
let eocd = buf.length - 22; while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
const entries = []; let p = buf.readUInt32LE(eocd + 16);
for (let k = 0, n = buf.readUInt16LE(eocd + 10); k < n; k++) {
  const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
  const name = buf.toString('utf8', p + 46, p + 46 + nl); p += 46 + nl + xl + cl;
  const ds = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28), raw = buf.subarray(ds, ds + csize);
  entries.push({ name, data: method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw) });
}
const g = entries.find(e => /plate_\d+\.gcode$/.test(e.name));
const lines = g.data.toString().split('\n');

// ---- 截前 N 層 + 結尾程序 ----
const layerIdx = []; lines.forEach((l, i) => { if (l.startsWith('; CHANGE_LAYER')) layerIdx.push(i); });
const cut = layerIdx[LAYERS];                                   // 第 N+1 層開始的地方
const endAt = lines.findIndex((l, i) => i > layerIdx[layerIdx.length - 1] && l.startsWith('; filament end gcode'));
const head = lines.slice(0, cut), tail = lines.slice(endAt - 2);

// ---- 插標記 ----
const out = [], markers = []; let layer = 0, cnt = 0, mk = BASE;
for (let i = 0; i < head.length; i++) {
  const l = head[i];
  if (l.startsWith('; CHANGE_LAYER')) { layer++; cnt = 0; }
  out.push(l);
  if (layer >= 2 && /^G[123] .*E[.\d]/.test(l) && ++cnt % K === 0) {
    mk++; out.push(`M73 L${mk}`); markers.push({ marker: mk, layer, srcLine: i + 1 });
  }
}
out.push(...tail);
const gcode = Buffer.from(out.join('\n'));
g.data = gcode;
const md5 = entries.find(e => /plate_\d+\.gcode\.md5$/.test(e.name));
if (md5) md5.data = Buffer.from(crypto.createHash('md5').update(gcode).digest('hex').toUpperCase());

// ---- 寫 zip ----
const parts = [], central = []; let off = 0;
for (const e of entries) {
  const nameB = Buffer.from(e.name), comp = zlib.deflateRawSync(e.data), crc = zlib.crc32(e.data);
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
  lh.writeUInt32LE(crc >>> 0, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(nameB.length, 26);
  parts.push(lh, nameB, comp);
  const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
  ch.writeUInt32LE(crc >>> 0, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(e.data.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(off, 42);
  central.push(ch, nameB); off += 30 + nameB.length + comp.length;
}
const cd = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
writeFileSync(OUT, Buffer.concat([...parts, cd, end]));
writeFileSync(OUT + '.markers.json', JSON.stringify(markers, null, 1));
console.log(`輸出 ${OUT}：前 ${LAYERS} 層、${out.length} 行、插了 ${markers.length} 個標記（L${BASE + 1}～L${mk}）`);
