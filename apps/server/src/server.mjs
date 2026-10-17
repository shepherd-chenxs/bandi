import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
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
import * as workflows from './workflows.mjs';
import * as quota from './quota.mjs';
import * as status from './status.mjs';
import { projectTasks, allTasks, createProjectTask, updateProjectTask, startProjectTask } from './project-tasks.mjs';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

/**
 * 供界面用的运行时清单：取自 runtimes 配置层（可在「设置 → 运行时」改）。
 * `blocked` 是这个环境里的实测结论，不再是写死在 server 里的常量。
 */
function runtimeOptions() {
  return runtimes.publicList().map((r) => ({
    id: r.id,
    family: r.family,
    /*
     * 名字里带上"那台机器在不在线"（2026-10-16）：选一个离线节点的运行时，
     * 活**不会立刻跑**，而是排进那台机器的队列里等它回来 —— 这点得在下拉里就看得见，
     * 否则用户会以为点了没反应。
     */
    label: r.remote && r.nodeOnline === false ? `${r.label}（离线）` : r.label,
    sandboxes: r.sandboxes,
    blocked: r.blocked,
    enabled: r.enabled,
  }));
}

/**
 * 给一台设备补上「外部件」（班底之外还要有的东西，现在只有 magpie）。
 *
 * **本机现探**（那台机器就是控制面自己），**节点用自报的**（心跳里带上来的 —— 本机判不了）。
 * `catalog` 是那张说明表：界面靠它把"没装"的东西也画出来（不然一片空白，用户不知道缺什么）。
 */
async function withExternals(dev) {
  if (!dev) return dev;
  // 说明表按**那台机器**的平台算（控制面在 Linux、节点是 Windows 时，命令不是同一条）
  const catalog = externals.publicExternals(dev.platform);
  if (dev.kind === 'node') {
    /*
     * 顺手把**最近那件小事**带上（装运行时 / 装外部件）。
     *
     * 为什么要有这一条（2026-10-16 用户报的"刷新页面，看不到安装进度了"）：
     * 进度原来只活在**浏览器**里（写在点击处理器的轮询里）—— 一刷新就没了，
     * 而那件事其实**还在那台机器上跑着**。按这条架构一贯的原则（**状态在服务端**），
     * 进度也该从服务端读回来：刷新、换台电脑、明天再看，都还是它。
     */
    const [task] = store.listNodeTasks(dev.id, 1);
    return {
      ...dev,
      task: store.publicNodeTask(task),
      externals: { probed: dev.externalsProbed ?? [], catalog },
    };
  }
  return { ...dev, externals: { probed: await externals.declared(), catalog } };
}

/** 这个模型名账本里有没有（空值永远合法＝用 CLI 默认） */
function sendJson(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

/**
 * 出错回应：**带上一个错误编码**。
 *
 * 为什么要有编码：界面上只印「服务异常（编码）」，**不印技术细节** ——
 * 用户看不懂那些话，看到了也只会截图来问；而排查的人拿到编码，
 * 在代码里 `grep E1043` 就能落到唯一那一行，不用猜、也不用翻日志。
 *
 * 编码**写在各调用点上**，不集中登记成一张表：集中登记就得维护一张会跟源码漂移的
 * 对照表（改文案忘改表就废了）；写在调用点上时，grep 直接命中出错的那一行。
 *
 * 分段（按 HTTP 状态码）：
 *   E1xxx 请求本身的问题（400）   E2xxx 找不到（404）
 *   E3xxx 被拒（403）             E4xxx 冲突（409）
 *   E5xxx 服务端出错（500）
 *
 * `extra` 用来带额外的数据字段（比如失败的 taskId），会和 error/code 一起发出去。
 */
function fail(res, status, code, error, extra = null) {
  sendJson(res, status, { error, code, ...(extra ?? {}) });
}

/**
 * 写请求的来源守卫（CSRF）。
 *
 * 为什么需要：浏览器**对非 GET 请求一定会带 Origin**。所以一个跑在沙箱 iframe 里的
 * 插件（opaque origin，`Origin: null`）或者任何别的页面，都能借你的浏览器发请求。
 * 光靠 iframe 的 sandbox 挡不住写操作 —— `fetch` 不设 Content-Type 时是 `text/plain`，
 * 属于"简单请求"不触发预检，而 readBody 只看正文不看 Content-Type，照样会执行。
 *
 * 规则：
 * - 带 Origin（网页发的）→ 必须是本机自己的源，且必须带 X-Bandi 头；
 * - 不带 Origin（curl / node 脚本）→ 放行，命令行调用方本来就不受 CSRF 影响。
 *
 * 这样既堵住网页借刀，又不用给每个命令行调用方都加头。
 */
function guardWrite(req) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return null;
  const origin = req.headers.origin;
  if (!origin) return null;
  if (origin === 'null') return '跨源请求被拒绝（Origin: null）';
  const clean = origin.replace(/\/$/, '');
  if (!allowedOrigins().has(clean)) return `来源不被允许：${origin}`;
  if (req.headers['x-bandi'] !== '1') return '缺少 X-Bandi 请求头';
  return null;
}

function allowedOrigins() {
  // 本机自己（界面就是这个源）+ 部署时另外声明的来源（见 config.extraOrigins）
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...extraOrigins]);
}

/**
 * 请求本身有问题（不是服务器出错）—— 顶层那个 catch 会把它映射成 **400**，其余才是 500。
 *
 * 为什么要有这个区分：原来一律 500，于是 `readBody` 里那句"请求体不是合法 JSON"
 * 被报成"内部服务器错误" —— 明明是调用方发错了，却让人往服务端查。
 */
class BadRequest extends Error {
  constructor(message, code = 'E1044') {
    super(message);
    this.code = code;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new BadRequest('请求体过大', 'E1045'));
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new BadRequest('请求体不是合法 JSON', 'E1044'));
      }
    });
    req.on('error', reject);
  });
}

const routes = {
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
      // 「已归档」入口要靠它决定显不显示；会话明细等真的点进去再拉
      archivedCount: store.countArchived(),
    });
  },

  /** 从列表移除的那些（归档）。只看不删 —— 真删功能还没做 */
  'GET /api/archived': async (req, res) => {
    sendJson(res, 200, { conversations: store.listArchivedConversations() });
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
      fail(res, 400, 'E1001', String(e?.message ?? e));
    }
  },

  'POST /api/personas': async (req, res) => {
    const body = await readBody(req);
    const name = String(body.name ?? '').trim();
    if (!name) return fail(res, 400, 'E1002', '员工需要名字');
    const runtime = runtimeOptions().some((r) => r.id === body.runtime) ? body.runtime : 'codex';
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
    const imported = [];
    const skipped = [];
    for (const d of dirs) {
      try {
        const r = skills.importSkill(d, { overwrite: !!body.overwrite });
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
    sendJson(res, 201, { conversation: store.getConversation(group.id) });
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
async function handleConversation(req, res, url) {
  const detail = /^\/api\/conversations\/([^/]+)$/.exec(url.pathname);
  const send = /^\/api\/conversations\/([^/]+)\/messages$/.exec(url.pathname);
  const hide = /^\/api\/conversations\/([^/]+)\/hide$/.exec(url.pathname);
  const unhide = /^\/api\/conversations\/([^/]+)\/unhide$/.exec(url.pathname);

  // 从消息列表移除：只动列表显示，**不删消息**
  if (req.method === 'POST' && hide) {
    const id = decodeURIComponent(hide[1]);
    if (!store.hideConversation(id)) return fail(res, 404, 'E2001', '会话不存在');
    return sendJson(res, 200, { hidden: true, conversations: store.listConversations() });
  }

  // 从「已归档」里捞回来
  if (req.method === 'POST' && unhide) {
    const id = decodeURIComponent(unhide[1]);
    if (!store.unhideConversation(id)) return fail(res, 404, 'E2002', '会话不存在');
    return sendJson(res, 200, { unhidden: true, conversations: store.listConversations() });
  }

  /**
   * 会话级覆盖：权限 `{ sandbox }` / 模型 `{ model }`。
   * 两者语义相同 —— 有值 = 只在这个会话里覆盖，null / '' = 收回、跟随员工默认。
   * 也可以一次只改一个（只发想改的那个键）。
   */
  if (req.method === 'PUT' && detail) {
    const id = decodeURIComponent(detail[1]);
    const body = await readBody(req);
    const wantsSandbox = 'sandbox' in body;
    const wantsModel = 'model' in body;
    // 这个请求体里两个键都没有 = 没说改什么。但光说"要改什么？"不够 ——
    // 调用方（尤其是版本对不上的前端）看到它才知道**能改的是哪两项**。
    if (!wantsSandbox && !wantsModel) {
      return fail(res, 400, 'E1037', '这次请求没说改哪一项 —— 这个接口只能改「权限」(sandbox) 或「模型」(model)');
    }
    let conversation = store.getConversation(id);
    if (!conversation) return fail(res, 404, 'E2003', '会话不存在');
    if (wantsSandbox) conversation = store.setConversationSandbox(id, body.sandbox ? String(body.sandbox) : null);
    if (wantsModel) conversation = store.setConversationModel(id, body.model ? String(body.model) : null);
    return sendJson(res, 200, { conversation });
  }

  if (req.method === 'GET' && detail) {
    const id = decodeURIComponent(detail[1]);
    const conversation = store.getConversation(id);
    if (!conversation) return fail(res, 404, 'E2004', '会话不存在');
    return sendJson(res, 200, {
      conversation,
      messages: store.listMessages(id),
      runs: store.listRuns(id).map((r) => ({ ...r, usage: r.usage ? JSON.parse(r.usage) : null })),
    });
  }

  if (req.method === 'POST' && send) {
    const id = decodeURIComponent(send[1]);
    const body = await readBody(req);
    const text = String(body.text ?? '').trim();
    if (!text) return fail(res, 400, 'E1010', '说点什么');

    // 校验、派活全在 dispatchToThread 里（工作流引擎也走它）—— 这里只管 HTTP 状态码
    try {
      // body.runId = 在流程卡片上「回复」时带上的：这条消息属于哪条流程。
      // 群里有好几条流程在跑时就靠它归属，不靠猜。
      const { run, member, mentions } = dispatchToThread(id, text, {
        runId: body.runId ?? null,
        taskId: body.taskId ?? null, // 从流程面板发的话：标给那一步
      });
      if (body.runId) workflows.attachRound(String(body.runId), run.id);
      return sendJson(res, 202, {
        runId: run.id,
        personaId: member.personaId,
        personaName: member.name,
        mentions: mentions.map((m) => m.name),
      });
    } catch (e) {
      return sendJson(res, e.code === 'busy' ? 409 : 400, { error: e.message });
    }
  }

  return false;
}

/** 员工详情与配置 */
async function handlePersona(req, res, url) {
  const one = /^\/api\/personas\/([^/]+)$/.exec(url.pathname);
  const open = /^\/api\/personas\/([^/]+)\/open$/.exec(url.pathname);
  const skillsAll = /^\/api\/personas\/([^/]+)\/skills$/.exec(url.pathname);
  const skillOne = /^\/api\/personas\/([^/]+)\/skills\/([^/]+)$/.exec(url.pathname);
  const runtimeSkills = /^\/api\/personas\/([^/]+)\/runtime-skills$/.exec(url.pathname);

  // 删员工：级联清关系数据；是他的群助手就先拦下（换人再删）
  // （one 的正则到行尾为止，所以只可能命中 /api/personas/<id> 这一种路径）
  if (req.method === 'DELETE' && one) {
    const id = decodeURIComponent(one[1]);
    const persona = store.getPersona(id);
    if (!persona) return fail(res, 404, 'E2005', '员工不存在');

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
    return sendJson(res, 200, { ...r, archivedCount: store.countArchived() });
  }

  // 关联技能（多选）
  if (req.method === 'POST' && skillsAll) {
    const id = decodeURIComponent(skillsAll[1]);
    if (!store.getPersona(id)) return fail(res, 404, 'E2006', '员工不存在');
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
    const removed = store.unlinkPersonaSkill(id, name);
    return sendJson(res, 200, { removed: removed > 0, skills: store.listPersonaSkillLinks(id) });
  }

  // 暂停/恢复某个技能（留着分配关系，只是不注入 prompt）
  if (req.method === 'PATCH' && skillOne) {
    const id = decodeURIComponent(skillOne[1]);
    const name = decodeURIComponent(skillOne[2]);
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

  if ((req.method === 'PUT' || req.method === 'PATCH') && one) {
    const id = decodeURIComponent(one[1]);
    const before = store.getPersona(id);
    if (!before) return fail(res, 404, 'E2009', '员工不存在');
    const body = await readBody(req);
    const name = String(body.name ?? '').trim();
    if (!name) return fail(res, 400, 'E1011', '名字不能空');
    const runtime = runtimeOptions().some((r) => r.id === body.runtime) ? body.runtime : undefined;
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

/** 群的加人 / 踢人 / 改名 */
async function handleGroup(req, res, url) {
  const rename = /^\/api\/groups\/([^/]+)$/.exec(url.pathname);
  const members = /^\/api\/groups\/([^/]+)\/members$/.exec(url.pathname);
  const one = /^\/api\/groups\/([^/]+)\/members\/([^/]+)$/.exec(url.pathname);

  if ((req.method === 'PATCH' || req.method === 'PUT') && rename) {
    const id = decodeURIComponent(rename[1]);
    const thread = store.getConversation(id);
    if (!thread || thread.kind !== 'group') return fail(res, 404, 'E2011', '群不存在');

    const body = await readBody(req);
    const title = String(body.title ?? '').trim();
    const nextAssistant = body.assistantPersonaId ? String(body.assistantPersonaId) : '';

    // 同上：把"能改什么"一并说清楚，别只留一句"没说要改什么"
    if (!title && !nextAssistant) {
      return fail(res, 400, 'E1039', '这次请求没说改哪一项 —— 这个接口只能改「群名称」(title) 或「群助手」(assistantPersonaId)');
    }

    if (nextAssistant) {
      if (!store.getPersona(nextAssistant)) return fail(res, 400, 'E1012', '这个数字员工不存在');
      if (!thread.members.some((m) => m.personaId === nextAssistant)) {
        return fail(res, 400, 'E1013', '群助手得先是群里的人');
      }
      store.setAssistantPersona(id, nextAssistant);
    }
    if (title) store.renameConversation(id, title);

    return sendJson(res, 200, { conversation: store.getConversation(id) });
  }

  // 解散群：**不抹聊天记录**，只解除成员关系 + 归档（见 store.dissolveGroup）。
  // 还在跑就先掐掉 —— 别让一个已经解散的群还在后台说话。
  if (req.method === 'DELETE' && rename) {
    const id = decodeURIComponent(rename[1]);
    const thread = store.getConversation(id);
    if (!thread || thread.kind !== 'group') return fail(res, 404, 'E2012', '群不存在');

    const running = store.activeRun(id);
    if (running) runs.getRun(running.id)?.abortController?.abort();

    const conv = store.dissolveGroup(id);
    return sendJson(res, 200, {
      dissolved: true,
      stoppedRunId: running?.id ?? null,
      conversation: conv,
      // 跟 /hide 一样回一份新列表：前端直接换掉，不用再拉一次
      conversations: store.listConversations(),
    });
  }

  if (req.method === 'POST' && members) {
    const id = decodeURIComponent(members[1]);
    const thread = store.getConversation(id);
    if (!thread || thread.kind !== 'group') return fail(res, 404, 'E2013', '群不存在');

    const body = await readBody(req);
    const ids = (Array.isArray(body.personaIds) ? body.personaIds : []).map(String);
    if (!ids.length) return fail(res, 400, 'E1014', '没选人');

    const already = new Set(thread.members.map((m) => m.personaId));
    const added = [];
    const skipped = [];
    for (const pid of ids) {
      if (!store.getPersona(pid)) { skipped.push(pid); continue; }
      if (already.has(pid)) { skipped.push(pid); continue; }
      store.addMember(id, pid);
      added.push(pid);
    }
    return sendJson(res, 200, { added, skipped, conversation: store.getConversation(id) });
  }

  if (req.method === 'DELETE' && one) {
    const id = decodeURIComponent(one[1]);
    const personaId = decodeURIComponent(one[2]);
    const thread = store.getConversation(id);
    if (!thread || thread.kind !== 'group') return fail(res, 404, 'E2014', '群不存在');

    // 群助手不能被移出：移了「没 @ 就找群助手」这条规则就断了
    if (personaId === thread.assistantPersonaId) {
      return fail(res, 400, 'E1015', '群助手不能被移出群。先把群助手换成别人，再移出他。');
    }
    if (!thread.members.some((m) => m.personaId === personaId)) {
      return fail(res, 404, 'E2015', '他不在这个群里');
    }

    store.removeMember(id, personaId);
    return sendJson(res, 200, { removed: personaId, conversation: store.getConversation(id) });
  }

  return false;
}

/** 单个 skill 的读/改/删 */
async function handleSkill(req, res, url) {
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
    return sendJson(res, 200, { skill: s, personas: store.listPersonas().filter((p) => store.listPersonaSkills(p.id).includes(name)).map((p) => ({ id: p.id, name: p.name })) });
  }

  if (req.method === 'PUT' || req.method === 'PATCH') {
    if (!skills.getSkill(name)) return fail(res, 404, 'E2018', '没有这个 skill');
    const body = await readBody(req);
    try {
      return sendJson(res, 200, { skill: skills.writeSkill(name, { description: body.description, body: body.body }) });
    } catch (e) {
      return fail(res, 400, 'E1017', String(e?.message ?? e));
    }
  }

  if (req.method === 'DELETE') {
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
async function handleConnector(req, res, url) {
  const one = /^\/api\/connectors\/([^/]+)$/.exec(url.pathname);
  const probeOne = /^\/api\/connectors\/([^/]+)\/probe$/.exec(url.pathname);

  if (req.method === 'GET' && url.pathname === '/api/connectors/catalog') {
    const installed = new Set(connectors.list().map((e) => e.id));
    return sendJson(res, 200, {
      error: catalog.catalogError(),
      catalog: catalog.listCatalog().map((c) => ({
        ...c,
        installed: installed.has(c.id),
        // 清单里点名要的凭据，环境里有没有 —— 界面据此提示，别让人装完才发现跑不起来
        requires: c.requires.map((key) => ({ key, present: process.env[key] !== undefined })),
      })),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/connectors') {
    const body = await readBody(req);

    // ① 从推荐清单装：清单条目就是一份模板
    if (body.from) {
      const c = catalog.getCatalog(String(body.from));
      if (!c) return fail(res, 404, 'E2019', '推荐清单里没有这一条');
      const r = connectors.saveEntry(c.id, {
        label: c.label,
        source: c.source,
        transport: c.transport,
        command: c.command,
        args: c.args,
        cwd: c.cwd,
        url: c.url,
        env: c.env,
        note: c.note,
        enabled: true,
      });
      if (r.error) return fail(res, 400, 'E1040', r.error, r);
      return sendJson(res, 201, { ...r, needs: c.requires, note: c.note });
    }

    // ② 手工装 / 改一条
    const id = String(body.id ?? '').trim();
    const r = connectors.saveEntry(id, body);
    return r.error ? fail(res, 400, 'E1041', r.error, r) : sendJson(res, 201, r);
  }

  if (req.method === 'POST' && probeOne) {
    const id = decodeURIComponent(probeOne[1]);
    return sendJson(res, 200, await connectors.probe(id));
  }

  if ((req.method === 'PUT' || req.method === 'PATCH') && one) {
    const id = decodeURIComponent(one[1]);
    if (!connectors.get(id)) return fail(res, 404, 'E2020', '没有这条连接器');
    const r = connectors.saveEntry(id, await readBody(req));
    return r.error ? fail(res, 400, 'E1042', r.error, r) : sendJson(res, 200, r);
  }

  if (req.method === 'DELETE' && one) {
    return sendJson(res, 200, { ...connectors.removeEntry(decodeURIComponent(one[1])) });
  }

  return false;
}


/* ------------------------------------------------------------------ 执行节点 */

/*
 * 「节点 → 设备」的映射**只有一份**，在 `runtimes.mjs`（`nodeAsDevice` / `publicNodes`）。
 * 这里以前也写过一份 —— 于是同一个节点在设备列表里出现两次、两份逻辑还会各自漂。
 * 2026-10-15 收掉了：节点长什么样，只在那一处定义。
 */

/** 节点接口：报到 / 心跳 / 清单 */
async function handleNode(req, res, url) {
  const register = /^\/api\/nodes\/register$/.exec(url.pathname);
  const heartbeat = /^\/api\/nodes\/([^/]+)\/heartbeat$/.exec(url.pathname);
  const list = /^\/api\/nodes$/.exec(url.pathname);
  const one = /^\/api\/nodes\/([^/]+)$/.exec(url.pathname);

  if (req.method === 'GET' && list) {
    return sendJson(res, 200, {
      heartbeatSeconds: runtimes.NODE_HEARTBEAT_SEC,
      offlineAfterSeconds: runtimes.NODE_OFFLINE_AFTER_MS / 1000,
      nodes: runtimes.publicNodes(),
    });
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
const CLAIM_POLL_MS = 250;
const CLAIM_MAX_WAIT_MS = 45000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 领活三件事：**领**（长轮询）/ **回传事件** / **报回执**。
 *
 * 为什么不是"控制面推给节点"：出站连接是多机方案里唯一不用开端口、不用打洞的形态，
 * 而"推"要求能连到节点。所以反过来 —— 节点挂着等（长轮询），有活立刻拿到。
 *
 * 事件批次的**响应里带回 `stop`**：这是反向的控制通道。人点了停止，不需要另开一条连接，
 * 下一个批次就把话带到，节点自己掐子进程。
 */
async function handleNodeWork(req, res, url) {
  const claim = /^\/api\/nodes\/([^/]+)\/claim$/.exec(url.pathname);
  const events = /^\/api\/runs\/([^/]+)\/events$/.exec(url.pathname);
  const done = /^\/api\/runs\/([^/]+)\/finish$/.exec(url.pathname);
  const tasks = /^\/api\/nodes\/([^/]+)\/tasks$/.exec(url.pathname);
  const oneTask = /^\/api\/nodes\/([^/]+)\/tasks\/([^/]+)$/.exec(url.pathname);
  const taskReport = /^\/api\/nodes\/([^/]+)\/tasks\/([^/]+)\/report$/.exec(url.pathname);

  /*
   * 一键安装 —— 排一个「让那台机器做件小事」。
   *
   * ⚠️ 只接受**族名**：命令表在节点那侧（`runtimes.installCommandFor`），控制面发不出命令。
   * 谁拿着令牌就能在每台节点上装软件，所以这条边界是这件事成立的前提，不是"顺手的设计"。
   */
  if (req.method === 'POST' && tasks) {
    const nodeId = decodeURIComponent(tasks[1]);
    if (!store.getNode(nodeId)) return fail(res, 404, 'E2041', '这个节点没登记过');
    const body = await readBody(req);
    const kind = String(body?.kind ?? '');
    const target = String(body?.family ?? body?.id ?? '');

    /*
     * 两种"小事"，共用一套队列：装一个**运行时**（agent CLI），或处理一个**外部件**的某一步
     * （装上 / 装成常驻服务）。命令表都在**节点那侧**，控制面只发 id 与步骤。
     */
    let spec = null;
    if (kind === 'install-runtime') {
      spec = runtimes.installCommandFor(target);
      if (!spec) {
        return fail(res, 400, 'E1044', `「${target || '(没给族名)'}」没法一键安装 —— 它要么不是这三个族之一，要么形态上就不是 npm 装的（比如 dsh 是 Windows 桌面端自带的）。去那台机器上手工装。`);
      }
    } else if (kind === 'external-install' || kind === 'external-serve') {
      const step = kind === 'external-install' ? 'install' : 'serve';
      /*
       * 走镜像装：`mirror` 是个**参数**，不是命令 —— 它会先过 externals.mirrorOk()
       * （它要被拼进 `sh -c '… --mirror "<前缀>"'`，所以带 shell 元字符的一律拒）。
       * 不能过就直接 400，别让它跑到那台机器上再失败。
       */
      const mirror = String(body?.mirror ?? '').trim();
      if (mirror && !externals.mirrorOk(mirror)) {
        return fail(res, 400, 'E1046', '镜像前缀里不能有空格、引号、反引号、$、;、|、& 这些字符（它会被拼进 shell 命令）—— 给一个普通的 https:// 前缀');
      }
      // 按**那台节点**的平台判（控制面在 Linux，节点可能是 Windows）
      spec = externals.commandFor(step, target, store.getNode(nodeId)?.platform, { mirror });
      if (!spec) {
        return fail(res, 400, 'E1045', `「${target}」的这一步在**那台机器**上没法一键做（比如 Windows 上 magpie 是桌面安装包，没有一条命令）。去那台机器上手工装。`);
      }
      const task = store.enqueueNodeTask({ nodeId, kind, family: target, arg: mirror || null });
      console.log(`[节点] 给 ${nodeId} 排了个任务：${kind} ${target}${mirror ? `（走镜像 ${mirror}）` : ''}`);
      return sendJson(res, 201, { task: store.publicNodeTask(task), willRun: spec.cmd });
    } else {
      return fail(res, 400, 'E1043', '只认这三种小事：install-runtime / external-install / external-serve');
    }

    const task = store.enqueueNodeTask({ nodeId, kind, family: target });
    console.log(`[节点] 给 ${nodeId} 排了个任务：${kind} ${target}`);
    return sendJson(res, 201, { task: store.publicNodeTask(task), willRun: spec.cmd });
  }

  // 界面轮询"装到哪一步了"
  if (req.method === 'GET' && oneTask) {
    const t = store.getNodeTask(decodeURIComponent(oneTask[2]));
    if (!t || t.nodeId !== decodeURIComponent(oneTask[1])) return fail(res, 404, 'E2043', '没有这个任务');
    return sendJson(res, 200, { task: store.publicNodeTask(t) });
  }

  // 节点回执：边跑边报输出，跑完报终态
  if (req.method === 'POST' && taskReport) {
    const t = store.getNodeTask(decodeURIComponent(taskReport[2]));
    if (!t || t.nodeId !== decodeURIComponent(taskReport[1])) return fail(res, 404, 'E2043', '没有这个任务');
    const body = await readBody(req);
    if (body?.output) store.appendNodeTaskOutput(t.id, body.output);
    if (body?.status === '完成' || body?.status === '失败') {
      store.finishNodeTask(t.id, body.status);
      console.log(`[节点] ${t.nodeId} 的安装任务${body.status === '完成' ? '装好了' : '失败了'}：${t.family}`);
    }
    return sendJson(res, 200, { task: store.publicNodeTask(store.getNodeTask(t.id)) });
  }

  /**
   * 发一个**一次性邀请码**（10 分钟、只用一次）—— 新机器凭它加入。
   *
   * 只有操作员能用：节点令牌的权限边界里没有这条（见 auth.nodeMayReach）✓。
   */
  if (req.method === 'POST' && url.pathname === '/api/nodes/invites') {
    const inv = store.createInvite();
    console.log('[节点] 发了一个邀请码（10 分钟内有效，只用一次）');
    return sendJson(res, 201, inv);
  }

  /**
   * **加入**：一台新机器凭邀请码换回**只属于它自己**的那枚令牌。
   *
   * 为什么要有这一步（2026-10-16）：原来节点直接用总机那枚 master 令牌 ✗ ——
   * 一台被翻等于整套被翻，而且「忘掉」踢不掉它。现在换成"一次性码 → 每节点一枚"：
   * 权限只到它自己那台的节点接口 ✓，可逐台吊销 ✓。
   *
   * 这条**不需要令牌**（新机器还没有），凭据就是邀请码本身 ✓；用了就作废 ✓。
   */
  if (req.method === 'POST' && url.pathname === '/api/nodes/join') {
    const body = await readBody(req);
    const code = String(body?.code ?? '').trim();
    const id = String(body?.id ?? '').trim();
    if (!id) return fail(res, 400, 'E1047', '加入要带上你自己的 id');
    if (!store.consumeInvite(code, id)) {
      return fail(res, 401, 'E4011', '邀请码不对、已经用过、或者过期了 —— 让控制面上重新生成一个（10 分钟有效、只用一次）');
    }
    const label = String(body.label ?? id).trim() || id;
    store.upsertNode({
      id,
      label,
      hostname: String(body.hostname ?? label).trim() || label,
      platform: body.platform ? String(body.platform) : null,
      runtimes: Array.isArray(body.runtimes) ? body.runtimes : [],
      externals: Array.isArray(body.externals) ? body.externals : null,
    });
    const token = store.issueNodeToken(id);
    console.log(`[节点] ${label} 用邀请码加入了（${id}）—— 给了它自己一枚令牌`);
    return sendJson(res, 201, {
      token,
      node: runtimes.publicDeviceById(id),
      heartbeatSeconds: runtimes.NODE_HEARTBEAT_SEC,
    });
  }

  if (req.method === 'POST' && claim) {
    const nodeId = decodeURIComponent(claim[1]);
    if (!store.getNode(nodeId)) return fail(res, 404, 'E2041', '这个节点没登记过，先调 /api/nodes/register');
    const body = await readBody(req);
    const waitMs = Math.min(Math.max(Number(body?.waitMs ?? 0) || 0, 0), CLAIM_MAX_WAIT_MS);
    const until = Date.now() + waitMs;

    /*
     * ⚠️ **要盯着请求方还在不在**。长轮询的请求可能在等待期间就断了（节点被杀、
     * 网线拔了、壳崩了）—— 那时如果把活"领"走，它就落在空气里：节点那边没人跑、
     * 队列里也看不见、界面上永远"跑中"（2026-10-15 实测踩到：活被一个已经死掉的
     * 节点领走，86ms 之内）。
     *
     * 判据是 **`res.destroyed`**（以及它底下那个 socket），实测：
     *   · 健康的领活请求 → false；
     *   · 客户端已经死了的那条 → true。
     * ⚠️ **别用 req.destroyed**：请求体读完（readBody）之后它**恒为 true**，
     * 拿它当判据会把正常领活也全拒掉（这一步真的踩了两遍）。
     * `'close'` 在这里也**不触发**，所以 close/aborted 只当双保险留着。
     */
    let closed = false;
    req.on('close', () => {
      closed = true;
    });
    req.on('aborted', () => {
      closed = true;
    });
    const gone = () => closed || res.destroyed || !!res.socket?.destroyed;

    let job = store.claimNodeJob(nodeId);
    while (!job && !gone() && Date.now() < until) {
      /*
       * 等待期间也盯着"让这台机器做件小事"（一键安装）—— 不看的话，它得等这次长轮询
       * 整整超时（20 秒）才轮到，界面上就是"点了没反应"。
       */
      const task = store.claimNodeTask(nodeId);
      if (task) return gone() ? undefined : sendJson(res, 200, { task: store.publicNodeTask(task) });
      await sleep(CLAIM_POLL_MS);
      job = store.claimNodeJob(nodeId);
    }
    if (!job) {
      // 长轮询收工前再看一次任务，别让它白等一轮
      const task = store.claimNodeTask(nodeId);
      if (task && !gone()) return sendJson(res, 200, { task: store.publicNodeTask(task) });
      return gone() ? undefined : sendJson(res, 200, { job: null });
    }

    // 领到的那一刻请求方已经没了 → **放回队列**，别让这次活凭空消失
    if (gone()) {
      store.releaseNodeJob(job.id);
      console.log(`[节点] ${nodeId} 领活途中连接断了 —— 把活放回队列`);
      return undefined;
    }

    console.log(`[节点] ${nodeId} 领到活（${job.family}）· 队列里还剩 ${store.countNodeJobs(nodeId)}`);
    return sendJson(res, 200, {
      job: {
        id: job.id,
        runId: job.runId,
        family: job.family,
        model: job.model,
        sandbox: job.sandbox,
        cwd: job.cwd,
        task: job.task,
        sessionId: job.sessionId,
      },
    });
  }

  if (req.method === 'POST' && events) {
    const runId = decodeURIComponent(events[1]);
    const body = await readBody(req);
    const list = Array.isArray(body?.events) ? body.events : [];
    // 这个活还有动静（**空批次也算** —— 那是节点在"一声不吭"时唯一的心跳，见下）
    const job = store.getNodeJobByRun(runId);
    if (job) store.touchNodeJob(job.id);
    let stop = false;
    for (const evt of list) {
      const r = runs.ingestEvent(runId, evt);
      if (!r.ok) return fail(res, 404, 'E2042', r.error);
      if (r.stop) stop = true;
    }
    /*
     * **空批次也要回 stop**：节点每 2 秒发一个空批次，那是它在一声不吭时唯一能收到
     * "人点了停止"的通道（模型在想的时候可能几分钟不吐一个字）。
     * 只看 `list` 里的结果，这个通道就等于不存在。
     */
    if (!list.length) {
      const run = runs.getRun(runId);
      if (!run) return fail(res, 404, 'E2042', '这次运行不在内存里（服务重启过？）');
      stop = !!(run.stoppedByUser || run.finished);
    }
    return sendJson(res, 200, { ok: true, stop });
  }

  if (req.method === 'POST' && done) {
    const runId = decodeURIComponent(done[1]);
    const body = await readBody(req);
    const job = store.getNodeJobByRun(runId);
    if (job) store.finishNodeJob(job.id);
    const ok = runs.finishRemote(runId, {
      status: String(body?.status ?? '失败'),
      exitCode: body?.exitCode ?? null,
      error: body?.error ?? null,
      usage: body?.usage ?? null,
      sessionId: body?.sessionId ?? null,
      finalText: String(body?.finalText ?? ''),
    });
    return ok ? sendJson(res, 200, { ok: true }) : fail(res, 404, 'E2043', '这次运行不在内存里（服务重启过？）');
  }

  return false;
}

/** 运行时管理：设备 → CLI → 详情 */
async function handleRuntime(req, res, url) {
  const devices = /^\/api\/devices$/.exec(url.pathname);
  const oneDevice = /^\/api\/devices\/([^/]+)$/.exec(url.pathname);
  const renameDevice = /^\/api\/devices\/([^/]+)\/rename$/.exec(url.pathname);
  const addOne = /^\/api\/devices\/([^/]+)\/runtimes$/.exec(url.pathname);
  const oneRuntime = /^\/api\/devices\/([^/]+)\/runtimes\/([^/]+)$/.exec(url.pathname);
  const probeOne = /^\/api\/devices\/([^/]+)\/runtimes\/([^/]+)\/probe$/.exec(url.pathname);
  const modelsOne = /^\/api\/runtimes\/([^/]+)\/models$/.exec(url.pathname);

  /** 这个运行时能用哪些模型 —— 每个族各找各的源头；查不到就如实说（见 cli-models.mjs） */
  if (req.method === 'GET' && modelsOne) {
    const rt = runtimes.resolveForRun(decodeURIComponent(modelsOne[1]));
    if (!rt) return fail(res, 404, 'E2021', '没有这个运行时');
    return sendJson(res, 200, await cliModels.forRuntime(rt));
  }

  /** 可添加的协议族（「添加运行时」里那三个选项） */
  if (req.method === 'GET' && url.pathname === '/api/runtime-families') {
    return sendJson(res, 200, { families: runtimes.publicFamilies() });
  }

  /**
   * 检测一个**还没建**的路径行不行（跑一次 `--version`）。
   *
   * 用在「安装」弹窗里：用户手填了一个安装目录 / 可执行文件，点「检测」先看看能不能跑，
   * 再决定接不接入。现有的 `/runtimes/:rid/probe` 只针对**已经存在**的运行时，
   * 所以这里单开一个。
   *
   * 会先过一遍 `resolveCliPath` —— 用户填目录时把它解析成里面的可执行文件，
   * 并把解析结果回给前端（让人看见实际用的是哪个文件）。
   */
  if (req.method === 'POST' && url.pathname === '/api/runtimes/test') {
    const body = await readBody(req);
    if (!runtimes.FAMILIES[body.family]) {
      return fail(res, 400, 'E1018', `不支持这个协议族：${body.family}`);
    }
    const given = String(body.path ?? '').trim();
    if (!given) return fail(res, 400, 'E1019', '先填一个安装目录或可执行文件路径');
    const resolved = runtimes.resolveCliPath(body.family, given);
    const r = await runtimes.probePath(body.family, resolved);
    return sendJson(res, 200, {
      ok: !!r.ok,
      version: r.version ?? null,
      error: r.error ?? null,
      path: resolved,
    });
  }

  /**
   * 探测这台机器上装了哪些 agent CLI，顺带跑一次 `--version` 拿版本号。
   *
   * **靠按钮点，不做定时扫描** —— 这是"我换机器了 / 我刚装了个 CLI"才需要的事。
   * 找路径是纯本地 stat（几毫秒）；版本号要 spawn 进程（每族约 0.2 秒），
   * 所以只探**第一个能用的候选**，不是把每个候选都跑一遍。
   */
  if (req.method === 'GET' && url.pathname === '/api/runtimes/detect') {
    const families = runtimes.detectAll();
    await Promise.all(
      families.map(async (f) => {
        const first = f.candidates.find((c) => c.usable);
        if (!first) return;
        const r = await runtimes.probePath(f.id, first.path);
        f.version = r.ok ? r.version ?? null : null;
        f.versionError = r.ok ? null : r.error ?? null;
      }),
    );
    return sendJson(res, 200, { families });
  }

  /**
   * **原地重启监听** —— 界面上那颗「重启生效」打的（2026-10-16 加的）。
   *
   * 为什么要有（用户问"重启怎么重启？关掉软件吗？"）：监听地址只能在启动那一刻定 ✗，
   * 于是那个开关一直挂着"改了要重启才生效" —— 而"重启"对用户就是关掉软件重开，太笨 ✗。
   *
   * ⚠️ 两件事必须做对：
   *   ① **先回响应**再动监听 —— 反过来的话，浏览器拿不到答复，只看到连接被断 ✗；
   *   ② 开关打开后**鉴权会生效**（"只看监听地址"那条规则 ✓）→ 必须顺手把令牌
   *      **塞进 Cookie** ✓，否则用户自己这个窗口下一次请求就被 401 挡在登录页外面 ✗
   *      （它会以为"点了重启就坏了"）。
   */
  if (req.method === 'POST' && url.pathname === '/api/restart') {
    const nextHost = process.env.BANDI_HOST ?? (netmode.readNetMode().allowLan ? '0.0.0.0' : '127.0.0.1');
    const willRequire = !netmode.isLoopback(nextHost);
    if (willRequire) {
      /*
       * ⚠️ **先按"目标"监听地址算一次鉴权**，再把令牌塞进 Cookie。
       *
       * 为什么不能等 `restartListening` 里去算（第一版就是那样，测试抓出来了）：回环形态下
       * `auth.setup` **连令牌文件都不生成**（单机零安全痕迹 ✓）→ 这里的 `AUTH.token` 是空字符串 ✗
       * → Cookie 根本设不出来 → 用户点完「重启生效」，自己那个窗口立刻撞上登录页 ✗
       * （他会以为"点了重启就坏了"）。先算这一次，令牌就造出来了 ✓。
       */
      Object.assign(AUTH, auth.setup({ host: nextHost, dataDir, envToken: process.env.BANDI_TOKEN }));
      if (AUTH.token) res.setHeader('Set-Cookie', auth.cookieValue(AUTH.token));
    }
    sendJson(res, 200, { ok: true, from: boundHost, to: nextHost, requiresToken: willRequire });
    setTimeout(restartListening, 80); // 让这个响应先发出去
    return;
  }

  /**
   * 桌面版那个开关：**要不要让局域网里的机器作为节点加入这台机器**（2026-10-16 加的）。
   *
   * 改动**要重启才生效** —— 监听地址只能在进程启动那一刻定 ✗，所以返回值里带 `restartNeeded`，
   * 界面据此说"重启后生效"，而不是骗用户"已经开了"。
   * 真值存在数据目录的 `netmode.json` 里，`config.mjs` 读它 → **桌面壳 / 开机自启 / 命令行三种起法都认** ✓。
   */
  if (url.pathname === '/api/lan') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      netmode.writeNetMode(body?.allowLan === true);
      console.log(`[网络] 局域网加入：${body?.allowLan === true ? '开' : '关'}（重启后生效）`);
    }
    const want = netmode.readNetMode().allowLan;
    const boundLan = !netmode.isLoopback(boundHost); // 这个进程**现在实际**听的是什么（原地重启后会变）
    /*
     * ⚠️ 监听地址是**环境变量显式指定**的时候，这个开关**管不着**（env 优先 ✓）——
     * 云端那台就是这么起的（`BANDI_HOST=0.0.0.0`），而它**本来就必须**对外听（节点在公网 ✓）。
     * 所以这里如实回报 `explicit`，让界面把开关禁掉、并**按实际监听**说状态 ✓：
     * 第一版没这条，于是云端那一页显示"关着 —— 只听本机"，而它其实对外开着 ✗（界面上说谎）。
     */
    const explicit = !!process.env.BANDI_HOST;
    return sendJson(res, 200, {
      allowLan: want,
      explicit,
      host: boundHost, // **实际**听着的（原地重启后会变）—— 别报启动时那个，那会骗人 ✗
      boundLan,
      restartNeeded: explicit ? false : want !== boundLan,
      port,
      // 摆给用户看"让别的机器连这个地址"（也是加入命令里该用的地址）
      urls: netmode.lanUrls(port),
    });
  }

  if (req.method === 'GET' && devices) {
    // 本机 + 已报到的节点。**两边是同一份映射**（都在 runtimes.mjs 里），别再各自拼一份
    return sendJson(res, 200, { devices: await Promise.all(runtimes.publicDevices().map(withExternals)) });
  }

  if (req.method === 'GET' && oneDevice) {
    const d = runtimes.publicDeviceById(decodeURIComponent(oneDevice[1]));
    return d ? sendJson(res, 200, { device: await withExternals(d) }) : fail(res, 404, 'E2037', '没有这台设备');
  }

  /**
   * 给一台机器起名（「重命名机器」）。
   *
   * 改的是**机器名**，不动**主机名** —— 主机名是那台机器自报的事实，改不了也不该改。
   * 本机那份存在 `runtimes.json`，节点那份存在控制面；两边都传空字符串就恢复默认（回主机名）。
   * body：`{ label }`。
   */
  if (req.method === 'POST' && renameDevice) {
    const did = decodeURIComponent(renameDevice[1]);
    const body = await readBody(req);
    const d = runtimes.renameDevice(did, body?.label ?? '');
    if (!d) return fail(res, 404, 'E2037', '没有这台设备');
    console.log(`[设备] 改名：${d.label}${d.renamed ? '' : '（恢复主机名）'}`);
    return sendJson(res, 200, { device: d });
  }

  /**
   * 节点设备上的运行时**不能从控制面改** —— 它们在**那台机器**上（`runtimes.json` / 它的设置页）。
   *
   * 注意这跟"能不能派活给它"是两件事：**现在能派**（绑到 `node-xxx:族` 上就行，
   * 见 smoke-node-jobs.mjs）。这里拦的是"编辑"，不拦"使用"。
   * 不拦的话，界面上那几颗开关会打到一个不存在的本机运行时上，报错还看不出为什么。
   */
  const rejectIfNode = (did) => {
    if (!store.getNode(did)) return false;
    fail(
      res,
      400,
      'E1041',
      '这是远程节点：它的运行时在**那台机器**上（runtimes.json / 它的设置页），控制面这头只读。' +
        '要派活给它，是把它绑成员工的 runtime（node-xxx:族），不是在这儿改。',
    );
    return true;
  };

  // 加一个运行时实例
  if (req.method === 'POST' && addOne) {
    const did = decodeURIComponent(addOne[1]);
    if (rejectIfNode(did)) return true;
    const body = await readBody(req);
    const r = runtimes.addRuntime(did, body);
    if (r.error) return fail(res, 400, 'E1020', r.error);
    return sendJson(res, 201, { runtime: r.runtime, device: runtimes.publicDeviceById(did) });
  }

  if ((req.method === 'PUT' || req.method === 'PATCH') && oneRuntime) {
    const did = decodeURIComponent(oneRuntime[1]);
    if (rejectIfNode(did)) return true;
    const rid = decodeURIComponent(oneRuntime[2]);
    const body = await readBody(req);
    const next = runtimes.saveRuntime(did, rid, body);
    // 三种结果要分得开：没这个运行时（404）/ 给的值不合法（400）/ 改好了（200）
    if (!next) return fail(res, 404, 'E2022', '没有这个运行时');
    if (next.error) return fail(res, 400, 'E1021', next.error);
    return sendJson(res, 200, { runtime: next, device: runtimes.publicDeviceById(did) });
  }

  if (req.method === 'DELETE' && oneRuntime) {
    const did = decodeURIComponent(oneRuntime[1]);
    if (rejectIfNode(did)) return true;
    const rid = decodeURIComponent(oneRuntime[2]);
    const r = runtimes.removeRuntime(did, rid);
    if (r.error) return fail(res, 400, 'E1022', r.error);
    return sendJson(res, 200, { removed: true, device: runtimes.publicDeviceById(did) });
  }

  if (req.method === 'POST' && probeOne) {
    const r = await runtimes.probe(decodeURIComponent(probeOne[1]), decodeURIComponent(probeOne[2]));
    return sendJson(res, 200, r);
  }

  return false;
}

/** 插件市场：装 / 卸 / 启停 */
async function handlePluginAction(req, res, url) {
  const act = /^\/api\/plugins\/([^/]+)\/(install|enable|disable)$/.exec(url.pathname);

  if (req.method === 'POST' && act) {
    const id = decodeURIComponent(act[1]);
    const what = act[2];
    const r =
      what === 'install' ? plugins.install(id) : plugins.setEnabled(id, what === 'enable');
    if (r.error) return fail(res, 400, 'E1023', r.error);
    return sendJson(res, 200, { ok: true, plugins: plugins.marketList() });
  }

  // 卸载：**真删目录**（和连接器的"卸载＝删条目"对齐语义，但这里删的是文件）
  const one = /^\/api\/plugins\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'DELETE' && one) {
    const r = plugins.uninstall(decodeURIComponent(one[1]));
    if (r.error) return fail(res, 400, 'E1024', r.error);
    return sendJson(res, 200, { ok: true, removed: r.path, plugins: plugins.marketList() });
  }

  return false;
}

/** 工作流：模板 → 实例 → 逐步执行 */
/**
 * 项目：**"在哪儿干活"的载体**（名字 / 主目录 / 附加根 / 项目规矩）。
 *
 * 现在只有"名字 + 目录 + 附加根 + 说明"这几件事 —— 还没跟会话/流程挂钩，
 * 那一步（让派活真的用项目目录）单独做。
 */
async function handleProject(req, res, url) {
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
    try {
      const task = createProjectTask(p, {
        title: body.title,
        description: body.description,
        status: body.status,
        personaId: body.personaId ?? null,
        startNow: body.startNow === true,
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
  if (req.method === 'PATCH' && taskOne) {
    const id = decodeURIComponent(taskOne[1]);
    const body = await readBody(req);
    try {
      const task = updateProjectTask(id, body);
      if (body.startNow === true) {
        try {
          return sendJson(res, 200, { task: startProjectTask(id), started: true });
        } catch (e) {
          // 卡改好了、但没派出去：把原因说清楚，别让人以为存都没存
          return fail(res, 400, 'E1048', `存了，但没派出去：${e.message}`, { taskId: id, task });
        }
      }
      return sendJson(res, 200, { task });
    } catch (e) {
      const missing = /不存在/.test(String(e.message));
      return sendJson(res, missing ? 404 : 400, { error: String(e.message ?? e) });
    }
  }
  if (req.method === 'DELETE' && taskOne) {
    const ok = store.deleteProjectTask(decodeURIComponent(taskOne[1]));
    return ok ? sendJson(res, 200, { ok: true }) : fail(res, 404, 'E2038', '任务不存在');
  }

  /*
   * **仓库值班写卡**（2026-10-17）：巡检（本机脚本；以后也可以是 Actions）把"要人管的事"
   * 写进看板。为什么单开一条、不直接复用上面那个建卡接口：
   *
   *   ① **去重** —— 同一个 PR 巡检十次只该有一张卡（按 `projectId + externalKey` 找）；
   *   ② **保护人的指令** —— 重复巡检只更新标题与描述，**状态一律不动**。卡的状态是人给的指令：
   *      拖到「已完成」＝ 批准，删掉 ＝ 忽略。重跑一次把它弹回「待办」，是最招人烦的那种 bug。
   *
   * body：{ key, title, body }（key 必填，如 `pr:3` / `issue:2` / `note:branch-protection`）
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
    const existing = store.getProjectTaskByExternalKey(p.id, key);
    if (existing) {
      const changed = existing.title !== title || existing.description !== description;
      return sendJson(res, 200, {
        task: changed ? store.updateProjectTask(existing.id, { title, description }) : existing,
        created: false,
        changed,
      });
    }
    const task = store.createProjectTask({
      projectId: p.id,
      title,
      description,
      status: '待办',
      source: 'repo',
      externalKey: key,
    });
    return sendJson(res, 201, { task, created: true, changed: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/projects') {
    const body = await readBody(req);
    const name = String(body.name ?? '').trim();
    const root = String(body.root ?? '').trim();
    if (!name) return fail(res, 400, 'E1025', '给项目起个名字');
    if (!root) return fail(res, 400, 'E1026', '项目目录不能空 —— AI 要在这儿干活');
    return sendJson(res, 201, { project: store.createProject({
      name, root, extraRoots: body.extraRoots ?? [], note: body.note ?? null,
    }) });
  }

  if (req.method === 'PUT' && detail) {
    const id = decodeURIComponent(detail[1]);
    const body = await readBody(req);
    const p = store.updateProject(id, {
      name: body.name === undefined ? undefined : String(body.name).trim(),
      root: body.root === undefined ? undefined : String(body.root).trim(),
      extraRoots: body.extraRoots,
      note: body.note,
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
async function handleStatus(req, res, url) {
  if (req.method !== 'GET') return false;
  const one = /^\/api\/status\/projects\/([^/]+)$/.exec(url.pathname);
  if (!one) return false;

  const p = store.getProject(decodeURIComponent(one[1]));
  if (!p) return fail(res, 404, 'E2027', '项目不存在');
  return sendJson(res, 200, status.projectDetail(p));
}

/**
 * 列子目录，给"选目录"用。
 *
 * 浏览器出于安全**不给绝对路径**（`webkitdirectory` 只给假路径），
 * 所以目录选择只能走服务端：这里只做**只读列目录**，不读文件内容、不写任何东西。
 */
async function handleFs(req, res, url) {
  if (req.method !== 'GET' || url.pathname !== '/api/fs/dirs') return false;
  const want = String(url.searchParams.get('path') ?? '').trim();
  const dir = want ? path.resolve(want) : os.homedir();
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return fail(res, 400, 'E1028', `读不了这个目录：${e.message}`);
  }
  const dirs = entries
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => ({ name: d.name, path: path.join(dir, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(dir);
  return sendJson(res, 200, { path: dir, parent: parent === dir ? null : parent, dirs });
}

/**
 * 弹**本机原生的目录选择框**，返回绝对路径。
 *
 * 为什么不能在前端做：界面在浏览器里，浏览器禁止读绝对路径
 * （`<input webkitdirectory>` 只给假路径）。但服务端就在本机，
 * 所以由它调系统对话框 —— 这才是 DSH 那种"新建项目时选目录"的体验。
 *
 * 纯只读：只是让用户选一个目录，不读内容、不写任何东西。
 * 没有桌面（服务跑在无 UI 环境）时返回 500，前端会退回页内浏览。
 */
async function handlePickDir(req, res) {
  if (req.method !== 'POST' || req.url !== '/api/fs/pick-dir') return false;
  if (process.platform !== 'win32') {
    return fail(res, 500, 'E5001', '这个系统上还没做原生选择框，用页内浏览吧');
  }
  // ⚠️ 这段**只能用 ASCII**：中文经 powershell.exe 传参会被编码搞坏，
  // 直接报 "string is missing the terminator"（实测踩到）。文案留给前端显示。
  // 用 Shell.Application 的 BrowseForFolder：不必加载 WinForms 程序集，
  // 在这台机器上 Add-Type System.Windows.Forms 是失败的（实测）。
  const ps = [
    '$shell = New-Object -ComObject Shell.Application',
    '$folder = $shell.BrowseForFolder(0, "Pick the project folder", 0)',
    'if ($folder) { [Console]::Out.Write($folder.Self.Path) }',
  ].join('; ');
  try {
    // ⚠️ **必须异步 spawn**：spawnSync 会把整个事件循环卡住 ——
    // 用户在挑目录的那几十秒里，全站请求都不响应（实测把服务端卡死过）。
    const { spawn } = await import('node:child_process');
    const picked = await new Promise((resolve) => {
      const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('error', () => resolve(null)); // 弹不出来 → 让前端退回页内浏览
      p.on('close', () => resolve(out.trim()));
      // 用户可能在挑目录上花很久；给个上限，免得永远挂着
      setTimeout(() => {
        try {
          p.kill();
        } catch { /* 已经退了 */ }
        resolve(null);
      }, 5 * 60 * 1000).unref?.();
    });
    if (picked === null) return fail(res, 500, 'E5002', '弹不出原生选择框');
    if (!picked) return sendJson(res, 200, { canceled: true }); // 用户点了取消
    return sendJson(res, 200, { path: picked });
  } catch (e) {
    return fail(res, 500, 'E5003', String(e?.message ?? e));
  }
}

async function handleWorkflow(req, res, url) {
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
        if (task?.agentRunId) runs.getRun(task.agentRunId)?.abortController?.abort();
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
async function handleSsh(req, res, url) {
  const one = /^\/api\/ssh\/servers\/([^/]+)$/.exec(url.pathname);
  const key = /^\/api\/ssh\/servers\/([^/]+)\/key$/.exec(url.pathname);
  const test = /^\/api\/ssh\/servers\/([^/]+)\/test$/.exec(url.pathname);

  if (req.method === 'DELETE' && one) {
    const r = sshRegistry.removeServer(decodeURIComponent(one[1]));
    if (!r.removed) return fail(res, 404, 'E2031', '登记表里没有这台机器');
    return sendJson(res, 200, { ...sshRegistry.publicServers(), removed: true, alias: r.alias });
  }

  /** 取公钥（只读 .pub）。没生成过就 exists:false + 一句提示，不报错 —— 界面要照常渲染 */
  if (req.method === 'GET' && key) {
    const alias = decodeURIComponent(key[1]);
    const s = sshRegistry.getServer(alias);
    if (!s) return fail(res, 404, 'E2032', '登记表里没有这台机器');
    const pub = sshExec.tryPublicKeyOf(s);
    if (!pub) {
      return sendJson(res, 200, {
        alias: s.alias,
        exists: false,
        public_key: '',
        fingerprint: '',
        guide: '',
        message: `「${s.alias}」还没生成密钥。点下面的按钮生成一对 ed25519；生成后把公钥贴到服务器上。`,
      });
    }
    return sendJson(res, 200, {
      alias: s.alias,
      exists: true,
      public_key: pub,
      fingerprint: sshExec.fingerprintOfPublicFile(`${sshExec.keyPathOf(s)}.pub`),
      // 可整段复制的交付指引，以及**给界面用的结构化步骤**（同一份文案，步骤是来源）
      guide: sshExec.buildGuide(s, pub),
      guide_steps: sshExec.buildGuideSteps(s, pub),
      message: '把下面这一整行贴到服务器的 ~/.ssh/authorized_keys（一行一把钥匙）；也可以直接照下面的步骤做。',
    });
  }

  /** 生成密钥对。**同名一律拒绝，绝不覆盖** —— 和桌面端（T-016）一个规矩 */
  if (req.method === 'POST' && key) {
    const alias = decodeURIComponent(key[1]);
    const s = sshRegistry.getServer(alias);
    if (!s) return fail(res, 404, 'E2033', '登记表里没有这台机器');
    try {
      const r = sshExec.generateKey(s);
      const guide = sshExec.buildGuide(s, r.publicKey);
      sshExec.assertNoCredentials(guide);          // 自检：指引里不许出现凭据正文
      return sendJson(res, 200, {
        alias: s.alias,
        exists: true,
        public_key: r.publicKey,
        fingerprint: r.fingerprint,
        guide,
        guide_steps: sshExec.buildGuideSteps(s, r.publicKey),
        private_path: r.keyPath,
        message: '生成好了。把下面这一整行贴到服务器的 ~/.ssh/authorized_keys（一行一把钥匙）；也可以直接照下面的步骤做。',
        warning: r.aclWarning,
      });
    } catch (e) {
      return fail(res, 400, 'E1036', String(e?.message ?? e));
    }
  }

  /** 连通性探测：真起一次 ssh，跑 hostname; whoami; uname -a */
  if (req.method === 'POST' && test) {
    const alias = decodeURIComponent(test[1]);
    const s = sshRegistry.getServer(alias);
    if (!s) return fail(res, 404, 'E2034', '登记表里没有这台机器');
    const r = await sshExec.testConnection(s);
    return sendJson(res, 200, { alias: s.alias, ok: r.ok, detail: r.detail, fingerprint: r.fingerprint });
  }

  return false;
}

async function handleRun(req, res, url) {
  const stream = /^\/api\/runs\/([^/]+)\/stream$/.exec(url.pathname);
  const abort = /^\/api\/runs\/([^/]+)\/abort$/.exec(url.pathname);

  if (req.method === 'GET' && stream) {
    /*
     * 断线重连：浏览器**自动**带上 `Last-Event-ID`（= 它收到的最后一个 `id:`），
     * 原样交给 subscribe，只补发缺的那一段。
     * 改前是**全量重放** —— 每次重连都把那半段回话再追加一遍（用户看到重复）。
     */
    const ok = runs.subscribe(decodeURIComponent(stream[1]), res, req.headers['last-event-id']);
    if (!ok) fail(res, 404, 'E2035', '这次运行认不出来（不存在，或它那次进程已经没了）');
    return true;
  }

  if (req.method === 'POST' && abort) {
    const runId = decodeURIComponent(abort[1]);
    // **先记下"是人停的"**（要在 abort 之前写，子进程被掐时 promise 会立刻以异常收尾）
    const live = runs.getRun(runId);
    if (live) live.stoppedByUser = true;

    const run = runs.getRun(runId);
    if (!run) {
      // 内存里没有 = 那次进程已经不在了（重启过、或进程异常退出）。
      // ⚠️ **只收拾"库里还写着跑中"的**：正常跑完的运行会从内存里移除，
      //    但它状态已经是 完成/已停止 —— 再盖成「中断」就是篡改事实（踩过：
      //    人点了停止，结果状态显示"中断"，还把这一步永远留在「进行中」）。
      const row = store.getRunStatus(runId);
      if (row?.status === '跑中') {
        store.finishRun(runId, { status: '中断', error: '运行已不在（服务重启或进程退出）' });
        return sendJson(res, 200, { ok: true, note: '那次运行已经不在内存里了，已标记为中断' });
      }
      return sendJson(res, 200, { ok: true, note: '这次运行已经结束了' });
    }
    // 远端那次跑在**别的机器**上：这边没有子进程可掐 —— 走"下一个事件批次把话带过去"那条路
    if (run.remote) {
      runs.abortRemote(runId);
      return sendJson(res, 200, { ok: true, note: '这次跑在远端节点上，已告诉它停下' });
    }
    run.abortController?.abort();
    return sendJson(res, 200, { ok: true });
  }

  return false;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

/** 只服务 apps/web 下的静态文件；路径解析后必须仍在 webDir 里 */
function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(webDir, rel);
  if (!file.startsWith(webDir)) {
    res.writeHead(403).end('forbidden');
    return true;
  }
  try {
    const buf = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- 访问令牌 */

/*
 * 闸开不开**只看监听地址**：只监听回环（桌面版 / 单机）免鉴权；
 * 监听非回环（服务器）全都得要令牌。理由见 auth.mjs 的长注释 ——
 * 关键是这条规则不会被"前面架了个反向代理"偷走。
 *
 * 免鉴权时 `auth.setup` **连令牌文件都不生成**（单机零安全痕迹）。
 */
const AUTH = auth.setup({ host, dataDir, envToken: process.env.BANDI_TOKEN });
/*
 * 这个进程**现在**听的是哪儿 —— 不只是启动时那个 `host`。
 *
 * 为什么要有它（2026-10-16）：加了「重启生效」那颗按钮之后，监听地址会**原地换**（见 restartListening），
 * 于是"配置里想要什么"（netmode.json）和"实际听着什么"可能不再是一回事，
 * `/api/lan` 要如实分辨这两者 ✓。
 */
let boundHost = host;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    /*
     * 访问令牌：**排在来源闸前面** —— 没令牌的请求，连"来源对不对"都不该让它摸到。
     * 闸开不开只看监听地址（回环免鉴权 / 非回环全要），见 auth.mjs 的长注释。
     */
    if (!auth.guard(AUTH, req, res, url)) return;

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

    const handledProject = await handleProject(req, res, url);
    if (handledProject !== false) return;

    const handledStatus = await handleStatus(req, res, url);
    if (handledStatus !== false) return;

    const handledFs = await handleFs(req, res, url);
    if (handledFs !== false) return;

    const handledPick = await handlePickDir(req, res);
    if (handledPick !== false) return;

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

    fail(res, 404, 'E2036', '没有这个接口');
  } catch (err) {
    // 请求本身有问题 → 400；其余才是服务端出错 → 500。两边都带上编码
    if (err instanceof BadRequest) fail(res, 400, err.code ?? 'E1044', String(err.message));
    else fail(res, 500, 'E5004', String(err?.message ?? err));
  }
});

const reaped = store.reapStaleRuns();
if (reaped) console.log(`清理了 ${reaped} 条被中断的运行`);

// 工作流：内建模板保证存在；**把引擎挂在 run 完成点上** —— 推进由平台做，不靠数字员工自觉
workflows.ensureBuiltInTemplate();
runs.onRunFinish(workflows.onAgentRunFinished);
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

server.listen(port, boundHost, logListen);

/**
 * 启动横幅。抽成函数是为了**原地重启之后能再打一遍** ✓
 * —— 不重打的话，日志里"监听 127.0.0.1"会一直骗着后面看日志的人 ✗。
 */
function logListen() {
  /*
   * 启动就把**数据落在哪儿**打出来。
   * 部署排查时最费时间的一类问题是"我在看的到底是哪个库"——
   * 桌面版（用户目录）和服务器（/var/lib/bandi）的库不是一个，光看界面分不出来。
   */
  console.log(`班底平台：http://${boundHost}:${port}`);
  console.log(`工作根：${repoRoot}`);
  console.log(`数据目录：${dataDir}`);
  console.log(`数据库：${dbPath}`);
  /*
   * 只听本机的合法形态有两种，别把它们说成"配错了"：
   *   · 桌面版 / 单机 —— 本来就不该对外；
   *   · 服务器 —— 走 SSH 隧道（不用开端口，也不用这个变量）。
   * 只有"确实要对局域网/公网开"时才需要同时设 BANDI_HOST 与 BANDI_ORIGINS。
   */
  if (AUTH.required) {
    console.log(`监听 ${boundHost}（非本机）—— 允许的来源：${[...allowedOrigins()].join(' , ')}`);
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
    console.log(`访问令牌：在数据目录的 token 文件里（0600，不打印到日志）· 来自 ${AUTH.from}${AUTH.created ? '，本次新生成' : ''}`);
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
  const want = process.env.BANDI_HOST ?? (netmode.readNetMode().allowLan ? '0.0.0.0' : '127.0.0.1');
  if (want === boundHost) {
    console.log(`[网络] 重启监听：本来就是 ${boundHost}，不用动`);
    return;
  }
  console.log(`[网络] 重启监听：${boundHost} → ${want}`);
  server.close(() => {
    boundHost = want;
    // 鉴权要跟着新的监听地址重算（"只看监听地址"那条规则）
    Object.assign(AUTH, auth.setup({ host: want, dataDir, envToken: process.env.BANDI_TOKEN }));
    server.listen(port, boundHost, logListen);
  });
  // 挂着的长轮询（领活那种 20 秒的）别挡着 close 回调 —— 节点收到断开自己会重连 ✓
  server.closeAllConnections?.();
}
