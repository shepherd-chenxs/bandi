/* routes/persona.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * 主分发顺序（先匹配先赢）见 ../server.mjs 的 CHAIN。 */

import { sendJson, fail, readBody } from '../http.mjs';
import { runtimeOptions, runtimesOk } from '../runtime-view.mjs';
import { repoRoot } from '../config.mjs';
import * as store from '../store.mjs';
import * as auth from '../auth.mjs';
import * as runs from '../runs.mjs';
import * as skills from '../skills.mjs';
import * as runtimes from '../runtimes.mjs';
import { personaRoots } from '../dispatch.mjs';
import { personaTasks } from '../project-tasks.mjs';
import * as experts from '../experts.mjs';

const AVATAR_FILE = /^[A-Za-z0-9._-]+\.(png|jpe?g|webp)$/i;

/**
 * 锁定话术（2026-10-22 收编喜儿时统一）。
 *
 * 同一组闸口，两种来源：
 *   - expert ：专家库雇来的（p-expert-<key>），随**专家包**固定，出路是解聘后自建；
 *   - builtin：出厂的（喜儿），随**平台**固定，出路是另建一个员工。
 * 判据只有 experts.lockKindOf 一处；这里只负责"怎么说人话"。
 */
const LOCK_MSG = {
  expert: {
    who: '雇佣员工',
    skills: '雇佣员工的技能随专家包固定',
    identity: '雇佣员工的名字与职责身份随专家包固定',
    hint: '想定制就解聘后自建一个员工',
  },
  builtin: {
    who: '内置员工',
    skills: '内置员工（喜儿）的技能随平台固定',
    identity: '内置员工（喜儿）的名字与职责身份随平台固定',
    hint: '想按自己的需要定制，就另建一个员工',
  },
};

/** 员工详情与配置 */
export async function handlePersona(req, res, url) {
  const one = /^\/api\/personas\/([^/]+)$/.exec(url.pathname);
  const open = /^\/api\/personas\/([^/]+)\/open$/.exec(url.pathname);
  const skillsAll = /^\/api\/personas\/([^/]+)\/skills$/.exec(url.pathname);
  const skillOne = /^\/api\/personas\/([^/]+)\/skills\/([^/]+)$/.exec(url.pathname);
  const runtimeSkills = /^\/api\/personas\/([^/]+)\/runtime-skills$/.exec(url.pathname);
  const personaTasksOf = /^\/api\/personas\/([^/]+)\/tasks$/.exec(url.pathname);

  // 删员工：级联清关系数据；是他的群助手就先拦下（换人再删）
  // （one 的正则到行尾为止，所以只可能命中 /api/personas/<id> 这一种路径）
  if (req.method === 'DELETE' && one) {
    const id = decodeURIComponent(one[1]);
    const persona = store.getPersona(id);
    if (!persona) return fail(res, 404, 'E2005', '员工不存在');

    /*
     * 内置员工先拦在这儿（2026-10-18）。`store.deletePersona` 里也有一道 —— 那道是底线
     * （别处绕过接口直接调 store 也删不掉），这道负责**把话说清楚、给对的状态码**：
     * 到 store 里抛出来只会变成 500，前端弹一句"服务端出错"，人会以为是 bug。
     */
    if (persona.builtin) {
      return fail(res, 403, 'E1075', `「${persona.name}」是内置员工，不能删 —— 可以改名，也可以改她的岗位指令。`);
    }

    const asAssistant = store.groupsWhereAssistant(id);
    if (asAssistant.length) {
      return fail(
        res,
        400,
        'E1038',
        `「${persona.name}」是群「${asAssistant.map((g) => g.title).join('、')}」的群助手，删了他群里就没人接话了。先在群设置里把群助手换成别人，再删。`,
      );
    }

    const r = store.deletePersona(id);
    // 只回结果。别再塞整份员工/会话列表 —— 前端会 load() 重拉，塞了就是白传几 KB
    return sendJson(res, 200, { ...r });
  }

  // 关联技能（多选）
  if (req.method === 'POST' && skillsAll) {
    const id = decodeURIComponent(skillsAll[1]);
    if (!store.getPersona(id)) return fail(res, 404, 'E2006', '员工不存在');
    // 技能锁定（2026-10-23，2026-10-22 扩到内置员工）：被锁员工的技能不能增加 —— 想定制就另建
    const lockKind = experts.lockKindOf(id);
    if (lockKind) {
      return fail(res, 403, 'E2054', `${LOCK_MSG[lockKind].skills}，不能添加 —— ${LOCK_MSG[lockKind].hint}`);
    }
    const body = await readBody(req);
    const names = (Array.isArray(body.names) ? body.names : []).map(String);
    const known = new Set(skills.listSkills().map((s) => s.name));
    const added = [];
    const skipped = [];
    for (const n of names) {
      if (!known.has(n)) { skipped.push(n); continue; }
      store.linkPersonaSkill(id, n);
      added.push(n);
    }
    return sendJson(res, 200, { added, skipped, skills: store.listPersonaSkillLinks(id) });
  }

  // 解除关联
  if (req.method === 'DELETE' && skillOne) {
    const id = decodeURIComponent(skillOne[1]);
    const name = decodeURIComponent(skillOne[2]);
    if (!store.getPersona(id)) return fail(res, 404, 'E2006', '员工不存在');
    // 技能锁定（2026-10-23，2026-10-22 扩到内置员工）：被锁员工的技能不能解绑 —— 组合是出厂定义的一部分
    const lockKind = experts.lockKindOf(id);
    if (lockKind) {
      return fail(res, 403, 'E2054', `${LOCK_MSG[lockKind].skills}，不能解绑「${name}」—— ${LOCK_MSG[lockKind].hint}`);
    }
    const removed = store.unlinkPersonaSkill(id, name);
    return sendJson(res, 200, { removed: removed > 0, skills: store.listPersonaSkillLinks(id) });
  }

  // 暂停/恢复某个技能（留着分配关系，只是不注入 prompt）
  if (req.method === 'PATCH' && skillOne) {
    const id = decodeURIComponent(skillOne[1]);
    const name = decodeURIComponent(skillOne[2]);
    if (!store.getPersona(id)) return fail(res, 404, 'E2006', '员工不存在');
    // 技能锁定（2026-10-23，2026-10-22 扩到内置员工）：被锁员工的技能不能停用 —— 半残的出厂员工比没有更难排查
    const lockKind = experts.lockKindOf(id);
    if (lockKind) {
      return fail(res, 403, 'E2054', `${LOCK_MSG[lockKind].skills}，不能停用「${name}」`);
    }
    const body = await readBody(req);
    const changed = store.setPersonaSkillEnabled(id, name, body.enabled !== false);
    return sendJson(res, 200, { changed: changed > 0, skills: store.listPersonaSkillLinks(id) });
  }

  // 该员工所在的运行时自带哪些技能（只发现，不改 CLI 的文件）
  if (req.method === 'GET' && runtimeSkills) {
    const id = decodeURIComponent(runtimeSkills[1]);
    const persona = store.getPersona(id);
    if (!persona) return fail(res, 404, 'E2007', '员工不存在');
    const rt = runtimes.resolveForRun(persona.runtime);
    const dirs = skills.runtimeSkillDirs(rt?.family ?? '');
    const found = dirs.flatMap((d) =>
      skills.discoverSkills(d, { maxDepth: 3 }).map((s) => ({
        name: s.name,
        description: s.description ?? '',
        dir: d,
      })),
    );
    return sendJson(res, 200, {
      runtime: persona.runtime,
      family: rt?.family ?? '',
      dirs,
      found,
    });
  }

  if (req.method === 'GET' && one) {
    const id = decodeURIComponent(one[1]);
    const persona = store.getPersona(id);
    if (!persona) return fail(res, 404, 'E2008', '员工不存在');
    return sendJson(res, 200, {
      // busy 要跟 /api/state 一致：通讯录的绿点看的是那边的 busy，
      // 详情里那个「空闲」徽标看的是这里 —— 这边不带的话详情永远显示"空闲"（用户实报：绿点+空闲，自相矛盾）
      persona: { ...persona, busy: !!store.activeRunForPersona(id) },
      runtimes: runtimeOptions(),
      platformRoot: repoRoot,
      roots: personaRoots(persona.cwd, persona.rootDirs),
      skills: store.listPersonaSkillLinks(id),
      allSkills: skills.listSkills().map((s) => ({ name: s.name, description: s.description })),
      runs: store.listRunsForPersona(id),
    });
  }

  // 这个人的任务（员工详情 → 任务）：跟任务看板**同一批行**，服务端按执行人筛一遍。
  // 单独一条路由而不是塞进上面那个 GET /api/personas/:id：那个是"配置"（打开就要），
  // 这个要扫全部会话与流程，重得多 —— 前端并行取，取不到也不该把整页拖黑。
  if (req.method === 'GET' && personaTasksOf) {
    const persona = store.getPersona(decodeURIComponent(personaTasksOf[1]));
    if (!persona) return fail(res, 404, 'E2008', '员工不存在');
    return sendJson(res, 200, personaTasks(persona));
  }

  if ((req.method === 'PUT' || req.method === 'PATCH') && one) {
    const id = decodeURIComponent(one[1]);
    const before = store.getPersona(id);
    if (!before) return fail(res, 404, 'E2009', '员工不存在');
    const body = await readBody(req);
    /*
     * **字段级闸**：改员工的「模型」或「运行时」= 改**模型路由**，那是五类管理动作之一
     * （设计 §6.3 第 15 条 / 决策 A 规则 1）。面板令牌能改名字、职责、技能、权限，
     * 但**改不了这两项** —— 否则一台被翻的瘦客户端能把活悄悄导到别的机器/别的模型上。
     *
     * 为什么落在这里而不是 auth.mjs 那张表里：要判的是 **body 里的字段**，而 `readBody`
     * 只有 handler 里有（`auth.mjs` 只看得到方法与路径）。
     *
     * ⚠️ 判的是"**值真的变了**"，不是"body 里带了这个键"：界面保存时会把整份表单发上来
     * （名字、职责、技能……带着没改过的 model），只按键存在就拦会把"改名字"也挡掉 ✗。
     */
    if (
      !auth.mayManage(req) &&
      (('model' in body && String(body.model ?? '') !== String(before.model ?? '')) ||
        ('runtime' in body && String(body.runtime ?? '') !== String(before.runtime ?? '')))
    ) {
      return fail(res, 403, 'E4032', '面板权限不能改员工的「模型」与「运行时」—— 那是总机上的模型路由，请到总机上改');
    }
    /*
     * 技能锁定的兜底（2026-10-23，2026-10-22 扩到内置员工）：员工编辑表单本身不带 skills
     * （挂载是独立动作），这个键只可能来自绕过界面的直接调用 —— 被锁员工一律拒掉，
     * 别让 setPersonaSkills 从这条缝里把出厂清单整表换掉。判"带了这个键"就行：正常流量根本不发它。
     */
    const lockKind = experts.lockKindOf(id);
    if (lockKind && Array.isArray(body.skills)) {
      return fail(res, 403, 'E2054', `${LOCK_MSG[lockKind].skills}，不能改 —— ${LOCK_MSG[lockKind].hint}`);
    }
    /*
     * 身份锁定（2026-10-23，2026-10-22 扩到内置员工）：被锁员工的**名字 / 岗位 / 职责与身份设定**
     * 只读（E2055）。⚠️ 照上面 E4032 的先例判"**值真的变了**"，不是键存在 —— 详情页自动保存会把
     * 整份表单发上来，只看键会把"改个运行时"也拦掉。岗位按服务端同一套归一（trim / 空即 null）
     * 再比，不然"没改岗位"也会因为归一差异误判成变了。
     */
    if (lockKind) {
      const role = body.role === undefined ? before.role : String(body.role ?? '').trim() || null;
      if (
        String(body.name ?? '').trim() !== String(before.name ?? '') ||
        (role ?? null) !== (before.role ?? null) ||
        String(body.instructions ?? '') !== String(before.instructions ?? '')
      ) {
        return fail(res, 403, 'E2055', `${LOCK_MSG[lockKind].identity}，不能改 —— ${LOCK_MSG[lockKind].hint}`);
      }
    }
    const name = String(body.name ?? '').trim();
    if (!name) return fail(res, 400, 'E1011', '名字不能空');
    if (body.avatar !== undefined && body.avatar !== null && body.avatar !== '' && !AVATAR_FILE.test(String(body.avatar))) {
      return fail(res, 400, 'E1013', '头像只能是 png/jpg/webp 文件名，不接受路径或其它格式');
    }
    const runtime = runtimesOk(body.runtime) ? body.runtime : undefined;
    // 模型名不再对着账本校验（账本已下架）；见 POST /api/personas 那段说明

    const persona = store.updatePersona(id, {
      name,
      // undefined = 这次没带这个字段；空串 = 显式清掉岗位
      role: body.role === undefined ? undefined : String(body.role ?? '').trim() || null,
      instructions: String(body.instructions ?? ''),
      runtime,
      sandbox: body.sandbox ? String(body.sandbox) : undefined,
      cwd: body.cwd ? String(body.cwd) : undefined,
      model: body.model === undefined ? undefined : String(body.model || '') || null,
      showThinking: body.showThinking === undefined ? undefined : (body.showThinking ? 1 : 0),
      rootDirs: Array.isArray(body.rootDirs) ? body.rootDirs.map(String).filter((s) => s.trim()) : undefined,
      avatar: body.avatar === undefined ? undefined : (body.avatar ? String(body.avatar) : null),
    });

    if (Array.isArray(body.skills)) store.setPersonaSkills(id, body.skills);
    return sendJson(res, 200, { persona });
  }

  // 点一个员工就进他的对话：有就复用，没有就现开一段
  if (req.method === 'POST' && open) {
    const personaId = decodeURIComponent(open[1]);
    const conversation = store.ensureConversationForPersona(personaId);
    if (!conversation) return fail(res, 404, 'E2010', '员工不存在');
    return sendJson(res, 200, { conversation });
  }

  return false;
}

/** 群的加人 / 踢人 / 改名 / 新开会话 */
