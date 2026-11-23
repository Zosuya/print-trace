// PRINT//TRACE 後端：連 Bambu 印表機的 MQTT（狀態）與 FTPS（下載正在印的檔案），
// 用 SSE 推給網頁，同時提供靜態檔案。
//
//   node server.mjs                     接實機（讀 config.local.json）
//   node server.mjs --sim <檔案>         模擬列印（不連印表機，用來測試畫面）
//
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, statSync, createReadStream, writeFileSync, appendFileSync } from 'node:fs';
import { join, extname, basename, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const CACHE = join(ROOT, 'cache');
mkdirSync(CACHE, { recursive: true });
const cfgPath = join(ROOT, 'config.local.json');
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^﻿/, '')) : {};
const PORT = +process.env.PORT || cfg.port || 8765;
const simIdx = process.argv.indexOf('--sim');
const SIM = simIdx > 0 ? process.argv[simIdx + 1] : null;

// ---------- 狀態與 SSE ----------
const state = { connected: false, print: {}, file: null, updated: 0, stgHist: [], job: '' };
const clients = new Set();
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
let pushTimer = null;
function pushStatus() {
  // 印表機回報很頻繁，合併成最多每 250ms 推一次
  if (pushTimer) return;
  pushTimer = setTimeout(() => { pushTimer = null; broadcast('status', snapshot()); }, 250);
}
const KEYS = ['gcode_state', 'stg_cur', 'mc_print_stage', 'layer_num', 'total_layer_num', 'mc_percent', 'mc_remaining_time',
  'gcode_file', 'subtask_name', 'spd_lvl', 'spd_mag', 'nozzle_temper', 'nozzle_target_temper', 'bed_temper', 'bed_target_temper',
  'print_type', 'ipcam', 'mc_print_line_number', 'sdcard', 'print_error', 'wifi_signal', 'cooling_fan_speed', 'heatbreak_fan_speed'];
function snapshot() {
  const p = {}; for (const k of KEYS) if (k in state.print) p[k] = state.print[k];
  // ver：index.html 改過就會變，網頁看到不同就自動重新整理（嵌在 Orca 裡沒辦法手動重整）
  let ver = 0; try { ver = statSync(join(ROOT, 'index.html')).mtimeMs; } catch { }
  return { connected: state.connected, sim: !!SIM, print: p, file: state.file, updated: state.updated, ver, stgHist: state.stgHist, lastPrep };
}
function applyReport(p) {
  Object.assign(state.print, p);
  trackStages();
  state.updated = Date.now();
  pushStatus();
  maybeFetchFile();
}

// 記下這次列印實際出現過的準備步驟（網頁重新整理也能知道哪些做過、哪些被跳過）
// 同時把每一步的實際開始時間記下來，開始印第一層時寫進 cache/prep-log.jsonl（之後拿來修正預估）
let prepRec = null;
// 上一次實際做過哪些準備步驟（網頁用來猜這次會不會調平、擠出校準）
let lastPrep = []; try { const l = readFileSync(join(CACHE, 'prep-log.jsonl'), 'utf8').trim().split('\n').pop(); lastPrep = JSON.parse(l).steps.map(x => x.code); } catch { }
function trackStages() {
  const p = state.print, job = (p.subtask_name || '') + '|' + (p.gcode_file || '');
  if (job !== state.job) { state.job = job; state.stgHist = []; prepRec = null; }
  const s = p.stg_cur, now = Date.now();
  if (p.gcode_state === 'PREPARE' || p.gcode_state === 'RUNNING') {
    if (!prepRec && (p.layer_num || 0) === 0) prepRec = { job, file: p.gcode_file, start: now, steps: [] };
    if (prepRec && !prepRec.done) {
      const lastStep = prepRec.steps[prepRec.steps.length - 1];
      if (s > 0 && s < 255 && lastStep?.code !== s) prepRec.steps.push({ code: s, at: now });
      if ((p.layer_num || 0) > 0) {
        prepRec.done = true; prepRec.printStart = now; lastPrep = prepRec.steps.map(x => x.code);
        prepRec.steps.forEach((st, i) => { st.sec = Math.round(((prepRec.steps[i + 1]?.at ?? now) - st.at) / 100) / 10; });
        try { appendFileSync(join(CACHE, 'prep-log.jsonl'), JSON.stringify({ ...prepRec, totalSec: Math.round((now - prepRec.start) / 1000) }) + '\n'); } catch { }
        console.log('[prep] 準備階段共', Math.round((now - prepRec.start) / 1000), '秒：', prepRec.steps.map(x => `${x.code}:${x.sec}s`).join(' '));
      }
    }
  }
  if (s > 0 && s < 255 && state.stgHist[state.stgHist.length - 1] !== s) state.stgHist.push(s);
}

// ---------- 下載正在印的檔案 ----------
let fetching = null, lastKey = '';
async function maybeFetchFile() {
  const p = state.print;
  const active = ['PREPARE', 'RUNNING', 'PAUSE', 'SLICING'].includes(p.gcode_state);
  const key = `${p.subtask_name || ''}|${p.gcode_file || ''}`;
  if (!active || !p.subtask_name && !p.gcode_file || key === lastKey || fetching) return;
  lastKey = key;
  fetching = downloadCurrent(p).then(f => {
    if (f) { state.file = f; broadcast('file', f); console.log('[ftp] 已下載', f.name); }
  }).catch(e => { console.log('[ftp] 下載失敗：', e.message); lastKey = ''; })
    .finally(() => { fetching = null; });
}
async function downloadCurrent(p) {
  const { Client } = await import('basic-ftp');
  const c = new Client(20000);
  try {
    await c.access({ host: cfg.ip, port: 990, user: 'bblp', password: cfg.accessCode, secure: 'implicit', secureOptions: { rejectUnauthorized: false } });
    const name = p.subtask_name || '';
    const file = (p.gcode_file || '').replace(/^.*\//, '');
    // 先猜常見位置，猜不到就列目錄找名字符合的 .3mf
    const guesses = [];
    if (/\.3mf$/i.test(p.gcode_file || '')) guesses.push(p.gcode_file, '/' + file, '/cache/' + file);
    if (name) for (const d of ['/cache/', '/', '/model/']) guesses.push(d + name + '.gcode.3mf', d + name + '.3mf');
    for (const d of ['/cache', '/', '/model']) {
      try { await c.cd(d); const l = await c.list();
        l.filter(f => f.isFile && /\.(3mf|gcode)$/i.test(f.name) && (name && f.name.startsWith(name) || file && f.name === file))
          .sort((a, b) => (b.modifiedAt?.getTime?.() || 0) - (a.modifiedAt?.getTime?.() || 0))
          .forEach(f => guesses.push((d === '/' ? '' : d) + '/' + f.name));
      } catch { }
    }
    for (const g of [...new Set(guesses.filter(Boolean))]) {
      try {
        const local = join(CACHE, basename(g).replace(/[^\p{L}\p{N}.\-_]+/gu, '_'));
        await c.downloadTo(local, g);
        if (statSync(local).size > 100) return { name: basename(g), url: '/cache/' + encodeURIComponent(basename(local)) };
      } catch { }
    }
    console.log('[ftp] 找不到檔案，試過：', guesses.join(', '));
    return null;
  } finally { c.close(); }
}

// ---------- 接實機 MQTT ----------
async function startMqtt() {   // 回傳停止用的函式
  const mqtt = (await import('mqtt')).default;
  const c = mqtt.connect(`mqtts://${cfg.ip}:8883`, { username: 'bblp', password: cfg.accessCode, rejectUnauthorized: false, reconnectPeriod: 5000, connectTimeout: 10000 });
  const pushall = () => c.publish(`device/${cfg.serial}/request`, JSON.stringify({ pushing: { sequence_id: String(Date.now()), command: 'pushall' } }));
  c.on('connect', () => {
    console.log('[mqtt] 已連線', cfg.ip);
    state.connected = true; pushStatus();
    c.subscribe(`device/${cfg.serial}/report`); pushall();
  });
  c.on('close', () => { if (state.connected) console.log('[mqtt] 斷線，重試中'); state.connected = false; pushStatus(); });
  c.on('error', e => console.log('[mqtt]', e.message));
  c.on('message', (t, buf) => { try { const j = JSON.parse(buf.toString()); if (j.print) applyReport(j.print); } catch { } });
  const t1 = setInterval(() => { if (state.connected) pushall(); }, 5 * 60 * 1000);
  const t2 = setInterval(() => broadcast('status', snapshot()), 2000);   // 定時推一次，網頁改版也能很快被偵測到
  return () => { clearInterval(t1); clearInterval(t2); c.end(true); state.connected = false; console.log('[mqtt] 已中斷'); };
}

// ---------- 模擬列印：照檔案的 G-code 一行行往下跑，產生跟實機一樣的欄位 ----------
function readZipEntry(buf, test) {
  let eocd = buf.length - 22; while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = buf.readUInt32LE(eocd + 16); const n = buf.readUInt16LE(eocd + 10);
  for (let k = 0; k < n; k++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl); p += 46 + nl + xl + cl;
    if (!test(name)) continue;
    const ds = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28), raw = buf.subarray(ds, ds + csize);
    return method === 0 ? raw : zlib.inflateRawSync(raw);
  }
}
function startSim(path) {
  const buf = readFileSync(path);
  const text = /\.3mf$/i.test(path) ? readZipEntry(buf, n => /plate_\d+\.gcode$/.test(n)).toString() : buf.toString();
  const lines = text.split('\n');
  const total = (text.match(/^; CHANGE_LAYER/gm) || []).length;
  const local = join(CACHE, 'sim_' + basename(path).replace(/[^\p{L}\p{N}.\-_]+/gu, '_'));
  writeFileSync(local, buf);
  state.file = { name: basename(path), url: '/cache/' + encodeURIComponent(basename(local)) };
  state.connected = true;
  const speed = Number(process.argv[process.argv.indexOf('--sim') + 2]) || 120;   // 每秒跑幾行
  let i = 0, layer = 0, stg = 0, idle = 5;
  console.log(`[sim] 模擬 ${basename(path)}，${lines.length} 行、${total} 層、每秒 ${speed} 行`);
  setInterval(() => {
    if (idle > 0) { idle--; applyReport({ gcode_state: 'IDLE', stg_cur: 0, layer_num: 0, total_layer_num: 0, mc_percent: 0, nozzle_temper: 26, bed_temper: 26, nozzle_target_temper: 0, bed_target_temper: 0, subtask_name: '' }); return; }
    const step = Math.max(1, Math.round(speed / 4));
    let tn, tb;
    for (let k = 0; k < step && i < lines.length; k++, i++) {
      const l = lines[i];
      let m;
      if (l.startsWith('; CHANGE_LAYER')) layer++;
      else if ((m = l.match(/gcode_claim_action\s*:\s*(\d+)/))) stg = +m[1];
      else if ((m = l.match(/^M10[49] S(\d+)/))) tn = +m[1];
      else if ((m = l.match(/^M1[49]0 S(\d+)/))) tb = +m[1];
    }
    const done = i >= lines.length;
    applyReport({
      gcode_state: done ? 'FINISH' : layer === 0 ? 'PREPARE' : 'RUNNING', stg_cur: layer > 0 ? 0 : stg,
      layer_num: layer, total_layer_num: total, mc_percent: Math.round(i / lines.length * 100),
      mc_remaining_time: Math.round((lines.length - i) / speed / 60), mc_print_line_number: String(i),
      subtask_name: basename(path).replace(/\.gcode\.3mf$|\.3mf$|\.gcode$/i, ''), gcode_file: basename(path),
      spd_lvl: 2, spd_mag: 100,
      ...(tn !== undefined ? { nozzle_target_temper: tn } : {}), ...(tb !== undefined ? { bed_target_temper: tb } : {}),
      nozzle_temper: (state.print.nozzle_target_temper || 26) - 0.4, bed_temper: (state.print.bed_target_temper || 26) - 0.2,
    });
  }, 250);
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.stl': 'application/octet-stream', '.3mf': 'application/octet-stream', '.gcode': 'text/plain', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/status') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(snapshot())); }
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`event: status\ndata: ${JSON.stringify(snapshot())}\n\n`);
    if (state.file) res.write(`event: file\ndata: ${JSON.stringify(state.file)}\n\n`);
    clients.add(res); const ka = setInterval(() => res.write(': ka\n\n'), 15000);
    req.on('close', () => { clients.delete(res); clearInterval(ka); });
    return;
  }
  // 靜態檔案（不讓外面讀到設定檔與 node_modules）
  let p = decodeURIComponent(url.pathname); if (p === '/') p = '/index.html';
  const f = normalize(join(ROOT, p));
  if (!f.startsWith(ROOT) || /config\.local|node_modules|[\\/]\./.test(f) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(f).pipe(res);
});
// 預設只給本機看；要給區網其他裝置（手機、平板）看，在 config.local.json 設 "host": "0.0.0.0"
const HOST = cfg.host || '127.0.0.1';
server.on('error', e => { console.log(e.code === 'EADDRINUSE' ? `port ${PORT} 已經有人在用（可能已經開著一個），結束` : e.message); process.exit(1); });
let stopMqtt = null, running = false;
async function start() {
  if (running) return; running = true;
  await new Promise(r => server.listen(PORT, HOST, r));
  console.log(`PRINT//TRACE 在 http://localhost:${PORT}/ ${SIM ? '（模擬模式）' : ''}`);
  if (SIM) startSim(SIM); else if (cfg.ip) stopMqtt = await startMqtt(); else console.log('沒有 config.local.json，只提供網頁');
}
function stop() {
  if (!running) return; running = false;
  stopMqtt?.(); stopMqtt = null;
  for (const res of clients) res.end(); clients.clear();
  server.close(); server.closeAllConnections?.();
  console.log('[server] 已停止');
}

// --with-slicer：跟著切片軟體開關。背景待命，偵測到 OrcaSlicer／Bambu Studio 在跑才啟動，關掉就停止
const SLICERS = process.platform === 'win32' ? ['orca-slicer.exe', 'bambu-studio.exe'] : ['OrcaSlicer', 'BambuStudio', 'orca-slicer', 'bambu-studio'];
function slicerRunning() {
  return new Promise(resolve => {
    const [cmd, args] = process.platform === 'win32' ? ['tasklist', ['/FO', 'CSV', '/NH']] : ['ps', ['-A', '-o', 'comm=']];
    execFile(cmd, args, { windowsHide: true, maxBuffer: 8 << 20 }, (err, out) => {
      if (err) return resolve(false);
      const low = out.toLowerCase(); resolve(SLICERS.some(n => low.includes(n.toLowerCase())));
    });
  });
}
if (process.argv.includes('--with-slicer')) {
  // 背景執行看不到視窗，訊息寫到 cache/server.log
  const logFile = join(CACHE, 'server.log');
  const orig = console.log;
  console.log = (...a) => { const line = `${new Date().toLocaleString('zh-TW', { hour12: false })} ${a.join(' ')}`; orig(line); try { appendFileSync(logFile, line + '\n'); } catch { } };
  console.log('[server] 待命中，等切片軟體開啟');
  const tick = async () => { const on = await slicerRunning(); if (on && !running) { console.log('[server] 偵測到切片軟體，啟動'); await start(); } else if (!on && running) { console.log('[server] 切片軟體已關閉'); stop(); } };
  tick(); setInterval(tick, 3000);
} else start();
