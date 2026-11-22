/**
 * progress-ledger.mjs —— 「这段活干到哪了」的**事实账**（2026-11-22，缺口①后半）。
 *
 * ## 为什么要有它
 *
 * 会话轮换（session-budget.mjs）之后，新会话把上下文全忘了，而平台原来只交接
 * **最近 8 条消息 ×160 字** —— 那是"刚才聊到哪"，不是"这件事干到哪"。
 * 真实后果：一段活跑了 7 轮（失败 5 次），换个会话接手的第一句话是"我先看看"，
 * 于是把已经改过的文件再改一遍、把已经踩过的坑再踩一遍。
 *
 * 库里其实全都有：`runs`（每轮成没成、为什么挂）、`run_events`（跑了什么命令、
 * 改了哪些文件）、`project_tasks`（卡现在什么状态、PR/CI 什么结论）。
 * 缺的只是**把它们摆到新会话面前**。
 *
 * ## 三条边界（改之前先想清楚）
 *
 * ① **只写平台能证明的事实**：轮次、成败、命令、改动文件、报错、卡状态。
 *    **不做摘要、不猜意图、不评价"他干得好不好"** —— 摘要会漏会编，这里每一行
 *    都能顺着 runId 回到事件流。要读原话，交接块里还有最近几条消息。
 * ② **只读尾部事件**：一轮能上千条事件、单条 64KB，全读会拖慢派活；这里只扫
 *    尾部 N 条（够看清"最后在干什么"）。
 * ③ **有上限**：3 轮 / 10 个文件 / 整块 1200 字。交接块本身不能再变成大上下文。
 */

import * as store from './store.mjs';
import { claimOf } from './delivery-claim.mjs';
import { evidenceOf } from './delivery-evidence.mjs';

export const PROGRESS = Object.freeze({
  /** 明细列几轮（新的在上）；更早的只进"一共几轮"的计数 */
  maxRuns: 3,
  /** 改动文件列几个（去重后） */
  maxFiles: 10,
  /** 每轮的报错留多长 */
  maxErrorChars: 90,
  /** 整块硬上限 */
  maxChars: 1200,
  /** 每轮只扫尾部多少条事件 */
  scanEvents: 80,
});

const STATUS_LABEL = {
  todo: '待办',
  doing: '进行中',
  review: '待验收',
  done: '已完成',
  blocked: '已阻塞',
  cancelled: '已取消',
  idea: '想法',
};

const RUN_LABEL = { done: '完成', failed: '失败', stopped: '被停', running: '在跑' };

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, Math.max(1, n - 1))}…` : t;
};

/** `2026-11-20T14:09:10.660Z` → `11-20 22:09`（本地时区；交接给人看，不用 ISO） */
function shortTime(iso) {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function durationOf(run) {
  const a = Date.parse(String(run?.startedAt ?? ''));
  const b = Date.parse(String(run?.endedAt ?? ''));
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '';
  const min = Math.round((b - a) / 60000);
  if (min < 1) return '不到 1 分钟';
  if (min < 60) return `${min} 分钟`;
  return `${(min / 60).toFixed(1)} 小时`;
}

/**
 * 命令说人话：剥掉运行时的 shell 外壳。
 *
 * codex 把每条命令都包在 `"C:\...\powershell.exe" -Command 'sleep 5'` 里（2026-11-22 实查），
 * 原样交接的话，新会话看到的"最后命令"全是那串 exe 路径 —— 等于什么都没说。
 */
export function cleanCommand(cmd) {
  let s = String(cmd ?? '').replace(/\s+/g, ' ').trim();
  const ps = /^"?[^"]*(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-\w+\s+)*-Command\s+["']?(.+?)["']?$/i.exec(s);
  if (ps) s = ps[1];
  const sh = /^"?[^"]*bash(?:\.exe)?"?\s+-\w*c\s+["']?(.+?)["']?$/i.exec(s);
  if (sh) s = sh[1];
  return s.replace(/^["']|["']$/g, '').trim();
}

/**
 * 报错说人话。
 *
 * 库里三种形态（2026-11-20 实查）：`退出码 4294967295`（进程被强杀）、
 * `2026-11-20T12:47:59.7Z ERROR codex_core::tools::router: ...`（运行时日志行）、
 * `服务重启，这次运行被中断`。原样抄给新会话只会让它以为"要处理一个技术问题"，
 * 所以只留能指导下一步的那半句。
 */
export function readableError(error) {
  const raw = String(error ?? '').trim();
  if (!raw) return '';
  const exitCode = /^退出码\s*(-?\d+)$/.exec(raw);
  if (exitCode) return `进程异常退出（退出码 ${exitCode[1]}）`;
  // 运行时日志：去掉行首 ISO 时间与级别词，留正文
  const stripped = raw
    .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s*/, '')
    .replace(/^(ERROR|WARN|error:|warning:)\s*/i, '')
    .trim();
  return clip(stripped || raw, PROGRESS.maxErrorChars);
}

/**
 * 从**一条运行的事件**里抽事实（纯函数，冒烟直接测）。
 *
 * @param {Array<object>} events 已解析的事件对象，按 seq 升序
 * @returns {{tools:number, commands:string[], files:string[], errors:string[]}}
 */
export function factsOfRun(events) {
  const commands = [];
  const files = [];
  const errors = [];
  let tools = 0;
  for (const evt of events) {
    if (!evt || typeof evt !== 'object') continue;
    if (evt.type === 'error') {
      const msg = readableError(evt.message ?? evt.text ?? '');
      if (msg) errors.push(msg);
      continue;
    }
    if (evt.type !== 'tool') continue;
    tools += 1;
    const d = evt.detail ?? {};
    const cmd = d.command ?? d.cmd ?? '';
    if (cmd) commands.push(clip(cleanCommand(cmd), 120));
    /*
     * 只认**改动**类事件的路径：`file_change` / `apply_patch` 的 `changes[]`。
     * 不能见 `detail.path` 就当改动 —— Read / Glob 也带 path，那会把"看了一眼"
     * 说成"改过"，新会话据此以为文件已经改好了，比不交接还坏。
     */
    const changes = Array.isArray(d.changes) ? d.changes : [];
    const mutating = changes.length > 0 || evt.name === 'file_change' || evt.name === 'apply_patch';
    if (!mutating) continue;
    for (const c of changes) if (c?.path) files.push(String(c.path));
    if (d.path) files.push(String(d.path));
    if (d.file) files.push(String(d.file));
  }
  return { tools, commands, files, errors };
}

/** 相对化：把仓库内的绝对路径压成仓库内相对路径（读起来短一半） */
function relPath(p, root) {
  let s = String(p ?? '').replace(/\\/g, '/').trim();
  const r = String(root ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (r && s.toLowerCase().startsWith(`${r.toLowerCase()}/`)) s = s.slice(r.length + 1);
  return s;
}

/** 一轮的明细行（"什么时候、成没成、动了什么"），失败时带原因 */
function runLine(run) {
  const rows = store.tailRunEvents(run.id, PROGRESS.scanEvents) ?? [];
  const events = rows
    .slice()
    .reverse()
    .map((r) => {
      try {
        return JSON.parse(r.evt);
      } catch {
        return null; // 坏行跳过，别为一条脏数据把整块弄挂
      }
    });
  const facts = factsOfRun(events);
  const parts = [shortTime(run.endedAt ?? run.startedAt), RUN_LABEL[run.status] ?? run.status];
  const dur = durationOf(run);
  if (dur) parts.push(dur);
  if (facts.files.length) parts.push(`改动 ${new Set(facts.files).size} 个文件`);
  if (facts.tools === 0) parts.push('没有工具动作');
  const why = readableError(run.error) || facts.errors.at(-1) || '';
  if (why && run.status !== 'done') parts.push(why);
  else if (facts.commands.length) parts.push(`最后命令 ${clip(facts.commands.at(-1), 60)}`);
  return { line: parts.join(' · '), facts };
}

/**
 * 「这段活干到哪了」注入块。**没有可说的就返回空串**（不印空壳）。
 *
 * @param {object} o
 * @param {string} o.conversationId  这段活在哪个会话里跑的
 * @param {string|null} [o.personaId] 只看这个人的轮次（给了但一条都没有时，退回整个会话）
 * @param {string|null} [o.root]      仓库根，用来把绝对路径压成相对路径
 * @returns {string}
 */
export function progressBlock({ conversationId, personaId = null, root = null } = {}) {
  if (!conversationId) return '';

  let card = null;
  try {
    card = store.getProjectTaskByConversation(conversationId);
  } catch { /* 老库没这张表也不影响交接 */ }

  /*
   * **按卡归集**（2026-11-22，缺口①的尾巴）：原来只按 conversationId 回溯 —— 卡被换会话
   * 派活（群协作卡换段 / 1:1 删了重开 / 卡改派）时，旧会话的轮次新会话看不到，"干到哪了"
   * 只剩最近一段。改法：**有卡就按卡把会话找齐**，没卡（纯聊天）退回按会话，行为不变。
   *
   * 卡的轮次可能散在三类会话里：
   *   ① 卡现在的 conversationId（群协作卡每派一次就跟着挪，见 project-tasks 的两条派活路径）；
   *   ② 工单会话（execScope = `task:<卡id>`）—— 看板派活 / 卡评论 / 流程步骤都落在这类会话，
   *      改派换人还会再开一条，按 scope 反查才找得全（store.listConversationsByExecScope）；
   *   ③ 群协作卡所在群的历史段（旧段的轮次）。
   * 已知边界（如实记，不硬凑）：聊天派活投影的卡，早期 1:1 里的轮次没有任何持久线索
   * （触发消息不带卡标记、runs.taskId 记的是流程 id），删了会话就真找不回 —— 那部分退回现状。
   */
  let cardConvIds = null; // null = 没卡：按会话回溯（原行为）
  if (card) {
    const ids = new Set();
    if (card.conversationId) ids.add(card.conversationId);
    try {
      for (const c of store.listConversationsByExecScope(`task:${card.id}`)) ids.add(c.id);
    } catch { /* 老库没有这个函数就少找一类，不挡交接 */ }
    if (card.assigneeGroupId) {
      try {
        for (const s of store.listGroupSessions(card.assigneeGroupId)) ids.add(s.id);
      } catch { /* 同上 */ }
    }
    cardConvIds = [...ids];
  }

  let all = [];
  try {
    const seen = new Set();
    all = (cardConvIds ?? [conversationId])
      .flatMap((cid) => store.listRuns(cid))
      .filter((r) => {
        if (r.status === 'running') return false;
        if (seen.has(r.id)) return false; // 同一条 run 理论上只属一条会话，防手滑重复计数
        seen.add(r.id);
        return true;
      });
    if (cardConvIds && cardConvIds.length > 1) {
      // 多条会话拼起来要重新按时间排，明细才真是"新的在上"
      all.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
    }
  } catch { /* 拿不到就只交接卡 */ }

  const mine = personaId ? all.filter((r) => r.personaId === personaId) : all;
  const rows = mine.length ? mine : all;
  if (!rows.length && !card) return '';
  // 只看自己的轮次时说"你"，退回整个会话时说"这个会话" —— 计数口径得跟人说的字对得上
  const scoped = Boolean(personaId && mine.length);

  const lines = [];

  if (card) {
    const bits = [`卡：${card.id}「${clip(card.title, 40)}」`, `现在「${STATUS_LABEL[card.status] ?? card.status}」`];
    const evidence = evidenceOf(card);
    if (evidence.verdict === 'strong') bits.push(evidence.why);
    else if (evidence.verdict === 'contra') bits.push(evidence.why);
    else if (evidence.verdict === 'pending') bits.push('CI 还在跑');
    lines.push(`- ${bits.join(' · ')}`);
  }

  if (rows.length) {
    const count = { done: 0, failed: 0, stopped: 0 };
    for (const r of rows) if (count[r.status] != null) count[r.status] += 1;
    // 有卡 = 轮次按卡归集（可能跨多条会话），口径就得跟着说"这张卡"；没卡才是"这个会话"
    const cross = cardConvIds && cardConvIds.length > 1 ? `（跨 ${cardConvIds.length} 段会话）` : '';
    const scopeNoun = card
      ? (scoped ? `你在这张卡上之前跑了 ${rows.length} 轮${cross}` : `这张卡跑了 ${rows.length} 轮${cross}`)
      : `${scoped ? '你在这之前跑了' : '这个会话跑了'} ${rows.length} 轮`;
    const summary = [`- ${scopeNoun}`, `完成 ${count.done}`, `失败 ${count.failed}`];
    if (count.stopped) summary.push(`被停 ${count.stopped}`);
    lines.push(summary.join('，'));

    const detail = rows.slice(0, PROGRESS.maxRuns);
    const fileSet = new Set();
    lines.push('- 最近几轮（新的在上）：');
    for (const run of detail) {
      const { line, facts } = runLine(run);
      // 别人干的要标出是谁 —— 换个人接手时，"谁改的"和"改了什么"一样重要
      const who = !personaId || run.personaId === personaId ? '' : `${run.personaName ?? '别人'} · `;
      lines.push(`  - ${who}${line}`);
      for (const f of facts.files) fileSet.add(clip(relPath(f, root), 80));
    }
    /*
     * **反复失败的原因按次数排**：明细只列最近 3 轮，但"一共失败了 5 次、其中 4 次是同一个原因"
     * 才是新会话最该知道的事 —— 同一个坑再踩一次，比什么都不交接更浪费。
     * 只读 `runs.error` 这一列，不再翻事件流（次数统计不需要过程）。
     */
    const reasons = new Map();
    for (const r of rows) {
      if (r.status === 'done' || r.status === 'running') continue;
      const why = readableError(r.error);
      if (why) reasons.set(why, (reasons.get(why) ?? 0) + 1);
    }
    if (reasons.size) {
      const top = [...reasons.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([why, n]) => `${why} ×${n}`)
        .join('、');
      lines.push(`- 没成的原因（按次数）：${top}`);
    }

    if (fileSet.size) {
      const shown = [...fileSet].slice(0, PROGRESS.maxFiles);
      const more = fileSet.size > shown.length ? ` 等 ${fileSet.size} 个` : '';
      lines.push(`- 这几轮动过的文件：${shown.join('、')}${more}`);
    }
  }

  // 上次回话的落款：平台协议的声明值（不是猜的），并明说"声明 ≠ 已核对"
  try {
    const last = store.lastAssistantMessage(conversationId, personaId);
    if (last?.text) {
      const claim = claimOf(last.text);
      const label = {
        done: '写了 [完成]（那是当时的声明；到没到位，以本轮核对为准）',
        blocked: '写了 [受阻]（当时就说了干不下去，原因在聊天记录里）',
        unclaimed: '没写交付声明（说了话，但平台没认这一轮是交付）',
        silent: '没回话（这一轮一个字都没说）',
      }[claim];
      if (label) lines.push(`- 上一次回话的落款：${label}`);
    }
  } catch { /* 拿不到就不说 */ }

  if (!lines.length) return '';

  const body = lines.join('\n');
  const head =
    '【这段活干到哪了】平台从运行记录里抽的事实（不是谁回忆的）。接着干就行 —— ' +
    '下面列出的改动已经发生过，别当没做过再重来一遍；判断和下一步仍以本轮任务合同为准。';
  let block = `${head}\n${body}`;
  if (block.length > PROGRESS.maxChars) {
    // 超长按行截（截在行边界，别留半句话）；块头那句说明必须留着 —— 它是"这是什么"的唯一线索
    const kept = [];
    let size = head.length + 1;
    for (const line of body.split('\n')) {
      if (size + line.length + 1 > PROGRESS.maxChars - 20) break;
      kept.push(line);
      size += line.length + 1;
    }
    block = [head, ...kept, '…（更长的事实见运行记录）'].join('\n');
  }
  return block;
}
