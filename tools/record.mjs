// 錄下印表機每一筆回報的 layer_num／mc_percent／stg_cur 變化（含時間），寫到 tools/work/record.log
import mqtt from 'mqtt';
import { readFileSync, appendFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync(new URL('../config.local.json', import.meta.url)).toString().replace(/^﻿/, ''));
const LOG = new URL('./work/record.log', import.meta.url);
const c = mqtt.connect(`mqtts://${cfg.ip}:8883`, { username: 'bblp', password: cfg.accessCode, rejectUnauthorized: false });
const last = {}; let started = false;   // 要先看到開始列印，之後的「完成」才算這次的
const log = s => { const line = `${new Date().toISOString().slice(11, 23)} ${s}`; console.log(line); appendFileSync(LOG, line + '\n'); };
c.on('connect', () => { log('connected'); c.subscribe(`device/${cfg.serial}/report`); c.publish(`device/${cfg.serial}/request`, JSON.stringify({ pushing: { sequence_id: '1', command: 'pushall' } })); });
c.on('message', (t, b) => {
  const p = JSON.parse(b.toString()).print; if (!p) return;
  const ch = [];
  for (const k of ['gcode_state', 'stg_cur', 'layer_num', 'total_layer_num', 'mc_percent', 'mc_remaining_time', 'mc_print_line_number'])
    if (k in p && p[k] !== last[k]) { ch.push(`${k}=${p[k]}`); last[k] = p[k]; }
  log(`msg${ch.length ? ' ' + ch.join(' ') : ''}`);
  if (p.gcode_state === 'RUNNING' || p.gcode_state === 'PREPARE') started = true;
  if (started && (p.gcode_state === 'FINISH' || p.gcode_state === 'FAILED')) { log('done'); setTimeout(() => process.exit(0), 1000); }
});
