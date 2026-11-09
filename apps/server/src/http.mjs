/* http.mjs —— 无状态的 HTTP 助手（2026-10-22 由 server.mjs 拆出）。
 * 不持任何连接/监听状态；有状态的（AUTH/boundHost）在 server-state.mjs。 */

import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { port, extraOrigins, lanOrigins, dataDir } from './config.mjs';
import { relayHosts, relayOrigins } from './hub/relay.mjs';
import { policyFor as cspPolicyFor } from './security/csp.mjs';

// 静态文件根：apps/web（serveStatic 用；路径深度与 server.mjs 同层）
// **导出**：/api/web-version 的指纹也要 stat 这里的文件（server.mjs 引它），别再各算一份。
export const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

/**
 * 这一份策略**装在每一次响应上**（server.mjs 在请求链最前面 setHeader）。
 *
 * 为什么在链首一次装完、而不是在 serveStatic / 登录页各装一次：写两处就会漏第三处，
 * 而漏掉的那处常是新加的出口。装在最前面还有个好处 —— Host 闸、网络周界闸拒绝的那几条
 * 403 也带着策略（拒绝页同样不该跑脚本）。
 *
 * 策略本身与哈希缓存在 security/csp.mjs（含逐项理由与 CRLF 归一那条坑）。
 */
export function cspHeader() {
  return cspPolicyFor(path.join(webDir, 'index.html'));
}

export function sendJson(res, code, body) {
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
export function fail(res, status, code, error, extra = null) {
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
export function guardWrite(req) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return null;
  const origin = req.headers.origin;
  if (!origin) return null;
  if (origin === 'null') return '跨源请求被拒绝（Origin: null）';
  const clean = origin.replace(/\/$/, '');
  if (!allowedOrigins().has(clean)) return `来源不被允许：${origin}`;
  if (req.headers['x-bandi'] !== '1') return '缺少 X-Bandi 请求头';
  return null;
}

/*
 * Host 头守卫（DNS Rebinding 防护）。
 *
 * 为什么需要：回环形态免鉴权，而 `guardWrite` 的 Origin 检查只管写。
 * 一个攻击页把自己的域名 rebind 到 127.0.0.1 后，跨站 GET 在浏览器看来是同源的，
 * 可以静默读走 /api/state、/api/fs/dirs 等全部面板数据 —— 但 Host 头仍是它的域名。
 * 所以：Host 的主机名必须是回环地址或本机网卡上的地址，否则 403。
 * （LAN 模式下按 IP 访问的节点不受影响；按主机名访问的需是本机别名。）
 *
 * 网卡列表缓存 60 秒：DHCP 换 IP 后至多一分钟自愈，省掉每请求的系统调用。
 */
let localAddrs = null;
let localAddrsAt = 0;
function localAddresses() {
  const now = Date.now();
  if (!localAddrs || now - localAddrsAt > 60_000) {
    localAddrs = new Set(['127.0.0.1', '::1', 'localhost']);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) if (ni?.address) localAddrs.add(String(ni.address).toLowerCase());
    }
    /*
     * 云端公网 IP 往往不在网卡上（NAT / EIP），但部署时已经通过 BANDI_ORIGINS
     * 明确声明了访问来源。把这些来源的主机名一并放行，否则公网页面会先被
     * Host 守卫挡成 403 E3002，连令牌闸都到不了。
     */
    for (const origin of extraOrigins) {
      try {
        localAddrs.add(new URL(origin).hostname.toLowerCase());
      } catch {
        /* 非法来源在 config 解析时已有自己的校验，这里不重复报错 */
      }
    }
    /*
     * 中枢下发的隧道域名（2026-11-07 外网访问）：`<设备>.d.<域>` 是外网那一侧写进
     * Host 的名字。它不在任何网卡上，凭 `BANDI_ORIGINS` 又只有"启动它的那个终端"知道
     * —— 开机自启不带，重启一次就 403。所以按配置现算，与网卡地址同级放行。
     * 放行的只是**这一个**中枢签发的名字，不是"任何域名"，DNS rebinding 的口子没开。
     */
    for (const h of relayHosts(dataDir)) localAddrs.add(h);
    localAddrsAt = now;
  }
  return localAddrs;
}

/** 从 Host 头里剥出主机名（去掉端口；IPv6 去方括号） */
function hostnameOf(raw) {
  const h = String(raw ?? '').trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? h.slice(1) : h.slice(1, end);
  }
  const i = h.lastIndexOf(':');
  return i === -1 ? h : h.slice(0, i);
}

/** 返回 null 表示放行；否则给出拒绝原因 */
export function guardHost(req) {
  const raw = String(req.headers.host ?? '');
  if (!raw) return '缺少 Host 头';
  if (!localAddresses().has(hostnameOf(raw))) return `Host 头不是本机地址：${raw}`;
  return null;
}

export function allowedOrigins() {
  // 本机自己（界面就是这个源）+ 部署时另外声明的来源（见 config.extraOrigins）+
  // 「允许局域网加入」时本机的局域网地址 —— 这份是**动态**的（config.lanOrigins 每次
  // 按当前 netmode 现算，mtime 缓存）：运行期切开关 + 原地重启后立刻生效，
  // 不用整个进程重开（2026-11 修"手机扫码卡正在配对"：导入时冻结 → 局域网写请求全 403 E3001）。
  return new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    ...extraOrigins,
    ...lanOrigins(),
    // 隧道域名（中枢下发，见 hub/relay.mjs）。写请求的 Origin 就是它 —— 不在这里
    // 放行的话，外网页面打得开、点一下全 403 E3001，看着像坏了。
    ...relayOrigins(dataDir),
  ]);
}

/**
 * 请求本身有问题（不是服务器出错）—— 顶层那个 catch 会把它映射成 **400**，其余才是 500。
 *
 * 为什么要有这个区分：原来一律 500，于是 `readBody` 里那句"请求体不是合法 JSON"
 * 被报成"内部服务器错误" —— 明明是调用方发错了，却让人往服务端查。
 */
export class BadRequest extends Error {
  constructor(message, code = 'E1044') {
    super(message);
    this.code = code;
  }
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new BadRequest('请求体过大', 'E1045'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      // 攒够 Buffer 一次性按 UTF-8 解码 —— 逐块 toString 会把跨块的多字节字符（中文）解碎成 �
      const raw = Buffer.concat(chunks).toString('utf8');
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
export function readRawBody(req, maxBytes = 200 * 1048576, tooBigMsg = '文件太大（上限 200MB）') {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new BadRequest(tooBigMsg, 'E1099'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}


const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  /*
   * PWA manifest（2026-11-03 锁竖屏）：必须有这个类型。
   * 只配 `.json` 的话 `.webmanifest` 落进最后的兜底 `application/octet-stream`，
   * 而 Chrome 只认 JSON 系 MIME —— 类型不对就**整份 manifest 作废**，
   * 表现是"添加到主屏幕没有图标 / 还是浏览器壳 / 横屏照转"，
   * 控制台只留一句 Manifest 警告，很容易被当成"手机不支持"。
   */
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  // 员工产出常给的类型（2026-10-24，/api/workspace/file 按它回 Content-Type）
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

/** 按文件扩展名给 Content-Type（工作区文件口用；认识的类型都带 charset） */
export function mimeOf(file) {
  return MIME[path.extname(String(file)).toLowerCase()] ?? 'application/octet-stream';
}

/** 只服务 apps/web 下的静态文件；路径解析后必须仍在 webDir 里 */
export function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  let file = path.resolve(webDir, rel);
  if (!file.startsWith(webDir + path.sep)) {
    res.writeHead(403).end('forbidden');
    return true;
  }

  /*
   * 头像：按 Accept 换 WebP（2026-11-08）。
   *
   * 背景：avatars/ 里是 23 张 256² PNG，平均 93 KB —— 但页面最大只显示 58px。
   * 照片存 PNG 压不动（无损格式），`tools/avatar-webp.mjs` 在旁边生成了同名 .webp
   * （160px，合计 2.1 MB → 58 KB）。**原 PNG 一个字节没删**：`personas.avatar` 存的是
   * 文件名，数据库里引用的还是 `.png`，前端 `onerror` 兜底也靠它。
   *
   * 所以换格式这件事必须发生在这里：请求 `/avatars/x.png`，客户端说它要 webp、
   * 且旁边真有 x.webp，就发 webp。老客户端（或 webp 文件缺失）原样拿 PNG，
   * 上层 JS、数据库、缓存键一个字都不用改。
   *
   * 为什么值得单独写一段：走中转时一屏 20 张头像 1.86 MB ≈ 5 秒，
   * 比整个应用外壳（brotli 595 KB）还贵，而且每进一次列表重来一遍。
   */
  const isAvatar = /^\/avatars\/[^/]+\.(?:png|jpe?g)$/i.test(pathname);
  let variesOnAccept = false;
  if (isAvatar) {
    const wp = file.replace(/\.(png|jpe?g)$/i, '.webp');
    if (fs.existsSync(wp)) {
      /*
       * 只要 webp 版本存在，两种响应都挂 Vary: Accept —— 哪怕这次发的是 PNG。
       * 少了这一条，中间缓存（nginx / 未来可能加的 CDN）会把不带 Vary 的 PNG
       * 存下来发给所有人，webp 就白做了。
       */
      variesOnAccept = true;
      if (/image\/webp/i.test(req?.headers?.accept ?? '')) file = wp;
    }
  }

  try {
    const buf = fs.readFileSync(file);
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      /*
       * 头像可以缓存一天：它们**不是代码**，改一次头像的代价是"明天才看到新的"，
       * 而代价的另一面是每进一次列表重下 1.8 MB。代码类仍然是 no-store
       * （那边靠 SW 的版本指纹管更新，语义不同，别混）。
       */
      'Cache-Control': isAvatar ? 'public, max-age=86400' : 'no-store',
    };
    if (variesOnAccept) headers.Vary = 'Accept';

    /*
     * 2026-11-08：静态响应开始压缩，因为**外网直连要自己扛带宽了**。
     *
     * 这首屏有多大：style.css 356K + mobile.css 231K + js/*.mjs 1354K
     * （app.mjs 一次性 import 二十来个模块）≈ 1.9MB 明文。以前走 Cloudflare，
     * CF 在边缘替我们压了，所以这个问题从来没露头；换成自建服务器直连
     * （阿里云 3Mbps = 375KB/s）就是 5 秒起步，而这种"慢"在用户那里会被读成
     * "服务挂了"或"网断了"—— 正是这一轮排查里反复出现的那种误判。
     *
     * 为什么压在这一层、而不是让反向代理压：局域网直连不经过任何代理。
     * 压在有文件的地方，手机上连家里 Wi-Fi 和走外网两条路同时受益。
     *
     * br 优先（比 gzip 再小 12~20%），不支持才退 gzip。质量取 9 不是 11：
     * 356K 的 CSS 在 q11 要 466ms、q9 只要 27ms，体积差 6K —— 首字节多等
     * 半秒换 6K，在 3Mbps 上不划算。压缩结果按 mtime 缓存，一个文件一辈子压一次。
     */
    const enc = COMPRESSIBLE.test(type) && buf.length >= COMPRESS_MIN ? pickEncoding(req) : '';
    let body = buf;
    if (enc) {
      const key = `${file}|${safeMtime(file)}|${buf.length}|${enc}`;
      let hit = compressCache.get(key);
      if (!hit) {
        hit = compressBuf(buf, enc);
        if (compressCache.size >= COMPRESS_CACHE_MAX) compressCache.clear();
        compressCache.set(key, hit);
      }
      body = hit;
      headers['Content-Encoding'] = enc;
      headers['Content-Length'] = body.length;
      // 必须带 Vary：否则反向代理/CDN 会把压过的版本发给不接受 br 的客户端
      // （头像那段可能已经挂了 Vary: Accept —— 两个维度都要留着，别互相覆盖）
      headers.Vary = headers.Vary ? `${headers.Vary}, Accept-Encoding` : 'Accept-Encoding';
    } else {
      headers['Content-Length'] = body.length;
    }

    res.writeHead(200, headers);
    // HEAD 只回头不回体（浏览器预检和部分代理会发），少传 700K 也算数
    res.end(req?.method === 'HEAD' ? undefined : body);
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- 静态压缩 */

/** 值得压的类型。图片/字体已经在自己的格式里压过了，再压只浪费 CPU */
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|xml|javascript|manifest\+json)|image\/svg)/;

/** 1KB 以下压了反而变大（gzip 头 20 字节 + 字典开销），直接放行 */
const COMPRESS_MIN = 1024;

const COMPRESS_CACHE_MAX = 64;
/** key = 文件路径 | mtime | 字节数 | 编码 —— 文件一改 mtime 就变，旧条目自然失效 */
const compressCache = new Map();

function safeMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 挑编码。只认 br / gzip —— deflate 早年被 IE 的错误实现坑过，
 * 现在也没人靠它省那点字节，不给自己加分支。
 */
function pickEncoding(req) {
  const ae = String(req?.headers?.['accept-encoding'] ?? '').toLowerCase();
  if (ae.includes('br')) return 'br';
  if (ae.includes('gzip')) return 'gzip';
  return '';
}

function compressBuf(buf, enc) {
  if (enc === 'br') {
    return zlib.brotliCompressSync(buf, {
      params: {
        // 大文件降质量：>512K 时 q9 的边际收益抵不上 CPU
        [zlib.constants.BROTLI_PARAM_QUALITY]: buf.length > 512 * 1024 ? 5 : 9,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    });
  }
  return zlib.gzipSync(buf, { level: 6 });
}


/* --------------------------------------------------------------- 访问令牌 */

/*
 * 闸开不开**只看监听地址**：只监听回环（桌面版 / 单机）免鉴权；
 * 监听非回环（服务器）全都得要令牌。理由见 auth.mjs 的长注释 ——
 * 关键是这条规则不会被"前面架了个反向代理"偷走。
 *
 * 免鉴权时 `auth.setup` **连令牌文件都不生成**（单机零安全痕迹）。
 */
