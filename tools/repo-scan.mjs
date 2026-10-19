#!/usr/bin/env node
/**
 * 仓库巡检 → 把"要人管的事"写进班底看板（去重）。
 *
 * 用途：过去看仓库要去 GitHub 翻；现在巡检一遍，**待办直接落到你正在看的看板上**，
 * 卡片能拖（拖到哪一列就是你给它的指令）、能删（删掉＝忽略）。
 *
 * 做什么：
 *   ① 拉 GitHub 的 open PR / open issue（公开仓库不需要令牌）；
 *   ② 每一条写成一张卡（PR 卡带上"该跑什么命令"的证据清单，并把 PR 本身的状态一起报上去）；
 *   ③ 写到 `POST /api/projects/<id>/repo-cards` —— 服务端按去重键更新，**绝不覆盖你改过的状态**。
 *
 * 跑法：
 *   node tools/repo-scan.mjs                       # 用默认控制面 127.0.0.1:8787 + 仓库默认项目
 *   node tools/repo-scan.mjs --dry                 # 只看会写什么，不写
 *   node tools/repo-scan.mjs --project pj-xxxx     # 指定项目
 *   node tools/repo-scan.mjs --note "给 main 加分支保护" --note-body "……"   # 手记一条"卫生"卡
 *
 * 环境变量：BANDI_BASE（控制面）、BANDI_TOKEN（控制面要求令牌时）、GITHUB_REPO（owner/name）
 */
/** 极简参数解析：--key value / --flag */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const BASE = String(args.base ?? process.env.BANDI_BASE ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const TOKEN = process.env.BANDI_TOKEN ?? '';
const REPO = String(args.repo ?? process.env.GITHUB_REPO ?? 'shepherd-chenxs/bandi');
const DRY = args.dry === true;

const headers = () => ({
  'Content-Type': 'application/json',
  ...(TOKEN ? { 'X-Bandi-Token': TOKEN } : {}),
  'User-Agent': 'bandi-repo-scan',
});

const api = async (p, opt = {}) => {
  const r = await fetch(BASE + p, { ...opt, headers: { ...headers(), ...(opt.headers ?? {}) } });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON：原样带着 */ }
  if (!r.ok) throw new Error(`${opt.method ?? 'GET'} ${p} → ${r.status} ${body?.error ?? text.slice(0, 160)}`);
  return body;
};

/** 选项目：显式给了就用；没给就用"唯一/默认"那个，免得每次都要查 id */
async function pickProject(explicit) {
  const list = (await api('/api/projects')).projects ?? [];
  if (!list.length) throw new Error('平台里一个项目都没有：先在「项目」里建一个（或把仓库登记成项目）');
  if (explicit) {
    const hit = list.find((p) => p.id === explicit || p.name === explicit);
    if (!hit) throw new Error(`找不到项目「${explicit}」（现有：${list.map((p) => p.name).join('、')}）`);
    return hit;
  }
  const def = list.find((p) => p.builtIn) ?? list[0];
  return def;
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** 一张 PR 卡的内容：结论 + 该跑什么 + 链接 */
function prCard(pr) {
  return {
    key: `pr:${pr.number}`,
    title: `PR #${pr.number} 待审：${clip(pr.title, 60)}`,
    /*
     * 把 PR 本身一起报上去（2026-10-17）：服务端据此写卡上的 `prRepo/prNumber/prState`，
     * 看板才会出现「PR #n 开着」那枚标签，卡也才进得了「刷新 PR」的清单。
     * 这里只报巡检看见的事实，**不替人下结论** —— 合并了卡片状态照样是人来拖。
     */
    pr: {
      url: pr.html_url,
      title: pr.title,
      state: pr.merged_at ? 'merged' : pr.state === 'open' ? 'open' : 'closed',
    },
    body: [
      `作者：${pr.user?.login ?? '?'} ｜ 改动：+${pr.additions ?? '?'} / -${pr.deletions ?? '?'} ｜ 文件 ${pr.changed_files ?? '?'}`,
      '',
      '结论：**待审**（还没人跑过验证）',
      '',
      '要跑的（在仓库根）：',
      '```sh',
      `git fetch origin '+refs/pull/${pr.number}/head:refs/remotes/pr/${pr.number}'`,
      `git worktree add ../bandi-pr-${pr.number} refs/remotes/pr/${pr.number}`,
      `cd ../bandi-pr-${pr.number}`,
      'node tools/check-pr.mjs      # 零依赖 / 地址白名单 / 断言完整性',
      'node tools/run-smokes.mjs    # 不需要真实 CLI 的那批',
      '```',
      '判据、红线（一票否决）、黄线都在 docs/审阅经验.md。',
      '',
      `链接：${pr.html_url}`,
      pr.body ? `\nPR 描述：${clip(pr.body, 300)}` : '',
    ].filter(Boolean).join('\n'),
  };
}

/** 一张 issue 卡：先分类，再由人决定 */
function issueCard(issue) {
  const labels = (issue.labels ?? []).map((l) => l.name).filter(Boolean);
  return {
    key: `issue:${issue.number}`,
    title: `issue #${issue.number} 待分类：${clip(issue.title, 60)}`,
    body: [
      `作者：${issue.user?.login ?? '?'}${labels.length ? ` ｜ 标签：${labels.join('、')}` : ''}`,
      '',
      '结论：**待分类**（值得做 / 不值得 / 广告引流 / 需要澄清）—— 定了再回复，别晾着。',
      '回复模板见 docs/审阅经验.md 末尾（值得做 / 不值得做 / 广告三类）。',
      '',
      `链接：${issue.html_url}`,
      issue.body ? `\n正文：${clip(issue.body, 300)}` : '',
    ].filter(Boolean).join('\n'),
  };
}

async function gh(p) {
  const r = await fetch(`https://api.github.com/repos/${REPO}${p}`, {
    headers: { 'User-Agent': 'bandi-repo-scan', Accept: 'application/vnd.github+json' },
  });
  if (!r.ok) throw new Error(`GitHub ${p} → ${r.status}${r.status === 404 ? '（仓库不存在，或拼错了 owner/name）' : ''}`);
  return r.json();
}

async function writeCard(projectId, card) {
  if (DRY) {
    console.log(`  · [dry] ${card.title}`);
    return { dry: true };
  }
  const res = await api(`/api/projects/${encodeURIComponent(projectId)}/repo-cards`, {
    method: 'POST',
    body: JSON.stringify(card),
  });
  console.log(`  ${res.created ? '＋ 新建' : res.changed ? '↻ 更新' : '＝ 没变'} ${card.title}`);
  return res;
}

/* ------------------------------------------------------------------ 主流程 */

const project = await pickProject(args.project);
console.log(`仓库巡检：${REPO}`);
console.log(`写到项目：${project.name}（${project.id}）${DRY ? '  · dry-run，不会真写' : ''}\n`);

let created = 0, updated = 0, unchanged = 0;
const tally = (res) => {
  if (res?.dry) return;
  if (res?.created) created++;
  else if (res?.changed) updated++;
  else unchanged++;
};

console.log('① 待审的 PR');
const prs = await gh('/pulls?state=open&per_page=30');
if (!prs.length) console.log('  （没有开着的 PR）');
for (const pr of prs) tally(await writeCard(project.id, prCard(pr)));

console.log('\n② 待分类的 issue');
const issues = (await gh('/issues?state=open&per_page=30')).filter((x) => !x.pull_request);
if (!issues.length) console.log('  （没有开着的 issue）');
for (const is of issues) tally(await writeCard(project.id, issueCard(is)));

if (args.note) {
  console.log('\n③ 手记一条');
  const body = String(args['note-body'] ?? '').trim();
  const key = String(args.key ?? `note:${Buffer.from(String(args.note)).toString('base64url').slice(0, 24)}`);
  tally(await writeCard(project.id, { key, title: String(args.note), body }));
}

console.log(`\n结论：新建 ${created} 张、更新 ${updated} 张、没变 ${unchanged} 张。`);
console.log('看板：项目 → 点进那个项目（或工作台 → 任务看板）；「仓库值班」标签就是这些卡。');
console.log('卡片状态就是指令：拖到「已完成」＝ 处理完了，删掉 ＝ 忽略。');
