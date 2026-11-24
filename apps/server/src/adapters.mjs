/**
 * 适配器注册表：**协议族 → 那个 CLI 的适配器**。
 *
 * 为什么单独一个文件：`runs.mjs` 要按协议族 spawn 对应的 agent CLI，而映射本身
 * 不该跟运行台账（store / DB）绑在一起 —— 独立成表，加一族 CLI 只改这里。
 * 历史上的第二个使用者是已删除的节点客户端（`node.mjs`），2026-11-09 随多机子系统退场。
 */
import { runTask as runCodex } from './codex.mjs';
import { runTask as runClaude } from './claude.mjs';
import { runDsh } from './dsh.mjs';

export const ADAPTERS = {
  codex: (opts) => runCodex(opts),
  claude: (opts) => runClaude(opts),
  dsh: (opts) => runDsh(opts),
};

/** 这个协议族有没有适配器（族是代码里写死的三家，不是配置能变出来的） */
export function adapterFor(family) {
  return ADAPTERS[family] ?? null;
}

export function knownFamilies() {
  return Object.keys(ADAPTERS);
}
