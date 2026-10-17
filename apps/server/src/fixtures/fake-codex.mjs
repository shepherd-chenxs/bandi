/**
 * 测试用的**假 codex 运行时**（2026-10-17）。
 *
 * 为什么需要：`smoke-node.mjs` / `smoke-node-jobs.mjs` 原来靠"本机恰好装了真 codex"才能过 ——
 * 本地全绿、CI 的干净 runner 上一片红（节点自报的运行时清单是空的）。
 * 这跟闸门里硬编码 `.agents/` 是同一类病：**用例不该依赖跑它的那台机器**。
 *
 * 做法：按 `runtimes.mjs` 的探测布局造一个完整的"看起来装了 codex"的结构：
 *
 *   <root>/bin/codex[.cmd]                              ← findOnPath 要找的那个 shim
 *   <root>/bin/node_modules/@openai/codex/bin/codex.js  ← 探测"推出真身"的 .js（= fixtures/fake-agent.js）
 *
 * 把 `<root>/bin` 塞进子进程的 PATH，节点就会"探测到"一个 codex，而且真跑起来是**假 agent**
 * （只吐 codex 事件词汇，不烧 token）。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 造一个假 codex 的 bin 目录，返回它（调用方拼进 PATH 最前面） */
export function makeFakeCodexBin(root) {
  const bin = path.join(root, 'bin');
  const pkgDir = path.join(bin, 'node_modules', '@openai', 'codex', 'bin');
  fs.mkdirSync(pkgDir, { recursive: true });

  // 真身：直接把 fixtures/fake-agent.js 复制成 codex.js（它就是照着 codex 的事件词汇写的）
  const fakeAgent = path.join(import.meta.dirname, 'fake-agent.js');
  fs.copyFileSync(fakeAgent, path.join(pkgDir, 'codex.js'));

  // shim：探测只要它**存在**（launchCommand 起的是那个 .js），所以内容无所谓
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'codex.cmd'), '@echo off\r\nrem 测试用假 codex（真身是同目录的 node_modules 里那份）\r\n', 'utf8');
  } else {
    const p = path.join(bin, 'codex');
    fs.writeFileSync(p, '#!/bin/sh\n# 测试用假 codex（不执行，真身在同目录的 node_modules 里）\nexit 0\n', 'utf8');
    fs.chmodSync(p, 0o755);
  }
  return bin;
}
