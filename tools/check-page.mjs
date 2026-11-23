// 檢查 index.html 裡主程式的語法（抽出 module script 用 node --check 跑）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const h = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const m = h.match(/<script type="module">([\s\S]*?)<\/script>/);
mkdirSync(new URL('./work/', import.meta.url), { recursive: true });
const out = new URL('./work/_page.mjs', import.meta.url);
writeFileSync(out, m[1].replace(/^import .*$/gm, ''));
try { execFileSync(process.execPath, ['--check', out.pathname.replace(/^\/([A-Z]:)/, '$1')], { stdio: 'inherit' }); console.log('語法 OK'); }
catch { process.exit(1); }
