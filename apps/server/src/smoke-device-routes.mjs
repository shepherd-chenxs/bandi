/**
 * 手机端路由白名单的**静态断言**（2026-11-05）。
 *
 * 背景：手机是「设备会话」，/api 白名单里没打 `device: true` 的路由一律 E4033。
 * conv.create / group.create / group.sessions / group.members 已经实机各踩过一次
 * —— 每次都是"代码里加了、桌面版没重启"或"压根忘了打标"。这个冒烟不做网络，
 * 只钉一件事：**手机聊天/建群/拉人这条链上的路由，device 标必须一直在**；
 * 反向再钉一条：明确留给桌面的动作（踢人/解散/改名）不许顺手放开。
 *
 * 跑法：node apps/server/src/smoke-device-routes.mjs
 */
import { ROUTES } from './security/route-policy.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

/** 手机必须能走的路由（id → 允许的方法）。少一个 device 标 = 实机 E4033。 */
const MUST_DEVICE = [
  ['conv.create', ['POST']],
  ['group.create', ['POST']],
  ['group.detail', ['GET']],
  ['group.sessions', ['POST']],
  ['group.members', ['POST']],
  /*
   * 定时任务（2026-11-06 手机工作台开入口）：列表页一屏就带着启停/立即跑/编辑/删除，
   * 四条少任何一条 = 手机上"点得进去、点一下报错"。建任务弹窗里的「交给流程」
   * 还要读 wf.tpl.list（只读清单），一并钉住。
   */
  ['schedule.list', ['GET']],
  ['schedule.create', ['POST']],
  ['schedule.one', ['PATCH', 'DELETE']],
  ['schedule.run', ['POST']],
  ['wf.tpl.list', ['GET']],
];

/** 明确只留桌面的路由：device 标不许加（多开 = 手机误触就能踢人/拆群）。 */
const MUST_NOT_DEVICE = ['group.update', 'group.delete', 'group.member.one'];

for (const [id, methods] of MUST_DEVICE) {
  const rows = ROUTES.filter((r) => r.id === id);
  check(`${id} 存在`, rows.length > 0);
  const row = rows[0];
  if (!row) continue;
  check(
    `${id} 打了 device 标`,
    row.device === true,
    row.device === true ? '' : '缺 device: true —— 手机实机会报 E4033',
  );
  for (const m of methods) {
    check(`${id} 允许 ${m}`, (row.m ?? []).includes(m));
  }
}

for (const id of MUST_NOT_DEVICE) {
  const row = ROUTES.find((r) => r.id === id);
  check(`${id} 存在`, !!row);
  if (!row) continue;
  check(
    `${id} 保持桌面专属（无 device 标）`,
    row.device !== true,
    '这个动作不该被手机触发，device 标要拿掉',
  );
}

console.log(failed ? `\n${failed} 项未过` : '\n全过');
process.exit(failed ? 1 : 0);
