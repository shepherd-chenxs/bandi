#!/usr/bin/env node
/**
 * 跑「不需要真实 CLI / 模型 / 网络」的那批冒烟 —— PR 闸门与本地自查**共用同一份清单**。
 *
 * 为什么是清单而不是 glob 所有 `smoke-*.mjs`：
 *   · 少数用例要真实 agent CLI 与模型（烧 token，GitHub runner 上也没有）→ 必须显式排除并写明原因；
 *   · 新加了 `smoke-*.mjs` 却忘了登记？这里会**报错** —— 不然"新用例从来不跑"没人会发现。
 *
 * 跑法：
 *   node tools/run-smokes.mjs                   # 全量（PR 门禁跑的就是这一条）
 *   node tools/run-smokes.mjs --only=pr-create  # 只跑文件名/路径含这个子串的（修红时先跑这一条，最慢也就几十秒）
 *   node tools/run-smokes.mjs --list            # 只列清单，不跑
 * 退出码：0 全通过 / 1 有用例没过 / 2 清单与目录对不上（含 --only 一个都没选中）
 *
 * 2026-10-30 改（"修 gate 要跑很久"）：失败时不再只给 ✗ 行 + 15 行尾巴，
 * 而是带上**断言的 文件:行号**、**只跑这一条的复现命令**、**完整输出的落盘路径**。
 * 原来这三样都没有，agent 只能把 3 分半的全量再跑一遍去把日志头尾各看一次。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.relative(repo, p).split(path.sep).join('/');

/** 要跑的：都不碰真实 data/、不要真实 CLI、不联网 */
const RUN = [
  'apps/server/src/smoke-agent-cards.mjs',
  // 运行钥匙（"工作证"）在**强制鉴权形态**下的建卡通道 + 只读台账（2026-11-08 实报补：
  // 真机监听 0.0.0.0 时认证层不认 X-Bandi-Run-Token，PM/助理双双 401）。纯策略 + 端到端。
  'apps/server/src/smoke-run-credential.mjs',
  // IAM 安全收编（Phase 1–3）的 6 个用例（2026-11-02 补登记）：策略表 / 审计 / CSRF /
  // 本机策略 / 反代鉴权 / 安全策略，全部临时数据目录、不联网
  // （bootstrap 与票据两条随 2026-11-07 本地账号退场删除 —— 被测机制没了，用例跟着删）
  'apps/server/src/smoke-admin-invariant.mjs',
  'apps/server/src/smoke-audit.mjs',
  // 数据增长封顶（2026-11-09）：运行事件单条 ≤64 KB / 同类拒绝窗口聚合 / 归档保留 1 个月。
  // 纯库操作、不起服务；窗口用环境变量缩到 80ms，不拖慢 PR 闸门。
  'apps/server/src/smoke-growth-caps.mjs',
  'apps/server/src/smoke-csrf.mjs',
  'apps/server/src/smoke-local-policy.mjs',
  // 网络周界闸（2026-11-03，对齐 1Panel 安全页）：授权 IP 白名单 E3003 / 域名绑定 E3004
  'apps/server/src/smoke-network.mjs',
  // 监听地址持久化（2026-11-04，做进系统）：env > 数据目录配置 > 缺省 0.0.0.0
  'apps/server/src/smoke-listen-host.mjs',
  'apps/server/src/smoke-proxy-auth.mjs',
  'apps/server/src/smoke-security-policy.mjs',
  'apps/server/src/smoke-auth.mjs',
  // 本机壳子自动进门（2026-11-10）：/shell/enter 核 local_secret + 本机直连 → 本机会话
  'apps/server/src/smoke-shell-enter.mjs',
  'apps/server/src/smoke-autostart.mjs',
  'apps/server/src/smoke-chat-to-board.mjs',
  'apps/server/src/smoke-connectors.mjs',
  // 连接器接线层与权限档位（2026-11-13）：claude 族 --mcp-config 接线、promptLines
  // 以 resolve 结果为准（没接线不许注入提示词骗模型）、claude blocked 存量迁移。
  // 纯函数 + 临时账本，不起服务不联网。
  'apps/server/src/smoke-connector-wiring.mjs',
  'apps/server/src/smoke-conversation-delete.mjs',
  'apps/server/src/smoke-events.mjs',
  'apps/server/src/smoke-data-dir.mjs',
  // 数据库迁移（2026-11-08 结构版本号机制落地时补）：老库打开一次就收到当前形态、
  // 再开一次什么都不变。第一条钉的是 v1→v2 清掉回话消息的 meta.progress（过程收起行砍掉）。
  'apps/server/src/smoke-agent-git.mjs',
  'apps/server/src/smoke-db-migration.mjs',
  'apps/server/src/smoke-experts.mjs',
  'apps/server/src/smoke-feishu.mjs',
  'apps/server/src/smoke-git-repos.mjs',
  'apps/server/src/smoke-group-dissolve.mjs',
  'apps/server/src/smoke-group-mentions.mjs',
  // 成员回复接力（2026-11-12 实报「群里没人理他」）：成员回话里 @ 谁就唤醒谁，带回打保护
  'apps/server/src/smoke-reply-chain.mjs',
  // 团队协作（派给群）：群助手必须是 PM、动态现读群助手、子卡授权/回执（2026-11-09）
  'apps/server/src/smoke-group-tasks.mjs',
  // 群关联项目（2026-11-11「一项目一群」）：群挂了项目 = 派活默认在那个项目里干（纯函数规则）
  'apps/server/src/smoke-group-project.mjs',
  // 汇报技能 bandi-report：结论先行口径、上游 MIT 出处、专家包默认挂载、平台注入指向它
  'apps/server/src/smoke-report-skill.mjs',
  'apps/server/src/smoke-lan-origin.mjs',
  'apps/server/src/smoke-lifecycle.mjs',
  // 身份中枢进门（2026-11-06）：验票九类负样本 + /hub/enter 正路 + 本地授权表 + 服务器形态
  // 不联网（票是本地现签的假票，只验"主机这一侧"的逻辑）
  'apps/server/src/smoke-hub.mjs',
  // 外网隧道（2026-11-07 接入 / 2026-11-08 下线）：smoke-tunnel.mjs 随 frp 内置一起删了。
  // 不是不测 —— 已没有可测的东西：bandi 不再起隧道进程，只剩 hub/relay.mjs 读域名，
  // 那两道闸（Host / Origin）由 smoke-lan-origin.mjs 覆盖，别在这里补一个空壳。
  'apps/server/src/smoke-personas.mjs',
  // 岗位固定与权限模型（2026-11-11）：岗位系统内置、权限挂在岗位上；旧 role 文本一次性
  // 映射成 roleKey；can() 只认 roleKey（不许再解析 role 文本）。纯库 + 纯函数，不起服务。
  'apps/server/src/smoke-roles.mjs',
  // 建卡通道（2026-11-11 实报后）：UTF-16 请求体 / 裸数组 / 群项目兜底 / 补记 / 验收人闸
  // ⚠️ 它自己把监听改成 0.0.0.0 跑「鉴权形态」—— 验收人闸只在运行身份下才走得到
  'apps/server/src/smoke-card-channel.mjs',
  // 信箱（2026-11-11 用户拍板）：建卡失败落库、同轮同码去重、已读/未读、角标口径
  'apps/server/src/smoke-inbox.mjs',
  // 完全自主交付（2026-11-13）：无人工闸模板、按岗位指派、自动流转、终态/受阻写信箱、
  // 普通人工流程不受影响。临时库 + 假 run 钩子 + 同进程控制面，不起真 CLI、不烧模型。
  'apps/server/src/smoke-self-delivery.mjs',
  // 上下文预算（2026-11-11 实报：会话跑 8 小时 / 3000 万 input 后空回话）——纯函数，不碰库
  'apps/server/src/smoke-session-budget.mjs',
  // 身份与职责检修 P0（2026-11-09）：身份卡只回答"我是谁"、平台契约/任务合同每轮注入。
  // 纯静态 + 纯函数，不开服务。
  'apps/server/src/smoke-persona-contract.mjs',
  'apps/server/src/smoke-plugin-blocks.mjs',
  'apps/server/src/smoke-pr-create.mjs',
  'apps/server/src/smoke-pr-link.mjs',
  'apps/server/src/smoke-pr-review.mjs',
  'apps/server/src/smoke-project-profile.mjs',
  'apps/server/src/smoke-project-tasks.mjs',
  'apps/server/src/smoke-quota.mjs',
  'apps/server/src/smoke-repo-cards.mjs',
  'apps/server/src/smoke-repo-patrol.mjs',
  'apps/server/src/smoke-run-events.mjs',
  'apps/server/src/smoke-run-progress.mjs',
  'apps/server/src/smoke-runtime-heal.mjs',
  // 运行时识别不依赖进程 PATH 快照（2026-11-04）：注册表实时 PATH + 固定落点。
  // ⚠️ 这条会临时改 HKCU\Environment\Path（原样写回）—— 真注册表用例
  'apps/server/src/smoke-runtime-detect.mjs',
  // 纯静态断言（不联网）：手机该走的路由必须带 device 标，桌面专属的必须没有
  'apps/server/src/smoke-users.mjs',
  // 状态词表一致性（2026-11-08）：八态/运行态/节点态、状态⇄看板列、建表默认值。
  // 纯数据 + 源码文本，不开库不起服务 —— 改状态相关代码后单独跑它最快
  // （node apps/server/src/smoke-status-vocab.mjs）
  'apps/server/src/smoke-status-vocab.mjs',
  'apps/server/src/smoke-schedules.mjs',
  'apps/server/src/smoke-steward.mjs',
  'apps/server/src/smoke-ssh.mjs',
  'apps/server/src/smoke-status.mjs',
  'apps/server/src/smoke-stop-keep.mjs',
  'apps/server/src/smoke-stop-watchdog.mjs',
  'apps/server/src/smoke-task-comments.mjs',
  'apps/server/src/smoke-task-flow.mjs',
  'apps/server/src/smoke-task-run-sync.mjs',
  // 步骤档案卡与节点同状态（2026-11-13 实报「卡改成进行中、实例页还是 failed」）：
  // 节点变 → 卡跟着变、没建卡不炸、人手改档案卡被拒。纯库，不起服务。
  'apps/server/src/smoke-step-card-sync.mjs',
  'apps/server/src/smoke-workflows.mjs',
  'apps/desktop/smoke-shell.mjs',
  'tools/smoke-help-pop.mjs',
  // 「重跑这一步」按钮（2026-11-13 实报后加回）：只在失败/已阻塞出现、走 /retry 同一条路；
  // 状态字只显示不可改（2026-11-13 晚拍板，编辑入口已撤）。纯源码断言（前端无构建步骤），几十毫秒。
  'tools/smoke-run-retry-btn.mjs',
  // 数字员工拿回 git 能力之后的三条闸（2026-11-13 试点）：真的推一遍临时 bare 仓库，
  // 直推 main / 带 .env / 正常分支三种情况都要判对 —— 判错不报错，东西就已经推上 GitHub 了。
  'tools/smoke-prepush-guard.mjs',
  // 2026-10-30：分支行尾那颗 `›` 的链路（menu → folderize → combo → combo-menu → 菜单）。
  // 这条链任何一手漏了都不报错、只是箭头不见了，所以必须钉住。
  'tools/smoke-branch-menu.mjs',
];

/** 不跑的：写明原因（要真实 CLI / 模型，会烧 token） */
const SKIP = {
  'apps/server/src/smoke-codex.mjs': '要真实 Codex CLI 与模型',
  'apps/server/src/smoke-dsh.mjs': '要真实 dsh 与模型',
  'apps/server/src/smoke-mcp.mjs': '② 真起 codex / dsh 让模型调 MCP 工具',
  'apps/server/src/smoke-plugin-e2e.mjs': '要 codex 真去 tool_search 调到工具',
};

/* ------------------------------------------- 清单完整性：不许有"没人管的用例" */

const dirs = ['apps/server/src', 'apps/desktop', 'tools'];
const found = dirs.flatMap((d) =>
  fs
    .readdirSync(path.join(repo, d))
    .filter((f) => /^smoke-.*\.mjs$/.test(f))
    .map((f) => `${d}/${f}`),
);
const known = new Set([...RUN, ...Object.keys(SKIP)]);
const unregistered = found.filter((f) => !known.has(f));
const vanished = [...known].filter((f) => !fs.existsSync(path.join(repo, f)));

if (unregistered.length || vanished.length) {
  if (unregistered.length) {
    console.error('这些冒烟用例没登记（要么加进 RUN，要么写进 SKIP 并说明原因）：');
    for (const f of unregistered) console.error('  - ' + f);
  }
  if (vanished.length) {
    console.error('清单里写了、但文件不在了：');
    for (const f of vanished) console.error('  - ' + f);
  }
  process.exit(2);
}

/* ------------------------------------------------- 参数：只跑一条 / 只列清单 */

/*
 * 修红的人（或 agent）第一步永远该是"只跑红的那一条"，不是全量。
 * 全量 3 分半，单条多数 1 秒级；先跑一条能把"复现"的成本压到可忽略。
 */
const argv = process.argv.slice(2);
const onlyArg = (() => {
  const i = argv.findIndex((a) => a === '--only' || a.startsWith('--only='));
  if (i < 0) return null;
  const a = argv[i];
  const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : String(argv[i + 1] ?? '');
  return v.trim() || null;
})();

if (argv.includes('--list') || argv.includes('-l')) {
  console.log(`要跑的 ${RUN.length} 个（另跳过 ${Object.keys(SKIP).length} 个 = 要真实 CLI / 模型）：`);
  for (const f of RUN) console.log('  ' + f);
  process.exit(0);
}

const targets = onlyArg ? RUN.filter((f) => f.includes(onlyArg)) : RUN;
if (onlyArg && !targets.length) {
  console.error(`--only=${onlyArg} 一个都没选中 —— 清单里没有含这个子串的路径。`);
  console.error('常用：--only=smoke-pr-create / --only=pr / --only=task / --only=run-progress；先 --list 看全清单。');
  process.exit(2);
}

/**
 * 把输出里那条 ✗ 的断言文案，回到用例源码里找出它的 `文件:行`。
 *
 * 为什么要在 runner 里干这件事：check() 打的是"中文标签 + 实际值"，
 * 没有行号 —— agent 拿到 797 行的用例文件只能靠肉眼把标签和代码对上；
 * 而标签文本本身就在 check('...' 的字面量里，反查一次就够。
 * 找不到（标签被拆行/拼出来）就返回 null，别硬猜一个错行号。
 */
function whereIs(file, outLine) {
  const label = outLine.trim().replace(/^✗\s*/, '').split(' — ')[0].trim();
  if (!label) return null;
  let src = '';
  try {
    src = fs.readFileSync(path.join(repo, file), 'utf8');
  } catch {
    return null;
  }
  const needle = label.length > 24 ? label.slice(0, 24) : label;
  const idx = src.split('\n').findIndex((l) => l.includes(needle));
  return idx >= 0 ? `${file}:${idx + 1}` : null;
}

/** GitHub 注解的属性值和正文要转义，否则带逗号/百分号的断言会把注解切坏 */
const ghEscape = (s) =>
  String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/,/g, '%2C').replace(/:/g, '%3A');

/* ------------------------------------------------------------------ 开跑 */

/*
 * 先跑**前端的静态自检**（不需要浏览器）：路由表与 setRoute 调用必须对得上。
 * 放这儿是因为 CI 只调这一个入口 —— 单开一个 workflow 步骤容易漏。
 * `--only` 时不跑：那时人只想知道那一条用例红不红，路由自检红了只会添乱。
 */
if (!onlyArg) {
  const routes = spawnSync(process.execPath, [path.join(repo, 'tools', 'check-routes.mjs')], {
    cwd: repo,
    stdio: 'inherit',
  });
  if (routes.status !== 0) {
    console.error('✗ 前端路由自检没过（见上）');
    process.exit(1);
  }

  /*
   * 再跑**文档与代码的对账**（2026-11-03 加）：活文档里提到的文件得在、行号得站得住、
   * 注释里的数字得等于代码里的实际数量、旧说法不许又写回来。
   * 同样挂在 CI 的唯一入口上 —— 它和冒烟一样是"掉队就该红"的东西，
   * 而人工"记得改文档"已经证明靠不住（11-03 那一轮挖出 11 处漂移）。
   */
  const drift = spawnSync(process.execPath, [path.join(repo, 'tools', 'check-doc-drift.mjs')], {
    cwd: repo,
    stdio: 'inherit',
  });
  if (drift.status !== 0) {
    console.error('✗ 文档与代码对不上（见上）');
    process.exit(1);
  }

  /*
   * 再跑**分发链自检**（2026-11-08 加）：routes/*.mjs 的实现 ↔ routes/chain.mjs 的登记表。
   * 加了一个路由模块忘了挂链，请求就是 404 —— 不报错、不崩、只有点到那条才发现；
   * 而这条检查纯源码文本、几十毫秒，正好钉在唯一入口上。
   */
  const chain = spawnSync(process.execPath, [path.join(repo, 'tools', 'check-dispatch-chain.mjs')], {
    cwd: repo,
    stdio: 'inherit',
  });
  if (chain.status !== 0) {
    console.error('✗ 分发链对不上（见上）');
    process.exit(1);
  }

  /*
   * 再跑**幽灵引用自检**（2026-11-08 加）：注释/文档里指向不存在文件的那类指路。
   * 它不改任何行为，但会**骗人** —— 11-08 排查手机端登录页时，就是被"401 → 重新扫码"
   * 这条过期注释带到了已退场的老壳上。机制退场时，指路也得跟着退场。
   */
  const ghosts = spawnSync(process.execPath, [path.join(repo, 'tools', 'check-ghost-refs.mjs')], {
    cwd: repo,
    stdio: 'inherit',
  });
  if (ghosts.status !== 0) {
    console.error('✗ 有引用指向不存在的东西（见上）');
    process.exit(1);
  }

  console.log(`跳过 ${Object.keys(SKIP).length} 个（要真实 CLI / 模型）：`);
  for (const [f, why] of Object.entries(SKIP)) console.log(`  · ${path.basename(f)} —— ${why}`);
}

console.log(onlyArg ? `\n只跑 ${targets.length} 个（--only=${onlyArg}）：` : `\n跑 ${targets.length} 个：`);

const failed = [];
const results = [];
for (const f of targets) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [f], {
    cwd: repo,
    /*
     * ⚠️ 冒烟默认钉 `BANDI_HOST=127.0.0.1`（2026-11-03：服务端缺省改成对外监听 0.0.0.0）。
     * 绝大多数用例要的是"免鉴权的回环形态"这个确定性底座，不是"对外监听"本身；
     * 要测**缺省对外 / 鉴权**的用例（smoke-auth ⑨、smoke-lan-origin）自己把 BANDI_HOST
     * 从子进程 env 里剥掉 —— 那才是被测行为，别让整批用例陪跑。
     */
    env: { ...process.env, BANDI_HOST: process.env.BANDI_HOST ?? '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  console.log(`  ${ok ? '✓' : '✗'} ${path.basename(f)}  ${(ms / 1000).toFixed(1)}s`);
  results.push({ f, ok, ms });
  if (!ok) {
    failed.push(f);
    const out = ((r.stdout ?? '') + (r.stderr ?? '')).trim();
    /*
     * 失败时先**把每条 ✗ 捞出来并标上位置**（2026-10-17：CI 上只看得到 15 行尾巴，
     * 失败的那条恰好被截掉，只能靠再跑一遍才能问出"到底是哪一项"；
     * 2026-10-30：光问出哪一项还不够，还得知道它在用例的哪一行 —— 见 whereIs）。
     *
     * 只认**行首就是 ✗** 的那种：用例里的分段标题也可能带 ✗（比如「PR 行上那颗 ✗ 的落点」），
     * 那是小节名不是失败项，算进来会把 agent 往错的地方带。
     */
    const bad = out.split('\n').filter((l) => /^\s*✗\s/.test(l) || /跑挂了/.test(l));
    const hits = bad.map((l) => ({ at: whereIs(f, l), line: l.trim() }));

    // 完整输出落盘：尾部 15 行只够看结论，翻上下文不该再花一次全量重跑
    const logPath = path.join(repo, 'tmp', `smoke-fail-${path.basename(f, '.mjs')}.log`);
    let logRel = null;
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, out + '\n', 'utf8');
      logRel = rel(logPath);
    } catch {
      /* 落盘失败不影响结论 */
    }

    if (hits.length) {
      console.log(`    ---- 没过的断言（${hits.length} 条，带 文件:行）----`);
      for (const h of hits) console.log(`    ${h.at ? '@' + h.at : '@?（标签跨行了，自己搜一下）'}  ${h.line}`);
    } else {
      console.log('    ---- 没有 ✗ 行：用例多半是抛异常挂的，看下面的尾部 ----');
    }
    if (logRel) console.log(`    ---- 完整输出（${out.length} 字节）----\n    ${logRel}`);
    const tail = out.split('\n').slice(-15).join('\n');
    console.log('    ---- 输出尾部 ----');
    console.log(
      tail
        .split('\n')
        .map((l) => '    ' + l)
        .join('\n'),
    );

    // CI 上把每条失败断言变成一条注解：PR 页面直接点到 文件:行，不用翻日志
    if (process.env.GITHUB_ACTIONS) {
      if (!hits.length) console.log(`::error file=${f}::冒烟用例没过：${path.basename(f)}`);
      for (const h of hits) {
        const [file, line] = (h.at ?? f).split(':');
        console.log(`::error file=${file}${line ? `,line=${line}` : ''}::${ghEscape(h.line)}`);
      }
    }
  }
}

const slow = results.filter((r) => r.ms > 60000).map((r) => `${path.basename(r.f)} ${(r.ms / 1000).toFixed(0)}s`);
if (slow.length) console.log(`\n（偏慢的：${slow.join('、')}）`);

console.log(`\n结论：${failed.length ? `${failed.length} 个没过 —— ${failed.join('、')}` : `${targets.length} 个全通过`}`);

/*
 * 结论之后直接给"下一步"，是这次改动的重点：
 * 原来到这里就结束了，agent 只能自己猜"我该跑什么、日志在哪"，
 * 于是把全量再跑一遍 —— 那 3 分半是纯等待。
 */
if (failed.length) {
  console.log('\n只跑没过的那几条（不用全量重跑）：');
  for (const f of failed) {
    console.log(`  node ${f}`);
    console.log(`  （= CI 里的同一条：node tools/run-smokes.mjs --only=${path.basename(f, '.mjs')}）`);
  }
  console.log('\n先看失败断言上的 @文件:行 —— 打开那十行就够定位，别从头读整个用例。');
}
process.exit(failed.length ? 1 : 0);
