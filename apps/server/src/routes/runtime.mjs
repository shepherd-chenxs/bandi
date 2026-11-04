/* routes/runtime.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * 主分发顺序（先匹配先赢）见 ../server.mjs 的 CHAIN。 */

import path from 'node:path';
import { sendJson, fail, readBody } from '../http.mjs';
import { withExternals } from '../runtime-view.mjs';
import { SERVER } from '../server-state.mjs';
import { port, host, hostSource, writeListenHost, normalizeListenHost } from '../config.mjs';
import * as netmode from '../netmode.mjs';
import * as store from '../store.mjs';
import * as runtimes from '../runtimes.mjs';
import * as cliModels from '../cli-models.mjs';
import * as lanAnnounce from '../lan-announce.mjs';
// 网络周界闸（security/ipallow.mjs）的名单校验与归一化 —— 写库前把脏数据挡住
import { normalizeIpList, normalizeDomain, clientIpOf, ipAllowed } from '../security/ipallow.mjs';

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
   * 这台机器的**形态**（2026-10-16 起；2026-11-03 起"对外服务"这一维整个删除）。
   *
   *   · 监听地址 —— **永远对外**（`BANDI_HOST` 可覆盖，缺省 `0.0.0.0`），是启动配置的事，
   *     界面上没有开关、没有「重启」。曾经管这个的 `allowLan` 键与 `/api/restart` 已删。
   *   · `acceptNodes` —— **角色**：总机（收别的机器当节点）/ 分机（不收）。**立刻生效**。
   *     分机照样对外服务、手机照样能连，只是不发邀请码、`/api/hello` 的 `joinable` 为 false。
   *
   * 真值存在数据目录的 `netmode.json` 里（`netmode.mjs`）。
   */
  if (url.pathname === '/api/lan') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      /*
       * **监听地址**（2026-11-04 用户：界面上那句"监听由启动配置决定，界面不改"
       * 是实现时自作主张加的口径，不是他的设计。要做成 1Panel 那样：面板里能改、
       * 重启生效、升级重装都不丢）。
       *
       * 值存数据目录的 `config.json`（`writeListenHost`）—— **不是** systemd 单元、
       * 也不是部署参数：单元每次安装都会被 `deploy/install.sh` 重新生成，11-04 的
       * 事故就是三次升级把 `0.0.0.0` 写回 `127.0.0.1`，局域网访问全断。
       *
       * `BANDI_HOST` 环境变量钉着时直接拒 —— 那不是"界面不给改"，是这个进程
       * **真的在听它**，写了也白写；先去掉变量（或 `bandi reset-host`）再改。
       */
      if (typeof body?.listenHost === 'string') {
        if (hostSource === 'env') {
          return fail(res, 400, 'E1053', `监听地址被启动参数钉着（BANDI_HOST=${process.env.BANDI_HOST}）—— 界面改不动它。去掉那个变量（或 bandi reset-host）再改。`);
        }
        const want = normalizeListenHost(body.listenHost);
        if (!want) {
          return fail(res, 400, 'E1054', '监听地址写不对：给 0.0.0.0（所有网卡）/ 127.0.0.1（只听本机）/ 具体 IPv4');
        }
        writeListenHost(want);
        console.log(`[网络] 监听地址 → ${want}（重启控制面后生效）`);
        return sendJson(res, 200, { ok: true, listenHost: want, needRestart: want !== SERVER.boundHost });
      }
      const patch = {};
      if (typeof body?.acceptNodes === 'boolean') patch.acceptNodes = body.acceptNodes;
      if (typeof body?.pairEnabled === 'boolean') patch.pairEnabled = body.pairEnabled;
      /*
       * 网络周界（2026-11-03，安全页「网络访问」卡）：授权 IP 白名单 + 域名绑定。
       * 名单**先整体校验再入库**（一条写错就整份不存 —— 存一半等于让人以为防住了）；
       * 域名归一化到纯主机名，空串 = 清除绑定。
       */
      if (Array.isArray(body?.whitelistIps)) {
        const { ips, bad } = normalizeIpList(body.whitelistIps);
        if (bad.length) return fail(res, 400, 'E1052', `授权 IP 里有写不对的：${bad.join('、')}（每行一个 IP 或网段，如 192.168.5.9 / 192.168.5.0/24）`);
        patch.whitelistIps = ips;
      }
      if (typeof body?.whitelistEnabled === 'boolean') patch.whitelistEnabled = body.whitelistEnabled;
      if (typeof body?.boundDomain === 'string') patch.boundDomain = normalizeDomain(body.boundDomain);
      /*
       * **开启白名单时自动把你当前的 IP 加进名单**（防锁死）：界面保存的瞬间，
       * 你的浏览器就来自某个 IP —— 它不在名单里的话，保存成功 = 你自己立刻 403。
       * 本机直连本来就放行（127.0.0.1），这条主要救的是从局域网/公网管理服务器的场景。
       */
      let addedMyIp = null;
      if (patch.whitelistEnabled === true) {
        const list = patch.whitelistIps ?? netmode.readNetMode().whitelistIps;
        const mine = clientIpOf(req);
        if (mine && !ipAllowed(mine, list)) {
          patch.whitelistIps = [...list, mine];
          addedMyIp = mine;
        }
      }
      if (Object.keys(patch).length) netmode.writeNetMode(patch);
      const now = netmode.readNetMode();
      if (typeof patch.acceptNodes === 'boolean') {
        console.log(`[网络] 角色：${patch.acceptNodes ? '总机（收节点）' : '分机（不收节点）'}（立即生效）`);
      }
      if (typeof patch.whitelistEnabled === 'boolean') {
        console.log(`[网络] 授权 IP 白名单：${patch.whitelistEnabled ? '开' : '关'}（${now.whitelistIps.length} 条${addedMyIp ? `，已自动加入你的 IP ${addedMyIp}` : ''}）`);
      }
      if (patch.boundDomain !== undefined && patch.boundDomain !== '') {
        console.log(`[网络] 域名绑定：${patch.boundDomain}（仅本机直连与该域名可访问）`);
      }
      /*
       * UDP 应答器已下线（lan-announce.mjs 只剩状态存根）；sync 照调保形状，
       * 让"状态里报的端口"跟当前进程对得上。
       */
      lanAnnounce.sync({ ...now, boundHost: SERVER.boundHost, httpPort: port });
      if (addedMyIp) return sendJson(res, 200, { ok: true, addedYourIp: addedMyIp });
    }
    const nm = netmode.readNetMode();
    const boundLan = !netmode.isLoopback(SERVER.boundHost); // 实际听着非回环吗（BANDI_HOST=127.0.0.1 调试时才是 false）
    return sendJson(res, 200, {
      acceptNodes: nm.acceptNodes,
      // 手机连接总开关（2026-11-02，「手机连接」页顶那颗；关 = 不发码 + 拒绝配对 + 断开全部）
      pairEnabled: nm.pairEnabled,
      // 网络周界（2026-11-03，安全页「网络访问」卡）。yourIp：界面提示"你会被自动加进名单"用
      whitelistEnabled: nm.whitelistEnabled,
      whitelistIps: nm.whitelistIps,
      boundDomain: nm.boundDomain,
      yourIp: clientIpOf(req),
      // 给界面直读的角色名（省得每处自己 if）
      role: nm.acceptNodes ? 'hub' : 'branch',
      host: SERVER.boundHost, // **实际**听着的
      /*
       * 监听地址的完整状态（2026-11-04，界面「监听地址」卡直接用这一块）：
       *   · `host`     这个进程**现在**听的（`SERVER.boundHost`，重启后才变）；
       *   · `wanted`   配置要它听的（config.json / BANDI_HOST / 缺省）；
       *   · `source`   谁定的：env（界面不能改）/ config（界面改过）/ default；
       *   · `needRestart` 改了还没重启 —— 界面据此提示"重启生效"。
       */
      listen: {
        host: SERVER.boundHost,
        wanted: host,
        source: hostSource,
        editable: hostSource !== 'env',
        port,
        needRestart: host !== SERVER.boundHost,
      },
      boundLan,
      port,
      // 摆给用户看"让别的机器连这个地址"（也是加入命令里该用的地址）
      urls: netmode.lanUrls(port),
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
