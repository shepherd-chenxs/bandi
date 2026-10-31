/**
 * `security/local-policy.mjs` 的穷举用例（姊妹文档 §5.1）。
 *
 * 为什么单独一个文件：这张表是**本机破坏性动作的唯一闸门**，错一格就是"给人导出全部数据"。
 * 纯逻辑模块（不 import store、不写库），所以可以在这里把 身份 × 来源 × 每条策略 全跑一遍，
 * 不用起服务。
 *
 * 三件事必须钉住：
 *   ① 矩阵：loopback 不看角色；network 下 operator/admin 是"要不要秘密"的区别，
 *      member / panel / compute / device / anonymous 一律 E4091；
 *   ② 默认拒绝：没登记的路径 → E4090（404），方法不对也走这一条；
 *   ③ 覆盖：`routes/local.mjs` 与 `routes/runtime.mjs` 里出现的每个 `/api/local/…`
 *      都必须在这张表里有一行 —— 漏登记 = 测试红（IAM §8.3 的"未登记即拒绝"靠它兜）。
 *
 * 跑法：node apps/server/src/smoke-local-policy.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_POLICY, authorizeLocal, principalKind, registeredPaths } from './security/local-policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const PRINCIPALS = {
  anonymous: null,
  operator: { kind: 'operator' },
  admin: { kind: 'user', roleId: 'admin', admin: true },
  member: { kind: 'user', roleId: 'operator', admin: false },
  panel: { kind: 'node', nodeId: 'n1', scope: new Set(['panel']) },
  compute: { kind: 'node', nodeId: 'n1', scope: new Set(['compute']) },
  device: { kind: 'device', deviceId: 'd1' },
};

const verdict = (row, who, source, hasSecret) =>
  authorizeLocal({ method: row.method, pathname: row.path, source, principal: PRINCIPALS[who], hasSecret });

console.log('\n[1] 身份归一');
check('operator', principalKind(PRINCIPALS.operator) === 'operator');
check('admin', principalKind(PRINCIPALS.admin) === 'admin');
check('member', principalKind(PRINCIPALS.member) === 'member');
check('panel', principalKind(PRINCIPALS.panel) === 'panel');
check('compute', principalKind(PRINCIPALS.compute) === 'compute');
check('device', principalKind(PRINCIPALS.device) === 'device');
check('无凭据 → anonymous', principalKind(null) === 'anonymous');
check('已撤销的令牌 → anonymous', principalKind({ kind: 'revoked' }) === 'anonymous');

console.log(`\n[2] 矩阵（${LOCAL_POLICY.length} 条）`);
for (const row of LOCAL_POLICY) {
  const tag = `${row.method} ${row.path}`;

  // 本机：不看角色、不要秘密（与改造前行为一致）
  for (const who of ['anonymous', 'member', 'operator']) {
    const v = verdict(row, who, 'loopback', false);
    if (!v.allow) check(`loopback + ${who} → 放行 · ${tag}`, false, v.code);
  }

  // 网络：非 operator/admin 一律 E4091
  for (const who of ['anonymous', 'member', 'panel', 'compute', 'device']) {
    const v = verdict(row, who, 'network', true); // 即便带着秘密也不该放行
    const ok = !v.allow && v.code === 'E4091';
    check(`network + ${who} → E4091 · ${tag}`, ok, v.code ?? 'allow');
  }

  // 网络：operator / admin，按 secret 三档
  for (const who of ['operator', 'admin']) {
    const noSecret = verdict(row, who, 'network', false);
    const withSecret = verdict(row, who, 'network', true);
    if (row.secret === 'never') {
      check(`network + ${who} + 无秘密 → 放行 · ${tag}`, noSecret.allow, noSecret.code ?? '');
      check(`network + ${who} + 秘密 → 放行 · ${tag}`, withSecret.allow, withSecret.code ?? '');
    } else {
      const ok = !noSecret.allow && noSecret.code === 'E4097';
      check(`network + ${who} + 无秘密 → E4097 · ${tag}`, ok, noSecret.code ?? 'allow');
      check(`network + ${who} + 秘密 → 放行 · ${tag}`, withSecret.allow, withSecret.code ?? '');
    }
  }
}

console.log('\n[3] 默认拒绝');
const unregistered = authorizeLocal({
  method: 'POST',
  pathname: '/api/local/whatever',
  source: 'loopback',
  principal: PRINCIPALS.operator,
  hasSecret: true,
});
check('未登记路径 → E4090 / 404（本机来源也一样）', !unregistered.allow && unregistered.code === 'E4090' && unregistered.status === 404);
const wrongMethod = authorizeLocal({
  method: 'DELETE',
  pathname: '/api/local/export',
  source: 'loopback',
  principal: PRINCIPALS.operator,
  hasSecret: true,
});
check('方法不在表里 → E4090', !wrongMethod.allow && wrongMethod.code === 'E4090');

console.log('\n[4] 覆盖检查（路由字面量必须全部登记）');
const wanted = new Set();
for (const file of ['routes/local.mjs', 'routes/runtime.mjs', 'routes/imageai.mjs']) {
  const src = fs.readFileSync(path.join(here, file), 'utf8');
  for (const m of src.matchAll(/'(\/api\/local\/[a-z/]+)'/g)) wanted.add(m[1]);
  if (file !== 'routes/local.mjs' && src.includes("'/api/restart'")) wanted.add('/api/restart');
}
const have = new Set(registeredPaths());
const missing = [...wanted].filter((p) => !have.has(p));
check(
  `路由里出现的本机路径全部已登记（扫到 ${wanted.size} 条）`,
  missing.length === 0,
  missing.length ? `漏登记：${missing.join(', ')}` : '',
);
const extra = [...have].filter((p) => !wanted.has(p) && p !== '/api/restart');
check(
  '表里没有"早就不存在"的路径（防表腐化）',
  extra.length === 0,
  extra.length ? `多余：${extra.join(', ')}` : '',
);

console.log(failed ? `\n✗ ${failed} 条不通过\n` : '\n✓ 全部通过\n');
process.exit(failed ? 1 : 0);
