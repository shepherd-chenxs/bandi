/* routes/events.mjs —— GET /api/events：全局 SSE（2026-10-24）。
 * 头部写法照 runs.subscribe 抄；多的这一样是**心跳** —— 这条连接是长命的
 * （不是跑完就收的运行流），没有流量时中间的代理会把它掐了，
 * 每 25 秒一发注释行保活。 */

import { addEventsSub } from '../events.mjs';

export async function handleEvents(req, res, url) {
  if (req.method !== 'GET' || url.pathname !== '/api/events') return false;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const hb = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch { /* close 回调会清掉定时器，这里只管别抛 */ }
  }, 25000);
  res.on('close', () => clearInterval(hb));

  addEventsSub(res);
  return true;
}
