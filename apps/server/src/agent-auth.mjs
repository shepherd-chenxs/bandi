/**
 * 员工的"工作证"（2026-10-24）：给**正在跑的那次运行**发一把一次性钥匙，
 * 员工凭它调平台少数几个专用接口（现在是建卡，见 routes/agent-cards.mjs）。
 *
 * 为什么是"运行级"而不是"员工级"：钥匙跟着活走 —— run 起来才发、收尾就吊销。
 * 员工本人（库里那行）从来不需要长期密钥，也就不存在"密钥泄露了怎么办"的存量问题；
 * 服务的内存 Map 一重启全清，旧进程手里的旧钥匙当场作废。
 *
 * 身份是**注入的、不是员工自报的**：startRun 把 token 塞进 agent 进程的环境变量，
 * 员工原样带回接口来验。冒名者拿不到别人进程里的环境变量。
 */
import { randomUUID } from 'node:crypto';
import { port } from './config.mjs';

/** agent 进程里能用的控制面地址（本机回环；远端节点的 agent 不在本机，拿不到钥匙也不该用） */
export const controlUrl = `http://127.0.0.1:${port}`;

const creds = new Map(); // token -> { runId, personaId }

/**
 * 给一次本地运行发钥匙。返回 null = 这次不发（远端节点跑的活，agent 在别的机器上，
 * 控制面的回环地址对它没意义）。
 */
export function issueRunCredential(runId, personaId, { local = true } = {}) {
  if (!local) return null;
  const token = `rt-${randomUUID().replace(/-/g, '')}`;
  creds.set(token, { runId, personaId });
  return { token };
}

/** 验钥匙：返回 { runId, personaId }；不对/过期返回 null。不吊销 —— 吊销跟着 run 收尾走。 */
export function verifyRunCredential(token) {
  return creds.get(String(token ?? '')) ?? null;
}

/** run 收尾吊销它的钥匙（按 runId 找，可能不止一把 —— 正常只有一把） */
export function revokeRunCredential(runId) {
  for (const [token, c] of [...creds]) {
    if (c.runId === runId) creds.delete(token);
  }
}

/*
 * 岗位判定（2026-11-11 移出）：以前这里是 `roleHeadOf` / `isPmRole` —— 按
 * 「岗位 · 职责」文本取第一段判"是不是项目经理"。那是"打四个字就拿到建卡权、
 * 改个写法就静默失去"的根。现在权限挂在内置岗位上，判定一律走
 * `roles.can(persona, '<权限>')`（见 roles.mjs / 设计文档），本模块只发钥匙。
 */
