/* routes/connector.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * 主分发顺序（先匹配先赢）见 ../server.mjs 的 CHAIN。 */

import { sendJson, fail, readBody } from '../http.mjs';
import * as runtimes from '../runtimes.mjs';
import * as connectors from '../connectors.mjs';
import * as catalog from '../catalog.mjs';

export async function handleConnector(req, res, url) {
  const one = /^\/api\/connectors\/([^/]+)$/.exec(url.pathname);
  const probeOne = /^\/api\/connectors\/([^/]+)\/probe$/.exec(url.pathname);

  if (req.method === 'GET' && url.pathname === '/api/connectors/catalog') {
    const installed = new Set(connectors.list().map((e) => e.id));
    return sendJson(res, 200, {
      error: catalog.catalogError(),
      catalog: catalog.listCatalog().map((c) => ({
        ...c,
        installed: installed.has(c.id),
        // 清单里点名要的凭据，环境里有没有 —— 界面据此提示，别让人装完才发现跑不起来
        requires: c.requires.map((key) => ({ key, present: process.env[key] !== undefined })),
      })),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/connectors') {
    const body = await readBody(req);

    // ① 从推荐清单装：清单条目就是一份模板
    if (body.from) {
      const c = catalog.getCatalog(String(body.from));
      if (!c) return fail(res, 404, 'E2019', '推荐清单里没有这一条');
      const r = connectors.saveEntry(c.id, {
        label: c.label,
        source: c.source,
        transport: c.transport,
        command: c.command,
        args: c.args,
        cwd: c.cwd,
        url: c.url,
        env: c.env,
        note: c.note,
        enabled: true,
      });
      if (r.error) return fail(res, 400, 'E1040', r.error, r);
      return sendJson(res, 201, { ...r, needs: c.requires, note: c.note });
    }

    // ② 手工装 / 改一条
    const id = String(body.id ?? '').trim();
    const r = connectors.saveEntry(id, body);
    return r.error ? fail(res, 400, 'E1041', r.error, r) : sendJson(res, 201, r);
  }

  if (req.method === 'POST' && probeOne) {
    const id = decodeURIComponent(probeOne[1]);
    return sendJson(res, 200, await connectors.probe(id));
  }

  if ((req.method === 'PUT' || req.method === 'PATCH') && one) {
    const id = decodeURIComponent(one[1]);
    if (!connectors.get(id)) return fail(res, 404, 'E2020', '没有这条连接器');
    const r = connectors.saveEntry(id, await readBody(req));
    return r.error ? fail(res, 400, 'E1042', r.error, r) : sendJson(res, 200, r);
  }

  if (req.method === 'DELETE' && one) {
    return sendJson(res, 200, { ...connectors.removeEntry(decodeURIComponent(one[1])) });
  }

  return false;
}


/* ------------------------------------------------------------------ 执行节点 */

/*
 * 「节点 → 设备」的映射**只有一份**，在 `runtimes.mjs`（`nodeAsDevice` / `publicNodes`）。
 * 这里以前也写过一份 —— 于是同一个节点在设备列表里出现两次、两份逻辑还会各自漂。
 * 2026-10-15 收掉了：节点长什么样，只在那一处定义。
 */

/** 节点接口：报到 / 心跳 / 清单 */
