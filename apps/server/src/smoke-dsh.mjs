/**
 * 冒烟测试：直接验证 dsh 执行端，不碰 HTTP 与数据库。
 * 跑法：node apps/server/src/smoke-dsh.mjs
 */
import { runDsh } from './dsh.mjs';
import * as runtimes from './runtimes.mjs';

// 路径必须显式给：适配器里已经没有写死的默认值了（那玩意儿只在开发那台机器上成立）。
// 这里用跟界面同一个探测，找不到就直说，别拿个死路径去试。
const cliPath = runtimes.detectFamily('dsh')?.[0]?.path;
if (!cliPath) {
  console.log('没探测到 dsh —— 先在「设置 → 运行时」点「识别本机运行时」接一个');
  process.exit(1);
}
console.log('用这个 dsh：', cliPath, '\n');

const t0 = Date.now();

const first = await runDsh({
  cliPath,
  task: 'Reply with exactly: OK',
  onEvent: (e) => console.log('  [evt]', e.type, e.phase ?? '', e.text ?? ''),
});

console.log('\n--- run1（新会话）---');
console.log('session :', first.sessionId);
console.log('final   :', JSON.stringify(first.finalText));
console.log('exitCode:', first.exitCode);
console.log('usage   :', JSON.stringify(first.usage));
console.log('stderr  :', JSON.stringify(first.stderr.slice(0, 400)));
console.log('elapsed :', Date.now() - t0, 'ms');

if (!first.sessionId) {
  console.log('\n失败：没有拿到 sessionId，后面不用跑了');
  process.exit(1);
}

const t1 = Date.now();
const second = await runDsh({
  cliPath,
  task: 'What did I just ask you to reply with? Answer with just those characters, nothing else.',
  sessionId: first.sessionId,
});

console.log('\n--- run2（续接同一会话）---');
console.log('session :', second.sessionId);
console.log('final   :', JSON.stringify(second.finalText));
console.log('exitCode:', second.exitCode);
console.log('usage   :', JSON.stringify(second.usage));
console.log('elapsed :', Date.now() - t1, 'ms');

const ok = first.exitCode === 0 && second.exitCode === 0 && second.finalText.trim() === 'OK';
console.log('\n结论：', ok ? '两轮都通，上下文续接成功' : '未达预期，看上面的输出');
process.exit(ok ? 0 : 1);
