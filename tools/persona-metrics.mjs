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

/* ---------------------------------------------------------------- 回话 */
const msgs = all("SELECT text, personaId FROM messages WHERE role = 'assistant'");
const lens = msgs.map((m) => String(m.text ?? '').length).sort((a, b) => a - b);
const at = (q) => (lens.length ? lens[Math.min(lens.length - 1, Math.floor(q * (lens.length - 1)))] : 0);
const classify = (t) => {
  const first = String(t ?? '').trim().split('\n').find((l) => l.trim()) ?? '';
  const judgment = /结论|完成|做完|没做完|卡在|需要你拍板|建议/.test(first);
  return { firstLen: first.length, judgment, next: /Next:/i.test(String(t ?? '')) };
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
console.log(`  出现 Next: ${r.nextRate} 条（${pct(r.nextRate, r.total)}%）`);

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
console.log('\n（基线参考：2026-11-09 检修前 · 回话均 260 字、>500 字 10.5%、Next: 31.5%、失败 40/174）');
db.close();
