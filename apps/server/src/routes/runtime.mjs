/* routes/runtime.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * 主分发顺序（先匹配先赢）见 ../server.mjs 的 CHAIN。 */

import path from 'node:path';
import { sendJson, fail, readBody } from '../http.mjs';
import { withExternals } from '../runtime-view.mjs';
import { SERVER } from '../server-state.mjs';
import { port, host, dataDir } from '../config.mjs';
import * as netmode from '../netmode.mjs';
import * as store from '../store.mjs';
import * as auth from '../auth.mjs';
import * as runtimes from '../runtimes.mjs';
import * as cliModels from '../cli-models.mjs';
import * as lanAnnounce from '../lan-announce.mjs';

export async function handleRuntime(req, res, url) {
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
       * 为什么不能等 `SERVER.restart` 里去算（第一版就是那样，测试抓出来了）：回环形态下
       * `auth.setup` **连令牌文件都不生成**（单机零安全痕迹 ✓）→ 这里的 `SERVER.AUTH.token` 是空字符串 ✗
       * → Cookie 根本设不出来 → 用户点完「重启生效」，自己那个窗口立刻撞上登录页 ✗
       * （他会以为"点了重启就坏了"）。先算这一次，令牌就造出来了 ✓。
       */
      Object.assign(SERVER.AUTH, auth.setup({ host: nextHost, dataDir, envToken: process.env.BANDI_TOKEN }));
      if (SERVER.AUTH.token) res.setHeader('Set-Cookie', auth.cookieValue(SERVER.AUTH.token));
    }
    sendJson(res, 200, { ok: true, from: SERVER.boundHost, to: nextHost, requiresToken: willRequire });
    setTimeout(SERVER.restart, 80); // 让这个响应先发出去
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
       * 这里用 `SERVER.boundHost`（这个进程**实际**听着什么），不是配置里想要的：
       * 开关刚打开、还没点重启时监听仍是回环，那时回应答毫无意义（别人根本连不进来）。
       */
      lanAnnounce.sync({ allowLan: body?.allowLan === true, explicit: !!process.env.BANDI_HOST, boundHost: SERVER.boundHost, httpPort: port });
    }
    const want = netmode.readNetMode().allowLan;
    const boundLan = !netmode.isLoopback(SERVER.boundHost); // 这个进程**现在实际**听的是什么（原地重启后会变）
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
      host: SERVER.boundHost, // **实际**听着的（原地重启后会变）—— 别报启动时那个，那会骗人 ✗
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
