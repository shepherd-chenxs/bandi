/* runtime-view.mjs —— 运行时/外部件给界面看的形状（2026-10-22 由 server.mjs 拆出）。
 * routes 表与 routes/runtime.mjs 共用，保证两处口径一致。 */

import * as runtimes from './runtimes.mjs';
import * as externals from './externals.mjs';
import * as store from './store.mjs';


/**
 * 供界面用的运行时清单：取自 runtimes 配置层（可在「设置 → 运行时」改）。
 * `blocked` 是这个环境里的实测结论，不再是写死在 server 里的常量。
 */
export function runtimeOptions() {
  return runtimes.publicList().map((r) => ({
    id: r.id,
    family: r.family,
    /*
     * 名字里带上"那台机器在不在线"（2026-10-16）：选一个离线节点的运行时，
     * 活**不会立刻跑**，而是排进那台机器的队列里等它回来 —— 这点得在下拉里就看得见，
     * 否则用户会以为点了没反应。
     */
    label: r.remote && r.nodeOnline === false ? `${r.label}（离线）` : r.label,
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
 * 这台总机对局域网**自报家门**的那一份数据（2026-10-20，设计 §5.4）。
 *
 * 两个出口共用同一份口径：`GET /api/hello`（HTTP，加入向导"探地址"用它）与
 * UDP 8788 的应答（见 lan-announce.mjs）。**故意不带任何秘密** —— 这些字段
 * PRD P0-1 已经定成"局域网可见"（机器名、主机名、端口、能不能加入、版本）。
 *
 * ⚠️ `allowLan` 取的是**开关值**（`netmode.readNetMode().allowLan`），不是"现在听没听 0.0.0.0"：
 * 它仍是开关值的广播（`/api/lan` 页口径不动）。而**能不能加入**由 `netmode.isJoinable()`
 * 判（2026-10-20 增量 1，设计 §1.1/§1.2）：云端总机（`BANDI_HOST=0.0.0.0` 显式监听、开关值
 * 恒为 false）在这里必须回 `joinable:true` —— 否则节点探测会把它误报成"没开局域网开关"（E1091）。
 * 判定与 UDP 应答包共用同一函数，杜绝两份逻辑漂移。
 */

export async function withExternals(dev) {
  if (!dev) return dev;
  // 说明表按**那台机器**的平台算（控制面在 Linux、节点是 Windows 时，命令不是同一条）
  const catalog = externals.publicExternals(dev.platform);
  /*
   * 顺手把**最近那件小事**带上（装运行时 / 装外部件）。
   *
   * 为什么要有这一条（2026-10-16 用户报的"刷新页面，看不到安装进度了"）：
   * 进度原来只活在**浏览器**里（写在点击处理器的轮询里）—— 一刷新就没了，
   * 而那件事其实**还在那台机器上跑着**。按这条架构一贯的原则（**状态在服务端**），
   * 进度也该从服务端读回来：刷新、换台电脑、明天再看，都还是它。
   *
   * 2026-10-21：本机也带上 —— 本机那颗「在这台机器上安装」和节点共用这一套
   * （任务表按设备 id 存，本机那条的 nodeId 就是 `local`）。
   */
  const [task] = store.listNodeTasks(dev.id, 1);
  if (dev.kind === 'node') {
    return {
      ...dev,
      task: store.publicNodeTask(task),
      externals: { probed: dev.externalsProbed ?? [], catalog },
    };
  }
  return { ...dev, task: store.publicNodeTask(task), externals: { probed: await externals.declared(), catalog } };
}

/** 这个模型名账本里有没有（空值永远合法＝用 CLI 默认） */
