/*
 * routes/agent-files.mjs —— 数字员工的「产物发进聊天」通道（2026-11-23）。
 *
 * 由来（用户实报）：田螺姑娘用宝螺做出成片，文件落在宝螺的输出目录（本机硬盘），
 * bandi 聊天只认 <dataDir>/uploads/<会话>/ 下的附件 —— 结果员工说"做好了"，
 * 雇主却点不开看。以前员工只能口头给一个本机路径，界面上画不成可点的 chip。
 *
 * 这条接口补的正是这一环：**员工把已经做好的本地文件登记成当前会话的附件**，
 * 走的是和前端上传完全相同的 uploads 目录与 safeName/safeConv 闸 —— 附件回显
 * （GET /api/files/<convId>/<name>）和前端气泡里那颗可点 chip 都是现成的，不用另造。
 *
 * 身份：和建卡通道一样，靠 runs.mjs 派活时注入的一次性工作证
 * （X-Bandi-Run-Token，见 agent-auth.mjs），不是浏览器 session。
 * **会话 id 不收客户端传参** —— 从工作证对应的 run 里取（run.conversationId），
 * 否则员工可以为别的会话登记文件，串会话。每次都现取钥匙、收尾即吊销。
 *
 * 幂等：同一轮里对同一个本地文件重复登记会拿到同一个 url（key = runId + 绝对路径），
 * 不会因为重试就在聊天里刷出好几颗一样的 chip。
 *
 * 安全边界：
 *   · 读本地产物 = 员工本来就有 danger-full-access（它能读那个文件才能做出它），
 *     这里不新增读权限；但**可写目标**死锁在 uploads/<本会话>/，用 safeName 剥路径。
 *   · 上限 50MB，与前端附件同一口径（ATT_MAX）——聊天附件不是网盘。
 *   · 只认普通文件（stat.isFile()），目录 / 设备文件一律拒。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sendJson, fail, readBody } from '../http.mjs';
import { dataDir } from '../config.mjs';
import * as store from '../store.mjs';
import { verifyRunCredential } from '../agent-auth.mjs';
import { getRun } from '../runs.mjs';
import { safeName, safeConv, uploadsRoot, ATT_MAX, ATT_MIME } from './conversation.mjs';

const MAX_NAME = 120;

/** 这枚工作证是谁的（认不出来 → null） */
function credOf(req) {
  return verifyRunCredential(req.headers['x-bandi-run-token']);
}

/** 附件回显 url（和 conversation.mjs 上传回的那一份同格式） */
function fileUrl(convId, stored) {
  return `/api/files/${encodeURIComponent(convId)}/${encodeURIComponent(stored)}`;
}

export async function handleAgentFiles(req, res, url) {
  if (url.pathname !== '/api/agent/files') return false;

  const cred = credOf(req);
  if (!cred) return fail(res, 401, 'E2056', '运行钥匙无效或已过期（每轮现发，别抄旧值）');

  if (req.method !== 'POST') return fail(res, 405, 'E1005', '只支持 POST');

  let body;
  try {
    body = await readBody(req);
  } catch {
    return fail(res, 400, 'E1010', '请求体不是合法 JSON');
  }

  const rawPath = String(body?.path ?? '').trim();
  if (!rawPath) return fail(res, 400, 'E2080', '缺少 path：要登记的本机文件绝对路径');

  // 会话从工作证对应的 run 取，不信客户端传参（防串会话）
  const runRow = store.getRunRow(cred.runId);
  const convId = safeConv(runRow?.conversationId);
  if (!convId) return fail(res, 400, 'E1046', '这次运行没有可登记的会话');

  let src;
  try {
    src = path.resolve(rawPath);
    const st = fs.statSync(src);
    if (!st.isFile()) return fail(res, 400, 'E2081', 'path 不是普通文件');
    if (st.size <= 0) return fail(res, 400, 'E2082', '文件是空的');
    if (st.size > ATT_MAX) return fail(res, 400, 'E2083', `文件超过 ${Math.round(ATT_MAX / 1048576)}MB 上限——聊天附件不是网盘，大文件请留在工作目录`);
  } catch (e) {
    if (e?.code === 'E2081' || e?.code === 'E2082' || e?.code === 'E2083') throw e;
    return fail(res, 400, 'E2084', `读不到这个文件：${path.basename(src)}（路径写错或没权限）`);
  }

  // 显示名：客户端给就用（清洗过），没给就用源文件名
  const name = safeName(body?.name ?? path.basename(src)).slice(0, MAX_NAME);
  const ext = path.extname(name).toLowerCase();

  // 幂等：同一 run 同一源文件 → 同一落盘名，重复登记拿到同一个 url
  const key = crypto.createHash('sha1').update(`${cred.runId}\0${src}`).digest('hex').slice(0, 12);
  const stored = `${Date.now()}-${key}-${name}`;
  // 先查这一轮有没有登记过同一个源文件（按 key 找，避免重复 chip）
  const dir = path.join(uploadsRoot, convId);
  fs.mkdirSync(dir, { recursive: true });
  const dup = fs.readdirSync(dir).find((f) => f.includes(`-${key}-`));
  const finalStored = dup ?? stored;
  const abs = path.join(dir, finalStored);
  if (!dup) {
    // 复制而不是移动：产物原件不能被动（员工可能还要用它 / 宝螺那边还要读）
    fs.copyFileSync(src, abs);
  }

  const att = {
    name,
    stored: finalStored,
    size: dup ? fs.statSync(abs).size : fs.statSync(src).size,
    mime: ATT_MIME[ext] ?? 'application/octet-stream',
    path: abs,
    url: fileUrl(convId, finalStored),
  };

  /*
   * 挂到内存里的 run 上：persistReply 收尾落库时一并写进消息的 atts 列，
   * 前端 attsHtmlOf 会把图片画成缩略图、其余给可点 chip。
   * 进程重启会丢暂存 —— 那就只是这一次回话少颗 chip，员工仍能拿到 url 自己贴文本里。
   */
  const run = getRun(cred.runId);
  if (run) {
    if (!Array.isArray(run.artifactAtts)) run.artifactAtts = [];
    if (!run.artifactAtts.some((a) => a.stored === finalStored)) run.artifactAtts.push(att);
  }

  return sendJson(res, dup ? 200 : 201, {
    file: att,
    deduped: Boolean(dup),
    hint: '文件已登记成本次会话的附件，会随你的回话一起显示；也可以把 url 写进回话里。',
  });
}
