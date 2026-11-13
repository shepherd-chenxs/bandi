import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { port, repoRoot, host, hostSource, dataDir, dbPath, extraOrigins, trustProxy, localSecretDisabled } from './config.mjs';
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
import { dispatchToThread, drainGroupQueue, personaRoots } from './dispatch.mjs';
import { ensureCliInstalled } from './cli-install.mjs';
import * as workflows from './workflows.mjs';
import * as prReview from './pr-review.mjs';
import * as prCreate from './pr-create.mjs';
import * as selfDelivery from './self-delivery.mjs';
import * as quota from './quota.mjs';
import * as status from './status.mjs';
import { projectTasks, allTasks, personaTasks, createProjectTask, updateProjectTask, startProjectTask, onTaskRunFinished, afterMerged, upsertRepoCard, ensureTaskCardForStep } from './project-tasks.mjs';
import * as git from './git-repos.mjs';
import * as schedules from './schedules.mjs';
import * as steward from './steward.mjs';
import * as experts from './experts.mjs';
// 岗位与权限（2026-11-11）：岗位系统内置、权限挂在岗位上（见 roles.mjs / 设计文档）
import * as roles from './roles.mjs';
import * as localMode from './local-mode.mjs';
import * as lanAnnounce from './lan-announce.mjs';
import * as localSecret from './security/local-secret.mjs';
import * as tlsCheck from './security/tls-check.mjs';
import { isLoopbackHost } from './security/source.mjs';
// 域模块（路由）**不在这里逐个 import**（2026-11-08）：谁先谁后、都有哪些，
// 全在 routes/chain.mjs 那张表里 —— 顺序是契约，得能一眼审、能机器查。
import { runChain } from './routes/chain.mjs';
// 飞书通道的服务端本体（不是路由）：启动时要 bootSync 把旧配置迁给对应员工
import * as feishu from './feishu.mjs';
import { handleLocal } from './routes/local.mjs';
// 身份中枢进门（2026-11-06）：`GET /hub/enter?ticket=…` —— 验票 → 查本地授权表 → 发会话
import { handleHub } from './routes/hub.mjs';
import * as hub from './hub/join.mjs';
import { sendJson, fail, readBody, guardWrite, guardHost, serveStatic, BadRequest, allowedOrigins, webDir, cspHeader } from './http.mjs';
import { SERVER } from './server-state.mjs';
import { runtimeOptions, runtimesOk, withExternals } from './runtime-view.mjs';
// CSRF 双提交（IAM §10.2，2026-10-31 Phase 1 收尾）：Cookie bandi_csrf 与请求头
// X-Bandi-CSRF 必须一致 —— 第三道闸，与 guardWrite 的 Origin / X-Bandi 并存
import * as csrf from './security/csrf.mjs';
// 网络周界闸（2026-11-03，对齐 1Panel 安全页）：授权 IP 白名单 + 域名绑定，
// 排在 guardHost 之后、令牌闸之前 —— 名单外的 IP 连登录口都不给摸
import { guardNetwork } from './security/ipallow.mjs';

/** 客户端 IP（审计与会话记录用；IPv4-mapped 前缀剥掉） */
const clientIp = (req) => String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
/** 写审计的 kind 标签（轻映射，别过度工程 —— 查询时按它筛） */
function auditKindOf(pathname) {
  if (pathname === '/api/logout') return 'session.revoke';
  if (pathname.startsWith('/api/local/')) return 'machine.local';
  if (pathname.startsWith('/api/users')) return 'user.change';
  return 'write';
}



function helloPayload() {
  const hostname = os.hostname() || '未命名机器';
  return {
    platform: 'bandi',
    proto: 1,
    // 版本读 apps/desktop/version.json（运行期读一次缓存；读不到给 null，不编一个）
    version: localMode.platformVersion(),
    instanceId: localMode.instanceId(),
    label: hostname,
    hostname,
    /*
     * 这台机器**自己的**操作系统（2026-11-07）：「我的」页的「系统 / 版本」原先取
     * `navigator.platform` —— 那是**看页面那台电脑**的平台（Windows 上远程看 Linux
     * 主机会显示 Win32，名不副实）。机器的系统只有服务端自己知道，由它报。
     * 用 `os.type()` 而不是 `os.platform()`：前者已经是人话（Linux / Darwin / Windows_NT）。
     */
    os: `${os.type()} ${os.release()} ${os.arch()}`.replace(/^Windows_NT/, 'Windows'),
    httpPort: port,
    /*
     * 2026-11-08：`relay` 字段**已下线**。
     *
     * 它原本上报 frpc 子进程的真实状态（off / unavailable / up / retrying / failed），
     * 前提是隧道由 bandi 自己拉起。用户决定不再内置 frp —— 进程归外部管，
     * 这里就无从知道它通不通，硬留着只会给出半真半假的状态。宁可没有。
     *
     * 注意：`hub/relay.mjs` 仍然活着，但它现在只服务一件事 —— 让 http.mjs 的
     * Host 守卫与写请求 Origin 白名单认识那个公网域名（见该文件头注释）。
     * 自己装 frp 的人把域名写进 `<数据目录>/tunnel.json`，闸门就放行；
     * 不写也不会坏，只是从公网进来的写请求会被 403。
     */
  };
}

/**
 * 给一台设备补上「外部件」（班底之外还要有的东西，现在只有 magpie）。
 *
 * **本机现探**（那台机器就是控制面自己）。
 * `catalog` 是那张说明表：界面靠它把"没装"的东西也画出来（不然一片空白，用户不知道缺什么）。
 */

const routes = {
  /**
   * **免令牌**（见 auth.mjs 里 guard 顶部那条放行）：加入向导"探这个地址"打的就是它。
   *
   * 披露的东西与 UDP 应答同源 —— 机器名 / 主机名 / 端口 / 版本。
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
    /*
     * 「我」是谁（2026-10-31 用户概念落地）：登录用户是他自己；回环 / 共享令牌的操作员
     * 是**第一个用户**（"本机自动登录"，像一台共用电脑——没人显式登录时活都算机主的）；
     * 还没有任何用户 → 维持 LOCAL_USER 占位。手机设备令牌同样占位（设备不是人）。
     */
    const actor = auth.actorUser(req);
    sendJson(res, 200, {
      runtimes: runtimeOptions(),
      repoRoot,
      platformRoot: repoRoot,
      me: actor ? { id: actor.id, name: actor.name } : store.LOCAL_USER,
      /*
       * 账号名册（2026-10-31）：通讯录的「成员」段与看板派活选真人用。
       * 只有 id / 名字 / 是不是内置 —— "团队里有谁"不是秘密，不要求管理权限；
       * salt/hash 与增删改仍在 mayManage 后面（/api/users）。
       */
      users: store.listUserBriefs(),
      // 信箱未读数（2026-11-11）：左栏「信箱」徽标；页面打开时 /api/notices 会再给一份
      noticesUnread: store.countUnreadNotices(),
      /*
       * 岗位与权限（2026-11-11，Phase 2）：岗位是系统内置的，前端画岗位名、筛"能承接
       * 团队协作的群"都要用它 —— 跟 /api/state 一起下发，免得 5 秒轮询再单开一个接口。
       * 只读快照：权限定义在 roles.mjs，改口径只能发版。
       */
      roles: roles.publicRoles(),
      permissions: roles.PERMISSIONS,
      /*
       * 状态字典（2026-11-12）：状态只有码，中文名是码的 label。前端**不自己写一份**
       * （那就是第二套状态表），跟着 /api/state 一起拿，渲染时查表。
       * 键是码、值是显示名：{ task: {todo:'待办',…}, run: {…}, workflow: {…}, node: {…} }
       */
      statusDict: store.statusDictionary(),
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
      /*
       * **这个请求从哪来 + 破坏性动作要不要秘密**（2026-10-31，IAM §10.1.3）。
       * 前端据此**显隐**破坏性按钮：服务器形态（`localSecret: 'required'`）下浏览器里
       * 不渲染「导出 / 导入 / 协作加入」这些按钮（它们要由本机终端用 CLI 执行），
       * 而不是渲染出来再报 E4097 —— 那等于给用户一个永远点不动的按钮。
       * `source` 同时给"当前是不是本机"的判断用，页面**不猜**。
       */
      source: req.bandiSource ?? 'loopback',
      localSecret: localSecret.mode(),
    });
  },

  /**
   * 信箱（2026-11-11 用户拍板）：左栏一级栏，先接"建卡失败"这类平台事实，以后还能接别的通知。
   * GET 列表按更新时间倒序（同一件事重试了会冒到最上面）；未读数给左栏徽标。
   */
  'GET /api/notices': async (req, res) => {
    sendJson(res, 200, { notices: store.listNotices({ limit: 100 }), unread: store.countUnreadNotices() });
  },

  /** 徽标轮询用的轻量口：只回未读数 */
  'GET /api/notices/unread': async (req, res) => {
    sendJson(res, 200, { unread: store.countUnreadNotices() });
  },

  /** 标记已读：body { id } 单条，或 { all: true } 全部；回剩余未读数 */
  'POST /api/notices/read': async (req, res) => {
    const body = await readBody(req);
    const unread = body?.all === true
      ? store.markAllNoticesRead()
      : body?.id
        ? store.markNoticeRead(String(body.id))
        : store.countUnreadNotices();
    sendJson(res, 200, { unread });
  },

  /**
   * 删除通知（2026-11-12 用户："加删除功能，支持批量删除"）：
   * body { ids: [...] }（一条也行多条也行）或 { all: true } 清空；回 { removed, unread }。
   * 确认弹窗在前端做（confirmDo），服务端只认单据不拦人。
   */
  'POST /api/notices/delete': async (req, res) => {
    const body = await readBody(req);
    sendJson(res, 200, store.deleteNotices({ ids: body?.ids, all: body?.all === true }));
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
   * 项目进度总览 —— 「研发面板」（插件 project-panel）的数据源（只读）。
   *
   * 项目清单来自平台自己的项目账本，但**只出被选中纳管的那些**（2026-10-27 用户：
   * 「要能选择把哪些项目纳管进来」）。没选进来的项目不是"出错"，是不在关心范围里 ——
   * 全摊出来再把读不到进度文件的标红，等于让噪音把进度淹掉。
   * 选哪些在 `GET /api/status/ledger`（账本全量）+ `POST /api/status/managed`（整表提交）。
   *
   * 纳管进来但读不到 `.bandi/status.yaml` 的**照样列出来**（标「缺进度文件」），
   * 不自动踢出去、不猜 —— 那是"该去补一份"，不是"不该纳管"。
   */
  'GET /api/status/projects': async (req, res) => {
    // 人名由这一层查（status.mjs 只读文件、不碰库；见 routes/status.mjs 的说明）
    sendJson(res, 200, { projects: status.listProjectCards(store.listManagedProjects(), (id) => store.getPersona(id)) });
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
    /*
     * 岗位 key（2026-11-11）：权限只认它，**只收内置清单里的 key**。
     * 没带就按旧 role 文本映射一次（store.createPersona 兜底）—— 过渡期兼容
     * 老前端与冒烟；Phase 2 前端换成岗位下拉后，这条兜底删掉。
     */
    const roleKey = body.roleKey ? String(body.roleKey).trim() : null;
    if (roleKey && !roles.isRoleKey(roleKey)) {
      return fail(res, 400, 'E1014', `岗位不在内置清单里：「${roleKey}」—— 岗位是系统内置的，只能从清单里选`);
    }
    // 模型名**不再校验**：以前要对着账本查"有没有这个模型"，账本已经下架了。
    // 现在的权威是 CLI 自己 —— 名字填错了它会报，班底替它把关只会把新模型挡在门外。
    const persona = store.createPersona({
      name,
      // 岗位文本：自由展示用（Phase 2 前端改成岗位下拉），权限判定不读它
      role: String(body.role ?? '').trim() || null,
      roleKey,
      // 部门：跟岗位一个口径 —— 自由文本、可空，只用于通讯录按部门分组
      department: String(body.department ?? '').trim() || null,
      instructions: String(body.instructions ?? ''),
      runtime,
      sandbox: String(body.sandbox ?? 'danger-full-access'),
      cwd: body.cwd ? String(body.cwd) : repoRoot,
      model: body.model ? String(body.model) : null,
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

  /**
   * 岗位清单（2026-11-11）：岗位是系统内置的，权限挂在岗位上（见 roles.mjs / 设计文档）。
   * 只读一下发：界面据此画岗位下拉与"这个岗能干什么"的只读矩阵；改口径只能发版。
   */
  'GET /api/roles': async (req, res) => {
    sendJson(res, 200, { roles: roles.publicRoles(), permissions: roles.PERMISSIONS });
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

SERVER.AUTH = auth.setup({ host, dataDir, envToken: process.env.BANDI_TOKEN, trustProxy });

/*
 * **本机文件秘密**（IAM §5.2）：服务器形态下"我在本机"的唯一证明。
 * 启动即生成（0600，一次生成、之后复用）—— 生不成也不拦启动：只是破坏性动作一律 E4097。
 */
localSecret.ensure();
if (localSecretDisabled) {
  console.warn('[安全] BANDI_LOCAL_SECRET=off：破坏性本机动作（导出/导入/加入）不再要求 X-Bandi-Local —— 请确认反代已 deny 这些路径');
}
/*
 * 这个进程**现在**听的是哪儿 —— `SERVER.boundHost`（`server-state.mjs`）。
 * 监听地址整个进程生命周期不变（2026-11-03 起没有"原地重启监听"这回事了），
 * 但它仍可能不等于 `config.host` 的字面量（`0.0.0.0` 实际 bind 后的回报），照实分辨。
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



const server = http.createServer(async (req, res) => {
  /*
   * **安全响应头**（2026-11-08）：装在请求链最前面，**先于一切判断** ——
   * 包括 Host 闸 / 网络周界闸拒绝的那几条 403（拒绝页也不该能跑脚本）。
   *
   * CSP 的来由见 security/csp.mjs 的文件头：界面靠 innerHTML 拼字符串 + 849 处 esc()，
   * 漏一次就是存储型 XSS；CSP 把「漏转义」从必然出洞降级成被浏览器挡住。
   * 它是兜底，不替代 esc() —— 两件事都要做。
   *
   * nosniff：静态文件按扩展名给 Content-Type，禁止浏览器自作聪明改写（MIME 嗅探 XSS）。
   */
  res.setHeader('Content-Security-Policy', cspHeader());
  res.setHeader('X-Content-Type-Options', 'nosniff');

  /*
   * Host 守卫排在一切之前（含令牌闸）：rebind 页面的请求 Host 是攻击者域名，
   * 连"来源对不对"都不该让它摸到面板数据（http.mjs 的 guardHost 注释）。
   */
  const badHost = guardHost(req);
  if (badHost) {
    // DNS rebinding / 未声明 Host：策略层拒绝，审计当场记（IAM §11.2：handler 不参与）
    try {
      store.deny({ kind: 'authz.deny', action: `${req.method} ${new URL(req.url, 'http://x').pathname}`, reason: `E3002 ${badHost}`, ip: clientIp(req), ua: req.headers['user-agent'] ?? '' });
    } catch { /* 审计绝不拖垮请求 */ }
    return fail(res, 403, 'E3002', badHost);
  }

  /*
   * 网络周界闸（2026-11-03）：授权 IP 白名单（E3003）与域名绑定（E3004）。
   * 与 Host 守卫同一层 —— 排在令牌闸**之前**：名单外的来源连登录口都别摸，
   * 这才对得起"网络层的门"。拒绝同样当场记审计，口径与上一条一致。
   */
  const netDenied = guardNetwork(req);
  if (netDenied) {
    try {
      store.deny({ kind: 'authz.deny', action: `${req.method} ${new URL(req.url, 'http://x').pathname}`, reason: `${netDenied.code} ${netDenied.message}`, ip: clientIp(req), ua: req.headers['user-agent'] ?? '' });
    } catch { /* 审计绝不拖垮请求 */ }
    return fail(res, 403, netDenied.code, netDenied.message);
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  /*
   * **健康探测口**（2026-11-08）：`GET /api/ping` —— 排在令牌闸**之前**、免鉴权、不记审计。
   *
   * 为什么必须有：桌面壳的健康巡检（lib.rs 的 watch_service，每 1~2 秒一次）以前探的是
   * `/api/state`，监听 0.0.0.0 时鉴权全开，每次探测都吃 401 → 审计每分钟多出几十条
   * 「拒绝访问」（2026-11-08 用户在审计页看到的成串 E4010 就是它）。探测只需要
   * "端口上有个班底在回话"这一个比特，`{ ok, platform:'bandi' }` 之外什么都不带 ——
   * 而 `platform` 这个字段 401 响应体里本来就带，这里零新增信息暴露。
   * HEAD 也放行（探测方只看状态行时用得上）。
   *
   * **2026-11-10 晚加 `authRequired`**：桌面壳的 `windowUrl()` 原来只能裸打 `/api/state`、
   * 拿 401 反推"这次要不要自动进门" —— 每开一次壳就在审计里留一行「拒绝访问」，
   * 与真的有人在扫面板分不开（用户当晚截图问"这个拒绝访问是不是有问题"）。
   * 这个字段就是"鉴权闸开没开"的一个比特：**信息量等于 401 状态码本身**
   * （拿任意 `/api/*` 试一下有没有凭据都看得出来），不是秘密。壳拿到 false 直接开窗口，
   * 拿到 true 才走 `/shell/enter` —— 壳启动不再产生 401，审计里那类噪音归零。
   * 老客户端（Rust 看门狗 / `lifecycle.isUp`）只读 `platform`，多一个字段不影响。
   */
  if (url.pathname === '/api/ping' && (req.method === 'GET' || req.method === 'HEAD')) {
    return sendJson(res, 200, { ok: true, platform: 'bandi', authRequired: !!SERVER.AUTH.required });
  }

  try {
    /*
     * 访问令牌：**排在来源闸前面** —— 没令牌的请求，连"来源对不对"都不该让它摸到。
     * 闸开不开只看监听地址（回环免鉴权 / 非回环全要），见 auth.mjs 的长注释。
     */
    if (!auth.guard(SERVER.AUTH, req, res, url)) {
      // guard 拒绝的（401 / 403 / 受限会话…）它自己已经在响应里写好了状态码 ——
      // 这里只补审计；200 的假响应（登录页 HTML）不记。
      // **只记 API 口**（2026-11-09 降噪）：静态资源（/style.css、/js/*.mjs、/favicon、
      // /manifest.webmanifest…）被 401 挡下不是安全事件，记了只会把审计刷成噪音
      // （本机归档里 94% 是这类重复行）。Host / IP 周界那两道闸在更前面，照旧记。
      if (res.statusCode >= 400 && url.pathname.startsWith('/api/')) {
        try {
          store.deny({ kind: 'authz.deny', action: `${req.method} ${url.pathname}`, reason: `HTTP ${res.statusCode}`, ip: clientIp(req), ua: req.headers['user-agent'] ?? '' });
        } catch { /* 不拖垮 */ }
      }
      return;
    }

    /*
     * **写操作审计**（IAM §11.2，2026-10-31 Phase 1 收尾）：授权过后立刻写一条
     * `pending`，响应收尾把**同一行**改成 ok / fail —— handler 漏不掉（它根本不参与）。
     * 覆盖整个 /api/* 写请求（含 handleLocal，它在这之后跑）。
     */
    let auditId = null;
    if (url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const actor = req.bandiAuth ?? {};
      auditId = store.add({
        kind: auditKindOf(url.pathname),
        actorKind: actor.kind ?? null,
        actorId: actor.userId ?? actor.deviceId ?? null,
        action: `${req.method} ${url.pathname}`,
        ip: clientIp(req),
        ua: req.headers['user-agent'] ?? '',
      });
      res.on('finish', () => {
        store.resolve(auditId, {
          result: res.statusCode < 400 ? 'ok' : 'fail',
          reason: res.statusCode >= 400 ? (req.bandiDenyReason ?? `HTTP ${res.statusCode}`) : null,
          httpStatus: res.statusCode,
        });
      });
    }

    /*
     * **本机专属接口**（2026-10-20，设计 §1.2 新增 A）。
     *
     * 位置在 `auth.guard` **之后**：令牌语义只有一处，别在两处各判一遍。
     * （回环形态下闸本来就全放行；若有人 `BANDI_HOST=0.0.0.0` 强开，
     *   `/api/local/*` 仍会被令牌闸保护 **＋** 自己那道回环校验，是双保险 —— P0-8。）
     */
    const handledLocal = await handleLocal(req, res, url);
    if (handledLocal !== false) return;

    /*
     * 身份中枢进门（2026-11-06）：`GET /hub/enter?ticket=…`。
     * 排在静态资源之前 —— 它不是一个文件，而是一次「验票换会话」的动作
     * （`serveStatic` 会按路径找文件，先到那里就变成 404 了）。
     */
    const handledHub = await handleHub(req, res, url, { dataDir, port });
    if (handledHub !== false) return;

    if (!url.pathname.startsWith('/api/')) {
      /*
       * CSRF 值的自愈补种（2026-11-01）：浏览器里可能只有 `bandi_sid` 而没有
       * `bandi_csrf`（老版本种的 Cookie、或用脚本/工具手工设过令牌），这时所有写请求
       * 都会 E4099，用户看到的就是"按钮点了没反应"。每个 HTML 页面响应顺手补一枚
       * （已有就不动）—— 打开一次页面即自愈。
       *
       * 2026-11-08 起 HTML 出口三条：登录页（`/hub/login`）、主页面、以及给壳的
       * 会话过期兜底页（`/hub/expired`，壳正常会拦下它、不真加载）。扫码落地页早随
       * 设备令牌体系退场了；这一层仍然要有：`bandi_csrf` 只活 1 天、`bandi_sid` 活
       * 30 天，"凭据还在、csrf 先过期"是常态，不是意外。
       */
      const wantsHtmlPage = url.pathname === '/'
        || url.pathname.endsWith('.html')
        || String(req.headers.accept ?? '').includes('text/html');
      if (wantsHtmlPage && !csrf.valuesOf(req).cookie) res.setHeader('Set-Cookie', csrf.cookieFor(csrf.mint()));
      if (serveStatic(req, res, url.pathname)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('没有这个文件');
      return;
    }

    const key = `${req.method} ${url.pathname}`;

    // 写请求先过来源守卫（CSRF）：任何网页借你的浏览器发的写请求都在这里被拦下。
    // 拒绝原因挂在 req 上 —— 上面那条 pending 审计在 finish 回填时把它带进 reason，
    // 不另记一行（同一请求只留一条历史，§11.2）。
    const denied = guardWrite(req);
    if (denied) {
      req.bandiDenyReason = `E3001 ${denied}`;
      return fail(res, 403, 'E3001', denied);
    }
    // CSRF 双提交（§10.2 第三道）：带 Cookie 凭据的写请求，bandi_csrf Cookie 与
    // X-Bandi-CSRF 头必须一致（CLI / 脚本走 X-Bandi-Token 头，浏览器不会自动带，天然豁免）
    const csrfDenied = csrf.check(req);
    if (csrfDenied) {
      req.bandiDenyReason = 'E4099 csrf double-submit mismatch';
      return fail(res, 403, 'E4099', csrfDenied);
    }

    if (routes[key]) return await routes[key](req, res);

    /*
     * **正则链**：所有带动态段的 /api 路径交给 routes/chain.mjs 那张表按顺序问一遍。
     *
     * 改造前这里是 25 段「`const handledX = await handleX(...); if (handledX !== false) return;`」
     * —— 顺序只存在于书写顺序里，加模块要"插在对的位置"，而注释里到处写着的
     * 「主分发顺序见 server.mjs 的 CHAIN」指的是一个**并不存在**的符号。
     * 现在顺序是数组下标，漏挂/重挂由 tools/check-dispatch-chain.mjs 在 PR 门禁里查。
     */
    if (await runChain(req, res, url)) return;

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
// PR 审阅与合并（2026-10-23）：pr-review.mjs 在 import 时注册动作节点（pr-merge），这里保证内建模板在
prReview.ensurePrReviewTemplate();
// PR 交付流程（2026-10-25）：pr-create.mjs 在 import 时注册动作节点（pr-create），这里保证模板在
prCreate.ensurePrDeliveryTemplate();
// 自主交付流程（2026-11-13）：保证内建模板存在并发布，全程无人工拍板节点
selfDelivery.ensureSelfDeliveryTemplate();
// 出厂就有一个人能说话：内置系统管家「崔老三」（2026-10-23 前是秘书「喜儿」；幂等，已有则只补 builtin 标记）
// **部署即装**（2026-10-22）：不管谁部署、用什么方式起（安装包 / 源码 start.cmd /
// systemd / 开机自启），服务起来那一刻「bandi」全局命令就在。幂等 —— 装好了什么都不写。
// 闸门与实现见 cli-install.mjs（BANDI_DATA 显式指定 = 测试/沙箱，默认不动真实用户目录）。
try {
  const cliNote = await ensureCliInstalled();
  if (cliNote) console.log(cliNote);
} catch { /* 上面保证不抛，这里兜一层：装命令失败不能拦启动 */ }
try {
  const seeded = steward.ensureSteward();
  if (seeded.created) console.log(`新建了内置员工「${seeded.persona.name}」`);
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
// 内置员工同理（2026-10-22 用户定：按专家团模式收编）——技能挂载与身份三件回出厂，
// 路由层同步锁死（E2054 技能 / E2055 身份）。他比专家早一步 seed，这里紧跟着做增量重置。
// 2026-10-23 名额换人（喜儿→崔老三）的存量迁移也走的这段：启动即把库里的旧身份刷成新出厂值。
try {
  const reset = steward.syncSteward();
  if (reset?.length) console.log(`内置员工已重置回出厂（${reset.join(' / ')}）`);
} catch (err) {
  console.log(`内置员工同步失败（不影响启动）：${err?.message ?? err}`);
}
// 内置连接器（2026-10-26）：SSH 工具随「工作台 → 研发 → 远程连接」出厂自带（幂等，已有只补 builtin 标记）
try {
  const seeded = connectors.ensureBuiltinConnectors();
  if (seeded.length) console.log(`内置连接器已就位：${seeded.join('、')}`);
} catch (err) {
  console.log(`内置连接器 seed 失败（不影响启动）：${err?.message ?? err}`);
}
// 过期登录会话（2026-10-28 第三刀）：启动时扫一次就够 —— 不需要定时器
// （平时 `userBySession` 撞到过期的也会顺手删，这里只是把"没人再来的"批量收掉；
//   2026-10-31 起四道口径一起清：expiresAt 30 天 / 绝对 12h / 空闲 30min）
try {
  const pruned = store.pruneSessions();
  if (pruned) console.log(`清掉 ${pruned} 条过期登录会话`);
} catch (err) {
  console.log(`清理过期登录会话失败（不影响启动）：${err?.message ?? err}`);
}
// 存量会话迁移（IAM §9，2026-10-31）：老库的会话没有空闲/绝对两道闸 ——
// 按"12 小时内自然过期"的缓冲口径补上，不追溯不踢人。幂等：已迁过的行不动。
try {
  const migrated = store.migrateLegacySessions();
  if (migrated) console.log(`[安全] ${migrated} 条存量会话已按新规则迁移（12 小时内自然过期）`);
} catch (err) {
  console.log(`存量会话迁移失败（不影响启动）：${err?.message ?? err}`);
}
// 审计归档（IAM §11.2）：security_events 保留 90 天，启动时搬一批进 archive 表 ——
// 触发器挡着 DELETE，归档是唯一合法的清理路（见 store/audit.mjs 的 archive 注释）
try {
  const archived = store.archive(90);
  if (archived) console.log(`[安全] 审计已归档 ${archived} 条（保留 90 天）`);
} catch (err) {
  console.log(`审计归档失败（不影响启动）：${err?.message ?? err}`);
}
// 归档表保留期（2026-11-09，给增长封顶）：主表 90 天、归档 1 个月 —— 归档原先只增不减。
// 跟主表归档一样**只在启动时跑一次**（没有定时器）；清理本身留一条 audit.prune 痕。
try {
  const prunedArchive = store.pruneArchive();
  if (prunedArchive) console.log(`[安全] 审计归档已清理 ${prunedArchive} 条（归档保留 ${store.ARCHIVE_KEEP_DAYS} 天）`);
} catch (err) {
  console.log(`审计归档清理失败（不影响启动）：${err?.message ?? err}`);
}
runs.onRunFinish(workflows.onAgentRunFinished);
// 任务卡同理（2026-10-17）：运行跑完/被停/跑挂了，卡不能永远挂在「进行中」——
// 完成 → 待验收；人停的 → 已阻塞、跑挂的 → 失败（都不回「待办」，否则会被自动重新派活 → 死循环）
runs.onRunFinish(onTaskRunFinished);
// 群里 @ 多人的排队（2026-10-24）：会话一次只跑一个 —— 前一个收尾，队里下一个立刻补上。
// 挂在流程/任务卡钩子之后：它们推进的是各自 exec 会话的活，跟群排队互不挡道。
runs.onRunFinish((run) => {
  try {
    drainGroupQueue(run.conversationId);
  } catch (e) {
    console.error('[群聊] 排队补派失败：', e?.message ?? e);
  }
});
// 进程重启会把在跑的执行判死（reapStaleRuns），可工作流的任务还写着「进行中」——
// 那条任务就永远卡住了。所以启动时把这类任务也收尾，别让人对着一个假"进行中"等。
const stuckTasks = store
  .listWorkflowRuns()
  .filter((r) => r.status === 'doing')
  .flatMap((r) => store.listWorkflowTasks(r.id))
  .filter((t) => t.status === 'doing');
for (const t of stuckTasks) {
  store.updateWorkflowTask(t.id, {
    // **「已阻塞」不是「进行中」**：进程重启后这次执行已经没了，
    // 还写"进行中"的话界面上计时器继续走、徽标说在跑 —— 但它永远不会自己动（用户实报）。
    // 已阻塞 = "卡住了、等人处理"，跟"跑挂了（失败）"也不一样：失败的可以重跑，这个要先决定怎么办。
    status: 'blocked',
    note: '服务重启，这一步被中断',
    endedAt: store.nowIso(),
  });
}
if (stuckTasks.length) console.log(`收了 ${stuckTasks.length} 个被中断的工作流任务`);

/*
 * 定时任务的心跳（2026-10-17）：30 秒一跳，挑**到点的**任务串行跑。
 * 只读动作（PR 巡检）第一条；它会自己去 GitHub 拉清单，所以这里不预判网络、令牌 ——
 * 错了就记进任务的 `lastStatus/lastError`，在「设置 → 定时任务」那一行如实显示。
 */
schedules.start();

/*
 * 飞书通道（2026-10-27 建的；2026-10-29 员工级改造）：先把旧 feishu.json 迁给对应员工，
 * 再把每个开了「开机自启」的员工的通道逐个拉起。
 * 起不来只 warn 不拦启动 —— 通道是外部的，班底该照常开张。
 */
feishu.bootSync();

/*
 * **明文检测**（IAM §10.1.1）：监听非回环、没声明反代、也没配 TLS → 告警；
 * `BANDI_TLS_STRICT=on` 时**拒绝启动**（给"我必须防呆"的公网部署用）。
 * 位置在 listen 之前：拒绝启动就别先占端口，否则运维会看到一个"起着但没用"的进程。
 */
const tlsState = tlsCheck.evaluate(SERVER.boundHost);
if (tlsState.warn) console.warn(`[安全] ${tlsState.text}`);
if (tlsState.fatal) {
  console.error('[安全] BANDI_TLS_STRICT=on：拒绝以明文对外监听。用反代/隧道终结 TLS，或设 BANDI_TRUST_PROXY=1 声明"证书在外层"。');
  process.exit(1);
}

/* 开机收尸（2026-11-04）：上回进程内跑着的本机安装任务，随上次进程一起没了 ——
 * 别让它们永远停在「执行中」，界面会跟着永远"安装中"、按钮也回不来。 */
try {
  const reaped = store.reapOrphanLocalTasks();
  if (reaped) console.log(`[本机] 收掉了 ${reaped} 件上次没跑完的安装任务（已标失败，要装再点一次）`);
} catch (e) {
  console.warn(`[本机] 安装任务收尸失败（不影响启动）：${e?.message ?? e}`);
}

server.listen(port, SERVER.boundHost, logListen);

/*
 * 身份中枢（2026-11-06）：加入了就接着报心跳 —— 中枢靠它画「在线」，
 * 不给地址的话手机名册上只有一台点不动的机器。
 *
 * 放在 `listen` 之后（先能答请求，再往外打）。**失败不拦启动**：
 * 中枢是可选增强，不是核心路径（docs/形态决策.md「单机零外部依赖」那条）。
 * 没加入过时它什么都不做，但定时器会一直挂着 —— 这样 本机登录页
 * 写进 hub.json 之后，最多 60 秒这边就跟上了，不用重启服务。
 */
try {
  if (hub.startHeartbeat({
    dataDir,
    port,
    version: localMode.platformVersion(),
  }).joined) {
    console.log('[中枢] 已恢复心跳');
  }
} catch (e) {
  console.warn(`[中枢] 心跳没起来（不影响本机使用）：${e?.message ?? e}`);
}

/*
 * 外网隧道（2026-11-07 接入，2026-11-08 下线）：**不再由 bandi 起 frpc**。
 *
 * 原因：frp 是黑产滥用最多的隧道工具，内置一份二进制（哪怕改名成 bandi-tunnel 绕杀软）
 * 意味着每个装班底的人都多背一个 17MB 的可疑文件，且它要常驻、要联网、要往中枢报身份。
 * 用户决定「需要时另外装，不内置」——这条路干净得多，也把"隧道不通"和"班底坏了"
 * 彻底分开：服务起不来一定是代码问题，不会是 frpc 没权限。
 *
 * 出去的那半边现在只做两件不需要进程的事：
 *   ① `hub/relay.mjs` 读配置（中枢下发或手写 tunnel.json），供 http.mjs 的
 *      Host 守卫 / Origin 白名单认域名；
 *   ② 什么都不起。自己装的 frpc 直接连本机 18787 即可。
 */

/**
 * 启动横幅（listen 回调里打一遍；没有"原地重启"了，监听整个进程生命周期不变）。
 */
function logListen() {
  /*
   * 应答器已下线（lan-announce.mjs 只剩状态存根）；sync 照调保形状，
   * 让状态里报的端口跟当前进程对得上。
   */
  lanAnnounce.sync({ ...netmode.readNetMode(), boundHost: SERVER.boundHost, httpPort: port });
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
    console.log('要求令牌：浏览器打开首页填一次（会记进 Cookie），脚本用 X-Bandi-Token 头。');
  } else {
    /*
     * 回环监听有三种来源（2026-11-04 起监听地址可以存在数据目录里了）：环境变量钉的、
     * 界面里改的、缺省调试形态。照实说是哪一种 —— 不然运维看着日志会去找一个不存在的
     * `BANDI_HOST`。免鉴权只跟"听回环"有关，跟谁设的无关（auth.mjs 同一条规则）。
     */
    const why =
      hostSource === 'env'
        ? 'BANDI_HOST 环境变量钉的'
        : hostSource === 'config'
          ? '界面里设的（设置 → 安全 → 监听地址）'
          : '显式调试形态';
    console.log(`只监听回环 —— 免鉴权（${why}；要让别的机器连，改成 0.0.0.0 再重启）。`);
  }
}
