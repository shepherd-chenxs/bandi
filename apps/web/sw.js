/*
 * sw.js —— Service Worker 缓存骨架（2026-11 手机端增量，P1-3）。
 *
 * 策略（设计 §5 T05 / §3.3.1.3）：
 *   · 安装期预缓存核心静态（`/`、CSS、入口 JS、**js/*.mjs 全量**、manifest、图标）；
 *   · 运行期对同源 GET 静态资源一律 **stale-while-revalidate**：先回缓存（弱网局域网
 *     二次加载明显快），后台再拉新版入库 —— 于是"改文件后刷新两次内拿到新版本"
 *     （第一刷：旧缓存先回、新版进库；第二刷：命中新版）；
 *   · **`/api/*` 一律放行不缓存** —— 本地优先产品，数据以服务端为准（PRD P1-3 的硬口径）；
 *   · `/sw.js`（SW 自己）永不缓存。
 *
 * 与 startVersionWatch 共存：SW 更新静态后 /api/web-version 的指纹照常变化，
 * 「刷新页面」提醒条机制不动（设计 §1.1）。缓存名里的 VERSION 是人工旋钮：
 *   静态布局大改（预缓存清单变了）时 +1，逼所有客户端整包重建。
 */

/*
 * **版本沿革（v13 → v160）已搬到 docs/changelog/web.md**（2026-11-08）。
 * 这个文件原来是 837 行里 722 行注释 —— 改缓存策略前得先翻过 160 个版本。
 * 改法不变：动静态清单就 VERSION +1，并去那边补一条"为什么进这一版"。
 */
const VERSION = 'v214';
const CACHE = `bandi-static-${VERSION}`;

/*
 * 预缓存清单（SW 不能 glob，手工列 —— 设计 §3.3.1.3 第 1 条）：
 * **新增 js 模块时同步这份清单，并把 VERSION +1**，否则老客户端拿不到新模块（整页白）。
 * js/*.mjs 全部在局域网一次拉完，二十来个文件代价很小。
 */
const JS_MODULES = [
  '/js/chat.mjs',
  '/js/connectors.mjs',
  '/js/contacts.mjs',
  '/js/core.mjs',
  '/js/events.mjs',
  '/js/experts.mjs',
  '/js/flowpages.mjs',
  '/js/groups.mjs',
  '/js/listmenu.mjs',
  '/js/machine.mjs',
  '/js/misc.mjs',
  '/js/mobile.mjs',
  '/js/plugin-data.mjs',
  '/js/projects.mjs',
  '/js/run-live.mjs',
  '/js/run-progress.mjs',
  '/js/run-progress-card.mjs',
  '/js/settings.mjs',
  '/js/securityadmin.mjs',
  '/js/shell.mjs',
  '/js/skills.mjs',
  '/js/state.mjs',
  '/js/ui.mjs',
  '/js/workflows.mjs',
];

const CORE = [
  '/',
  '/style.css',
  '/mobile.css',
  '/app.mjs',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/favicon-32.png',
  '/icons/favicon-16.png',
  ...JS_MODULES,
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // addAll 一颗失败就全废 —— 核心静态逐个来，缺哪张图标不该拖垮整个安装
      await Promise.allSettled(CORE.map((u) => cache.add(u)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      /*
       * 清掉旧版本的缓存：名字里带 VERSION，留下来的都是上一代。
       * `replaced` 同时是个信号：**有旧缓存 = 这次是版本升级**（不是首次安装）。
       */
      let replaced = false;
      for (const name of await caches.keys()) {
        if (name.startsWith('bandi-static-') && name !== CACHE) {
          await caches.delete(name);
          replaced = true;
        }
      }
      await self.clients.claim();

      /*
       * 版本升级时，通知已经开着的页面自己重载一次（2026-11-05「手机端没变化」）：
       * 手机上 App 常常一直挂着，旧页面里跑的还是旧 HTML/旧 CSS —— 新 SW 接管了也
       * 换不掉"已经渲染好的那一屏"。
       * 用 postMessage 而不是 clients.navigate：navigate 在部分 WebView/无头环境里会卡住。
       * 首次安装不发（没有旧缓存 → replaced=false），免得打断配对/首屏。
       * 只在这一刻发一次，不会循环（下次 activate 要等下个版本）。
       */
      if (replaced) {
        const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const w of wins) w.postMessage({ type: 'bandi:sw-updated' });
      }
    })(),
  );
});

/** 这个请求走不走缓存（true = 原样放行网络） */
function bypass(url, request) {
  if (request.method !== 'GET') return true;
  if (url.origin !== self.location.origin) return true; // 只管自己家的静态
  if (url.pathname.startsWith('/api/')) return true; // API 一律不缓存（数据以服务端为准）
  if (url.pathname === '/pair' || url.pathname === '/pair.html') return true; // 落地页带一次性 token
  if (url.pathname === '/sw.js') return true; // SW 自己永远走网络，否则更新不动
  return false;
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (bypass(url, e.request)) return; // 不拦 = 浏览器直连网络

  /*
   * 两类资源两套策略（2026-11-05 用户实报「手机端没变化」后改）：
   *
   * ① **代码类 · 网络优先**：页面导航、.css / .js / .mjs / .html / .webmanifest。
   *    原来是"缓存优先 + 后台偷偷更新"（stale-while-revalidate）—— 第一下必然拿旧文件，
   *    缓存虽在后台换新了，用户这屏已经是旧的，得再刷一次才看见。手机上看起来就是
   *    "改了跟没改一样"。局域网里那点往返根本不算事，而"改完看不到"是致命的。
   *    断网 / 服务重启时回退到缓存里那份，离线仍然能用。
   * ② **图片类 · 缓存优先**：图标、头像、截图，体积大、基本不变，先用缓存最快，
   *    后台照旧悄悄刷新。
   */
  const isNav = e.request.mode === 'navigate';
  const isCode = isNav || /\.(?:m?js|css|html|webmanifest)$/i.test(url.pathname);

  e.respondWith(
    (async () => {
      let cache = await caches.open(CACHE);

      /*
       * 2026-11-08：代码类资源从「网络优先」改回「缓存优先 + 后台更新」。
       *
       * 11-05 改成网络优先是为了治「改完看不到」，当时的判断是
       * 「局域网里那点往返根本不算事」—— 在局域网（1ms）这句是对的。
       * 但走中枢中转时**每个请求 2~5 秒**（实测 style.css TTFB 5.4s、总计 8.8s），
       * 于是每次打开都要把 23 个文件重新下一遍；HTTP/1.1 同域只并发 6 条，
       * 23 ÷ 6 × 2.5s ≈ 10 秒起步。用户实报「还是慢」，根子在这。
       *
       * 而「改完看不到」**本来就已经有独立兜底**：startVersionWatch 每 60 秒
       * 对一次 /api/web-version 的指纹，变了就弹「代码有更新」提示条
       * （misc.mjs:505，2026-10-17 一天踩两回后加的）。SW 不必再当第二道保险，
       * 它付出的代价是慢链路上缓存全废。
       *
       * 主动刷新的语义必须保住：用户点了「刷新页面」= 「我知道有新版，给我新的」。
       * 那时导航请求的 request.cache === 'reload'，走下面 forceNet 分支 ——
       * **连整个静态缓存一起清掉**再拉。只清 HTML 不够：HTML 换新了、js 还是
       * 缓存里那份旧的，新结构配旧脚本才会真的白屏。宁可慢一次，给一套完整的。
       */
      const forceNet = isNav && e.request.cache === 'reload';

      if (forceNet) {
        cache = await (async () => {
          await caches.delete(CACHE);
          return caches.open(CACHE);
        })();
        try {
          const r = await fetch(e.request, { cache: 'no-store' });
          if (r && r.ok) cache.put(e.request, r.clone());
          return r;
        } catch {
          return (await cache.match('/')) ?? new Response('', { status: 504, statusText: 'offline' });
        }
      }

      if (isCode) {
        const hit = await cache.match(e.request);
        // 后台更新：先把请求踢出去，再用它刷新缓存（命中时不等它，不阻塞这一屏）
        const refresh = fetch(e.request)
          .then((r) => {
            if (r && r.ok) cache.put(e.request, r.clone());
            return r;
          })
          .catch(() => null);
        if (hit) return hit;
        return (
          (await refresh) ??
          (isNav ? await cache.match('/') : null) ??
          new Response('', { status: 504, statusText: 'offline' })
        );
      }

      const hit = await cache.match(e.request);
      // 后台更新：fetch 失败（离线/服务重启中）静默吞掉，缓存里还有旧的就先用旧的
      const refresh = fetch(e.request)
        .then((r) => {
          if (r && r.ok) cache.put(e.request, r.clone());
          return r;
        })
        .catch(() => null);
      return hit ?? (await refresh) ?? new Response('', { status: 504, statusText: 'offline' });
    })(),
  );
});
