/* routes/schedules.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * 主分发顺序（先匹配先赢）见 ../server.mjs 的 CHAIN。 */

import { sendJson, fail, readBody, BadRequest } from '../http.mjs';
import * as store from '../store.mjs';
import * as schedules from '../schedules.mjs';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function scheduleFields(body, { partial = false } = {}) {
  const out = {};
  if (body.repeat !== undefined || !partial) {
    const r = String(body.repeat ?? 'interval');
    if (!schedules.REPEATS.includes(r)) throw new BadRequest(`不认识的重复方式：${r}（可选：${schedules.REPEATS.join(' / ')}）`, 'E1083');
    out.repeat = r;
  }
  const repeat = out.repeat;

  if (repeat === 'interval' || body.everyMinutes !== undefined) {
    const n = Math.round(Number(body.everyMinutes));
    if (!Number.isFinite(n) || n < schedules.MIN_MINUTES) throw new BadRequest(`间隔至少 ${schedules.MIN_MINUTES} 分钟（再密就是白烧 GitHub 的速率上限）`, 'E1083');
    if (n > 7 * 24 * 60) throw new BadRequest('间隔太大（最多 7 天）', 'E1083');
    out.everyMinutes = n;
  }

  if (repeat === 'once' || body.runAt !== undefined) {
    const t = Date.parse(body.runAt ?? '');
    if (!Number.isFinite(t)) throw new BadRequest('单次要给一个有效的时间（如 2026-10-20T09:00）', 'E1083');
    out.runAt = new Date(t).toISOString();
  }

  if ((repeat && repeat !== 'interval' && repeat !== 'once') || body.atTime !== undefined) {
    if (!HHMM.test(String(body.atTime ?? ''))) throw new BadRequest('时间要写成 HH:MM（如 09:00）', 'E1083');
    out.atTime = String(body.atTime);
  }

  if (repeat === 'weekly' || repeat === 'biweekly' || body.weekday !== undefined) {
    const w = Math.round(Number(body.weekday));
    if (!Number.isInteger(w) || w < 0 || w > 6) throw new BadRequest('星期几要在 0（日）到 6（六）之间', 'E1083');
    out.weekday = w;
  }

  if (repeat === 'monthly' || repeat === 'yearly' || body.dayOfMonth !== undefined) {
    const d = Math.round(Number(body.dayOfMonth));
    if (!Number.isInteger(d) || d < 1 || d > 31) throw new BadRequest('几号要在 1 到 31 之间（小月会自动取当月最后一天）', 'E1083');
    out.dayOfMonth = d;
  }

  if (repeat === 'yearly' || body.month !== undefined) {
    const m = Math.round(Number(body.month));
    if (!Number.isInteger(m) || m < 1 || m > 12) throw new BadRequest('几月要在 1 到 12 之间', 'E1083');
    out.month = m;
  }

  if (body.name !== undefined || !partial) {
    const name = String(body.name ?? '').trim();
    if (!name) throw new BadRequest('任务要有名字', 'E1081');
    out.name = name;
  }
  if (body.action !== undefined || !partial) {
    if (!schedules.ACTIONS[String(body.action ?? '')]) throw new BadRequest(`不认识的动作：${body.action ?? '（空）'}`, 'E1082');
    out.action = String(body.action);
  }
  if (body.enabled !== undefined) out.enabled = body.enabled ? 1 : 0;
  if (body.config !== undefined) {
    if (body.config !== null && typeof body.config !== 'object') throw new BadRequest('config 要是一个对象', 'E1084');
    out.config = body.config;
  }
  return out;
}

/**
 * 动作自己的校验（声明了 `validate` 的才跑）。
 *
 * 为什么放服务端：界面上「没写要做什么」当然会拦，但接口谁都能直接调；
 * 更要紧的是**别让一个配错的定时任务建成功** —— 半夜到点跑一次、失败、写进 lastError，
 * 人第二天才知道配错了。能在建的时候说清楚的，就在建的时候说。
 */
function assertActionConfig(actionId, config) {
  const check = schedules.ACTIONS[actionId]?.validate;
  if (!check) return;
  const msg = check(config ?? {});
  if (msg) throw new BadRequest(msg, 'E1087');
}

export async function handleSchedules(req, res, url) {
  if (!url.pathname.startsWith('/api/schedules')) return false;
  const one = /^\/api\/schedules\/([^/]+)(\/run)?$/.exec(url.pathname);
  const view = (j) => {
    const config = schedules.parseConfig(j);
    return {
      ...j,
      config,
      text: schedules.describeRepeat(j),
      running: schedules.runningIds().includes(j.id),
      // 卡片上那一行"它到底要干什么"：由**动作自己**说（见 schedules.ACTIONS 的 describe）。
      // 以前是前端按字段名拼的 —— 加第二个通用动作时那段 if 就得重写，而卡片不该认识动作。
      lead: schedules.ACTIONS[j.action]?.describe?.(config) ?? '',
      /*
       * 仓库级巡检（2026-10-29）：`pr-scan` 且指定了仓库的任务，**主人是仓库那一行**
       * （代码托管 › 仓库设置里改节拍）。这里照样列出来 —— 藏起来会让人以为任务丢了 ——
       * 但界面据此标「随仓库」，并说清改去哪儿改。
       */
      ownedByRepo: j.action === 'pr-scan' && config.repo ? String(config.repo) : null,
    };
  };

  if (req.method === 'GET' && url.pathname === '/api/schedules') {
    return (
      sendJson(res, 200, {
        jobs: store.listSchedules().map(view),
        actions: schedules.actionCatalogue(),
        minMinutes: schedules.MIN_MINUTES,
      }),
      true
    );
  }

  if (req.method === 'POST' && url.pathname === '/api/schedules') {
    const body = await readBody(req);
    const fields = scheduleFields(body);
    assertActionConfig(fields.action, fields.config);
    const job = store.createSchedule(fields);
    return sendJson(res, 201, { job: view(job) }), true;
  }

  if (one && !one[2] && req.method === 'PATCH') {
    const job = store.getSchedule(decodeURIComponent(one[1]));
    if (!job) return fail(res, 404, 'E1085', '没有这个定时任务'), true;
    const patch = scheduleFields(await readBody(req), { partial: true });
    // 只改开关/重复方式时，动作和参数都还是老样子 —— 校验要看**合并后**的那一份
    assertActionConfig(patch.action ?? job.action, patch.config !== undefined ? patch.config : schedules.parseConfig(job));
    return sendJson(res, 200, { job: view(Object.keys(patch).length ? store.updateSchedule(job.id, patch) : job) }), true;
  }

  if (one && !one[2] && req.method === 'DELETE') {
    const ok = store.deleteSchedule(decodeURIComponent(one[1]));
    return ok ? sendJson(res, 200, { ok: true }) : fail(res, 404, 'E1085', '没有这个定时任务'), true;
  }

  // 「立即跑」：不看间隔、不看开关（人点它就是要现在跑一次），同步等结果
  if (one && one[2] === '/run' && req.method === 'POST') {
    const id = decodeURIComponent(one[1]);
    if (!store.getSchedule(id)) return fail(res, 404, 'E1085', '没有这个定时任务'), true;
    let out;
    try {
      out = await schedules.runNow(id);
    } catch (e) {
      // 「这个任务正在跑」这种是**请求本身不合适**，不是服务出错 → 400，让人看见原话
      return fail(res, 400, 'E1086', String(e?.message ?? e)), true;
    }
    // 200 + ok:false：请求成功了，是**这次执行**失败（原因在 error 里，界面照直说）
    return sendJson(res, 200, out), true;
  }

  return false;
}

/* ---------------------------------------------------- 本机专属接口（/api/local/*） */

/**
 * 这个请求是不是从**本机**发起的（P0-8 的唯一判据）。
 *
 * ⚠️ 为什么必须有这条：`/api/local/join` 会写 `config.json`（把"这台机器"变成别人的节点）。
 * 局域网里任何人只要能 POST 到它，就能让你的机器加入他的总机 = **机器被劫走**。
 * 所以 6 条 `/api/local/*` 每条**第一件事**都是这个判断。
 */
