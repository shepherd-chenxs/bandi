/**
 * 连接器**接线层**与权限档位的验收（2026-11-13）。
 *
 * 起因是马超那次实报，两件事叠在一起：
 *   · ssh 连接器账本开着、首轮提示词也注入了"你有 ssh 连接器"，但 claude 族根本没接线
 *     （resolve 走"还没接连接器"分支）→ 模型在 mcp__* 里搜不到工具，下结论"没有远程通道"；
 *   · 那三天他跑在 claude 的 default 档上，headless 下命令全拒，模型把"命令被拒"
 *     误诊成"本机没 git/ssh、沙箱拦网络"。
 *
 * 钉住的口径：
 *   ① claude 族真接线（--mcp-config 内容寻址文件，stdio/http/env 引用各一）；
 *   ② promptLines 以 resolve 的结果为准 —— 参数没生成，提示词就缩回去，不许骗模型；
 *   ③ codex / dsh 两条老路不回归；
 *   ④ runtimes 的 blocked：claude 族默认带 default/plan；老库存的旧默认 [] 跟随新口径，
 *      用户自己改过的原样保留。
 *
 * 隔离：临时账本 + 临时数据目录，不碰 data/ 里的真账；不起服务、不联网。
 * 跑法：node apps/server/src/smoke-connector-wiring.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-wiring-'));
process.env.BANDI_DATA = tmp;
process.env.BANDI_CONNECTORS = path.join(tmp, 'connectors.json');
process.env.BANDI_CONNECTORS_DIR = path.join(tmp, 'generated');

// ⚠️ 必须在设好环境变量之后再 import —— config 在模块加载时读环境变量
const connectors = await import('./connectors.mjs');
const runtimes = await import('./runtimes.mjs');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const readConfig = (wiring) => JSON.parse(fs.readFileSync(wiring.files[0], 'utf8'));

console.log('① claude 族真接线：stdio 连接器 → --mcp-config 内容寻址文件');
const saved = connectors.saveEntry('srv', {
  transport: 'stdio',
  command: process.execPath,
  args: ['echo.mjs'],
  env: { LITERAL: 'plain-value' },
});
check('登记成功', !!saved.connector, JSON.stringify(saved.error ?? ''));
const w1 = connectors.resolve('claude');
check('参数是 --mcp-config + 文件', w1.args.length === 2 && w1.args[0] === '--mcp-config' && !!w1.files[0], JSON.stringify(w1.args));
check('生成文件真实存在', fs.existsSync(w1.files[0]), w1.files[0]);
const cfg1 = readConfig(w1);
check('根键是 mcpServers', !!cfg1.mcpServers, Object.keys(cfg1).join(','));
const srv1 = cfg1.mcpServers.srv;
check('stdio 条目带 command / args / env', srv1?.command === process.execPath && Array.isArray(srv1?.args) && srv1?.env?.LITERAL === 'plain-value', JSON.stringify(srv1));
check('active 带上这条', w1.active.includes('srv'), JSON.stringify(w1.active));

console.log('\n② env 引用：缺变量的键丢弃、note 说清楚；字面量原样进');
connectors.saveEntry('refmiss', {
  transport: 'stdio',
  command: process.execPath,
  env: { TOKEN: 'env:BANDI_NO_SUCH_TOKEN_XYZ' },
});
const w2 = connectors.resolve('claude');
check('note 点名缺哪个变量', w2.notes.some((n) => /BANDI_NO_SUCH_TOKEN_XYZ/.test(n)), JSON.stringify(w2.notes));
const cfg2 = readConfig(w2);
check('缺引用的键没进文件', cfg2.mcpServers.refmiss?.env?.TOKEN === undefined, JSON.stringify(cfg2.mcpServers.refmiss));

console.log('\n③ http 连接器：type/url/headers，bearerTokenEnv 解析成 Authorization');
process.env.BANDI_TEST_BEARER = 'tok-123';
connectors.saveEntry('remote', {
  transport: 'streamable-http',
  url: 'https://example.com/mcp',
  bearerTokenEnv: 'BANDI_TEST_BEARER',
  headers: { 'X-Trace': 'env:BANDI_TEST_BEARER' },
});
const w3 = connectors.resolve('claude');
const remote = readConfig(w3).mcpServers.remote;
check('http 条目形状正确', remote?.type === 'http' && remote?.url === 'https://example.com/mcp', JSON.stringify(remote));
check('bearerTokenEnv → Authorization 头', remote?.headers?.Authorization === 'Bearer tok-123', JSON.stringify(remote?.headers));
check('headers 里的引用也解析', remote?.headers?.['X-Trace'] === 'tok-123', JSON.stringify(remote?.headers));
delete process.env.BANDI_TEST_BEARER;

console.log('\n④ promptLines 以 resolve 的结果为准（没接线就不许注入提示词）');
const lines = connectors.promptLines('claude');
check('接了线就有提示词', lines.length > 0 && lines.some((l) => l.includes('srv')), JSON.stringify(lines));
check('claude 的提示走 mcp__ 工具名口径', lines.some((l) => /mcp__/.test(l)), JSON.stringify(lines));
// 全部停用 → 参数生成不出来 → 提示词必须缩回空
for (const e of connectors.list()) connectors.setEnabled(e.id, false);
check('全部停用后 promptLines 回空（不许骗模型）', connectors.promptLines('claude').length === 0, JSON.stringify(connectors.promptLines('claude')));
connectors.setEnabled('srv', true);

console.log('\n⑤ codex / dsh 两条老路不回归');
const wc = connectors.resolve('codex');
check('codex 仍走 -c 参数', wc.args.length > 0 && wc.args[0] === '-c', JSON.stringify(wc.args.slice(0, 3)));
const wd = connectors.resolve('dsh');
check('dsh 仍走 --patch + 文件', wd.args[0] === '--patch' && !!wd.files[0] && fs.existsSync(wd.files[0]), JSON.stringify(wd.args));
check('dsh 的提示词口径是 tool_search', connectors.promptLines('codex').some((l) => /tool_search/.test(l)), '');

console.log('\n⑥ runtimes：claude 的 blocked 带 default/plan，存量旧默认 [] 跟随新口径');
// claude 默认（没存 blocked）→ 族默认
// 存了旧默认 []（建运行时那一刻存进去、从没改过）→ 跟随新口径
// 存了用户自己改的 ['plan'] → 原样保留
const savedJson = {
  devices: {
    local: {
      runtimes: {
        'rt-claude-a': { family: 'claude', path: 'C:/nowhere/claude.exe', blocked: [] },
        'rt-claude-b': { family: 'claude', path: 'C:/nowhere/claude.exe', blocked: ['plan'] },
        'rt-claude-c': { family: 'claude', path: 'C:/nowhere/claude.exe' },
        // publicList 只出**存过盘**的实例 —— codex 也要写一条，才能断言它的口径没被波及
        'rt-codex-a': { family: 'codex', path: 'C:/nowhere/codex.js' },
      },
    },
  },
};
fs.writeFileSync(path.join(tmp, 'runtimes.json'), JSON.stringify(savedJson, null, 2), 'utf8');
const pub = Object.fromEntries(runtimes.publicList().map((r) => [r.id, r]));
check('族默认 = [default, plan]', JSON.stringify(pub['rt-claude-c']?.blocked) === JSON.stringify(['default', 'plan']), JSON.stringify(pub['rt-claude-c']?.blocked));
check('存的旧默认 [] 迁移到新口径', JSON.stringify(pub['rt-claude-a']?.blocked) === JSON.stringify(['default', 'plan']), JSON.stringify(pub['rt-claude-a']?.blocked));
check('用户改过的 [plan] 原样保留', JSON.stringify(pub['rt-claude-b']?.blocked) === JSON.stringify(['plan']), JSON.stringify(pub['rt-claude-b']?.blocked));
check('codex 的 blocked 口径不变', JSON.stringify(Object.values(pub).find((r) => r.family === 'codex')?.blocked) === JSON.stringify(['workspace-write', 'read-only']), '');
check('claude 的 sandboxes 仍是四档', pub['rt-claude-c']?.sandboxes?.length === 4, JSON.stringify(pub['rt-claude-c']?.sandboxes));

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 临时目录，删不掉就算了 */
}
console.log(`\n结论：${failed ? `有 ${failed} 项没通过` : '全通过'}`);
process.exit(failed ? 1 : 0);
