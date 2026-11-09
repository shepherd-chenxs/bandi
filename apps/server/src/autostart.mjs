/**
 * 开机自启 —— 班底**自带**的能力。
 *
 * 为什么要自带：这是"每台机器都要配一遍"的典型。手工往 crontab / Startup 里塞东西，
 * 换台机器就得再来一遍，而且错一点就**静默失效**（见下面 Windows 那条的 ASCII 坑）。
 * 这件事应该是一条命令：
 *
 *     node apps/server/src/autostart.mjs status
 *     node apps/server/src/autostart.mjs install
 *     node apps/server/src/autostart.mjs remove
 *
 * 目标（target）只有一个：
 *   · `control-plane`   —— 这台机器作为**控制面**。托管的那台装它。
 *     （曾经的 `node` 执行节点守护随多机节点子系统整体删除，2026-11-09。）
 *
 * 各平台走什么（**优先正规做法，退化才用土办法**）：
 *
 * | 平台 | 首选 | 退化 |
 * | --- | --- | --- |
 * | Linux | `systemd --user` 单元（崩了自动重启、日志进 journalctl）＋ `loginctl enable-linger`（开机不必先登录） | `crontab @reboot` ＋ 自带重连循环的启动脚本 |
 * | Windows | Startup 文件夹里的 `.vbs`（隐藏窗口）＋ 带循环的 `.cmd` | — |
 * | macOS | `~/Library/LaunchAgents/*.plist`（`KeepAlive`） | — |
 *
 * ⚠️ **生成的 .cmd / .vbs 必须纯 ASCII**（只有 Windows 那条）：wscript / cmd 按**系统 ANSI 页**
 * 读脚本，UTF-8 的中文注释被按 GBK 解时某些字节序列会**把换行一起吃掉** ——
 * 下一行并进注释，`Set sh = CreateObject(...)` 整行消失，vbs 报 `缺少对象: 'sh'`，
 * **自启静默失效**（2026-10-16 实测踩到，跟 `smoke-shell.mjs` 被 PowerShell 往返写坏同源）。
 * 所以那些文件由 `ascii()` 生成，中文只留在这个源文件里。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { repoRoot, dataDir } from './config.mjs';

export const TARGETS = ['control-plane'];

/** 生成的启动脚本放这儿（跟数据目录一起走） */
const scriptDir = (o) => path.join(o.dataDir, 'autostart');

/**
 * 一份完整的"装什么"描述。**所有平台分支都从这里取路径与命令** ——
 * 免得三套后端各拼一份，日子一长就各说各话。
 */
function plan(o = {}) {
  const opt = {
    repoRoot,
    dataDir,
    nodeBin: process.execPath,
    home: os.homedir(),
    /*
     * `noSystem`：**只用例用** —— 跳过 `systemctl` / `launchctl` / `crontab` 这些系统级动作，
     * 只生成文件。为什么必须有它（2026-10-16 实测踩到）：单元名是固定的 `bandi-control-plane.service`，
     * 用例一跑 `systemctl --user disable --now bandi-control-plane` 就会**停掉这台机器上真正在跑的那个服务** ——
     * 验证代码把生产环境改了，这不能接受。真实安装**不要**开这个开关。
     */
    noSystem: false,
    ...o,
  };
  const wins = process.platform === 'win32';
  const cpLog = path.join(opt.dataDir, 'server.log');
  /*
   * ⚠️ **启动脚本自己的输出，不能重定向到应用自己的日志文件**。
   *
   * 2026-10-16 实测踩到：`control-plane.cmd` 里写了 `start.mjs >> data\server.log 2>&1`，
   * 而 `start.mjs` 自己也要 `openSync(data/server.log, 'a')` 把 fd 交给脱胎出去的服务 ——
   * **同一个文件被两处打开**，Windows 上直接 `EBUSY`，控制面起不来（日志里只有一段堆栈）。
   * 所以两件事分开：`appLog` 是应用写的（控制面由 lifecycle 写 server.log），
   * `outLog` 是启动脚本那条重定向的目标。
   */
  const cpOut = path.join(opt.dataDir, 'autostart-control-plane.log');
  return {
    opt,
    targets: {
      'control-plane': {
        id: 'control-plane',
        label: '控制面',
        entry: [opt.nodeBin, path.join(opt.repoRoot, 'start.mjs')],
        env: {
          // 开机时别自己弹浏览器（start.mjs 默认会开一个）
          BANDI_NO_BROWSER: '1',
          /*
           * ⚠️ **必须把数据目录写死进脚本**（2026-10-16 修的一个真 bug）。
           *
           * 原来这里没有这一行 ✗ —— 于是自启那份控制面用的是 `config.mjs` 的默认数据目录
           * （仓库的 `data/` ✗），而**桌面壳**用的是它自己的目录（`%APPDATA%\bandi` ✓）：
           * 同一台机器上出现**两个实例、两个库** ✗✗（用户看到"数据不见了 / 多出一个空实例"），
           * 而且 `netmode.json`、`token` 也跟着分成两份 ✗（那个局域网开关的"要重启才生效"因此永远对不上）。
           *
           * 脚本里的日志（`appLog`/`outLog`）本来就在 `opt.dataDir` 里 ✓ ——
           * 只有数据这一项没跟着走 ✗，所以补上：**一份数据目录，脚本、壳、令牌、开关全用它** ✓。
           */
          BANDI_DATA: opt.dataDir,
        },
        appLog: cpLog,
        outLog: cpOut,
        note: `数据目录 ${opt.dataDir}`,
      },
    },
    wins,
  };
}

/** 只允许 ASCII：Windows 的 cmd / wscript 会按系统 ANSI 页读脚本（见文件头那条坑） */
function ascii(text, where) {
  const bad = [...text].filter((c) => c.charCodeAt(0) > 127);
  if (bad.length) throw new Error(`${where} 里出现了非 ASCII 字符：${bad.slice(0, 5).join('')}`);
  return text;
}

/* ------------------------------------------------------------------ Linux */

const unitDir = (o) => path.join(o.home, '.config', 'systemd', 'user');
const unitName = (id) => `bandi-${id}.service`;

function unitText(t, o) {
  const [bin, ...args] = t.entry;
  const env = Object.entries(t.env)
    .map(([k, v]) => `Environment=${k}=${v}`)
    .join('\n');
  return `[Unit]
Description=bandi ${t.id} (${t.note})
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${o.repoRoot}
ExecStart=${[bin, ...args].join(' ')}
${env}
Restart=always
RestartSec=5
StandardOutput=append:${t.outLog}
StandardError=append:${t.outLog}

[Install]
WantedBy=default.target
`;
}

/** systemd --user 能不能用（拿不到 session bus 的机器上不行，那就退化） */
function hasSystemdUser(o) {
  if (process.platform !== 'linux') return false;
  try {
    execFileSync('systemctl', ['--user', 'is-system-running'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch (e) {
    // `is-system-running` 在 degraded 时会非零退出 —— 那也算"能用"
    return /degraded|running/.test(String(e?.stdout ?? ''));
  }
}

function sh(cmd, args, o) {
  try {
    return { ok: true, out: String(execFileSync(cmd, args, { encoding: 'utf8', timeout: 15000, env: process.env })).trim() };
  } catch (e) {
    return { ok: false, out: String(e?.stderr ?? e?.message ?? '').trim() };
  }
}

/* ------------------------------------------------------------- crontab 兜底 */

const CRON_TAG = '# bandi-autostart';

function cronLine(t, o) {
  // cron 的环境是干净的（没有你的 PATH），所以启动脚本里自带 PATH 与重连循环
  const sh1 = path.join(scriptDir(o), `${t.id}.sh`);
  return `@reboot ${sh1} >/dev/null 2>&1`;
}

/** 兜底用的启动脚本：**带循环**（cron 不会替你重启崩掉的进程） */
function cronScript(t, o) {
  const [bin, ...args] = t.entry;
  const env = Object.entries(t.env)
    .map(([k, v]) => `export ${k}='${v}'`)
    .join('\n');
  return `#!/bin/sh
# bandi ${t.id} —— crontab @reboot 调它。cron 不会重启崩掉的进程，所以这里自己循环。
${env}
while :; do
  "${bin}" ${args.map((a) => `"${a}"`).join(' ')} >> "${t.outLog}" 2>&1
  sleep 10
done
`;
}

function readCrontab() {
  const r = sh('crontab', ['-l']);
  return r.ok ? r.out : '';
}
function writeCrontab(text) {
  const f = path.join(os.tmpdir(), `bandi-cron-${process.pid}`);
  fs.writeFileSync(f, text.endsWith('\n') ? text : text + '\n', 'utf8');
  const r = sh('crontab', [f]);
  fs.rmSync(f, { force: true });
  if (!r.ok) throw new Error('写 crontab 失败：' + r.out);
}

/* ----------------------------------------------------------------- Windows */

function winCmd(t, o) {
  const [bin, ...args] = t.entry;
  const env = Object.entries(t.env)
    .map(([k, v]) => `set ${k}=${v}`)
    .join('\r\n');
  return ascii(
    `@echo off
rem bandi ${t.id} - autostart launcher. ASCII only: see apps/server/src/autostart.mjs
cd /d "${o.repoRoot}"
${env}
:again
"${bin}" ${args.map((a) => `"${a}"`).join(' ')} >> "${t.outLog}" 2>&1
timeout /t 10 /nobreak >nul
goto again
`,
    'cmd',
  );
}

function winVbs(t, o) {
  return ascii(
    `' bandi ${t.id} autostart. 0 = hidden window (no black box). ASCII only.
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c ""${path.join(scriptDir(o), `${t.id}.cmd`)}""", 0, False
`,
    'vbs',
  );
}

const winStartup = (o) => path.join(o.home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');

/* ------------------------------------------------------------------ macOS */

function plistText(t, o) {
  const [bin, ...args] = t.entry;
  const env = Object.entries(t.env)
    .map(([k, v]) => `    <key>${k}</key><string>${v}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.local.bandi.${t.id}</string>
  <key>ProgramArguments</key><array>
    <string>${bin}</string>
${args.map((a) => `    <string>${a}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${o.repoRoot}</string>
  <key>EnvironmentVariables</key><dict>
${env}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${t.outLog}</string>
  <key>StandardErrorPath</key><string>${t.outLog}</string>
</dict></plist>
`;
}

/* --------------------------------------------------------------- 对外三个动作 */

/** 这台机器上现在装了什么、怎么装的 */
export function status(opts = {}) {
  const { opt, targets, wins } = plan(opts);
  const linuxSystemd = hasSystemdUser(opt);
  const backend = wins ? 'startup-folder' : process.platform === 'darwin' ? 'launchd' : linuxSystemd ? 'systemd-user' : 'crontab';
  const cron = process.platform === 'linux' && !linuxSystemd ? readCrontab() : '';

  return {
    platform: process.platform,
    backend,
    repoRoot: opt.repoRoot,
    dataDir: opt.dataDir,
    targets: TARGETS.map((id) => {
      const t = targets[id];
      let installed = false;
      let where = '';
      if (wins) {
        where = path.join(winStartup(opt), `bandi-${id}.vbs`);
        installed = fs.existsSync(where);
      } else if (process.platform === 'darwin') {
        where = path.join(opt.home, 'Library', 'LaunchAgents', `app.local.bandi.${id}.plist`);
        installed = fs.existsSync(where);
      } else if (linuxSystemd) {
        where = path.join(unitDir(opt), unitName(id));
        installed = fs.existsSync(where);
      } else {
        where = `${CRON_TAG} ${id}`;
        installed = cron.includes(`${CRON_TAG} ${id}`);
      }
      return {
        id,
        label: t.label,
        note: t.note,
        installed,
        where,
        // 给人看的是**应用自己的**日志（server.log）；启动脚本那条重定向是另一回事
        log: t.appLog,
      };
    }),
  };
}

export function install(which = 'all', opts = {}) {
  const { opt, targets, wins } = plan(opts);
  const ids = which === 'all' ? TARGETS : TARGETS.includes(which) ? [which] : null;
  if (!ids) throw new Error(`不认识的目标「${which}」—— 只有 ${TARGETS.join(' / ')} / all`);

  const done = [];
  for (const id of ids) {
    const t = targets[id];
    fs.mkdirSync(opt.dataDir, { recursive: true });
    fs.mkdirSync(scriptDir(opt), { recursive: true });

    if (wins) {
      /*
       * ⚠️ 这两份文件**必须 ASCII**（见文件头那条坑）：中文注释会让 wscript 把下一行吃掉，
       * 于是 `Set sh = ...` 变成注释、自启静默失效。
       */
      fs.writeFileSync(path.join(scriptDir(opt), `${id}.cmd`), winCmd(t, opt), 'ascii');
      const startup = winStartup(opt);
      fs.mkdirSync(startup, { recursive: true });
      fs.writeFileSync(path.join(startup, `bandi-${id}.vbs`), winVbs(t, opt), 'ascii');
      done.push({ id, how: 'startup-folder', where: path.join(startup, `bandi-${id}.vbs`) });
      continue;
    }

    if (process.platform === 'darwin') {
      const dir = path.join(opt.home, 'Library', 'LaunchAgents');
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, `app.local.bandi.${id}.plist`);
      fs.writeFileSync(f, plistText(t, opt), 'utf8');
      sh('launchctl', ['unload', f]);
      const r = opt.noSystem ? { ok: true, out: '' } : sh('launchctl', ['load', '-w', f]);
      done.push({ id, how: 'launchd', where: f, warn: r.ok ? '' : r.out });
      continue;
    }

    // Linux：能用 systemd 就用 systemd
    if (hasSystemdUser(opt)) {
      const dir = unitDir(opt);
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, unitName(id));
      fs.writeFileSync(f, unitText(t, opt), 'utf8');
      if (!opt.noSystem) sh('systemctl', ['--user', 'daemon-reload']);
      const r = opt.noSystem ? { ok: true, out: '' } : sh('systemctl', ['--user', 'enable', '--now', unitName(id)]);
      /*
       * linger：让这个用户的服务**开机就起，不必等他先登录**。
       * 给自己开通常不需要 root（实测 Ubuntu 22.04 直接成了）；不成就说明白，别装作成功。
       */
      const linger = opt.noSystem ? { ok: true, out: '(用例跳过)' } : sh('loginctl', ['enable-linger', os.userInfo().username]);
      done.push({
        id,
        how: 'systemd-user',
        where: f,
        warn: r.ok ? '' : r.out,
        note: linger.ok ? '已开 linger（开机不必先登录）' : '⚠️ 开 linger 失败：开机后要先登录一次它才起 —— ' + linger.out,
      });
      continue;
    }

    // 退化：crontab @reboot + 自带循环的脚本
    const s = path.join(scriptDir(opt), `${id}.sh`);
    fs.writeFileSync(s, cronScript(t, opt), { mode: 0o755 });
    if (!opt.noSystem) {
      const kept = readCrontab()
        .split(/\r?\n/)
        .filter((l) => l.trim() && !(l.includes(CRON_TAG) && l.includes(` ${id}`)))
        .join('\n');
      const marker = `${CRON_TAG} ${id}`;
      writeCrontab([kept, `${marker} (${t.note})`, cronLine(t, opt), ''].filter(Boolean).join('\n'));
    }
    done.push({ id, how: 'crontab', where: s, note: '@reboot 在 cron 启动时跑一次' });
  }
  return done;
}

export function remove(which = 'all', opts = {}) {
  const { opt, targets, wins } = plan(opts);
  const ids = which === 'all' ? TARGETS : TARGETS.includes(which) ? [which] : null;
  if (!ids) throw new Error(`不认识的目标「${which}」`);

  const gone = [];
  for (const id of ids) {
    const t = targets[id];
    if (wins) {
      const f = path.join(winStartup(opt), `bandi-${id}.vbs`);
      fs.rmSync(f, { force: true });
      fs.rmSync(path.join(scriptDir(opt), `${id}.cmd`), { force: true });
      gone.push({ id, where: f });
      continue;
    }
    if (process.platform === 'darwin') {
      const f = path.join(opt.home, 'Library', 'LaunchAgents', `app.local.bandi.${id}.plist`);
      if (!opt.noSystem) sh('launchctl', ['unload', f]);
      fs.rmSync(f, { force: true });
      gone.push({ id, where: f });
      continue;
    }
    if (hasSystemdUser(opt)) {
      if (!opt.noSystem) sh('systemctl', ['--user', 'disable', '--now', unitName(id)]);
      const f = path.join(unitDir(opt), unitName(id));
      fs.rmSync(f, { force: true });
      if (!opt.noSystem) sh('systemctl', ['--user', 'daemon-reload']);
      gone.push({ id, where: f });
      continue;
    }
    if (!opt.noSystem) {
      const kept = readCrontab()
        .split(/\r?\n/)
        .filter((l) => !(l.includes(CRON_TAG) && l.includes(` ${id}`)))
        .join('\n');
      try {
        writeCrontab(kept);
      } catch { /* crontab 本来就空 */ }
    }
    fs.rmSync(path.join(scriptDir(opt), `${id}.sh`), { force: true });
    gone.push({ id, where: `${CRON_TAG} ${id}` });
  }
  return gone;
}

/* ------------------------------------------------------------------- 命令行 */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd = 'status', which = 'all'] = process.argv.slice(2);
  const say = (s) => console.log(s);
  try {
    if (cmd === 'status') {
      const s = status();
      say(`平台 ${s.platform} · 方式 ${s.backend}`);
      say(`工作根 ${s.repoRoot}`);
      say(`数据目录 ${s.dataDir}`);
      for (const t of s.targets) {
        say(`  ${t.installed ? '✅ 已装' : '—  未装'}  ${t.label.padEnd(6)} ${t.note}`);
        if (t.installed) say(`              ${t.where}`);
      }
      if (!s.targets.some((t) => t.installed)) say('\n装：node apps/server/src/autostart.mjs install');
    } else if (cmd === 'install' || cmd === 'remove') {
      const fn = cmd === 'install' ? install : remove;
      for (const d of fn(which)) {
        say(`${cmd === 'install' ? '✅' : '🗑 '} ${d.id} · ${d.how ?? ''} · ${d.where}`);
        if (d.note) say(`   ${d.note}`);
        if (d.warn) say(`   ⚠️ ${d.warn}`);
      }
      if (cmd === 'install') say('\n看状态：node apps/server/src/autostart.mjs status');
    } else {
      say('用法：node apps/server/src/autostart.mjs <status|install|remove> [control-plane|all]');
      process.exitCode = 2;
    }
  } catch (e) {
    say('出错：' + (e?.message ?? e));
    process.exitCode = 1;
  }
}
