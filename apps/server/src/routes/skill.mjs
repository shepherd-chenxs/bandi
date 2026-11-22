/* routes/skill.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * 主分发顺序（先匹配先赢）见 ./chain.mjs 的 CHAIN。 */

import { sendJson, fail, readBody } from '../http.mjs';
import * as store from '../store.mjs';
import * as skills from '../skills.mjs';
import * as connectors from '../connectors.mjs';
import * as catalog from '../catalog.mjs';
import * as experts from '../experts.mjs';

export async function handleSkill(req, res, url) {
  /*
   * 技能这一侧的挂载：把一个技能**发给若干个数字员工**（技能页那个「添加到数字员工」）。
   *
   * ⚠️ 必须放在下面那个 `if (!one) return false` **之前** —— `one` 只匹配
   *    `/api/skills/<名字>` 这一种路径，带 `/personas` 后缀的根本到不了后面。
   *
   * 为什么单开一条而不是让前端对每个员工各调一次 `/api/personas/:id/skills`：
   *   一次操作就是一次操作 —— N 次请求里挂到一半失败，界面要么显示错了、要么得自己回滚。
   *   这里一把做完，回一份最终名单。
   * 注意方向：员工详情那侧是"给这个人挑几个技能"，两边落的是同一张表（persona_skills）。
   */
  const personasRoute = /^\/api\/skills\/([^/]+)\/personas$/.exec(url.pathname);
  if (req.method === 'POST' && personasRoute) {
    const skillName = decodeURIComponent(personasRoute[1]);
    if (!skills.getSkill(skillName)) return fail(res, 404, 'E2016', '没有这个 skill');
    const body = await readBody(req);
    const ids = [...new Set((Array.isArray(body.personaIds) ? body.personaIds : []).map(String).filter(Boolean))];
    if (!ids.length) return fail(res, 400, 'E1016', '没选人');

    const added = [];
    const skipped = [];
    for (const pid of ids) {
      if (!store.getPersona(pid)) { skipped.push(pid); continue; }
      // 技能锁定的反方向闸（2026-10-23，2026-10-22 扩到内置员工）：技能页"发给数字员工"也发不到被锁员工头上
      const pidLock = experts.lockKindOf(pid);
      if (pidLock) {
        const who = store.getPersona(pid);
        // LOCK_MSG 在 experts.mjs（2026-11-22 修：原来这里裸用了一个本模块没有的常量，必 500）
        return fail(
          res,
          403,
          'E2054',
          `「${who?.name ?? pid}」是${experts.LOCK_MSG[pidLock].who}，技能${pidLock === 'expert' ? '随专家包' : '随平台'}固定，不能添加`,
        );
      }
      if (store.listPersonaSkills(pid).includes(skillName)) { skipped.push(pid); continue; }
      store.linkPersonaSkill(pid, skillName);
      added.push(pid);
    }
    return sendJson(res, 200, {
      added,
      skipped,
      personas: store
        .listPersonas()
        .filter((p) => store.listPersonaSkills(p.id).includes(skillName))
        .map((p) => ({ id: p.id, name: p.name })),
    });
  }

  const one = /^\/api\/skills\/([^/]+)$/.exec(url.pathname);
  if (!one) return false;
  const name = decodeURIComponent(one[1]);

  if (req.method === 'GET') {
    const s = skills.getSkill(name);
    if (!s) return fail(res, 404, 'E2017', '没有这个 skill');
    /*
     * **内置技能的正文不下发**（2026-11-22 用户拍板："技能页只显示简介，保护 skill 的隐私"）。
     *
     * 只在前端不画不算数 —— 打开开发者工具看一眼这个接口就全拿到了。所以档口在这里：
     * `body` 置空 + `bodyHidden:true`（前端据此知道"这是刻意不给的"，而不是文件是空的）。
     *
     * 为什么敢删：正文没有任何客户端的用途 ——
     *   · 界面上内置技能不再有编辑入口（只读，改也改不了：PUT 本来就 403）；
     *   · 数字员工要正文是**直接读文件** `skills/<名字>/SKILL.md`（技能目录挂在员工 cwd 下），
     *     从不经这条接口。
     * 自建技能照旧回正文 —— 用户自己写的东西得能改。
     */
    const skill = s.builtin ? { ...s, body: '', bodyHidden: true } : s;
    return sendJson(res, 200, { skill, personas: store.listPersonas().filter((p) => store.listPersonaSkills(p.id).includes(name)).map((p) => ({ id: p.id, name: p.name })) });
  }

  if (req.method === 'PUT' || req.method === 'PATCH') {
    const cur = skills.getSkill(name);
    if (!cur) return fail(res, 404, 'E2018', '没有这个 skill');
    // 内置技能只读（2026-10-22 用户拍板：出厂技能只允许用，不允许改）
    if (skills.isBuiltin(cur.dirName)) {
      return fail(res, 403, 'E4033', `「${name}」是内置技能，只读 —— 想定制就复制一个改名字新建`);
    }
    const body = await readBody(req);
    try {
      return sendJson(res, 200, { skill: skills.writeSkill(name, { description: body.description, body: body.body }) });
    } catch (e) {
      return fail(res, 400, 'E1017', String(e?.message ?? e));
    }
  }

  if (req.method === 'DELETE') {
    const cur = skills.getSkill(name);
    // 内置技能不许删（闸在写入侧，界面只是不摆按钮 —— 两边都拦，绕不过去）
    if (cur && skills.isBuiltin(cur.dirName)) {
      return fail(res, 403, 'E4033', `「${name}」是内置技能，不能删 —— 不想让某个员工用它，去他的详情页解除挂载就行`);
    }
    const removed = skills.removeSkill(name);
    const unlinked = store.forgetSkillEverywhere(name); // 文件没了，挂载关系一并清掉
    return sendJson(res, 200, { removed, unlinked });
  }

  return false;
}

/**
 * 连接器：账本 + 推荐清单 + 装 / 卸 / 启停 / 实探。
 *
 * 「公开」那一栏来自随仓库走的推荐清单（catalog/connectors.json），不是真市场；
 * 装的动作只是把清单条目落成账本里的一条，代码仍然由 CLI 在它自己的进程里跑。
 */
