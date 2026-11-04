#!/usr/bin/env node
/**
 * **契约自检**：路由权限清单 ↔ 实现 ↔ 调用方 三方对账（2026-11-04 加）。
 *
 * 为什么要有：`apps/server/src/security/route-policy.mjs` 是**默认拒绝**的路由清单 ——
 * 没登记的 `/api/*` 一上线就是 404 `E4090`。它的注释里写着一句"smoke 的覆盖率扫描会逼着
 * 两端同步"，但那条扫描只在**跑服务端的冒烟用例里**才生效（要起服务、要真库），而**反方向**
 * （清单里登记了、实现侧却没有 handler）和**调用方**（前端/插件/手机调了一个没登记的路）
 * 都没有静态闸门。于是会出现两种很贵的坏账：
 *
 *   · 清单登记了、实现侧没有 → 线上 404，但**谁也发现不了**：没有调用方就没有冒烟用例，
 *     它是"看起来存在、其实不存在"的接口，等到有人按清单去调它才炸；
 *   · 前端调了、清单没登记 → 线上被默认拒绝，本地回环形态下可能因为免鉴权口径不同而
 *     "开发时好好的"，一到服务器形态就 403/404。
 *
 * 这个工具把三条不变量钉住（按"误报从低到高"排，和 check-doc-drift 同一套哲学）：
 *
 *   ① **无实现端点（红）**：清单里每条 path 都要能在 `apps/server/src/routes/*.mjs`
 *      或 `server.mjs` 的内联路由里找到对应实现 —— 写法可以是字面量全等、也可以是正则
 *      （带 `:id` 的路径实现侧几乎都是正则）。判定方式：把清单里的 path 正则"反生成"一条
 *      样本路径（`([^/]+)`→`x`、`(\d+)`→`1`、可选组→空、alternation 取第一支），再拿样本
 *      去过实现侧收集到的三种匹配器（字面量全等 / 正则字面量 / `startsWith` 前缀）。
 *      **零容忍**：判不了就红。
 *   ② **未登记调用（红）**：`apps/web`、`plugins/`、`apps/mobile/` 里出现的 `/api/...`
 *      路径（注释不算），必须是清单里某条能匹配上的路径，否则红。抽取时会把同一行里的
 *      字符串拼接与模板串**拼回一条路径**（`'/api/x/' + encodeURIComponent(id) + '/y'`
 *      → `/api/x/${}/y`），并把同文件/同仓的常量基址展开（`${LOCAL_BASE}/status`、
 *      `LOCAL_BASE = '/api/local'`），否则 `api('/api/conversations/' + id)` 这种最常见
 *      的写法会被误报成"只调了前缀"。
 *   ③ **无调用方端点（warning，不失败）**：清单里有、但仓内找不到任何使用点的端点。
 *      使用点比 ② 扫得**宽**：除前端/插件/手机外，还算上服务端内部的跨机调用
 *      （`node.mjs` 调远端 `/api/nodes/*`、`collab-branch.mjs` 调中心、`cli.mjs` 的
 *      `path: '/api/...'`）—— 这些是真实的契约消费方，不算僵尸。
 *      但 ③ 只 warning、不红：因为"没有使用点"可能是**外部契约**（仓外 CLI / 已装出去的
 *      旧客户端 / 分公司机器），不是错误。所以每条要么进下面的 ALLOW 表（附一句理由），
 *      要么就老实当"疑似僵尸"打出来给人复核。改行为边界（新增可删的端点）先改 ALLOW。
 *
 * 不查什么（**故意**的）：
 *   · **方法级**登记不查。PUT /api/prefs 这种"路径登记了 GET、PUT 没登记"是**故意**的
 *     （smoke-pair ⑨、smoke-admin-invariant 盯着它），查了会天天误报。方法与路径的组合
 *     由服务端冒烟负责（它们会真起服务、真带凭据打）。
 *   · 不查 `apps/server/src/smoke-*.mjs`（测试自己调接口不算"契约消费方"）、不查
 *     `routes/*.mjs` 的实现体（那是实现侧，反过来会自我覆盖 ①）。
 *   · 不查文档里的 `/api/...`（文档是叙述，不是调用；文档对账由 check-doc-drift 管）。
 *   · 快照目录（`apps/desktop/runtime`、`apps/desktop/target`、`tmp/`、`apps/mobile/target`、
 *     `gen/`）一律跳过 —— 它们是构建产物，不是源码。
 *
 * 判定口径（这三条是踩过坑后定的，改之前先想清楚）：
 *   · 带 `:id` 的清单条目不要求实现侧也写成同样的正则，只要求**样本路径**能命中实现侧的
 *     某个匹配器；实现侧用 `pathname === '/api/x'`、`re.exec(pathname)`、
 *     `pathname.startsWith('/api/x/')` 都算。
 *   · 只被 `startsWith('/api/namespace/')` 这种**命名空间闸**认领的条目，不判红、打 `·`
 *     放"无法静态判定"清单 —— 实现侧可能用分段解析（split）而不是正则，静态判不出来时
 *     宁可跳过也不误报（红一次，人就开始整片忽略输出）。
 *   · 调用方抽取里 `${...}` 一律当"一段动态内容"；行尾的 `${...}` 可能是查询串
 *     （`${q}`）或路径后缀（`${p}`），判登记时两种都试。判"有没有使用点"时，以 `${...}`
 *     结尾的形状放宽成 `.*`（apiRepo 这类**拼接帮手**静态拆不开，别拿它当"没人调"）。
 *
 * 跑法：
 *   node tools/check-contracts.mjs                     # 三类全跑（默认）
 *   node tools/check-contracts.mjs --only=missing-impl # 只跑 ①（missing-impl / calls / orphans）
 *   node tools/check-contracts.mjs --only=calls        # 只跑 ②
 *   node tools/check-contracts.mjs --only=orphans      # 只跑 ③
 *   node tools/check-contracts.mjs --list              # 只打印清单（id / 方法 / path / auth），不检查
 *
 * 退出码：0 通过（③ 有 warning 也算通过）/ 1 有红（① 或 ②）/ 2 参数不认识。
 *
 * 自测方法（**不要改真文件**；仓库惯例是造 tmp/ 下的一次性反例）：
 *
 *   # ① 反例：复制一份清单，插一条"实现侧不存在"的路由
 *   cp apps/server/src/security/route-policy.mjs tmp/route-policy-bad.mjs
 *   #   在 ROUTES 末尾插一行（注意保持 p() 写法）：
 *   #   { id: 'ghost', m: ['GET'], path: p('/api/definitely-not-here'), auth: 'public' },
 *   node tools/check-contracts.mjs --only=missing-impl --policy=tmp/route-policy-bad.mjs
 *   #   → 应该打印 ✗ ghost ... 并以 1 退出
 *
 *   # ② 反例：造一个"前端调了没登记路径"的假调用方目录
 *   mkdir tmp/fake-callers
 *   echo "fetch('/api/definitely/not/here', { method: 'POST' });" > tmp/fake-callers/bad.mjs
 *   node tools/check-contracts.mjs --only=calls --callers=tmp/fake-callers
 *   #   → 应该打印 ✗ tmp/fake-callers/bad.mjs → /api/definitely/not/here 并以 1 退出
 *
 *   # ③ 的"反例"就是临时从 ALLOW 表里拿掉一条（别真删文件），或在上面 --policy 反例里
 *   #   补一条不存在使用点的 `/api/definitely-not-here`，然后 --only=orphans 观察它出现在
 *   #   "疑似僵尸"里（warning、exit 0）。
 *
 * `--policy=` / `--callers=` 两个参数是**给自测用的注入钩子**（默认都指向仓内真路径）。
 * 注意 `--callers=` 只替换"扫描面"：③ 的使用点也会跟着只看这份注入目录，别拿它当日常参数。
 *
 * 维护提示：
 *   · 新增 ALLOW 条目：`ALLOW_ORPHANS` 里一条 `{ id, why }`，`why` 必须写清"为什么没人调
 *     还留着"（外部契约 / 仓外 CLI / 兼容垫片 / 预留）。id 写错会在输出里提示"ALLOW 表项
 *     已过期"，不会静默失效。
 *   · 新增"故意不登记的调用"：`ALLOW_CALLS` 里一条 `{ re, why }`，并尽量写窄（整条路径而不是
 *     前缀），否则等于把 ② 关掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.relative(repo, p).split(path.sep).join('/');
const read = (f) => fs.readFileSync(path.join(repo, f), 'utf8');

/* ------------------------------------------------------------------ 参数 */

const ONLY = new Set(['missing-impl', 'calls', 'orphans']);
const usage = () => console.error(
  '用法：node tools/check-contracts.mjs [--only=missing-impl|calls|orphans] [--list]\n'
  + '      node tools/check-contracts.mjs [--policy=<清单文件>] [--callers=<扫描目录>]（自测钩子）',
);

let only = null;
let listOnly = false;
let policyFile = 'apps/server/src/security/route-policy.mjs';
let callersRoot = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--list') listOnly = true;
  else if (a.startsWith('--only=')) {
    const v = a.slice('--only='.length);
    if (!ONLY.has(v)) { console.error(`✗ 不认识的 --only 值：${v}`); usage(); process.exit(2); }
    only = v;
  } else if (a.startsWith('--policy=')) policyFile = a.slice('--policy='.length);
  else if (a.startsWith('--callers=')) callersRoot = a.slice('--callers='.length);
  else { console.error(`✗ 不认识的参数：${a}`); usage(); process.exit(2); }
}
const want = (k) => only === null || only === k;

/* ------------------------------------------------------------------ 清单 */

let ROUTES;
try {
  const mod = await import(pathToFileURL(path.join(repo, policyFile)).href);
  ROUTES = mod.ROUTES;
  if (!Array.isArray(ROUTES) || !ROUTES.length) throw new Error('没有导出 ROUTES 数组');
} catch (e) {
  console.error(`✗ 加载不了路由清单 ${policyFile}：${e?.message ?? e}`);
  process.exit(1);
}
const routePath = (r) => String(r?.path?.source ?? '');

if (listOnly) {
  for (const r of ROUTES) console.log(`${String(r.id).padEnd(24)} ${String(r.m?.join('/')).padEnd(14)} ${routePath(r)}  auth=${r.auth}`);
  console.log(`\n共 ${ROUTES.length} 条`);
  process.exit(0);
}

/* ------------------------------------------------------------------ 注释 / 字面量处理 */

/**
 * 把 JS 注释挖掉（保留换行，行号/行内定位不漂）。**保留正则字面量**（实现侧匹配器要用）。
 * 单行注释里的 `\/api\/` 常出现在 handler 的说明里，不挖掉会把说明当实现。
 */
function maskJsComments(src) {
  let out = ''; let i = 0; const n = src.length; let state = 'code';
  while (i < n) {
    const c = src[i]; const d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") state = 'sq'; else if (c === '"') state = 'dq'; else if (c === '`') state = 'bt';
      out += c; i += 1; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c; } else out += ' '; i += 1; continue; }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; out += '  '; i += 2; }
      else { out += c === '\n' ? c : ' '; i += 1; }
      continue;
    }
    out += c;
    if (c === '\\') { out += d ?? ''; i += 2; continue; }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'bt' && c === '`')) state = 'code';
    i += 1;
  }
  return out;
}

/**
 * 调用方侧用：注释与**正则字面量**都挖掉（正则里的引号，比如 `/[&<>"']/g`，会把
 * 逐字符扫描的引号状态带歪，进而漏掉后面所有 `/api/` 字面量 —— 2026-11-04 实测踩到：
 * pair-claim.mjs 里有个 `/[&<>"']/g`，结果整个 `/api/pair/claim` 被漏扫）。
 * 判定"这是不是正则起点"用上一非空字符的启发式（表达式起始/操作符之后）。
 */
/*
 * 判定"这个 `/` 是不是正则起点"用上一非空字符的启发式（表达式起始 / 操作符之后）。
 * ⚠️ 不要收 `<` `>`：HTML 模板串里的 `</label>` `</span>` 会把后面的内容整段当正则挖掉
 * （2026-11-04 踩过：skills.mjs 里一条 `</label><span ...>` 之后所有 `/api/...` 全被漏扫，
 * ③ 于是误报 expert.hire / schedule.run 等"无调用方"）。`=>` 单独判。
 */
const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '/']);
function maskJsCommentsAndRegex(src) {
  let out = ''; let i = 0; const n = src.length; let state = 'code';
  let lastSig = '';
  const keywords = /(?:^|[^\w$])(?:return|typeof|case|in|of|new|delete|void|do|else|instanceof|yield|await)$/;
  const arrow = (t) => /=>\s*$/.test(t);
  while (i < n) {
    const c = src[i]; const d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === '/') {
        const before = out.slice(Math.max(0, out.length - 12));
        if (REGEX_PREV.has(lastSig) || !lastSig || arrow(before) || keywords.test(before.trimEnd())) {
          // 正则字面量：挖到配对 /（字符类里的 / 不算结束）
          let j = i + 1; let inClass = false;
          while (j < n) {
            const ch = src[j];
            if (ch === '\n') break;
            if (ch === '\\') { j += 2; continue; }
            if (ch === '[') inClass = true;
            else if (ch === ']' && inClass) inClass = false;
            else if (ch === '/' && !inClass) break;
            j += 1;
          }
          if (j < n && src[j] === '/') {
            for (let k = i; k <= j; k += 1) out += src[k] === '\n' ? '\n' : ' ';
            i = j + 1; continue;
          }
        }
      }
      if (c === "'") state = 'sq'; else if (c === '"') state = 'dq'; else if (c === '`') state = 'bt';
      out += c;
      if (!/\s/.test(c)) lastSig = c;
      i += 1; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c; lastSig = ''; } else out += ' '; i += 1; continue; }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; out += '  '; i += 2; }
      else { out += c === '\n' ? c : ' '; i += 1; }
      continue;
    }
    // 模板串里的 ${...}：**整段跳过**（内部可能有嵌套反引号/引号/正则，
    // 逐字符走会把嵌套模板的收尾反引号当成外层模板的结尾，后面整片代码就被当字符串/注释 ——
    // 2026-11-04 踩过：projects.mjs 看板 HTML 里 `${cond ? \`...\` : ''}` 之后
    // /api/collab/tasks/:id 与 /api/git/prs/refresh 全被漏扫，③ 误报"无人调"）。
    if (state === 'bt' && c === '$' && d === '{') {
      let depth = 1; let k = i + 2;
      while (k < n && depth > 0) {
        if (src[k] === '{') depth += 1;
        else if (src[k] === '}') depth -= 1;
        k += 1;
      }
      out += src.slice(i, k);
      i = k;
      continue;
    }
    out += c;
    if (c === '\\') { out += d ?? ''; i += 2; continue; }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'bt' && c === '`')) state = 'code';
    i += 1;
  }
  return out;
}
const maskHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));

const PATH_TAIL = /^[A-Za-z0-9_\-/.${}]*$/;
/** 是不是一条"看起来像路径"的形状（排除错误文案/HTML/说明文字里的 /api/ 提及） */
function isPathShape(s) {
  if (!s.includes('/api/')) return false;
  if (s === '/api' || s === '/api/') return false;
  if (!PATH_TAIL.test(s)) return false;
  return s.startsWith('/api/') || s.startsWith('${}/api/');
}

/** 展开模板串 body 里的 ${expr}：能对上仓内常量的直接展开，否则当动态段 */
function expandTemplateBody(body, consts) {
  let out = ''; let i = 0;
  while (i < body.length) {
    const j = body.indexOf('${', i);
    if (j < 0) { out += body.slice(i); break; }
    out += body.slice(i, j);
    let depth = 1; let k = j + 2;
    while (k < body.length && depth > 0) {
      if (body[k] === '{') depth += 1;
      else if (body[k] === '}') depth -= 1;
      k += 1;
    }
    const expr = body.slice(j + 2, k - 1).trim();
    out += consts.has(expr) ? consts.get(expr) : '${}';
    i = k;
  }
  return out;
}
const skipWs = (s, p) => { while (p < s.length && /\s/.test(s[p])) p += 1; return p; };

/** 收集 `const/let/var NAME = '/api/...'`（跨文件共用；只看 /api/ 开头的常量值，碰撞面很小） */
function collectConsts(files) {
  const consts = new Map();
  for (const f of files) {
    let src;
    try { src = read(f); } catch { continue; }
    const code = f.endsWith('.html') ? maskHtmlComments(src) : f.endsWith('.json') ? src : maskJsCommentsAndRegex(src);
    for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*'(\/api\/[^']*)'/g)) consts.set(m[1], m[2]);
  }
  return consts;
}

/**
 * 抽出一段代码里的所有"路径表达式"形状。见文件头的判定口径。
 * 返回 [{ raw, line, prefix, file }]。
 */
function extractShapes(code, file, consts) {
  const shapes = [];
  const push = (raw, start, end) => {
    if (!raw.includes('/api/')) return;
    const q = raw.indexOf('?');
    if (q >= 0) raw = raw.slice(0, q);
    if (!isPathShape(raw)) return;
    const lineStart = code.lastIndexOf('\n', start) + 1;
    const lineEndRaw = code.indexOf('\n', end);
    const lineEnd = lineEndRaw === -1 ? code.length : lineEndRaw;
    shapes.push({ raw, line: code.slice(lineStart, lineEnd), prefix: code.slice(Math.max(0, start - 30), start), file });
  };
  let i = 0; const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c !== "'" && c !== '"' && c !== '`') { i += 1; continue; }
    const tok = readLiteral(code, i, consts);
    if (!tok) { i += 1; continue; }
    let shape = tok.shape;
    let end = tok.end;
    let start = i;
    // 向右吃 `+` 拼接：'/api/x/' + encodeURIComponent(id) + '/y'
    for (;;) {
      const p = skipWs(code, end);
      if (code[p] !== '+') break;
      let q = skipWs(code, p + 1);
      if (code[q] === "'" || code[q] === '"' || code[q] === '`') {
        const nxt = readLiteral(code, q, consts);
        if (!nxt) break;
        shape += nxt.shape;
        end = nxt.end;
        continue;
      }
      // 普通表达式：按括号配平吃到同层的 + / 终止符
      let r = q; let depth = 0;
      while (r < n) {
        const ch = code[r];
        if (ch === '(' || ch === '[' || ch === '{') depth += 1;
        else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) break; depth -= 1; }
        else if (depth === 0 && (ch === '+' || ch === ',' || ch === ';' || ch === '\n')) break;
        r += 1;
      }
      shape += '${}';
      end = r;
      if (code[r] !== '+') break;
    }
    // 纯常量定义（const X = '/api/...'）不是调用点；startsWith('/api/') 是路由逻辑不是调用
    const isConstDef = /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*['"]/.test(code.slice(code.lastIndexOf('\n', start) + 1, end)) && !/[+?]/.test(shape);
    const isRouterLogic = /(?:startsWith|endsWith|includes|indexOf|match|replace|test)\(\s*$/.test(code.slice(Math.max(0, start - 30), start));
    if (!isConstDef && !isRouterLogic) push(shape, start, end);
    // 模板串的 body 里可能还有代码（登录页的 HTML+JS）：递归再扫一遍
    if (tok.kind === 'template' && tok.body.includes('/api/')) {
      const inner = maskJsCommentsAndRegex(tok.body);
      for (const x of extractShapes(inner, file, consts)) shapes.push(x);
    }
    i = tok.end;
  }
  if (process.env.BANDI_CONTRACTS_DEBUG && file.includes('skills')) console.log('DBG scanEnd', i, 'of', n, JSON.stringify(code.slice(Math.max(0, i - 100), i + 100)));
  return shapes;
}

/** 从 i 起读一个字符串/模板串；模板里的 ${...} 按常量展开或占位 */
function readLiteral(code, i, consts) {
  const quote = code[i];
  const n = code.length;
  if (quote !== '`') {
    let j = i + 1; let body = '';
    while (j < n && code[j] !== quote) {
      if (code[j] === '\\') { body += code[j + 1] ?? ''; j += 2; continue; }
      body += code[j]; j += 1;
    }
    if (j >= n) return null;
    return { kind: 'string', shape: body, body, end: j + 1 };
  }
  let j = i + 1; let body = '';
  while (j < n) {
    const c = code[j];
    if (c === '\\') { body += code[j + 1] ?? ''; j += 2; continue; }
    if (c === '`') break;
    if (c === '$' && code[j + 1] === '{') {
      let depth = 1; let k = j + 2;
      while (k < n && depth > 0) {
        if (code[k] === '{') depth += 1;
        else if (code[k] === '}') depth -= 1;
        k += 1;
      }
      body += code.slice(j, k);
      j = k;
      continue;
    }
    body += c; j += 1;
  }
  if (j >= n) return null;
  return { kind: 'template', shape: expandTemplateBody(body, consts), body, end: j + 1 };
}

/* ------------------------------------------------------------------ 清单 path → 样本 */

/**
 * 把清单里的 path 正则"反生成"一条样本路径。只认 p() 生产出来的那几种构造：
 * 字面段、`([^/]+)`、`(\d+)`、`(?:a|b|c)`（必选取第一支 / 可选整段丢）、`\/` 转义。
 * 遇到没见过的构造返回 null → 该条进"无法静态判定"，**不猜、不红**。
 */
function genSample(source) {
  let s = String(source);
  if (s.startsWith('^')) s = s.slice(1);
  if (s.endsWith('$')) s = s.slice(0, -1);
  return genPart(s);
}
function genPart(s) {
  let out = ''; let i = 0; const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\' && (s[i + 1] === '/' || s[i + 1] === '.' || s[i + 1] === '-')) { out += s[i + 1]; i += 2; continue; }
    if (c === '[') { const end = s.indexOf(']', i); if (end < 0) return null; out += 'x'; i = end + 1; continue; }
    if (c === '(') {
      let depth = 0; let j = i;
      for (; j < n; j += 1) {
        if (s[j] === '\\') { j += 1; continue; }
        if (s[j] === '(') depth += 1;
        else if (s[j] === ')') { depth -= 1; if (depth === 0) break; }
      }
      if (j >= n) return null;
      const inner = s.slice(i + 1, j);
      const optional = s[j + 1] === '?';
      const nonCap = inner.startsWith('?:');
      const body = nonCap ? inner.slice(2) : inner;
      if (body === '[^/]+' || body === '[^\\/]+') out += 'x';
      else if (body === '\\d+') out += '1';
      else if (nonCap) {
        if (!optional) {
          const alts = splitAlts(body);
          const first = genPart(alts[0] ?? '');
          if (first == null) return null;
          out += first;
        }
      } else return null;
      i = optional ? j + 2 : j + 1;
      continue;
    }
    if (c === '?' || c === '*' || c === '+' || c === '{') return null;
    out += c; i += 1;
  }
  return out;
}
function splitAlts(body) {
  const alts = []; let cur = ''; let depth = 0;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '\\') { cur += c + (body[i + 1] ?? ''); i += 1; continue; }
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (c === '|' && depth === 0) { alts.push(cur); cur = ''; continue; }
    cur += c;
  }
  alts.push(cur);
  return alts;
}
const SAMPLES = new Map();
for (const r of ROUTES) SAMPLES.set(r, genSample(routePath(r)));

/* ------------------------------------------------------------------ 实现侧匹配器 */

const implFiles = [
  'apps/server/src/server.mjs',
  ...fs.readdirSync(path.join(repo, 'apps/server/src/routes'))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => `apps/server/src/routes/${f}`),
];
const implExact = new Set(); // 字面量全等（=== / path: / routes 对象键）
const implPrefix = new Set(); // startsWith('/api/...') 前缀
const implRegex = []; // 正则字面量（带 \/api\/ 的）

/** 从文本里收集正则字面量（用字符类/转义配平找真正的结束 /） */
function collectRegexLiterals(text) {
  const found = [];
  let i = 0; const n = text.length;
  while (i < n) {
    const pos = text.indexOf('/', i);
    if (pos < 0) break;
    if (pos > 0 && text[pos - 1] === '\\') { i = pos + 1; continue; }
    let j = pos + 1; let inClass = false; let closed = false;
    while (j < n) {
      const c = text[j];
      if (c === '\n') break;
      if (c === '\\') { j += 2; continue; }
      if (c === '[') { inClass = true; j += 1; continue; }
      if (c === ']' && inClass) { inClass = false; j += 1; continue; }
      if (c === '/' && !inClass) { closed = true; break; }
      j += 1;
    }
    if (!closed) { i = pos + 1; continue; }
    found.push(text.slice(pos + 1, j));
    i = j + 1;
  }
  return found;
}
const ROUTE_KEY = /'([A-Z]+)\s+(\/api\/[A-Za-z0-9_\-/]*)'\s*:/g;
for (const f of implFiles) {
  let code;
  try { code = maskJsComments(read(f)); } catch { continue; }
  for (const body of collectRegexLiterals(code)) {
    if (!body.includes('\\/api\\/')) continue;
    try { implRegex.push(new RegExp(body)); } catch { /* 解不出的正则不参与判定（宁可漏判不误报） */ }
  }
  // 字符串字面量：/api/ 开头且只含路径字符。startsWith 的参数算前缀，其余算全等。
  for (const m of code.matchAll(/'(\/api\/[A-Za-z0-9_\-/]*)'/g)) {
    const before = code.slice(Math.max(0, m.index - 30), m.index);
    if (/(?:startsWith|endsWith)\(\s*$/.test(before)) implPrefix.add(m[1]);
    else implExact.add(m[1]);
  }
  for (const m of code.matchAll(/"(\/api\/[A-Za-z0-9_\-/]*)"/g)) {
    const before = code.slice(Math.max(0, m.index - 30), m.index);
    if (/(?:startsWith|endsWith)\(\s*$/.test(before)) implPrefix.add(m[1]);
    else implExact.add(m[1]);
  }
  for (const m of code.matchAll(ROUTE_KEY)) implExact.add(m[2]);
}
function implCoverage(sample) {
  if (implExact.has(sample)) return 'exact';
  if (implRegex.some((re) => re.test(sample))) return 'regex';
  for (const pre of implPrefix) {
    if (!pre.includes('/api/')) continue;
    if (sample === pre || sample.startsWith(pre.endsWith('/') ? pre : `${pre}/`)) return 'prefix';
  }
  return null;
}

/* ------------------------------------------------------------------ 调用方使用点 */

const EXTS = ['.mjs', '.js', '.html', '.json', '.rs'];
const SNAPSHOT_SKIP = [
  'node_modules', '.git', 'tmp', 'target', 'gen', 'dist', 'docs',
  'avatars', 'icons', // 静态资源目录（二进制/图片，不扫）
];
function walk(dir, exts, skip) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    const rp = rel(p);
    if (rp.split('/').some((seg) => skip.includes(seg))) continue;
    if (ent.isDirectory()) out.push(...walk(p, exts, skip));
    else if (exts.some((e) => ent.name.endsWith(e))) out.push(rp);
  }
  return out;
}

// ② 的扫描面（规格就是这三个地方：前端 / 插件 / 手机）
const FRONT_ROOTS = ['apps/web', 'plugins', 'apps/mobile'];
// ③ 额外算上"服务端内部的跨机/CLI 调用方"（实现侧自己不算，否则自我覆盖）
const SERVER_CALLER_FILES = walk(path.join(repo, 'apps/server/src'), EXTS, SNAPSHOT_SKIP)
  .filter((f) => !f.startsWith('apps/server/src/routes/')
    && !f.startsWith('apps/server/src/security/')
    && !/^apps\/server\/src\/smoke-/.test(f)
    && f !== 'apps/server/src/server.mjs');

let frontFiles;
if (callersRoot) {
  const dir = path.resolve(repo, callersRoot);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`✗ --callers= 指向的不是目录：${callersRoot}`);
    process.exit(2);
  }
  frontFiles = walk(dir, EXTS, []);
} else {
  frontFiles = FRONT_ROOTS.flatMap((root) => walk(path.join(repo, root), EXTS, SNAPSHOT_SKIP));
}

const consts = collectConsts([...frontFiles, ...SERVER_CALLER_FILES]);

function collect(files, { serverSide }) {
  const out = [];
  for (const f of files) {
    let src;
    try { src = read(f); } catch { continue; }
    let code;
    if (f.endsWith('.html')) code = maskHtmlComments(src);
    else if (f.endsWith('.json')) code = src;
    else code = maskJsCommentsAndRegex(src);
    for (const x of extractShapes(code, f, consts)) {
      if (serverSide && !CALL_HINT.test(x.line)) continue; // 服务端只有"真调用上下文"才算使用点
      out.push(x);
    }
  }
  return out;
}
// 服务端内部调用方的"调用上下文"判据：fetch(...) / path: '...' / api( 等
const CALL_HINT = /fetch\s*\(|new EventSource\s*\(|\b(?:api|post|put|patch|del|get|req|call)\s*\(\s*['"`]|\bpath\s*:|['"]api['"]\s*:/;

const frontUse = collect(frontFiles, { serverSide: false });
const serverUse = callersRoot ? [] : collect(SERVER_CALLER_FILES, { serverSide: true });
if (process.env.BANDI_CONTRACTS_DEBUG) {
  for (const f of frontFiles) {
    const raw = read(f);
    const a = maskJsComments(raw).split('\n');
    const b = maskJsCommentsAndRegex(raw).split('\n');
    for (let ln = 0; ln < a.length; ln += 1) {
      const qa = (a[ln].match(/['"`]/g) ?? []).length;
      const qb = (b[ln].match(/['"`]/g) ?? []).length;
      if (qa !== qb) { console.log('DBGQ', f, ln + 1, JSON.stringify(a[ln].slice(0, 100)), '->', JSON.stringify(b[ln].slice(0, 100))); break; }
    }
  }
}

/* ------------------------------------------------------------------ 形状 → 清单条目 */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, (ch) => '\\' + ch);
/** 调用方形状 → 正则。`${}` 当一段动态内容；`broadTail` 时行尾那段放宽成 `.*`（拼接帮手） */
function shapeRe(raw, { broadTail }) {
  const parts = raw.split('${}');
  let re = '^';
  for (let k = 0; k < parts.length; k += 1) {
    re += escapeRe(parts[k]);
    if (k < parts.length - 1) re += k === parts.length - 2 && broadTail ? '.*' : '[^/]*';
  }
  return new RegExp(`${re}$`);
}

/** 这条使用点形状能命中哪些清单条目（路径级） */
function routeIdsOf(shape) {
  const ids = new Set();
  const concrete = shape.raw.replace(/\$\{\}/g, 'x');
  for (const r of ROUTES) if (r.path.test(concrete)) ids.add(r.id);
  // 行尾 ${} 也可能是查询串：去掉再试
  if (/\$\{\}$/.test(shape.raw)) {
    const trimmed = shape.raw.replace(/\$\{\}$/, '');
    if (trimmed) for (const r of ROUTES) if (r.path.test(trimmed)) ids.add(r.id);
  }
  // 反向：形状正则去套清单样本（字面段 vs 占位段对不齐时，这是唯一能对上的方向）
  const reTail = shapeRe(shape.raw, { broadTail: true });
  for (const r of ROUTES) {
    const s = SAMPLES.get(r);
    if (s && reTail.test(s)) ids.add(r.id);
  }
  // 只是某个命名空间的基址（'/api/local/' + 子路径）：任何样本以它开头就算
  if (shape.raw.endsWith('/')) {
    for (const r of ROUTES) {
      const s = SAMPLES.get(r);
      if (s && s.startsWith(shape.raw)) ids.add(r.id);
    }
  }
  return ids;
}

/** 这条调用方路径在清单里登记了吗（② 用；返回命中的 route id 或 null） */
function registeredBy(raw) {
  // 直接对清单正则试几种"具体化"变体（${} 段当 x；行尾 ${} 可能是查询串，也试去掉）
  for (const concrete of [raw, raw.replace(/\$\{\}/g, 'x'), raw.replace(/\$\{\}$/, '')]) {
    if (!concrete || concrete.includes('${}')) continue;
    for (const r of ROUTES) if (r.path.test(concrete)) return r.id;
  }
  const re = shapeRe(raw, { broadTail: false });
  for (const r of ROUTES) {
    const s = SAMPLES.get(r);
    if (s && re.test(s)) return r.id;
  }
  if (raw.endsWith('/')) {
    for (const r of ROUTES) {
      const s = SAMPLES.get(r);
      if (s && s.startsWith(raw)) return r.id;
    }
  }
  const tail = shapeRe(raw, { broadTail: true });
  for (const r of ROUTES) {
    const s = SAMPLES.get(r);
    if (s && tail.test(s)) return r.id;
  }
  return null;
}

/* ------------------------------------------------------------------ ALLOW 表 */

/*
 * ③ 的"无调用方但**故意保留**"清单。每条必须有一句 reason：
 * 要么是**仓外调用方**（装出去的 CLI / 分公司机器 / 远端节点 / 手机旧客户端），
 * 要么是**兼容垫片**（新前端已改走别的路，但旧客户端还认这条），要么是**明确预留**。
 * ⚠️ 不要往这里加"顺手能删但其实有人用"的条目 —— 这里只豁免 warning，不豁免 ①/②。
 */
const ALLOW_ORPHANS = [
  { id: 'auth.token', why: '换票链入口（IAM §6.2）：仓外 CLI / 脚本用密码+otp 换 at_ 票，前端登录走 /api/login' },
  { id: 'auth.refresh', why: '换票链续期：仓外 CLI / 脚本的 at_ 到期后用 rf_ 换新票（轮换语义见 security/refresh.mjs）' },
  { id: 'auth.revoke', why: '换票链撤销：仓外 CLI / 脚本凭票自撤（accessToken / refreshToken 至少一个）' },
  { id: 'pair.me', why: '旧手机客户端兼容垫片：新前端改问 /api/me（users.mjs 里带上了设备详情），这条留着给存量客户端' },
  { id: 'pair.device.revoke', why: '兼容垫片：语义等同 disconnect（pair.mjs:366「老接口，保留兼容」），新前端只调 disconnect' },
  { id: 'collab.invites', why: '兼容垫片：老的"按名字直接发码"，新流程是 branches 落行 + /invite；按「老接口保留兼容」留着' },
  { id: 'runtime.test', why: '契约保留、无 UI 消费（docs/现状.md:997）：原「按路径接入」弹窗撤了，接口按当时口径保留' },
  { id: 'ai.image', why: '外部/临时生图工具回环直调（前端设置页只消费 image-config / image-test）；生图能力唯一的 HTTP 出口' },
  { id: 'files.get', why: '附件/图片 URL 由服务端响应里的 url 字段回传（conversation.mjs / project.mjs 拼），前端不拼字面量' },
  { id: 'ssh.list', why: 'SSH 是**外部件**：远程连接面板由运行时装的插件按 manifest.permissions 声明后发起，仓内没有字面量调用' },
  { id: 'ssh.create', why: '同上（插件面板经通用插件通道发 /api/ssh/*，仓内仅 experts.mjs 的占位声明）' },
  { id: 'ssh.one', why: '同上（插件面板经通用插件通道发 /api/ssh/*）' },
  { id: 'ssh.key', why: '同上（插件面板经通用插件通道发 /api/ssh/*）' },
  { id: 'ssh.test', why: '同上（插件面板经通用插件通道发 /api/ssh/*）' },
  { id: 'local.probe', why: '仓外 CLI / 存量面板的局域网探测口；设置里的入口已收，服务端按本机接口口径保留' },
  { id: 'local.hosts.add', why: '同上：/api/local/hosts/* 是局域网手动加主机的一组本机接口，仓内入口已收' },
  { id: 'local.hosts.remove', why: '同上：/api/local/hosts/* 是局域网手动加主机的一组本机接口，仓内入口已收' },
  { id: 'local.hosts.test', why: '同上：/api/local/hosts/* 是局域网手动加主机的一组本机接口，仓内入口已收' },
  { id: 'me.otp', why: '动态验证基路径（GET 状态 / DELETE 解绑在旧面板按基路径调）；新前端走 /status /bind /unbind 子路径' },
  { id: 'nodes.scope', why: '总机侧节点权限设置：面板入口 2026-11 收进 CLI（bandi nodes），HTTP 口按既有契约保留给脚本' },
  { id: 'nodes.role', why: '同上（节点角色改由 CLI / 脚本驱动，HTTP 口保留）' },
  { id: 'nodes.paths', why: '同上（节点可访问路径改由 CLI / 脚本驱动，HTTP 口保留）' },
  { id: 'control.restart', why: '改监听地址后的"重启控制面"：由桌面壳 / systemd 监护进程调用（仓内只有 config.mjs 的说明），走 machine:manage' },
  { id: 'status.project.one', why: '连接器 / 插件面板按项目 id 取状态详情；仓内通用面板用 pick 字段，不拼字面量' },
  { id: 'security.auditExport', why: '审计导出按钮在 admin 设置页里按 kind 拼查询串（抽取后是 /export${}，见 ② 的宽松尾段规则）；保留' },
  { id: 'security.auditClear', why: '清空审计日志：破坏性动作，只在 admin 设置页的确认流程里出现（前端字符串拼接，静态只是一条 /clear）' },
];

/*
 * ② 的"故意不登记"白名单（理论上应该空着）。写窄：整条路径，不要前缀。
 * 例：{ re: /^\/api\/health$/, why: '负载均衡探测口：不走 policy（在 guard 之前由 server 直接答）' }
 */
const ALLOW_CALLS = [];

/* ------------------------------------------------------------------ ① 无实现端点 */

const red = []; // 红项（决定 exit 1）
const notes = []; // `·` 无法静态判定 / 提示

if (want('missing-impl')) {
  let judged = 0;
  const prefixOnly = [];
  for (const r of ROUTES) {
    const sample = SAMPLES.get(r);
    const id = r.id;
    if (sample == null) {
      notes.push(`① ${id} ${routePath(r)} —— 正则构造超出了本工具的静态理解（没有反生成样本），跳过`);
      continue;
    }
    judged += 1;
    const cov = implCoverage(sample);
    if (cov === 'prefix') prefixOnly.push({ r, sample });
    else if (!cov) red.push(`① ${id} ${routePath(r)} —— 清单登记了，但实现侧找不到 handler（样本路径 ${sample}）`);
  }
  for (const { r, sample } of prefixOnly) {
    notes.push(`① ${r.id} ${routePath(r)} —— 实现侧只有命名空间前缀认领（样本 ${sample}），无法静态确认具体 handler，跳过`);
  }
  console.log(`\n① 无实现端点：清单 ${ROUTES.length} 条，静态判了 ${judged} 条；`
    + `${prefixOnly.length} 条只有前缀认领（见下 ·）；${red.length ? `✗ ${red.length} 条缺实现` : '✓ 全部有实现'}`);
  for (const line of red) if (line.startsWith('①')) console.log(`  ✗ ${line.slice(2)}`);
}

/* ------------------------------------------------------------------ ② 未登记调用 */

if (want('calls')) {
  const seen = new Set();
  const bad = [];
  for (const x of frontUse) {
    const key = `${x.file}\n${x.raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (registeredBy(x.raw)) continue;
    const allowed = ALLOW_CALLS.find((a) => a.re.test(x.raw));
    if (allowed) { notes.push(`② ${x.file} → ${x.raw} —— 白名单：${allowed.why}`); continue; }
    bad.push(`② ${x.file} → ${x.raw}`);
  }
  for (const line of bad) red.push(line);
  console.log(`\n② 未登记调用：扫描 ${frontFiles.length} 个文件、${seen.size} 条路径；`
    + `${bad.length ? `✗ ${bad.length} 条没登记（线上会被默认拒绝 404 E4090）` : '✓ 全部已登记'}`);
  for (const line of bad) console.log(`  ✗ ${line.slice(2)}`);
}

/* ------------------------------------------------------------------ ③ 无调用方端点 */

if (want('orphans')) {
  const usedIds = new Set();
  for (const x of [...frontUse, ...serverUse]) for (const id of routeIdsOf(x)) usedIds.add(id);
  // 同路径的条目一起算（/api/local/status 登记了两条、/api/nodes 一条 GET 一条 POST…）：
  // 路径级使用点只要命中任一条，同路径的其它登记就算"有使用点"。
  const usedPaths = new Set(ROUTES.filter((r) => usedIds.has(r.id)).map(routePath));
  const allowById = new Map(ALLOW_ORPHANS.map((a) => [a.id, a]));
  const routeIds = new Set(ROUTES.map((r) => r.id));
  const allowed = [];
  const usedAllow = new Set();
  const zombies = [];
  for (const r of ROUTES) {
    if (usedIds.has(r.id) || usedPaths.has(routePath(r))) continue;
    if (allowById.has(r.id)) { allowed.push({ route: r, why: allowById.get(r.id).why }); usedAllow.add(r.id); continue; }
    zombies.push(r);
  }
  console.log(`\n③ 无调用方端点：使用点 ${frontUse.length + serverUse.length} 条；`
    + `${zombies.length ? `! ${zombies.length} 条疑似僵尸（warning，不失败）` : '✓ 没有疑似僵尸'}；`
    + `ALLOW 豁免 ${allowed.length} 条（契约保留 / 仓外调用方，见下 ·）`);
  for (const a of allowed) notes.push(`③ ${a.route.id} ${routePath(a.route)} —— ${a.why}`);
  for (const r of zombies) console.log(`  ! ${r.id} ${routePath(r)} ${r.m?.join('/') ?? ''} —— 仓内找不到调用方；若是外部契约/预留请登记进 ALLOW_ORPHANS 并写理由`);
  // ALLOW 表过期提示：只有"清单里压根没有这个 id"才算过期（路由被删了/改名了，理由条目就该跟着删）；
  // 只是"这条路由有调用方、用不着豁免"不算过期 —— 留着它还能防 ③ 将来又把它当僵尸。
  for (const id of allowById.keys()) {
    if (!routeIds.has(id) && !usedAllow.has(id)) notes.push(`③ ALLOW 表项已过期：${id} 不在清单里（路由删了/改名了就把这条也删掉）`);
  }
}

/* ------------------------------------------------------------------ 输出收尾 */

if (notes.length) {
  console.log('\n· 无法静态判定 / 契约豁免（跳过，不判红）：');
  for (const n of notes) console.log(`  · ${n}`);
}

const redCount = red.length;
if (redCount) {
  console.log(`\n✗ 契约自检没过：${redCount} 条红项（见上）`);
  process.exit(1);
}
console.log('\n✓ 契约自检通过（清单里的都有实现；调用方没有未登记的；无调用方端点已有人复核）');
