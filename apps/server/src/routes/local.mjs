/* routes/local.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * 主分发顺序（先匹配先赢）见 ../server.mjs 的 CHAIN。 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendJson, fail, readBody, readRawBody } from '../http.mjs';
import { SERVER } from '../server-state.mjs';
import { port, host, dataDir, dbPath } from '../config.mjs';
import * as netmode from '../netmode.mjs';
import * as store from '../store.mjs';
import * as runtimes from '../runtimes.mjs';
import * as externals from '../externals.mjs';
import * as status from '../status.mjs';
import * as localMode from '../local-mode.mjs';
import * as discover from '../discover.mjs';

function isLoopbackRemote(address) {
  const a = String(address ?? '').trim().toLowerCase();
  if (!a) return false;
  if (a === '::1' || a === '127.0.0.1' || a === 'localhost') return true;
  if (a.startsWith('::ffff:127.')) return true; // IPv4-mapped（Node 在双栈 socket 上会这么报）
  return a.startsWith('127.');
}

/**
 * 节点守护进程（T03 的 `node-supervisor.mjs`）：起停与状态。
 *
 * 这个模块**还没落地**时返回 `null`，`/api/local/*` 照样能用（只是 `node.running:false`）——
 * 不让"少一个文件"变成整个本机接口 500。
 */
async function supervisorModule() {
  try {
    return await import('./node-supervisor.mjs');
  } catch {
    return null;
  }
}

/** 节点进程现在在不在跑（`external:true` = 是 autostart 拉起的那个，不是我们起的） */
async function localNodeStatus() {
  const sup = await supervisorModule();
  if (!sup) return { running: false, pid: null, external: false };
  try {
    return sup.status();
  } catch (e) {
    return { running: false, pid: null, external: false, why: String(e?.message ?? e) };
  }
}

/**
 * 这台机器上探到的 agent CLI（加入时随 body 报给总机）。
 *
 * 为什么在 server 侧算：`local-mode.mjs` **不许 import runtimes.mjs**（后者 import store，
 * 节点进程会因此去打开控制面库）。本函数与 `node.mjs` 的 `declared()` 同源、同形状。
 */
function localDeclared() {
  const out = [];
  for (const fam of runtimes.detectAll()) {
    const best = fam.candidates?.[0];
    if (!best) continue;
    out.push({ family: fam.id, label: fam.label, path: best.path, usable: !!best.usable });
  }
  return out;
}

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

/**
 * 「另一个数据目录里也有节点常驻」这条**预警**（设计 §14 第 1 条，产品已确认只提示不处理）。
 *
 * 由来：`autostart` 装的节点用 `%APPDATA%\bandi-node`，而瘦客户端的 `config.json` 在
 * `%APPDATA%\bandi` —— 两个 `node.json` 不同 → 总机上会出现**两台设备**，单实例锁也管不到
 * （不同目录，锁是每数据目录一把）。本次处置：**不迁移、不自动卸载**，只说一声。
 */
function siblingDataDir() {
  const guess =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'bandi-node')
      : path.join(path.dirname(dataDir), 'bandi-node');
  return path.resolve(guess) === path.resolve(dataDir) ? null : guess;
}

function localWarnings() {
  const out = [];
  const mine = String(localMode.readClientConfig().controlPlane ?? '').trim();
  const sibling = siblingDataDir();
  if (!mine || !sibling) return out;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(sibling, 'config.json'), 'utf8'));
    const other = String(j?.controlPlane ?? '').trim();
    if (other && other === mine) {
      out.push(
        `另一个数据目录（${sibling}）里也有一个节点常驻，它会让总机上多出一台设备。` +
          '清理：node apps/server/src/autostart.mjs remove node',
      );
    }
  } catch {
    /* 没那个目录 / 没那个文件 / 坏了 —— 都不算问题 */
  }
  return out;
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
 * 为什么由本机处理：它读写的是**本机**的事实（`config.json`、本机库），总机那边没有这些；
 * 加入/退出两个入口也在它里面（client 形态已随反代移除，本机接口永远是本机答）。
 *
 * 七条：`GET status`、`POST discover / probe / join / leave / export / import`。
 * **每条之前先判回环**（P0-8）—— 见 `isLoopbackRemote` 那段。
 */
export async function handleLocal(req, res, url) {
  if (!url.pathname.startsWith('/api/local/')) return false;

  if (!isLoopbackRemote(req.socket?.remoteAddress)) {
    fail(res, 403, 'E1094', '本机专属接口只能在回环上调用（远程机器不能让你加入它的总机）');
    return true;
  }

  try {
    /* ---------------------------------------------------------------- 本机身份的唯一读数 */
    if (req.method === 'GET' && url.pathname === '/api/local/status') {
      const st = localMode.status();
      st.client.node = await localNodeStatus(); // 真实状态（未加入时永远是"没在跑"）
      st.local = localDataInfo();
      st.warnings = localWarnings();
      return sendJson(res, 200, st), true;
    }

    /* ------------------------------------------------------------------------ 扫局域网 */
    if (req.method === 'POST' && url.pathname === '/api/local/discover') {
      const body = await readBody(req);
      // 空数组不是错误 —— PRD 步骤 3 的兜底页就是它；最多 4 秒返回
      const candidates = await discover.discover({ rounds: body?.rounds, port: body?.port });
      return sendJson(res, 200, { candidates }), true;
    }

    /* ---------------------------------------------------------------------- 探一个地址 */
    if (req.method === 'POST' && url.pathname === '/api/local/probe') {
      const body = await readBody(req);
      const host = await localMode.probe(body?.url); // 失败抛 LocalError（E1090/E1091/E1092/E2050）
      return sendJson(res, 200, { host }), true;
    }

    /* ------------------------------------------- 主机列表（2026-10-21 增量：列表模型）
     * add = 填了就入列（不拦探测；行上的「测试」负责验连接，2026-10-21 用户定）；
     * test = 探一次，在列的顺带刷新该行；remove = 从通讯录移除。
     * 三条都在上面那道回环闸（E1094）之后，局域网里任何人改不了这台机器的通讯录。 */
    if (req.method === 'POST' && url.pathname === '/api/local/hosts/add') {
      const body = await readBody(req);
      return sendJson(res, 201, await localMode.addHost(body?.url)), true;
    }
    if (req.method === 'POST' && url.pathname === '/api/local/hosts/test') {
      const body = await readBody(req);
      return sendJson(res, 200, await localMode.testHost(body?.url)), true;
    }
    if (req.method === 'POST' && url.pathname === '/api/local/hosts/remove') {
      const body = await readBody(req);
      return sendJson(res, 200, localMode.removeHost(body?.url)), true;
    }

    /* -------------------------------------------------------------------------- 加入 */
    if (req.method === 'POST' && url.pathname === '/api/local/join') {
      const body = await readBody(req);
      /*
       * 2026-10-21 拍板：**节点一律只当算力** —— 不信任前端的 scope，写死 compute。
       * 总机侧的 scope 机制保留（存量令牌、设备详情还认它），但「加入」这条路不再产生 panel 令牌；
       * 反代已整体移除，节点机的界面就是本地那份节点状态页。
       */
      const scopes = 'compute';
      /*
       * 顺序即设计 §5.5：已加入 → E1093；探地址（复用它那四个失败码）；换令牌；
       * 写 `config.json`（写不进去 = 500 E1097，**此时还没动任何既有状态**）。
       */
      const joined = await localMode.join({
        url: body?.url,
        code: body?.code,
        scopes,
        runtimes: localDeclared(),
        externals: await externals.declared(),
      });

      /*
       * 第 6 步：**只有含 `compute` 才起节点**（写死 compute 后恒真；保留判据是防
       * 旧配置里存过 panel-only 的 scope —— 那种机器不接活，不该被拉起节点）。
       * spawn 失败**不回滚**：加入本身已经成功了（令牌拿到了、配置写好了），
       * 返回 201 + `node:{running:false, why}`，节点下次会自己起。
       */
      let node = { running: false, pid: null, external: false };
      if (joined.scope.includes(store.SCOPE_COMPUTE)) {
        const sup = await supervisorModule();
        if (sup) {
          try {
            node = sup.start();
          } catch (e) {
            node = { running: false, pid: null, external: false, why: String(e?.message ?? e) };
          }
        } else {
          node = { running: false, pid: null, external: false, why: '节点守护还没接上：配置已写，节点不会自己起' };
        }
      }

      /*
       * 2026-10-21 修（三态互斥的两个漏，用户实报）：
       *   ① 清掉 allowLan —— 加入 = 放弃本机总机角色。不清的话，退出总机后机器会落到
       *      「总机（等重启）」，而不是回单机。
       *   ② 把监听收回环 —— 之前是总机的话现在听着 0.0.0.0，加入后到下次重启前一直敞着，
       *      和"已加入必须只听回环"（SERVER.restart 里那条）直接矛盾。
       * 先回响应再动监听：同 `/api/lan` 的写法，否则浏览器拿不到这个 201。
       */
      try {
        netmode.writeNetMode(false);
      } catch (e) {
        console.warn(`[本机] 加入后清 allowLan 失败：${e?.message ?? e}`);
      }
      console.log(`[本机] 加入了「${joined.hostLabel}」（${joined.controlPlane}）· 只当算力（${joined.scope.join('+')}）`);
      sendJson(res, 201, {
        ok: true,
        hostLabel: joined.hostLabel,
        hostHostname: joined.hostHostname,
        controlPlane: joined.controlPlane,
        scope: joined.scope,
        node,
      });
      setTimeout(SERVER.restart, 80); // 让 201 先发出去，再把监听收回环
      return true;
    }

    /* ---------------------------------------------------------------------- 退出总机 */
    if (req.method === 'POST' && url.pathname === '/api/local/leave') {
      if (!localMode.isJoined()) {
        return fail(res, 400, 'E1098', '这台机器还没加入任何总机'), true;
      }
      /*
       * **先停节点，再清配置**（顺序不能反）：反过来的话，那个还活着的节点进程会拿着
       * 刚被清掉的令牌再请求一次（401 `E4012`），日志里就是一堆看不懂的红字。
       */
      let killed = false;
      let note = null;
      let autoRemoved = false;
      const sup = await supervisorModule();
      if (sup) {
        try {
          const r = sup.stop();
          killed = !!(r && (r.killed ?? r.stopped ?? r.ok));
          if (r?.external && r?.stopped === false) {
            /*
             * 2026-10-21 修：开机自启拉起的节点原来只留一句提示 —— 界面照样说"退出成功"，
             * 节点却拿着刚清掉的令牌空转（用户实报）。「退出总机」就是不再当节点，
             * 所以这里**连自启一起收掉**：
             *   · 先移除自启登记（Linux 那套 systemd remove 会顺手 --now 停掉）；
             *   · 再按锁里的 PID 停进程（Windows 的 remove 只删启动脚本，不停进程）。
             */
            try {
              const auto = await import('./autostart.mjs');
              auto.remove('node');
              autoRemoved = true;
            } catch (e) {
              note = `开机自启没移除成功：${e?.message ?? e}（手动：node apps/server/src/autostart.mjs remove node）`;
            }
            try {
              const r2 = sup.stopExternal?.();
              if (r2?.stopped) killed = true;
              else if (r2?.mismatch) note = (note ? note + '；' : '') + '锁里的进程不是节点，没动它';
              else if (r2?.running && !note) note = '节点进程没停掉；下次开机不会再自启';
            } catch (e) {
              note = (note ? note + '；' : '') + `停自启节点出错：${e?.message ?? e}`;
            }
          }
        } catch (e) {
          console.warn(`[本机] 停节点时出错（继续退出总机）：${e?.message ?? e}`);
        }
      }
      const out = localMode.leave(); // 只清 config.json 里那七个字段，node.json 保留
      /*
       * 退出后**一定回单机**（2026-10-21）：不清 allowLan 的话，之前开过总机的机器会落到
       * 「总机（等重启）」—— 与「退出总机，回到本机」的文案和"三态互斥"都不符。
       */
      try {
        netmode.writeNetMode(false);
      } catch (e) {
        console.warn(`[本机] 退出后清 allowLan 失败：${e?.message ?? e}`);
      }
      console.log('[本机] 已退出总机 —— 本机数据原样（从来没被写过）');
      return sendJson(res, 200, { ok: true, killed, autoRemoved, note, local: localDataInfo(), nodeId: out.nodeId }), true;
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

