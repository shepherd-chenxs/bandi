#!/usr/bin/env node
/**
 * **活文档 ↔ 代码的对账**（2026-11-03 加）。
 *
 * 为什么要有：这个仓库最贵的东西不是代码，是注释和文档里的**理由**；而理由最容易过期 ——
 * 代码一路改，README / SECURITY / 台账还停在三个月前的口径，后来的人（包括 agent）
 * 照着文档办事，第一步就被带沟里。2026-11-03 那一轮人工对账挖出 11 处漂移，
 * 每挖一处都能顺着找到下一处 —— 说明这不是个别笔误，是**结构性的欠账**，
 * 靠"下次记得改"是治不住的，得让掉队直接报错。
 *
 * 四类检查，按"误报从低到高"排：
 *
 *   ① **引用完整性**（机械、零歧义）：文档里写了 `apps/server/src/xxx.mjs`，那个文件就得在。
 *      改文件名 / 拆模块之后，文档里的旧路径会静默失效 —— 点进去 404，比写错字更费时间。
 *   ② **行号引用**：`auth.mjs:271` 这种指路，行号是最脆的坐标（上面插十行就废）。
 *      只判"文件在、行号在范围内"，另加一条软提醒：指到空行或收尾括号时几乎肯定已经漂了。
 *   ③ **数量枚举**：注释里"分四类身份""四态，别混"这类**数字**，必须等于代码里的实际数量。
 *      2026-11-03 真踩过：identify() 已经四类，注释还写"三种"；登录页已四态，注释写"五态"，
 *      第五态就是被删掉的令牌表单留下的残渣。数字是最容易腐烂又最容易被相信的东西。
 *   ④ **陈旧结论**：一张短语表（"默认只听本机""把令牌填进登录页"…），命中就报；
 *      同时在**历史注记**里豁免（见下）。仓库惯例是"保留历史 + 加批注"，
 *      那些句子是**故意留着**的，不能一视同仁地打红。
 *
 * 关于"新旧怎么区分"（这是本工具唯一的判断题，尽量说清楚）：
 *   · 命中后先看**上下 8 行内**有没有"历史措辞"——原先 / 曾经 / 已被 / 取代 / 删掉 / 改成 / ✗ 之类。
 *     有就当**历史注记**（不判红，`--verbose` 时列出来）；没有才判红（那才是"又把旧说法写回去了"）。
 *   · **光有日期不算历史措辞**。这一条是被现实逼出来的：`deploy/README.md` 里那句
 *     "为什么不做用户名＋密码（2026-10-16 定）"带着日期、读起来像归档，其实是**还在生效的正文**，
 *     而且早被 10-31 推翻了。日期只证明"这话当年说过"，证明不了"已经作废"。
 *   · 例外：**版本台账块**（`**`1.4.0`（2026-10-28）装了什么**` 底下那一段）整体按历史处理 ——
 *     台账天生是"每版追加、旧段原样留着"，拿现行口径判它红等于要求篡改历史。
 *   · 反引号里的词按"在谈论这个词"处理，不算"在使用这个说法"——
 *     否则 CONTRIBUTING 里那句"grep 一遍 `免登录`"会把自己判红。
 *   · `--strict` 把 ② 的软提醒也算失败（想彻底清零时用）。
 *   · 拿不准就**跳过并打印**（`·` 开头的行）：误报一次，人就开始整片忽略它的输出。
 *
 * 不扫什么（**故意**的）：
 *   · `docs/design/*`、`docs/prd/*`、`docs/mobile/pwa-prd.md`、`docs/交接-*.md` ——
 *     时间点快照，改它等于篡改历史；它们和新实现的关系靠"谁取代了谁"那句话来交代。
 *   · 但**快照也得登记**：根目录 / docs / docs/mobile / deploy 下新出现的 .md
 *     如果既不在活文档表、也不在快照表里，直接报错 —— 和 run-smokes 的"不许有没人管的用例"同理，
 *     不然新文档天生不受检，等于没这道闸。
 *
 * 跑法：
 *   node tools/check-doc-drift.mjs                 # 四类全跑
 *   node tools/check-doc-drift.mjs --only=phrases  # 只跑一类（refs / lines / counts / phrases）
 *   node tools/check-doc-drift.mjs --verbose       # 连"命中但有历史批注"的那些也列出来
 *   node tools/check-doc-drift.mjs --strict        # ② 的软提醒也算失败
 * 退出码：0 干净 / 1 有漂移 / 2 参数不认识
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.relative(repo, p).split(path.sep).join('/');
const read = (f) => fs.readFileSync(path.join(repo, f), 'utf8');

/* ============================================================ 登记表 */

/**
 * **活文档**：描述"现在是什么样"，改了代码就得跟着改。
 * 加一个文件进来 = 承认"它会被检查"；不加也不进快照表 = 直接报错。
 */
const LIVE = [
  ['README.md', '对外首页：上手步骤、安全默认、从源码跑'],
  ['SECURITY.md', '安全默认与部署建议'],
  ['CONTRIBUTING.md', '开发约定（含注释规约）'],
  ['deploy/README.md', '部署手册：隧道、节点报到、排障'],
  ['docs/现状.md', '台账：每一版装了什么（历史条目保留，现行口径看最新补记）'],
  ['docs/架构.md', '模块表与数据流'],
  ['docs/形态决策.md', '单机 / 总机 / 分机的取舍'],
  ['docs/契约.md', '接口契约'],
  ['docs/审阅经验.md', 'PR 审阅踩过的坑'],
  ['docs/头像生成规范.md', '头像生成口径'],
  ['docs/mobile/pwa-design.md', '手机端实现说明（头部已声明为快照性质，但仍是现行实现的主要参考）'],
  ['docs/mobile/sequence-diagram.mermaid', '手机配对的时序图'],
];

/**
 * **时间点快照**：写的是"当时决定这么做"，**不回写**。
 * 值写清楚它是什么时间的什么决定 —— 有人想改它之前先看到这句。
 */
const SNAPSHOT = {
  'docs/mobile/pwa-prd.md': '2026-10 手机端 PRD（需求快照；实现口径见 pwa-design / 现状.md）',
  'docs/PRD-2026-10-23-PR审阅与授权合并.md': '2026-10-23 需求快照',
  'docs/PRD-2026-10-23-项目面板改造.md': '2026-10-23 需求快照',
  'docs/交接-2026-10-18.md': '2026-10-18 交接快照',
};

/**
 * **活注释**：代码里承担"文档职责"的那几个文件（文件头讲规则、讲取舍）。
 * 只扫陈旧结论，不扫引用完整性 —— 注释里提到路径常常是举例，判"文件不存在"会误伤。
 */
const LIVE_CODE = ['apps/server/src/auth.mjs', 'apps/server/src/config.mjs', 'apps/server/src/store/devices.mjs'];

/* ============================================================ 文件索引 */

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'tmp', 'data', '.workbuddy']);

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile()) {
      out.push(rel(path.join(dir, e.name)));
    }
  }
  return out;
}

const ALL_FILES = walk(repo);
const BY_NAME = new Map();
for (const f of ALL_FILES) {
  const b = path.posix.basename(f);
  if (!BY_NAME.has(b)) BY_NAME.set(b, []);
  BY_NAME.get(b).push(f);
}

/* ============================================================ 参数 */

const argv = process.argv.slice(2);
const onlyArg = (() => {
  const i = argv.findIndex((a) => a === '--only' || a.startsWith('--only='));
  if (i < 0) return null;
  const a = argv[i];
  const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : String(argv[i + 1] ?? '');
  return v.trim() || null;
})();
const strict = argv.includes('--strict');
/** --verbose：把"命中但被历史批注豁免"的那些也列出来（想彻底清零时挨条看） */
const verbose = argv.includes('--verbose');
const SECTIONS = ['refs', 'lines', 'counts', 'phrases'];
const want = onlyArg ? SECTIONS.filter((s) => s === onlyArg) : SECTIONS;
if (onlyArg && !want.length) {
  console.error(`--only=${onlyArg} 不认识。可选：${SECTIONS.join(' / ')}`);
  process.exit(2);
}

let hard = 0;
let soft = 0;
const bad = (msg) => {
  console.log('  ✗ ' + msg);
  hard += 1;
};
const warn = (msg) => {
  console.log('  ! ' + msg);
  soft += 1;
};

/* ============================================================ 0. 清单完整性 */

{
  const roots = ['', 'docs', 'docs/mobile', 'deploy'];
  const found = roots.flatMap((d) =>
    fs
      .readdirSync(path.join(repo, d))
      .filter((f) => f.endsWith('.md'))
      .map((f) => (d ? `${d}/${f}` : f))
      .filter((f) => !f.includes('/.')),
  );
  const known = new Set([...LIVE.map(([f]) => f), ...Object.keys(SNAPSHOT)]);
  const missing = found.filter((f) => !known.has(f));
  const vanished = [...known].filter((f) => !ALL_FILES.includes(f));
  if (missing.length) {
    console.error('这些文档既不在活文档表、也不在快照表里（选一个登记，写明它是什么）：');
    for (const f of missing) console.error('  - ' + f);
    hard += 1;
  }
  if (vanished.length) {
    console.error('登记表里写了、但文件不在了：');
    for (const f of vanished) console.error('  - ' + f);
    hard += 1;
  }
}

/* ============================================================ 1. 引用完整性 */

/** 文档里像"仓库内文件"的 token。故意不含 `~`、通配符、尖括号之类的举例写法。 */
const PATH_TOKEN = /[A-Za-z0-9_@.\-/]+\.(?:mjs|js|json|css|html|md|mermaid|cmd|vbs|service)\b/g;

/**
 * 一个 token 可能指哪些仓库文件。
 *
 * 三路都试，是因为文档里三种写法都有：全路径（`apps/server/src/auth.mjs`）、
 * 从模块根算起的短路径（`routes/git.mjs`、`web/js/ui.mjs`）、光写文件名（`auth.mjs`）。
 * **只判"存在"、不判"指得准不准"** —— 同名文件（仓库里有 6 个 README.md）不该让检查崩掉，
 * 指得准不准是人的事，存在性才适合自动化。
 */
function findFiles(token, docFile) {
  const clean = token.replace(/^\.\//, '');
  const hits = new Set();
  if (ALL_FILES.includes(clean)) hits.add(clean);
  const fromDoc = path.posix.normalize(path.posix.join(path.posix.dirname(docFile), clean));
  if (ALL_FILES.includes(fromDoc)) hits.add(fromDoc);
  const suffix = '/' + clean;
  for (const f of ALL_FILES) if (f.endsWith(suffix)) hits.add(f);
  if (!clean.includes('/')) for (const f of BY_NAME.get(clean) ?? []) hits.add(f);
  return [...hits];
}

/**
 * 要不要查这个 token。
 *
 * 跳掉的两类都是**数据目录里的文件名**，不是仓库文件：`runtimes.json`、`plugins.json`、
 * `service.json`、`bandi.service` 这些是运行期产物 / 部署件，仓库里没有它们是正常的。
 * 带 `/` 的照查（`apps/...` 这种只能是仓库里真有的东西）。
 */
function skipToken(t) {
  if (t.includes('://') || t.startsWith('-') || t.startsWith('/')) return true;
  if (/[*<>{}~$|]/.test(t)) return true;
  if (!t.includes('/') && /\.(json|service|cmd|vbs)$/.test(t)) return true;
  /*
   * 被忽略的目录（tmp / data / dist …）里本来就没有可校验的东西：
   * `tmp/stop-keep-cdp.mjs` 就是"本地临时脚本、不随仓库提交"（docs/现状.md 原话），
   * 拿它判红属于冤枉人。
   */
  if (t.includes('/') && IGNORE_DIRS.has(t.split('/')[0])) return true;
  return false;
}

/**
 * 这一行是不是**历史注记**（仓库惯例是保留旧说法 + 加批注）。
 *
 * ⚠️ **光有日期不算** —— 这一条是被现实逼出来的：`deploy/README.md` 里那句
 * "为什么不做用户名＋密码（2026-10-16 定）" 带着日期，读起来像"已归档的决定"，
 * 实际上是**还在生效的正文**、而且早就被 10-31 推翻了。日期只能证明"这话当年说过"，
 * 不能证明"这话已经作废"，能证明的只有措辞本身：取代 / 已被 / 删掉 / 改成 …
 */
const HIST =
  /(原先|原本|曾经|旧口径|旧说法|历史上|取代|已被|被推翻|不再|已删|删掉|删了|删除|已移除|已不存在|不存在|改成|改：|✗)/;
const HIST_WINDOW = 8;
function isHistorical(lines, i) {
  if (HIST.test(lines.slice(Math.max(0, i - HIST_WINDOW), Math.min(lines.length, i + HIST_WINDOW + 1)).join('\n'))) return true;
  return inVersionRecord(lines, i);
}

/**
 * 是不是在**版本台账块**里（`**`1.4.0`（2026-10-28）装了什么**` 下的条目）。
 *
 * 台账这种文档天生是"每一版追加一段、旧段原样留着"，那些段落写的是**那一版的事实**，
 * 拿现行口径去判它红，等于要求把历史改成现在 —— 那才是真破坏可追溯性。
 * 判定很窄：从命中行往上找最近的 `##`/`###` 标题，中间出现过"版本号 + 日期"的加粗小标题才算。
 */
const VERSION_RECORD = /^\*\*`?\d+\.\d+\.\d+`?（?20\d\d-\d\d/;
function inVersionRecord(lines, i) {
  for (let k = i; k >= 0 && i - k <= 60; k -= 1) {
    if (/^#{2,3} /.test(lines[k])) return false;
    if (VERSION_RECORD.test(lines[k])) return true;
  }
  return false;
}

/**
 * 少数 token 指的**根本不是本仓库的文件** —— 判"不存在"是冤枉人。
 * 与其猜规则（"不带 / 的 .js 就放过"会把真欠账一起放过），不如一条条写明理由；
 * 这份表越短越好，长到需要解释"为什么不加规则"的时候就该改规则了。
 */
const REF_ALLOW = {
  'cli.js': 'dsh / Electron 包内部的文件（docs/架构.md 讲的是外部 CLI 自己的结构）',
  'qrcode.js': 'vendored 的来源文件，在 npm 包里；仓库里只有转出的 vendor/qrcode.mjs（原文已写明）',
};

if (want.includes('refs')) {
  console.log('\n== ① 引用完整性（文档提到的仓库文件必须存在）==');
  let checked = 0;
  let kept = 0;
  const seen = new Set();
  for (const [file] of LIVE) {
    const lines = read(file).split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(PATH_TOKEN)) {
        const token = m[0];
        if (skipToken(token)) continue;
        // `x.mjs:123` 的行号归 ② 管，这里只判文件
        const bare = token.replace(/:\d+$/, '');
        const key = `${file}|${bare}`;
        if (seen.has(key)) continue;
        seen.add(key);
        checked += 1;
        if (REF_ALLOW[bare]) {
          /* 白名单不该是"静默放行"：--verbose 时把理由打出来，谁想加一条先看见现有理由有多克制 */
          if (verbose) console.log(`  · ${file}:${i + 1} ${bare} —— 白名单：${REF_ALLOW[bare]}`);
          continue;
        }
        if (findFiles(bare, file).length) continue;
        /*
         * 找不到时的两种处置，这是本工具最需要拿捏的一处：
         *   · 历史章节里提到**当时删掉的文件**（`tmp/xxx-cdp.mjs`、第二套前端那批 `app.js`）——
         *     那是记录，不是欠账，留着正确；
         *   · 正文（现行口径）里提到一个不存在的文件 —— 那多半是改名/拆模块之后没跟上，
         *     点进去 404，正是这道闸要拦的。
         */
        if (isHistorical(lines, i)) {
          kept += 1;
          continue;
        }
        bad(`${file}:${i + 1} 提到 ${bare} —— 仓库里没有这个文件（改名了？还是从来没写过？）`);
      }
    });
  }
  const allOk = hard === 0;
  if (checked && allOk) console.log(`  ✓ ${LIVE.length} 个活文档，共 ${checked} 处文件引用，全部指得到`);
  else if (!checked) console.log('  （没有文件引用）');
  if (kept) console.log(`  · 另有 ${kept} 处在历史章节里提到已删除的文件（记录，不算欠账）`);
}

/* ============================================================ 2. 行号引用 */

/* 只判"在范围内"是硬的；"指到了空行/收尾括号"只提醒 —— 那种位置几乎肯定已经漂了，
 * 但偶尔真的有一行正文正好跟在括号后面，硬判会误杀。 */
const LINE_REF = /([A-Za-z0-9_@.\-/]+\.(?:mjs|js|json|css|html|md|mermaid)):(\d+)/g;

/**
 * 同名好几份时挑"最像本体"的那份。
 *
 * 之所以要挑而不是跳过：仓库里 `apps/desktop/runtime/**` 是**打包进安装包的副本**（`apps/web/**`
 * 的镜像），`tmp/**` 是临时产物 —— 它们和正文同名，但不是文档在说的地方。
 * 跳过等于"最该查的那几处永远查不了"，所以按这个顺序挑：去掉副本 → 路径最短（本体在顶层）。
 */
function pickOne(hits) {
  const primary = hits.filter((f) => !f.startsWith('apps/desktop/runtime/') && !f.startsWith('tmp/'));
  const pool = primary.length ? primary : hits;
  if (pool.length === 1) return pool[0];
  const sorted = [...pool].sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);
  // 层级完全一样的（真分不清）→ 返回 null，宁可跳过也不瞎猜
  if (sorted[0].split('/').length === sorted[1].split('/').length) return null;
  return sorted[0];
}

if (want.includes('lines')) {
  console.log('\n== ② 行号引用（file:line 的坐标还站得住吗）==');
  let n = 0;
  let ambiguous = 0;
  for (const [file] of LIVE) {
    read(file)
      .split('\n')
      .forEach((line, i) => {
        for (const m of line.matchAll(LINE_REF)) {
          const hits = findFiles(m[1], file);
          const ln = Number(m[2]);
          n += 1;
          if (!hits.length) {
            if (isHistorical(read(file).split('\n'), i)) return;
            bad(`${file}:${i + 1} 的 ${m[1]}:${ln} —— 文件都找不到了`);
            continue;
          }
          // 同名多份时按"最像本体"的那份挑（理由见 pickOne），挑不出来才跳过
          const target = hits.length > 1 ? pickOne(hits) : hits[0];
          if (!target) {
            ambiguous += 1;
            continue;
          }
          const body = read(target).split('\n');
          if (ln > body.length || ln < 1) {
            bad(`${file}:${i + 1} 的 ${m[1]}:${ln} —— ${target} 只有 ${body.length} 行`);
            continue;
          }
          const at = body[ln - 1].trim();
          if (!at || /^[})\];]+[,;]?$/.test(at) || /^\*?\/?$/.test(at)) {
            warn(`${file}:${i + 1} 的 ${m[1]}:${ln} 指到了 ${target}:${ln}「${at}」—— 像是插删行之后漂了`);
          }
        }
      });
  }
  if (!n) console.log('  （没有行号引用）');
  else if (!hard) console.log(`  ✓ ${n} 处行号引用都在范围内`);
  if (ambiguous) console.log(`  · ${ambiguous} 处因同名文件（好几份）没法判定，跳过`);
}

/* ============================================================ 3. 数量枚举 */

const CN = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const num = (s) => (/^\d+$/.test(s) ? Number(s) : (CN[s] ?? NaN));

/**
 * 每条：在 `file` 里算出一个实际数量，再要求 `claim` 捕获到的那个中文数字跟它一致。
 * `compute` 抛异常 = 代码结构变了、这个检查本身失效 —— 那是硬失败（否则检查会静默变成空话，
 * 比漂移更糟：它还会打出 ✓）。
 */
const COUNTS = [
  {
    id: 'identify 身份种类',
    file: 'apps/server/src/auth.mjs',
    claim: /分([一二三四五六七八九十\d]+)类身份/,
    why: 'identify() 每加/删一类，文件头那句"分N类身份"必须跟着改（2026-11-03 真漂过：四类写成三种）',
    compute: () => {
      const src = read('apps/server/src/auth.mjs');
      const start = src.indexOf('export function identify(');
      const end = src.indexOf('\n}\n', start);
      if (start < 0 || end < 0) throw new Error('找不到 identify() 的函数体（改签名了？先修这个检查）');
      const kinds = new Set([...src.slice(start, end).matchAll(/kind:\s*'([a-z]+)'/g)].map((m) => m[1]));
      if (!kinds.size) throw new Error('identify() 里没有 kind: 字面量（结构变了？）');
      return { n: kinds.size, detail: [...kinds].join(' / ') };
    },
  },
  {
    id: '登录页状态数',
    file: 'apps/server/src/auth.mjs',
    claim: /([一二三四五六七八九十\d]+)态，别混/,
    why: '登录页删/加一个状态，文件头那句"N态"必须跟着改（2026-11-03 真漂过：四态写成五态）',
    compute: () => {
      const src = read('apps/server/src/auth.mjs');
      const start = src.indexOf('态，别混');
      if (start < 0) throw new Error('找不到「态，别混」那段注释（改写了？先修这个检查）');
      const block = src.slice(start, src.indexOf('*/', start));
      const bullets = block.split('\n').filter((l) => /^\s*\*\s+·\s/.test(l)).length;
      if (!bullets) throw new Error('那段注释里没有「· 」条目（格式变了？）');
      return { n: bullets, detail: `${bullets} 条状态` };
    },
  },
];

if (want.includes('counts')) {
  console.log('\n== ③ 数量枚举（注释里的数字 = 代码里的实际数量）==');
  for (const c of COUNTS) {
    let got;
    try {
      got = c.compute();
    } catch (e) {
      bad(`${c.id}：${e.message}`);
      continue;
    }
    const src = read(c.file);
    const m = src.match(c.claim);
    if (!m) {
      bad(`${c.id}：${c.file} 里找不到那条断言（${c.claim}）—— 检查本身失效了，先修它`);
      continue;
    }
    const claimed = num(m[1]);
    if (!Number.isFinite(claimed)) {
      bad(`${c.id}：注释里的数字「${m[1]}」认不出来`);
    } else if (claimed !== got.n) {
      bad(`${c.id}：注释说「${m[0]}」，实际 ${got.n}（${got.detail}）—— 改哪边都对，别留着`);
    } else {
      console.log(`  ✓ ${c.id}：注释与实际都是 ${got.n}（${got.detail}）`);
    }
  }
}

/* ============================================================ 4. 陈旧结论 */

/**
 * 短语表。每条写清楚"为什么现在不成立了"，报错时一起打出来 ——
 * 只报"命中关键词"等于让修的人自己去考古。
 */
const PHRASES = [
  {
    re: /默认只听(本机|回环)/,
    why: '2026-11-03 起监听缺省就是 0.0.0.0（config.mjs:121 的 `BANDI_HOST ?? \'0.0.0.0\'`），回环只剩调试形态',
  },
  {
    re: /(本机|回环)[^，。；]{0,8}免登录/,
    // "机器凭据在回环上免填令牌"是**对的**（auth.mjs 的 operator 分支），
    // 只有把这句话说成"浏览器/面板/人"的时候才是旧的（2026-10-31 起面板一律登录）
    not: /机器凭据|脚本|CLI|operator|接口|API/,
    why: '2026-10-31 用户拍板"不管总机还是分机都要用用户登录"；免令牌只留给机器凭据（X-Bandi-Token），浏览器一律过登录页',
  },
  {
    re: /(把|将)?令牌填(进|到|入)/,
    why: '2026-10-31 删掉令牌表单后登录页没有令牌入口（auth.mjs "页面上没有令牌入口了"）；脚本走 X-Bandi-Token 头或 ?token=',
  },
  {
    re: /不做用户名[＋+]?密码|没有账号体系|无账号体系/,
    why: '2026-10-31 已做账号体系（建号 → 账号磁贴 / 用户名+密码），当年"不做"的结论已被推翻',
  },
  {
    re: /分?三(种|类)身份|五态/,
    why: 'identify() 已是四类身份（operator/node/device/revoked），登录页是四态',
  },
  {
    re: /切到总机(模式)?并重启|先在?模式里切到总机/,
    why: '2026-11-03 删了 `/api/restart` 与 `allowLan`；总机/分机与手机开关都是立刻生效，没有"改完重启"这一步',
  },
  {
    re: /(单机|分机|总机)[^，。；]{0,4}只听回环|只听回环[^，。；]{0,4}(形态|就够了)/,
    why: '2026-11-03 起所有形态都监听 0.0.0.0（回环只剩 BANDI_HOST 调试形态）；"某形态只听回环"这个前提没了，"所以免鉴权"更不成立',
  },
];

if (want.includes('phrases')) {
  console.log('\n== ④ 陈旧结论（旧口径又写回来了吗）==');
  const targets = [...LIVE.map(([f]) => f), ...LIVE_CODE];
  let hits = 0;
  let exempt = 0;
  for (const file of targets) {
    const lines = read(file).split('\n');
    lines.forEach((raw, i) => {
      // 反引号里的是"在谈论这个词"，不是"在使用这个说法"
      const line = raw.replace(/`[^`]*`/g, '');
      for (const p of PHRASES) {
        if (p.not && p.not.test(line)) continue;
        const m = line.match(p.re);
        if (!m) continue;
        hits += 1;
        if (isHistorical(lines, i)) {
          exempt += 1;
          if (verbose) console.log(`  · ${file}:${i + 1} 「${m[0]}」（附近有批注，视为历史注记）`);
          continue;
        }
        bad(`${file}:${i + 1} 「${m[0]}」\n      → ${p.why}`);
      }
    });
  }
  if (!hits) console.log('  ✓ 没有命中任何旧说法');
  else if (exempt) console.log(`  · 另有 ${exempt} 处命中但附近有日期/历史批注（历史注记，保留是对的）`);
}

/* ============================================================ 结论 */

console.log('');
if (hard) {
  console.error(`✗ 文档与代码对不上：${hard} 处硬漂移${soft ? `（另有 ${soft} 处待确认）` : ''}`);
  console.error('修的时候顺手自问一句：是**文档**落后了，还是**代码**该改？两边都可能。');
  if (strict) process.exit(1);
  process.exit(1);
}
if (soft && strict) {
  console.error(`✗ --strict：${soft} 处待确认也算失败`);
  process.exit(1);
}
console.log(`✓ 活文档与代码一致${soft ? `（${soft} 处待确认，见上面 ! 行）` : ''}`);
