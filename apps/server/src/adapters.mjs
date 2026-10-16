/**
 * 适配器注册表：**协议族 → 那个 CLI 的适配器**。
 *
 * 为什么单独一个文件：这个映射现在有**两个**使用者 ——
 *   · 控制面（`runs.mjs`）：本机那条路直接 spawn；
 *   · 节点（`node.mjs`）：领到的活在本机执行，用的是同一套适配器。
 * 放在 `runs.mjs` 里的话，节点为了拿这个映射就得把 store（进而整个 DB）也拉进来。
 * 一份真相，两处引用，谁都别自己再写一遍。
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
