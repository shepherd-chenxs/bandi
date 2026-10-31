#!/usr/bin/env node
/**
 * PR 闸门里**确定性的那一半**：不靠模型判断，直接对着 diff 查策略。
 *
 * 只查机器能一句话判死的（宁可少而准）：
 *   ① **零依赖铁律** —— 不许新增 package.json / 锁文件 / node_modules（本仓库零依赖是硬约束）
 *   ② **地址白名单** —— 代码与配置里新增的外部地址必须在白名单里；文档里的只提示
 *   ③ **断言完整性** —— 不许删冒烟用例、不许删用例里的 check(...)
 *   ④ **需要人看**（只提示不拦）—— 改 CI 工作流、鉴权/沙箱/数据目录、base_url 这类关键词
 *
 * "这段逻辑对不对"不在这里判 —— 那留给人和 agent，硬编码进 CI 只会天天误杀。
 * **白名单要加东西，在 PR 里写明理由**（那是人审的事）。
 *
 * 用法：
 *   BASE_SHA=<base commit> node tools/check-pr.mjs   # CI 里由 workflow 给（PR 的 base.sha）
 *   node tools/check-pr.mjs                          # 本地：拿工作区跟 HEAD 比
 * 退出码：0 没有硬违规 / 1 有硬违规
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_SHA || process.env.BASE_REF || '';
const head = 'HEAD';
const range = BASE ? [`${BASE}`, head] : [head]; // 本地不给 base → 比工作区

/*
 * maxBuffer 必须给足：Node 默认 1MB（spawnSync 的默认），大 PR 的 `git diff -U0`
 * 轻易就超（v1.0.0 这次是 946KB 的 stdout + 泄漏的 stderr 合计越界）。
 * 超了 Node 会杀掉子进程，status 是 null、stdout 截断为空、error.code=ENOBUFS，
 * 于是报出来变成一句没有下文的「失败：」—— 看着像 git 出错，其实是缓冲区太小。
 */
const git = (args) => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    const why = r.error
      ? `${r.error.code ?? r.error.name}: ${r.error.message}`
      : (r.stderr ?? '').trim() || `退出码 ${r.status}${r.signal ? `（信号 ${r.signal}）` : ''}`;
    console.error(`git ${args.join(' ')} 失败：${why}`);
    process.exit(2);
  }
  return r.stdout ?? '';
};

/**
 * 白名单 = 这个项目**本来就在用**的地址。新增任何一个都要在 PR 里说明理由。
 * 加它之前先问：这个域名是我们自己的服务/官方的源，还是别人家的中转站？
 */
const HOST_ALLOW = [
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'nodejs.org',
  'registry.npmjs.org',
  'registry.npmmirror.com',
  'schema.tauri.app',
  'tauri.app',
  'usemagpie.ai',
  // Tauri 的 IPC 走 `http://ipc.localhost`（自定义协议在 Android/Windows 上的
  // 实际 origin），CSP 的 connect-src 必须放它，否则前端调不了任何 command。
  // 2026-11 新增 apps/mobile 时被误判成"外部地址"。
  'ipc.localhost',
  // 飞书开放平台（2026-10-28）：用户**自建飞书应用**的官方 API 域名 ——
  // 不是中转站/网关；飞书通道（apps/server/src/feishu.mjs）按官方协议直连它，
  // 与 larksuite/node-sdk 用的是同一个 host。见 docs/架构.md「飞书通道」。
  'open.feishu.cn',
  '127.0.0.1',
  'localhost',
  // SVG 的命名空间标识符（`xmlns="http://www.w3.org/2000/svg"`）不是网络请求，
  // 浏览器/编辑器不会去 GET 它；2026-10-20 新增独立图标母版 icons/icon.svg 时被误判成"外部地址"。
  'www.w3.org',
];

/*
 * 「本地地址」类直接放行（2026-10-22 用户拍板：192.168.1.9 这种本地地址可以放进白名单）。
 *
 * 为什么可以不逐个登记：这两类地址**不可能指向真实的外部服务** ——
 *   · RFC 1918 私有网段 / 169.254 链路本地：只在局域网内可达，公网路由不到；
 *   · RFC 2606 保留域（example.com / .example / .test / .invalid）：IANA 留给文档示例，永不解析。
 * 它们出现在加入向导的 placeholder、报错文案、设计图里，只是"地址长这样"的示例，
 * 不是又接了一个中转站/网关 —— 白名单要拦的是后者。
 */
const PRIVATE_HOST_RE =
  /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})$/;
const RESERVED_DOMAIN_RE = /(^|\.)(example\.(com|net|org)|example|test|invalid)$/;

/** 改了这些 = 需要人看一眼（提示，不拦） */
const NEEDS_EYE = [
  /^\.github\/workflows\//,
  /^apps\/server\/src\/auth\.mjs$/,
  /^apps\/server\/src\/config\.mjs$/,
  /^apps\/server\/src\/store\.mjs$/,
  /^apps\/server\/src\/ssh-registry\.mjs$/,
  /^apps\/desktop\/installer-hooks\.nsh$/,
  /^apps\/desktop\/tauri\.conf\.json$/,
];

/** 新增行里出现这些词 = 提示人看（地址/凭据相关） */
const RISKY_WORD = /\b(base_?url|baseURL|BASE_URL|api_?key|apiKey|GATEWAY_KEY|personal_access_token|PRIVATE KEY)\b/i;

const errors = [];
const notices = [];
const err = (file, line, msg) => errors.push({ file, line, msg });
const note = (file, msg) => notices.push({ file, msg });

/* ------------------------------------------------------------ 收集 diff */

/*
 * diff 里的路径有两种写法：`b/docs/形态决策.md`，以及 git 认为"特殊"时加引号 + 八进制转义的
 * `"b/docs/\345\275\242..."` —— **非 ASCII 文件名默认就是后者**（core.quotepath 默认 true）。
 *
 * 2026-10-27 实报：原来只认裸 `b/`，引号路径一个都认不出，于是中文名文件的所有改动行
 * 都被算到**上一个文件**头上 —— `docs/形态决策.md` 里那条早就在的第三方链接，被报成
 * `design/v1.0.1/ios-workbench.html:10` 的"新增白名单外地址"硬违规（文档本该只提示）。
 *
 * 修法两层，缺一不可：
 *   · 两处 `git diff` 都带 `-c core.quotepath=false`（路径原样输出 UTF-8，还能让上方
 *     `--name-status` 的 NEEDS_EYE / 依赖面判断也对得上中文名文件）；
 *   · 这里再兜一层引号解包 —— 文件名里带引号/制表符时 git 仍会加引号，只关 quotepath 不够。
 */
const unquoteDiffPath = (raw) => {
  const quoted = raw.startsWith('"');
  const p = quoted ? raw.slice(1, raw.lastIndexOf('"')) : raw;
  const unescaped = p
    .replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\(.)/g, '$1');
  return unescaped.replace(/^[ab]\//, '');
};

const nameStatus = git(['-c', 'core.quotepath=false', 'diff', '--name-status', ...range, '--'])
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    const [status, ...rest] = l.split(/\t/);
    return { status, file: rest.join('\t') };
  });

const changedFiles = nameStatus.map((x) => x.file);

// 逐行过 diff（-U0 只出改动行；带 +/- 与 @@ 行号）
const added = new Map(); // file → [{ line, text }]
const removed = new Map();
{
  const diff = git(['-c', 'core.quotepath=false', 'diff', '-U0', ...range, '--']);
  let file = null;
  let newLine = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4);
      if (p === '/dev/null') continue; // 删除文件：没有"新增行"可归
      file = unquoteDiffPath(p);
      if (!added.has(file)) added.set(file, []);
      if (!removed.has(file)) removed.set(file, []);
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('diff --git')) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('+')) {
      added.get(file).push({ line: newLine, text: raw.slice(1) });
      newLine += 1;
    } else if (raw.startsWith('-')) {
      removed.get(file).push({ line: 0, text: raw.slice(1) });
    }
  }
}

const isDoc = (f) => /\.(md|txt|rst)$/i.test(f);

/* -------------------------------------------------------------- ① 零依赖 */

const DEP_FILE = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|node_modules\/)/;
for (const { status, file } of nameStatus) {
  if (status.startsWith('D')) continue;
  if (DEP_FILE.test(file)) {
    err(file, 0, `新增依赖面：${file}。本仓库**零依赖**是硬约束（见 docs/架构.md 技术选型）——要么去掉它，要么在 PR 里说明为什么必须破例。`);
  }
}

/* -------------------------------------------------------- ② 地址白名单 */

const URL_RE = /https?:\/\/([A-Za-z0-9.-]+)/g;
const hostAllowed = (h) =>
  HOST_ALLOW.includes(h) ||
  h.endsWith('.usemagpie.ai') ||
  PRIVATE_HOST_RE.test(h) ||
  RESERVED_DOMAIN_RE.test(h);

/*
 * 第三方 skill 的资产目录：`skills/**` 是原样收录的上游 skill（Apache-2.0，
 * 见各目录 LICENSE.txt），里面的字体/CSS CDN、品牌图床都不是我们发起的请求。
 * 改它们应该走"换掉这个 skill"，而不是逼着把字体 CDN 加进白名单。
 */
const isVendored = (f) => /^skills\//.test(f);

/*
 * 生成物目录：`apps/mobile/gen/**`（`tauri android init` + Gradle 生成的 Android 工程）
 * 与 `apps/mobile/icons/**`（`tauri icon` 生成的图标）。
 *
 * 里面的地址都是框架标准产物，不是我们发起的请求：
 *   · `schemas.android.com` —— XML namespace 标识符（`xmlns:android=...`）；
 *   · `json-schema.org` / `urlpattern.spec.whatwg.org` / `mydomain.dev` —— 生成的
 *     JSON Schema 里的 `$schema` 与示例值；
 *   · `www.apache.org` —— Gradle wrapper 的 Apache License 头。
 * 手写的部分（`gen/android/app/build.gradle.kts` 的镜像、`MainActivity.kt`）仍走
 * NEEDS_EYE 人审，不受这条豁免影响。
 */
const isGenerated = (f) => /^apps\/mobile\/(gen|icons)\//.test(f);

/*
 * 冒烟用例里的**反例字面量**：专门验证"不是 github 的 PR 链接 → null"这种
 * 断言，得把 gitlab.com 写进字符串才测得了。
 *
 * 判据要小心，两条都别踩：
 *   · `fetch("https://evil/v1")` 的 URL 同样在引号里 —— **引号内 ≠ 没发请求**
 *   · `check(a.url === "https://x")` 才真的只是数据
 * 所以放行条件收紧到"这一行是断言 / 纯注释"，并要求它不含发请求的动作。
 */
const REQUEST_CALL = /\b(fetch|request|axios|got|undici|WebSocket|\.open|createConnection)\s*\(/i;
const isAssertion = (text) => {
  const t = text.trim();
  if (/^(\/\/|\*|\/\*|#)/.test(t)) return true; // 纯注释
  if (!/\bcheck\s*\(/.test(t)) return false; // 只有 check(...) 里的才算反例数据
  return !REQUEST_CALL.test(t);
};

for (const [file, list] of added) {
  const vendored = isVendored(file);
  // 生成物（apps/mobile/gen、icons）里的地址是框架标准产物，不是我们发起的请求
  if (isGenerated(file)) continue;
  for (const { line, text } of list) {
    const dataOnly = isAssertion(text);
    for (const m of text.matchAll(URL_RE)) {
      const host = m[1];
      if (hostAllowed(host)) continue;
      if (vendored || dataOnly) {
        if (isDoc(file)) note(file, `新增外部链接（文档，仅提示）：${host}`);
        else note(file, `新增外部地址（${vendored ? '第三方 skill 资产' : '仅作断言/注释，未发起请求'}，仅提示）：${host} · 第 ${line} 行`);
        continue;
      }
      if (isDoc(file)) note(file, `新增外部链接（文档，仅提示）：${host}`);
      else err(file, line, `新增了白名单外的地址：${host} —— 中转站/网关这类必须说明来路（白名单在 tools/check-pr.mjs）`);
    }
    if (RISKY_WORD.test(text)) note(file, `新增行里出现地址/凭据相关字样（第 ${line} 行）：${text.trim().slice(0, 80)}`);
  }
}

/* -------------------------------------------------------- ③ 断言完整性 */

/*
 * 判据：**净减少**才算放松（2026-10-17 修）。
 *
 * 原来只要"删掉一行含 check( 的"就报错 —— 于是**改写**一条断言的写法（删一行、加一行）
 * 也会被当成"删断言"（我自己踩过：把一条含外部域名的断言换成不含域名的，被拦下）。
 * 现在比较净变化：改写不给过，**真的少了一条**才拦。
 */
for (const { status, file } of nameStatus) {
  if (!/smoke-.*\.mjs$/.test(file)) continue;
  if (status.startsWith('D')) {
    err(file, 0, '删掉了整个冒烟用例 —— 这要人拍板（用例是别人的验收依据）');
    continue;
  }
  const isCheck = (x) => /\bcheck\s*\(/.test(x.text);
  const gone = (removed.get(file) ?? []).filter(isCheck).length;
  const came = (added.get(file) ?? []).filter(isCheck).length;
  const net = gone - came;
  if (net > 0) {
    err(file, 0, `净删掉了 ${net} 条 check(...) 断言（删 ${gone} / 加 ${came}）—— 测试被放松，需要人确认（改写不算、新增没问题）`);
  }
}

/* ------------------------------------------------------ ④ 需要人看一眼 */

for (const file of changedFiles) {
  if (NEEDS_EYE.some((re) => re.test(file))) note(file, '这个文件改了 —— 需要人看一眼（CI 工作流 / 鉴权 / 沙箱 / 数据目录 / 打包钩子）');
}

/* ------------------------------------------------------------------ 输出 */

const mode = BASE ? `对比 ${BASE.slice(0, 8)}…HEAD` : '对比 HEAD（工作区）';
console.log(`PR 闸门（确定性检查）· ${mode}`);
console.log(`改动文件 ${changedFiles.length} 个`);

if (notices.length) {
  console.log(`\n要看一眼（不拦，${notices.length} 条）：`);
  for (const n of notices) {
    console.log(`  · ${n.file} —— ${n.msg}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::warning file=${n.file}::${n.msg}`);
  }
}

if (errors.length) {
  console.log(`\n硬违规（${errors.length} 条）—— 不修就不该合：`);
  for (const e of errors) {
    const where = e.line ? `${e.file}:${e.line}` : e.file;
    console.log(`  ✗ ${where} —— ${e.msg}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error file=${e.file}${e.line ? `,line=${e.line}` : ''}::${e.msg}`);
  }
  console.log('\n结论：有硬违规。');
  process.exit(1);
}

console.log('\n结论：确定性检查都过了（逻辑对不对仍要人 / agent 看）。');
