/**
 * 技能隐私（2026-11-22）：技能页只显示简介 —— **内置技能的正文不该出服务端**。
 *
 * 用户原话："技能页改成弹窗显示，不要显示技能的详细内容，只要显示简介就行 ——
 * 这样可以保护 skill 的隐私，我看 workbuddy 就做的很好"。
 *
 * 为什么这条要单独立一个冒烟：只在前端"不画正文"是假隐私 —— 打开开发者工具看一眼
 * `GET /api/skills/:name` 就全拿到了。所以档口在服务端（`routes/skill.mjs` 的 GET：
 * builtin → `body: ''` + `bodyHidden: true`），这条用例盯的就是那一道。
 *
 * 同时也盯住反方向：**自建技能必须照旧回正文** —— 用户自己写的东西得能改，
 * 一刀切会把编辑功能做死。
 *
 * 隔离：临时数据目录 + 独立端口，不碰 data/ 里的真账。技能库读的是仓库里的 `skills/`
 * （只读，一个字节都不写：用现成的 bandi-git / bandi-report 做样本）。
 * 跑法：node apps/server/src/smoke-skill-privacy.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-skill-privacy-'));

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const PORT = Number(process.env.SMOKE_PORT ?? 8911);
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs')], {
  cwd: repoRoot,
  env: { ...process.env, BANDI_HOST: '127.0.0.1', BANDI_PORT: String(PORT), BANDI_DATA: tmp, BANDI_DB: path.join(tmp, 'bandi.db') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (b) => { serverLog += b.toString(); });
child.stderr.on('data', (b) => { serverLog += b.toString(); });

const req = async (p, opt = {}) => {
  const r = await fetch(BASE + p, { ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers ?? {}) } });
  const text = await r.text();
  let b = null;
  try {
    b = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: r.status, b };
};

try {
  let up = false;
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(BASE + '/api/state')).ok) {
        up = true;
        break;
      }
    } catch {
      /* 还没起 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  check('控制面起来了', up);
  if (!up) console.log(serverLog.split('\n').slice(-15).join('\n'));

  if (up) {
    console.log('\n① 内置技能：正文不下发（bandi-git 是出厂技能）');
    const g = await req('/api/skills/bandi-git');
    check('GET /api/skills/bandi-git → 200', g.status === 200, String(g.status));
    check('回的是内置标记', g.b?.skill?.builtin === true, String(g.b?.skill?.builtin));
    check('正文被摘成空串', g.b?.skill?.body === '', JSON.stringify(String(g.b?.skill?.body ?? '').slice(0, 40)));
    check('带 bodyHidden 标记（前端据此知道是刻意不给，不是文件空）', g.b?.skill?.bodyHidden === true, String(g.b?.skill?.bodyHidden));
    check('简介照旧给（那一句才是界面要显示的东西）', String(g.b?.skill?.description ?? '').length > 10, String(g.b?.skill?.description ?? '').slice(0, 40));

    console.log('\n② 自建技能：正文照旧下发（bandi-report 不在内置清单）');
    const r = await req('/api/skills/bandi-report');
    check('GET /api/skills/bandi-report → 200', r.status === 200, String(r.status));
    check('不是内置', r.b?.skill?.builtin === false, String(r.b?.skill?.builtin));
    check('正文给全（不截断、不是空串）', String(r.b?.skill?.body ?? '').length > 200, `${String(r.b?.skill?.body ?? '').length} 字`);
    check('没有 bodyHidden 标记', r.b?.skill?.bodyHidden === undefined, String(r.b?.skill?.bodyHidden));

    console.log('\n③ 列表接口：一项都不带正文');
    const l = await req('/api/skills');
    const rows = l.b?.skills ?? [];
    check('GET /api/skills → 200', l.status === 200, String(l.status));
    check('列表非空', rows.length > 0, `${rows.length} 个`);
    check('每一项都没有 body 字段', rows.every((s) => s.body === undefined), rows.filter((s) => s.body !== undefined).map((s) => s.name).join(','));
    check('列表里 bandi-git 仍标着内置', rows.find((s) => s.name === 'bandi-git')?.builtin === true);

    console.log('\n④ 看不了也改不了：内置技能的写入闸还在');
    const put = await req('/api/skills/bandi-git', { method: 'PUT', body: JSON.stringify({ description: 'x', body: 'y' }) });
    check('PUT 内置技能 → 403 E4033', put.status === 403 && put.b?.code === 'E4033', `${put.status} ${put.b?.code ?? ''}`);
    const del = await req('/api/skills/bandi-git', { method: 'DELETE' });
    check('DELETE 内置技能 → 403 E4033', del.status === 403 && del.b?.code === 'E4033', `${del.status} ${del.b?.code ?? ''}`);

    console.log('\n⑤ 不存在的技能照旧 404（别把"隐私"实现成"全都 404"）');
    const no = await req('/api/skills/no-such-skill-here');
    check('GET 不存在的技能 → 404 E2017', no.status === 404 && no.b?.code === 'E2017', `${no.status} ${no.b?.code ?? ''}`);
  }
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 临时目录，删不掉就算了 */
  }
}

console.log(`\n结论：${failed ? `有 ${failed} 项没通过` : '全通过'}`);
process.exit(failed ? 1 : 0);
