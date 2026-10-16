#!/usr/bin/env node
/**
 * 启动班底平台（命令行那条路）。
 *
 * 为什么不是纯 .cmd：这里要做的事（判断端口被谁占、那个进程是不是我们自己的、
 * 结束它、等端口释放、等健康检查）用批处理写会又长又没法测。放在 Node 里能单测。
 *
 * ⚠️ **起停逻辑不在这里** —— 在 `apps/server/src/lifecycle.mjs`。
 * 桌面薄壳（`apps/desktop`）用的是**同一份**：壳要做的是同一件事，
 * 各写一份必然两边跑偏（就像前端当初那两套）。这里只负责"说人话 + 开浏览器"。
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureRunning, urlOf } from './apps/server/src/lifecycle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.BANDI_PORT ?? 8787);
const HOME = urlOf(PORT);
/*
 * 日志跟着**数据目录**走（`BANDI_DATA`；不设就是 `<仓库>/data`）。
 * 日志本来就是运行时数据 —— 数据指到别处、日志还留在仓库里，是两半。
 * `deploy/start-control-plane.sh` 也是这个规矩（日志进 `~/bandi-data/`）。
 */
const DATA = process.env.BANDI_DATA || path.join(root, 'data');
const LOG = path.join(DATA, 'server.log');
const FORCE = process.argv.slice(2).some((a) => a === '--restart' || a === '-restart');
const NO_BROWSER = process.env.BANDI_NO_BROWSER === '1'; // 测试时别真开浏览器

const say = (s) => console.log(s);

function openBrowser() {
  if (NO_BROWSER) {
    say('  （BANDI_NO_BROWSER=1，跳过打开浏览器）');
    return;
  }
  try {
    if (process.platform === 'win32') {
      spawn('powershell', ['-NoProfile', '-Command', `Start-Process '${HOME}'`], {
        detached: true, stdio: 'ignore', windowsHide: true,
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [HOME], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [HOME], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    say(`  （没能自动打开浏览器，手动访问 ${HOME}）`);
  }
}

/* ------------------------------------------------------------------ 主流程 */

say(`班底平台 · 端口 ${PORT}`);
say(`工作根 ${root}`);

const r = await ensureRunning({ port: PORT, logFile: LOG, force: FORCE });

// ① 已经在跑
if (r.action === 'already') {
  say(`\n已经在运行（PID ${(r.pids ?? []).join(', ') || '?'}）—— 不重启，直接开页面。`);
  say('要强制重启用 restart.cmd（会打断正在跑的任务）。');
  openBrowser();
  process.exit(0);
}

// ② 端口被**别人的程序**占着：一个都不动
if (r.action === 'alien') {
  say(`\n✗ 端口 ${PORT} 被**别的程序**占着，我不动它：`);
  for (const a of r.alien) say(`    PID ${a.pid}  ${a.name}  ${a.cmd || '(读不到命令行)'}`);
  say('\n请先自己处理它（或换个端口：set BANDI_PORT=8899 后再运行 start.cmd）。');
  process.exit(1);
}

// ③ 起不来
if (r.action === 'failed') {
  say(`\n✗ ${r.reason}`);
  if (r.logTail) say('--- 日志尾部 ---\n' + r.logTail);
  else say(`看日志：${LOG}`);
  process.exit(1);
}

// ④ 起来了：端口原来被我们自己的服务占着的话，说清楚是"强制重启"还是"僵死"
if (r.replaced?.length) {
  say(
    `\n端口被班底自己的服务占着（PID ${r.replaced.join(', ')}），` +
      `${r.forced ? '强制重启' : '但它不响应，判定僵死'} —— 结束它再起。`,
  );
}
say(`\n✓ 就绪 ${HOME}`);
openBrowser();
