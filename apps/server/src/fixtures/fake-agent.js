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
 *   `BANDI_FAKE_CREATE_CARD=1`：任务文本里带 `【建卡】{...请求体JSON...}`（单行）时，
 *                            真调一次"工作证"建卡接口，结果回进 agent_message ——
 *                            验冒名/权限/建卡全链路用。带 `【批量建卡】{...}` 时改调
 *                            批量口（`cards` 数组），回 `FAKE-BATCH:<status>:<张数>:<去重张数>`；
 *                            带 `【改卡】{"id","body"}` 时 PATCH 那张卡（验运行钥匙改卡权限），
 *                            回 `FAKE-PATCH:<status>:<code>:<新状态>`。
 *                            没有标记就不建 —— 防"建卡 → 指派 → 下一环又建卡"滚雪球。
 *   `BANDI_FAKE_PROBE=1`：用运行钥匙（X-Bandi-Run-Token）挨个打几扇平台门，把
 *                            HTTP 状态回进 agent_message（`FAKE-PROBE:{...}`）——
 *                            验"强制鉴权模式下钥匙能开哪几扇门"（2026-11-08 补）。
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

  // BANDI_FAKE_ECHO=full：把**整个任务**回显出来（任务卡锚点断言用）——默认只回前 60 字，
  // 别处只认 /FAKE-OK/ 正则，加长不影响，但回显全文会让回复很长，还是用开关圈死在需要的冒烟里。
  const head = task.replace(/\s+/g, ' ').trim().slice(0, 60);
  const echo = process.env.BANDI_FAKE_ECHO === 'full' ? task.replace(/\s+/g, ' ').trim() : head;

  /*
   * 交付声明（2026-11-09 P4，判据见 apps/server/src/delivery-claim.mjs）：假 CLI 默认演
   * "干完了"，所以回话第一个非空行带 `[完成]` —— 否则按新口径，所有卡都会被如实收成
   * 「已阻塞」（没交回可验收结论），原来那批验"跑完收待验收"的用例就全红了，测的却不是
   * 它们要测的事。要演"这轮没交回结论"，用 `BANDI_FAKE_NO_CLAIM=1`。
   */
  const claim = process.env.BANDI_FAKE_NO_CLAIM === '1' ? '' : '[完成] ';

  // 「工作证」建卡（见上面的开关说明）：真的去调控制面，结果回进回复文本里给冒烟断言
  let cardNote = '';
  if (process.env.BANDI_FAKE_CREATE_CARD === '1') {
    const call = async (path, body) => {
      const r = await fetch(process.env.BANDI_CONTROL_URL + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bandi': '1',
          'X-Bandi-Run-Token': process.env.BANDI_RUN_TOKEN ?? '',
        },
        body,
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    // 批量口（2026-11-09）：`【批量建卡】{...}` → POST /api/agent/cards/batch；
    // 回 `FAKE-BATCH:<status>:<张数>:<去重张数>` —— 验"一次建一批"和"幂等重发"。
    // ⚠️ 取证要看**最后出现**的那个标记：群聊/续接会话的任务里会带上历史消息，
    //   前面几轮的标记也在文本里；最新那条指令才是这一轮要执行的。
    const lastOf = (re) => [...task.matchAll(re)].at(-1) ?? null;
    const picked = [
      { kind: 'batch', m: lastOf(/【批量建卡】(\{[^\n]*\})/g) },
      { kind: 'card', m: lastOf(/【建卡】(\{[^\n]*\})/g) },
      // 【改卡】（2026-11-09）：`{"id":"pt-…","body":{…}}` → PATCH 卡（验运行钥匙的改卡权限）
      { kind: 'patch', m: lastOf(/【改卡】(\{[^\n]*\})/g) },
    ]
      .filter((x) => x.m)
      .sort((a, b) => a.m.index - b.m.index)
      .at(-1) ?? null;
    const batchBody = picked?.kind === 'batch' ? picked.m[1] : null;
    const cardBody = picked?.kind === 'card' ? picked.m[1] : null;
    const patchBody = picked?.kind === 'patch' ? picked.m[1] : null;
    if (patchBody) {
      try {
        const spec = JSON.parse(patchBody);
        const r = await fetch(process.env.BANDI_CONTROL_URL + '/api/projects/tasks/' + encodeURIComponent(String(spec.id ?? '')), {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-Bandi': '1',
            'X-Bandi-Run-Token': process.env.BANDI_RUN_TOKEN ?? '',
          },
          body: JSON.stringify(spec.body ?? {}),
        });
        const b = await r.json().catch(() => ({}));
        cardNote = ` FAKE-PATCH:${r.status}:${b.code ?? ''}:${b.task?.status ?? ''}${b.error ? ':' + String(b.error).slice(0, 120) : ''}`;
      } catch (e) {
        cardNote = ` FAKE-PATCH:ERR:${String(e.message ?? e).slice(0, 80)}`;
      }
    } else if (batchBody) {
      try {
        const { status, body: b } = await call('/api/agent/cards/batch', batchBody);
        cardNote = ` FAKE-BATCH:${status}:${Array.isArray(b.tasks) ? b.tasks.length : 0}:${b.deduped ?? 0}${b.code ? ':' + b.code : ''}${b.error ? ':' + String(b.error).slice(0, 120) : ''}`;
      } catch (e) {
        cardNote = ` FAKE-BATCH:ERR:${String(e.message ?? e).slice(0, 80)}`;
      }
    } else if (cardBody) {
      try {
        const { status, body: b } = await call('/api/agent/cards', cardBody);
        cardNote = ` FAKE-CARD:${status}:${b.task?.id ?? b.code ?? '?'}${b.task ? ':' + b.task.status : ''}${b.deduped ? ':dedup' : ''}${b.error ? ':' + String(b.error).slice(0, 100) : ''}`;
      } catch (e) {
        cardNote = ` FAKE-CARD:ERR:${String(e.message ?? e).slice(0, 80)}`;
      }
    }
  }

  /*
   * 运行钥匙探针（BANDI_FAKE_PROBE=1）：强制鉴权模式下，钥匙该能开"建卡 + 只读台账"，
   * 不该能开面板管理口。结果原样回进回复，冒烟断言。
   */
  let probeNote = '';
  if (process.env.BANDI_FAKE_PROBE === '1') {
    const base = process.env.BANDI_CONTROL_URL;
    const headers = { 'X-Bandi': '1', 'X-Bandi-Run-Token': process.env.BANDI_RUN_TOKEN ?? '' };
    const targets = [
      ['projects', '/api/projects'],
      ['state', '/api/state'],
      ['tasks', '/api/tasks'],
      ['runtimes', '/api/runtimes'],
      ['users', '/api/users'],
      ['skills', '/api/skills'],
    ];
    const got = {};
    for (const [key, path] of targets) {
      try {
        const r = await fetch(base + path, { headers });
        got[key] = r.status;
      } catch {
        got[key] = 'ERR';
      }
    }
    probeNote = ' FAKE-PROBE:' + JSON.stringify(got);
  }

  out({ type: 'item.completed', item: { type: 'agent_message', text: `${claim}FAKE-OK：${echo}${cardNote}${probeNote}` } });
  out({ type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 22, cached_input_tokens: 3 } });
  process.exit(0);
}

main();
