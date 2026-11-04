/**
 * 「外部件」—— 一台机器上**除了班底本身**还需要有的东西。
 *
 * 为什么单开一层，而不是塞进 `plugins/`（2026-10-16 用户提的"把 magpie 当插件"）：
 *   · `plugins/` 那个槽位是**界面面板**（`plugins/<id>/manifest.json` → rail 里一块面板）；
 *   · 而 magpie 这类东西**不是一块界面**，它是那台机器的**运行前提** ——
 *     跟 agent CLI 是同一类：装在那台机器上、我们**只对接命令行**、它自己管自己。
 * 槽位用错，后面所有事都会别扭（"为什么插件装了却没生效"）。
 *
 * 我们只认三件事，且**只认命令与端口，不 import、不解析它的配置文件**：
 *   ① 命令在不在；② 网关端口通不通；③ 怎么装、怎么让它常驻。
 * 这样它**怎么更新都不用动我们一行代码** —— 这正是不把它做成"插件"的意义。
 *
 * ⚠️ 安装/常驻命令都写在**这张表里**，跟运行时那份命令表同理：
 * 控制面只能发**外部件 id + 哪一步**，命令由**那台机器**自己查表 —— 递不出任意命令。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { pathDirs } from './path-env.mjs';

export const EXTERNALS = {
  magpie: {
    id: 'magpie',
    label: 'magpie',
    note: '本机模型网关：把各 agent 的请求转给你配的供应商（协议转换、账号轮换、用量统计）。装上并配好之后，各 agent 自己的配置文件由它去写。',
    home: 'https://usemagpie.ai/zh/',
    /** 网关端口（它默认跑在 127.0.0.1:3425）。网关不通时，被它接管的 agent 会全线 502。 */
    gatewayPort: 3425,
    /**
     * 它自己那个**面板**的端口（`magpie web` / `daemon install --web`，默认 127.0.0.1:3430）。
     *
     * ⚠️ 这条**只属于 POSIX**（2026-11-04 用户纠正：Windows 上装的 magpie 是**桌面软件**，
     * 它的面板就是它自己的窗口，不是网页 —— 在 Windows 上探 3430 没有意义，见 declared）。
     * Linux/无桌面的机器上才是网页形态：浏览器里打开它的完整界面，
     * "no desktop needed: WSL, a server over SSH"。所以这里的定位是**只放入口**：
     * 界面是它的、我们只显示"面板起没起 + 一条能打开的链接"，不搬界面、不解析输出。
     */
    panelPort: 3430,
    /**
     * 装：
     * · POSIX 上是它官方那条脚本。
     * · Windows 上走**官方固定下载口**（2026-11-04 改，用户要的"软件商店"条目：
     *   "我点一下就可以直接安装了，不要再去找命令或者安装包"）——
     *   usemagpie.ai/download/<平台> 永远指向当前正式版安装包，版本号变了这条 URL 不变。
     *   点一下 = 把安装包下到 %TEMP% 并**启动它自己的安装程序**：安装界面是 magpie 的，
     *   我们不代点、不解析、装到哪儿它自己管 —— "他原来是什么样就什么样"。
     *   ⚠️ 那行命令里带引号和 &&，是**给 cmd 的一整行**：spec.raw = true，
     *   spawn 时必须 windowsVerbatimArguments（Node 默认的引号转义是 `\"`，cmd 不认，会拆烂）。
     */
    install: {
      /**
       * POSIX 默认就**走镜像**（2026-11-04 用户："thinkpad 上下载连不上网……改成使用镜像下载"）——
       * 实测那台机器直连 GitHub 时下载会挂死（脚本停在 "downloading magpie …" 不动，
       * 四次点安装全卡成僵尸），而 usemagpie.ai 本站和镜像都通。版本清单（SHA-256 来源）
       * 仍从官网拿，镜像只扛 GitHub 的发布文件，安全性见 mirrors 的注释。
       * 不想走镜像/想换一家：任务带 `mirror` 参数（过 mirrorOk() 后由 withMirror 拼进去）。
       */
      posix: {
        bin: 'sh',
        args: ['-c', 'curl -fsSL https://usemagpie.ai/install.sh | sh -s -- --mirror https://gh-proxy.com/'],
        cmd: 'curl -fsSL https://usemagpie.ai/install.sh | sh -s -- --mirror https://gh-proxy.com/',
      },
      /** 按 CPU 架构挑下载口（platform 形如 `win32 x64` / `win32 arm64`，调用方传进来） */
      win32: (platform) => {
        const url = /arm/i.test(String(platform))
          ? 'https://usemagpie.ai/download/windows-arm64'
          : 'https://usemagpie.ai/download/windows-amd64';
        return {
          raw: true, // 整行进 cmd，别让 Node 转义里面的引号（见上）
          bin: 'cmd.exe',
          args: ['/d', '/s', '/c', `curl.exe -fsSL -o "%TEMP%\\magpie-setup.exe" ${url} && start "" "%TEMP%\\magpie-setup.exe"`],
          cmd: `下载官方安装包（${url}）并启动安装程序`,
        };
      },
      /**
       * 走镜像装（家里拉 GitHub 容易卡）。
       *
       * ⚠️ 这一段是**拼进 shell 的**（`| sh -s -- --mirror X`）—— 所以 `X` 必须**先过 mirrorOk()**
       * 才允许出现在这里。它是个**参数**，不是命令：节点永远只跑这张表里的固定命令，
       * 控制面能影响的只有这个被严格校验过的前缀。
       * 官方文档也说了：**文件哈希仍然来自 usemagpie.ai**，镜像改过的会被拒。
       */
      withMirror: (prefix) => ({
        bin: 'sh',
        args: ['-c', `curl -fsSL https://usemagpie.ai/install.sh | sh -s -- --mirror "${prefix}"`],
        cmd: `curl -fsSL https://usemagpie.ai/install.sh | sh -s -- --mirror ${prefix}`,
      }),
    },
    /**
     * 常驻：它自己就带这个命令（Linux 上是 systemd、macOS 上是 launchd，开机即起、不用窗口）。
     *
     * ⚠️ 为什么带 `--web --lan`（2026-10-16 定的）：装上**面板**（不只是网关），
     * 而且让面板在局域网上可达 —— 否则它只绑 127.0.0.1，用户在自己电脑的浏览器里打不开。
     * 面板本身有访问密钥（magpie 生成、跨重启保留），不是裸奔。
     */
    serve: {
      posix: {
        bin: 'magpie',
        args: ['daemon', 'install', '--web', '--lan'],
        cmd: 'magpie daemon install --web --lan',
      },
    },
    /**
     * 打开它自己的面板（2026-11-04 用户纠正后的新步骤）：
     * · Windows 上 magpie 是**桌面软件**，面板 = 它自己的窗口 —— "打开面板"就是把这个 exe 拉起来。
     *   装在哪只有**这台机器自己知道**（见 whereIs 的注释），所以规格是**函数**：执行时在那台机器上
     *   现场解析 exe 路径 —— 命令仍然只出自这张表，控制面递不进任何东西，边界不变。
     * · POSIX 上不给这一步：面板是网页，daemon 常驻时它自己就在，界面上给链接就行（见 declared）。
     * `start ""` 立刻返回、不等窗口关闭 —— 任务runner（等进程退出才算完）拿到的就是"秒完"。
     */
    open: {
      win32: () => {
        const exe = whereIs('magpie');
        if (!exe) return null;
        return {
          raw: true, // 整行进 cmd（路径带空格要靠引号兜住），别让 Node 转义
          bin: 'cmd.exe',
          args: ['/d', '/s', '/c', `start "" "${exe}"`],
          cmd: `打开它自己的面板（桌面窗口：${exe}）`,
        };
      },
    },
    /**
     * 内置的 GitHub 镜像（**普通用户不该去记这些**，所以由我们提供，界面只给一个勾选框）。
     *
     * 为什么是一串而不是一个：这类公共镜像**会挂**，写死一个等于把"装不上"钉死在一个第三方的
     * 可用性上。所以按顺序试，谁先通用谁。
     *
     * 为什么用它们**不会装上假货**：`install.sh` 最终校验的 SHA-256 **仍然来自 usemagpie.ai**
     * （它官方文档明说"文件的 SHA-256 始终来自 usemagpie.ai，而不是镜像，镜像改过的文件会被拒绝安装"）。
     * 所以镜像最坏只能"拉不到"，不能"换成别的二进制"。
     *
     * 要换掉/加一条，改这里就行 —— 界面会自动跟着变，不用动 UI。
     */
    mirrors: ['https://gh-proxy.com/', 'https://ghfast.top/', 'https://ghproxy.net/'],
    /**
     * 官方固定下载口（2026-11-04）：一键装不了时的兜底 —— 界面给一颗"打开下载页/直链"，
     * 浏览器点开也能拿到安装包，不用去网站里翻。键 = `<平台> <架构>`（与节点自报的 platform 同形）。
     */
    download: {
      'win32 x64': 'https://usemagpie.ai/download/windows-amd64',
      'win32 arm64': 'https://usemagpie.ai/download/windows-arm64',
      'linux x64': 'https://usemagpie.ai/download/linux-amd64',
      'linux arm64': 'https://usemagpie.ai/download/linux-arm64',
    },
  },
};

/** 一层层找"它装哪儿了"——不 spawn，纯看文件（心跳里每秒都可能跑，要便宜） */
const HOMES = {
  magpie: () =>
    [
      '/usr/local/bin/magpie',
      '/usr/bin/magpie',
      path.join(os.homedir(), '.local', 'bin', 'magpie'),
      '/Applications/magpie.app',
      path.join(os.homedir(), 'Applications', 'magpie.app'),
      'C:\\Program Files\\magpie\\magpie.exe',
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'magpie', 'magpie.exe'),
      path.join(process.env.ProgramFiles ?? '', 'magpie', 'magpie.exe'),
    ].filter(Boolean),
  // 配置目录也算"装过"的证据：桌面版可能不在上面这些固定位置
  config: {
    magpie: () => [path.join(os.homedir(), '.config', 'magpie'), path.join(os.homedir(), 'AppData', 'Local', 'magpie')],
  },
};

/**
 * 在 PATH 上找 —— 用户态装的那种（Linux 上是 `~/.local/bin/magpie`）通常就这么能看见。
 * 2026-11-04 补：PATH 来源换成 `pathDirs()`（进程快照 ∪ 注册表此刻的系统/用户 PATH，
 * 见 path-env.mjs）—— bandi 先启动、magpie 后装，也能被看见。
 */
function onPath(name) {
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const d of pathDirs()) {
    for (const x of exts) {
      const p = path.join(d, name + x);
      try {
        if (fs.existsSync(p)) return p;
      } catch { /* 不可读就跳过 */ }
    }
  }
  return null;
}

/**
 * "`Program Files` 可能在别的盘" —— 这机器就是（magpie 在 `D:\Program Files\magpie`，
 * 而 `%ProgramFiles%` 指的是 C 盘）。从 PATH 里那些住在 `X:\AppData\` 下面的条目推盘符，
 * 跟 runtimes.mjs 里 appRoots() 同一个思路。
 */
function programFilesDirs(name) {
  const out = [];
  // 2026-11-04 补：同样换成 pathDirs() —— 盘符推导跟着注册表此刻的 PATH 走
  for (const d of pathDirs()) {
    const m = /^([A-Za-z]:)[\\/]AppData[\\/]/i.exec(String(d).trim());
    if (m) {
      out.push(path.join(m[1] + path.sep, 'Program Files', name));
      out.push(path.join(m[1] + path.sep, 'Program Files (x86)', name));
    }
  }
  return out;
}

function whereIs(id) {
  const direct = onPath(id);
  if (direct) return direct;
  for (const p of HOMES[id]?.() ?? []) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* 不可读就跳过 */ }
  }
  for (const p of programFilesDirs(id)) {
    try {
      if (fs.existsSync(path.join(p, process.platform === 'win32' ? `${id}.exe` : id)) || fs.existsSync(p)) return p;
    } catch { /* 同上 */ }
  }
  /*
   * ⚠️ **配置目录不算"装过"**（2026-10-16 踩到）：它只是数据，而且卸载时我特意留着它
   * （供应商/密钥是用户的东西）。拿它当证据的后果正是最尴尬的那种：
   * 卸载之后照样报"装了" → 界面上那颗按钮从「装上并常驻」变成「重设常驻」→ **没法重装** ✗。
   * 所以这里不再看 `.config/magpie`；"装没装"改由**功能性判据**兜底（见 declared：网关/面板在应答）。
   */
  return null;
}

/** 端口通不通。超时卡在 300ms —— 端口被防火墙吞掉时别把心跳拖住 */
function portOpen(port, timeoutMs = 300) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* 已经断了 */ }
      resolve(ok);
    };
    const sock = net.connect({ port, host: '127.0.0.1' });
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/**
 * 这台机器在局域网里的地址（挑一个最像局域网的 IPv4）。
 *
 * 为什么要报这个：面板的链接得指向**能连上的地址**。主机名（`sea-ThinkPad-P15-Gen-1`）
 * 在别人机器上不一定解析得出来，而 `192.168.x.x` 在同一个局域网里一定行。
 *
 * 导出是给**节点**用的：它要把 magpie 打印的那串链接里"局域网那条"挑出来
 * （magpie 会把 docker 的 172.x 也一起列出来 —— 那不是你要点的那个）。
 */
export function lanAddrs() {
  const out = [];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family !== 'IPv4' || ni.internal) continue;
        out.push(ni.address);
      }
    }
  } catch { /* 拿不到就算了 */ }
  // 私有网段排前面（`192.168.` 更常见，排最前）
  const rank = (a) => (/^192\.168\./.test(a) ? 0 : /^10\./.test(a) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b));
}
/**
 * 这台机器上的外部件现状。**节点每次心跳都会报一份**（跟 runtimes 同一套机制），
 * 控制面自己那台也用它 —— 于是"网关没起"这种事在界面上是看得见的，
 * 而不是等 agent 报 502 才知道。
 */
export async function declared() {
  const out = [];
  const lan = lanAddrs();
  /*
   * 面板分**两种形态**（2026-11-04 用户纠正）：Windows 上 magpie 是桌面软件，
   * 面板 = 它自己的窗口（不是网页）—— 探 3430 没有意义，网页链接也不该给；
   * POSIX 上才是 `magpie web` 那个网页（端口 3430）。`panelKind` 把这件事
   * 明明白白报给界面：'app' = 桌面窗口（用 open 那一步拉起来），'web' = 网页（给链接）。
   */
  const win = process.platform === 'win32';
  for (const e of Object.values(EXTERNALS)) {
    const where = whereIs(e.id);
    // 网关在不在：装了但网关没起，是最坑的状态（agent 指向它 → 全线 502）
    const gateway = e.gatewayPort ? await portOpen(e.gatewayPort) : null;
    const panel = !win && e.panelPort ? await portOpen(e.panelPort) : null;
    /*
     * 「装没装」用**功能性判据**：命令在 **或** 网关/面板在应答。
     * 只看文件位置会骗人（用户态装的落点五花八门、卸载也可能留下配置目录 —— 见 whereIs 的注释），
     * 而"端口在应答"这件事骗不了人：能应答就说明它确实装着并在跑。
     */
    const installed = !!where || gateway === true || panel === true;
    out.push({
      id: e.id,
      label: e.label,
      installed,
      where: where ?? '',
      gateway,
      gatewayPort: e.gatewayPort ?? null,
      panelKind: win ? 'app' : 'web',
      panel,
      panelPort: win ? null : (e.panelPort ?? null),
      panelUrl: !win && e.panelPort && lan.length ? `http://${lan[0]}:${e.panelPort}` : null,
    });
  }
  return out;
}

/**
 * 面板链接要**带访问密钥** —— magpie 的页面不带就是 401（2026-10-16 实测：
 * 直接开 `http://192.168.5.19:3430` 得到"未经授权"）。密钥不由我们编，问它自己要
 * （`magpie daemon web` 会打印带密钥的链接），并**缓存 10 分钟**：密钥跨重启不变，
 * 没必要每次心跳都 spawn 一个进程。
 *
 * 2026-11-04 从 node.mjs 搬到这里：**本机**那条路（routes/local.mjs 的软件商店）也要用它 ——
 * 不然本机界面上给的是 declared() 里"按局域网地址猜的"那条，点开一片 401。
 */
const panelCache = new Map();
export async function panelUrlFor(id, port) {
  const hit = panelCache.get(id);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.url;
  const want = lanAddrs();
  /*
   * ⚠️ 用 `whereIs(id)` 拿**真实路径**，别只写命令名（2026-11-04 thinkpad 实测）：
   * systemd 起的服务里 PATH 没有 `~/.local/bin`，`spawn('magpie')` 直接 ENOENT → 链接恒为 null，
   * 而探测那边走的是 whereIs（能找到），于是"面板起着却没链接"。同一个坑 2026-10-16 在探测侧踩过。
   */
  const bin = whereIs(id) ?? id;
  /*
   * ⚠️ Linux 上还得补 `XDG_RUNTIME_DIR`（2026-11-04 thinkpad 实测）：`magpie daemon web`
   * 内部走 `systemctl --user` 问会话总线，而 **systemd 起的服务**环境里没有这个变量 ——
   * 报 "can't reach your session's service manager"，于是链接恒为 null（面板明明起着）。
   * 值就是 `/run/user/<uid>`，存在才补（不存在说明这台机器压根没有用户会话，补了也没用）。
   */
  const env = { ...process.env, PATH: pathDirs().join(path.delimiter) };
  if (process.platform === 'linux' && !env.XDG_RUNTIME_DIR && typeof process.getuid === 'function') {
    const rt = `/run/user/${process.getuid()}`;
    try {
      if (fs.existsSync(rt)) env.XDG_RUNTIME_DIR = rt;
    } catch { /* 看不见就算了 */ }
  }
  const url = await new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(bin, ['daemon', 'web'], {
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退了 */ }
      resolve(null);
    }, 4000);
    const onData = (c) => { out += String(c); };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      // 它会把每个网卡都列一遍（docker 的 172.x 也在里头）—— 挑"我自己那张局域网卡"那条
      const urls = [...out.matchAll(/https?:\/\/[^\s"']*\/\?k=[A-Za-z0-9._-]+/g)].map((m) => m[0]);
      const mine = urls.find((u) => want.some((ip) => u.includes(`//${ip}:${port}`)));
      resolve(mine ?? urls.find((u) => u.includes(`:${port}/`)) ?? null);
    });
  });
  panelCache.set(id, { url, at: Date.now() });
  return url;
}

/**
 * 给现状补上带密钥的面板链接（**只在面板真的起着时**才去问 —— 没起就不用 spawn 一个进程）。
 * 节点心跳与本机软件商店共用这一条，免得两处各写一份、其中一处忘了带密钥。
 */
export async function withPanelUrls(list) {
  for (const e of list) {
    if (!e.panel || !e.panelPort) continue;
    const keyed = await panelUrlFor(e.id, e.panelPort);
    if (keyed) e.panelUrl = keyed; // 用带密钥的那条，盖掉"按局域网地址猜的"那条
  }
  return list;
}

/**
 * 界面上要的说明（含"**那台机器**能不能一键装"）。
 *
 * ⚠️ 平台要按**目标机器**算，不能按控制面自己 —— 2026-10-16 差点漏掉：
 * 控制面在云端（Linux）时，给一台 Windows 节点也会给出 `curl | sh` ✗。
 * 所以 `platform` 由调用方传那台机器的（节点自报的 `platform`）。
 */
export function publicExternals(platform = process.platform) {
  const plat = String(platform);
  const win = /win/i.test(plat);
  return Object.values(EXTERNALS).map((e) => {
    // win32 规格可能是**按架构算的函数**（挑下载口用）—— 界面说明也按同一个算法出
    const raw = e.install?.[win ? 'win32' : 'posix'];
    const spec = typeof raw === 'function' ? raw(plat) : raw;
    return {
      id: e.id,
      label: e.label,
      note: e.note,
      home: e.home,
      gatewayPort: e.gatewayPort ?? null,
      // 面板形态跟着**那台机器**走（同 platform 的口径）：Windows = 桌面窗口，POSIX = 网页
      panelKind: win ? 'app' : 'web',
      panelPort: win ? null : (e.panelPort ?? null),
      installCmd: spec?.cmd ?? null,
      serveCmd: e.serve?.[win ? 'win32' : 'posix']?.cmd ?? null,
      // 一键装不了时的兜底：官方固定下载口（浏览器点开就能拿到安装包）
      downloadUrl: e.download?.[plat.toLowerCase()] ?? null,
      /**
       * 走镜像时按顺序试的那些前缀（**普通用户不需要知道**，界面只给一个勾选框）。
       * Windows 上给不出来（走的是官方下载口，没有镜像一说），所以给空数组。
       */
      mirrors: win || !e.mirrors?.length ? [] : e.mirrors.filter((m) => mirrorOk(m)),
    };
  });
}

/**
 * 镜像前缀能不能用。**这是安全边界，不是格式洁癖**：
 * 这个值会被拼进 `sh -c '… --mirror "<前缀>"'`，所以只要它带了引号、反引号、`$`、`;`、`|`、`&`、
 * 括号、通配符、空白、换行 —— 那就是一条注入通道。
 *
 * ⚠️ 第一版我照"URL 里合法的字符"写，于是把 `;` `&` `(` `)` `*` `!` 也放进来了 ——
 * **用例当场抓出来**（`https://a.com/;id` 被放行）。这里要的是**白名单**：
 * 只留 URL 常用**且**在 shell 里绝无含义的那些。
 * （模板里那个双引号也保留着 —— 但"靠引号兜住"不该是唯一的一道。）
 */
export function mirrorOk(prefix) {
  const s = String(prefix ?? '').trim();
  if (!s) return false;
  if (s.length > 200) return false;
  return /^[A-Za-z0-9._~:/?#@=%,+-]+$/.test(s);
}

/**
 * 某一步要跑什么。`step` 是 `install`（装上）或 `serve`（装成常驻服务）。
 *
 * 返回 null = 这一步在**这个平台**上没法一键做 —— 调用方要如实说清楚，别装作能装。
 * 规格允许是**函数**（win32 那条要按 CPU 架构挑下载口），函数收 platform 字符串。
 *
 * `opts.mirror`（只有 POSIX 的 install 用得上）：走 GitHub 镜像装。**先过 mirrorOk()**，
 * 不过就当没有。Windows 那条走官方下载口，没有镜像一说 —— 给了也拒。
 *
 * ⚠️ 控制面**校验**时也要传那台节点的平台（`node.platform`）：不然 Linux 控制面会放行一个
 * posix 任务给 Windows 节点，节点那边再拒一次 —— 白绕一圈。
 */
export function commandFor(step, id, platform = process.platform, opts = {}) {
  const e = EXTERNALS[id];
  if (!e) return null;
  const win = /win/i.test(String(platform));
  const raw = e[step]?.[win ? 'win32' : 'posix'];
  const spec = typeof raw === 'function' ? raw(platform) : raw;
  if (!spec?.bin || !Array.isArray(spec.args)) return null;
  const mirror = String(opts.mirror ?? '').trim();
  if (mirror) {
    if (win || step !== 'install' || !e.install?.withMirror || !mirrorOk(mirror)) return null;
    const m = e.install.withMirror(mirror);
    return { bin: m.bin, args: m.args, cmd: m.cmd };
  }
  return { bin: spec.bin, args: spec.args, cmd: spec.cmd, raw: !!spec.raw };
}
