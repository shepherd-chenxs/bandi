/* routes/group.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * 主分发顺序（先匹配先赢）见 ./chain.mjs 的 CHAIN。 */

import { sendJson, fail, readBody } from '../http.mjs';
import * as store from '../store.mjs';
import * as runs from '../runs.mjs';
import * as experts from '../experts.mjs';

export async function handleGroup(req, res, url) {
  const one = /^\/api\/groups\/([^/]+)$/.exec(url.pathname);
  const sessions = /^\/api\/groups\/([^/]+)\/sessions$/.exec(url.pathname);
  const members = /^\/api\/groups\/([^/]+)\/members$/.exec(url.pathname);
  const member = /^\/api\/groups\/([^/]+)\/members\/([^/]+)$/.exec(url.pathname);

  /*
   * 读一个群的详情（名字 / 群助手 / 成员）。**不是会话** —— 2026-10-20 起群有自己的表，
   * 一个群下面有多段会话。通讯录的群详情页走这条。
   */
  if (req.method === 'GET' && one) {
    const g = store.getGroup(decodeURIComponent(one[1]));
    if (!g) return fail(res, 404, 'E2011', '群不存在');
    return sendJson(res, 200, { group: g });
  }

  if ((req.method === 'PATCH' || req.method === 'PUT') && one) {
    const id = decodeURIComponent(one[1]);
    const g = store.getGroup(id);
    if (!g) return fail(res, 404, 'E2011', '群不存在');
    // 解散的群只读：成员、助手都清了，再改设置没有意义（与「解散的群不开群设置抽屉」同一口径）
    if (g.dissolvedAt) return fail(res, 400, 'E2050', '这个群已经解散了，改不了设置');

    const body = await readBody(req);
    const title = String(body.title ?? '').trim();
    const nextAssistant = body.assistantPersonaId ? String(body.assistantPersonaId) : '';
    /*
     * 「关联项目」（2026-11-11）：空值是**合法指令**（解除关联），
     * 所以判"有没有提这一项"而不是判真值 —— 跟 title/assistant 的写法不同，别照抄。
     */
    const touchProject = Object.prototype.hasOwnProperty.call(body, 'projectId');
    const nextProject = touchProject ? String(body.projectId ?? '').trim() : '';

    if (!title && !nextAssistant && !touchProject) {
      return fail(res, 400, 'E1039', '这次请求没说改哪一项 —— 这个接口只能改「群名称」(title)、「群助手」(assistantPersonaId) 或「关联项目」(projectId)');
    }
    if (nextAssistant) {
      if (!store.getPersona(nextAssistant)) return fail(res, 400, 'E1012', '这个数字员工不存在');
      if (!g.members.some((m) => m.personaId === nextAssistant)) {
        return fail(res, 400, 'E1013', '群助手得先是群里的人');
      }
    }
    /*
     * 一项目一群：该项目已经归别的群 → 拒绝，**不给"顶掉"**。
     * （顶掉意味着另一个群的工作区被静默夺走，而那边毫不知情。）
     * 错误码 E2068/E2069 是群域往后顺位新占的，grep 确认全仓无撞号。
     */
    if (nextProject) {
      const proj = store.getProject(nextProject);
      if (!proj) return fail(res, 404, 'E2068', '这个项目已经不在了，刷新一下再选');
      const owner = store.getGroupByProject(nextProject);
      if (owner && owner.id !== id) {
        return fail(
          res,
          409,
          'E2069',
          `「${proj.name || proj.id}」已经归群「${owner.title}」了。一个项目只归一个群，先去那边解除关联。`,
        );
      }
    }
    // 群级改 + 同步到每一段会话（列表/聊天头部读的是会话上的镜像字段）
    const next = store.updateGroup(id, {
      title: title || '',
      assistantPersonaId: nextAssistant || '',
      ...(touchProject ? { projectId: nextProject } : {}),
    });
    return sendJson(res, 200, { group: next });
  }

  // 解散群：**不抹聊天记录**，只解除成员关系 + 把各段会话收起来（见 store.dissolveGroup）。
  if (req.method === 'DELETE' && one) {
    const id = decodeURIComponent(one[1]);
    const g = store.getGroup(id);
    if (!g) return fail(res, 404, 'E2012', '群不存在');

    // 还在跑就先掐掉 —— 别让一个已经解散的群还在后台说话
    let stopped = null;
    for (const s of store.listGroupSessions(id)) {
      const running = store.activeRun(s.id);
      if (running) {
        // requestStop：掐进程 + 看门狗（裸 abort 等不来退出通知会把运行永远挂在「跑中」）
        runs.requestStop(running.id);
        stopped = running.id;
        break;
      }
    }

    const conv = store.dissolveGroup(id);
    return sendJson(res, 200, {
      dissolved: true,
      stoppedRunId: stopped,
      group: conv,
      conversations: store.listConversations(),
      hiddenConversations: store.listHiddenConversations(),
    });
  }

  /*
   * 给群**开一段新会话**（群详情页「发消息」）。
   * 跟单聊的 `POST /api/conversations` 对称：一次任务一段，上下文不串味。
   */
  if (req.method === 'POST' && sessions) {
    const id = decodeURIComponent(sessions[1]);
    const g = store.getGroup(id);
    /*
     * 码段不跟别的域抢：E2016 / E2017 已经归「技能」用了（见 handleSkill），
     * 群会话这两条从 E2048 往后排（E2047 是会话 404 统一下来的最后一个）。
     */
    if (!g) return fail(res, 404, 'E2048', '群不存在');
    if (g.dissolvedAt) return fail(res, 400, 'E2049', '这个群已经解散了，不能再开会话');
    const conv = store.createGroupSession(id);
    if (!conv) return fail(res, 400, 'E2049', '这个群已经解散了，不能再开会话');
    return sendJson(res, 201, { conversation: conv, conversations: store.listConversations() });
  }

  if (req.method === 'POST' && members) {
    const id = decodeURIComponent(members[1]);
    const g = store.getGroup(id);
    if (!g) return fail(res, 404, 'E2013', '群不存在');

    const body = await readBody(req);
    const ids = (Array.isArray(body.personaIds) ? body.personaIds : []).map(String);
    if (!ids.length) return fail(res, 400, 'E1014', '没选人');

    const already = new Set(g.members.map((m) => m.personaId));
    const added = [];
    const skipped = [];
    for (const pid of ids) {
      if (!store.getPersona(pid)) { skipped.push(pid); continue; }
      if (already.has(pid)) { skipped.push(pid); continue; }
      added.push(pid);
    }
    // 群级加人（每段会话都会补上成员快照），不是只加当前这段
    if (added.length) store.addGroupMembers(id, added);
    return sendJson(res, 200, { added, skipped, group: store.getGroup(id) });
  }

  if (req.method === 'DELETE' && member) {
    const id = decodeURIComponent(member[1]);
    const personaId = decodeURIComponent(member[2]);
    const g = store.getGroup(id);
    if (!g) return fail(res, 404, 'E2014', '群不存在');

    // 群助手不能被移出：移了「没 @ 就找群助手」这条规则就断了
    if (personaId === g.assistantPersonaId) {
      return fail(res, 400, 'E1015', '群助手不能被移出群。先把群助手换成别人，再移出他。');
    }
    if (!g.members.some((m) => m.personaId === personaId)) {
      return fail(res, 404, 'E2015', '他不在这个群里');
    }

    store.removeGroupMember(id, personaId);
    return sendJson(res, 200, { removed: personaId, group: store.getGroup(id) });
  }

  return false;
}

/** 单个 skill 的读/改/删 */
/**
 * 专家库的雇佣 / 解聘（2026-10-22）。
 *
 * 路径带 `:key`（`/api/experts/<key>/hire|fire`），静态路由表匹配不了，照 handleSkill
 * 的路子单开一个处理器挂进分发链。错误码用专家域自己的 **E2051**（404 没这位专家）——
 * E2051 往前整段空闲（群域停在 E2050），往后别的域随时会接，先占先得。
 *
 * 挂载点有意放在 handlePersona **之后**：`/api/personas/:id` 那些员工路由谁也不许被抢
 * （专家雇佣后就是个普通 persona，员工详情/改配置都走既有接口，专家域只管雇与解）。
 */
