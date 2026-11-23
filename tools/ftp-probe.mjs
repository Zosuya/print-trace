// 連線測試：用 FTPS（implicit TLS, port 990）列出 A1 SD 卡上的檔案
import { Client } from 'basic-ftp';
import { readFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync(new URL('../config.local.json', import.meta.url)).toString().replace(/^﻿/, ''));
const c = new Client(15000);
try {
  await c.access({ host: cfg.ip, port: 990, user: 'bblp', password: cfg.accessCode, secure: 'implicit', secureOptions: { rejectUnauthorized: false } });
  for (const dir of ['/', '/cache', '/model']) {
    try { await c.cd(dir); const l = await c.list(); console.log(dir, '→', l.slice(0, 15).map(f => (f.isDirectory ? '[d]' : '') + f.name + (f.isFile ? ` (${f.size})` : '')).join('  ')); }
    catch (e) { console.log(dir, 'ERR', e.message); }
  }
} catch (e) { console.log('ERROR', e.message); }
c.close();

