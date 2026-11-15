/**
 * workspace 路由的**本机判定**（localBind）—— 2026-11-14 实报：
 * 默认监听 0.0.0.0 时，桌面端点聊天里的文件 pill → /api/open 被旧守卫
 * （只认 127.0.0.1/localhost）误判成 E2060「服务不在本机」。
 * 0.0.0.0 是所有网卡含回环 = 本机，必须放行；真绑了某个局域网地址才拒。
 *
 * 判据是纯函数（localBind），这里直接单测它的**形态矩阵**；
 * 路由本身不端到端跑 —— /api/open 放行后真会拉起系统浏览器，冒烟不该开窗。
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-wsopen-'));
/* BANDI_DATA / BANDI_DB 必须在 import 之前设好（store 在 import 时开库） */
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ' — ' + detail}`);
  if (!ok) failed += 1;
};

const ws = await import('./routes/workspace.mjs');
const { localBind } = ws;

check('0.0.0.0（默认绑定，全网卡含回环）→ 本机，放行', localBind('0.0.0.0') === true, String(localBind('0.0.0.0')));
check('127.0.0.1 / 127.9.9.9（回环）→ 放行', localBind('127.0.0.1') === true && localBind('127.9.9.9') === true,
  `${localBind('127.0.0.1')}/${localBind('127.9.9.9')}`);
check(':: 与 ::1（IPv6 通配/回环）→ 放行', localBind('::') === true && localBind('::1') === true,
  `${localBind('::')}/${localBind('::1')}`);
check('localhost（config 归一前的写法也兜住）→ 放行', localBind('localhost') === true, String(localBind('localhost')));
check('192.168.1.5 / 10.0.0.2（明确的局域网地址）→ 拒',
  localBind('192.168.1.5') === false && localBind('10.0.0.2') === false,
  `${localBind('192.168.1.5')}/${localBind('10.0.0.2')}`);
check('空 / 乱串 → 拒（不猜）', localBind('') === false && localBind('nonsense') === false && localBind(null) === false,
  `${localBind('')}/${localBind('nonsense')}/${localBind(null)}`);

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 库句柄还开着，删不掉就算了 */ }
if (failed) { console.log(`\n✗ ${failed} 项没过`); process.exit(1); }
console.log('\n✓ 全部通过');
