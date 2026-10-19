/**
 * 动作：备份数据库（2026-10-17）。
 *
 * 这是**第二个动作**，存在的意义不只是"多个功能"：它证明调度核心跟具体动作无关 ——
 * 这个动作跟 GitHub、跟 PR、跟看板**一点关系都没有**（不读命令配置里的仓库、不写卡），
 * 只是在数据目录里放一份一致的快照。PR 巡检只是注册表里的一条，不是骨架。
 *
 * 用 `VACUUM INTO`（见 `store.backupTo`）：库开着 WAL，直接拷 `.db` 会漏掉还在 `-wal` 里的事务。
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.mjs';
import * as store from './store.mjs';

const KEEP_DEF = 14;
const NAME_RE = /^bandi-\d{8}-\d{6}\d{3}\.db$/;

/** 名字带毫秒：一秒内连跑两次（冒烟、手动点两下）也不会撞名，撞名了 VACUUM INTO 会直接报错 */
function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

export async function backupDb({ config = {} } = {}) {
  const keep = Math.min(90, Math.max(1, Math.round(Number(config.keep) || KEEP_DEF)));
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });

  const name = `bandi-${stamp()}.db`;
  const file = path.join(dir, name);
  store.backupTo(file);
  const size = fs.statSync(file).size;

  // 只留最近 keep 份。名字排序 = 时间排序（定长时间戳），不用读 mtime
  const all = fs.readdirSync(dir).filter((f) => NAME_RE.test(f)).sort();
  const drop = all.slice(0, Math.max(0, all.length - keep));
  for (const f of drop) fs.rmSync(path.join(dir, f), { force: true });

  const mb = (size / 1048576).toFixed(2);
  return { summary: `已备份 ${name}（${mb} MB），${dir} 现存 ${all.length - drop.length} 份` };
}
