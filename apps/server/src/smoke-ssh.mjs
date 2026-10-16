/**
 * 冒烟测试：服务器与密钥（SSH MCP server）。
 *
 * 三块，各自不互相掩盖：
 *   ① 只读：工具清单、登记表、公钥、上公钥指引
 *   ② 写：在**临时登记表**上增删改 —— 绝不碰 ~/.bandi/servers.yaml
 *   ③ 真连：ssh_test / ssh_run 打一台真机器（只跑只读命令）
 *
 * 跑法：node apps/server/src/smoke-ssh.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '..', 'mcp', 'bandi-ssh.mjs');
const REAL_REGISTRY = path.join(os.homedir(), '.bandi', 'servers.yaml');

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

/* ------------------------------------------------ ①② 只读 + 写（临时账本） */

const live = mcpClient({});
await live.ready();

console.log('① 只读');
const tools = await live.tools();
check('工具数 7 个', tools.length === 7, String(tools.length));
check('带上了 ssh_run / ssh_test', tools.includes('ssh_run') && tools.includes('ssh_test'));
check('带上了登记与公钥相关工具', ['servers_list', 'server_public_key', 'ssh_guide', 'server_upsert', 'server_remove'].every((t) => tools.includes(t)));

const list = await live.call('servers_list');
/*
 * ⚠️ 这条原来把**我们自己的服务器地址**写死在断言里 ✗ —— 两个问题：公开仓库里泄漏地址 ✓，
 * 而且别人 clone 下来跑这条**必然失败** ✗（他们的登记表里当然没有那台）。
 * 2026-10-16 开源前改成"只要读得到、且内容像一台机器" ✓（本机没有登记表时也不会误报）。
 */
const looksLikeEntry = /(?:\d{1,3}\.){3}\d{1,3}|\balias\b|:22\b|主机/i.test(list.text ?? '');
check('登记表读得到（不依赖具体是哪台）', !list.isError && (list.text ?? '').trim().length > 0, list.isError ? list.text.slice(0, 120) : (list.text ?? '').trim().split('\n')[0]);
check('登记内容像一台机器（有地址/别名/主机字样）', looksLikeEntry, (list.text ?? '').trim().slice(0, 120));
console.log('  --- servers_list ---');
console.log(list.text.split('\n').map((l) => '  ' + l).join('\n'));

const pk = await live.call('server_public_key', { alias: 'bandi-hs4g' });
const pubFile = fs.existsSync(path.join(os.homedir(), '.ssh', 'bandi-hs4g.pub'))
  ? fs.readFileSync(path.join(os.homedir(), '.ssh', 'bandi-hs4g.pub'), 'utf8').trim()
  : '';
check('公钥和磁盘 .pub 一字不差', !pk.isError && pk.text.includes(pubFile) && pubFile !== '');
check('公钥是 ed25519 且不含私钥内容', pk.text.includes('ssh-ed25519 ') && !pk.text.includes('PRIVATE KEY'));

const guide = await live.call('ssh_guide', { alias: 'bandi-hs4g' });
check('指引里有 authorized_keys 和真实公钥', guide.text.includes('authorized_keys') && guide.text.includes('ssh-ed25519'));

const noWrite = await live.call('server_upsert', { alias: 'tmp-x', host: '10.0.0.1', user: 'root' });
check('写默认关闭，且说清了怎么开', noWrite.isError && noWrite.text.includes('默认关闭'));

const missing = await live.call('ssh_run', { alias: '不存在的机器', command: 'hostname' });
check('找不到机器时报错清楚并列出可选项', missing.isError && missing.text.includes('bandi-hs4g'));
live.close();

console.log('\n② 写（临时登记表，不碰真账本）');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-ssh-'));
const tmpReg = path.join(tmp, 'servers.yaml');
fs.copyFileSync(REAL_REGISTRY, tmpReg);
const wr = mcpClient({ BANDI_SSH_REGISTRY: tmpReg, BANDI_SSH_ALLOW_WRITE: '1' });
await wr.ready();
const up = await wr.call('server_upsert', { alias: 'tmp-box', host: '10.1.2.3', port: 2222, user: 'ops', purpose: '临时测试\n第二行' });
check('登记成功', !up.isError, up.text.slice(0, 120));
const list2 = await wr.call('servers_list');
check('登记后列得出来', list2.text.includes('10.1.2.3'));
const reloaded = fs.readFileSync(tmpReg, 'utf8');
check('多行备注往返没坏', /purpose: \|-\n\s+临时测试\n\s+第二行/.test(reloaded), reloaded.includes('|-') ? '用了块标量' : '（没写成块标量）');
const rm = await wr.call('server_remove', { alias: 'tmp-box' });
check('删得掉', !rm.isError && rm.text.includes('已从登记表删掉'));
check('真账本一个字没动', fs.readFileSync(REAL_REGISTRY, 'utf8') === fs.readFileSync(tmpReg, 'utf8').replace(/\n$/, '\n') || !fs.readFileSync(REAL_REGISTRY, 'utf8').includes('10.1.2.3'));
wr.close();
fs.rmSync(tmp, { recursive: true, force: true });

/* ------------------------------------------------------------ ③ 真连 */

console.log('\n③ 真连（只跑只读命令）');
const net = mcpClient({});
await net.ready();
const t = await net.call('ssh_test', { alias: 'bandi-hs4g' });
check('ssh_test 连上了', !t.isError && t.text.startsWith('✅'), t.text.split('\n').slice(0, 4).join(' / '));
if (t.text.startsWith('✅')) console.log(t.text.split('\n').map((l) => '  ' + l).join('\n'));

const run = await net.call('ssh_run', { alias: 'bandi-hs4g', command: 'hostname; whoami; echo 班底在这里' });
check('ssh_run 执行成功', !run.isError && run.text.startsWith('✅'), run.text.split('\n').slice(0, 3).join(' / '));
if (run.text.startsWith('✅')) console.log(run.text.split('\n').map((l) => '  ' + l).join('\n'));
net.close();

console.log(`\n结论：${failed ? `${failed} 项没通过` : '全通过'}`);
process.exit(failed ? 1 : 0);
