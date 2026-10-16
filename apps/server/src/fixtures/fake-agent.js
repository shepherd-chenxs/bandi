#!/usr/bin/env node
/**
 * 假 agent CLI —— **只给测试用**。按 codex 的事件词汇吐几行 JSON 就退出。
 *
 * 为什么要有它：领活那条链路要验的是"活被节点领走 → 在**那台机器**上执行 → 事件回传到控制面 →
 * 流到界面"，这跟真去烧一遍模型无关。用一个确定的假 CLI，测试才不飘、也不花钱。
 *
 * ⚠️ 故意用 **`.js`**（不是 `.mjs`）：`launchable()` 对 codex 族只认 `.js` ——
 * 那条规则来自一次真实事故（PATH 上的 `codex.cmd` 被喂进 node 直接 EINVAL）。
 * 它是 CommonJS 也照样跑（不 import，只用一个 async main）。
 *
 * 认的参数（与 codex 一致：任务从 **stdin** 读）：
 *   `--version`              打印版本就退（探测路径用）
 *   `exec --json ...`        真跑
 *   `exec resume <id>`       续接：把那个 id 原样当 thread_id 吐回去
 *
 * 环境开关：
 *   `BANDI_FAKE_FAIL=1`      演一次"跑挂"（error + turn.failed，退出码 1）
 *   `BANDI_FAKE_SLEEP_MS`    开工前先睡一会儿（用来验"一声不吭时也能被掐掉"）
 */
const argv = process.argv.slice(2);

if (argv.includes('--version')) {
  process.stdout.write('fake-agent 0.0.1\n');
  process.exit(0);
}

const resumeAt = argv.indexOf('resume');
const threadId = resumeAt >= 0 ? argv[resumeAt + 1] : 'fake-thread-0001';

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 任务从 stdin 读（和 codex 一样：命令行上不出现用户输入）
  let task = '';
  for await (const chunk of process.stdin) task += chunk;

  const sleepMs = Number(process.env.BANDI_FAKE_SLEEP_MS ?? 0);
  if (sleepMs > 0) await sleep(sleepMs);

  out({ type: 'thread.started', thread_id: threadId });
  out({ type: 'turn.started' });
  out({ type: 'item.completed', item: { type: 'reasoning', text: '先把任务看一眼' } });
  // 一次"工具动作"，验工具事件也能回传
  out({ type: 'item.completed', item: { type: 'command_execution', command: 'echo hi' } });

  if (process.env.BANDI_FAKE_FAIL === '1') {
    out({ type: 'error', message: '假 CLI 故意失败' });
    out({ type: 'turn.failed', error: { message: '假 CLI 故意失败' } });
    process.exit(1);
  }

  const head = task.replace(/\s+/g, ' ').trim().slice(0, 60);
  out({ type: 'item.completed', item: { type: 'agent_message', text: `FAKE-OK：${head}` } });
  out({ type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 22, cached_input_tokens: 3 } });
  process.exit(0);
}

main();
