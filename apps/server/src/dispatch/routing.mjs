/**
 * **@ 解析与目标解析**（2026-11-19 从 dispatch.mjs 拆出）。
 *
 * 输入都是"值"（thread 行、成员数组、原话），输出也是值 —— 不碰库、不起进程。
 * 规则本身很短，但它是"谁该接这句话"的唯一判据（@ 谁谁干活 / 没 @ 找群助手 /
 * 一个会话同时只跑一个），所以单独放一处，别混在派活流程里。
 *
 * 依赖方向：routing → config（只为 repoRoot）。反向由 dispatch.mjs 再导出。
 */
import { repoRoot } from '../config.mjs';

/**
 * 一个员工实际能看到的工作根。
 * = 主工作目录（cwd，-C 传它） + 自己配的附加根 + **平台根（自动附加）**。
 * 平台根里放 skill，所以哪怕员工在别的项目里干活，也能读到 skill。
 *
 * 注意：只有切回沙箱模式后这串才有约束力；danger-full-access 下它没有效果。
 */
export function personaRoots(cwd, rootDirsJson) {
  let extra = [];
  try {
    const parsed = JSON.parse(rootDirsJson || '[]');
    if (Array.isArray(parsed)) extra = parsed.filter((s) => typeof s === 'string' && s.trim());
  } catch { /* 存坏了就当没有 */ }

  const seen = new Set();
  const out = [];
  for (const dir of [cwd, ...extra, repoRoot].filter(Boolean)) {
    const key = String(dir).replace(/[\\/]+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

/** 1:1 会话的"成员"就是对面那个人，从 thread 行上拼出来，形状与群成员一致 */
export function directMember(thread) {
  return {
    personaId: thread.personaId,
    name: thread.personaName,
    runtime: thread.runtime,
    // **会话级覆盖优先**：波哥平时只读，这个会话给了他完全权限，就在这儿生效；
    // 没覆盖（null）→ 跟随员工默认 personaSandbox。
    sandbox: thread.sandbox ?? thread.personaSandbox,
    cwd: thread.personaCwd,
    // 模型同理：会话级覆盖优先（聊天面板那颗切换按钮写的就是它），
    // 没覆盖 → 跟随员工绑的；员工也没绑 → 由 cliModels.effectiveModelOf 回落到 CLI 自己的默认
    model: thread.model ?? thread.personaModel,
    instructions: thread.personaInstructions,
    roots: personaRoots(thread.personaCwd, thread.personaRootDirs),
  };
}

/**
 * 解析 @名字。按名字长度倒序匹配，避免「@李」把「@李俊」吃掉。
 * 返回命中的成员列表。
 */
export function parseMentions(text, members) {
  const hits = [];
  let rest = text;
  for (const m of [...members].sort((a, b) => b.name.length - a.name.length)) {
    const token = '@' + m.name;
    if (rest.includes(token)) {
      hits.push(m);
      rest = rest.split(token).join('');
    }
  }
  return hits;
}

/**
 * 规则：@ 谁谁干活（@ 了几个就按成员表顺序一个个来 —— 第一个当场派，其余排队，
 * 见 dispatchToThread）；没 @ 就跟**群助手**说话（群主是创建人，不接话）。
 * 一个会话同一时刻只跑一个 —— 同时跑会在同一个仓库改代码上打架。
 */
export function resolveTarget(thread, members, text) {
  if (thread.kind !== 'group') {
    return { member: members[0] ?? null, mentions: [] };
  }
  const mentions = parseMentions(text, members);
  if (mentions.length) return { member: mentions[0], mentions };
  const assistant = members.find((m) => m.personaId === thread.assistantPersonaId) ?? null;
  return { member: assistant, mentions: [] };
}
