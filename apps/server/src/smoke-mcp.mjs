/**
 * 冒烟测试：连接器（MCP）透传 —— 一次跑完"登记 → 生成参数 → 真调用"。
 *
 * 覆盖：
 *   ① 静态：登记一条 MCP 连接器，看 codex / dsh 各自生成什么启动参数（不花钱、不联网）
 *   ② 实测：真起一次 codex、一次 dsh，让模型调用那个 MCP 工具，在事件流里抓工具痕迹
 *
 * 跑法：
 *   node apps/server/src/smoke-mcp.mjs          # 全跑（会真的调模型）
 *   node apps/server/src/smoke-mcp.mjs --dry    # 只跑静态部分
 *
 * 隔离：账本和生成的覆盖层都写到临时目录（BANDI_CONNECTORS / BANDI_CONNECTORS_DIR），
 * 跑完删掉 —— **不碰 data/connectors.json**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dry = process.argv.includes('--dry');
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').split('=')[1] ?? '';
const wants = (name) => !only || only === name;

// 账本里那条连接器引用了这个环境变量：给它一个值，让"引用能不能落地"这件事也被测到
process.env.BANDI_ECHO_TOKEN = process.env.BANDI_ECHO_TOKEN ?? 'demo-token';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-connectors-'));
process.env.BANDI_CONNECTORS = path.join(tmpDir, 'connectors.json');
process.env.BANDI_CONNECTORS_DIR = path.join(tmpDir, 'generated');

/** dsh 的模型凭据：本进程环境里没有就从 $DSH_HOME/.env 借一下（只影响这次测试，不回显值） */
function borrowGatewayKey() {
  if (process.env.MAGPIE_GATEWAY_KEY) return 'environment';
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  try {
    const line = fs
      .readFileSync(path.join(home, '.env'), 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith('MAGPIE_GATEWAY_KEY='));
    if (!line) return null;
    process.env.MAGPIE_GATEWAY_KEY = line.slice('MAGPIE_GATEWAY_KEY='.length).trim();
    return path.join(home, '.env');
  } catch {
    return null;
  }
}
const keyFrom = borrowGatewayKey();

const connectors = await import('./connectors.mjs');
const runtimes = await import('./runtimes.mjs');
const { runTask } = await import('./codex.mjs');
const { runDsh } = await import('./dsh.mjs');

// 适配器里已经没有写死的默认路径了（那玩意儿只在开发那台机器上成立），
// 所以真跑之前得先探测出可执行文件在哪儿 —— 跟界面同一套。
const cliOf = (fam) => runtimes.detectFamily(fam)?.[0]?.path ?? null;
const cliCodex = cliOf('codex');
const cliDsh = cliOf('dsh');

const FIXTURE = path.join(here, 'fixtures', 'mcp-echo.mjs');
const TASK =
  '现在请调用 echo 工具（工具名里含 echo），text 参数传：班底。然后只回复该工具返回的那一行内容，不要加任何别的话。';

let failed = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
}

const cleanup = () => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 删不掉就算了 */
  }
};

try {
  /* ---------------------------------------------- ① 静态 */
  console.log('① 静态：登记一条 MCP 连接器，看两个运行时各自生成什么');
  const saved = connectors.saveEntry('echo', {
    label: '回声（fixture）',
    source: { kind: 'local', ref: FIXTURE },
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    env: { ECHO_TOKEN: 'env:BANDI_ECHO_TOKEN' },
  });
  if (saved.error) throw new Error('登记失败：' + saved.error);
  console.log('  账本：' + JSON.stringify(connectors.publicList()[0]));

  const forCodex = connectors.resolve('codex');
  console.log('  codex 参数：' + JSON.stringify(forCodex.args));
  check('codex 挂上了 mcp_servers.echo.command', forCodex.args.join(' ').includes('mcp_servers.echo.command'));
  check('codex 参数里带上了 fixture 路径', forCodex.args.join(' ').includes('mcp-echo.mjs'));
  check('codex 如实报告了"引用型环境变量没接"', forCodex.notes.some((n) => n.includes('环境变量引用')));

  const forDsh = connectors.resolve('dsh');
  console.log('  dsh 参数：' + JSON.stringify(forDsh.args));
  const patch = forDsh.files[0];
  check('dsh 给的是 --patch 且文件真的在', forDsh.args[0] === '--patch' && !!patch && fs.existsSync(patch));
  const yml = patch ? fs.readFileSync(patch, 'utf8') : '';
  console.log('--- 生成的 dsh 覆盖层 ---');
  console.log(yml.trimEnd());
  console.log('-----------------------');
  check('覆盖层 insert 了 dsh-mcp-client', yml.includes("@deepseek-ai/dsh-mcp-client"));
  check('覆盖层 serverName 正确', /serverName: 'echo'/.test(yml));
  check('引用写成了 !!js process.env.*（密钥不进文件）', yml.includes('!!js process.env.BANDI_ECHO_TOKEN'));
  check('未登记的运行时不受影响（claude 返回空）', connectors.resolve('claude').args.length === 0);

  if (!dry && wants('codex')) {
    /* -------------------------------------------- ② 实测 codex */
    console.log('\n② 实测 codex：真跑一次，让模型调用这个 MCP 工具');
    const codexRun = await runTask({
      cliPath: cliCodex,
      task: TASK,
      sandbox: 'danger-full-access',
      connectorArgs: forCodex.args,
      onEvent: (e) => console.log('   [evt]', e.type, e.phase ?? '', e.name ?? e.text ?? ''),
    });
    report('codex', codexRun, codexRun.rawEvents ?? codexRun.events ?? []);

  }
  if (!dry && wants('dsh')) {
    /* ---------------------------------------------- ③ 实测 dsh */
    console.log('\n③ 实测 dsh：真跑一次，让模型调用这个 MCP 工具');
    if (keyFrom === null) {
      console.log('  ⚠ 没有 MAGPIE_GATEWAY_KEY（环境变量和 $DSH_HOME/.env 都没有），dsh 这条跑不了');
    }
    console.log(`  （凭据来源：${keyFrom ?? '无'}${keyFrom && keyFrom !== 'environment' ? '，只用于本次测试' : ''}）`);
    const dshRun = await runDsh({
      cliPath: cliDsh,
      task: TASK,
      connectorArgs: forDsh.args,
      onEvent: (e) => console.log('   [evt]', e.type, e.phase ?? '', e.name ?? e.text ?? ''),
    });
    report('dsh', dshRun, dshRun.events ?? []);
  }
  if (dry) console.log('\n--dry：静态部分到此为止');
} finally {
  cleanup();
}

function report(name, res, events) {
  const blob = events.map((e) => JSON.stringify(e));
  const hits = blob.filter((s) => /mcp|echo/i.test(s));
  console.log(`  session : ${res.sessionId}`);
  console.log(`  final   : ${JSON.stringify(String(res.finalText ?? '').slice(0, 200))}`);
  console.log(`  exitCode: ${res.exitCode}`);
  if (res.stderr) console.log('  stderr  : ' + JSON.stringify(String(res.stderr).slice(0, 1200)));
  console.log(`  事件里带 mcp/echo 的痕迹：${hits.length} 条`);
  for (const h of hits.slice(0, 4)) console.log('    · ' + h.slice(0, 300));
  console.log('  事件类型：' + JSON.stringify([...new Set(events.map((e) => e.type))]));

  const calledTool = hits.length > 0;
  const answered = /echo:\s*班底/.test(String(res.finalText ?? ''));
  check(`${name}：退出码 0`, res.exitCode === 0, res.exitCode === 0 ? '' : JSON.stringify(res.stderr ?? '').slice(0, 200));
  check(`${name}：事件流里出现 MCP 工具痕迹`, calledTool, calledTool ? '' : '没看到（模型可能没调工具）');
  check(`${name}：工具真的回话了（final 含 echo: 班底）`, answered);
}

console.log(`\n结论：${failed ? `${failed} 项没通过` : '全通过'}`);
process.exit(failed ? 1 : 0);
