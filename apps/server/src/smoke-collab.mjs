/**
 * 「协作中心」的验收（2026-10-31 MVP）—— 一条活从中心派到分公司、干完、收尾、全程不丢。
 *
 * 链路是真的：**两台真实进程**（中心 + 分公司，各一份临时数据目录），不走内存替身。
 *   · 中心：`BANDI_HOST=0.0.0.0` + `BANDI_TOKEN`（鉴权**开着**，才测得出"分公司凭 bc_ 令牌进来"）；
 *   · 分公司：`BANDI_HOST=127.0.0.1`（回环，UI/API 免登录）。
 *
 * 覆盖任务书 §11.1 的 1–15：
 *   发码 → 加入 → 在线 → 派活 → 分公司出现卡 → 状态双向 → 中心验收 → 分公司自判完成
 *   → 中心取消 → 只读（改标题）→ 令牌 → 移除 → 重复加入 → 退出 → 中心挂了照常可用。
 *
 * 跑法：node apps/server/src/smoke-collab.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repoRoot } from './config.mjs';
import { sleep } from './lifecycle.mjs';

const P1 = Number(process.env.SMOKE_PORT ?? 8890); // 中心
const P2 = Number(process.env.SMOKE_PORT2 ?? 8891); // 分公司
const CENTER = `http://127.0.0.1:${P1}`;
const BRANCH = `http://127.0.0.1:${P2}`;
const OP_TOKEN = 'smoke-collab-op-token';
const SERVER = path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-collab-'));
const CENTER_DATA = path.join(tmp, 'center');
const BRANCH_DATA = path.join(tmp, 'branch');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const kids = [];
function spawnBg(env) {
  const c = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const st = { child: c, out: '' };
  kids.push(st);
  c.stdout.on('data', (d) => (st.out += d));
  c.stderr.on('data', (d) => (st.out += d));
  return st;
}

const startCenter = () =>
  spawnBg({
    BANDI_PORT: String(P1),
    BANDI_DATA: CENTER_DATA,
    BANDI_HOST: '0.0.0.0',
    BANDI_TOKEN: OP_TOKEN,
    // 别让中心去碰真数据目录里的东西（桌面壳的 8787 也不该被这个用例影响）
    BANDI_NO_INSTALL_CLI: '1',
  });
const startBranch = () =>
  spawnBg({
    BANDI_PORT: String(P2),
    BANDI_DATA: BRANCH_DATA,
    BANDI_HOST: '127.0.0.1',
    BANDI_NO_INSTALL_CLI: '1',
  });

const center = startCenter();
const branch = startBranch();

async function stop(st) {
  if (!st?.child || st.child.exitCode !== null) return;
  const done = new Promise((r) => st.child.once('exit', r));
  st.child.kill();
  await Promise.race([done, sleep(4000)]);
}

/** 一次请求：`token` 走 `X-Bandi-Token`（中心的管理接口用它，分公司的 bc_ 令牌也用它） */
async function call(base, p, { method = 'GET', body = null, token = null } = {}) {
  const headers = {};
  if (body !== null) headers['Content-Type'] = 'application/json';
  if (token) headers['X-Bandi-Token'] = token;
  const r = await fetch(base + p, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const cApi = (p, opt = {}) => call(CENTER, p, { token: OP_TOKEN, ...opt });
const bApi = (p, opt = {}) => call(BRANCH, p, opt);

async function waitFor(fn, ms, every = 300) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if (await fn()) return true;
    } catch {
      /* 服务还没起来 / 请求失败：再等等 */
    }
    await sleep(every);
  }
  return false;
}

/** 分公司看板上找这张卡（`/api/tasks` 是全局面板，行里有 manual_id / source / project_name） */
async function cardByTitle(title) {
  const r = await bApi('/api/tasks');
  return (r.body?.rows ?? []).find((x) => x.task === title) ?? null;
}

async function waitCard(title, want, ms = 15000) {
  let got = null;
  const ok = await waitFor(async () => {
    got = await cardByTitle(title);
    return !!got && (!want || got.status === want);
  }, ms);
  return { ok, card: got };
}

async function waitCenterStatus(taskId, want, ms = 15000) {
  let got = null;
  const ok = await waitFor(async () => {
    const r = await cApi(`/api/collab/tasks`);
    got = (r.body?.tasks ?? []).find((t) => t.id === taskId) ?? null;
    return !!got && got.status === want;
  }, ms);
  return { ok, task: got };
}

async function main() {
  console.log('协作中心冒烟（中心 0.0.0.0 鉴权开 / 分公司 127.0.0.1）');

  const up = await waitFor(async () => (await call(CENTER, '/api/hello')).status === 200, 30000);
  check('0 中心起得来', up);
  const up2 = await waitFor(async () => (await call(BRANCH, '/api/hello')).status === 200, 30000);
  check('0 分公司起得来', up2);
  if (!up || !up2) {
    console.log('\n服务没起来，先看日志：\n--- center ---\n' + center.out.slice(-3000) + '\n--- branch ---\n' + branch.out.slice(-3000));
    return;
  }

  // 1 发接入码
  const inv = await cApi('/api/collab/invites', { method: 'POST', body: { label: '办公室那台' } });
  check('1 发接入码 201 且 bi_ 开头', inv.status === 201 && String(inv.body?.code ?? '').startsWith('bi_'), `${inv.status} ${inv.body?.code}`);

  // 2 分公司加入
  const join = await bApi('/api/local/collab/join', {
    method: 'POST',
    body: { url: CENTER, code: inv.body?.code },
  });
  const branchId = join.body?.branchId;
  check(
    '2 分公司加入成功（branchId / projectId / centerLabel）',
    join.status === 200 && !!branchId && !!join.body?.projectId && !!join.body?.centerLabel,
    `${join.status} ${JSON.stringify(join.body)}`,
  );

  // 3 中心看到这台、且 6 秒内在在线
  const online = await waitFor(async () => {
    const r = await cApi('/api/collab/branches');
    const b = (r.body?.branches ?? []).find((x) => x.id === branchId);
    return !!b && b.online === true;
  }, 8000);
  const bl = await cApi('/api/collab/branches');
  check('3 中心列表 1 条且在在线', online && (bl.body?.branches ?? []).length === 1, JSON.stringify(bl.body?.branches));

  // 4 派活
  const t1 = await cApi('/api/collab/tasks', { method: 'POST', body: { branchId, title: '把首页的图换掉', description: '换成本地那张海报' } });
  check('4 派活 201 / 待办 / rev=1', t1.status === 201 && t1.body?.task?.status === '待办' && t1.body?.task?.rev === 1, JSON.stringify(t1.body?.task));

  // 5 分公司 10 秒内出现这张卡
  const c1 = await waitCard('把首页的图换掉', '待办');
  check(
    '5 分公司看板出现卡（source=collab / 项目叫「协作 · …」）',
    c1.ok && c1.card?.source === 'collab' && String(c1.card?.project_name ?? '').startsWith('协作 ·'),
    JSON.stringify(c1.card && { source: c1.card.source, project_name: c1.card.project_name, status: c1.card.status }),
  );
  const cardId = c1.card?.manual_id;

  // 6 分公司改「进行中」→ 中心 10 秒内看到
  const p6 = await bApi(`/api/projects/tasks/${encodeURIComponent(cardId)}`, { method: 'PATCH', body: { status: '进行中' } });
  const w6 = await waitCenterStatus(t1.body?.task?.id, '进行中');
  check('6 分公司改进行中 → 中心 10 秒内同步', p6.status === 200 && w6.ok, `${p6.status} center=${w6.task?.status}`);

  // 7 分公司改「待验收」→ 中心看到
  const p7 = await bApi(`/api/projects/tasks/${encodeURIComponent(cardId)}`, { method: 'PATCH', body: { status: '待验收' } });
  const w7 = await waitCenterStatus(t1.body?.task?.id, '待验收');
  check('7 分公司改待验收 → 中心看到', p7.status === 200 && w7.ok, `${p7.status} center=${w7.task?.status}`);

  // 8 中心验收完成 → 分公司卡跟着变
  const ok8 = await cApi(`/api/collab/tasks/${encodeURIComponent(t1.body?.task?.id)}`, { method: 'PATCH', body: { status: '已完成' } });
  const w8 = await waitCard('把首页的图换掉', '已完成');
  check('8 中心点验收 → 分公司卡变已完成', ok8.status === 200 && w8.ok, `${ok8.status} branch=${w8.card?.status}`);

  // 8b 分公司自己判完成
  const t2 = await cApi('/api/collab/tasks', { method: 'POST', body: { branchId, title: '整理一下发布说明' } });
  const c2 = await waitCard('整理一下发布说明', '待办');
  const p8b = c2.ok
    ? await bApi(`/api/projects/tasks/${encodeURIComponent(c2.card.manual_id)}`, { method: 'PATCH', body: { status: '已完成' } })
    : { status: 0 };
  const w8b = await waitCenterStatus(t2.body?.task?.id, '已完成');
  check('8b 分公司自判完成 → 中心 10 秒内看到', p8b.status === 200 && w8b.ok, `${p8b.status} center=${w8b.task?.status}`);

  // 9 中心取消
  const t3 = await cApi('/api/collab/tasks', { method: 'POST', body: { branchId, title: '这条不做了' } });
  const c3 = await waitCard('这条不做了', '待办');
  const ok9 = await cApi(`/api/collab/tasks/${encodeURIComponent(t3.body?.task?.id)}`, { method: 'PATCH', body: { status: '已取消' } });
  const w9 = await waitCard('这条不做了', '已取消');
  check('9 中心取消 → 分公司卡变已取消', c3.ok && ok9.status === 200 && w9.ok, `${ok9.status} branch=${w9.card?.status}`);

  // 10 只读：本地改标题
  const p10 = await bApi(`/api/projects/tasks/${encodeURIComponent(c3.card?.manual_id)}`, { method: 'PATCH', body: { title: '改个名' } });
  check('10 本地改标题被拒 400 E4046', p10.status === 400 && p10.body?.code === 'E4046', `${p10.status} ${p10.body?.code}`);

  // 10b 本地删协作卡 / 本地判「已取消」也该拦
  const p10b = await bApi(`/api/projects/tasks/${encodeURIComponent(c3.card?.manual_id)}`, { method: 'DELETE' });
  check('10b 本地删协作卡被拒 400 E4046', p10b.status === 400 && p10b.body?.code === 'E4046', `${p10b.status} ${p10b.body?.code}`);

  // 11 令牌（HTTP 头只能放 ASCII —— 乱码令牌用 ASCII 的假串）
  const noTok = await call(CENTER, '/api/collab/poll', { method: 'POST', body: {} });
  const badTok = await call(CENTER, '/api/collab/poll', { method: 'POST', body: {}, token: 'bc_garbage-token' });
  check(
    '11 无令牌 401 / 乱码令牌 401 E4044',
    noTok.status === 401 && badTok.status === 401 && badTok.body?.code === 'E4044',
    `${noTok.status}/${badTok.status} ${badTok.body?.code}`,
  );

  // 12 移除
  const rev = await cApi(`/api/collab/branches/${encodeURIComponent(branchId)}/revoke`, { method: 'POST', body: {} });
  const revoked = await waitFor(async () => (await bApi('/api/local/collab/status')).body?.revoked === true, 15000);
  const afterRevoke = await cApi('/api/collab/branches');
  const revRow = (afterRevoke.body?.branches ?? []).find((x) => x.id === branchId);
  check('12 中心移除 → 分公司状态变「已被移除」，中心列表留痕', rev.status === 200 && revoked && !!revRow?.revokedAt, `${rev.status} revoked=${revoked}`);

  // 15 重复加入（此时 collab.json 还在）
  const again = await bApi('/api/local/collab/join', { method: 'POST', body: { url: CENTER, code: inv.body?.code } });
  check('15 已有 collab.json 再加入 → 409 E4042', again.status === 409 && again.body?.code === 'E4042', `${again.status} ${again.body?.code}`);

  // 14 中心挂了，分公司照常（卡还在、状态显示离线）
  const projectsBefore = await bApi('/api/projects');
  const projId = join.body?.projectId;
  await stop(center);
  await sleep(6000); // 让它至少失败一拍，状态页才会显示离线
  const tasksAfter = await bApi('/api/tasks');
  const stAfter = await bApi('/api/local/collab/status');
  check(
    '14 中心挂掉：/api/tasks 仍 200 且卡还在，状态显示离线',
    tasksAfter.status === 200 && (tasksAfter.body?.rows ?? []).some((r) => r.source === 'collab') && stAfter.body?.online === false && stAfter.body?.joined === true,
    `tasks=${tasksAfter.status} rows=${(tasksAfter.body?.rows ?? []).length} online=${stAfter.body?.online}`,
  );

  // 13 退出（中心已挂，best-effort 也要退得掉）
  const lv = await bApi('/api/local/collab/leave', { method: 'POST', body: {} });
  const st13 = await bApi('/api/local/collab/status');
  const tasks13 = await bApi('/api/tasks');
  const proj13 = await bApi('/api/projects');
  const projectKept = (proj13.body?.projects ?? []).some((p) => p.id === projId);
  check(
    '13 退出：200 / joined:false / 本地项目与卡片都还在',
    lv.status === 200 && st13.body?.joined === false && projectKept && (tasks13.body?.rows ?? []).length > 0,
    `${lv.status} joined=${st13.body?.joined} project=${projectKept} rows=${(tasks13.body?.rows ?? []).length}`,
  );
  void projectsBefore;

  // 附：分公司自己的项目根确实落在数据目录下（不是随手找个目录糊弄）
  check(
    '13b 本地项目目录在 <数据目录>/collab/<branchId>/',
    fs.existsSync(path.join(BRANCH_DATA, 'collab', String(branchId))),
    path.join(BRANCH_DATA, 'collab', String(branchId)),
  );
}

try {
  await main();
} catch (e) {
  failed += 1;
  console.log(`\n✗ 用例自己崩了：${e?.stack ?? e}`);
} finally {
  await stop(center);
  await stop(branch);
  for (const k of kids) {
    if (k.out && /Error|error:/.test(k.out)) {
      // 只在真出错时打一眼尾巴，正常跑完不留噪音
      console.log(`\n[${k === center ? 'center' : 'branch'} 日志尾巴]\n${k.out.slice(-1200)}`);
    }
  }
  console.log(`\n${failed === 0 ? '全部通过' : `${failed} 条没过`}（临时目录 ${tmp}）`);
  process.exit(failed === 0 ? 0 : 1);
}
