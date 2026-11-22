// 手动跑：node tools/check-connjson.mjs —— 连接器 JSON 框的解析/生成（纯函数，见 apps/web/js/connjson.mjs）
import { parseConnJson, connJsonText, connBrief, toolsBrief } from '../apps/web/js/connjson.mjs';

let bad = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`}`);
};

// 1. Claude Desktop 整段（两条，含别家 ref 写法与不认识的键）
const full = `{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "\${GITHUB_PERSONAL_ACCESS_TOKEN}", "DEBUG": "1" },
      "alwaysAllow": ["search"]
    },
    "remote": { "type": "http", "url": "https://x.example/mcp", "headers": { "Authorization": "Bearer abc" } }
  }
}`;
const a = parseConnJson(full);
eq('整段：条数', a.list.length, 2);
eq('整段：github.transport', a.list[0][1].transport, 'stdio');
eq('整段：github.env 引用归一', a.list[0][1].env, { GITHUB_PERSONAL_ACCESS_TOKEN: 'env:GITHUB_PERSONAL_ACCESS_TOKEN', DEBUG: '1' });
eq('整段：github.args', a.list[0][1].args, ['-y', '@modelcontextprotocol/server-github']);
eq('整段：认不出的键被报出来', a.ignored, ['github.alwaysAllow']);
eq('整段：remote 判成 http', a.list[1][1].transport, 'streamable-http');
eq('整段：remote.url', a.list[1][1].url, 'https://x.example/mcp');
eq('整段：http 不吃 env（没写就不进 body）', 'env' in a.list[1][1], false);

// 2. 单条内层对象（最常见的手粘形态），没写 type 靠 url 判
const one = parseConnJson(`{"command":"node","args":["E:/a.mjs"]}`);
eq('单条：id 自动生成', one.list[0][0], one.list[0][1].id);
eq('单条：command', one.list[0][1].command, 'node');
eq('单条：默认 label = id', one.list[0][1].label, one.list[0][0]);

// 3. 顶层直接 id→配置
const bare = parseConnJson(`{"memory":{"command":"npx","args":["-y","@mcp/memory"]}}`);
eq('顶层表：id', bare.list[0][0], 'memory');

// 4. \${env:X} 形态
const ref = parseConnJson(`{"m":{"command":"x","env":{"TOKEN":"\${env:MY_TOKEN}"}}}`);
eq('${env:X} 归一', ref.list[0][1].env.TOKEN, 'env:MY_TOKEN');

// 5. runtime 扩展字段透传 + enabled:false
const ext = parseConnJson(`{"m":{"command":"x","runtimes":["codex"],"enabled":false}}`);
eq('runtimes 透传', ext.list[0][1].runtimes, ['codex']);
eq('enabled:false', ext.list[0][1].enabled, false);

// 6. 报错：非法 JSON / 空 / 顶层数组
for (const [name, txt] of [['非法 JSON', '{"a":'], ['空', '   '], ['顶层数组', '[1,2]']]) {
  let msg = '';
  try { parseConnJson(txt); } catch (e) { msg = e.message; }
  console.log(`${msg ? '✓' : '✗'} 报错：${name} → ${msg || '(没报错)'}`);
  if (!msg) bad++;
}

// 7. 回填：账本条目 → 文本。**env 不出现在文本里**（值不下发，硬填会改坏凭据）
const entry = {
  id: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], cwd: '',
  env: [{ key: 'GH_TOKEN', kind: 'ref' }], headers: [], bearerTokenEnv: '', runtimes: ['codex'],
};
const text = connJsonText(entry);
const back = parseConnJson(text);
eq('回填：id', back.list[0][0], 'github');
eq('回填：runtimes 透传', back.list[0][1].runtimes, ['codex']);
eq('回填：不带 env（否则"看一眼再保存"会改坏凭据）', 'env' in back.list[0][1], false);
eq('回填：文本里也没有 env', /"env"/.test(text), false);
console.log('\n--- 回填文本 ---\n' + text);

// 8. 「没写」≠「清空」：PATCH 靠这条保住原有凭据（服务端 saveEntry 是 merge）
eq('没写 env：body 里没有 env 键', 'env' in parseConnJson('{"m":{"command":"x"}}').list[0][1], false);
eq('显式 env:{}：body 里是空对象（用户明确要清）', parseConnJson('{"m":{"command":"x","env":{}}}').list[0][1].env, {});
eq('http 写了 headers：照传', parseConnJson('{"m":{"type":"http","url":"https://a.example/b","headers":{"X":"1"}}}').list[0][1].headers, { X: '1' });
eq('http 没写 headers：不碰', 'headers' in parseConnJson('{"m":{"type":"http","url":"https://a.example/b"}}').list[0][1], false);

// 9. 卡片简述：只留能认出来的称呼，绝不吐完整路径（2026-11-22 用户："这个改成简述"）
eq('简述：绝对路径只留文件名', connBrief({ transport: 'stdio', command: 'E:\\a\\node_modules\\electron\\dist\\electron.exe', args: ['E:\\a\\dist\\headless\\bridge.cjs'] }), 'electron.exe bridge.cjs');
eq('简述：包名原样，不被后面的目录带偏', connBrief({ transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'E:\\某个目录'] }), 'npx @modelcontextprotocol/server-filesystem');
eq('简述：node + 绝对路径', connBrief({ transport: 'stdio', command: 'node', args: ['E:\\a\\mcp\\x.mjs'] }), 'node x.mjs');
eq('简述：远端只给域名', connBrief({ transport: 'streamable-http', command: '', args: [], url: 'https://example.com/mcp' }), 'example.com');
eq('简述：什么都没有时兜底', connBrief({ transport: 'stdio', command: '', args: [] }), '本地进程');

// 10. 工具清单 → 能力简述（卡片第三行"接过来的能力"）
eq('工具：去掉连接器 id 前缀', toolsBrief(['baoluo_parse_link', 'baoluo_download']), 'parse link、download');
eq('工具：超过 5 个收成"等 N 个工具"', toolsBrief(['a_x', 'a_y', 'a_z', 'a_p', 'a_q', 'a_r']), 'x、y、z、p、q 等 6 个工具');
eq('工具：没有公共前缀就不切', toolsBrief(['get_issue', 'create_issue']), 'get issue、create issue');
eq('工具：空清单返回空串（卡片退回下一个兜底）', toolsBrief([]), '');

console.log(bad ? `\n✗ ${bad} 项不对` : '\n全部通过');
process.exit(bad ? 1 : 0);
