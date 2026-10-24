/* routes/node.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * 主分发顺序（先匹配先赢）见 ../server.mjs 的 CHAIN。 */

import { sendJson, fail, readBody } from '../http.mjs';
import * as store from '../store.mjs';
import * as auth from '../auth.mjs';
import * as runs from '../runs.mjs';
import * as runtimes from '../runtimes.mjs';
import * as externals from '../externals.mjs';
import * as status from '../status.mjs';
import * as git from '../git-repos.mjs';

export async function handleNode(req, res, url) {
  const register = /^\/api\/nodes\/register$/.exec(url.pathname);
  const heartbeat = /^\/api\/nodes\/([^/]+)\/heartbeat$/.exec(url.pathname);
  const list = /^\/api\/nodes$/.exec(url.pathname);
  const one = /^\/api\/nodes\/([^/]+)$/.exec(url.pathname);
  const scopeOf = /^\/api\/nodes\/([^/]+)\/scope$/.exec(url.pathname);
  const pathsOf = /^\/api\/nodes\/([^/]+)\/paths$/.exec(url.pathname);

  /**
   * **改一台机器的权限**（2026-10-20，设计 §5.9 / 决策 A 规则 2）。
   *
   * 决策 A 规则 2：**scope 只能由总机侧改，节点侧只读** —— 能自升级的权限等于没有权限边界。
   * 所以这里除了 `auth.decide`（`panel` 令牌在禁止清单里已经被 403 `E4032` 拦掉）之外
   * **再判一次** `mayManage`：compute-only 的令牌根本走不到这里（会被 decide 判成 `E4031`），
   * 但这条判断是"这条接口只有操作员能碰"的**明文表达**，不该只依赖那张表。
   *
   * 改完**不缓存**：下一次请求按新 scope 立刻生效（`store.setNodeScope` 改的是令牌行）。
   */
  if (req.method === 'POST' && scopeOf) {
    if (!auth.mayManage(req)) {
      return fail(res, 403, 'E4032', '改权限只能由总机上做（这台机器拿着面板/算力令牌，改不了自己的权限）');
    }
    const nodeId = decodeURIComponent(scopeOf[1]);
    if (!store.getNode(nodeId)) return fail(res, 404, 'E2040', '这个节点没登记过');
    const body = await readBody(req);
    if (!store.scopeIsValid(body?.scope)) {
      return fail(res, 400, 'E1047', '这台机器的用途只认「算力」(compute) 与「面板」(panel) 的组合');
    }
    if (store.countNodeTokens(nodeId) === 0) {
      /*
       * 一台被「忘掉」过的机器：**没有令牌可改**。如实说，别回一个假的"改好了"——
       * 它下次来是一枚被吊销的令牌（401 `E4012`），权限改了也用不上。
       */
      return fail(res, 409, 'E4003', '这台机器已经没有有效令牌了（被「忘掉」过）—— 让它用新的邀请码重新加入');
    }
    const r = store.setNodeScope(nodeId, body?.scope);
    const n = store.getNode(nodeId);
    console.log(`[节点] ${n?.label ?? nodeId} 的权限改成「${r.scope}」（${r.tokens} 枚令牌，下一次请求立即生效）`);
    return sendJson(res, 200, { nodeId, scope: r.scope, tokens: r.tokens });
  }

  if (req.method === 'GET' && list) {
    return sendJson(res, 200, {
      heartbeatSeconds: runtimes.NODE_HEARTBEAT_SEC,
      offlineAfterSeconds: runtimes.NODE_OFFLINE_AFTER_MS / 1000,
      nodes: runtimes.publicNodes(),
    });
  }

  /*
   * 工作空间映射（2026-10-22）：给**非 git 项目**配"总机的这个目录 = 那台机器的哪个目录"。
   * git 项目不用配 —— 派活时控制面记下仓库全名，节点自己 clone/pull（见 runs.queueRemoteRun）。
   */
  if (req.method === 'GET' && pathsOf) {
    const nodeId = decodeURIComponent(pathsOf[1]);
    if (!store.getNode(nodeId)) return fail(res, 404, 'E2040', '这个节点没登记过');
    return sendJson(res, 200, { paths: store.listNodePaths(nodeId) });
  }
  if (req.method === 'PUT' && pathsOf) {
    const nodeId = decodeURIComponent(pathsOf[1]);
    if (!store.getNode(nodeId)) return fail(res, 404, 'E2040', '这个节点没登记过');
    const body = await readBody(req);
    const remotePath = String(body?.remotePath ?? '').trim();
    const localPath = String(body?.localPath ?? '').trim();
    if (!remotePath || !localPath) return fail(res, 400, 'E1046', '两边路径都要给：总机上的目录 + 那台机器上的目录');
    store.setNodePath(nodeId, remotePath, localPath);
    console.log(`[节点] ${store.getNode(nodeId)?.label ?? nodeId} 的工作空间映射：${remotePath} → ${localPath}`);
    return sendJson(res, 200, { paths: store.listNodePaths(nodeId) });
  }
  if (req.method === 'DELETE' && pathsOf) {
    const nodeId = decodeURIComponent(pathsOf[1]);
    if (!store.getNode(nodeId)) return fail(res, 404, 'E2040', '这个节点没登记过');
    const body = await readBody(req);
    const remotePath = String(body?.remotePath ?? '').trim();
    if (!remotePath) return fail(res, 400, 'E1046', '要删哪条映射，把总机上的那个目录发来');
    const n = store.deleteNodePath(nodeId, remotePath);
    return sendJson(res, 200, { removed: n > 0, paths: store.listNodePaths(nodeId) });
  }

  /**
   * 忘掉一台节点。
   *
   * 它身上压着的活必须**如实收掉** —— 否则那些运行会永远挂在"跑中"，
   * 而它们等的那个节点已经不在这张名单上了（谁也等不到）。
   */
  if (req.method === 'DELETE' && one) {
    const id = decodeURIComponent(one[1]);
    const n = store.getNode(id);
    if (!n) return fail(res, 404, 'E2040', '这个节点没登记过');
    const live = store.listNodeJobs(id, 200).filter((j) => j.status === '待领' || j.status === '执行中');
    for (const j of live) {
      store.finishNodeJob(j.id, '已取消');
      runs.finishRemote(j.runId, { status: '已停止', error: `节点「${n.label}」被从控制面移除了` });
    }
    store.deleteNode(id);
    /*
     * 「忘掉」= **真的把它踢出去**：连它的令牌一起吊销（2026-10-16 加的）。
     * 之前只删记录 —— 那台机器下次心跳就自己回来了（令牌还有效）✗，
     * 于是"忘掉"实际上什么也没忘掉。现在它拿的是自己那枚，吊销之后再也进不来，
     * 想让它回来得重新发一个邀请码 ✓。
     */
    const revoked = store.revokeNodeTokens(id);
    console.log(`[节点] 移除 ${n.label}（${id}）· 顺带收掉 ${live.length} 个活 · 吊销 ${revoked} 枚节点令牌`);
    return sendJson(res, 200, { ok: true, cancelledJobs: live.length, revokedTokens: revoked });
  }

  if (req.method === 'POST' && register) {
    const body = await readBody(req);
    const id = String(body.id ?? '').trim();
    if (!id) return fail(res, 400, 'E1040', '节点要带一个 id');
    /*
     * ⚠️ 报到是**共享**端点（id 在 body 里），所以"用别人的 id 报到"只有这儿挡得住：
     * 拿的是自己那枚令牌，就不许报成别人的 id（auth.nodeMayReach 只看得见路径，看不见 body）。
     */
    if (req.bandiAuth?.kind === 'node' && id !== req.bandiAuth.nodeId) {
      return fail(res, 403, 'E4030', '节点令牌只能用你自己那个 id 报到');
    }
    const node = store.upsertNode({
      id,
      label: String(body.label ?? id).trim() || id,
      // 主机名是那台机器的事实（人起的名字与它分开存，见 runtimes.renameDevice）
      hostname: String(body.hostname ?? body.label ?? id).trim() || id,
      platform: body.platform ? String(body.platform) : null,
      runtimes: Array.isArray(body.runtimes) ? body.runtimes : [],
      externals: Array.isArray(body.externals) ? body.externals : null,
    });
    const declared = Array.isArray(body.runtimes) ? body.runtimes.length : 0;
    console.log(`[节点] 报到：${node.label}（${node.id}）· 自报 ${declared} 个运行时`);
    return sendJson(res, 201, {
      node: runtimes.publicDeviceById(node.id),
      heartbeatSeconds: runtimes.NODE_HEARTBEAT_SEC,
    });
  }

  if (req.method === 'POST' && heartbeat) {
    const body = await readBody(req);
    /*
     * 心跳可以**捎带运行时清单** —— 那台机器上装了新 CLI 之后，这边不用等它重启就能看到。
     * 不捎带也照样工作（清单只在报到时报）。
     */
    const node = store.touchNode(decodeURIComponent(heartbeat[1]), {
      runtimes: Array.isArray(body?.runtimes) ? body.runtimes : undefined,
      // 外部件现状也捎上来（装了没、网关通不通）—— 跟运行时同理，装了新的不用等重启
      externals: Array.isArray(body?.externals) ? body.externals : undefined,
    });
    // 没登记过就 404 —— 别让一个陌生 id 靠心跳把自己造出来
    if (!node) return fail(res, 404, 'E2040', '这个节点没登记过，先调 /api/nodes/register');
    return sendJson(res, 200, {
      node: runtimes.publicDeviceById(node.id),
      heartbeatSeconds: runtimes.NODE_HEARTBEAT_SEC,
    });
  }

  return false;
}

/* --------------------------------------------------------------- 节点领活 */

/** 长轮询的节奏与上限。挂着等，有活立刻回 —— 不引 WebSocket（见 docs/形态决策.md §十二） */
