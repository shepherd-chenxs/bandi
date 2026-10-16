#!/usr/bin/env node
/**
 * 一个最小的 MCP server（stdio 传输），只为了**实测**连接器那条线：
 * 起得来、握得上手、工具能列出来、调用能回话。
 *
 * 零依赖，不进 data、不进协议之外的东西。stdout 是协议通道，调试信息一律走 stderr。
 *
 * 用法（一般不用手跑，smoke-mcp.mjs 会拉起它）：
 *   node apps/server/src/fixtures/mcp-echo.mjs
 */

const SERVER_INFO = { name: 'bandi-echo', version: '0.1.0' };
const TOOL = {
  name: 'echo',
  description: '把传入的 text 原样回显，用来验证 MCP 链路是否打通。',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: '要回显的文本' } },
    required: ['text'],
    additionalProperties: false,
  },
};

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

function handle(msg) {
  const { id, method, params } = msg;
  // 通知（没有 id）不需要回话
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (id === undefined) return;
  switch (method) {
    case 'initialize':
      // 回客户端要的协议版本：最小实现里这是最兼容的做法
      return ok(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: [TOOL] });
    case 'tools/call': {
      if (params?.name !== TOOL.name) return fail(id, -32602, `未知工具：${params?.name}`);
      const text = params?.arguments?.text ?? '';
      return ok(id, { content: [{ type: 'text', text: `echo: ${text}` }], isError: false });
    }
    case 'resources/list':
      return ok(id, { resources: [] });
    case 'resources/templates/list':
      return ok(id, { resourceTemplates: [] });
    case 'prompts/list':
      return ok(id, { prompts: [] });
    default:
      return fail(id, -32601, `未实现的方法：${method}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (err) {
      process.stderr.write(`[mcp-echo] 收到解析不了的一行：${String(err?.message ?? err)}\n`);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
process.stderr.write('[mcp-echo] 起了\n');
