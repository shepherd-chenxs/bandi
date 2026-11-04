/**
 * 「识别本机运行时」的验收（2026-11-04）。
 *
 * 背景（用户实报）：bandi 界面把**已装好**的 Codex CLI / Claude Code 列成「未安装」。
 * 原因：探测只认 `process.env.PATH` —— bandi 进程**启动那一刻**继承的快照。两个坑：
 *   · CLI 在 bandi 启动之后才装（注册表 PATH 变了，进程快照没变，要重启才认）；
 *   · bandi 是 GUI 进程，PATH 本来就缺（fnm / nvm 这类版本管理器按 shell 会话注入，
 *     `bashrc` 里的 `fnm env` 对 GUI 进程毫无作用）。
 *
 * 修法（path-env.mjs）：探测目录 = 进程 PATH ∪ 注册表**此刻**的系统/用户 PATH ∪
 * 各安装器的固定落点。三条要钉住：
 *   ① **PATH 残缺的进程也要识别得出**：给 server 一个只剩 System32 的 PATH ——
 *      跟"GUI 进程看不见 node/CLI"是同一种处境；识别结论必须和全量 PATH 的对照组一致。
 *      （探不到就跳过 —— 别拿别人的环境当前提，跟 smoke-runtime-heal 一个规矩。）
 *   ② **装完即见，不用重启**：往 HKCU\Environment\Path **现塞**一个假目录（有原值还原），
 *      server 不重启，等过 5 秒记忆化再识别 —— 假目录里的假 shim 必须出现在探测结果里。
 *   ③ 地基（unit）：expandRegValue / readMachinePath / pathDirs 的去重与覆盖。
 *
 * ⚠️ 两个坑，都是第一版真栽过的：
 *   · 对照组和实验组**必须用不同端口**：kill() 是异步的，同一端口上旧进程没退干净、
 *     新进程 EADDRINUSE 挂掉的话，Windows 的 SO_REUSEADDR 会让请求继续落到旧进程 ——
 *     整个 ② 就成了"对照组跟自己比"的同义反复，结论全是假的；
 *   · ② 会动真注册表（HKCU\Environment\Path）：先读原值，finally 里**原样写回**
 *     （连 REG_SZ / REG_EXPAND_SZ 类型一起）。读不到原值就整个 ② 跳过 ——
 *     宁可不测，不能把用户 PATH 弄丢。
 *
 * 跑法：node apps/server/src/smoke-runtime-detect.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathDirs, readMachinePath, readUserPath, expandRegValue, wellKnownBins } from './path-env.mjs';

const ROOT = process.cwd();
const WIN = process.platform === 'win32';
const PORT_CONTROL = 8896; // 对照组（全量 PATH）
const PORT_MINIMAL = 8897; // 实验组（残缺 PATH）—— 两个端口必须不同，理由见文件头 ⚠️
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-detect-'));

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带超时的请求：挂住 = 失败 */
const get = async (port, p) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: ac.signal });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    clearTimeout(t);
  }
};

/**
 * 起一个 server：BANDI_DATA 指临时目录（BANDI_NO_INSTALL_CLI=1，启动安装闸直接短路）。
 * `minimalPath` 给了就是实验组：PATH 只剩系统目录 —— GUI 进程的处境。
 */
function boot(port, minimalPath = null) {
  const env = { ...process.env };
  if (minimalPath !== null) {
    // Windows 的正式名是 Path；两个名字都删干净，避免留下原值
    delete env.PATH;
    delete env.Path;
    env[WIN ? 'Path' : 'PATH'] = minimalPath;
  }
  return spawn(process.execPath, [path.join(ROOT, 'apps', 'server', 'src', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...env,
      BANDI_NO_INSTALL_CLI: '1',
      BANDI_HOST: '127.0.0.1',
      BANDI_PORT: String(port),
      BANDI_DATA: tmp,
      BANDI_DB: path.join(tmp, 'bandi.db'),
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
async function waitReady(port) {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await get(port, '/api/state')).status === 200) return true;
    } catch {
      /* 还没起 */
    }
    await sleep(200);
  }
  return false;
}
/** kill() 是异步的 —— 等 'exit' 真发生，别拿端口被谁占着听天由命 */
async function stop(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode) return;
  const done = new Promise((resolve) => proc.once('exit', resolve));
  try {
    proc.kill();
  } catch {
    /* 已经死了 */
  }
  await Promise.race([done, sleep(3000)]);
}
const familiesOf = async (port) => (await get(port, '/api/runtime-families')).body.families;

let server = null;
try {
  /* -------------------------------------------------------- ① 地基（unit） */
  console.log('① path-env 的地基（unit）');
  if (WIN) {
    const m = readMachinePath();
    check('HKLM 系统级 PATH 读得到且非空', m.exists && m.value.length > 0, m.type);
    const u = readUserPath();
    check('HKCU 用户级 PATH 读得到、类型合法', !u.exists || /^REG_[A-Z_]+$/.test(u.type), u.type);
    const expanded = expandRegValue('%SystemRoot%\\System32');
    check(
      '%VAR% 按 process.env 展开',
      expanded.toLowerCase() === path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32').toLowerCase(),
      expanded,
    );
    const dirs = pathDirs();
    const machineDirs = expandRegValue(m.value)
      .split(';')
      .map((s) => s.trim().replace(/[\\/]+$/, ''))
      .filter(Boolean);
    const missing = machineDirs.filter((d) => !dirs.some((x) => x.toLowerCase() === d.toLowerCase()));
    check('pathDirs() 覆盖 HKLM PATH 的每个目录', missing.length === 0, missing.slice(0, 3).join(' , '));
    const lowered = dirs.map((d) => d.toLowerCase());
    check('pathDirs() 没有重复目录（win32 大小写不敏感去重）', lowered.length === new Set(lowered).size);
    const fnmDefault = path.join(process.env.APPDATA ?? '', 'fnm', 'aliases', 'default');
    if (fs.existsSync(fnmDefault)) {
      check('wellKnownBins() 列了 fnm 的 default 别名目录', wellKnownBins().some((d) => d.toLowerCase() === fnmDefault.toLowerCase()));
    }
  } else {
    check('非 Windows：注册表那几条不适用，跳过', true);
  }

  /* --------------------------------------- ② PATH 残缺的进程也要识别得出 */
  console.log('\n② 对照组（全量 PATH）→ 实验组（只剩系统目录的 PATH）');
  const control = boot(PORT_CONTROL);
  if (!(await waitReady(PORT_CONTROL))) {
    check('对照组 server 起来了', false, '80×200ms 内 /api/state 不通');
  } else {
    const controlFams = await familiesOf(PORT_CONTROL);
    const installedIds = controlFams.filter((f) => f.installed).map((f) => f.id);
    console.log(`  本机（全量 PATH）探到已装：${installedIds.join(' ') || '（一个都没有）'}`);
    await stop(control); // **等它真退了**再起实验组 —— 端口的事见文件头 ⚠️

    if (installedIds.length === 0) {
      check('本机一个 CLI 都没有，比对用例跳过（不是失败）', true, '没有可比对的探测结果');
    } else {
      server = boot(PORT_MINIMAL, WIN ? 'C:\\Windows\\System32' : '/usr/bin:/bin');
      if (!(await waitReady(PORT_MINIMAL))) {
        check('残缺 PATH 的 server 起来了', false, '80×200ms 内 /api/state 不通');
      } else {
        const minFams = await familiesOf(PORT_MINIMAL);
        for (const f of controlFams) {
          const m = minFams.find((x) => x.id === f.id);
          check(
            `「${f.id}」PATH 残缺也识别得出（installed=${f.installed}）`,
            !!m && m.installed === f.installed,
            m?.detectedPath ?? '',
          );
        }
      }
    }
  }
  await stop(control);

  /* --------------------------- ③ 注册表新鲜度：装完即见，不用重启 server */
  console.log('\n③ 往 HKCU 用户 PATH 现塞一个假目录，server 不重启');
  const cur = readUserPath();
  if (!WIN || !cur.exists) {
    check('读不到用户级 PATH，③ 跳过（宁可不测，不能把用户 PATH 弄丢）', true);
  } else {
    const savedValue = cur.value;
    const savedType = cur.type;
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      try {
        execFileSync('reg', ['add', 'HKCU\\Environment', '/v', 'Path', '/t', savedType, '/d', savedValue, '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        /* 尽力写回 —— 下面的兜底检查会如实报 */
      }
    };
    try {
      const fakeDir = path.join(tmp, 'fake-path-entry');
      fs.mkdirSync(fakeDir);
      // 占位假 shim：launchable 只看扩展名（.exe），内容是什么无所谓
      fs.writeFileSync(path.join(fakeDir, 'claude.exe'), 'not a real exe — 只是个占位', 'utf8');
      execFileSync('reg', ['add', 'HKCU\\Environment', '/v', 'Path', '/t', savedType, '/d', `${fakeDir};${savedValue}`, '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });

      if (!server) {
        // ② 没跑到（比如本机一个 CLI 都没有）—— 这里自己起一个残缺 PATH 的
        server = boot(PORT_MINIMAL, WIN ? 'C:\\Windows\\System32' : '/usr/bin:/bin');
        await waitReady(PORT_MINIMAL);
      }
      // 等 pathDirs() 的 5 秒记忆化过期 —— server **不重启**，这正是要验的事
      await sleep(5500);
      const fams = await familiesOf(PORT_MINIMAL);
      const cl = fams.find((f) => f.id === 'claude');
      check(
        '假目录里的 claude 出现在探测结果里（server 没重启）',
        typeof cl?.detectedPath === 'string' && cl.detectedPath.toLowerCase().startsWith(fakeDir.toLowerCase()),
        cl?.detectedPath ?? '(null)',
      );
    } finally {
      restore();
    }
    const after = readUserPath();
    check('用户级 PATH 已原样写回（连类型）', after.exists && after.value === savedValue && after.type === savedType, after.type);
  }

  console.log('\n④ 服务还活着');
  if (server) check('健康检查仍然 200', (await get(PORT_MINIMAL, '/api/state')).status === 200);
  else check('（②③ 都没起 server —— 没有可检查的实例，跳过）', true);
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err));
  if (String(err?.name) === 'AbortError') console.log('（请求超时 = 请求挂住了）');
  failed += 1;
} finally {
  try {
    server?.kill();
  } catch {
    /* 退了 */
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 算了 */
  }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
