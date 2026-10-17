/**
 * 冒烟测试：服务器与密钥（SSH MCP server）。
 *
 * 三块，各自不互相掩盖：
 *   ① 只读：工具清单、登记表、公钥、上公钥指引 —— 跑在**临时夹具登记表**上
 *   ② 写：在夹具上增删改 —— 绝不碰 ~/.bandi/servers.yaml
 *   ③ 真连：打一台真机器（只跑只读命令）—— **可选**，设了 `BANDI_SSH_LIVE=<别名>` 才跑
 *
 * ⚠️ 2026-10-17 改：原来 ① 断言**本机**登记表里有某台机器、还比对磁盘上的 ~/.ssh/*.pub，
 *    ② 无条件把真登记表拷进临时目录，③ 直接连那台机器 —— 换台机器（CI、新同事）必然挂。
 *    现在：夹具自己造（登记与公钥都在临时目录里现造），真连那半截改成**显式 opt-in**。
 *    教训写在 docs/审阅经验.md 第一条（测试不许依赖开发者本机状态）。
 *
 * 跑法：node apps/server/src/smoke-ssh.mjs
 *       BANDI_SSH_LIVE=某台机器 node apps/server/src/smoke-ssh.mjs   # 连上真机器再验一遍
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '..', 'mcp', 'bandi-ssh.mjs');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

/** 一个够用的 MCP 客户端：起进程、按 id 对回包 */
function mcpClient(env) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let stderr = '';
  const pending = new Map();
  let nextId = 1;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => (stderr += c));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const slot = pending.get(msg.id);
      if (slot) {
        pending.delete(msg.id);
        slot(msg);
      }
    }
  });

  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 90000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');

  return {
    ready: async () => {
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
      notify('notifications/initialized');
    },
    tools: async () => (await rpc('tools/list')).result.tools.map((t) => t.name),
    call: async (name, args) => {
      const res = await rpc('tools/call', { name, arguments: args ?? {} });
      const text = res.result?.content?.[0]?.text ?? '';
      return { isError: res.result?.isError === true, text, raw: res };
    },
    stderr: () => stderr,
    close: () => {
      try {
        child.kill();
      } catch {
        /* 已退 */
      }
    },
  };
}

/* ------------------------------------------------------- 夹具（现造，不碰本机） */

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-ssh-'));
const KEY_DIR = path.join(work, 'keys');
fs.mkdirSync(KEY_DIR);
const ALIAS = 'fixture-box';
const PUB_TEXT = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureKeyForSmokeTestOnly000000000000 smoke@fixture';
const KEY_PATH = path.join(KEY_DIR, ALIAS);
fs.writeFileSync(`${KEY_PATH}.pub`, PUB_TEXT + '\n', 'utf8');
const REG = path.join(work, 'servers.yaml');

console.log('⓪ 夹具（临时登记表 + 临时公钥，跟本机的 ~/.bandi 无关）');
{
  const seed = mcpClient({ BANDI_SSH_REGISTRY: REG, BANDI_SSH_ALLOW_WRITE: '1' });
  await seed.ready();
  const r = await seed.call('server_upsert', { alias: ALIAS, host: '10.0.0.9', port: 22, user: 'ops', key_path: KEY_PATH, purpose: '冒烟夹具' });
  check('夹具造出来了', !r.isError, r.text.slice(0, 120));
  seed.close();
}

/* ------------------------------------------------------ ① 只读（夹具登记表） */

console.log('\n① 只读');
const live = mcpClient({ BANDI_SSH_REGISTRY: REG });
await live.ready();
const tools = await live.tools();
check('工具数 7 个', tools.length === 7, String(tools.length));
check('带上了 ssh_run / ssh_test', tools.includes('ssh_run') && tools.includes('ssh_test'));
check('带上了登记与公钥相关工具', ['servers_list', 'server_public_key', 'ssh_guide', 'server_upsert', 'server_remove'].every((t) => tools.includes(t)));

const list = await live.call('servers_list');
check('登记表读得到', !list.isError && list.text.includes(ALIAS), list.isError ? list.text.slice(0, 120) : list.text.trim().split('\n')[0]);
console.log('  --- servers_list ---');
console.log(list.text.split('\n').map((l) => '  ' + l).join('\n'));

const pk = await live.call('server_public_key', { alias: ALIAS });
check('公钥就是夹具里那把（一字不差）', !pk.isError && pk.text.includes(PUB_TEXT), pk.isError ? pk.text.slice(0, 120) : '');
check('公钥是 ed25519 且不含私钥内容', pk.text.includes('ssh-ed25519 ') && !pk.text.includes('PRIVATE KEY'));

const guide = await live.call('ssh_guide', { alias: ALIAS });
check('指引里有 authorized_keys 和真实公钥', guide.text.includes('authorized_keys') && guide.text.includes('ssh-ed25519'));

const noWrite = await live.call('server_upsert', { alias: 'tmp-x', host: '10.0.0.1', user: 'root' });
check('写默认关闭，且说清了怎么开', noWrite.isError && noWrite.text.includes('默认关闭'));

const missing = await live.call('ssh_run', { alias: '不存在的机器', command: 'hostname' });
check('找不到机器时报错清楚并列出可选项', missing.isError && missing.text.includes(ALIAS));
live.close();

// 只读客户端跑完，登记表应该**一个字没多**（它没有写权限）
const afterRead = fs.readFileSync(REG, 'utf8');
check('只读客户端没往登记表里写东西', !afterRead.includes('tmp-x') && (afterRead.match(/^ {2}- /gm) ?? []).length === 1, String((afterRead.match(/^ {2}- /gm) ?? []).length));

/* -------------------------------------------------------- ② 写（同一份夹具） */

console.log('\n② 写（夹具登记表，不碰真账本）');
const wr = mcpClient({ BANDI_SSH_REGISTRY: REG, BANDI_SSH_ALLOW_WRITE: '1' });
await wr.ready();
const up = await wr.call('server_upsert', { alias: 'tmp-box', host: '10.1.2.3', port: 2222, user: 'ops', key_path: path.join(KEY_DIR, 'tmp-box'), purpose: '临时测试\n第二行' });
check('登记成功', !up.isError, up.text.slice(0, 120));
const list2 = await wr.call('servers_list');
check('登记后列得出来', list2.text.includes('10.1.2.3'));
const reloaded = fs.readFileSync(REG, 'utf8');
check('多行备注往返没坏', /purpose: \|-\n\s+临时测试\n\s+第二行/.test(reloaded), reloaded.includes('|-') ? '用了块标量' : '（没写成块标量）');
const rm = await wr.call('server_remove', { alias: 'tmp-box' });
check('删得掉', !rm.isError && rm.text.includes('已从登记表删掉'));
const afterWrite = fs.readFileSync(REG, 'utf8');
check('删完那台不在了，夹具那台还在', !afterWrite.includes('10.1.2.3') && afterWrite.includes(ALIAS));
wr.close();

/* ------------------------------------------------------------- ③ 真连（可选） */

console.log('\n③ 真连（只跑只读命令）');
const liveAlias = process.env.BANDI_SSH_LIVE;
if (!liveAlias) {
  console.log('  · 跳过：没设 BANDI_SSH_LIVE=<登记表里的别名>。这一块要一台真机器与网络，');
  console.log('    不该在 CI / 别人机器上默认跑（设了就真连一次，只跑只读命令）。');
} else {
  const net = mcpClient({});
  await net.ready();
  const t = await net.call('ssh_test', { alias: liveAlias });
  check('ssh_test 连上了', !t.isError && t.text.startsWith('✅'), t.text.split('\n').slice(0, 4).join(' / '));
  if (t.text.startsWith('✅')) console.log(t.text.split('\n').map((l) => '  ' + l).join('\n'));

  const run = await net.call('ssh_run', { alias: liveAlias, command: 'hostname; whoami; echo 班底在这里' });
  check('ssh_run 执行成功', !run.isError && run.text.startsWith('✅'), run.text.split('\n').slice(0, 3).join(' / '));
  if (run.text.startsWith('✅')) console.log(run.text.split('\n').map((l) => '  ' + l).join('\n'));
  net.close();
}

fs.rmSync(work, { recursive: true, force: true });
console.log(`\n结论：${failed ? `${failed} 项没通过` : '全通过'}`);
process.exit(failed ? 1 : 0);
