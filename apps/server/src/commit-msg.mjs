import { changeDigest, workState } from './git-repos.mjs';
import { loadDevices } from './runtimes.mjs';
import { adapterFor } from './adapters.mjs';

/**
 * 「生成提交说明」（2026-10-29）。
 *
 * 为什么不是丢给员工：这事只需要**看一眼改动、写一行字**，走员工就是开一场对话
 * （读源码、自查、十来轮往返，实测 566 秒）。这里是一次性短跑：素材自己从 git 取，
 * 模型只负责措辞，写完就散，不建 run、不留会话、不进上下文。
 *
 * 运行时用 `auto`（当下第一个能跑的）—— 跟喜儿同一条理由：这是**顺手工具**，
 * 谁在机器上都不该因为"没绑定运行时"就按不动；真要精细挑模型的场景不在这里。
 *
 * ⚠️ 模型挂了、超时、没运行时 → **退规则兜底**，按钮永远给得出东西，不会转圈转到底。
 * 兜底说明只如实交代"动了几个文件"，不假装懂业务 —— 假说明比没说明害人。
 */

/** 说明的上限：一行，长了在手写框里也是废的 */
const MAX_LEN = 72;

/** 只留一行、去掉代码块与引号 —— 模型爱把一句话包成 ```text … ``` */
export function pickMessage(text) {
  const raw = String(text ?? '').replace(/\r/g, '');
  const body = raw.replace(/^\s*```[a-z]*\s*/i, '').replace(/```\s*$/i, '');
  const lines = body
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*·>]|\d+[.)])\s*/, '').replace(/^["'「『]|["'」』]$/g, '').trim())
    .filter(Boolean);
  // 优先取符合 `type: 话` 的那行；都没有就取第一行
  const conv = lines.find((l) => /^[a-z]+(\([^)]{1,24}\))?!?:/.test(l));
  return (conv ?? lines[0] ?? '').slice(0, MAX_LEN);
}

/** 兜底：从改动形状推一条不撒谎的说明（纯函数，冒烟直接钉） */
export function fallbackMessage(digest) {
  const files = digest.files ?? [];
  const n = files.length;
  if (!n) return '';
  const allNew = files.every((f) => f.status === '??' || f.status.startsWith('A'));
  const allGone = files.every((f) => f.status.startsWith('D'));
  const type = allNew ? 'feat' : 'chore';
  if (allGone) return `chore: 删除 ${n} 个文件`.slice(0, MAX_LEN);
  // 取改动最集中的**目录**当 scope（apps/web / docs …）—— 文件名进 scope 是废的
  const cnt = new Map();
  for (const f of files) {
    const dirs = f.path.includes('/') ? f.path.split('/').slice(0, -1) : [];
    const seg = dirs.slice(0, 2).join('/');
    cnt.set(seg, (cnt.get(seg) ?? 0) + 1);
  }
  const scope = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const what = n === 1 ? files[0].path.split('/').pop() : `${n} 个文件`;
  return `${type}${scope ? `(${scope})` : ''}: ${allNew ? '新增' : '更新'} ${what}`.slice(0, MAX_LEN);
}

const PROMPT_HEAD = `你在给一次 git 提交写说明。只根据下面这份改动信息写**一行**中文提交说明。

硬性要求：
- 只输出那一行，不要解释、不要代码块、不要引号、不要换行。
- 格式：\`type: 一句话\`，type 只能是 feat / fix / docs / style / refactor / perf / test / chore / build / ci。
- 说清"改了什么"，别写"更新代码""本次提交"这类空话。
- 不超过 60 个字。
- **不要调用任何工具、不要读文件、不要运行命令** —— 信息全在下面。

`;

export function buildPrompt(digest) {
  const shown = digest.files.slice(0, 40);
  const fileLines = shown.map((f) => `- ${f.status} ${f.path}`).join('\n')
    + (digest.files.length > shown.length ? `\n- …另有 ${digest.files.length - shown.length} 个文件` : '');
  const parts = [
    PROMPT_HEAD,
    `仓库：${digest.fullName ?? ''}　分支：${digest.branch ?? ''}`,
    `命令涉及 ${digest.files.length} 个文件：\n${fileLines}`,
    digest.untracked.length ? `\n其中新文件（未跟踪）：\n${digest.untracked.slice(0, 20).map((p) => `- ${p}`).join('\n')}` : '',
    digest.stat ? `\n改动统计：\n${digest.stat}` : '',
    digest.diff ? `\ndiff${digest.diffTruncated ? '（已截断）' : ''}：\n${digest.diff}` : '',
  ];
  return parts.filter(Boolean).join('\n');
}

/**
 * 挑一个能跑的运行时，**claude 优先**。
 *
 * 为什么不直接用 `resolveForRun('auto')`：auto 取的是清单里第一个（这台机器上是 Codex），
 * 而实测 codex 这条短跑会卡到超时（31 秒空手而归）。这个活只要"读一段文本、写一行字"，
 * 谁的空载最快就用谁 —— 顺序写死在这儿，别让它随机挑。
 */
function pickRuntime(prefer = ['claude', 'codex', 'dsh']) {
  const all = [];
  for (const d of loadDevices()) {
    for (const r of d.runtimes ?? []) if (r.enabled && r.path) all.push(r);
  }
  const rank = (f) => (prefer.indexOf(f) >= 0 ? prefer.indexOf(f) : 99);
  return all.sort((a, b) => rank(a.family) - rank(b.family))[0] ?? null;
}

/**
 * @returns {Promise<{message:string, source:'model'|'rule', note?:string}>}
 *   source=rule 时 note 说明为什么没走成模型（界面上小字带一句，别让人以为是模型写的）
 */
export async function suggestCommitMessage(row, { paths = null, timeoutMs = 30000 } = {}) {
  /*
   * **不带 diff 正文**（2026-10-29 实测）：同一份改动，喂 4000 字 diff 要 **40 秒**，
   * 只给文件清单 + `--stat` 是 **6.3 秒**，而写一行说明的质量没差 —— 一行字要的是
   * "改了哪块、大概什么事"，不是每行代码。慢的根源是输入长度，不是模型笨。
   */
  const digest = await changeDigest(row, { paths, maxDiffChars: 0 });

  const md = fallbackMessage(digest);
  const rt = pickRuntime();
  const adapter = rt ? adapterFor(rt.family) : null;
  if (!rt || !adapter) {
    return { message: md, source: 'rule', note: rt ? `没有 ${rt.family} 的适配器` : '没有可用的运行时（设置 → 运行时）' };
  }

  const ctl = new AbortController();
  // 15 秒实测不够（2026-10-30）：Claude Code 冷启动到吐字这台机器要 17 秒+，每次都掐死在临门一脚，
  // 界面永远只见"没给出可用的说明"。30 秒是"真挂了"和"慢"的分界。
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const out = await adapter({
      task: buildPrompt(digest),
      cwd: row.localPath,
      cliPath: rt.path,
      // 只要措辞，不要它动手：codex 的 read-only 等于"工具全禁"，正合适；claude/dsh 没有这档
      ...(rt.family === 'codex' ? { sandbox: 'read-only' } : {}),
      signal: ctl.signal,
    });
    // 适配器失败是**正常 resolve**（text 空 + error 带真话），不是 reject —— 不接住它，
    // 真话就被扔了，永远报成"没给出可用的说明"（2026-10-30 实测踩过）
    if (out?.isError || out?.error) {
      return { message: md, source: 'rule', note: `模型没跑成：${out.error}` };
    }
    const msg = pickMessage(out?.text);
    if (msg) return { message: msg, source: 'model' };
    return { message: md, source: 'rule', note: `${rt.label ?? rt.family} 没给出可用的说明` };
  } catch (e) {
    const why = ctl.signal.aborted ? `等了 ${Math.round(timeoutMs / 1000)} 秒没回` : String(e?.message ?? e);
    return { message: md, source: 'rule', note: `模型没跑成：${why}` };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ PR 草稿 */

/**
 * 解析模型给的 PR 草稿（**纯函数**，冒烟直接钉）。
 *
 * 约定的输出形状是「标题：…」一行 + 「描述：」后面跟正文；模型不守规矩时按行数猜 ——
 * 第一行当标题、剩下的当描述。标题压到 80 字、描述压到 600 字，再长弹窗里也放不下。
 */
export function parsePrDraft(text) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n').map((l) => l.trim());
  const ti = lines.findIndex((l) => /^标题[:：]/.test(l));
  const bi = lines.findIndex((l) => /^描述[:：]?\s*$/.test(l));
  let title = ti >= 0 ? lines[ti].replace(/^标题[:：]\s*/, '') : lines[0] ?? '';
  let body = '';
  if (bi >= 0) body = lines.slice(bi + 1).join('\n');
  else if (ti >= 0) body = lines.filter((l, i) => i !== ti && l).join('\n');
  else body = lines.slice(1).join('\n');
  title = title.replace(/^["'「『]|["'」』]$/g, '').trim().slice(0, 80);
  body = body.trim().slice(0, 600);
  return { title, body };
}

/** 兜底：从"没推的提交 + 未提交改动"拼一份不撒谎的草稿，没有素材就回 null（按钮报错） */
export function fallbackPrDraft(st, digest) {
  const commits = st.aheadCommits ?? [];
  const files = digest?.files ?? [];
  if (commits.length) {
    /*
     * 2026-10-29 用户指着弹窗问"这是直接拿来用吗"：上面提交卡已经列过一遍标题，
     * 描述再原样抄一遍等于复读，一点增量信息都没有。兜底做点轻加工 ——
     * 剥掉 type: 前缀、截取分号前的第一截、按它去重（"设置左栏分区折叠；A" 和
     * "设置左栏分区折叠；B" 是同一件事的两次提交，留一条就够）——
     * 写出来的是"这批提交在做什么"的摘要，不是清单本体。终稿仍该人过一遍。
     */
    const seen = new Set();
    const points = [];
    for (const c of commits) {
      const s = String(c.subject ?? '').replace(/^\w+(?:\([^)]*\))?!?:\s*/, '').trim();
      const head = (s.split(/[；;]/)[0] || s).trim();
      const key = head.toLowerCase();
      if (!head || seen.has(key)) continue;
      seen.add(key);
      points.push(head);
      if (points.length >= 6) break;
    }
    const body = points.map((p) => `- ${p}`).join('\n')
      + (commits.length > points.length ? `\n- …等共 ${commits.length} 条提交` : '')
      + '\n\n未验证';
    return { title: String(commits[0].subject).slice(0, 80), body };
  }
  if (files.length) {
    // 只剩「没提交的改动」这种素材不再走这里：PR 装不进去（canPr 已经把这条挡在外面了）
    const msg = fallbackMessage(digest);
    return { title: msg, body: `改动 ${files.length} 个文件\n\n未验证` };
  }
  return null;
}

const PR_PROMPT_HEAD = `你在给一个 GitHub PR 写标题和描述。只根据下面给出的信息写。

硬性要求：
- 输出只有两段：第一行以「标题：」开头；随后一行写「描述：」，描述跟在后面 2~4 行。
- 标题不超过 40 个字，说清这个 PR 干了什么，别写"更新代码"这种空话。
- 描述写"改了什么 + 怎么验的"；信息里看不出验证就写「未验证」—— 别编造「安全」「已修复」。
- 不要代码块、不要解释、不要调用任何工具。

`;

export function buildPrPrompt(st, digest) {
  const parts = [PR_PROMPT_HEAD];
  if (st.branch) parts.push(`分支 ${st.branch} → 合进 ${st.base ?? '（base 未记录）'}`);
  if (st.aheadCommits?.length) {
    parts.push(`这个分支上已提交、还没推的 ${st.aheadCommits.length} 条提交：\n${st.aheadCommits.slice(0, 15).map((c) => `- ${c.subject}`).join('\n')}`);
  }
  if (digest?.files?.length) {
    const shown = digest.files.slice(0, 30);
    parts.push(`未提交、会一并进这条 PR 的 ${digest.files.length} 个文件：\n${shown.map((f) => `- ${f.status} ${f.path}`).join('\n')}${digest.files.length > shown.length ? `\n- …另有 ${digest.files.length - shown.length} 个` : ''}`);
  }
  if (digest?.stat) parts.push(`改动统计：\n${digest.stat}`);
  return parts.join('\n\n');
}

/**
 * PR 弹窗的「自动填充」（2026-10-29，用户："这个加个自动填充功能"）。
 *
 * 素材是两块：**没推的提交**（`workState().aheadCommits`，干干净净的标题清单）
 * 和**未提交改动**（`changeDigest`，只给清单和 --stat，不喂 diff 正文 —— 理由见上）。
 * 模型只管把这两块拧成「标题 + 描述」；挂了、超时、没运行时 → 规则兜底；
 * 连兜底素材都没有（工作区干净、分支也不领先）→ 回 null，按钮报"没东西可填"。
 *
 * @returns {Promise<{title:string, body:string, source:'model'|'rule', note?:string}|null>}
 */
export async function suggestPrDraft(row, { timeoutMs = 30000 } = {}) {
  const st = await workState(row);
  /* 素材只有**已提交、还没推**的那些（2026-10-29：建 PR 不再顺手提交，脏文件进不去 PR，
     拿它当素材写出来的描述就是假话）。没有提交可推 → 没得填。 */
  if (!st.canPr) return null;
  const digest = null;

  const fb = fallbackPrDraft(st, digest);
  const rt = pickRuntime();
  const adapter = rt ? adapterFor(rt.family) : null;
  if (!rt || !adapter) {
    return fb ? { ...fb, source: 'rule', note: rt ? `没有 ${rt.family} 的适配器` : '没有可用的运行时（设置 → 运行时）' } : null;
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const out = await adapter({
      task: buildPrPrompt(st, digest),
      cwd: row.localPath,
      cliPath: rt.path,
      ...(rt.family === 'codex' ? { sandbox: 'read-only' } : {}),
      signal: ctl.signal,
    });
    // 同 suggestCommitMessage：失败是 resolve 不 reject，error 字段不接住就丢了
    if (out?.isError || out?.error) {
      return fb ? { ...fb, source: 'rule', note: `模型没跑成：${out.error}` } : null;
    }
    const draft = parsePrDraft(out?.text);
    if (draft.title) return { ...draft, source: 'model' };
    return fb ? { ...fb, source: 'rule', note: `${rt.label ?? rt.family} 没给出可用的草稿` } : null;
  } catch (e) {
    const why = ctl.signal.aborted ? `等了 ${Math.round(timeoutMs / 1000)} 秒没回` : String(e?.message ?? e);
    return fb ? { ...fb, source: 'rule', note: `模型没跑成：${why}` } : null;
  } finally {
    clearTimeout(timer);
  }
}
