/* routes/expert.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * 主分发顺序（先匹配先赢）见 ../server.mjs 的 CHAIN。 */

import { sendJson, fail } from '../http.mjs';
import * as experts from '../experts.mjs';

export async function handleExpert(req, res, url) {
  const hire = /^\/api\/experts\/([^/]+)\/hire$/.exec(url.pathname);
  const fire = /^\/api\/experts\/([^/]+)\/fire$/.exec(url.pathname);
  if (!hire && !fire) return false;
  if (req.method !== 'POST') {
    return fail(res, 405, 'E2052', '雇佣/解聘只认 POST');
  }

  const key = decodeURIComponent((hire ?? fire)[1]);
  if (!experts.getExpert(key)) {
    return fail(res, 404, 'E2051', `专家库里没有「${key}」这一位 —— 目录就那十四位（技术轨八 + 内容轨六），看看是不是拼错了`);
  }

  if (hire) {
    // 幂等：已经雇着 → 直接返回现有的，200（新雇才 201）。重按雇佣按钮不该变成报错
    const r = experts.hireExpert(key);
    return sendJson(res, r.created ? 201 : 200, { persona: r.persona });
  }

  /*
   * 解聘。群助手先拦（2026-10-22）：普通员工删除的 E1038 拦在 handlePersona 里，
   * 专家这条直调的路要在自己这里补上同一道 —— 否则群里会剩一个悬空的"没 @ 就找群助手"。
   * 错误码 **E2053**（409 专家还是群助手，E2051/E2052 之后顺位，grep 确认全仓无撞号）；
   * 群名单附在 detail 给控制台，界面只显示码 + 中文。
   */
  const r = experts.fireExpert(key);
  if (r.blocked) {
    return fail(
      res,
      409,
      'E2053',
      `「${experts.getExpert(key).name}」还是 ${r.groups.length} 个群的群助手，先在群设置里把群助手换成别人，再解聘。`,
      { groups: r.groups },
    );
  }
  return sendJson(res, 200, r);
}

