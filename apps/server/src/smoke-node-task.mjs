/**
 * 「一键安装运行时」的验收（2026-10-16）。
 *
 * 这条链路是：界面点一下 → 控制面**只排一个族名** → 节点在它的领活循环里领走 →
 * **节点自己查命令表**跑 → 边跑边报输出 → 装完节点重报清单、界面那行跳到已安装。
 *
 * 用**假节点**驱动（就是照着真节点那样发 HTTP），所以不装任何东西、也不需要 npm：
 * 这里验的是**协议与安全边界**，真机上的 npm 安装另手工验（见 deploy/README）。
 *
 * 最要紧的一条：**控制面发不出命令**。它只能发族名；族名不在表里、或者那个族本来就不是
 * npm 装的（dsh），一律要**明确拒绝** —— 这条边界要是松了，一键安装就成了
 * "谁拿着令牌谁就能在每台机器上跑任意命令"。
 *
 * 跑法：node apps/server/src/smoke-node-task.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const PORT = 8886;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-task-'));

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};
const req = async (p, opts = {}) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(BASE + p, {
      signal: ac.signal,
      method: opts.method ?? 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    clearTimeout(t);
  }
};

const server = spawn(process.execPath, [path.join(ROOT, 'apps', 'server', 'src', 'server.mjs')], {
  cwd: ROOT,
  env: { ...process.env, BANDI_PORT: String(PORT), BANDI_DATA: tmp, BANDI_DB: path.join(tmp, 'bandi.db') },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (c) => (log += c));
server.stderr.on('data', (c) => (log += c));

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await req('/api/state')).status === 200) break; } catch { /* 还没起 */ }
    await new Promise((r) => setTimeout(r, 200));
  }

  const NODE = 'node-install-test';
  await req('/api/nodes/register', {
    method: 'POST',
    body: { id: NODE, label: '装东西的机器', hostname: 'install-host', platform: 'linux x64', runtimes: [] },
  });

  console.log('① 排一个安装任务（只给族名）');
  const made = await req(`/api/nodes/${NODE}/tasks`, { method: 'POST', body: { kind: 'install-runtime', family: 'codex' } });
  check('排上了（201）', made.status === 201, String(made.status));
  const tid = made.body?.task?.id;
  check('任务带 id 和"待领"状态', !!tid && made.body.task.status === '待领', made.body?.task?.status);
  check('顺带回一句"将要跑什么"给界面确认用', /npm install -g @openai\/codex/.test(made.body?.willRun ?? ''), made.body?.willRun);

  console.log('\n② 安全边界：控制面**发不出命令**，只能发族名');
  const bad = await req(`/api/nodes/${NODE}/tasks`, { method: 'POST', body: { kind: 'install-runtime', family: 'rm -rf /' } });
  check('不认识的"族名"被拒（400）', bad.status === 400, String(bad.status));
  check('且说清为什么', /没法一键安装/.test(bad.body?.error ?? ''), bad.body?.error);
  const dsh = await req(`/api/nodes/${NODE}/tasks`, { method: 'POST', body: { kind: 'install-runtime', family: 'dsh' } });
  check('dsh（桌面端自带的）也明确拒绝，不装作能装', dsh.status === 400, String(dsh.status));
  const wrongKind = await req(`/api/nodes/${NODE}/tasks`, { method: 'POST', body: { kind: 'run-anything', family: 'codex' } });
  check('别的 kind 一律不收（免得多出个通用执行口子）', wrongKind.status === 400, String(wrongKind.status));

  console.log('\n③ 节点来领活 —— 任务应该**在同一个长轮询里**发给它');
  const claimed = await req(`/api/nodes/${NODE}/claim`, { method: 'POST', body: { waitMs: 3000 } });
  check('领到了这个任务', claimed.body?.task?.id === tid, JSON.stringify(claimed.body?.task?.id));
  check('领走之后状态变"执行中"', claimed.body?.task?.status === '执行中', claimed.body?.task?.status);
  /*
   * ⚠️ 断言要写精确：第一版用 `/npm|install/` 抓，结果被自己的 `kind: "install-runtime"`
   * 打中（假失败）。要断言的是"**没有命令字段、没有包名**"，不是"没有 install 这个词"。
   */
  const payload = JSON.stringify(claimed.body?.task ?? {});
  const keys = Object.keys(claimed.body?.task ?? {}).sort().join(',');
  check(
    '下发里没有命令字段（只有族名 —— 这条最关键）',
    !/(^|,)(cmd|args|bin)(,|$)/.test(keys) && !/@openai|@anthropic/.test(payload),
    keys,
  );

  console.log('\n④ 节点边跑边报输出');
  await req(`/api/nodes/${NODE}/tasks/${tid}/report`, { method: 'POST', body: { output: 'npm warn deprecated\n' } });
  await req(`/api/nodes/${NODE}/tasks/${tid}/report`, { method: 'POST', body: { output: 'added 1 package\n' } });
  const mid = await req(`/api/nodes/${NODE}/tasks/${tid}`);
  check('两次输出都攒着', /deprecated[\s\S]*added 1 package/.test(mid.body?.task?.output ?? ''), JSON.stringify(mid.body?.task?.output));
  check('还没结束（running，不是 done）', mid.body?.task?.running === true && mid.body?.task?.done === false);

  /*
   * ⚠️ 进度**必须挂在设备详情上**（2026-10-16 用户报的"刷新页面，看不到安装进度了"）：
   * 原来它只活在浏览器里 —— 一刷新就没了，而那件事还在那台机器上跑着。
   * 这条断言就是"刷新之后还能看见"的契约：`GET /api/devices/:id` 要带出那件在跑的活。
   */
  const devMid = (await req(`/api/devices/${NODE}`)).body.device;
  check('设备详情里带着那件在跑的活（刷新也不会丢）', devMid.task?.id === tid, JSON.stringify(devMid.task?.id ?? null));
  check('它带来状态与输出（界面据此画进度）', devMid.task?.status === '执行中' && /added 1 package/.test(devMid.task?.output ?? ''), devMid.task?.status);
  check('目标也在（界面靠它认出是给哪一行画的）', devMid.task?.family === 'codex', String(devMid.task?.family));

  console.log('\n⑤ 收尾 + 节点重报清单');
  await req(`/api/nodes/${NODE}/tasks/${tid}/report`, { method: 'POST', body: { status: '完成', output: '\n装完了。\n' } });
  const fin = await req(`/api/nodes/${NODE}/tasks/${tid}`);
  check('状态是"完成"', fin.body?.task?.status === '完成', fin.body?.task?.status);
  check('done=true（界面据此收手）', fin.body?.task?.done === true);
  await req(`/api/nodes/${NODE}/heartbeat`, {
    method: 'POST',
    body: { runtimes: [{ family: 'codex', label: 'Codex CLI', path: '/home/x/.local/node/lib/node_modules/@openai/codex/bin/codex.js', usable: true }] },
  });
  const dev = (await req(`/api/devices/${NODE}`)).body.device;
  check('装完那台机器立刻就"有"这个运行时可派了', dev.runtimeCount === 1 && dev.runtimes[0].family === 'codex', `count=${dev.runtimeCount}`);

  console.log('\n⑥ 失败路径也要能说清');
  const t2 = await req(`/api/nodes/${NODE}/tasks`, { method: 'POST', body: { kind: 'install-runtime', family: 'claude' } });
  const id2 = t2.body.task.id;
  await req(`/api/nodes/${NODE}/claim`, { method: 'POST', body: { waitMs: 3000 } });
  await req(`/api/nodes/${NODE}/tasks/${id2}/report`, { method: 'POST', body: { status: '失败', output: 'npm ERR! 源连不上\n' } });
  const bad2 = await req(`/api/nodes/${NODE}/tasks/${id2}`);
  check('失败状态与输出都留下来了（不是一声不吭）', bad2.body?.task?.status === '失败' && /源连不上/.test(bad2.body?.task?.output ?? ''), bad2.body?.task?.status);

  console.log('\n⑧ 外部件：控制面照样只发 id + 哪一步（命令表在那台机器那侧）');
  /*
   * ⚠️ 判据要按**那台节点**的平台，不是控制面自己的 —— 2026-10-16 修掉的那个 bug：
   * 控制面在云端（Linux），给一台 Windows 节点也会放行 `curl | sh`。
   * 所以这里两个平台各验一次。
   */
  const { commandFor } = await import('./externals.mjs');
  check('Linux 节点：这一步能一键', !!commandFor('install', 'magpie', 'linux x64'));
  check('Windows 节点：这一步给不出来（桌面安装包）', commandFor('install', 'magpie', 'win32 x64') === null);

  // 这台测试节点报的是 linux x64 → 应当**被接受**
  const ext = await req(`/api/nodes/${NODE}/tasks`, { method: 'POST', body: { kind: 'external-install', family: 'magpie' } });
  check('Linux 节点上排得上（201）', ext.status === 201, String(ext.status));
  const extId = ext.body?.task?.id;
  check('顺带回一句"将要跑什么"', /usemagpie\.ai/.test(ext.body?.willRun ?? ''), ext.body?.willRun);
  const extClaim = await req(`/api/nodes/${NODE}/claim`, { method: 'POST', body: { waitMs: 3000 } });
  const extPayload = JSON.stringify(extClaim.body?.task ?? {});
  check('下发里同样没有命令（只有 id 与步骤）', !/curl|usemagpie|daemon install/.test(extPayload), extPayload.slice(0, 130));
  await req(`/api/nodes/${NODE}/tasks/${extId}/report`, { method: 'POST', body: { status: '完成' } });

  // 换成一台 **Windows** 节点：同一步就得被拒，并说清为什么
  const WINNODE = 'node-win-test';
  await req('/api/nodes/register', {
    method: 'POST',
    body: { id: WINNODE, label: 'Windows 那台', hostname: 'win-host', platform: 'win32 x64', runtimes: [] },
  });
  const extWin = await req(`/api/nodes/${WINNODE}/tasks`, { method: 'POST', body: { kind: 'external-install', family: 'magpie' } });
  check('Windows 节点上**明确拒绝**，不装作能装', extWin.status === 400 && /没法一键做/.test(extWin.body?.error ?? ''), extWin.body?.error);

  const idBogus = await req(`/api/nodes/${NODE}/tasks`, { method: 'POST', body: { kind: 'external-install', family: 'rm -rf /' } });
  check('不认识的外部件 id 一样被拒', idBogus.status === 400, String(idBogus.status));

  console.log('\n⑨ 节点自报的「外部件」现状要能传到界面上');
  await req(`/api/nodes/${NODE}/heartbeat`, {
    method: 'POST',
    body: {
      externals: [
        {
          id: 'magpie',
          installed: true,
          where: '/home/x/.local/bin/magpie',
          gateway: false,
          gatewayPort: 3425,
          // 面板入口也由**那台机器**给出（它才知道自己的局域网地址）——
          // 界面只放入口，不搬它自己的界面（2026-10-16 定的）
          panel: true,
          panelPort: 3430,
          panelUrl: 'http://192.168.5.19:3430',
        },
      ],
    },
  });
  const devX = (await req(`/api/devices/${NODE}`)).body.device;
  check('设备详情里带上了它自报的现状', devX.externals?.probed?.[0]?.id === 'magpie', JSON.stringify(devX.externals?.probed ?? null));
  check('网关那栏是"没起"（界面上要标红）', devX.externals?.probed?.[0]?.gateway === false, String(devX.externals?.probed?.[0]?.gateway));
  check('面板入口也带回来了（界面靠它画那颗链接）', devX.externals?.probed?.[0]?.panelUrl === 'http://192.168.5.19:3430', String(devX.externals?.probed?.[0]?.panelUrl));
  check('说明表也在（界面靠它把"没装"的也画出来）', (devX.externals?.catalog ?? []).some((c) => c.id === 'magpie'), JSON.stringify((devX.externals?.catalog ?? []).length));

  console.log('\n⑩ 走镜像装：那个前缀是**参数**，必须严格校验（它会被拼进 shell 命令）');
  const { mirrorOk } = await import('./externals.mjs');
  const MIRROR = 'https://ghproxy.example.com/';
  check('直连：命令里没有 --mirror', !/--mirror/.test(commandFor('install', 'magpie', 'linux x64')?.cmd ?? ''));
  check(
    '给了合法前缀 → 命令里带上它',
    (commandFor('install', 'magpie', 'linux x64', { mirror: MIRROR })?.cmd ?? '').includes(`--mirror ${MIRROR}`),
    commandFor('install', 'magpie', 'linux x64', { mirror: MIRROR })?.cmd,
  );
  /*
   * ⚠️ 这一节是**安全边界**，不是格式洁癖：前缀会被拼进 `sh -c '… --mirror "<前缀>"'`。
   * 带任何一个 shell 元字符，它就从"参数"变成"命令"了。
   */
  const EVIL = [
    'https://a.com/"; rm -rf /',
    'https://a.com/"$(id)"',
    'https://a.com/`id`',
    'https://a.com/;id',
    'https://a.com/|id',
    'https://a.com/&&id',
    'a b',
    'a\nb',
    '"',
    '\\',
  ];
  const leaked = EVIL.filter((b) => mirrorOk(b) || commandFor('install', 'magpie', 'linux x64', { mirror: b }));
  check('带 shell 元字符的一律拒掉', leaked.length === 0, leaked.length ? `放行了：${JSON.stringify(leaked)}` : `试了 ${EVIL.length} 种`);
  check('正常前缀放行', mirrorOk(MIRROR) && mirrorOk('https://gh-proxy.com/https://github.com'));

  /*
   * 内置镜像（普通用户不填地址，勾一下就用这些）—— **每一条都要能过校验**：
   * 写错一条就会静默失效（勾了却没走镜像，或者整条命令给你个 null）。
   */
  const { publicExternals } = await import('./externals.mjs');
  const builtIn = publicExternals('linux x64').find((x) => x.id === 'magpie')?.mirrors ?? [];
  check('内置镜像不止一个（这类公共镜像会挂，写死一个等于把"装不上"钉死）', builtIn.length >= 2, JSON.stringify(builtIn));
  check('每一条内置镜像都能过校验', builtIn.every((m) => mirrorOk(m) && commandFor('install', 'magpie', 'linux x64', { mirror: m })), JSON.stringify(builtIn));
  check('Windows 上没有内置镜像（它本来就是桌面安装包）', (publicExternals('win32 x64').find((x) => x.id === 'magpie')?.mirrors ?? ['x']).length === 0);
  check('Windows 上给镜像也一样给不出命令', commandFor('install', 'magpie', 'win32 x64', { mirror: MIRROR }) === null);

  // 接口这一层也要挡住（不然它会被排进队列，跑到那台机器上才失败）
  const badMirror = await req(`/api/nodes/${NODE}/tasks`, {
    method: 'POST',
    body: { kind: 'external-install', family: 'magpie', mirror: 'https://a.com/; rm -rf /' },
  });
  check('接口直接 400 并说清原因', badMirror.status === 400 && /不能有空格、引号/.test(badMirror.body?.error ?? ''), badMirror.body?.error?.slice(0, 60));
  const goodMirror = await req(`/api/nodes/${NODE}/tasks`, {
    method: 'POST',
    body: { kind: 'external-install', family: 'magpie', mirror: MIRROR },
  });
  check('合法镜像排得上，且回执里写明要跑什么', goodMirror.status === 201 && (goodMirror.body?.willRun ?? '').includes(MIRROR), goodMirror.body?.willRun?.slice(0, 80));
  check('任务里存着这个参数（节点据此选命令）', goodMirror.body?.task?.arg === MIRROR, String(goodMirror.body?.task?.arg));

  console.log('\n⑦ 输出不会无限涨');
  const big = 'x'.repeat(9000);
  await req(`/api/nodes/${NODE}/tasks/${id2}/report`, { method: 'POST', body: { output: big } });
  const capped = await req(`/api/nodes/${NODE}/tasks/${id2}`);
  check('只留末尾一段（不会把库撑起来）', (capped.body?.task?.output ?? '').length <= 8100, String((capped.body?.task?.output ?? '').length));
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err));
  if (String(err?.name) === 'AbortError') console.log('（请求超时 = 请求挂住了）');
  console.log(log.slice(-400));
  failed += 1;
} finally {
  try { server.kill(); } catch { /* 退了 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 算了 */ }
}

console.log(failed ? `\n✗ ${failed} 项没过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
