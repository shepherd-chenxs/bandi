#!/usr/bin/env node
/**
 * **分发链自检**：`routes/*.mjs` 的实现 ↔ `routes/chain.mjs` 的登记表（2026-11-08 加）。
 *
 * 为什么要有：`chain.mjs` 之前的形态是 server.mjs 里 25 段手写 if —— 加一个路由模块
 * 忘了挂上去，**什么都不会报**：文件在、import 在（甚至没有 import），接口就是 404。
 * 这类"漏挂"只有真去请求那一条才发现，而它往往在手机端/边角功能上，平时没人点。
 *
 * 反方向也要查：表里登记了、模块里却没有那个导出（改名/删函数后），启动时才炸，
 * 而那时人已经在"为什么服务起不来"里绕了。
 *
 * 这一条**不启动服务、不开库**，纯源码文本 —— 所以能挂在 PR 门禁的最前面。
 *
 * 跑法：node tools/check-dispatch-chain.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routesDir = path.join(repo, 'apps', 'server', 'src', 'routes');
const chainFile = path.join(routesDir, 'chain.mjs');
const serverFile = path.join(repo, 'apps', 'server', 'src', 'server.mjs');

const rel = (p) => path.relative(repo, p).split(path.sep).join('/');

let bad = 0;
const err = (msg) => {
  console.error('  ✗ ' + msg);
  bad += 1;
};
const ok = (msg) => console.log('  ✓ ' + msg);

if (!fs.existsSync(chainFile)) {
  console.error('找不到 apps/server/src/routes/chain.mjs —— 分发链表被删了？');
  process.exit(1);
}

const chainSrc = fs.readFileSync(chainFile, 'utf8');

/* ------------------------------------------------ ① 表里的顺序与 import 的对应 */

const imports = new Map(); // handle 名 → 模块文件名
for (const m of chainSrc.matchAll(/import\s*\{\s*(\w+)\s*\}\s*from\s*'\.\/([\w.-]+)\.mjs'/g)) {
  imports.set(m[1], m[2]);
}

const entries = [...chainSrc.matchAll(/\{\s*id:\s*'([^']+)',\s*handle:\s*(\w+)/g)].map((m) => ({
  id: m[1],
  handle: m[2],
}));

console.log('分发链（按顺序）：');
entries.forEach((e, i) => console.log(`  ${String(i + 1).padStart(2, ' ')}. ${e.id}  →  ${e.handle}`));

if (!entries.length) err('chain.mjs 里一条都认不出来（格式变了？）');

const ids = new Set();
for (const e of entries) {
  if (ids.has(e.id)) err(`id 重复：${e.id}`);
  ids.add(e.id);
  const mod = imports.get(e.handle);
  if (!mod) {
    err(`${e.id}：handle 叫 ${e.handle}，但 chain.mjs 顶部没有 import 它`);
    continue;
  }
  if (!fs.existsSync(path.join(routesDir, `${mod}.mjs`))) err(`${e.id}：import 的 ./${mod}.mjs 不存在`);
}

/* -------------------------------------- ② 每个路由模块导出的 handler 都必须挂在表上 */

const files = fs.readdirSync(routesDir).filter((f) => f.endsWith('.mjs') && f !== 'chain.mjs');
const used = new Set(entries.map((e) => e.handle));
const allExported = new Set();

console.log('\n模块 ↔ 表：');
for (const f of files.sort()) {
  const src = fs.readFileSync(path.join(routesDir, f), 'utf8');
  const handlers = [...src.matchAll(/export\s+(?:async\s+)?function\s+(handle\w+)/g)].map((m) => m[1]);
  /*
   * 走的是另一条路的两个模块，不算漏挂：
   *   · local.mjs —— /api/local/* 在链之前单独判（它判的是"本机身份"，不是普通路由）；
   *   · hub.mjs   —— /hub/enter 是"验票换会话"的动作，也排在链之前（见 server.mjs 注释）。
   * 它们仍然是登记过的路由（route-policy 里能查到），只是不走正则链。
   */
  if (f === 'local.mjs' || f === 'hub.mjs') continue;
  if (!handlers.length) continue; // 纯工具模块（没有导出 handler）不参与
  for (const h of handlers) {
    allExported.add(h);
    const times = entries.filter((e) => e.handle === h).length;
    if (times === 0) err(`${rel(path.join(routesDir, f))} 导出的 ${h} 没挂在 chain.mjs 上 —— 那条路会一直 404`);
    else if (times > 1) err(`${h} 在表里挂了 ${times} 次`);
    else ok(`${f} → ${h}`);
  }
}

// 表里挂了一个没人导出的名字（改名/删函数）
for (const e of entries) {
  if (!imports.has(e.handle)) continue;
  const mod = `${imports.get(e.handle)}.mjs`;
  if (!files.includes(mod)) continue;
  if (!allExported.has(e.handle) && !e.handle.startsWith('handle')) err(`${e.id}：${e.handle} 不是任何模块导出的 handler`);
}

/* ----------------------------------------------- ③ 服务端只能有这一条分发路径 */

const serverSrc = fs.readFileSync(serverFile, 'utf8')
  // 先把注释剥掉：server.mjs 的注释里就写着 `await handleX(...)`（讲改造前长什么样），
  // 直接扫原文会把它当成分发调用 —— 自己把自己的说明判成违规
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
// handleLocal / handleHub 在链之前单独判（它们判的不是 /api 路径），不算第二条链
const strays = [...serverSrc.matchAll(/await\s+(handle[A-Z]\w*)\s*\(/g)]
  .map((m) => m[1])
  .filter((h) => h !== 'handleLocal' && h !== 'handleHub');
if (strays.length) {
  err(`server.mjs 里还有绕开 chain 的分发调用：${[...new Set(strays)].join('、')} —— 顺序会重新变成隐式的`);
} else {
  ok('server.mjs 只有 runChain 一条分发路径');
}

console.log(bad ? `\n✗ 分发链对不上（${bad} 处）` : '\n✓ 分发链完整');
process.exit(bad ? 1 : 0);
