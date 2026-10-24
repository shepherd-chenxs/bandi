/* routes/workflow.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * 主分发顺序（先匹配先赢）见 ../server.mjs 的 CHAIN。 */

import { sendJson, fail, readBody } from '../http.mjs';
import * as store from '../store.mjs';
import * as runs from '../runs.mjs';
import * as workflows from '../workflows.mjs';
import * as status from '../status.mjs';
import { ensureTaskCardForStep } from '../project-tasks.mjs';

export async function handleWorkflow(req, res, url) {
  const one = /^\/api\/workflows\/runs\/([^/]+)$/.exec(url.pathname);
  const act = /^\/api\/workflows\/runs\/([^/]+)\/(start|decide|retry|assign|status|abort)$/.exec(url.pathname);
  const tplOne = /^\/api\/workflows\/templates\/([^/]+)$/.exec(url.pathname);
  const tplPub = /^\/api\/workflows\/templates\/([^/]+)\/publish$/.exec(url.pathname);

  // 某个会话里挂着的流程（会话里画流程卡片用；一个项目群可以挂好几条）
  if (req.method === 'GET' && url.pathname === '/api/workflows/thread') {
    const tid = url.searchParams.get('threadId') ?? '';
    if (!tid) return fail(res, 400, 'E1029', '要 threadId');
    return sendJson(res, 200, { runs: workflows.runsOfThread(tid) });
  }

  // 列表 + 模板（左栏要的都在这一口里，少一次往返）
  if (req.method === 'GET' && url.pathname === '/api/workflows') {
    return sendJson(res, 200, {
      templates: store.listWorkflowTemplates().map((t) => ({
        id: t.id,
        name: t.name,
        builtIn: !!t.builtIn,
        publishedAt: t.publishedAt ?? null,
        start: workflows.startOf(t),
        nodes: workflows.nodesOf(t),
      })),
      runs: workflows.listWorkflowViews(),
      // 工作台要的：已发布的流程（点一下就能起一条）
      published: workflows.publishedFlows(),
    });
  }

  // 发布 / 下架：发布了的才在工作台里能点开
  if (req.method === 'POST' && tplPub) {
    const body = await readBody(req).catch(() => ({}));
    try {
      const t = workflows.publishTemplate(decodeURIComponent(tplPub[1]), body.on !== false);
      return sendJson(res, 200, { id: t.id, publishedAt: t.publishedAt ?? null });
    } catch (e) {
      return fail(res, 400, 'E1030', String(e?.message ?? e));
    }
  }

  // 流程模板：读一个 / 存一个（设计器用）
  if (req.method === 'GET' && tplOne) {
    const t = store.getWorkflowTemplate(decodeURIComponent(tplOne[1]));
    if (!t) return fail(res, 404, 'E2028', '模板不存在');
    return sendJson(res, 200, {
      id: t.id,
      name: t.name,
      builtIn: !!t.builtIn,
      publishedAt: t.publishedAt ?? null,
      start: workflows.startOf(t),
      nodes: workflows.nodesOf(t),
    });
  }
  if ((req.method === 'PUT' || req.method === 'POST') && tplOne) {
    const body = await readBody(req);
    try {
      const t = workflows.saveTemplate({
        id: decodeURIComponent(tplOne[1]),
        name: body.name,
        nodes: body.nodes,
        start: body.start,
      });
      return sendJson(res, 200, { id: t.id, name: t.name, builtIn: !!t.builtIn, start: workflows.startOf(t), nodes: workflows.nodesOf(t) });
    } catch (e) {
      return fail(res, 400, 'E1031', String(e?.message ?? e));
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/workflows/templates') {
    const body = await readBody(req);
    try {
      const t = workflows.saveTemplate({ id: body.id || null, name: body.name, nodes: body.nodes, start: body.start });
      return sendJson(res, 201, { id: t.id, name: t.name, builtIn: !!t.builtIn, start: workflows.startOf(t), nodes: workflows.nodesOf(t) });
    } catch (e) {
      return fail(res, 400, 'E1032', String(e?.message ?? e));
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/workflows/runs') {
    const body = await readBody(req);
    try {
      // intent = 发起时填的「想法」，会作为第一句话发给第一个节点的人。
      // **必须填**：它是「开始」节点的内容，也是第一个节点接到的活；空了就没起因。
      // 前端也拦，这里是接口这道门 —— 接口是能直接调的，别只靠前端。
      if (!String(body.intent ?? '').trim()) return fail(res, 400, 'E1033', '先说说要干什么');
      // 没有 venue：流程不建群，派给谁就发到谁那儿
      return sendJson(
        res,
        201,
        workflows.startWorkflow({
        templateId: body.templateId,
        title: body.title,
        intent: body.intent,
        // 项目：选了就在那儿干活；没选（老调用方）就退回员工自己的 cwd
        projectId: body.projectId ? String(body.projectId) : null,
      }),
      );
    } catch (e) {
      return fail(res, 400, 'E1034', String(e?.message ?? e));
    }
  }

  if (req.method === 'GET' && one) {
    const view = workflows.getWorkflowView(decodeURIComponent(one[1]));
    if (!view) return fail(res, 404, 'E2029', '流程不存在');
    return sendJson(res, 200, view);
  }

  // 删掉一条流程实例（连同步骤记录）。**不碰**各经办人的会话和消息。
  if (req.method === 'DELETE' && one) {
    const id = decodeURIComponent(one[1]);
    if (!store.deleteWorkflowRun(id)) return fail(res, 404, 'E2030', '流程不存在');
    return sendJson(res, 200, { deleted: true });
  }

  /*
   * 流程的一步 → 它那张**任务卡**（2026-10-19）：`POST /api/workflows/runs/:id/tasks/:taskId/card`
   *
   * 流程页那枚「对话」改成"打开这一步的任务卡"之后，需要这条路。
   * 幂等：卡已经有了就返回原卡（不新建、不改内容）—— 点两次不会开两张。
   * 单开一个 POST 而不是 GET：第一次点会**真的建一张卡**，用 GET 做写操作迟早出事
   * （预取、刷新、爬虫，任何一个都会给它种一张卡）。前端只在点击时调。
   */
  const stepCard = /^\/api\/workflows\/runs\/([^/]+)\/tasks\/([^/]+)\/card$/.exec(url.pathname);
  if (req.method === 'POST' && stepCard) {
    const runId = decodeURIComponent(stepCard[1]);
    const taskId = decodeURIComponent(stepCard[2]);
    const run = store.getWorkflowRun(runId);
    if (!run) return fail(res, 404, 'E2029', '流程不存在');
    const step = store.listWorkflowTasks(runId).find((t) => t.id === taskId);
    if (!step) return fail(res, 404, 'E2045', '这一步不在这条流程里');
    try {
      const card = ensureTaskCardForStep(run, step);
      return sendJson(res, 200, { task: card });
    } catch (e) {
      return fail(res, 400, 'E2046', String(e?.message ?? e));
    }
  }

  if (req.method === 'POST' && act) {
    const id = decodeURIComponent(act[1]);
    let body = {};
    try {
      body = await readBody(req);
    } catch { /* 可以没有 body */ }
    try {
      // **改状态也好、终止也好，都要先真的停手**：光改状态的话经办人还在跑，
      // 跑完又把状态写回去，两边打架（用户实报："状态进行中、备注却写着被中断"）。
      if (act[2] === 'abort' || act[2] === 'status') {
        const task = store.listWorkflowTasks(id).at(-1);
        // requestStop 而不是裸 abort：带"是人停的"标记（落成已停止而不是失败）+ 停止看门狗
        if (task?.agentRunId) runs.requestStop(task.agentRunId);
      }
      const r =
        act[2] === 'start' ? workflows.startCurrentStep(id, { force: body.force === true })
        : act[2] === 'decide' ? workflows.decide(id, body.decision)
        : act[2] === 'retry' ? workflows.retryCurrentStep(id)
        : act[2] === 'assign' ? workflows.assignCurrentStep(id, body.personaId)
        : act[2] === 'status' ? workflows.setStepStatus(id, body.status)
        : workflows.abortWorkflow(id);
      return sendJson(res, 200, r);
    } catch (e) {
      return fail(res, 400, 'E1035', String(e?.message ?? e));
    }
  }

  return false;
}

/** 服务器登记表：单台机器的密钥与连通性。路径带参数，所以单独一个 handler */
