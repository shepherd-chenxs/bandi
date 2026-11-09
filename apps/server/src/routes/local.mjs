/* routes/local.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * **不在 routes/chain.mjs 上**：/api/local/* 判的是"本机身份"，排在认证之后、
 * 正则链之前单独判一次（见 server.mjs 的 handleLocal）。登记仍在 route-policy 里。 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sendJson, fail, readBody, readRawBody } from '../http.mjs';
import { dataDir, dbPath } from '../config.mjs';
import * as store from '../store.mjs';
import * as externals from '../externals.mjs';
import * as localMode from '../local-mode.mjs';
// 本机接口的**接口级授权**（2026-10-31 IAM §8.5 / 姊妹文档 v5）：声明式、默认拒绝
import { authorizeLocal } from '../security/local-policy.mjs';
import * as localSecret from '../security/local-secret.mjs';
import { sourceOf } from '../security/source.mjs';

/*
 * 这里原来有一个 `isLoopbackRemote(req.socket.remoteAddress)` —— **已删除**。
 * 它既不看角色也不分动作，而且在反代后面（peer 全是 127.0.0.1）等于没判。
 * 来源判定现在只有一处：`security/source.mjs` 的 `classifySource()`（guard 已经把结果挂在
 * `req.bandiSource` 上，`sourceOf(req)` 直接读它，不重算）。
 */

/** 本机库的"路径 / 大小 / 最后修改 / 各有几条"（PRD P0-5：设置页常显这些东西） */
function localDataInfo() {
  let dbSize = null;
  let dbMtime = null;
  try {
    const st = fs.statSync(dbPath);
    dbSize = st.size;
    dbMtime = st.mtime.toISOString();
  } catch {
    /* 库还没建（理论上不可能，store 一 import 就建） */
  }
  return {
    dataDir,
    dbPath,
    dbSize,
    dbMtime,
    counts: {
      personas: store.listPersonas().length,
      // 「不显示」的会话也是本机数据，一起算 —— 不然用户会觉得"我的会话少了几段"
      conversations: store.listConversations().length + store.listHiddenConversations().length,
      projects: store.listProjects().length,
    },
  };
}

/** 导出落点的三级兜底：桌面 → 下载 → `<数据目录>/exports/`（逐级看是否真存在） */
function exportDirs() {
  const home = os.homedir();
  return [path.join(home, 'Desktop'), path.join(home, 'Downloads'), path.join(dataDir, 'exports')];
}

/**
 * 挑一个能写的落点。
 *
 * ⚠️ **不弹目录选择框**（设计 §14 第 3 条，产品已确认）：`<input type=file>` 只能选目录、
 * 不可写，实际还得让用户自己拷 —— 那就等于没做成。落点找不到桌面时退到下载目录，
 * 再不行退到数据目录下，**把完整路径用 toast 说出来**（前端拿 `file` 字段）。
 */
function pickExportDir(want) {
  const list = exportDirs();
  const fallback = list[list.length - 1];
  if (want) {
    // 只允许显式指到桌面/下载（以及那个兜底目录）—— 别让接口变成"往任意路径写文件"
    const w = path.resolve(String(want));
    const hit = list.find((d) => path.resolve(d) === w);
    if (hit) {
      fs.mkdirSync(hit, { recursive: true });
      return hit;
    }
  }
  for (const d of list) {
    try {
      if (fs.statSync(d).isDirectory()) return d;
    } catch {
      /* 这个平台没有这个目录，看下一个 */
    }
  }
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

/** 导出文件名里的时间戳（照 `db-backup.mjs` 的写法，带毫秒 —— `VACUUM INTO` 撞名会直接报错） */
function exportStamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

/**
 * 校验一份待导入的 .db 快照（2026-10-22 数据管理）。返回 null = 可导入，否则给一句人话。
 * 三道：① SQLite 文件头；② `PRAGMA integrity_check`（真开一遍库，比看头严格得多）；
 * ③ 班底的表在不在（personas / conversations）—— 拿别的 SQLite 文件来导也过不了这关。
 * 校验在**临时文件**上做，不碰现库也不碰待导入文件本体。
 */
function validateSnapshot(buf) {
  if (!buf || buf.length < 4096) return '文件太小，不像班底的库快照';
  if (buf.subarray(0, 16).toString('latin1') !== 'SQLite format 3\x00') return '不是 SQLite 数据库文件';
  const tmp = `${dbPath}.check-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, buf);
    const probe = new DatabaseSync(tmp);
    try {
      const row = probe.prepare('PRAGMA integrity_check').get();
      if (row?.integrity_check !== 'ok') return `库文件已损坏（${row?.integrity_check ?? 'unknown'}）`;
      const tables = new Set(
        probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
      );
      for (const t of ['personas', 'conversations']) {
        if (!tables.has(t)) return '不是班底的库快照（没有班底的表）';
      }
    } finally {
      probe.close();
    }
  } catch (e) {
    return `打不开这个库（${e?.message ?? e}）`;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 删不掉临时文件不算错 */ }
  }
  return null;
}

/**
 * `/api/local/*` —— **这台机器自己**的接口（2026-10-20，设计 §5.1-§5.7）。
 *
 * 多机节点子系统（probe / hosts 通讯录 / join / leave）已于 2026-11-09 整体删除。
 * 剩下：`GET status`、`GET externals`、`GET backups`、`POST export / import`。
 * **准入统一走 `security/local-policy.mjs`**（2026-10-31 起）：原来那句
 * `if (!isLoopbackRemote(...)) E1094` 既不分身份也不分动作，反代下还形同虚设。
 */
export async function handleLocal(req, res, url) {
  if (!url.pathname.startsWith('/api/local/')) return false;

  /*
   * **接口准入**（唯一一处，2026-10-31）：策略表在 `security/local-policy.mjs`，
   * 判定顺序是「登记 → 身份 → 位置/秘密」，三条失败码各说一件事：
   *   E4090 未登记（404，代码问题） / E4091 身份不够（403） / E4097 缺 X-Bandi-Local（403）。
   * handler 里不再各写各的回环判断 —— 要放开某一行就改表 + 补用例，不动这里。
   */
  const verdict = authorizeLocal({
    method: req.method,
    pathname: url.pathname,
    source: sourceOf(req),
    principal: req.bandiAuth ?? null,
    hasSecret: localSecret.check(req),
  });
  if (!verdict.allow) {
    fail(res, verdict.status, verdict.code, verdict.message, verdict.hint ? { hint: verdict.hint } : null);
    return true;
  }

  try {
    /* ---------------------------------------------------------------- 本机身份的唯一读数 */
    if (req.method === 'GET' && url.pathname === '/api/local/status') {
      return sendJson(res, 200, {
        instanceId: localMode.instanceId(),
        local: localDataInfo(),
      }), true;
    }

    /* ------------------------------------------- 外部件（2026-11-04：插件页「软件」商店条目）
     * catalog = 界面要画的清单（含装法说明与官方下载口），probed = 这台机器的**现状**
     * （装没装、网关/面板通不通）。只读 —— 安装不在这里排：走 /api/install/tasks
     * 那条既有通路，命令仍只出自 externals 那张表（边界不变）。
     * tasks（2026-11-04 用户："点击之后显示安装状态"）＝ 每个软件**最近一次**装/起任务。
     * 进度只活在浏览器轮询里、一刷新就没 —— 这坑 2026-10-16 在运行时那侧踩过一次
     * （见 runtime-view.withExternals 的注释），这次同一原则：状态在服务端，刷新照旧。 */
    if (req.method === 'GET' && url.pathname === '/api/local/externals') {
      const tasks = {};
      for (const t of store.listNodeTasks('local', 20)) {
        if (t.kind !== 'external-install' && t.kind !== 'external-serve' && t.kind !== 'external-open') continue;
        if (!tasks[t.family]) tasks[t.family] = store.publicNodeTask(t); // listNodeTasks 新的在前
      }
      return sendJson(res, 200, {
        /* `withPanelUrls`：面板起着时把那串**带密钥**的链接补上（问 `magpie daemon web` 要，
           缓存 10 分钟）。2026-11-04 thinkpad 实测：本机这条路原来拿的是"按局域网地址猜的"
           那条，点开 401 —— 节点那边一直是对的，只有本机忘了走同一套。 */
        externals: await externals.withPanelUrls(await externals.declared()),
        catalog: externals.publicExternals(`${process.platform} ${process.arch}`),
        tasks,
      }), true;
    }

    /* ------------------------------------------------------------------------ 导出 */
    /* ------------------------------------------------------ 备份快照列表（只读，2026-10-22）
     * backups/ 里有两路人在写文件，页面上却一直看不见 —— 这里只列不改：
     *   · 定时备份（schedules → db-backup.backupDb）：`bandi-<时间戳>.db`
     *   · 导入换库时的自动备份（store.mjs）：`导入前-<时间戳>.db`（三件套里只列 .db 本体）
     * 手动「导出」写的是用户自选目录，不在这里，列它没有意义。 */
    if (req.method === 'GET' && url.pathname === '/api/local/backups') {
      const dir = path.join(dataDir, 'backups');
      let files = [];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).map((f) => {
          const s = fs.statSync(path.join(dir, f));
          return {
            name: f,
            size: s.size,
            mtime: s.mtimeMs,
            src: f.startsWith('导入前-') ? 'import' : /^bandi-\d{8}-\d{6}\d{3}\.db$/.test(f) ? 'scheduled' : 'other',
          };
        });
      } catch { /* 目录不存在 = 还没备份过，空列表即可，不是错 */ }
      files.sort((a, b) => b.mtime - a.mtime);
      return sendJson(res, 200, { dir, files }), true;
    }

    if (req.method === 'POST' && url.pathname === '/api/local/export') {
      const body = await readBody(req);
      let file;
      try {
        const dir = pickExportDir(body?.dir);
        file = path.join(dir, `bandi-备份-${exportStamp()}.db`);
        store.backupTo(file); // VACUUM INTO：库开着 WAL，直接拷 .db 会漏事务
      } catch (e) {
        return fail(res, 500, 'E1096', `导出失败：写不进那个目录（${e?.message ?? e}）`), true;
      }
      const size = fs.statSync(file).size;
      console.log(`[本机] 导出一份：${file}（${(size / 1048576).toFixed(2)} MB）`);
      return sendJson(res, 200, { file, size }), true;
    }

    /* ------------------------------------------------------------------------ 导入 */
    /*
     * 导入 = 拿一份班底导出的 .db 快照**覆盖本机数据**（2026-10-22 数据管理）。
     * 分两步走，接口只做第一步：
     *   ① 这里：校验（SQLite 头 / integrity_check / 班底的表在不在）→ 把快照写成
     *      `<dbPath>.importing`。当前库**一个字节都不动**，导出照常可用；
     *   ② 换库在 store.mjs 模块加载（下一次启动、连接打开之前）—— 那时零并发风险，
     *      现库三件套自动改名进 backups/导入前-<时间戳>.*，坏了可以整体搬回来。
     * 所以响应里必须把"重启后生效"说明白，前端 toast 也这么说。
     */
    if (req.method === 'POST' && url.pathname === '/api/local/import') {
      const buf = await readRawBody(req);
      const err = validateSnapshot(buf);
      if (err) return fail(res, 400, 'E1099', `导入没成功：${err}`), true;
      fs.writeFileSync(`${dbPath}.importing`, buf);
      console.log(`[本机] 收到导入快照（${(buf.length / 1048576).toFixed(2)} MB），重启后生效`);
      return sendJson(res, 200, { ok: true, size: buf.length, note: '重启班底后生效' }), true;
    }
  } catch (err) {
    if (err instanceof localMode.LocalError) {
      fail(res, err.status, err.code, err.message, err.detail ? { detail: String(err.detail) } : null);
      return true;
    }
    throw err; // 其余交给顶层 catch（500 E5004）
  }

  fail(res, 404, 'E2036', '没有这个本机接口');
  return true;
}

