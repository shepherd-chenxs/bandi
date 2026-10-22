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
 * 这个运行时 id 收不收。
 *
 * `'auto'` 也是合法值（`runtimes.resolveForRun` 认识它：按"谁现在能用"挑一个）——
 * 内置秘书就用它，这样换机器、换 CLI 都不用回来改她。界面上只有内置员工的下拉里有这一条。
 */
function runtimesOk(id) {
  return id === 'auto' || runtimeOptions().some((r) => r.id === id);
}

/* --------------------------------------------------- 局域网发现与"自报家门" */

/*
 * 这台总机对局域网**自报家门**的那一份数据（2026-10-20，设计 §5.4）。
 *
 * 两个出口共用同一份口径：`GET /api/hello`（HTTP，加入向导"探地址"用它）与
 * UDP 8788 的应答（见 lan-announce.mjs）。**故意不带任何秘密** —— 这些字段
 * PRD P0-1 已经定成"局域网可见"（机器名、主机名、端口、能不能加入、版本）。
 *
 * ⚠️ `allowLan` 取的是**开关值**（`netmode.readNetMode().allowLan`），不是"现在听没听 0.0.0.0"：
 * 它仍是开关值的广播（`/api/lan` 页口径不动）。而**能不能加入**由 `netmode.isJoinable()`
 * 判（2026-10-20 增量 1，设计 §1.1/§1.2）：云端总机（`BANDI_HOST=0.0.0.0` 显式监听、开关值
 * 恒为 false）在这里必须回 `joinable:true` —— 否则节点探测会把它误报成"没开局域网开关"（E1091）。
 * 判定与 UDP 应答包共用同一函数，杜绝两份逻辑漂移。
 */
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
    joinable: netmode.isJoinable({ allowLan: nm.allowLan, explicit: !!process.env.BANDI_HOST, boundHost }),
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
async function withExternals(dev) {
  if (!dev) return dev;
  // 说明表按**那台机器**的平台算（控制面在 Linux、节点是 Windows 时，命令不是同一条）
  const catalog = externals.publicExternals(dev.platform);
  /*
   * 顺手把**最近那件小事**带上（装运行时 / 装外部件）。
   *
   * 为什么要有这一条（2026-10-16 用户报的"刷新页面，看不到安装进度了"）：
   * 进度原来只活在**浏览器**里（写在点击处理器的轮询里）—— 一刷新就没了，
   * 而那件事其实**还在那台机器上跑着**。按这条架构一贯的原则（**状态在服务端**），
   * 进度也该从服务端读回来：刷新、换台电脑、明天再看，都还是它。
   *
   * 2026-10-21：本机也带上 —— 本机那颗「在这台机器上安装」和节点共用这一套
   * （任务表按设备 id 存，本机那条的 nodeId 就是 `local`）。
   */
  const [task] = store.listNodeTasks(dev.id, 1);
  if (dev.kind === 'node') {
    return {
      ...dev,
      task: store.publicNodeTask(task),
      externals: { probed: dev.externalsProbed ?? [], catalog },
    };
  }
  return { ...dev, task: store.publicNodeTask(task), externals: { probed: await externals.declared(), catalog } };
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

/**
 * 收一个**原始二进制**请求体（2026-10-22 数据管理：导入整个 .db 快照用）。
 * readBody 是 JSON 且 1MB 就掐 —— 快照通常好几 MB 还是二进制，走不了它。
 * 上限照着"库再大也就几十 MB"给 200MB，超了直接掐（E1099）。
 */
function readRawBody(req, maxBytes = 200 * 1048576) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new BadRequest('文件太大（上限 200MB）', 'E1099'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

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
  // 前端是长活 SPA：磁盘上的 app.js 换了，开着的页面不会自己换 —— 「点了没反应」多半是它。
  // 前端每 60 秒来对一次指纹（mtime+size），变了就亮「刷新」提示条。只 stat 一个文件，几乎零成本。
  'GET /api/web-version': async (req, res) => {
    try {
      const st = fs.statSync(path.join(webDir, 'app.js'));
      sendJson(res, 200, { v: `${Math.round(st.mtimeMs)}-${st.size}` });
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
async function handleConversation(req, res, url) {
  const detail = /^\/api\/conversations\/([^/]+)$/.exec(url.pathname);
  const send = /^\/api\/conversations\/([^/]+)\/messages$/.exec(url.pathname);
  const hide = /^\/api\/conversations\/([^/]+)\/hide$/.exec(url.pathname);

  /**
   * 「不显示」/「归档」：只动列表显示，**不删任何消息**（2026-10-20）。
   *
   * 两个菜单项走同一个接口，区别只在前端文案：
   *   · 正常员工 → 「不显示」，之后仍能在**聊天记录**里找到（返回体里带 hiddenConversations）；
   *   · 已删除员工 → 「归档」，那个人已经没有聊天记录入口了，所以界面上等于彻底收走。
   * 恢复入口已随归档功能一起去掉；想在列表里再看到它，只能等它再说一句话（见 addMessage）。
   */
  if (req.method === 'POST' && hide) {
    const id = decodeURIComponent(hide[1]);
    if (!store.hideConversation(id)) return fail(res, 404, 'E2001', '会话不存在');
    return sendJson(res, 200, {
      hidden: true,
      conversations: store.listConversations(),
      hiddenConversations: store.listHiddenConversations(),
    });
  }

  /**
   * **永久删除**一段会话（右键菜单 →「删除」，2026-10-20）。
   *
   * 接受 `direct` / `group`，另外一种有它自己的出口，**不从这儿删**：
   *   · 群 → 2026-10-20 用户定：「删除不是删除群，是删除**这次会话**」——
   *     列表里那行代表的是这个群最新的一段，删它只抹这一段；
   *     群本身、成员名单、其他段都不动（删到零段时群行一并收掉，见 store）；
   *     整个群不要了走「解散」（记录留着、成员关系解除）。
   *   · exec（工单会话）→ 它是任务卡 / 流程的载体，删它等于抽掉办过的痕迹。
   *
   * 三道校验（存在 / 是 direct / 没有跑中的 run）都在 `store.deleteConversation` 里做，
   * 这里只负责**映射成对的状态码与错误码** —— 前端可以被绕过、接口也能被直接调，
   * 所以「store 里再判一遍」是底线，不是重复（同 DELETE /api/personas/:id 的两道关）。
   *
   * 回整份 `conversations` 是跟 hide 保持一致：同一个界面、同一套前端流程，
   * 前端一行 `S.conversations = r.conversations` 就够，不用再 load() 一次。
   * `hiddenConversations` 一起回，是因为聊天记录抽屉可能正列着它（删完要立刻消失）。
   */
  if (req.method === 'DELETE' && detail) {
    const id = decodeURIComponent(detail[1]);
    const r = store.deleteConversation(id);
    if (!r.ok) {
      if (r.why === 'not-found') {
        return fail(res, 404, 'E2047', '这段会话已经不在了（可能刚被删过）');
      }
      if (r.why === 'not-deletable') {
        return fail(res, 400, 'E1050', '工单会话不能这样删 —— 它属于任务卡 / 流程，请去那边删任务');
      }
      // 「这段正在跑」是**当前状态冲突**，不是请求格式错 —— 所以 409（E4xxx 段），不是 400
      return fail(res, 409, 'E4002', '这段还在跑，等它跑完或先终止再删', r.runId ? { runId: r.runId } : null);
    }
    return sendJson(res, 200, {
      deleted: true,
      id,
      conversations: store.listConversations(),
      hiddenConversations: store.listHiddenConversations(),
    });
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
    /*
     * 404 的码同样是 `E2047`（2026-10-20，设计 §4.1.1 统一；原 `E2003`）。
     *
     * 理由与下面 GET 那段一样：**「会话不存在」是一个概念，就该只有一个码**。
     * 三个 404 入口（GET / PUT / DELETE）里留一个不一样的，就是给下一个人挖坑 ——
     * 何况 `E2047` 的定义本来就是「会话不存在」，给它加个"仅限删除"的隐含限定没有道理。
     * 码与文案一起对齐：**状态码仍是 404**；文案改成与 GET 逐字相同的那句 ——
     * 「同一个概念在两个接口上说两种话」只会让用户以为是两个不同的问题（一个说"不存在"、
     * 一个说"已经不在了"，其实都是"这段没了"）。
     * 这个接口的前端 catch 仍不接 `toastConvErr`（那是「改权限 / 模型」的界面，不在本次范围，
     * 失败提示行为保持原样，只是里面那句中文跟着变了）。
     */
    if (!conversation) return fail(res, 404, 'E2047', '这段会话已经不在了（可能刚被删过）');
    if (wantsSandbox) conversation = store.setConversationSandbox(id, body.sandbox ? String(body.sandbox) : null);
    if (wantsModel) conversation = store.setConversationModel(id, body.model ? String(body.model) : null);
    return sendJson(res, 200, { conversation });
  }

  if (req.method === 'GET' && detail) {
    const id = decodeURIComponent(detail[1]);
    const conversation = store.getConversation(id);
    /*
     * 404 的码从 `E2004` 改成了 `E2047`（2026-10-20，会话改造 v1.1 收口）。
     *
     * 为什么改：`E2047` 的定义就是「**会话不存在**」，而「这段被另一个窗口删了」这件事
     * 在**回看**（这个 GET）和**删除**（下面的 DELETE）两个入口上必须给同一个码 ——
     * 前端 `openConversationSafe` 就是靠 `err.code === 'E2047'` 认出"这段没了"，
     * 好把右栏收拾干净并说人话（设计 §5.6.1 路径 2/3 明确写的是「GET 返回 E2047」）。
     * 两个码表示同一件事，只会让人多写一条映射，还容易漏。
     * 上面 PUT 那段同理（原 `E2003`）—— 三个 404 入口统一口径，见设计 §4.1.1。
     *
     * `E2004` / `E2003` 全仓没有第二处引用（前端也不解析它们），换掉不影响任何调用方。
     */
    if (!conversation) return fail(res, 404, 'E2047', '这段会话已经不在了（可能刚被删过）');
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

    /*
     * 已解散的群：**只读**（2026-10-20 用户定：解散后消息留在消息列表里，但不能再聊）。
     * 前端已经把输入框置灰了，这里再拦一次 —— 接口能被直接调，而且"解散后 thread_members 空了"
     * 会让 dispatcher 找不到人、表现成"点了没反应"（比报错更难查）。
     * 用 E2049（与「群已解散，不能再开会话」同一个概念：这个群结束了）。
     */
    const conv0 = store.getConversation(id);
    if (conv0?.dissolvedAt) {
      return fail(res, 409, 'E2049', '这个群已经解散了，只能查看聊天记录');
    }

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

/** 头像字段只收纯文件名（图片本体在 apps/web/avatars/，由静态路由服务）—— 防借字段写路径 */
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
async function handlePersona(req, res, url) {
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
async function handleGroup(req, res, url) {
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

    const body = await readBody(req);
    const title = String(body.title ?? '').trim();
    const nextAssistant = body.assistantPersonaId ? String(body.assistantPersonaId) : '';

    if (!title && !nextAssistant) {
      return fail(res, 400, 'E1039', '这次请求没说改哪一项 —— 这个接口只能改「群名称」(title) 或「群助手」(assistantPersonaId)');
    }
    if (nextAssistant) {
      if (!store.getPersona(nextAssistant)) return fail(res, 400, 'E1012', '这个数字员工不存在');
      if (!g.members.some((m) => m.personaId === nextAssistant)) {
        return fail(res, 400, 'E1013', '群助手得先是群里的人');
      }
    }
    // 群级改 + 同步到每一段会话（列表/聊天头部读的是会话上的镜像字段）
    const next = store.updateGroup(id, { title: title || '', assistantPersonaId: nextAssistant || '' });
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
        runs.getRun(running.id)?.abortController?.abort();
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
async function handleExpert(req, res, url) {
  const hire = /^\/api\/experts\/([^/]+)\/hire$/.exec(url.pathname);
  const fire = /^\/api\/experts\/([^/]+)\/fire$/.exec(url.pathname);
  if (!hire && !fire) return false;
  if (req.method !== 'POST') {
    return fail(res, 405, 'E2052', '雇佣/解聘只认 POST');
  }

  const key = decodeURIComponent((hire ?? fire)[1]);
  if (!experts.getExpert(key)) {
    return fail(res, 404, 'E2051', `专家库里没有「${key}」这一位 —— 目录就那八位，看看是不是拼错了`);
  }

  if (hire) {
    // 幂等：已经雇着 → 直接返回现有的，200（新雇才 201）。重按雇佣按钮不该变成报错
    const r = experts.hireExpert(key);
    return sendJson(res, r.created ? 201 : 200, { persona: r.persona });
  }

  /*
   * 解聘。群助手先拦（2026-10-22）：普通员工删除的 E1038 拦在 handlePersona 里，
   * 专家这条直调的路要在自己这里补上同一道 —— 否则群里会剩一个悬空的"没 @ 就找群助手"。
   * 错误码 **E2053**（409 专家还是群助手，E2051/E2052 之后顺位，grep 确认全仓无撞号）；
   * 群名单附在 detail 给控制台，界面只显示码 + 中文。
   */
  const r = experts.fireExpert(key);
  if (r.blocked) {
    return fail(
      res,
      409,
      'E2053',
      `「${experts.getExpert(key).name}」还是 ${r.groups.length} 个群的群助手，先在群设置里把群助手换成别人，再解聘。`,
      { groups: r.groups },
    );
  }
  return sendJson(res, 200, r);
}

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
      // 技能锁定的反方向闸（2026-10-23，2026-10-22 扩到内置员工）：技能页"发给数字员工"也发不到被锁员工头上
      const pidLock = experts.lockKindOf(pid);
      if (pidLock) {
        const who = store.getPersona(pid);
        return fail(res, 403, 'E2054', `「${who?.name ?? pid}」是${LOCK_MSG[pidLock].who}，技能${pidLock === 'expert' ? '随专家包' : '随平台'}固定，不能添加`);
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
    return sendJson(res, 200, { skill: s, personas: store.listPersonas().filter((p) => store.listPersonaSkills(p.id).includes(name)).map((p) => ({ id: p.id, name: p.name })) });
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
const CLAIM_POLL_MS = 250;
const CLAIM_MAX_WAIT_MS = 45000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * **本机就地执行**一件安装任务（2026-10-21）：「设置 → 这台机器 → 未安装 → 在这台机器上安装」。
 *
 * 为什么要有这一条：远程节点那侧是"控制面排任务 → 节点领走 → 节点自己查表跑"；
 * 而单机形态下本机（id=`local`）没有节点进程来领活，任务会永远"待领"。
 * 本机就是控制面自己，所以排完任务由本进程直接跑。
 *
 * ⚠️ **安全边界和节点那条完全一样**：调用方只能发**族名**，命令永远来自
 * `runtimes.installCommandFor` 这张写死在代码里的表 —— 这里没有"传什么跑什么"的口子。
 *
 * Windows 上 `npm` 是 .cmd 垫片：Node 22 直接 spawn 它会 EINVAL（实测，见 connectors.mjs
 * 的 launcher 注释），所以过一层 `cmd /c` —— 拼进去的仍是表里的固定字符串，没有用户输入。
 * 输出节流写回任务行（界面每 1.5 秒读回来），装完的清单本机是**现探**的，不用额外上报。
 */
async function runLocalInstall(taskId) {
  const task = store.claimNodeTaskById(taskId);
  if (!task) return; // 已经被领走 / 已经结束：不重复执行
  const spec = runtimes.installCommandFor(task.family);
  if (!spec) {
    store.appendNodeTaskOutput(task.id, '这台机器上的班底不认识这个族，或者它不是一条命令能装的\n');
    return store.finishNodeTask(task.id, '失败');
  }
  const isWin = process.platform === 'win32';
  const file = isWin ? process.env.ComSpec || 'cmd.exe' : spec.bin;
  const args = isWin ? ['/c', spec.bin, ...spec.args] : spec.args;

  let buf = '';
  let lastAt = 0;
  const flush = (force = false) => {
    if (!buf) return;
    const now = Date.now();
    if (!force && now - lastAt < 400) return;
    lastAt = now;
    const chunk = buf;
    buf = '';
    store.appendNodeTaskOutput(task.id, chunk);
  };

  console.log(`[本机] 开始安装 ${task.family}：${spec.cmd}`);
  let child;
  try {
    const { spawn } = await import('node:child_process');
    child = spawn(file, args, { cwd: os.homedir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    store.appendNodeTaskOutput(task.id, `起不来：${[e?.code, e?.message].filter(Boolean).join(' ')}\n`);
    return store.finishNodeTask(task.id, '失败');
  }
  const onData = (c) => {
    buf += String(c);
    flush();
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  let settled = false; // 'error' 与 'close' 只许收尾一次，别把任务判两遍
  const finish = (status, extra = '') => {
    if (settled) return;
    settled = true;
    clearTimeout(killer);
    if (extra) {
      buf += extra;
      flush(true);
    }
    store.finishNodeTask(task.id, status);
  };
  // 兜底超时：npm 卡死（网络挂起）不该让这一行永远"执行中"
  const killer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* 已经退了 */
    }
  }, 15 * 60 * 1000);
  killer.unref();
  child.on('error', (e) => {
    finish('失败', `起不来：${e?.message ?? e}\n`);
    console.log(`[本机] 安装 ${task.family} 失败：${e?.message ?? e}`);
  });
  child.on('close', (code) => {
    const ok = code === 0;
    finish(ok ? '完成' : '失败', ok ? '\n装完了。\n' : `\n（${spec.bin} 退出码 ${code}）\n`);
    console.log(`[本机] 安装 ${task.family}${ok ? '装好了' : `失败了（退出码 ${code}）`}`);
  });
}

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
   *
   * 本机（id=`local`）2026-10-21 起也走这里：单机形态下没有节点进程来领活，
   * 所以排完任务由**控制面自己执行**（见 runLocalInstall）—— 边界不变，
   * 命令还是那张固定表里的，前端照样只能发族名。
   */
  if (req.method === 'POST' && tasks) {
    const nodeId = decodeURIComponent(tasks[1]);
    const isLocal = nodeId === runtimes.LOCAL_ID;
    if (!isLocal && !store.getNode(nodeId)) return fail(res, 404, 'E2041', '这个节点没登记过');
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
      const task = store.enqueueNodeTask({ nodeId, kind, family: target });
      console.log(`[节点] 给 ${nodeId} 排了个任务：${kind} ${target}`);
      if (isLocal) void runLocalInstall(task.id); // 本机：控制面当场跑，不等谁来领
      return sendJson(res, 201, { task: store.publicNodeTask(task), willRun: spec.cmd });
    } else if (kind === 'external-install' || kind === 'external-serve') {
      // 本机不给外部件一键（2026-10-16 定的边界，别被"本机也能装运行时"带偏）：
      // 那是 `curl … | sh`，控制面直接跑不合适 —— 界面上给复制命令，用户自己在终端粘。
      if (isLocal) {
        return fail(res, 400, 'E1043', '本机不给外部件一键安装 —— 复制那条命令，在终端里粘一下更清楚');
      }
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
    /*
     * `scope`（2026-10-20，设计 §5.8）：这台机器用来做什么 —— `compute` / `panel` 可同时具备。
     *
     * ⚠️ **前端 wire 发 `scopes` 数组**（复数键优先），此处统一归一进 `normScope` ——
     * 只读单数键的话，前端那份数组会被静默忽略、按缺省落成 `compute`，
     * "当入口也能干活"的机器就只拿到算力令牌（静默降级，QA 实测堵掉的就是它）。
     *
     * **缺省 `compute`**：老的 `node.mjs --join`（它一个字节不改）照旧能用，且行为与改前完全一致。
     * 校验放在**消耗邀请码之前**：非法值不该把一个一次性邀请码白白烧掉。
     * 码沿用 `E1047`（与"加入要带 id"同码，不新增）。
     */
    const scopeInput = body?.scopes ?? body?.scope;
    if (!store.scopeIsValid(scopeInput)) {
      return fail(res, 400, 'E1047', '这台机器的用途只认「算力」(compute) 与「面板」(panel) 的组合');
    }
    const scope = store.normScope(scopeInput);
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
    const token = store.issueNodeToken(id, scope);
    console.log(`[节点] ${label} 用邀请码加入了（${id}）—— 给了它自己一枚令牌，权限「${scope}」`);
    return sendJson(res, 201, {
      token,
      node: runtimes.publicDeviceById(id),
      heartbeatSeconds: runtimes.NODE_HEARTBEAT_SEC,
      // 回显：节点侧据此自检"总机记下的权限"与"我以为的"是不是同一份
      scope,
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
    // repo（工作空间，2026-10-22）：存库时是 JSON 字符串，发回对象 —— 解不开就当没有
    let repo = null;
    try {
      repo = job.repo ? JSON.parse(job.repo) : null;
    } catch {
      repo = null;
    }
    return sendJson(res, 200, {
      job: {
        id: job.id,
        runId: job.runId,
        family: job.family,
        model: job.model,
        sandbox: job.sandbox,
        cwd: job.cwd,
        repo,
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
      /*
       * **UDP 应答器跟着开关原地启停**（2026-10-20，设计 §5.5 三处同步点之一）。
       * 开关关掉必须**立刻**停 bind —— 否则"关掉之后不再出现在候选里"这条 PRD 验收项
       * 就得等重启才成立 ✗。
       *
       * 这里用 `boundHost`（这个进程**实际**听着什么），不是配置里想要的：
       * 开关刚打开、还没点重启时监听仍是回环，那时回应答毫无意义（别人根本连不进来）。
       */
      lanAnnounce.sync({ allowLan: body?.allowLan === true, explicit: !!process.env.BANDI_HOST, boundHost, httpPort: port });
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
      /*
       * UDP 应答器**实际**在不在听（2026-10-20 加）：`on` 才是"别的机器能不能发现我"的真相。
       * 开关开着但还没重启 → `on:false` —— 界面上那句"重启后生效"就有据可依了。
       */
      discovery: lanAnnounce.state(),
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
  if (req.method === 'POST' && taskComments) {
    const id = decodeURIComponent(taskComments[1]);
    const task = store.getProjectTask(id);
    if (!task) return fail(res, 404, 'E2039', '任务不存在');
    const body = await readBody(req);
    const text = String(body.text ?? '').trim();
    if (!text) return fail(res, 400, 'E1010', '说点什么');
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
      const message = store.addMessage({ conversationId: conv.id, role: 'user', text, parentId, note: true });
      return sendJson(res, 201, { note: true, mode, message, conversationId: conv.id });
    }
    try {
      // 讨论 = 只读（plan）；执行 = 员工默认沙箱。不传 sandbox 就用默认。
      const { run } = dispatchToThread(conv.id, text, {
        projectId: task.projectId ?? null,
        parentId,
        sandbox: mode === 'discuss' ? 'plan' : undefined,
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
   * `pr` 归状态走同一套 `afterMerged`：巡检报上来是 merged、卡在「进行中」，就收成「待确认」。
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
      constitution: body.constitution,
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
 *
 * ⚠️ **只做"列目录"，不弹原生框**（2026-10-22 改）：原来的 `/api/fs/pick-dir` 由服务端
 * spawn PowerShell 弹 `Shell.Application.BrowseForFolder` —— 但服务端是没有窗口的后台进程，
 * 弹出来的框没有属主窗口，实测 `IsWindowVisible=false`（被最大化的桌面壳窗口整个盖住），
 * 用户只看到按钮一直转「…」。原生目录框现在归**桌面壳**：页面走 Tauri IPC 的
 * `pick_directory`（`apps/desktop/src/lib.rs`，带 owner 窗口的 IFileOpenDialog）；
 * 纯浏览器环境（`start.cmd`）退回页内浏览，也就是本接口。
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

/*
 * **代码托管**（GitHub 仓库接入，2026-10-17）。
 *
 * 令牌只在 git-repos.mjs 里读写，这里**从不回显完整令牌**（只给后 4 位）。
 * 克隆/拉取是**异步子进程**（不 spawnSync）—— 大仓库克隆时控制面不能整台卡住。
 */
async function handleGit(req, res, url) {
  // 这个 handler 管两类路径：/api/git/*（代码托管）与 /api/projects/tasks/:id/pr*（PR 联动）
  const isPrRoute = /^\/api\/projects\/tasks\/[^/]+\/pr(\/refresh)?$/.test(url.pathname);
  if (!url.pathname.startsWith('/api/git/') && !isPrRoute) return false;

  /*
   * 状态**只读本机**（2026-10-17 改）：connected / hint / 仓库清单全在本地文件和库里，
   * 登录名用上次验到的那一个（`meta.github_login`）。
   *
   * 原来这里每次都 `await git.verifyToken()` —— 页面每打开一次就往 api.github.com 打一次，
   * 国内网络下界面就悬在"取代码托管状态…"好几秒（用户实报："这个页面显示有延迟"）。
   * 现在身份校验挪到 `/api/git/whoami`，由界面**画完之后再在后台问**。
   */
  if (req.method === 'GET' && url.pathname === '/api/git/status') {
    const connected = !!git.readToken();
    return sendJson(res, 200, { connected, login: connected ? git.cachedLogin() : null, hint: git.tokenHint(), repos: git.listConnected() }), true;
  }

  /*
   * 后台验一次身份（界面首屏画完之后才调）。
   *
   * **失败也回 200**：这不是"操作失败"，只是"这次没问到"——页面已经用本地状态画完了，
   * 回 200 + `error` 让它安静地不改那行字，而不是弹一个错误块把整页弄成失败态。
   * 令牌明确失效（401）时顺手把记住的名字清掉，下次页面就不再显示一个已死的账号。
   */
  if (req.method === 'GET' && url.pathname === '/api/git/whoami') {
    if (!git.readToken()) return sendJson(res, 200, { connected: false, login: null }), true;
    try {
      const me = await git.whoami({ fresh: url.searchParams.get('fresh') === '1' });
      return sendJson(res, 200, { connected: true, login: me.login, name: me.name ?? null, cached: !!me.cached }), true;
    } catch (e) {
      const msg = String(e.message ?? e);
      if (msg.includes('401')) git.forgetLogin();
      return sendJson(res, 200, { connected: true, login: git.cachedLogin(), error: msg }), true;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/git/token') {
    const body = await readBody(req);
    const token = String(body.token ?? '').trim();
    if (!token) return fail(res, 400, 'E1061', '令牌是空的');
    let me;
    try {
      me = await git.verifyToken(token);
    } catch (e) {
      return fail(res, 400, 'E1062', String(e.message ?? e)), true;
    }
    git.saveToken(token);
    git.rememberLogin(me.login); // 刚验过，页面下次打开就能立刻显示 @名字
    return sendJson(res, 200, { connected: true, login: me.login, hint: git.tokenHint() }), true;
  }

  if (req.method === 'DELETE' && url.pathname === '/api/git/token') {
    git.clearToken();
    return sendJson(res, 200, { connected: false }), true;
  }

  if (req.method === 'GET' && url.pathname === '/api/git/available') {
    try {
      const list = await git.listAvailableRepos();
      const connected = new Set(git.listConnected().map((r) => r.fullName));
      return sendJson(res, 200, { repos: list.map((r) => ({ ...r, connected: connected.has(r.fullName) })) }), true;
    } catch (e) {
      return fail(res, 400, 'E1063', String(e.message ?? e)), true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/git/repos') {
    return sendJson(res, 200, { repos: git.listConnected() }), true;
  }

  if (req.method === 'POST' && url.pathname === '/api/git/repos') {
    const body = await readBody(req);
    try {
      const out = await git.connectRepo(String(body.fullName ?? ''), null, body.localPath ? String(body.localPath) : null);
      return sendJson(res, 201, out), true;
    } catch (e) {
      return fail(res, 400, 'E1064', String(e.message ?? e)), true;
    }
  }

  /* ---- PR 联动：卡片 ↔ GitHub PR ------------------------------------- */

  const prOf = /^\/api\/projects\/tasks\/([^/]+)\/pr(\/refresh)?$/.exec(url.pathname);
  if (prOf) {
    const taskId = decodeURIComponent(prOf[1]);
    const task = store.getProjectTask(taskId);
    if (!task) return fail(res, 404, 'E1068', '任务不存在'), true;

    // 关联：body { url }（也接受 owner/name#123）
    if (req.method === 'POST' && !prOf[2]) {
      const body = await readBody(req);
      const ref = git.parsePrRef(body.url ?? body.pr ?? '');
      if (!ref) return fail(res, 400, 'E1069', '看不懂这个 PR：贴链接，或写成 owner/name#123'), true;
      if (!git.readToken()) return fail(res, 400, 'E1070', '先连接 GitHub（设置 → 代码托管）'), true;
      let snap;
      try {
        snap = await git.fetchPull(ref.repo, ref.number);
      } catch (e) {
        return fail(res, 400, 'E1071', `查不到这个 PR：${e.message}`), true;
      }
      const next = store.updateProjectTask(taskId, {
        prRepo: ref.repo,
        prNumber: ref.number,
        prState: snap.state,
        prTitle: snap.title,
        prCheckedAt: new Date().toISOString(),
      });
      return sendJson(res, 200, { task: afterMerged(next), pr: snap }), true;
    }

    // 刷新：重新查一次
    if (req.method === 'POST' && prOf[2]) {
      if (!task.prRepo || !task.prNumber) return fail(res, 400, 'E1072', '这张卡还没关联 PR'), true;
      let snap;
      try {
        snap = await git.fetchPull(task.prRepo, task.prNumber);
      } catch (e) {
        return fail(res, 400, 'E1073', `查不到这个 PR：${e.message}`), true;
      }
      const next = store.updateProjectTask(taskId, {
        prState: snap.state,
        prTitle: snap.title,
        prCheckedAt: new Date().toISOString(),
      });
      return sendJson(res, 200, { task: afterMerged(next), pr: snap }), true;
    }

    // 取消关联
    if (req.method === 'DELETE') {
      const next = store.updateProjectTask(taskId, {
        prRepo: null,
        prNumber: null,
        prState: null,
        prTitle: null,
        prCheckedAt: null,
      });
      return sendJson(res, 200, { task: next }), true;
    }
  }

  /*
   * 批量刷新：所有关联了 PR 的卡（看板工具栏上的「刷新 PR（n）」）。
   *
   * `?projectId=` 只查某个项目 —— 项目看板上那颗按钮写的是"本板 n 张"，就该只动这几张
   * （不然数字对不上：按钮说 2 张，背后刷了 20 张别的项目的卡）。全局面板不带它，查全部。
   * 上限 50 张：一次点下去串行查 GitHub，几百张会卡到人以为点了没反应。
   */
  if (req.method === 'POST' && url.pathname === '/api/git/prs/refresh') {
    if (!git.readToken()) return fail(res, 400, 'E1074', '先连接 GitHub（设置 → 代码托管）'), true;
    const only = url.searchParams.get('projectId');
    let updated = 0;
    const failed = [];
    for (const t of store
      .listProjectTasksWithPr()
      .filter((x) => !only || x.projectId === only)
      .slice(0, 50)) {
      try {
        const snap = await git.fetchPull(t.prRepo, t.prNumber);
        const next = store.updateProjectTask(t.id, {
          prState: snap.state,
          prTitle: snap.title,
          prCheckedAt: new Date().toISOString(),
        });
        afterMerged(next);
        updated++;
      } catch (e) {
        failed.push({ id: t.id, error: String(e.message ?? e) });
      }
    }
    return sendJson(res, 200, { updated, failed }), true;
  }

  const syncOne = /^\/api\/git\/repos\/([^/]+)\/sync$/.exec(url.pathname);
  if (req.method === 'POST' && syncOne) {
    try {
      return sendJson(res, 200, { repo: await git.syncRepo(decodeURIComponent(syncOne[1])) }), true;
    } catch (e) {
      return fail(res, 400, 'E1065', String(e.message ?? e)), true;
    }
  }

  const one = /^\/api\/git\/repos\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'DELETE' && one) {
    try {
      return sendJson(res, 200, git.removeRepo(decodeURIComponent(one[1]))), true;
    } catch (e) {
      return fail(res, 404, 'E1066', String(e.message ?? e)), true;
    }
  }

  return fail(res, 404, 'E1067', '没有这个接口'), true;
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
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function scheduleFields(body, { partial = false } = {}) {
  const out = {};
  if (body.repeat !== undefined || !partial) {
    const r = String(body.repeat ?? 'interval');
    if (!schedules.REPEATS.includes(r)) throw new BadRequest(`不认识的重复方式：${r}（可选：${schedules.REPEATS.join(' / ')}）`, 'E1083');
    out.repeat = r;
  }
  const repeat = out.repeat;

  if (repeat === 'interval' || body.everyMinutes !== undefined) {
    const n = Math.round(Number(body.everyMinutes));
    if (!Number.isFinite(n) || n < schedules.MIN_MINUTES) throw new BadRequest(`间隔至少 ${schedules.MIN_MINUTES} 分钟（再密就是白烧 GitHub 的速率上限）`, 'E1083');
    if (n > 7 * 24 * 60) throw new BadRequest('间隔太大（最多 7 天）', 'E1083');
    out.everyMinutes = n;
  }

  if (repeat === 'once' || body.runAt !== undefined) {
    const t = Date.parse(body.runAt ?? '');
    if (!Number.isFinite(t)) throw new BadRequest('单次要给一个有效的时间（如 2026-10-20T09:00）', 'E1083');
    out.runAt = new Date(t).toISOString();
  }

  if ((repeat && repeat !== 'interval' && repeat !== 'once') || body.atTime !== undefined) {
    if (!HHMM.test(String(body.atTime ?? ''))) throw new BadRequest('时间要写成 HH:MM（如 09:00）', 'E1083');
    out.atTime = String(body.atTime);
  }

  if (repeat === 'weekly' || repeat === 'biweekly' || body.weekday !== undefined) {
    const w = Math.round(Number(body.weekday));
    if (!Number.isInteger(w) || w < 0 || w > 6) throw new BadRequest('星期几要在 0（日）到 6（六）之间', 'E1083');
    out.weekday = w;
  }

  if (repeat === 'monthly' || repeat === 'yearly' || body.dayOfMonth !== undefined) {
    const d = Math.round(Number(body.dayOfMonth));
    if (!Number.isInteger(d) || d < 1 || d > 31) throw new BadRequest('几号要在 1 到 31 之间（小月会自动取当月最后一天）', 'E1083');
    out.dayOfMonth = d;
  }

  if (repeat === 'yearly' || body.month !== undefined) {
    const m = Math.round(Number(body.month));
    if (!Number.isInteger(m) || m < 1 || m > 12) throw new BadRequest('几月要在 1 到 12 之间', 'E1083');
    out.month = m;
  }

  if (body.name !== undefined || !partial) {
    const name = String(body.name ?? '').trim();
    if (!name) throw new BadRequest('任务要有名字', 'E1081');
    out.name = name;
  }
  if (body.action !== undefined || !partial) {
    if (!schedules.ACTIONS[String(body.action ?? '')]) throw new BadRequest(`不认识的动作：${body.action ?? '（空）'}`, 'E1082');
    out.action = String(body.action);
  }
  if (body.enabled !== undefined) out.enabled = body.enabled ? 1 : 0;
  if (body.config !== undefined) {
    if (body.config !== null && typeof body.config !== 'object') throw new BadRequest('config 要是一个对象', 'E1084');
    out.config = body.config;
  }
  return out;
}

/**
 * 动作自己的校验（声明了 `validate` 的才跑）。
 *
 * 为什么放服务端：界面上「没写要做什么」当然会拦，但接口谁都能直接调；
 * 更要紧的是**别让一个配错的定时任务建成功** —— 半夜到点跑一次、失败、写进 lastError，
 * 人第二天才知道配错了。能在建的时候说清楚的，就在建的时候说。
 */
function assertActionConfig(actionId, config) {
  const check = schedules.ACTIONS[actionId]?.validate;
  if (!check) return;
  const msg = check(config ?? {});
  if (msg) throw new BadRequest(msg, 'E1087');
}

async function handleSchedules(req, res, url) {
  if (!url.pathname.startsWith('/api/schedules')) return false;
  const one = /^\/api\/schedules\/([^/]+)(\/run)?$/.exec(url.pathname);
  const view = (j) => ({
    ...j,
    config: schedules.parseConfig(j),
    text: schedules.describeRepeat(j),
    running: schedules.runningIds().includes(j.id),
  });

  if (req.method === 'GET' && url.pathname === '/api/schedules') {
    return (
      sendJson(res, 200, {
        jobs: store.listSchedules().map(view),
        actions: schedules.actionCatalogue(),
        minMinutes: schedules.MIN_MINUTES,
      }),
      true
    );
  }

  if (req.method === 'POST' && url.pathname === '/api/schedules') {
    const body = await readBody(req);
    const fields = scheduleFields(body);
    assertActionConfig(fields.action, fields.config);
    const job = store.createSchedule(fields);
    return sendJson(res, 201, { job: view(job) }), true;
  }

  if (one && !one[2] && req.method === 'PATCH') {
    const job = store.getSchedule(decodeURIComponent(one[1]));
    if (!job) return fail(res, 404, 'E1085', '没有这个定时任务'), true;
    const patch = scheduleFields(await readBody(req), { partial: true });
    // 只改开关/重复方式时，动作和参数都还是老样子 —— 校验要看**合并后**的那一份
    assertActionConfig(patch.action ?? job.action, patch.config !== undefined ? patch.config : schedules.parseConfig(job));
    return sendJson(res, 200, { job: view(Object.keys(patch).length ? store.updateSchedule(job.id, patch) : job) }), true;
  }

  if (one && !one[2] && req.method === 'DELETE') {
    const ok = store.deleteSchedule(decodeURIComponent(one[1]));
    return ok ? sendJson(res, 200, { ok: true }) : fail(res, 404, 'E1085', '没有这个定时任务'), true;
  }

  // 「立即跑」：不看间隔、不看开关（人点它就是要现在跑一次），同步等结果
  if (one && one[2] === '/run' && req.method === 'POST') {
    const id = decodeURIComponent(one[1]);
    if (!store.getSchedule(id)) return fail(res, 404, 'E1085', '没有这个定时任务'), true;
    let out;
    try {
      out = await schedules.runNow(id);
    } catch (e) {
      // 「这个任务正在跑」这种是**请求本身不合适**，不是服务出错 → 400，让人看见原话
      return fail(res, 400, 'E1086', String(e?.message ?? e)), true;
    }
    // 200 + ok:false：请求成功了，是**这次执行**失败（原因在 error 里，界面照直说）
    return sendJson(res, 200, out), true;
  }

  return false;
}

/* ---------------------------------------------------- 本机专属接口（/api/local/*） */

/**
 * 这个请求是不是从**本机**发起的（P0-8 的唯一判据）。
 *
 * ⚠️ 为什么必须有这条：`/api/local/join` 会写 `config.json`（把"这台机器"变成别人的节点）。
 * 局域网里任何人只要能 POST 到它，就能让你的机器加入他的总机 = **机器被劫走**。
 * 所以 6 条 `/api/local/*` 每条**第一件事**都是这个判断。
 */
function isLoopbackRemote(address) {
  const a = String(address ?? '').trim().toLowerCase();
  if (!a) return false;
  if (a === '::1' || a === '127.0.0.1' || a === 'localhost') return true;
  if (a.startsWith('::ffff:127.')) return true; // IPv4-mapped（Node 在双栈 socket 上会这么报）
  return a.startsWith('127.');
}

/**
 * 节点守护进程（T03 的 `node-supervisor.mjs`）：起停与状态。
 *
 * 这个模块**还没落地**时返回 `null`，`/api/local/*` 照样能用（只是 `node.running:false`）——
 * 不让"少一个文件"变成整个本机接口 500。
 */
async function supervisorModule() {
  try {
    return await import('./node-supervisor.mjs');
  } catch {
    return null;
  }
}

/** 节点进程现在在不在跑（`external:true` = 是 autostart 拉起的那个，不是我们起的） */
async function localNodeStatus() {
  const sup = await supervisorModule();
  if (!sup) return { running: false, pid: null, external: false };
  try {
    return sup.status();
  } catch (e) {
    return { running: false, pid: null, external: false, why: String(e?.message ?? e) };
  }
}

/**
 * 这台机器上探到的 agent CLI（加入时随 body 报给总机）。
 *
 * 为什么在 server 侧算：`local-mode.mjs` **不许 import runtimes.mjs**（后者 import store，
 * 节点进程会因此去打开控制面库）。本函数与 `node.mjs` 的 `declared()` 同源、同形状。
 */
function localDeclared() {
  const out = [];
  for (const fam of runtimes.detectAll()) {
    const best = fam.candidates?.[0];
    if (!best) continue;
    out.push({ family: fam.id, label: fam.label, path: best.path, usable: !!best.usable });
  }
  return out;
}

/** 本机库的"路径 / 大小 / 最后修改 / 各有几条"（PRD P0-5：设置页常显这些东西） */
function localDataInfo() {
  let dbSize = null;
  let dbMtime = null;
  try {
    const st = fs.statSync(dbPath);
    dbSize = st.size;
    dbMtime = st.mtime.toISOString();
  } catch {
    /* 库还没建（理论上不可能，store 一 import 就建） */
  }
  return {
    dataDir,
    dbPath,
    dbSize,
    dbMtime,
    counts: {
      personas: store.listPersonas().length,
      // 「不显示」的会话也是本机数据，一起算 —— 不然用户会觉得"我的会话少了几段"
      conversations: store.listConversations().length + store.listHiddenConversations().length,
      projects: store.listProjects().length,
    },
  };
}

/**
 * 「另一个数据目录里也有节点常驻」这条**预警**（设计 §14 第 1 条，产品已确认只提示不处理）。
 *
 * 由来：`autostart` 装的节点用 `%APPDATA%\bandi-node`，而瘦客户端的 `config.json` 在
 * `%APPDATA%\bandi` —— 两个 `node.json` 不同 → 总机上会出现**两台设备**，单实例锁也管不到
 * （不同目录，锁是每数据目录一把）。本次处置：**不迁移、不自动卸载**，只说一声。
 */
function siblingDataDir() {
  const guess =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'bandi-node')
      : path.join(path.dirname(dataDir), 'bandi-node');
  return path.resolve(guess) === path.resolve(dataDir) ? null : guess;
}

function localWarnings() {
  const out = [];
  const mine = String(localMode.readClientConfig().controlPlane ?? '').trim();
  const sibling = siblingDataDir();
  if (!mine || !sibling) return out;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(sibling, 'config.json'), 'utf8'));
    const other = String(j?.controlPlane ?? '').trim();
    if (other && other === mine) {
      out.push(
        `另一个数据目录（${sibling}）里也有一个节点常驻，它会让总机上多出一台设备。` +
          '清理：node apps/server/src/autostart.mjs remove node',
      );
    }
  } catch {
    /* 没那个目录 / 没那个文件 / 坏了 —— 都不算问题 */
  }
  return out;
}

/** 导出落点的三级兜底：桌面 → 下载 → `<数据目录>/exports/`（逐级看是否真存在） */
function exportDirs() {
  const home = os.homedir();
  return [path.join(home, 'Desktop'), path.join(home, 'Downloads'), path.join(dataDir, 'exports')];
}

/**
 * 挑一个能写的落点。
 *
 * ⚠️ **不弹目录选择框**（设计 §14 第 3 条，产品已确认）：`<input type=file>` 只能选目录、
 * 不可写，实际还得让用户自己拷 —— 那就等于没做成。落点找不到桌面时退到下载目录，
 * 再不行退到数据目录下，**把完整路径用 toast 说出来**（前端拿 `file` 字段）。
 */
function pickExportDir(want) {
  const list = exportDirs();
  const fallback = list[list.length - 1];
  if (want) {
    // 只允许显式指到桌面/下载（以及那个兜底目录）—— 别让接口变成"往任意路径写文件"
    const w = path.resolve(String(want));
    const hit = list.find((d) => path.resolve(d) === w);
    if (hit) {
      fs.mkdirSync(hit, { recursive: true });
      return hit;
    }
  }
  for (const d of list) {
    try {
      if (fs.statSync(d).isDirectory()) return d;
    } catch {
      /* 这个平台没有这个目录，看下一个 */
    }
  }
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

/** 导出文件名里的时间戳（照 `db-backup.mjs` 的写法，带毫秒 —— `VACUUM INTO` 撞名会直接报错） */
function exportStamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

/**
 * 校验一份待导入的 .db 快照（2026-10-22 数据管理）。返回 null = 可导入，否则给一句人话。
 * 三道：① SQLite 文件头；② `PRAGMA integrity_check`（真开一遍库，比看头严格得多）；
 * ③ 班底的表在不在（personas / conversations）—— 拿别的 SQLite 文件来导也过不了这关。
 * 校验在**临时文件**上做，不碰现库也不碰待导入文件本体。
 */
function validateSnapshot(buf) {
  if (!buf || buf.length < 4096) return '文件太小，不像班底的库快照';
  if (buf.subarray(0, 16).toString('latin1') !== 'SQLite format 3\x00') return '不是 SQLite 数据库文件';
  const tmp = `${dbPath}.check-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, buf);
    const probe = new DatabaseSync(tmp);
    try {
      const row = probe.prepare('PRAGMA integrity_check').get();
      if (row?.integrity_check !== 'ok') return `库文件已损坏（${row?.integrity_check ?? 'unknown'}）`;
      const tables = new Set(
        probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
      );
      for (const t of ['personas', 'conversations']) {
        if (!tables.has(t)) return '不是班底的库快照（没有班底的表）';
      }
    } finally {
      probe.close();
    }
  } catch (e) {
    return `打不开这个库（${e?.message ?? e}）`;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 删不掉临时文件不算错 */ }
  }
  return null;
}

/**
 * `/api/local/*` —— **这台机器自己**的接口（2026-10-20，设计 §5.1-§5.7）。
 *
 * 为什么由本机处理：它读写的是**本机**的事实（`config.json`、本机库），总机那边没有这些；
 * 加入/退出两个入口也在它里面（client 形态已随反代移除，本机接口永远是本机答）。
 *
 * 七条：`GET status`、`POST discover / probe / join / leave / export / import`。
 * **每条之前先判回环**（P0-8）—— 见 `isLoopbackRemote` 那段。
 */
async function handleLocal(req, res, url) {
  if (!url.pathname.startsWith('/api/local/')) return false;

  if (!isLoopbackRemote(req.socket?.remoteAddress)) {
    fail(res, 403, 'E1094', '本机专属接口只能在回环上调用（远程机器不能让你加入它的总机）');
    return true;
  }

  try {
    /* ---------------------------------------------------------------- 本机身份的唯一读数 */
    if (req.method === 'GET' && url.pathname === '/api/local/status') {
      const st = localMode.status();
      st.client.node = await localNodeStatus(); // 真实状态（未加入时永远是"没在跑"）
      st.local = localDataInfo();
      st.warnings = localWarnings();
      return sendJson(res, 200, st), true;
    }

    /* ------------------------------------------------------------------------ 扫局域网 */
    if (req.method === 'POST' && url.pathname === '/api/local/discover') {
      const body = await readBody(req);
      // 空数组不是错误 —— PRD 步骤 3 的兜底页就是它；最多 4 秒返回
      const candidates = await discover.discover({ rounds: body?.rounds, port: body?.port });
      return sendJson(res, 200, { candidates }), true;
    }

    /* ---------------------------------------------------------------------- 探一个地址 */
    if (req.method === 'POST' && url.pathname === '/api/local/probe') {
      const body = await readBody(req);
      const host = await localMode.probe(body?.url); // 失败抛 LocalError（E1090/E1091/E1092/E2050）
      return sendJson(res, 200, { host }), true;
    }

    /* ------------------------------------------- 主机列表（2026-10-21 增量：列表模型）
     * add = 填了就入列（不拦探测；行上的「测试」负责验连接，2026-10-21 用户定）；
     * test = 探一次，在列的顺带刷新该行；remove = 从通讯录移除。
     * 三条都在上面那道回环闸（E1094）之后，局域网里任何人改不了这台机器的通讯录。 */
    if (req.method === 'POST' && url.pathname === '/api/local/hosts/add') {
      const body = await readBody(req);
      return sendJson(res, 201, await localMode.addHost(body?.url)), true;
    }
    if (req.method === 'POST' && url.pathname === '/api/local/hosts/test') {
      const body = await readBody(req);
      return sendJson(res, 200, await localMode.testHost(body?.url)), true;
    }
    if (req.method === 'POST' && url.pathname === '/api/local/hosts/remove') {
      const body = await readBody(req);
      return sendJson(res, 200, localMode.removeHost(body?.url)), true;
    }

    /* -------------------------------------------------------------------------- 加入 */
    if (req.method === 'POST' && url.pathname === '/api/local/join') {
      const body = await readBody(req);
      /*
       * 2026-10-21 拍板：**节点一律只当算力** —— 不信任前端的 scope，写死 compute。
       * 总机侧的 scope 机制保留（存量令牌、设备详情还认它），但「加入」这条路不再产生 panel 令牌；
       * 反代已整体移除，节点机的界面就是本地那份节点状态页。
       */
      const scopes = 'compute';
      /*
       * 顺序即设计 §5.5：已加入 → E1093；探地址（复用它那四个失败码）；换令牌；
       * 写 `config.json`（写不进去 = 500 E1097，**此时还没动任何既有状态**）。
       */
      const joined = await localMode.join({
        url: body?.url,
        code: body?.code,
        scopes,
        runtimes: localDeclared(),
        externals: await externals.declared(),
      });

      /*
       * 第 6 步：**只有含 `compute` 才起节点**（写死 compute 后恒真；保留判据是防
       * 旧配置里存过 panel-only 的 scope —— 那种机器不接活，不该被拉起节点）。
       * spawn 失败**不回滚**：加入本身已经成功了（令牌拿到了、配置写好了），
       * 返回 201 + `node:{running:false, why}`，节点下次会自己起。
       */
      let node = { running: false, pid: null, external: false };
      if (joined.scope.includes(store.SCOPE_COMPUTE)) {
        const sup = await supervisorModule();
        if (sup) {
          try {
            node = sup.start();
          } catch (e) {
            node = { running: false, pid: null, external: false, why: String(e?.message ?? e) };
          }
        } else {
          node = { running: false, pid: null, external: false, why: '节点守护还没接上：配置已写，节点不会自己起' };
        }
      }

      /*
       * 2026-10-21 修（三态互斥的两个漏，用户实报）：
       *   ① 清掉 allowLan —— 加入 = 放弃本机总机角色。不清的话，退出总机后机器会落到
       *      「总机（等重启）」，而不是回单机。
       *   ② 把监听收回环 —— 之前是总机的话现在听着 0.0.0.0，加入后到下次重启前一直敞着，
       *      和"已加入必须只听回环"（restartListening 里那条）直接矛盾。
       * 先回响应再动监听：同 `/api/lan` 的写法，否则浏览器拿不到这个 201。
       */
      try {
        netmode.writeNetMode(false);
      } catch (e) {
        console.warn(`[本机] 加入后清 allowLan 失败：${e?.message ?? e}`);
      }
      console.log(`[本机] 加入了「${joined.hostLabel}」（${joined.controlPlane}）· 只当算力（${joined.scope.join('+')}）`);
      sendJson(res, 201, {
        ok: true,
        hostLabel: joined.hostLabel,
        hostHostname: joined.hostHostname,
        controlPlane: joined.controlPlane,
        scope: joined.scope,
        node,
      });
      setTimeout(restartListening, 80); // 让 201 先发出去，再把监听收回环
      return true;
    }

    /* ---------------------------------------------------------------------- 退出总机 */
    if (req.method === 'POST' && url.pathname === '/api/local/leave') {
      if (!localMode.isJoined()) {
        return fail(res, 400, 'E1098', '这台机器还没加入任何总机'), true;
      }
      /*
       * **先停节点，再清配置**（顺序不能反）：反过来的话，那个还活着的节点进程会拿着
       * 刚被清掉的令牌再请求一次（401 `E4012`），日志里就是一堆看不懂的红字。
       */
      let killed = false;
      let note = null;
      let autoRemoved = false;
      const sup = await supervisorModule();
      if (sup) {
        try {
          const r = sup.stop();
          killed = !!(r && (r.killed ?? r.stopped ?? r.ok));
          if (r?.external && r?.stopped === false) {
            /*
             * 2026-10-21 修：开机自启拉起的节点原来只留一句提示 —— 界面照样说"退出成功"，
             * 节点却拿着刚清掉的令牌空转（用户实报）。「退出总机」就是不再当节点，
             * 所以这里**连自启一起收掉**：
             *   · 先移除自启登记（Linux 那套 systemd remove 会顺手 --now 停掉）；
             *   · 再按锁里的 PID 停进程（Windows 的 remove 只删启动脚本，不停进程）。
             */
            try {
              const auto = await import('./autostart.mjs');
              auto.remove('node');
              autoRemoved = true;
            } catch (e) {
              note = `开机自启没移除成功：${e?.message ?? e}（手动：node apps/server/src/autostart.mjs remove node）`;
            }
            try {
              const r2 = sup.stopExternal?.();
              if (r2?.stopped) killed = true;
              else if (r2?.mismatch) note = (note ? note + '；' : '') + '锁里的进程不是节点，没动它';
              else if (r2?.running && !note) note = '节点进程没停掉；下次开机不会再自启';
            } catch (e) {
              note = (note ? note + '；' : '') + `停自启节点出错：${e?.message ?? e}`;
            }
          }
        } catch (e) {
          console.warn(`[本机] 停节点时出错（继续退出总机）：${e?.message ?? e}`);
        }
      }
      const out = localMode.leave(); // 只清 config.json 里那七个字段，node.json 保留
      /*
       * 退出后**一定回单机**（2026-10-21）：不清 allowLan 的话，之前开过总机的机器会落到
       * 「总机（等重启）」—— 与「退出总机，回到本机」的文案和"三态互斥"都不符。
       */
      try {
        netmode.writeNetMode(false);
      } catch (e) {
        console.warn(`[本机] 退出后清 allowLan 失败：${e?.message ?? e}`);
      }
      console.log('[本机] 已退出总机 —— 本机数据原样（从来没被写过）');
      return sendJson(res, 200, { ok: true, killed, autoRemoved, note, local: localDataInfo(), nodeId: out.nodeId }), true;
    }

    /* ------------------------------------------------------------------------ 导出 */
    if (req.method === 'POST' && url.pathname === '/api/local/export') {
      const body = await readBody(req);
      let file;
      try {
        const dir = pickExportDir(body?.dir);
        file = path.join(dir, `bandi-备份-${exportStamp()}.db`);
        store.backupTo(file); // VACUUM INTO：库开着 WAL，直接拷 .db 会漏事务
      } catch (e) {
        return fail(res, 500, 'E1096', `导出失败：写不进那个目录（${e?.message ?? e}）`), true;
      }
      const size = fs.statSync(file).size;
      console.log(`[本机] 导出一份：${file}（${(size / 1048576).toFixed(2)} MB）`);
      return sendJson(res, 200, { file, size }), true;
    }

    /* ------------------------------------------------------------------------ 导入 */
    /*
     * 导入 = 拿一份班底导出的 .db 快照**覆盖本机数据**（2026-10-22 数据管理）。
     * 分两步走，接口只做第一步：
     *   ① 这里：校验（SQLite 头 / integrity_check / 班底的表在不在）→ 把快照写成
     *      `<dbPath>.importing`。当前库**一个字节都不动**，导出照常可用；
     *   ② 换库在 store.mjs 模块加载（下一次启动、连接打开之前）—— 那时零并发风险，
     *      现库三件套自动改名进 backups/导入前-<时间戳>.*，坏了可以整体搬回来。
     * 所以响应里必须把"重启后生效"说明白，前端 toast 也这么说。
     */
    if (req.method === 'POST' && url.pathname === '/api/local/import') {
      const buf = await readRawBody(req);
      const err = validateSnapshot(buf);
      if (err) return fail(res, 400, 'E1099', `导入没成功：${err}`), true;
      fs.writeFileSync(`${dbPath}.importing`, buf);
      console.log(`[本机] 收到导入快照（${(buf.length / 1048576).toFixed(2)} MB），重启后生效`);
      return sendJson(res, 200, { ok: true, size: buf.length, note: '重启班底后生效' }), true;
    }
  } catch (err) {
    if (err instanceof localMode.LocalError) {
      fail(res, err.status, err.code, err.message, err.detail ? { detail: String(err.detail) } : null);
      return true;
    }
    throw err; // 其余交给顶层 catch（500 E5004）
  }

  fail(res, 404, 'E2036', '没有这个本机接口');
  return true;
}

let boundHost = host;

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
    if (!auth.guard(AUTH, req, res, url)) return;

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

server.listen(port, boundHost, logListen);

/**
 * 启动横幅。抽成函数是为了**原地重启之后能再打一遍** ✓
 * —— 不重打的话，日志里"监听 127.0.0.1"会一直骗着后面看日志的人 ✗。
 */
function logListen() {
  /*
   * **UDP 应答器跟着监听地址原地启停**（2026-10-20，设计 §5.5 之一）：
   * 启动那一刻、以及每次「重启生效」之后都要对一次 ——
   * `sync` 的判据是"开关开 且 真的听着非回环"，所以这里传的是 `boundHost`（实际监听）。
   */
  lanAnnounce.sync({ allowLan: netmode.readNetMode().allowLan, explicit: !!process.env.BANDI_HOST, boundHost, httpPort: port });
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
  if (want === boundHost) {
    console.log(`[网络] 重启监听：本来就是 ${boundHost}，不用动`);
    /*
     * 这里也要对一次（设计 §5.5 的三处同步点之一）：开关可能刚变过、而监听地址恰好没变
     * （比如 `BANDI_HOST` 显式指定着，或者本来就在回环上）—— 应答器该停就得停。
     */
    lanAnnounce.sync({ allowLan: netmode.readNetMode().allowLan, explicit: !!process.env.BANDI_HOST, boundHost, httpPort: port });
    return;
  }
  console.log(`[网络] 重启监听：${boundHost} → ${want}`);
  server.close(() => {
    boundHost = want;
    // 鉴权要跟着新的监听地址重算（"只看监听地址"那条规则）
    Object.assign(AUTH, auth.setup({ host: want, dataDir, envToken: process.env.BANDI_TOKEN }));
    /*
     * UDP 应答器同步（三处同步点之二）：**在 listen 之前**把上一份停掉 ——
     * 开关是关的时候就这一下就够（`sync` 见到 on=false 直接 stop，不等 listen 回调）。
     * 开关是开的时候它会重新 bind，`logListen` 里那次是幂等的第二遍。
     */
    lanAnnounce.sync({ allowLan: netmode.readNetMode().allowLan, explicit: !!process.env.BANDI_HOST, boundHost, httpPort: port });
    server.listen(port, boundHost, logListen);
  });
  // 挂着的长轮询（领活那种 20 秒的）别挡着 close 回调 —— 节点收到断开自己会重连 ✓
  server.closeAllConnections?.();
}
