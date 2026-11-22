#!/usr/bin/env node
/**
 * persona-metrics.mjs —— 数字员工汇报体检（2026-11-09 身份/职责检修 P1 的验收工具）。
 *
 * 为什么要有：检修前只有"感觉不好用"，没有可比的数。这个脚本从本机库里量出几条
 * **能反映"给雇主的简报好不好用"**的指标，检修前后各跑一次就能判断有没有变好：
 *   · 回话长度：均值 / P50 / P90 / 最长，>500 字与 >1000 字占比；
 *   · 结论先行：首行 ≤80 字、首行出现"结论/完成/卡在/拍板"等判断词的比例；
 *   · 收尾纪律：整条出现 `Next:` 的比例；
 *   · 失败率：按员工分的运行失败占比（身份/流程冲突的侧写）。
 *
 * 只读：打开库后只执行 SELECT，不写任何数据。库路径同服务端（BANDI_DB / 默认用户数据目录）。
 *
 * 跑法：
 *   node tools/persona-metrics.mjs           # 人读的表格
 *   node tools/persona-metrics.mjs --json    # 给脚本/趋势记录用
 */
import { DatabaseSync } from 'node:sqlite';
import { dbPath } from '../apps/server/src/config.mjs';

const asJson = process.argv.includes('--json');

let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
  db.prepare('SELECT 1 FROM messages LIMIT 1').get();
} catch (e) {
  console.error(`打不开库（${dbPath}）：${e?.message ?? e}`);
  console.error('提示：看本机数据目录（bandi status / %APPDATA%\\bandi），或用 BANDI_DB 指定。');
  process.exit(1);
}

const all = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);

const rounds = (x, d = 1) => (x == null ? 0 : Number(Number(x).toFixed(d)));
const pct = (n, total) => (total ? rounds((n / total) * 100) : 0);
/** 表在不在：新增的表可能还没被哪次启动补上（这里是只读脚本，不能自己去建表） */
const hasTable = (name) => !!one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name);
/** 判据核对是"最近的账"：30 天窗口够看趋势，又不会被陈年记录淹没 */
const SINCE_30D = new Date(Date.now() - 30 * 86400_000).toISOString();

/* ---------------------------------------------------------------- 回话 */
const msgs = all("SELECT text, personaId FROM messages WHERE role = 'assistant'");
const lens = msgs.map((m) => String(m.text ?? '').length).sort((a, b) => a - b);
const at = (q) => (lens.length ? lens[Math.min(lens.length - 1, Math.floor(q * (lens.length - 1)))] : 0);
const classify = (t) => {
  const s = String(t ?? '');
  const first = s.trim().split('\n').find((l) => l.trim()) ?? '';
  const judgment = /结论|完成|做完|没做完|卡在|需要你拍板|建议/.test(first);
  /*
   * 「正文里贴命令/代码块」的粗判（P2 计划里的"先统计再定阈值"）：代码围栏，或行首像命令。
   * 不是在抓违规——回话本身也可能是贴代码的教学内容；用它看趋势，决定要不要硬判。
   */
  const pasted = /```|(^|\n)\s*(?:[$#>]\s|node\s|npm\s|git\s|SELECT\s|curl\s|cd\s|dir\s|powershell\s|Get-ChildItem\s)/i.test(s);
  return { firstLen: first.length, judgment, next: /Next:/i.test(s), pasted };
};
const classes = msgs.map((m) => classify(m.text));

const summary = {
  generatedAt: new Date().toISOString(),
  dbPath,
  replies: {
    total: lens.length,
    avg: rounds(lens.reduce((a, b) => a + b, 0) / (lens.length || 1)),
    p50: at(0.5),
    p90: at(0.9),
    max: lens[lens.length - 1] ?? 0,
    over500: lens.filter((n) => n > 500).length,
    over1000: lens.filter((n) => n > 1000).length,
    firstLineShort: classes.filter((c) => c.firstLen <= 80).length,
    conclusionFirst: classes.filter((c) => c.judgment).length,
    nextRate: classes.filter((c) => c.next).length,
    pasted: classes.filter((c) => c.pasted).length,
  },
  byPersona: all(
    `SELECT COALESCE(p.name, '(未知)') AS who, COUNT(*) AS n,
            ROUND(AVG(length(m.text))) AS avg, MAX(length(m.text)) AS max,
            SUM(CASE WHEN length(m.text) > 500 THEN 1 ELSE 0 END) AS over500
       FROM messages m LEFT JOIN personas p ON p.id = m.personaId
      WHERE m.role = 'assistant' GROUP BY who ORDER BY n DESC`,
  ),
  runs: {
    total: one('SELECT COUNT(*) AS n FROM runs').n,
    failed: one("SELECT COUNT(*) AS n FROM runs WHERE status = '失败'").n,
    byPersona: all(
      `SELECT COALESCE(p.name, '(未知)') AS who, COUNT(*) AS n,
              SUM(CASE WHEN r.status = '失败' THEN 1 ELSE 0 END) AS fail,
              SUM(CASE WHEN r.status = '完成' THEN 1 ELSE 0 END) AS ok
         FROM runs r LEFT JOIN personas p ON p.id = r.personaId GROUP BY who ORDER BY n DESC`,
    ),
  },
  /*
   * 判据核对（2026-11-22，缺口②的可比数）：**判据只在有人声称完成时核**，所以它量的不是
   * "干得好不好"，而是"声称完成时动作到位没有"—— 这正是 persona 汇报指标（字数/首行/Next:，
   * 全是文风）量不到的那一半。判据未过 = 一轮声称完成的 run 里动作没发生（进信箱那些）。
   * 从 notices 的 dedupeKey（'criteria:<runId>'）数，不重算事件：一张账只有一处写。
   */
  criteria: {
    total: one("SELECT COUNT(*) AS n FROM notices WHERE dedupeKey LIKE 'criteria:%'").n,
    last30: one("SELECT COUNT(*) AS n FROM notices WHERE dedupeKey LIKE 'criteria:%' AND createdAt >= ?", SINCE_30D).n,
    unread: one("SELECT COUNT(*) AS n FROM notices WHERE dedupeKey LIKE 'criteria:%' AND readAt IS NULL").n,
    byPersona: all(
      `SELECT COALESCE(p.name, '(未知)') AS who, COUNT(*) AS n
         FROM notices nt LEFT JOIN personas p ON p.id = nt.personaId
        WHERE nt.dedupeKey LIKE 'criteria:%' GROUP BY who ORDER BY n DESC`,
    ),
  },
  /*
   * 经验簿（2026-11-22，缺口①的可比数）。它量的不是"记了多少字"，而是**跨会话的积累有没有发生**：
   *   · 坑：平台核出来的错，反复犯会合并成一条（hits 涨）—— 所以"坑的条数不涨、hits 在涨"
   *     说明提醒没起作用；"条数也在涨"说明在犯新类型的错。这两种读法完全不同。
   *   · 口径：只能人给（接口/CLI）。一直是 0 = 这条链路没人用，不是"没问题"。
   */
  experience: hasTable('persona_notes')
    ? {
        total: one('SELECT COUNT(*) AS n FROM persona_notes').n,
        repo: one("SELECT COUNT(*) AS n FROM persona_notes WHERE kind = 'repo'").n,
        pitfall: one("SELECT COUNT(*) AS n FROM persona_notes WHERE kind = 'pitfall'").n,
        people: one('SELECT COUNT(DISTINCT personaId) AS n FROM persona_notes').n,
        byPersona: all(
          `SELECT COALESCE(p.name, '(未知)') AS who,
                  SUM(CASE WHEN n.kind = 'repo' THEN 1 ELSE 0 END) AS repo,
                  SUM(CASE WHEN n.kind = 'pitfall' THEN 1 ELSE 0 END) AS pit,
                  SUM(n.hits) AS hits
             FROM persona_notes n LEFT JOIN personas p ON p.id = n.personaId
            GROUP BY who ORDER BY pit DESC, repo DESC`,
        ),
        top: all(
          `SELECT COALESCE(p.name, '(未知)') AS who, n.kind, n.text, n.hits
             FROM persona_notes n LEFT JOIN personas p ON p.id = n.personaId
            ORDER BY n.hits DESC, n.updatedAt DESC LIMIT 5`,
        ),
      }
    : { total: 0, repo: 0, pitfall: 0, people: 0, byPersona: [], top: [], missing: true },
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
  db.close();
  process.exit(0);
}

const r = summary.replies;
console.log(`数字员工汇报体检 · ${summary.generatedAt.slice(0, 16).replace('T', ' ')}`);
console.log(`库：${dbPath}`);
console.log(`\n回话 ${r.total} 条：均值 ${r.avg} 字 · P50 ${r.p50} · P90 ${r.p90} · 最长 ${r.max}`);
console.log(`  >500 字 ${r.over500} 条（${pct(r.over500, r.total)}%）· >1000 字 ${r.over1000} 条（${pct(r.over1000, r.total)}%）`);
console.log(`  首行 ≤80 字 ${r.firstLineShort} 条（${pct(r.firstLineShort, r.total)}%）· 首行是判断（结论/完成/卡在/拍板）${r.conclusionFirst} 条（${pct(r.conclusionFirst, r.total)}%）`);
console.log(`  出现 Next: ${r.nextRate} 条（${pct(r.nextRate, r.total)}%）· 正文像贴命令/代码块 ${r.pasted} 条（${pct(r.pasted, r.total)}%）`);

console.log('\n按员工：');
for (const p of summary.byPersona) {
  console.log(`  ${p.who}\t${p.n} 条\t均 ${p.avg} 字\t最长 ${p.max}\t>500 字 ${p.over500} 条`);
}

const runs = summary.runs;
console.log(`\n运行 ${runs.total} 次 · 失败 ${runs.failed} 次（${pct(runs.failed, runs.total)}%）`);
for (const p of runs.byPersona) {
  if (!p.fail && !p.ok) continue;
  console.log(`  ${p.who}\t总 ${p.n}\t完成 ${p.ok}\t失败 ${p.fail}${p.n ? `（${pct(p.fail, p.n)}%）` : ''}`);
}

/*
 * 判据核对：**这里才是"专业度"的可比数**。上面那些（字数 / 首行 / Next:）量的是汇报文风，
 * 判据量的是"声称完成时，这个岗位要求跑的那件事到底跑了没有"。
 */
const crit = summary.criteria;
console.log(`\n判据核对（按工具事件判，不看回话怎么写）：未过 ${crit.total} 轮 · 近 30 天 ${crit.last30} 轮 · 未读 ${crit.unread}`);
if (!crit.total) {
  console.log('  （还没有记录：判据只在有人声称完成时核；没声称过完成就没有账）');
} else {
  for (const p of crit.byPersona) console.log(`  ${p.who}\t未过 ${p.n} 轮`);
}

/*
 * 经验簿：跨会话的积累有没有真的发生。读法见上面 summary 里的注释 ——
 * 「坑的条数不涨、hits 在涨」= 提醒没拦住；「口径一直是 0」= 这条链路没人用。
 */
const xp = summary.experience;
console.log(`\n经验簿：${xp.total} 条（口径 ${xp.repo} · 坑 ${xp.pitfall}）· ${xp.people} 人有过记录`);
if (xp.missing) {
  console.log('  （库里还没这张表：启动过一次服务就会自动补上）');
} else if (!xp.total) {
  console.log('  （空的：口径要人给（bandi note add），坑要平台核出来 —— 没声称过完成就没有坑）');
} else {
  for (const p of xp.byPersona) console.log(`  ${p.who}\t口径 ${p.repo ?? 0} · 坑 ${p.pit ?? 0}\t累计被核出 ${p.hits ?? 0} 次`);
  if (xp.top.length) {
    console.log('  最常犯的：');
    for (const t of xp.top) console.log(`    ${t.who}\t×${t.hits}\t${String(t.text ?? '').slice(0, 60)}`);
  }
}
console.log('\n（基线参考：2026-11-09 检修前 · 回话均 260 字、>500 字 10.5%、Next: 31.5%、失败 40/174）');
db.close();
