/**
 * context-probe.mjs —— 从**运行时自己的会话转录**里读真实上下文（2026-11-12）。
 *
 * 起因（用户实报「一个会话上下文就爆了，bandi 是不是特别耗上下文」）：
 * 轮换判据把 `turn.completed.usage.inputTokens` 当成了"单轮上下文"，但那是**整轮所有
 * API 调用求和** —— 34 步 ssh 的工具活每步都重发一遍上下文，缓存命中不涨窗口、却照涨这个数，
 * 于是一次重活堆出 234 万，被判"单轮 234 万 ≥ 10 万"→ 换会话。而 Codex 自己在会话转录里
 * 一直记着真数：`token_count.info.last_token_usage.input_tokens` 是**最后一调**的输入
 * （= 当前真实上下文），`model_context_window` 是模型窗口（实测 group/never-stuck 是 95 万，
 * 不是注释里那位老兄写的 128k）。
 *
 * 契约：读不到就返回 null（文件不在 / 权限 / 老版本没有 token_count），调用方回退旧口径 ——
 * 探测是锦上添花，绝不能因为它让 run 收尾出错。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');
/** 转录尾部读多少字节就够找到最后一条 token_count：一条事件几百字节，256KB 绰绰有余 */
const TAIL_BYTES = 256 * 1024;

/** threadId → 转录文件路径（一个进程内缓存；同一条会话会连着跑很多轮） */
const fileCache = new Map();

/**
 * 在 sessions/<年>/<月>/<日>/rollout-*.jsonl 里找这条会话的转录。
 * 从最近的日期往回找，命中即停 —— 会话总是近期的，没必要全树扫。
 */
function findRollout(threadId) {
  if (fileCache.has(threadId)) {
    const hit = fileCache.get(threadId);
    if (hit && fs.existsSync(hit)) return hit;
  }
  const suffix = `-${threadId}.jsonl`;
  let years;
  try { years = fs.readdirSync(SESSIONS_ROOT).sort().reverse(); } catch { return null; }
  for (const y of years) {
    const yp = path.join(SESSIONS_ROOT, y);
    let months; try { months = fs.readdirSync(yp).sort().reverse(); } catch { continue; }
    for (const m of months) {
      const mp = path.join(yp, m);
      let days; try { days = fs.readdirSync(mp).sort().reverse(); } catch { continue; }
      for (const d of days) {
        const dp = path.join(mp, d);
        let files; try { files = fs.readdirSync(dp); } catch { continue; }
        const hit = files.find((f) => f.endsWith(suffix));
        if (hit) {
          const full = path.join(dp, hit);
          fileCache.set(threadId, full);
          return full;
        }
      }
    }
  }
  fileCache.set(threadId, null);
  return null;
}

/**
 * 这条 Codex 会话的**真实上下文**。
 * @returns {{contextTokens:number, contextWindow:number}|null}
 *   contextTokens = 最后一次调用的 input（当前上下文）
 *   contextWindow = 模型窗口
 */
export function codexContextOf(threadId) {
  if (!threadId) return null;
  try {
    const file = findRollout(threadId);
    if (!file) return null;
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (!l.includes('"token_count"')) continue;
      let j;
      try { j = JSON.parse(l); } catch {
        // 尾部截断可能把第一行切半，忽略即可
        continue;
      }
      const info = j?.payload?.info;
      if (!info) continue;
      const tokens = Number(info.last_token_usage?.input_tokens ?? 0) || 0;
      if (!tokens) continue;
      return { contextTokens: tokens, contextWindow: Number(info.model_context_window ?? 0) || 0 };
    }
    return null;
  } catch {
    return null;
  }
}
