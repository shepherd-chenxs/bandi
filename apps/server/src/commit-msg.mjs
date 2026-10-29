import { changeDigest } from './git-repos.mjs';
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
export async function suggestCommitMessage(row, { paths = null, timeoutMs = 15000 } = {}) {
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
