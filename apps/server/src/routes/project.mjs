/* routes/project.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * 主分发顺序（先匹配先赢）见 ../server.mjs 的 CHAIN。 */

import fs from 'node:fs';
import path from 'node:path';
import { sendJson, fail, readBody, readRawBody } from '../http.mjs';
import * as store from '../store.mjs';
import { dispatchToThread } from '../dispatch.mjs';
import * as status from '../status.mjs';
import { projectTasks, allTasks, createProjectTask, updateProjectTask, startProjectTask, afterMerged, upsertRepoCard } from '../project-tasks.mjs';
import * as git from '../git-repos.mjs';
import { verifyRunCredential } from '../agent-auth.mjs';
import { ATT_MAX, safeName, validateAtts, uploadsRoot } from './conversation.mjs';

export async function handleProject(req, res, url) {
  const detail = /^\/api\/projects\/([^/]+)$/.exec(url.pathname);
  const tasksOf = /^\/api\/projects\/([^/]+)\/tasks$/.exec(url.pathname);

  if (req.method === 'GET' && url.pathname === '/api/projects') {
    return sendJson(res, 200, { projects: store.listProjects() });
  }

  /*
   * **全局任务看板**：所有项目的活铺在同一张看板上（界面入口：工作台 → 任务看板）。
   * 跟下面那个项目看板是**同一个机制** —— 行怎么算、列怎么分都共用 `project-tasks.mjs` 的
   * `board()`，这里只是换个范围取行。全局多两件事：每行带 `project_id` / `project_name`，
   * 以及**没挂项目的活也收**（`project_name` = 「未归属」）。
   * 前端 `openTaskBoard()` 消费它；项目详情页消费下面那个。
   */
  if (req.method === 'GET' && url.pathname === '/api/tasks') {
    return sendJson(res, 200, allTasks());
  }

  /*
   * 一个项目的**任务看板**：流程的每一次办理 + 这个项目下的聊天派活 + 手工建的任务，各一张卡。
   * 这是**平台的一等功能**（项目 → 任务），不是某个插件的私有接口 ——
   * 界面在「项目」详情页里（[项目] → 点一行进去），插件只是另一个消费者。
   */
  if (req.method === 'GET' && tasksOf) {
    const p = store.getProject(decodeURIComponent(tasksOf[1]));
    if (!p) return fail(res, 404, 'E2023', '项目不存在');
    return sendJson(res, 200, projectTasks(p));
  }

  // 在某一列点「＋」建一张手工卡（可选：建完立刻派给某个数字员工）
  if (req.method === 'POST' && tasksOf) {
    const p = store.getProject(decodeURIComponent(tasksOf[1]));
    if (!p) return fail(res, 404, 'E2024', '项目不存在');
    const body = await readBody(req);
    /*
     * 数字员工经**通用接口**建卡时也把身份记下来（2026-10-24）：有的员工不走"工作证"专用口
     * （routes/agent-cards.mjs），直接调这个口 —— 带了运行钥匙（进程环境变量 BANDI_RUN_TOKEN）
     * 就认下他是谁、记下他建卡时所在的会话，卡片回执（notifyCardOwner）才有"该通知谁"的依据。
     * 人从浏览器建卡没有钥匙 → 两列留空，行为与从前一字不差。
     */
    const cred = verifyRunCredential(req.headers['x-bandi-run-token']);
    const originRun = cred ? store.getRunRow(cred.runId) : null;
    try {
      const task = createProjectTask(p, {
        title: body.title,
        description: body.description,
        status: body.status,
        personaId: body.personaId ?? null,
        startNow: body.startNow === true,
        createdBy: cred?.personaId ?? null,
        creatorConvId: originRun?.conversationId ?? null,
      });
      return sendJson(res, 201, { task });
    } catch (e) {
      // 派活失败时卡已经建好了 —— 把 id 带回去，界面才能说清"卡在、但没跑起来"
      return fail(res, 400, 'E1043', String(e.message ?? e), { taskId: e.taskId ?? null });
    }
  }

  // 单张本地卡：拿**全文**（看板行里的标题/描述是截断过的 —— 卡片详情要看完整描述）
  const taskOne = /^\/api\/projects\/tasks\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'GET' && taskOne) {
    const t = store.getProjectTask(decodeURIComponent(taskOne[1]));
    return t ? sendJson(res, 200, { task: t }) : fail(res, 404, 'E2039', '任务不存在');
  }

  // 改一张本地卡（拖到别的列 = 改状态；也能改标题 / 描述 / **执行人**）。
  // 带 `startNow: true` ＝ 「保存并开始工作」：存完立刻派活 —— 跟建卡时那个「立即开始」同一条链路。
  //
  // **拖进「进行中」＝开工**（2026-10-17，对齐 Multica）：有执行人的卡一进「进行中」就派活，
  // 不用再点按钮。所以带 startNow 的时候要关掉那条自动路径（`autoStart: false`），
  // 否则一次保存会派两遍 —— 第二遍还会撞上"他还在跑上一条"。
  if (req.method === 'PATCH' && taskOne) {
    const id = decodeURIComponent(taskOne[1]);
    const body = await readBody(req);
    try {
      const before = store.getProjectTask(id);
      const task = updateProjectTask(id, body, { autoStart: body.startNow !== true });
      if (body.startNow === true) {
        try {
          return sendJson(res, 200, { task: startProjectTask(id), started: true });
        } catch (e) {
          // 卡改好了、但没派出去：把原因说清楚，别让人以为存都没存
          return fail(res, 400, 'E1048', `存了，但没派出去：${e.message}`, { taskId: id, task });
        }
      }
      // runId 变了 = 这一下真的派出去了（不是"改了个状态"），界面据此提示"已开跑"
      const started = !!(before && task.runId && task.runId !== before.runId);
      return sendJson(res, 200, { task, started });
    } catch (e) {
      const missing = /不存在/.test(String(e.message));
      if (e?.taskId) {
        // 拖进「进行中」但没派出去：字段存了、状态没动（见 project-tasks 里的说明）
        return fail(res, 400, 'E1049', String(e.message), { taskId: e.taskId, statusUnchanged: true });
      }
      return sendJson(res, missing ? 404 : 400, { error: String(e.message ?? e) });
    }
  }
  if (req.method === 'DELETE' && taskOne) {
    const ok = store.deleteProjectTask(decodeURIComponent(taskOne[1]));
    return ok ? sendJson(res, 200, { ok: true }) : fail(res, 404, 'E2038', '任务不存在');
  }

  /*
   * **卡片评论**（2026-10-18 建，2026-10-19 改成三档）。
   *
   * 跟 `/api/conversations/:id/messages` 的差别：
   *   ① 会话**按需建**：第一次评论才把这张卡的工单会话建出来（原来只有「开始工作」才建），
   *      所以"还没开工也能先聊"；
   *   ② 评论分**三档**（`body.mode`），档位决定"叫不叫醒他、叫醒后能不能动手"：
   *        · `note`    便签 —— 只留一句话在卡上，**不叫醒**。给自己（和将来的人）看，
   *          agent 不读、也不补投。这是 Multica `/note` 的本意；
   *        · `discuss` 讨论 —— 叫醒他聊、看代码、给方案，但**只读不动手**（沙箱盖成 `plan`）；
   *        · `execute` 执行 —— 叫醒他真正干活，用员工自己的沙箱（默认可写）。
   *      三档都是"说话"，不因档位而改卡的状态或登记 runId —— 开工是另一条指令
   *      （状态改「进行中」/「开始工作」→ startProjectTask）。
   *   ③ `parentId` = 这条回复挂在哪个**顶层议题**下（只一层）。
   */
  const taskComments = /^\/api\/projects\/tasks\/([^/]+)\/comments$/.exec(url.pathname);
  const taskFiles = /^\/api\/projects\/tasks\/([^/]+)\/files$/.exec(url.pathname);

  /*
   * 任务卡附件上传（2026-10-23 用户要求「像聊天面板那样带文件/贴图」）。
   * 与 /api/conversations/:id/files 同一套落盘规则：懒建工单会话，再存二进制。
   */
  if (req.method === 'POST' && taskFiles) {
    const id = decodeURIComponent(taskFiles[1]);
    const task = store.getProjectTask(id);
    if (!task) return fail(res, 404, 'E2039', '任务不存在');
    if (!task.assigneePersonaId) return fail(res, 400, 'E1061', '先指定执行人 —— 评论区是跟他讨论的');
    const persona = store.getPersona(task.assigneePersonaId);
    if (!persona) return fail(res, 400, 'E1062', '指定的执行人不在了');
    const conv = store.ensureExecConversation({
      personaId: persona.id,
      scope: `task:${task.id}`,
      title: `任务 · ${task.title}`,
      projectId: task.projectId ?? null,
    });
    if (!conv) return fail(res, 400, 'E1063', '这个执行人已经不在了');
    if (task.conversationId !== conv.id) store.updateProjectTask(task.id, { conversationId: conv.id });

    const name = safeName(url.searchParams.get('name'));
    const dir = path.join(uploadsRoot, conv.id);
    fs.mkdirSync(dir, { recursive: true });
    const stored = `${Date.now()}-${name}`;
    const buf = await readRawBody(req, ATT_MAX, '文件太大（上限 50MB）—— 大文件请放到工作目录里再让员工去读');
    if (!buf.length) return fail(res, 400, 'E1048', '文件是空的');
    fs.writeFileSync(path.join(dir, stored), buf);
    return sendJson(res, 201, {
      conversationId: conv.id,
      file: {
        name,
        stored,
        size: buf.length,
        mime: String(req.headers['content-type'] ?? ''),
        path: path.join(dir, stored),
        url: `/api/files/${encodeURIComponent(conv.id)}/${encodeURIComponent(stored)}`,
      },
    });
  }

  if (req.method === 'POST' && taskComments) {
    const id = decodeURIComponent(taskComments[1]);
    const task = store.getProjectTask(id);
    if (!task) return fail(res, 404, 'E2039', '任务不存在');
    const body = await readBody(req);
    const text = String(body.text ?? '').trim();
    if (!task.assigneePersonaId) return fail(res, 400, 'E1061', '先指定执行人 —— 评论区是跟他讨论的');
    const persona = store.getPersona(task.assigneePersonaId);
    if (!persona) return fail(res, 400, 'E1062', '指定的执行人不在了');

    const conv = store.ensureExecConversation({
      personaId: persona.id,
      scope: `task:${task.id}`,
      title: `任务 · ${task.title}`,
      projectId: task.projectId ?? null,
    });
    if (!conv) return fail(res, 400, 'E1063', '这个执行人已经不在了');
    if (task.conversationId !== conv.id) store.updateProjectTask(task.id, { conversationId: conv.id });

    let atts = null;
    try {
      atts = validateAtts(conv.id, body.atts);
    } catch (e) {
      return fail(res, 400, e.code ?? 'E1046', e.message);
    }
    if (!text && !atts) return fail(res, 400, 'E1010', '说点什么');

    // 只认这条会话里的**顶层**消息当议题：传了个回复的 id 或者别的会话的 id，就当没传（挂回顶层）
    let parentId = String(body.parentId ?? '').trim() || null;
    if (parentId) {
      const hit = store.listMessages(conv.id).find((m) => m.id === parentId);
      if (!hit) parentId = null;
      else if (hit.parentId) parentId = hit.parentId;
    }

    // 档位归一：新接口用 mode，老客户端发 note:true 也认（等价于 note）
    const mode = body.mode === 'note' || body.note === true ? 'note'
      : body.mode === 'discuss' ? 'discuss'
      : 'execute';

    if (mode === 'note') {
      // 便签：只落一条消息、不派活、不叫醒。**它是给人看的**，不补投给 agent。
      const message = store.addMessage({ conversationId: conv.id, role: 'user', text, parentId, note: true, atts });
      return sendJson(res, 201, { note: true, mode, message, conversationId: conv.id });
    }
    try {
      // 讨论 = 只读（plan）；执行 = 员工默认沙箱。不传 sandbox 就用默认。
      // card（2026-10-23）：卡评论区的派活必须锚定"你在办哪张卡"——
      // 否则"问进度"员工只能去仓库里猜，翻到别的任务的文档就答偏（真实事故）。
      const project = task.projectId ? store.getProject(task.projectId) : null;
      const { run } = dispatchToThread(conv.id, text, {
        projectId: task.projectId ?? null,
        parentId,
        sandbox: mode === 'discuss' ? 'plan' : undefined,
        atts,
        card: {
          title: task.title,
          description: task.description,
          status: task.status,
          projectName: project?.name ?? null,
        },
      });
      return sendJson(res, 202, { runId: run.id, mode, conversationId: conv.id });
    } catch (e) {
      return sendJson(res, e.code === 'busy' ? 409 : 400, { error: e.message });
    }
  }

  /*
   * **仓库值班写卡**（2026-10-17）：巡检（本机脚本；以后也可以是 Actions）把"要人管的事"
   * 写进看板。为什么单开一条、不直接复用上面那个建卡接口：
   *
   *   ① **去重** —— 同一个 PR 巡检十次只该有一张卡（按 `projectId + externalKey` 找）；
   *   ② **保护人的指令** —— 重复巡检只更新标题与描述，**状态一律不动**。卡的状态是人给的指令：
   *      拖到「已完成」＝ 批准，删掉 ＝ 忽略。重跑一次把它弹回「待办」，是最招人烦的那种 bug。
   *
   * body：{ key, title, body, pr? }（key 必填，如 `pr:3` / `issue:2` / `note:branch-protection`）
   *
   * `pr` 是 2026-10-17 补的：**PR 卡也要带上 PR 字段**（`git.prFieldsOf` 归一）。
   * 不带的话巡检扫进来的卡既没有看板上那枚「PR #n 开着」标签，也进不了「刷新 PR」的批量清单 ——
   * 同一个 PR，手动贴链接的卡能看见状态、机器扫进来的看不见，说不过去。
   * `pr` 归状态走同一套 `afterMerged`：巡检报上来是 merged、卡在「进行中」，就收成「待验收」。
   * 状态仍然只在这一个条件下动，别的列（人拖到「已完成」的）一律不碰。
   */
  const repoCards = /^\/api\/projects\/([^/]+)\/repo-cards$/.exec(url.pathname);
  if (req.method === 'POST' && repoCards) {
    const p = store.getProject(decodeURIComponent(repoCards[1]));
    if (!p) return fail(res, 404, 'E2042', '项目不存在');
    const body = await readBody(req);
    const title = String(body.title ?? '').trim();
    if (!title) return fail(res, 400, 'E1046', '卡要有标题');
    const key = String(body.key ?? '').trim();
    if (!key) {
      return fail(res, 400, 'E1047', '卡要有去重键（如 pr:3 / issue:2 / note:xxx）—— 没有它每次巡检都会重复建卡');
    }
    const description = String(body.body ?? '').trim();
    // 写卡那套规矩（去重 / 不覆盖人的状态 / PR 字段只在真变了才写）在 project-tasks 里，
    // 平台内「PR 巡检」定时动作走的是**同一个函数** —— 两处各写一遍迟早跑偏
    const out = upsertRepoCard({ projectId: p.id, key, title, description, pr: git.prFieldsOf(body.pr) });
    return sendJson(res, out.created ? 201 : 200, out);
  }

  if (req.method === 'POST' && url.pathname === '/api/projects') {
    const body = await readBody(req);
    const name = String(body.name ?? '').trim();
    const root = String(body.root ?? '').trim();
    if (!name) return fail(res, 400, 'E1025', '给项目起个名字');
    if (!root) return fail(res, 400, 'E1026', '项目目录不能空 —— AI 要在这儿干活');
    return sendJson(res, 201, { project: store.createProject({
      name, root, extraRoots: body.extraRoots ?? [],
    }) });
  }

  /*
   * 改项目。**档案五列跟名字/目录走同一张单**（界面上是一起自动存的）：
   * 校验摆在这里而不是 store —— store 只管落库，能不能落是接口的事。
   * 三类错分开报码，人一眼知道是哪一格错了：
   *   · 项目经理绑了个不存在的人 → E1080（别等打开面板才发现是空的）
   *   · 成员里有不存在的人 → E1081（整单拒掉，不写半截名单）
   *   · 日期不是 YYYY-MM-DD → E1082（"10月10日"这种存进去，界面没法排序也没法算）
   */
  if (req.method === 'PUT' && detail) {
    const id = decodeURIComponent(detail[1]);
    const body = await readBody(req);
    if (body.pmPersonaId && !store.getPersona(String(body.pmPersonaId))) {
      return fail(res, 400, 'E1080', '选的项目经理已经不在了，换一个');
    }
    if (body.memberPersonaIds !== undefined) {
      if (!Array.isArray(body.memberPersonaIds)) return fail(res, 400, 'E1081', '成员要传一个员工 id 数组');
      const missing = body.memberPersonaIds.map(String).filter((x) => x && !store.getPersona(x));
      if (missing.length) return fail(res, 400, 'E1081', `名单里有人已经不在了：${missing.join('、')}`);
    }
    for (const key of ['startedAt', 'endedAt']) {
      const v = String(body[key] ?? '').trim();
      // 空 = 清掉，允许；非空就必须是 YYYY-MM-DD。
      // ⚠️ 只看正则不够：`Date.parse('2026-02-30')` 会**滚到 3 月 2 日**（不报错），
      //    所以还要回读一遍日期，跟写的那串逐字对上才算数。
      const okDate = /^\d{4}-\d{2}-\d{2}$/.test(v)
        && (() => {
          const d = new Date(`${v}T00:00:00Z`);
          return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
        })();
      if (v && !okDate) {
        return fail(res, 400, 'E1082', `${key === 'startedAt' ? '开始' : '结束'}时间写成 YYYY-MM-DD，例如 2026-10-23`);
      }
    }
    const p = store.updateProject(id, {
      name: body.name === undefined ? undefined : String(body.name).trim(),
      root: body.root === undefined ? undefined : String(body.root).trim(),
      extraRoots: body.extraRoots,
      constitution: body.constitution,
      summary: body.summary,
      pmPersonaId: body.pmPersonaId,
      memberPersonaIds: body.memberPersonaIds,
      startedAt: body.startedAt,
      endedAt: body.endedAt,
    });
    if (!p) return fail(res, 404, 'E2025', '项目不存在');
    return sendJson(res, 200, { project: p });
  }

  // 删项目**不动会话**：绑在它上面的会话自动解绑，回到员工默认工作目录
  if (req.method === 'DELETE' && detail) {
    const id = decodeURIComponent(detail[1]);
    const p = store.getProject(id);
    if (!p) return fail(res, 404, 'E2026', '项目不存在');
    // 内置的删了就没有兜底的地方了 —— 要换地方就改它的目录
    if (p.builtIn) return fail(res, 400, 'E1027', '「默认项目」是内置的，不能删（可以改它的目录）');
    store.deleteProject(id);
    return sendJson(res, 200, { deleted: true });
  }

  return false;
}

/**
 * 项目进度详情（只读）：一个项目的版本清单与卡片清单。
 *
 * **没有写接口，也不打算有**：这一版刻意不搬旧面板的「一键部署 / 登记部署目标」——
 * 那两件事要往目标项目里写文件、要跑脚本，属于数字员工的活（会话里干，事件流留证）。
 * 面板看记录，执行交给员工，权限白名单里就只有 GET。
 */
