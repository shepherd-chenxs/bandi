/* routes/agent-deliver.mjs —— 数字员工的「交付」动作（2026-11-19）。
 *
 * ## 为什么要它（机制问题，不是提示词问题）
 *
 * agent 跟世界打交道的方式是**发文本命令**：发一条 → 等结果 → 回模型问"下一步"。
 * 所以"提交 → 推送 → 开 PR"这么一串，它要发 6 条命令、走 6 次往返，每次往返 40–60 秒。
 * 实报 r-4c85d92c：一整轮 15 分钟，其中 **9 条命令耗掉 6 分钟纯等待，命令本身只跑了 6 秒**；
 * 另有 5 分 42 秒是全量闸门在真跑（那部分该花）。
 *
 * 病根不是它笨，是**平台没给它通道**：`git-repos.openPr({ push: true })` 早就是
 * "提交+推送+开PR"的原子动作（界面按钮、流程节点都走它），可运行钥匙的白名单里
 * 一条 git 动作都没有 —— 它只能用 shell 自己拼，拼错了还要多绕几轮。
 *
 * ## 两条动作
 *
 *   · `POST /api/agent/gate`    —— 跑全量闸门，**只回「过没过 + 挂了哪几项 + 日志路径」**。
 *     78 项日志一律落 `tmp/gate-*.log`，不回正文：那几万字符一旦进了上下文，
 *     此后每次往返都要重读一遍，是上下文从 179k 涨到 532k 的主要来源。
 *   · `POST /api/agent/deliver` —— 提交 → 推送 → 开 PR，一条命令做完，回一份十条以内的摘要。
 *
 * 判据一句话：**确定性的运维流程做成动作，别让模型现拼**。它只该判断"该不该交"，
 * 不该负责"怎么交"。这和 `contract.mjs` 的 `gitStateBlock()` 是同一个思路：
 * 盲区里的东西平台直接给，别让人现摸。
 *
 * ## 身份与权限
 *
 * 钥匙同 `/api/agent/cards`（`X-Bandi-Run-Token`，每轮现发、收尾作废）；
 * 权限位 `repo.deliver`（目前只有「仓库管家」拿到）。工作目录必须落在**已接入的仓库**里 ——
 * 拿 `repoForCwd(persona.cwd)` 认，认不出来就明说，不许去猜一个目录。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sendJson, fail, readBody } from '../http.mjs';
import * as store from '../store.mjs';
import * as git from '../git-repos.mjs';
import { verifyRunCredential } from '../agent-auth.mjs';
import { can, roleNameOf } from '../roles.mjs';

/** 闸门最多跑多久（本机全量 5~6 分钟；给三倍余量，卡死就杀，别让一条请求吊到天亮） */
const GATE_TIMEOUT_MS = 15 * 60_000;
/** 回给模型的失败行上限：再多就说明该看文件了，不是看摘要 */
const FAIL_MAX = 8;
/** 没识别出失败行时，回日志尾部这么多行（够判断"是挂了还是在跑"） */
const TAIL_MAX = 12;
/** 交付摘要里最多列几个文件（剩下的只报数量） */
const FILES_MAX = 10;

/** 从运行钥匙认出员工；失败时已经把 HTTP 回了，返回 null 让调用方直接收工 */
function identityOf(req, res) {
  const cred = verifyRunCredential(req.headers['x-bandi-run-token']);
  if (!cred) {
    fail(res, 401, 'E2056',
      '要带有效的运行钥匙（X-Bandi-Run-Token）—— 每轮现发、收尾作废；值取自本进程环境变量 BANDI_RUN_TOKEN，别用历史命令里的旧值');
    return null;
  }
  const persona = store.getPersona(cred.personaId);
  if (!persona) {
    fail(res, 401, 'E2056', '这把钥匙对应的员工已经不在了');
    return null;
  }
  return { cred, persona };
}

/**
 * 认仓库：persona.cwd 必须落在某个已接入仓库里。
 * 返回 `{ row }` 或 `{ error }`（错误话里要说清"你现在在哪、该怎么接"）。
 */
function repoOf(persona) {
  const cwd = String(persona.cwd ?? '').trim();
  if (!cwd) {
    return { error: '你的工作目录还没设 —— 让雇主在「员工」里给你指定一个仓库目录（或让仓库管家去接仓库）' };
  }
  const row = git.repoForCwd(cwd);
  if (!row) {
    return { error: `你的工作目录 ${cwd} 不在任何**已接入**的仓库里。先让雇主在「代码托管」把仓库接入，或把工作目录改到已接入仓库的目录下` };
  }
  return { row, cwd };
}

/**
 * 跑全量闸门：日志整份落文件，只回结论。
 *
 * 为什么不让它自己 `node tools/run-smokes.mjs`：那会把 78 项输出**原样塞进上下文**，
 * 之后每次往返都要重读（实测一轮上下文从 179k 涨到 532k，主要就是这些日志）。
 * 这里把"看日志"变成"看结论"，要看细节就按返回的路径 `grep` 一次 —— 一次就够。
 */
function runGate(root) {
  const logDir = path.join(root, 'tmp');
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (e) {
    return Promise.resolve({ ok: false, error: `建不了日志目录：${e.message}` });
  }
  const logPath = path.join(logDir, `gate-${Date.now()}.log`);
  let fd;
  try {
    fd = fs.openSync(logPath, 'w');
  } catch (e) {
    return Promise.resolve({ ok: false, error: `写不了日志文件：${e.message}` });
  }
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(process.execPath, [path.join(root, 'tools', 'run-smokes.mjs')], {
        cwd: root,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
        env: { ...process.env },
      });
    } catch (e) {
      try { fs.closeSync(fd); } catch {}
      resolve({ ok: false, error: `起不来闸门：${e.message}` });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
    }, GATE_TIMEOUT_MS);
    const done = (code, err) => {
      clearTimeout(timer);
      try { fs.closeSync(fd); } catch {}
      resolve(summarizeGate(root, logPath, code, Date.now() - startedAt, err));
    };
    child.on('error', (e) => done(-1, e.message));
    child.on('close', (code) => done(code ?? -1, null));
  });
}

/** 把一份可能有几万行的闸门日志压成"结论 + 失败行 + 路径" */
function summarizeGate(root, logPath, exitCode, spentMs, spawnError) {
  let text = '';
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch {}
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rel = path.relative(root, logPath).replace(/\\/g, '/');
  if (spawnError) {
    return { ok: false, exitCode, spentMs, logPath: rel, failed: [`闸门起不来：${spawnError}`], tail: [] };
  }
  if (exitCode === 0) {
    return { ok: true, exitCode: 0, spentMs, logPath: rel, failed: [], tail: [] };
  }
  // 失败行优先认 `✗`（run-smokes 的标记），认不出来就回尾部
  const failed = lines.filter((l) => /✗|✖|FAIL|没过|失败/.test(l)).slice(0, FAIL_MAX);
  return {
    ok: false,
    exitCode,
    spentMs,
    logPath: rel,
    failed: failed.length ? failed : [],
    tail: failed.length ? [] : lines.slice(-TAIL_MAX),
  };
}

/** 人类可读的耗时 */
const spentText = (ms) => (ms >= 60_000 ? `${Math.round(ms / 6000) / 10} 分` : `${Math.round(ms / 1000)} 秒`);

export async function handleAgentDeliver(req, res, url) {
  const isGate = /^\/api\/agent\/gate$/.test(url.pathname);
  const isDeliver = /^\/api\/agent\/deliver$/.test(url.pathname);
  if (!isGate && !isDeliver) return false;

  if (req.method !== 'POST') {
    return fail(res, 405, 'E2076', '这两个通道只收 POST'), true;
  }

  const id = identityOf(req, res);
  if (!id) return true;
  const { persona } = id;

  if (!can(persona, 'repo.deliver')) {
    return fail(res, 403, 'E2077',
      `交付权只给仓库管家（你的岗位是「${roleNameOf(persona.roleKey) ?? '未设岗位'}」）。要交付就把改动说给仓库管家，或让雇主在面板上点按钮。`), true;
  }

  const found = repoOf(persona);
  if (found.error) return fail(res, 400, 'E2078', found.error), true;
  const { row } = found;

  /* ------------------------------------------------------------- 闸门 */
  if (isGate) {
    const r = await runGate(row.localPath);
    if (r.error) return fail(res, 500, 'E2079', r.error), true;
    return sendJson(res, r.ok ? 200 : 409, {
      ok: r.ok,
      spent: spentText(r.spentMs),
      spentMs: r.spentMs,
      ...(r.ok
        ? { summary: `全量闸门过了（${spentText(r.spentMs)}），可以交付。别再自己一条条跑用例。` }
        : {
            summary: `闸门没过（${spentText(r.spentMs)}）：见 failed。**只按日志文件定位，别看全文**；改完再调一次本接口，别自己跑全量。`,
            failed: r.failed,
            tail: r.tail,
          }),
      logPath: r.logPath,
    }), true;
  }

  /* ------------------------------------------------------------- 交付 */
  const body = await readBody(req);
  const title = String(body.title ?? '').trim();
  if (!title) {
    return fail(res, 400, 'E2078',
      '要给这次交付一个标题（`title`）—— 它会当 PR 标题。一句话说清改了什么，别写「更新」这种。'), true;
  }
  const message = String(body.message ?? title).trim() || title;

  let out;
  try {
    out = await git.openPr(row, {
      title,
      message,
      body: String(body.body ?? ''),
      branch: body.branch ? String(body.branch) : undefined,
      base: body.base ? String(body.base) : undefined,
      push: true,
      includeDirty: true,
    });
  } catch (e) {
    return fail(res, 400, 'E2079', `交付没成：${String(e?.message ?? e)}`), true;
  }

  const files = (out.files ?? [])
    .map((f) => (typeof f === 'string' ? f : f?.path ?? f?.file ?? ''))
    .filter(Boolean);
  const pr = out.pr ?? {};
  return sendJson(res, 201, {
    ok: true,
    created: !!out.created,
    pr: { number: pr.number ?? null, url: pr.url ?? null, title: pr.title ?? title, head: pr.headRef ?? out.branch ?? null, base: pr.baseRef ?? out.base ?? null },
    branch: out.branch ?? null,
    files: files.slice(0, FILES_MAX),
    fileCount: files.length,
    summary: `已交付：${files.length} 个文件 → ${out.branch ?? '当前分支'}，PR #${pr.number ?? '?'}（${out.created ? '新建' : '已有同一个，复用'}）：${pr.url ?? ''}。下一步等 CI，别再自己 push 或建 PR。`,
  }), true;
}
