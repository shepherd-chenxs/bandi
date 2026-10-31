/* security/local-policy.mjs —— 本机接口的**声明式授权表**（默认拒绝）。
 *
 * 起因（姊妹文档 `2026-10-31-本机接口授权-设计.md` v5）：`/api/local/*` 原来只有一道
 * 「来源必须是回环」的一刀切（`E1094`）。它既不分身份、也不分读/写/危险动作，于是：
 *   · 本机管理员在 `192.168.x.x:8787` 上被挡（正常需求做不了）；
 *   · `panel` 令牌这种不该碰本机管理的身份，只是"恰好"被同一道闸挡住了；
 *   · 每加一个本机接口就要在 handler 里再写一遍判断 —— 这就是打补丁。
 *
 * 现在把口径写成一张表：**角色管"是什么身份"，`X-Bandi-Local` 管"能不能碰这台机器"**，
 * 两条同时满足才放行；`loopback` 来源不看角色也不要秘密（单机形态零摩擦，一个字节没变）。
 *
 * 纯逻辑：不 import store、不写 SQL、不碰 DOM —— 所以可以被 smoke 用例直接穷举。
 */

/** 与 `store.SCOPE_PANEL` 同一个字面量。**故意不 import store**：那个模块一加载就开库，
 *  这条判定不该为了一个字符串把数据库拖进来（smoke 用例也要能在空目录里跑）。 */
const SCOPE_PANEL = 'panel';

/**
 * `secret` 三档（与 IAM §8.3 一致，和来源正交）：
 *   · `'never'`   —— 只读接口，任何来源都不要秘密；
 *   · `'network'` —— **只有从网络来**才要（本机终端不要）；
 *   · `'always'`  —— 任何来源都要（本项目的服务器形态用不到，留给极端部署）。
 *
 * ⚠️ `/api/restart` 也在这张表里：它不在 `/api/local/` 前缀下（`routes/runtime.mjs`），
 * 靠前缀规则兜不住，必须逐条登记。
 */
export const LOCAL_POLICY = [
  // 只读状态：网络来源也放行、不要秘密 —— 反代后面的设置页要显示本机 / 协作状态，
  // 要秘密就等于永远显示不出来（IAM §10.1.2 也因此只 deny 破坏性路径）。
  { method: 'GET', path: '/api/local/status', principals: ['operator', 'admin'], secret: 'never' },
  { method: 'GET', path: '/api/local/collab/status', principals: ['operator', 'admin'], secret: 'never' },
  { method: 'GET', path: '/api/local/backups', principals: ['operator', 'admin'], secret: 'never' },

  // 破坏性：本机来源不要秘密；从网络来必须带 X-Bandi-Local（只有本机进程读得到）。
  { method: 'POST', path: '/api/local/collab/join', principals: ['operator', 'admin'], secret: 'network' },
  { method: 'POST', path: '/api/local/collab/leave', principals: ['operator', 'admin'], secret: 'network' },
  { method: 'POST', path: '/api/local/export', principals: ['operator', 'admin'], secret: 'network' },
  { method: 'POST', path: '/api/local/import', principals: ['operator', 'admin'], secret: 'network' },
  { method: 'POST', path: '/api/local/hosts/add', principals: ['operator', 'admin'], secret: 'network' },
  { method: 'POST', path: '/api/local/hosts/test', principals: ['operator', 'admin'], secret: 'network' },
  { method: 'POST', path: '/api/local/hosts/remove', principals: ['operator', 'admin'], secret: 'network' },
  { method: 'POST', path: '/api/local/discover', principals: ['operator', 'admin'], secret: 'network' },
  { method: 'POST', path: '/api/local/probe', principals: ['operator', 'admin'], secret: 'network' },
  { method: 'POST', path: '/api/local/join', principals: ['operator', 'admin'], secret: 'network' },
  { method: 'POST', path: '/api/local/leave', principals: ['operator', 'admin'], secret: 'network' },
  /*
   * ⚠️ **`/api/restart` 是这张表里唯一一条"网络来源不要秘密"的破坏性动作**，故意的，
   * 理由两条：
   *   ① 它**不动数据、不外带数据** —— 只把监听地址换一下。风险是"别人能重启你的服务"，
   *      而那已经被 `operator / admin` 挡住了（拿到管理会话的人本来就能删库，不缺这一下）；
   *   ② 要求秘密会造成**单向门**：开了局域网 → 监听变 0.0.0.0 → 之后浏览器里所有请求都是
   *      network 来源 → 想再点「重启」退回单机就永远 E4097，只能去终端敲 CLI。
   *      一个"开了关不掉"的开关比这点风险糟得多。
   * 部署契约里反代仍然 deny `/api/restart`（IAM §10.1.2），那一道比秘密更硬。
   */
  { method: 'POST', path: '/api/restart', principals: ['operator', 'admin'], secret: 'never' },
];

/**
 * `req.bandiAuth` → 策略表里的身份名（IAM §2.1 那张表）。
 * 认不出来的（revoked / 空）一律 `'anonymous'` —— 落进"不在 principals 里"，默认拒绝。
 */
export function principalKind(auth) {
  if (!auth) return 'anonymous';
  if (auth.kind === 'operator') return 'operator';
  if (auth.kind === 'user') return auth.admin ? 'admin' : 'member';
  if (auth.kind === 'device') return 'device';
  if (auth.kind === 'node') {
    const scope = auth.scope instanceof Set ? auth.scope : new Set();
    return scope.has(SCOPE_PANEL) ? 'panel' : 'compute';
  }
  return 'anonymous';
}

/** 精确匹配（目前这一组全是固定路径，没有 `:id`；真出现了就在这儿加 RegExp 行） */
function rowFor(method, pathname) {
  const m = String(method ?? '').toUpperCase();
  return LOCAL_POLICY.find((r) => r.method === m && r.path === pathname) ?? null;
}

const deny = (code, status, message, hint) => ({ allow: false, code, status, message, hint });

/**
 * 判定。返回 `{ allow: true }` 或 `{ allow: false, code, status, message, hint }`。
 *
 * 顺序（IAM §8.4）：**登记 → 身份 → 位置/秘密**。
 * 反过来判会把"没登记"说成"你身份不够"，排查时变成猜。
 *
 * @param {{method:string, pathname:string, source:'loopback'|'network',
 *          principal:{kind:string, admin?:boolean, scope?:Set}|null,
 *          hasSecret:boolean}} ctx
 */
export function authorizeLocal({ method, pathname, source, principal, hasSecret }) {
  const row = rowFor(method, pathname);
  if (!row) {
    return deny('E4090', 404, '本机接口未在策略表登记（默认拒绝）', '这是代码问题：新加本机接口要先在 security/local-policy.mjs 登记');
  }

  // 物理在本机：不看角色、也不要秘密（与改造前行为完全一致）
  if (source === 'loopback') return { allow: true };

  const kind = principalKind(principal);
  if (!row.principals.includes(kind)) {
    return deny(
      'E4091',
      403,
      '当前身份不能做本机管理动作（需要操作员或管理员）',
      kind === 'anonymous'
        ? '先登录，或带上操作员令牌（数据目录 token 文件）。'
        : '本机管理动作只对操作员 / 管理员开放；普通账号请在桌面端操作。',
    );
  }

  const needSecret = row.secret === 'always' || (row.secret === 'network' && source === 'network');
  if (needSecret && !hasSecret) {
    return deny(
      'E4097',
      403,
      '这个动作需要 X-Bandi-Local（服务器形态请在本机终端用 CLI 执行）',
      '值在数据目录的 local_secret 文件里；`bandi collab join` / `bandi data export` 会自动带上。',
    );
  }

  return { allow: true };
}

/** 表里登记过的路径（smoke 覆盖检查用：`routes/local.mjs` 的字面量必须都在这里面） */
export function registeredPaths() {
  return LOCAL_POLICY.map((r) => r.path);
}
