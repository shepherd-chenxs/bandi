/*
 * sw.js —— Service Worker 缓存骨架（2026-11 手机端增量，P1-3）。
 *
 * 策略（设计 §5 T05 / §3.3.1.3）：
 *   · 安装期预缓存核心静态（`/`、CSS、入口 JS、**js/*.mjs 全量**、manifest、图标、配对落地页）；
 *   · 运行期对同源 GET 静态资源一律 **stale-while-revalidate**：先回缓存（弱网局域网
 *     二次加载明显快），后台再拉新版入库 —— 于是"改文件后刷新两次内拿到新版本"
 *     （第一刷：旧缓存先回、新版进库；第二刷：命中新版）；
 *   · **`/api/*` 一律放行不缓存** —— 本地优先产品，数据以服务端为准（PRD P1-3 的硬口径）；
 *   · `/pair`（落地页，地址里带着一次性 token）与 `/sw.js`（SW 自己）也永不缓存。
 *
 * 与 startVersionWatch 共存：SW 更新静态后 /api/web-version 的指纹照常变化，
 * 「刷新页面」提醒条机制不动（设计 §1.1）。缓存名里的 VERSION 是人工旋钮：
 *   静态布局大改（预缓存清单变了）时 +1，逼所有客户端整包重建。
 */

const VERSION = 'v3';
const CACHE = `bandi-static-${VERSION}`;

/*
 * 预缓存清单（SW 不能 glob，手工列 —— 设计 §3.3.1.3 第 1 条）：
 * **新增 js 模块时同步这份清单，并把 VERSION +1**，否则老客户端拿不到新模块（整页白）。
 * js/*.mjs 全部在局域网一次拉完，二十来个文件代价很小；vendor/ 也进（二维码是配对必需件）。
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
  '/js/pair-claim.mjs',
  '/js/pairing.mjs',
  '/js/plugin-data.mjs',
  '/js/projects.mjs',
  '/js/run-progress.mjs',
  '/js/roles.mjs',
  '/js/settings.mjs',
  '/js/shell.mjs',
  '/js/skills.mjs',
  '/js/state.mjs',
  '/js/ui.mjs',
  '/js/workflows.mjs',
  '/js/vendor/qrcode.mjs',
];

const CORE = [
  '/',
  '/style.css',
  '/mobile.css',
  '/app.mjs',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/pair.html',
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
      // 清掉旧版本的缓存：名字里带 VERSION，留下来的都是上一代
      for (const name of await caches.keys()) {
        if (name.startsWith('bandi-static-') && name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
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

  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
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
