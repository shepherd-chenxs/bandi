/**
 * `security/policy.mjs` 的 `authorize` 穷举用例（姊妹文档 §3，2026-11-07 登录即全权模型）。
 *
 * 为什么单独一个文件、不起服务：`authorize` 是纯函数（只 import `route-policy.mjs` 的
 * 静态路由表，不碰 store、不读库、不开进程），所以可以在这里把 身份 × 每条策略
 * 全跑一遍，且能在空目录里直接 `node` 跑。
 *
 * 两件事必须钉住：
 *   ① 机器身份 vs 人：operator / 登录用户（kind:'user'）一律全权；
 *      run（运行钥匙）只许清单标 `run: true` 的那几扇门，其余 `E4034`；
 *      （node / revoked 身份 2026-11-09 随多机子系统整体删除，矩阵里不再有这两列 ——
 *        伪造出来的会落兜底 E4031，smoke-security-policy 已钉。）
 *   ② 覆盖：样例路径必须能在 `ROUTES` 命中（漏登记 = 路由表腐化）。
 *
 * 跑法：node apps/server/src/smoke-local-policy.mjs
 *       或：SMOKE_PORT=8907 node apps/server/src/smoke-local-policy.mjs
 */
import { authorize } from './security/policy.mjs';
import { findRoute } from './security/route-policy.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

// 新模型下的身份 principal —— 不再携带任何分级 / 菜单字段（旧角色体系已整体退场）。
const WHO = {
  operator: { kind: 'operator' },
  user: { kind: 'user' },
  run: { kind: 'run' },
};

const verdict = (who, method, path) => authorize({ who, method, pathname: path });

console.log('\n[1] 身份形状（kind 归一）');
check('operator.kind === operator', WHO.operator.kind === 'operator');
check('user.kind === user（登录即全权，不再分级）', WHO.user.kind === 'user');
check('run.kind === run（运行钥匙，边界收在清单标记上）', WHO.run.kind === 'run');

console.log('\n[2] 矩阵（身份 × 路由）');
/**
 * 每条 case 给一个 (method, path) 与预期：每个身份应得到的判定（'allow' 或错误码）。
 */
const CASES = [
  {
    // 普通可读路由（GET /api/me）：人全通；运行钥匙没被标 run:true → E4034
    tag: '可读路由（GET /api/me）',
    method: 'GET', path: '/api/me',
    expect: { operator: 'allow', user: 'allow', run: 'E4034' },
  },
  {
    // 管理路由：登录用户也全权（2026-11-07 角色体系退场）；运行钥匙照样进不来
    tag: '管理路由（GET /api/users）',
    method: 'GET', path: '/api/users',
    expect: { operator: 'allow', user: 'allow', run: 'E4034' },
  },
  {
    // 运行钥匙的专用口（建卡通道，route-policy 标 run:true）：机器身份里只有它过
    tag: '运行钥匙专用口（POST /api/agent/cards，run:true）',
    method: 'POST', path: '/api/agent/cards',
    expect: { operator: 'allow', user: 'allow', run: 'allow' },
  },
  {
    // 只读台账（GET /api/tasks，run:true）：秘书台账给运行钥匙开
    tag: '运行钥匙专用口（GET /api/tasks，run:true）',
    method: 'GET', path: '/api/tasks',
    expect: { operator: 'allow', user: 'allow', run: 'allow' },
  },
  {
    // 非 /api 页面：人与 operator 不拦（登录页/静态资源另有闸管）；
    // 运行钥匙是纯 API 身份，非 /api 一律 E4034
    tag: '非 /api 页面（GET /index.html）',
    method: 'GET', path: '/index.html',
    expect: { operator: 'allow', user: 'allow', run: 'E4034' },
  },
];

for (const c of CASES) {
  for (const [whoKey, expected] of Object.entries(c.expect)) {
    const got = verdict(WHO[whoKey], c.method, c.path);
    const ok = got === expected;
    check(
      `${whoKey} · ${c.method} ${c.path} → ${expected}`,
      ok,
      ok ? '' : `实际 ${got}`,
    );
  }
}

console.log('\n[3] 路由接线（样例路径能在 ROUTES 命中）');
for (const c of CASES) {
  if (!c.path.startsWith('/api/')) continue; // 非 /api 路径本来就不在 ROUTES 里
  const r = findRoute(c.path, c.method);
  check(`findRoute(${c.method} ${c.path}) 命中`, !!r, r ? r.id : '未登记');
}

console.log(failed ? `\n✗ ${failed} 条不通过\n` : '\n✓ 全部通过\n');
process.exit(failed ? 1 : 0);
