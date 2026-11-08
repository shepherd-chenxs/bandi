/**
 * `security/policy.mjs` 的 `authorize` 穷举用例（姊妹文档 §3，2026-11-07 登录即全权模型）。
 *
 * 为什么单独一个文件、不起服务：`authorize` 是纯函数（只 import `route-policy.mjs` 的
 * 静态路由表，不碰 store、不读库、不开进程），所以可以在这里把 身份 × 来源 × 每条策略
 * 全跑一遍，且能在空目录里直接 `node` 跑。
 *
 * 三件事必须钉住（2026-11-07 角色/菜单权限体系退场后）：
 *   ① 机器身份 vs 人：operator / 登录用户（kind:'user'）一律全权；
 *      node 按 compute/panel 收敛；revoked 一律 `E4012`（先判这一个，排在所有人/机器之前）；
 *      （`device` 身份 2026-11-07 随配对体系整体退场，矩阵里不再有这一列）
 *   ② 节点令牌边界：compute 只许"自己的活"（归属判定由 rules.nodeMayReach 注入，
 *      本测试用桩函数喂），panel 命中 `noPanel` 路由给 `E4032`；
 *   ③ 覆盖：样例路径必须能在 `ROUTES` 命中（漏登记 = 路由表腐化）。
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
  nodeCompute: { kind: 'node', nodeId: 'n1', scope: new Set(['compute']) },
  nodePanel: { kind: 'node', nodeId: 'p1', scope: new Set(['panel']) },
  revoked: { kind: 'revoked' },
};

const verdict = (who, method, path, rules = {}) =>
  authorize({ who, method, pathname: path, rules });

console.log('\n[1] 身份形状（kind 归一）');
check('operator.kind === operator', WHO.operator.kind === 'operator');
check('user.kind === user（登录即全权，不再分级）', WHO.user.kind === 'user');
check('node 带 scope（compute）', WHO.nodeCompute.kind === 'node' && WHO.nodeCompute.scope.has('compute'));
check('node 带 scope（panel）', WHO.nodePanel.kind === 'node' && WHO.nodePanel.scope.has('panel'));
check('revoked.kind === revoked', WHO.revoked.kind === 'revoked');

console.log('\n[2] 矩阵（身份 × 路由）');
/**
 * 每条 case 给一个 (method, path) 与预期：每个身份应得到的判定（'allow' 或错误码）。
 * rules 仅给需要归属判定的 compute 用例喂桩。
 */
const CASES = [
  {
    // 普通可读路由（GET /api/me）：panel 节点可读（非 noPanel），compute 节点不沾（E4031）
    tag: '可读路由（GET /api/me）',
    method: 'GET', path: '/api/me',
    expect: {
      operator: 'allow', user: 'allow',
      nodeCompute: 'E4031', nodePanel: 'allow', revoked: 'E4012',
    },
  },
  {
    // noPanel 管理路由：panel 节点命中 noPanel → E4032
    tag: 'noPanel 管理路由（GET /api/users）',
    method: 'GET', path: '/api/users',
    expect: {
      operator: 'allow', user: 'allow',
      nodeCompute: 'E4031', nodePanel: 'E4032', revoked: 'E4012',
    },
  },
  {
    // compute 自端点、归属命中：compute 节点 allow；panel 节点（非 noPanel）allow
    tag: 'compute 自端点（POST /api/nodes/register）— 归属命中',
    method: 'POST', path: '/api/nodes/register', rules: { nodeMayReach: () => true },
    expect: {
      operator: 'allow', user: 'allow',
      nodeCompute: 'allow', nodePanel: 'allow', revoked: 'E4012',
    },
  },
  {
    // compute 自端点、归属未命中：compute 节点落 E4031；其余同上
    tag: 'compute 自端点（POST /api/nodes/register）— 归属未命中',
    method: 'POST', path: '/api/nodes/register', rules: { nodeMayReach: () => false },
    expect: {
      operator: 'allow', user: 'allow',
      nodeCompute: 'E4031', nodePanel: 'allow', revoked: 'E4012',
    },
  },
  {
    // 非 /api 页面：compute 节点无归属 → E4031；panel 节点（非 noPanel）放行
    tag: '非 /api 页面（GET /index.html）',
    method: 'GET', path: '/index.html',
    expect: {
      operator: 'allow', user: 'allow',
      nodeCompute: 'E4031', nodePanel: 'allow', revoked: 'E4012',
    },
  },
];

for (const c of CASES) {
  for (const [whoKey, expected] of Object.entries(c.expect)) {
    const got = verdict(WHO[whoKey], c.method, c.path, c.rules);
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
