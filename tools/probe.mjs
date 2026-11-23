// 連線測試：連上 A1 的 MQTT，要一次完整狀態（pushall），印出重要欄位後結束
import mqtt from 'mqtt';
import { readFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync(new URL('../config.local.json', import.meta.url)).toString().replace(/^﻿/, ''));
const c = mqtt.connect(`mqtts://${cfg.ip}:8883`, { username: 'bblp', password: cfg.accessCode, rejectUnauthorized: false, connectTimeout: 8000, reconnectPeriod: 0 });
const done = (msg) => { console.log(msg); c.end(true); process.exit(0); };
setTimeout(() => done('TIMEOUT'), 15000);
c.on('error', e => done('ERROR ' + e.message));
c.on('connect', () => {
  console.log('connected');
  c.subscribe(`device/${cfg.serial}/report`);
  c.publish(`device/${cfg.serial}/request`, JSON.stringify({ pushing: { sequence_id: '0', command: 'pushall' } }));
});
c.on('message', (t, buf) => {
  const j = JSON.parse(buf.toString()); const p = j.print || {};
  if (p.command !== 'push_status') return;
  const keys = ['gcode_state', 'stg_cur', 'mc_print_stage', 'layer_num', 'total_layer_num', 'mc_percent', 'mc_remaining_time', 'gcode_file', 'subtask_name', 'spd_lvl', 'spd_mag', 'nozzle_temper', 'nozzle_target_temper', 'bed_temper', 'bed_target_temper', 'print_type', 'mc_print_line_number', 'sdcard', 'hw_switch_state', 'ipcam', 'ams', 'vt_tray', 'ams_status'];
  const o = {}; for (const k of keys) if (k in p) o[k] = p[k];
  console.log(JSON.stringify(o, null, 1)); console.log('all keys:', Object.keys(p).join(','));
  done('');
});

