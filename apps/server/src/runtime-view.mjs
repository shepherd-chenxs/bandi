/* runtime-view.mjs —— 运行时/外部件给界面看的形状（2026-10-22 由 server.mjs 拆出）。
 * routes 表与 routes/runtime.mjs 共用，保证两处口径一致。 */

import * as runtimes from './runtimes.mjs';
import * as externals from './externals.mjs';


/**
 * 供界面用的运行时清单：取自 runtimes 配置层（可在「设置 → 运行时」改）。
 * `blocked` 是这个环境里的实测结论，不再是写死在 server 里的常量。
 */
export function runtimeOptions() {
  return runtimes.publicList().map((r) => ({
    id: r.id,
    family: r.family,
    label: r.label,
    sandboxes: r.sandboxes,
    blocked: r.blocked,
    enabled: r.enabled,
  }));
}

/**
 * 这个运行时 id 收不收。
 *
 * `'auto'` 也是合法值（`runtimes.resolveForRun` 认识它：按"谁现在能用"挑一个）——
 * 内置秘书就用它，这样换机器、换 CLI 都不用回来改她。界面上只有内置员工的下拉里有这一条。
 */

export function runtimesOk(id) {
  return id === 'auto' || runtimeOptions().some((r) => r.id === id);
}

/* --------------------------------------------------- 局域网发现与"自报家门" */

/*
 * 这台机器对局域网**自报家门**的那一份数据。
 *
 * 两个出口共用同一份口径：`GET /api/hello`（HTTP，加入向导"探地址"用它）与
 * UDP 8788 的应答（见 lan-announce.mjs）。**故意不带任何秘密** —— 这些字段
 * PRD P0-1 已经定成"局域网可见"（机器名、主机名、端口、版本）。
 */

export async function withExternals(dev) {
  if (!dev) return dev;
  // 说明表按本机平台算（现在只有本机一台设备）
  const catalog = externals.publicExternals(dev.platform);
  return { ...dev, externals: { probed: await externals.declared(), catalog } };
}

/** 这个模型名账本里有没有（空值永远合法＝用 CLI 默认） */
