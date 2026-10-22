import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { port, repoRoot, host, dataDir, dbPath, extraOrigins } from './config.mjs';
import * as netmode from './netmode.mjs';
import * as store from './store.mjs';
import * as auth from './auth.mjs';
import * as runs from './runs.mjs';
import * as skills from './skills.mjs';
import * as runtimes from './runtimes.mjs';
import * as externals from './externals.mjs';
import * as plugins from './plugins.mjs';
import * as sshRegistry from './ssh-registry.mjs';
import * as sshExec from './ssh-exec.mjs';
import * as connectors from './connectors.mjs';
import * as catalog from './catalog.mjs';
import * as cliModels from './cli-models.mjs';
import { dispatchToThread, personaRoots } from './dispatch.mjs';
import { ensureCliInstalled } from './cli-install.mjs';
import * as workflows from './workflows.mjs';
import * as quota from './quota.mjs';
import * as status from './status.mjs';
import { projectTasks, allTasks, personaTasks, createProjectTask, updateProjectTask, startProjectTask, onTaskRunFinished, afterMerged, upsertRepoCard, ensureTaskCardForStep } from './project-tasks.mjs';
import * as git from './git-repos.mjs';
import * as schedules from './schedules.mjs';
import * as secretary from './secretary.mjs';
import * as experts from './experts.mjs';
import * as localMode from './local-mode.mjs';
import * as discover from './discover.mjs';
import * as lanAnnounce from './lan-announce.mjs';
import { handleConversation } from './routes/conversation.mjs';
import { handlePersona } from './routes/persona.mjs';
import { handleGroup } from './routes/group.mjs';
import { handleExpert } from './routes/expert.mjs';
import { handleSkill } from './routes/skill.mjs';
import { handleConnector } from './routes/connector.mjs';
import { handleNode } from './routes/node.mjs';
import { handleNodeWork } from './routes/nodeWork.mjs';
import { handleRuntime } from './routes/runtime.mjs';
import { handlePluginAction } from './routes/plugin.mjs';
import { handleProject } from './routes/project.mjs';
import { handleStatus } from './routes/status.mjs';
import { handleFs } from './routes/fs.mjs';
import { handleWorkflow } from './routes/workflow.mjs';
import { handleSsh } from './routes/ssh.mjs';
import { handleGit } from './routes/git.mjs';
import { handleRun } from './routes/run.mjs';
import { handleSchedules } from './routes/schedules.mjs';
import { handleLocal, supervisorModule } from './routes/local.mjs';
import { sendJson, fail, readBody, guardWrite, serveStatic, BadRequest, allowedOrigins, webDir } from './http.mjs';
import { SERVER } from './server-state.mjs';
import { runtimeOptions, runtimesOk, withExternals } from './runtime-view.mjs';



function helloPayload() {
  const me = localMode.nodeIdentity();
  const nm = netmode.readNetMode();
  return {
    platform: 'bandi',
    proto: 1,
    // 版本读 apps/desktop/version.json（运行期读一次缓存；读不到给 null，不编一个）
    version: localMode.platformVersion(),
    instanceId: localMode.instanceId(),
    label: me.label,
    hostname: me.hostname,
    httpPort: port,
    allowLan: nm.allowLan,
    joinable: netmode.isJoinable({ allowLan: nm.allowLan, explicit: !!process.env.BANDI_HOST, boundHost: SERVER.boundHost }),
    // 能力声明：有这个才认得出 `scope` 字段（旧总机没有 → 加入方回 E2050，不静默降级）
    caps: ['scope'],
  };
}

/**
 * 给一台设备补上「外部件」（班底之外还要有的东西，现在只有 magpie）。
 *
 * **本机现探**（那台机器就是控制面自己），**节点用自报的**（心跳里带上来的 —— 本机判不了）。
 * `catalog` 是那张说明表：界面靠它把"没装"的东西也画出来（不然一片空白，用户不知道缺什么）。
 */

const routes = {
  /**
   * **免令牌**（见 auth.mjs 里 guard 顶部那条放行）：加入向导"探这个地址"打的就是它。
   *
   * 披露的东西与 UDP 应答同源 —— 机器名 / 主机名 / 端口 / 能不能加入 / 版本 / 能力。
   * 故意不带任何秘密（设计 §5.4），所以它不需要令牌也不会漏东西。
   */
  'GET /api/hello': async (req, res) => {
    sendJson(res, 200, helloPayload());
  },
  // 前端是长活 SPA：磁盘上的前端代码换了，开着的页面不会自己换 —— 「点了没反应」多半是它。
  // 前端每 60 秒来对一次指纹（各模块 mtime+size 之和），变了就亮「刷新」提示条。十几个 stat，几乎零成本。
  'GET /api/web-version': async (req, res) => {
    try {
      let v = 0;
      const add = (p) => { const st = fs.statSync(p); v += Math.round(st.mtimeMs) + st.size; };
      add(path.join(webDir, 'app.mjs'));
      for (const name of fs.readdirSync(path.join(webDir, 'js'))) {
        if (name.endsWith('.mjs')) add(path.join(webDir, 'js', name));
      }
      sendJson(res, 200, { v: `js-${v}` });
    } catch {
      sendJson(res, 200, { v: null });
    }
  },
  'GET /api/state': async (req, res) => {
    sendJson(res, 200, {
      runtimes: runtimeOptions(),
      repoRoot,
      platformRoot: repoRoot,
      me: store.LOCAL_USER,
      // 带上"忙不忙"：通讯录里要一眼看出谁能马上接活
      // busyLabel：**他在干什么** —— 光一个"工作中"没用，得知道是哪条流程的哪一步
      // （运行上挂的 workflowTask 就是答案；不属于任何流程的就是普通对话）
      personas: store.listPersonas().map((p) => {
        const ar = store.activeRunForPersona(p.id);
        let busyLabel = null;
        if (ar) {
          const t = store.getWorkflowTaskByAgentRun(ar.id);
          if (t) {
            const w = store.getWorkflowRun(t.runId);
            busyLabel = `流程「${w?.title ?? '?'}」· ${t.nodeName}`;
          } else {
            busyLabel = '对话里';
          }
        }
        return { ...p, busy: !!ar, busyLabel, busySince: ar?.startedAt ?? null };
      }),
      conversations: store.listConversations(),
      /*
       * 群列表**单独给**（2026-10-20 用户报「通讯录里群也没了」）：
       * 通讯录的群行以前是从 conversations 里去重推出来的 —— 会话删光，群就凭空消失。
       * 群是容器，容器列表得有自己的来源，所以这里直接给 groups 表（零段的群也在）。
       * 消息列表照旧只看 conversations（没会话就没消息，不该占行），两者互不干扰。
       */
      groups: store.listGroups(),
      // 被「不显示」收走的会话：**只给聊天记录抽屉用**（2026-10-20 去掉会话归档后）。
      // 不并进 conversations —— 那条是热路径，工作台/通讯录都在吃，混进隐藏的会凭空多出行。
      hiddenConversations: store.listHiddenConversations(),
    });
  },

  /** 插件市场：可装的 ＋ 已装的，每条带 installed/enabled —— 界面据此显示"安装"还是"停用/卸载" */
  'GET /api/plugins': async (req, res) => {
    sendJson(res, 200, {
      plugins: plugins.marketList(),
      pluginsRoot: plugins.pluginsRoot,
      catalogRoot: plugins.catalogRoot,
      ledgerPath: plugins.ledgerPath,
    });
  },

  /**
   * 项目进度总览 —— 「项目面板」插件的数据源（只读）。
   *
   * 项目清单来自平台自己的项目账本；进度现读各项目根下的 `.bandi/status.yaml`。
   * 读不到的项目**照样列出来**（标「未纳管」），不自动删、不猜。
   */
  'GET /api/status/projects': async (req, res) => {
    sendJson(res, 200, { projects: status.listProjectCards(store.listProjects()) });
  },

  /** 服务器登记总览 —— 只出安全字段（不出私钥路径）。界面插件的数据源 */
  'GET /api/ssh/servers': async (req, res) => {
    sendJson(res, 200, sshRegistry.publicServers());
  },

  /**
   * 登记或更新一台机器（按 alias upsert）。
   * 界面是人点的，**不受 MCP 那个 BANDI_SSH_ALLOW_WRITE 开关约束** —— 那个开关是防 agent 乱改的。
   * 校验和写入都走 ssh-registry.mjs，和 MCP 的 server_upsert 是同一份代码。
   */
  'POST /api/ssh/servers': async (req, res) => {
    try {
      const body = await readBody(req);
      const r = sshRegistry.upsertServer(body);
      sendJson(res, 200, { ...sshRegistry.publicServers(), created: r.created, alias: r.alias });
    } catch (e) {
      /*
       * 2026-10-21 重设计：这里原来一律 `400 E1001`，把三件不同的事混成一个码 ——
       *   ① 输入没过校验（别名带空格、地址带了端口…）→ 用户改一下就能过
       *   ② 请求体本身坏了（不是合法 JSON / 过大）→ 调用方写错了
       *   ③ 登记表写不进去（权限、磁盘满）→ 真的是服务器的问题
       * 混一起的后果：前端只能显示「E1001：服务异常」，人看不到哪个字段错了（用户截图）。
       * 现在按 `status` 分流：4xx 的 message 本来就是写给用户的，照原文回；5xx 只回码。
       */
      if (e instanceof BadRequest) return fail(res, 400, e.code, String(e.message));
      const status = Number(e?.status) || 500;
      if (status >= 500) {
        console.error('[班底] 服务器登记表写入失败', e);
        return fail(res, 500, 'E5005', `写不进服务器登记表（${sshRegistry.REGISTRY_PATH}），磁盘满或没有写权限`);
      }
      return fail(res, status, e?.code || 'E1051', String(e?.message ?? e));
    }
  },

  'POST /api/personas': async (req, res) => {
    const body = await readBody(req);
    const name = String(body.name ?? '').trim();
    if (!name) return fail(res, 400, 'E1002', '员工需要名字');
    const runtime = runtimesOk(body.runtime) ? body.runtime : 'codex';
    // 模型名**不再校验**：以前要对着账本查"有没有这个模型"，账本已经下架了。
    // 现在的权威是 CLI 自己 —— 名字填错了它会报，班底替它把关只会把新模型挡在门外。
    const persona = store.createPersona({
      name,
      // 岗位：自由文本、可空。**只用于看人/辨认，不参与派活**（引擎只认节点上点的名）
      role: String(body.role ?? '').trim() || null,
      instructions: String(body.instructions ?? ''),
      runtime,
      sandbox: String(body.sandbox ?? 'danger-full-access'),
      cwd: body.cwd ? String(body.cwd) : repoRoot,
      model: body.model ? String(body.model) : null,
      showThinking: body.showThinking === undefined ? 0 : (body.showThinking ? 1 : 0),
      rootDirs: Array.isArray(body.rootDirs) ? body.rootDirs.map(String).filter((s) => s.trim()) : [],
    });
    sendJson(res, 201, { persona });
  },

  /*
   * 专家库目录（2026-10-22 建库，2026-11 扩到八位）：出厂的岗位专家 + 各自的雇佣状态。
   * 目录是代码里的常量（experts.mjs），这里只做读出口 —— 雇佣/解聘走下面的 handleExpert
   * （带 :key 的动态路径，静态路由表按 `方法 + 全路径` 匹配，吃不了它）。
   */
  'GET /api/experts': async (req, res) => {
    sendJson(res, 200, { experts: experts.listExperts() });
  },

  'POST /api/conversations': async (req, res) => {
    const body = await readBody(req);
    const personaId = String(body.personaId ?? '');
    if (!store.getPersona(personaId)) return fail(res, 400, 'E1003', '先选一个数字员工');
    const title = String(body.title ?? '').trim() || '未命名会话';
    const conversation = store.createConversation({ title, personaId });
    sendJson(res, 201, { conversation });
  },

  'GET /api/runtimes': async (req, res) => {
    sendJson(res, 200, { runtimes: runtimes.publicList() });
  },

  /** 连接器账本：外面来的能力（MCP server…）装了什么、给谁用、要什么凭据 */
  'GET /api/connectors': async (req, res) => {
    sendJson(res, 200, { kinds: connectors.KINDS, connectors: connectors.publicList() });
  },

  /** skill 库：正文是文件（平台根下 skills/），这里只做读写与登记 */
  'GET /api/skills': async (req, res) => {
    sendJson(res, 200, { skillsRoot: skills.skillsRoot, skills: skills.listSkills() });
  },

  /** 从本地导入：先扫再导，两步分开，让用户看清扫到了什么 */
  'POST /api/skills/discover': async (req, res) => {
    const body = await readBody(req);
    const root = String(body.root ?? '').trim() || repoRoot;
    if (!fs.existsSync(root)) return fail(res, 400, 'E1004', '这个路径不存在');
    sendJson(res, 200, { root, found: skills.discoverSkills(root) });
  },

  'POST /api/skills/import': async (req, res) => {
    const body = await readBody(req);
    const dirs = Array.isArray(body.dirs) ? body.dirs.map(String) : [];
    if (!dirs.length) return fail(res, 400, 'E1005', '没选要导入的');
    // 内置技能只读 —— 覆盖导入是编辑闸之外的第二条改法，一并堵死（不覆盖，报"跳过"）
    const overwrite = !!body.overwrite;
    const imported = [];
    const skipped = [];
    for (const d of dirs) {
      try {
        const r = skills.importSkill(d, { overwrite });
        if (r.skipped) skipped.push({ dir: d, name: r.name, reason: r.reason });
        else imported.push({ dir: d, name: r.name });
      } catch (e) {
        skipped.push({ dir: d, name: null, reason: String(e?.message ?? e) });
      }
    }
    sendJson(res, 200, { imported, skipped, skills: skills.listSkills() });
  },

  'POST /api/skills': async (req, res) => {
    const body = await readBody(req);
    const name = String(body.name ?? '').trim();
    if (!name) return fail(res, 400, 'E1006', 'skill 需要个名字');
    if (skills.getSkill(name)) return fail(res, 409, 'E4001', '同名 skill 已存在');
    try {
      sendJson(res, 201, { skill: skills.writeSkill(name, { description: body.description, body: body.body }) });
    } catch (e) {
      fail(res, 400, 'E1007', String(e?.message ?? e));
    }
  },

  /** 建群：群主是创建人（人），另选一个虚拟人当群助手接没 @ 的话 */
  'POST /api/groups': async (req, res) => {
    const body = await readBody(req);
    const title = String(body.title ?? '').trim();
    if (!title) return fail(res, 400, 'E1008', '群需要个名字');

    // assistantPersonaId 是正式字段；ownerPersonaId 兼容旧调用
    const assistantPersonaId = String(body.assistantPersonaId ?? body.ownerPersonaId ?? '');
    if (!store.getPersona(assistantPersonaId)) return fail(res, 400, 'E1009', '先选一个群助手');

    const memberIds = Array.isArray(body.memberIds) ? body.memberIds.map(String) : [];
    const valid = memberIds.filter((id) => store.getPersona(id));

    const group = store.createGroup({ title, assistantPersonaId, memberIds: valid });
    // 同时给 group 和第一段会话：前端要 session id 才能直接进聊天，要 group id 才能开下一段
    sendJson(res, 201, { group: store.getGroup(group.groupId), conversation: store.getConversation(group.id) });
  },

  /*
   * 额度：**每个模型**每天最多用多少 token。
   *
   * 为什么按模型不按供应商：贵/便宜的分界线在**模型 id** 上，不在供应商上 ——
   * 本机 codex / dsh 只配了一个供应商（magpie 网关），
   * `group/auto-deepseek-v4-1-flash` 和 `opencode-zen-free/*` 都是它名下的模型。
   * 按供应商设额度 = 给 magpie 设一个数，会把免费的和收费的一起管住。
   *
   * 两条都返回同一份 quotaStatus()（今天的总量 + 每个模型一行：限额/用量/超没超）——
   * 界面拿到的必须是同一次读数，不然"已用"和"超了没"会对不上。
   */
  'GET /api/quota': async (req, res) => {
    sendJson(res, 200, await quota.quotaStatus());
  },

  /**
   * 存限额。body：`{ limits: { 模型id: { dailyTokens, dailyRuns } } }`。
   *
   * **整表替换**：传进来就是全部，没提到的模型一律回到"不限制"（界面上是一个「保存」，
   * 把一个上限清空 = 这个模型不管了，那一下必须真的落下去）。
   * 数字不合法 / 留空 / 0 都当成"不限制"，不报错：界面上那就是清空一个输入框，
   * 不该因为一个手滑的字符弹红。要真拦，闸在派活那一步（workflows.startCurrentStep）。
   */
  'POST /api/quota': async (req, res) => {
    const body = await readBody(req);
    const limits = body?.limits && typeof body.limits === 'object' ? body.limits : {};
    quota.setQuotas(limits);
    sendJson(res, 200, await quota.quotaStatus());
  },
};

/** 带路径参数的路由单独处理 */

SERVER.AUTH = auth.setup({ host, dataDir, envToken: process.env.BANDI_TOKEN });
/*
 * 这个进程**现在**听的是哪儿 —— 不只是启动时那个 `host`。
 *
 * 为什么要有它（2026-10-16）：加了「重启生效」那颗按钮之后，监听地址会**原地换**（见 restartListening），
 * 于是"配置里想要什么"（netmode.json）和"实际听着什么"可能不再是一回事，
 * `/api/lan` 要如实分辨这两者 ✓。
 */
/**
 * 定时任务（`/api/schedules`，2026-10-17）。
 *
 * 界面只做三件事：看清单、改重复方式/开关、点「立即跑」。**执行**在 `schedules.mjs` 那个 30 秒的
 * 心跳里，不在这条请求链路上 —— 一次巡检要几十秒，挂在 HTTP 上会被浏览器超时掐掉，
 * 人还会以为"点了没反应"。所以「立即跑」也只是**同步跑一次并等它**，不走后台队列：
 * 人要的是"现在到底行不行"这个答案，等几十秒比事后翻日志强。
 *
 * 重复方式七选一（对齐 WorkBuddy 的定时任务）：间隔（分钟）/ 单次（某时刻跑一次）/
 * 每天 / 每周 / 每双周 / 每月 / 每年（都带「几点」）。时间字段只在对应方式下必填，
 * PATCH 只改开关时不必带着时间。
 */



/* ------------------------------------------------- 节点形态（2026-10-21 拍板） */

/*
 * **节点不做「看总机面板」** —— 瘦客户端反代（client-proxy.mjs）整体移除。
 * 加入后本机服务照常答自己的 UI 与 API；app.js 读 `/api/local/status` 发现已加入
 * 就渲染节点状态页（`renderNodeMode`）。总机的面板只存在于总机上。
 * 总机侧的 scope 机制（`auth.decide` 的 E4031 等）**保留**：存量令牌与设备详情还认它，
 * 它仍是「compute 令牌摸面板 → 403」的那道闸。
 */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    /*
     * 访问令牌：**排在来源闸前面** —— 没令牌的请求，连"来源对不对"都不该让它摸到。
     * 闸开不开只看监听地址（回环免鉴权 / 非回环全要），见 auth.mjs 的长注释。
     */
    if (!auth.guard(SERVER.AUTH, req, res, url)) return;

    /*
     * **本机专属接口**（2026-10-20，设计 §1.2 新增 A）。
     *
     * 位置在 `auth.guard` **之后**：令牌语义只有一处，别在两处各判一遍。
     * （回环形态下闸本来就全放行；若有人 `BANDI_HOST=0.0.0.0` 强开，
     *   `/api/local/*` 仍会被令牌闸保护 **＋** 自己那道回环校验，是双保险 —— P0-8。）
     */
    const handledLocal = await handleLocal(req, res, url);
    if (handledLocal !== false) return;

    if (!url.pathname.startsWith('/api/')) {
      if (serveStatic(res, url.pathname)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('没有这个文件');
      return;
    }

    const key = `${req.method} ${url.pathname}`;

    // 写请求先过来源守卫（CSRF）：任何网页借你的浏览器发的写请求都在这里被拦下
    const denied = guardWrite(req);
    if (denied) return fail(res, 403, 'E3001', denied);

    if (routes[key]) return await routes[key](req, res);

    const handledConversation = await handleConversation(req, res, url);
    if (handledConversation !== false) return;

    const handledPersona = await handlePersona(req, res, url);
    if (handledPersona !== false) return;

    const handledExpert = await handleExpert(req, res, url);
    if (handledExpert !== false) return;

    const handledProject = await handleProject(req, res, url);
    if (handledProject !== false) return;

    const handledStatus = await handleStatus(req, res, url);
    if (handledStatus !== false) return;

    const handledFs = await handleFs(req, res, url);
    if (handledFs !== false) return;

    const handledGroup = await handleGroup(req, res, url);
    if (handledGroup !== false) return;

    const handledSkill = await handleSkill(req, res, url);
    if (handledSkill !== false) return;

    const handledConnector = await handleConnector(req, res, url);
    if (handledConnector !== false) return;


    const handledRuntime = await handleRuntime(req, res, url);
    if (handledRuntime !== false) return;

    const handledNode = await handleNode(req, res, url);
    if (handledNode !== false) return;

    const handledNodeWork = await handleNodeWork(req, res, url);
    if (handledNodeWork !== false) return;

    const handledPlugin = await handlePluginAction(req, res, url);
    if (handledPlugin !== false) return;

    const handledSsh = await handleSsh(req, res, url);
    if (handledSsh !== false) return;

    const handledWorkflow = await handleWorkflow(req, res, url);
    if (handledWorkflow !== false) return;

    const handledRun = await handleRun(req, res, url);
    if (handledRun !== false) return;

    const handledGit = await handleGit(req, res, url);
    if (handledGit !== false) return;

    const handledSchedules = await handleSchedules(req, res, url);
    if (handledSchedules !== false) return;

    fail(res, 404, 'E2036', '没有这个接口');
  } catch (err) {
    // 请求本身有问题 → 400（原文就是写给调用方的）；其余是服务端出错 → 500。
    // 500 **不回内部原文**：那可能是 SQL/文件路径/栈片段，对用户没用、对旁人有用。
    // 完整错误进日志（下一条），排查不受影响。
    if (err instanceof BadRequest) fail(res, 400, err.code ?? 'E1044', String(err.message));
    else {
      console.error('[班底] E5004 · 未捕获的服务端错误', err);
      fail(res, 500, 'E5004', '服务内部错误，详情看服务端日志');
    }
  }
});

SERVER.restart = restartListening; // 原地重启监听：handler 里通过 SERVER 调（见 server-state.mjs）
const reaped = store.reapStaleRuns();
if (reaped) console.log(`清理了 ${reaped} 条被中断的运行`);

// 工作流：内建模板保证存在；**把引擎挂在 run 完成点上** —— 推进由平台做，不靠数字员工自觉
workflows.ensureBuiltInTemplate();
// 出厂就有一个人能说话：内置秘书「喜儿」（幂等，已有则只补 builtin 标记，不改名不改指令）
// **部署即装**（2026-10-22）：不管谁部署、用什么方式起（安装包 / 源码 start.cmd /
// systemd / 开机自启），服务起来那一刻「bandi」全局命令就在。幂等 —— 装好了什么都不写。
// 闸门与实现见 cli-install.mjs（BANDI_DATA 显式指定 = 测试/沙箱，默认不动真实用户目录）。
try {
  const cliNote = await ensureCliInstalled();
  if (cliNote) console.log(cliNote);
} catch { /* 上面保证不抛，这里兜一层：装命令失败不能拦启动 */ }
try {
  const xier = secretary.ensureSecretary();
  if (xier.created) console.log(`新建了内置员工「${xier.persona.name}」`);
} catch (err) {
  // seed 失败不该拦住整个服务：她能做的事少，服务起不来才是大事
  console.log(`内置员工创建失败（不影响启动）：${err?.message ?? err}`);
}
// 锁定同步（2026-10-23）：雇佣员工的技能挂载回专家包清单 + 名字/岗位/指令回出厂值
// （存量重置 + 日常幂等检查）。路由层从此锁死（E2054 技能 / E2055 身份），
// 这里负责"上线那一刻库里已有的改动"拉回出厂。
try {
  const synced = experts.syncHiredExperts();
  if (synced.length) console.log(`雇佣员工已重置回专家包出厂（技能挂载 / 名字 / 职责 / 指令）：${synced.join('、')}`);
} catch (err) {
  console.log(`雇佣员工同步失败（不影响启动）：${err?.message ?? err}`);
}
// 内置员工同理（2026-10-22 用户定：喜儿按专家团模式收编）——技能挂载与身份三件回出厂，
// 路由层同步锁死（E2054 技能 / E2055 身份）。她比专家早一步 seed，这里紧跟着做增量重置。
try {
  const reset = secretary.syncSecretary();
  if (reset?.length) console.log(`内置员工喜儿已重置回出厂（${reset.join(' / ')}）`);
} catch (err) {
  console.log(`内置员工同步失败（不影响启动）：${err?.message ?? err}`);
}
runs.onRunFinish(workflows.onAgentRunFinished);
// 任务卡同理（2026-10-17）：运行跑完/被停/跑挂了，卡不能永远挂在「进行中」——
// 完成 → 待确认；人停的 / 跑挂的 → 已阻塞（**不回待办**，否则会被自动重新派活 → 死循环）
runs.onRunFinish(onTaskRunFinished);
// 进程重启会把在跑的执行判死（reapStaleRuns），可工作流的任务还写着「进行中」——
// 那条任务就永远卡住了。所以启动时把这类任务也收尾，别让人对着一个假"进行中"等。
const stuckTasks = store
  .listWorkflowRuns()
  .filter((r) => r.status === '进行中')
  .flatMap((r) => store.listWorkflowTasks(r.id))
  .filter((t) => t.status === '进行中');
for (const t of stuckTasks) {
  store.updateWorkflowTask(t.id, {
    // **「已阻塞」不是「进行中」**：进程重启后这次执行已经没了，
    // 还写"进行中"的话界面上计时器继续走、徽标说在跑 —— 但它永远不会自己动（用户实报）。
    // 已阻塞 = "卡住了、等人处理"，跟"跑挂了（失败）"也不一样：失败的可以重跑，这个要先决定怎么办。
    status: '已阻塞',
    note: '服务重启，这一步被中断',
    endedAt: store.nowIso(),
  });
}
if (stuckTasks.length) console.log(`收了 ${stuckTasks.length} 个被中断的工作流任务`);

/* ------------------------------------------------------------------ 掉线清扫 */

/**
 * 活被某个节点领走了，而那个节点**掉线了** —— 那次运行不能永远挂在"跑中"。
 *
 * 判据是**节点离线**（三个心跳周期没有消息），**不是"跑了多久"**：
 * 一个半小时的重构活，只要节点还在心跳就绝不能被打断。节点在跑活时是并发心跳的，
 * 所以这条判据是准的。
 *
 * 为什么不是"重新排一次队"：这次执行的**副作用可能已经发生了一半**（改了文件、提交了），
 * 悄悄重跑比说清楚更危险。重派是"中断续跑"那一步的事，这里先如实判中断。
 */
const SWEEP_MS = 15000;
const sweep = setInterval(() => {
  const now = Date.now();
  for (const job of store.listRunningNodeJobs()) {
    const n = store.getNode(job.nodeId);
    if (n && now - Date.parse(n.lastSeenAt) < runtimes.NODE_OFFLINE_AFTER_MS) continue;

    /*
     * 节点没了，但**"能不能重派"取决于副作用发生过没有**：
     *   · 一次动静都没有（`progressAt` 空）→ 那边根本没开张，**放回队列**，换个时机再跑；
     *   · 有动静之后才断 → 副作用可能已经发生了一半（改了文件、提交了），
     *     悄悄重跑比说清楚危险得多 —— 如实判**中断**。
     */
    if (!job.progressAt) {
      store.releaseNodeJob(job.id);
      console.log(`[节点] ${job.nodeId} 掉线 —— 那个还没开张的活已放回队列`);
      continue;
    }
    store.finishNodeJob(job.id, '已中断');
    const done = runs.finishRemote(job.runId, {
      status: '中断',
      exitCode: null,
      error: `节点「${n?.label ?? job.nodeId}」掉线了，这次执行被中断（那台机器上的进程可能还在跑）`,
    });
    console.log(
      `[节点] ${job.nodeId} 掉线 —— 把它正在跑的活判为中断${done ? '' : '（运行已不在内存里，只收了队列行）'}`,
    );
  }
}, SWEEP_MS);
sweep.unref(); // 别让这个定时器拖着进程不退出

/*
 * 定时任务的心跳（2026-10-17）：30 秒一跳，挑**到点的**任务串行跑。
 * 只读动作（PR 巡检）第一条；它会自己去 GitHub 拉清单，所以这里不预判网络、令牌 ——
 * 错了就记进任务的 `lastStatus/lastError`，在「设置 → 定时任务」那一行如实显示。
 */
schedules.start();

/*
 * **启动即已加入 → 直接进入节点形态**（2026-10-21 拍板：只当算力，无反代无面板）。
 * 本机 UI/API 照常服务（app.js 会渲染节点状态页）；这里只负责把节点进程拉起来。
 * supervisor 见到 autostart 的常驻在跑会直接认领（external），不会双起。
 */
if (localMode.isJoined()) {
  const joined = localMode.readClientConfig();
  console.log(
    `[本机] 已加入「${joined.hostLabel || joined.hostHostname || joined.controlPlane}」（${joined.controlPlane}）` +
      ` —— 节点形态：只出算力，本机数据原样（从未被写过）`,
  );
  if (String(joined.scope ?? 'compute').split(/[\s,]+/).includes('compute')) {
    void (async () => {
      const sup = await supervisorModule();
      if (!sup) return;
      try {
        const r = sup.start();
        console.log(
          r.external
            ? `[本机] 节点已在跑（pid ${r.pid}，外部拉起的常驻）—— 不另起一个`
            : `[本机] 已拉起节点进程（pid ${r.pid}）`,
        );
      } catch (e) {
        console.warn(`[本机] 节点进程没起来（不影响面板，下次重启会再试）：${e?.message ?? e}`);
      }
    })();
  }
}

server.listen(port, SERVER.boundHost, logListen);

/**
 * 启动横幅。抽成函数是为了**原地重启之后能再打一遍** ✓
 * —— 不重打的话，日志里"监听 127.0.0.1"会一直骗着后面看日志的人 ✗。
 */
function logListen() {
  /*
   * **UDP 应答器跟着监听地址原地启停**（2026-10-20，设计 §5.5 之一）：
   * 启动那一刻、以及每次「重启生效」之后都要对一次 ——
   * `sync` 的判据是"开关开 且 真的听着非回环"，所以这里传的是 `SERVER.boundHost`（实际监听）。
   */
  lanAnnounce.sync({ allowLan: netmode.readNetMode().allowLan, explicit: !!process.env.BANDI_HOST, boundHost: SERVER.boundHost, httpPort: port });
  /*
   * 启动就把**数据落在哪儿**打出来。
   * 部署排查时最费时间的一类问题是"我在看的到底是哪个库"——
   * 桌面版（用户目录）和服务器（/var/lib/bandi）的库不是一个，光看界面分不出来。
   */
  console.log(`班底平台：http://${SERVER.boundHost}:${port}`);
  console.log(`工作根：${repoRoot}`);
  console.log(`数据目录：${dataDir}`);
  console.log(`数据库：${dbPath}`);
  /*
   * 只听本机的合法形态有两种，别把它们说成"配错了"：
   *   · 桌面版 / 单机 —— 本来就不该对外；
   *   · 服务器 —— 走 SSH 隧道（不用开端口，也不用这个变量）。
   * 只有"确实要对局域网/公网开"时才需要同时设 BANDI_HOST 与 BANDI_ORIGINS。
   */
  if (SERVER.AUTH.required) {
    console.log(`监听 ${SERVER.boundHost}（非本机）—— 允许的来源：${[...allowedOrigins()].join(' , ')}`);
    /*
     * ⚠️ **令牌不打进日志**（2026-10-16 改）。
     *
     * 原来这里会 `console.log('访问令牌：…')`，理由是"自托管单操作员，打出来才找得到"
     * （像 Jupyter 那个 token URL）。但日志的实际命运是：被贴进聊天、被备份、被同步、被塞进工单 ✗ ——
     * 而那枚令牌是**总机的 master 凭据**（所有节点、所有操作员共用同一枚 ✗）。
     * 贴一次日志 = 交出整套控制权。
     *
     * 现在只说"在哪儿"（数据目录的 token 文件，0600 ✓），需要的人自己去看；
     * 登录页上也写着同一句话 ✓。要换地方就用 BANDI_TOKEN 自己指定、让它别落盘。
     */
    console.log(`访问令牌：在数据目录的 token 文件里（0600，不打印到日志）· 来自 ${SERVER.AUTH.from}${SERVER.AUTH.created ? '，本次新生成' : ''}`);
    console.log('要求令牌：浏览器打开首页填一次（会记进 Cookie），节点/脚本用 X-Bandi-Token 头。');
  } else {
    console.log('只监听回环 —— 免鉴权（桌面版 / 单机的形态）。');
  }
}

/**
 * **原地重启监听**（`POST /api/restart` 打它）。
 *
 * 为什么要这个（2026-10-16 用户问"重启怎么重启？关掉软件吗？能不能做一个重启按钮"）：
 * 监听地址只能在**启动那一刻**定 ✗，所以那个局域网开关一直是"改了要重启才生效" ——
 * 而"重启"对用户意味着关掉软件重开，太笨 ✓。这里改成**只换监听**：
 *   · 进程不退出（pid 不变 → 桌面壳的监管关系不变 ✓、日志重定向也不丢 ✓）；
 *   · 关掉旧监听、丢掉挂着的长轮询（节点会自己重连 ✓），再按最新配置 listen ✓。
 *
 * 配置从 `netmode.json` + `BANDI_HOST` 重新算 —— 跟启动时**同一套优先级** ✓。
 */
function restartListening() {
  /*
   * ⚠️ **已加入 = 节点形态，必须只听回环**（2026-10-20，设计 §4.4）：
   * 节点令牌虽已收窄成 compute，但本机服务里还有导出等本机接口 —— 不该敞给网段。
   * 这里**现读** `localMode.isJoined()`（join/leave 会原地改它，启动时的快照会过期），
   * 与 `config.mjs` 启动时那份是同一套优先级（`BANDI_HOST` 仍最优先）。
   */
  const want = process.env.BANDI_HOST
    ?? (localMode.isJoined()
      ? '127.0.0.1'
      : netmode.readNetMode().allowLan ? '0.0.0.0' : '127.0.0.1');
  if (want === SERVER.boundHost) {
    console.log(`[网络] 重启监听：本来就是 ${SERVER.boundHost}，不用动`);
    /*
     * 这里也要对一次（设计 §5.5 的三处同步点之一）：开关可能刚变过、而监听地址恰好没变
     * （比如 `BANDI_HOST` 显式指定着，或者本来就在回环上）—— 应答器该停就得停。
     */
    lanAnnounce.sync({ allowLan: netmode.readNetMode().allowLan, explicit: !!process.env.BANDI_HOST, boundHost: SERVER.boundHost, httpPort: port });
    return;
  }
  console.log(`[网络] 重启监听：${SERVER.boundHost} → ${want}`);
  server.close(() => {
    SERVER.boundHost = want;
    // 鉴权要跟着新的监听地址重算（"只看监听地址"那条规则）
    Object.assign(SERVER.AUTH, auth.setup({ host: want, dataDir, envToken: process.env.BANDI_TOKEN }));
    /*
     * UDP 应答器同步（三处同步点之二）：**在 listen 之前**把上一份停掉 ——
     * 开关是关的时候就这一下就够（`sync` 见到 on=false 直接 stop，不等 listen 回调）。
     * 开关是开的时候它会重新 bind，`logListen` 里那次是幂等的第二遍。
     */
    lanAnnounce.sync({ allowLan: netmode.readNetMode().allowLan, explicit: !!process.env.BANDI_HOST, boundHost: SERVER.boundHost, httpPort: port });
    server.listen(port, SERVER.boundHost, logListen);
  });
  // 挂着的长轮询（领活那种 20 秒的）别挡着 close 回调 —— 节点收到断开自己会重连 ✓
  server.closeAllConnections?.();
}
