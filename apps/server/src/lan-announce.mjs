/**
 * ~~总机侧 UDP 8788 应答器~~ → **已下线（2026-11-02）**。
 *
 * 原职责：有人 UDP 广播探测时回一条"我在这儿、能不能加入"（2026-10-20，设计 §5.5/§13.3）。
 * 下线原因：**发起端全部退场了** ——
 *   · 手机壳 2026-11-01 三改起连接语义 = 扫码默认 + 地址 + 邀请码，局域网也填地址，
 *     Rust 里的 `discover` command 保留但启动页不再调用（apps/mobile/README.md「为什么局域网也要求填地址」）；
 *   · 网页/桌面控制面从未接过「扫局域网」（`/api/local/discover` 前端零引用）；
 *   · 总机-分机加入走 HTTP claim，从不依赖 UDP。
 * 只剩应答端空转 = 纯粹给局域网扫描者报信（服务存在 + 机器名 + 端口），不赚任何功能，删。
 *
 * 本文件降级为**状态存根**：`sync()`/`state()` 的形状原样保留 ——
 * `server.mjs` 的三处 `lanAnnounce.sync(...)` 与 `/api/runtime` 的 `discovery` 字段
 * 不用动，永远报 `{on:false, port:0}`。哪天要做局域网自动发现，从这里重新长出来。
 */

/** `sync()` 最后一次被告知的 HTTP 端口（`state().httpPort` 的来源） */
let httpPortOfHost = 0;

/**
 * 按当前形态与实际监听地址"启停"（幂等）—— 现在恒为停。
 * 参数签名保留（`allowLan`/`explicit`/`boundHost`/`httpPort`），调用方不用改。
 * （`acceptNodes` 已随多机节点子系统于 2026-11-09 退场。）
 */
export function sync({ httpPort } = {}) {
  const port = Number(httpPort) > 0 ? Math.round(Number(httpPort)) : 0;
  httpPortOfHost = port;
  return state();
}

/** 停掉（没开也算成功）—— 现在是空操作，留着保形状 */
export function stop() {
  return state();
}

/** 发现服务状态：已下线，恒 `{on:false, port:0}`；`httpPort` 照实报 */
export function state() {
  return { on: false, port: 0, httpPort: httpPortOfHost || null };
}
