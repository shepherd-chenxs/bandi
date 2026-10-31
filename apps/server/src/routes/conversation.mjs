/* routes/conversation.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * 主分发顺序（先匹配先赢）见 ../server.mjs 的 CHAIN。 */

import fs from 'node:fs';
import path from 'node:path';
import { sendJson, fail, readBody, readRawBody, BadRequest } from '../http.mjs';
import { dataDir } from '../config.mjs';
import * as store from '../store.mjs';
import * as auth from '../auth.mjs';
import * as runs from '../runs.mjs';
import { dispatchToThread } from '../dispatch.mjs';
import * as workflows from '../workflows.mjs';
import { promoteConversationToCard } from '../project-tasks.mjs';

/* --------------------------------------------------- 附件（2026-10-23） */

/** 附件根：<dataDir>/uploads/<会话id>/ —— 文件跟着数据走，备份/搬迁一体 */
export const uploadsRoot = path.join(dataDir, 'uploads');

/** 上限给 50MB：聊天附件不是网盘，再大该走工作目录 */
export const ATT_MAX = 50 * 1048576;
const ATT_MAX_COUNT = 8;

/** 文件名清洗：只留_basename，剥掉路径分隔符与控制字符 —— 防借 name 写到别处 */
export function safeName(name) {
  const base = path.basename(String(name ?? 'file')).replace(/[\x00-\x1f]/g, '').trim();
  return (base || 'file').slice(0, 120);
}

/** 会话 id 闸：ids 都是自己生成的 `c-xxxx`，不带它认不出的字符 —— 防借 convId 穿目录 */
export function safeConv(id) {
  const s = String(id ?? '');
  return /^[A-Za-z0-9_-]+$/.test(s) ? s : null;
}

const ATT_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
};

/**
 * 校验前端传回的附件清单：每一份都必须真的落在**这个会话**的 uploads/ 里。
 * 为什么不信前端：接口能被直接调，乱传 path 就成了"任读任传任意文件"。
 * 返回清洗后的数组；不合法抛 BadRequest（外层映射成 400）。
 */
export function validateAtts(convId, raw) {
  if (raw == null) return null;
  if (!Array.isArray(raw) || !raw.length) throw new BadRequest('附件清单不合法');
  if (raw.length > ATT_MAX_COUNT) throw new BadRequest(`附件最多 ${ATT_MAX_COUNT} 个`);
  const dir = path.join(uploadsRoot, convId);
  const out = [];
  for (const a of raw) {
    const stored = safeName(a?.stored ?? a?.name);
    const abs = path.resolve(dir, stored);
    if (!abs.startsWith(path.resolve(dir) + path.sep)) throw new BadRequest('附件路径不合法');
    if (!fs.existsSync(abs)) throw new BadRequest(`附件不存在或已过期：${stored}`);
    out.push({
      name: safeName(a?.name) || stored,
      stored,
      size: Number(a?.size) || fs.statSync(abs).size,
      mime: String(a?.mime ?? ''),
      path: abs,
      url: `/api/files/${encodeURIComponent(convId)}/${encodeURIComponent(stored)}`,
    });
  }
  return out;
}

/** 服务一份附件（GET /api/files/<convId>/<文件名>）：先过路径闸，再按扩展名给 MIME */
function serveAttachment(res, convId, name) {
  const dir = path.resolve(uploadsRoot, convId);
  // URL 段是 percent-encoded 的（中文文件名），先解码再清洗
  let decoded = name;
  try { decoded = decodeURIComponent(name); } catch { /* 解不开就按原样试 */ }
  const file = path.resolve(dir, safeName(decoded));
  if (!file.startsWith(dir + path.sep)) {
    res.writeHead(403).end('forbidden');
    return true;
  }
  try {
    const buf = fs.readFileSync(file);
    const mime = ATT_MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const headers = {
      'Content-Type': mime,
      'Cache-Control': 'private, max-age=31536000, immutable', // 文件名带时间戳，内容不可变
      'Content-Disposition': 'inline',
    };
    // HTML/SVG 是能在浏览器里跑脚本的文档（2026-10-24，设计稿走 HTML 交付的前提）：
    // 直接 inline 回显就是同源 XSS 通道 —— 加 CSP sandbox 关进不透明源，脚本碰不到班底本体。
    if (['.html', '.htm', '.svg'].includes(path.extname(file).toLowerCase())) {
      headers['Content-Security-Policy'] = 'sandbox allow-scripts';
    }
    res.writeHead(200, headers);
    res.end(buf);
    return true;
  } catch {
    return false; // 没这个文件 → 走外层 404
  }
}

export async function handleConversation(req, res, url) {
  const detail = /^\/api\/conversations\/([^/]+)$/.exec(url.pathname);
  const send = /^\/api\/conversations\/([^/]+)\/messages$/.exec(url.pathname);
  const hide = /^\/api\/conversations\/([^/]+)\/hide$/.exec(url.pathname);
  // 立成任务卡（2026-10-24）：把这场会话最近一轮派的活转正成看板上的真卡
  const card = /^\/api\/conversations\/([^/]+)\/card$/.exec(url.pathname);
  // 附件：上传（原始二进制，一次一个文件）与回显（GET /api/files/...）
  const upload = /^\/api\/conversations\/([^/]+)\/files$/.exec(url.pathname);
  const fileGet = /^\/api\/files\/([^/]+)\/([^/]+)$/.exec(url.pathname);

  /*
   * 附件回显（2026-10-23）：聊天里画的图片 / 可点的文件都走这儿。
   * auth.guard 在外层已经把非本机来源挡了，这里只管路径不穿出 uploads/。
   */
  if (req.method === 'GET' && fileGet) {
    const convId = safeConv(decodeURIComponent(fileGet[1]));
    if (!convId) return fail(res, 400, 'E1046', '会话 id 不合法');
    if (serveAttachment(res, convId, fileGet[2])) return;
    return fail(res, 404, 'E2036', '没有这个文件');
  }

  /*
   * 附件上传（2026-10-23）：前端用「+」选文件 / 粘贴图片后，先把文件本体 POST 上来
   * （原始二进制，一次一个，名字走 query），拿到清单再随消息一起发。
   */
  if (req.method === 'POST' && upload) {
    const convId = safeConv(decodeURIComponent(upload[1]));
    if (!convId) return fail(res, 400, 'E1046', '会话 id 不合法');
    if (!store.getConversation(convId)) return fail(res, 404, 'E2047', '这段会话已经不在了（可能刚被删过）');
    const name = safeName(url.searchParams.get('name'));
    const dir = path.join(uploadsRoot, convId);
    fs.mkdirSync(dir, { recursive: true });
    // 同名不覆盖：文件名前缀毫秒时间戳（回显那边 immutable 缓存也靠它保证内容不可变）
    const stored = `${Date.now()}-${name}`;
    const buf = await readRawBody(req, ATT_MAX, '文件太大（上限 50MB）—— 大文件请放到工作目录里再让员工去读');
    if (!buf.length) return fail(res, 400, 'E1048', '文件是空的');
    fs.writeFileSync(path.join(dir, stored), buf);
    const abs = path.join(dir, stored);
    return sendJson(res, 201, {
      file: {
        name,               // 界面上显示的原始文件名
        stored,             // 落盘名（回显 URL 用）
        size: buf.length,
        mime: String(req.headers['content-type'] ?? ''),
        path: abs,          // 员工读文件用的绝对路径
        url: `/api/files/${encodeURIComponent(convId)}/${encodeURIComponent(stored)}`,
      },
    });
  }

  /**
   * 「不显示」/「归档」：只动列表显示，**不删任何消息**（2026-10-20）。
   *
   * 两个菜单项走同一个接口，区别只在前端文案：
   *   · 正常员工 → 「不显示」，之后仍能在**聊天记录**里找到（返回体里带 hiddenConversations）；
   *   · 已删除员工 → 「归档」，那个人已经没有聊天记录入口了，所以界面上等于彻底收走。
   * 恢复入口已随归档功能一起去掉；想在列表里再看到它，只能等它再说一句话（见 addMessage）。
   */
  if (req.method === 'POST' && hide) {
    const id = decodeURIComponent(hide[1]);
    if (!store.hideConversation(id)) return fail(res, 404, 'E2001', '会话不存在');
    return sendJson(res, 200, {
      hidden: true,
      conversations: store.listConversations(),
      hiddenConversations: store.listHiddenConversations(),
    });
  }

  /**
   * **永久删除**一段会话（右键菜单 →「删除」，2026-10-20）。
   *
   * 接受 `direct` / `group`，另外一种有它自己的出口，**不从这儿删**：
   *   · 群 → 2026-10-20 用户定：「删除不是删除群，是删除**这次会话**」——
   *     列表里那行代表的是这个群最新的一段，删它只抹这一段；
   *     群本身、成员名单、其他段都不动（删到零段时群行一并收掉，见 store）；
   *     整个群不要了走「解散」（记录留着、成员关系解除）。
   *   · exec（工单会话）→ 它是任务卡 / 流程的载体，删它等于抽掉办过的痕迹。
   *
   * 三道校验（存在 / 是 direct / 没有跑中的 run）都在 `store.deleteConversation` 里做，
   * 这里只负责**映射成对的状态码与错误码** —— 前端可以被绕过、接口也能被直接调，
   * 所以「store 里再判一遍」是底线，不是重复（同 DELETE /api/personas/:id 的两道关）。
   *
   * 回整份 `conversations` 是跟 hide 保持一致：同一个界面、同一套前端流程，
   * 前端一行 `S.conversations = r.conversations` 就够，不用再 load() 一次。
   * `hiddenConversations` 一起回，是因为聊天记录抽屉可能正列着它（删完要立刻消失）。
   */
  if (req.method === 'DELETE' && detail) {
    const id = decodeURIComponent(detail[1]);
    const r = store.deleteConversation(id);
    if (!r.ok) {
      if (r.why === 'not-found') {
        return fail(res, 404, 'E2047', '这段会话已经不在了（可能刚被删过）');
      }
      if (r.why === 'not-deletable') {
        return fail(res, 400, 'E1050', '工单会话不能这样删 —— 它属于任务卡 / 流程，请去那边删任务');
      }
      // 「这段正在跑」是**当前状态冲突**，不是请求格式错 —— 所以 409（E4xxx 段），不是 400
      return fail(res, 409, 'E4002', '这段还在跑，等它跑完或先终止再删', r.runId ? { runId: r.runId } : null);
    }
    return sendJson(res, 200, {
      deleted: true,
      id,
      conversations: store.listConversations(),
      hiddenConversations: store.listHiddenConversations(),
    });
  }

  /**
   * 会话级覆盖：权限 `{ sandbox }` / 模型 `{ model }`。
   * 两者语义相同 —— 有值 = 只在这个会话里覆盖，null / '' = 收回、跟随员工默认。
   * 也可以一次只改一个（只发想改的那个键）。
   */
  if (req.method === 'PUT' && detail) {
    const id = decodeURIComponent(detail[1]);
    const body = await readBody(req);
    const wantsSandbox = 'sandbox' in body;
    const wantsModel = 'model' in body;
    // 这个请求体里两个键都没有 = 没说改什么。但光说"要改什么？"不够 ——
    // 调用方（尤其是版本对不上的前端）看到它才知道**能改的是哪两项**。
    if (!wantsSandbox && !wantsModel) {
      return fail(res, 400, 'E1037', '这次请求没说改哪一项 —— 这个接口只能改「权限」(sandbox) 或「模型」(model)');
    }
    let conversation = store.getConversation(id);
    /*
     * 404 的码同样是 `E2047`（2026-10-20，设计 §4.1.1 统一；原 `E2003`）。
     *
     * 理由与下面 GET 那段一样：**「会话不存在」是一个概念，就该只有一个码**。
     * 三个 404 入口（GET / PUT / DELETE）里留一个不一样的，就是给下一个人挖坑 ——
     * 何况 `E2047` 的定义本来就是「会话不存在」，给它加个"仅限删除"的隐含限定没有道理。
     * 码与文案一起对齐：**状态码仍是 404**；文案改成与 GET 逐字相同的那句 ——
     * 「同一个概念在两个接口上说两种话」只会让用户以为是两个不同的问题（一个说"不存在"、
     * 一个说"已经不在了"，其实都是"这段没了"）。
     * 这个接口的前端 catch 仍不接 `toastConvErr`（那是「改权限 / 模型」的界面，不在本次范围，
     * 失败提示行为保持原样，只是里面那句中文跟着变了）。
     */
    if (!conversation) return fail(res, 404, 'E2047', '这段会话已经不在了（可能刚被删过）');
    if (wantsSandbox) conversation = store.setConversationSandbox(id, body.sandbox ? String(body.sandbox) : null);
    if (wantsModel) conversation = store.setConversationModel(id, body.model ? String(body.model) : null);
    return sendJson(res, 200, { conversation });
  }

  /*
   * 立成任务卡（2026-10-24）：把这场会话最近一轮派的活转正成看板上的真卡。
   * 逻辑都在 project-tasks.promoteConversationToCard（幂等、归属、状态折算看那边的注释）；
   * 这里只管 404 与把错误翻译成带码的 400。立过卡不算错 —— 原样带回，前端好提示"已经立过"。
   */
  if (req.method === 'POST' && card) {
    const id = decodeURIComponent(card[1]);
    if (!store.getConversation(id)) return fail(res, 404, 'E2047', '这段会话已经不在了（可能刚被删过）');
    try {
      const out = promoteConversationToCard(id);
      return sendJson(res, out.created ? 201 : 200, out);
    } catch (e) {
      return fail(res, e.code === 'E2047' ? 404 : 400, e.code ?? 'E2059', e.message);
    }
  }

  if (req.method === 'GET' && detail) {
    const id = decodeURIComponent(detail[1]);
    const conversation = store.getConversation(id);
    /*
     * 404 的码从 `E2004` 改成了 `E2047`（2026-10-20，会话改造 v1.1 收口）。
     *
     * 为什么改：`E2047` 的定义就是「**会话不存在**」，而「这段被另一个窗口删了」这件事
     * 在**回看**（这个 GET）和**删除**（下面的 DELETE）两个入口上必须给同一个码 ——
     * 前端 `openConversationSafe` 就是靠 `err.code === 'E2047'` 认出"这段没了"，
     * 好把右栏收拾干净并说人话（设计 §5.6.1 路径 2/3 明确写的是「GET 返回 E2047」）。
     * 两个码表示同一件事，只会让人多写一条映射，还容易漏。
     * 上面 PUT 那段同理（原 `E2003`）—— 三个 404 入口统一口径，见设计 §4.1.1。
     *
     * `E2004` / `E2003` 全仓没有第二处引用（前端也不解析它们），换掉不影响任何调用方。
     */
    if (!conversation) return fail(res, 404, 'E2047', '这段会话已经不在了（可能刚被删过）');
    return sendJson(res, 200, {
      conversation,
      messages: store.listMessages(id),
      runs: store.listRuns(id).map((r) => ({
        ...r,
        // 失败原因补真因（2026-10-26）：有些 CLI 失败时 stderr 是空的，落库只剩「退出码 1」，
        // 真因在 run_events 里 —— 见 runs.errorForDisplay 的注释
        error: runs.errorForDisplay(r),
        usage: r.usage ? JSON.parse(r.usage) : null,
      })),
    });
  }

  if (req.method === 'POST' && send) {
    const id = decodeURIComponent(send[1]);
    const body = await readBody(req);
    const text = String(body.text ?? '').trim();
    // 附件（2026-10-23）：文件本体已由 /files 上传，这里只带清单。
    // 光发图不说话也行（IM 常识）；文本附件两空才拦。
    let atts = null;
    try {
      atts = validateAtts(id, body.atts);
    } catch (e) {
      return fail(res, 400, e.code ?? 'E1046', e.message);
    }
    if (!text && !atts) return fail(res, 400, 'E1010', '说点什么');

    /*
     * 已解散的群：**只读**（2026-10-20 用户定：解散后消息留在消息列表里，但不能再聊）。
     * 前端已经把输入框置灰了，这里再拦一次 —— 接口能被直接调，而且"解散后 thread_members 空了"
     * 会让 dispatcher 找不到人、表现成"点了没反应"（比报错更难查）。
     * 用 E2049（与「群已解散，不能再开会话」同一个概念：这个群结束了）。
     */
    const conv0 = store.getConversation(id);
    if (conv0?.dissolvedAt) {
      return fail(res, 409, 'E2049', '这个群已经解散了，只能查看聊天记录');
    }

    // 校验、派活全在 dispatchToThread 里（工作流引擎也走它）—— 这里只管 HTTP 状态码
    try {
      // body.runId = 在流程卡片上「回复」时带上的：这条消息属于哪条流程。
      // 群里有好几条流程在跑时就靠它归属，不靠猜。
      const { run, member, mentions, queued } = dispatchToThread(id, text, {
        runId: body.runId ?? null,
        taskId: body.taskId ?? null, // 从流程面板发的话：标给那一步
        atts,                        // 随消息上传的附件（已校验都在这个会话的 uploads/ 里）
        // 说话的是哪个人（2026-10-31 用户概念落地）：登录用户是他自己，
        // 回环操作员是第一个用户（"本机自动登录"），节点/手机是 null
        senderUserId: auth.actorUser(req)?.id ?? null,
      });
      if (body.runId) workflows.attachRound(String(body.runId), run.id);
      return sendJson(res, 202, {
        runId: run.id,
        personaId: member.personaId,
        personaName: member.name,
        mentions: mentions.map((m) => m.name),
        // 群里 @ 多人（2026-10-24）：第一个当场派，其余在队里等前一个跑完
        queued: (queued ?? []).map((q) => q.name),
      });
    } catch (e) {
      return sendJson(res, e.code === 'busy' ? 409 : 400, { error: e.message });
    }
  }

  return false;
}

/** 头像字段只收纯文件名（图片本体在 apps/web/avatars/，由静态路由服务）—— 防借字段写路径 */
