/*
 * security/csp.mjs —— 内容安全策略（2026-11-08）。
 *
 * **为什么要有它**：界面是「无构建 + innerHTML 拼字符串」—— 283 处 innerHTML、2600 多处
 * 模板插值，安全性全靠 `esc()` 这一条纪律。而 agent 的输出恰好是会被原样渲染进 DOM 的
 * 不可信内容（它会复述网页、文件、命令输出）。纪律会漏，漏一次就是存储型 XSS。
 * CSP 是**机制**：漏转义时由浏览器挡住，而不是等人 review 出来。
 *
 * **script-src 用哈希，不用 'unsafe-inline'**：
 * index.html 里那几段内联脚本（定主题、启动看门狗）在启动路径上，挪不得；给它们算
 * sha256 就等于「**只有这几段**能跑」—— 注入进来的 `<script>…</script>`、`onerror=`、
 * `javascript:` 一律执行不了。加 'unsafe-inline' 则等于没加（内联脚本和事件属性全都放行）。
 *
 * **哈希现算，不维护一份表**：按 index.html 的 mtime+size 缓存，文件改了自动重算。
 * 手工维护的哈希表必然漂移 —— 那是这个仓库最反感的欠账形态。
 *
 * ⚠️ **CRLF 归一**：浏览器在输入流预处理阶段就把 CRLF 折成 LF，哈希算的是**折过之后**的
 * 文本。这里先归一化再算，否则 Windows 上用 autocrlf 检出（CRLF）会让所有内联脚本失效
 * —— 而失效的表现是「主题闪一下 + 看门狗不在」，不报错，很难看出来。
 *
 * 这一层是**兜底**，不是替代 `esc()`：CSP 挡不住「合法位置上的合法 HTML」（比如注入一张
 * `<img src>` 到外域）。两件事都要做。
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

/** 内联脚本：有 src 的归 'self' 管，只看没有 src 的 */
const INLINE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

let cache = { key: '', policy: '' };

/** 把一段 HTML 里所有内联 <script> 折成 CSP 的哈希源（顺序无关，浏览器不挑） */
export function inlineScriptHashes(html) {
  /*
   * ⚠️ **必须先剥掉 HTML 注释**（2026-11-08 实抓）：index.html 的头部注释里就写着
   * 「紧跟的内联 `<script>` 抢在解析 body 之前把 data-theme 定下来」—— 那句散文里的
   * `<script>` 会被正则当成开标签，一直吞到**第一个真脚本的 `</script>`**，
   * 于是第一段哈希算的是「注释 + 脚本」的混合体 → 真的那段脚本浏览器认不出来 → 被拦。
   * 浏览器不把注释里的标签当标签，这里必须一致。
   */
  const text = String(html).replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  INLINE_SCRIPT.lastIndex = 0;
  let m;
  let seen = 0;
  while ((m = INLINE_SCRIPT.exec(text))) {
    seen += 1;
    if (/\bsrc\s*=/i.test(m[1])) continue;
    out.push(`'sha256-${crypto.createHash('sha256').update(m[2], 'utf8').digest('base64')}'`);
  }
  /*
   * 自检：标签数 ≠ 匹配数，说明这段 HTML 里出现了这个正则看不懂的写法（比如 `</script>`
   * 被写进了 JS 字符串）。不静默降级成 'unsafe-inline'（那等于把这道闸关掉还假装开着），
   * 只把问题喊出来 —— 页面上表现为"某段内联脚本不执行"，日志里能看到根因。
   */
  const opens = (text.match(/<script\b/gi) ?? []).length;
  if (opens !== seen) {
    console.warn(`[CSP] index.html 有 ${opens} 个 <script 开标签，只认出 ${seen} 段 —— 内联脚本哈希可能不全，见 security/csp.mjs`);
  }
  return out;
}

/**
 * 整站策略。**一份**，所有响应共用（JSON / 静态资源 / 登录页都带上）——
 * 按路由各写一份就会漏，而漏掉的那条恰好是新加的那条。
 *
 * 逐项理由：
 *   · default-src 'self'       —— 兜底：没点名的取全部只许本站
 *   · script-src               —— 本站脚本 + index.html 的内联脚本哈希
 *   · style-src 'unsafe-inline'—— 界面有 140+ 处 style="…"（进度条、画布坐标），这条免不了
 *   · img-src data: blob:      —— 头像/图标是本站文件，CSS 里用 data: 内联 SVG，附件预览用 blob:
 *   · connect-src 'self'       —— 前端只跟自己的控制面说话（远端节点也由控制面代理）
 *   · worker-src 'self' blob:  —— PWA 的 sw.js
 *   · object-src 'none'        —— 不嵌插件对象
 *   · base-uri 'none'          —— 防 <base> 改写相对地址（把脚本指到外域）
 *   · form-action 'self'       —— 登录表单只许提交给自己
 *   · frame-ancestors 'none'   —— 防点击劫持（本产品没有任何「被嵌进别人页面」的场景）
 */
export function policyFor(indexHtmlPath) {
  let st = null;
  try {
    st = fs.statSync(indexHtmlPath);
  } catch {
    /* 文件不在就没有哈希可言：守成「只许本站脚本」，页面本来也打不开 */
  }
  const key = st ? `${st.mtimeMs}:${st.size}` : 'none';
  if (cache.key === key) return cache.policy;

  let hashes = [];
  if (st) {
    try {
      hashes = inlineScriptHashes(fs.readFileSync(indexHtmlPath, 'utf8'));
    } catch {
      hashes = [];
    }
  }

  const policy = [
    "default-src 'self'",
    ["script-src 'self'", ...hashes].join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  cache = { key, policy };
  return policy;
}
