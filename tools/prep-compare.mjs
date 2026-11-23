// 比對準備階段：網頁預估的每一步時間 vs 印表機實際花的時間
//   node tools/prep-compare.mjs <檔案.gcode.3mf> <record.log 或 prep-log.jsonl>
// 預估用的是 index.html 裡同一套解析／估時程式（直接從網頁抽出來執行，不另外抄一份）
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

const [, , FILE, LOG] = process.argv;
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const cut = (a, b) => html.slice(html.indexOf(a), html.indexOf(b));
const code = cut('// Bambu 的條件區塊', '// ---------- 顏色') + cut('// Bambu 起始程序的步驟代碼', '// 色階');
const api = new Function(code + '; return { parseGcode, estimateTimes, buildSegments, stageName };')();

// 讀 3mf 裡的 G-code
const buf = readFileSync(FILE);
let eocd = buf.length - 22; while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
let text = '', p = buf.readUInt32LE(eocd + 16);
for (let k = 0, n = buf.readUInt16LE(eocd + 10); k < n; k++) {
  const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
  const name = buf.toString('utf8', p + 46, p + 46 + nl); p += 46 + nl + xl + cl;
  if (!/plate_\d+\.gcode$/.test(name)) continue;
  const ds = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28), raw = buf.subarray(ds, ds + csize);
  text = (method === 0 ? raw : zlib.inflateRawSync(raw)).toString();
}
const data = api.parseGcode(text); api.estimateTimes(data); api.buildSegments(data);
const est = data.segments.filter(s => s.code !== 0).map(s => ({ code: s.code, sec: s.t1 - s.t0 }));

// 實際：從 record.log（stg_cur=… 的時間點）或 prep-log.jsonl 讀
let real = [];
const log = readFileSync(LOG, 'utf8');
if (LOG.endsWith('.jsonl')) real = JSON.parse(log.trim().split('\n').pop()).steps.map(s => ({ code: s.code, sec: s.sec }));
else {
  const ts = l => { const [h, m, s] = l.slice(0, 12).split(':'); return +h * 3600 + +m * 60 + +s; };
  const ev = []; let printAt = null;
  for (const l of log.split('\n')) {
    let m; if ((m = l.match(/stg_cur=(\d+)/)) && +m[1] > 0 && +m[1] < 255 && printAt === null) ev.push({ code: +m[1], at: ts(l) });
    if ((m = l.match(/layer_num=(\d+)/)) && +m[1] > 0 && printAt === null && ev.length) printAt = ts(l);
  }
  real = ev.map((e, i) => ({ code: e.code, sec: (ev[i + 1]?.at ?? printAt ?? e.at) - e.at }));
}

// 逐步對齊（照順序，預估裡有但實際沒出現的＝跳過）
const rows = []; let j = 0;
for (const r of real) {
  while (j < est.length && est[j].code !== r.code) { rows.push([api.stageName(est[j].code), est[j].sec, null]); j++; }
  if (j < est.length) { rows.push([api.stageName(r.code), est[j].sec, r.sec]); j++; } else rows.push([api.stageName(r.code), null, r.sec]);
}
for (; j < est.length; j++) rows.push([api.stageName(est[j].code), est[j].sec, null]);
const f = v => v == null ? '   —  ' : (v.toFixed(0) + 's').padStart(6);
console.log('步驟'.padEnd(12, '　'), '預估', '  實際', '   差');
let te = 0, tr = 0;
for (const [n, e, r] of rows) { te += e || 0; tr += r || 0; console.log(n.padEnd(10, '　'), f(e), f(r), e != null && r != null ? ((r - e >= 0 ? '+' : '') + (r - e).toFixed(0) + 's').padStart(6) : (r == null ? '  跳過' : '  多出')); }
console.log('合計'.padEnd(10, '　'), f(te), f(tr), ((tr - te >= 0 ? '+' : '') + (tr - te).toFixed(0) + 's').padStart(6));
