/**
 * 「研发面板」（插件 id 仍是 project-panel）的验收：接口读得对、读不通的照样列出来、只读是真的只读。
 *
 * 隔离：临时数据库、临时端口、临时项目目录 —— 不碰 data/ 里的真账。
 * 2026-10-15 起 `BANDI_DATA` 也能指了，于是 **plugins 目录与账本也进隔离范围**：
 * 以前只有 `BANDI_DB` 能指，那个目录照样写真实 `data/`，所以这个用例当时只能
 * 「不安装插件」来回避 —— 现在不必了。
 *
 * 跑法：node apps/server/src/smoke-status.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repoRoot } from './config.mjs';
import { parseStatus, readScope } from './status.mjs';

const PORT = Number(process.env.SMOKE_PORT ?? 8793);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-status-'));

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};
const api = async (p, opts) => {
  const res = await fetch(BASE + p, opts);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const post = (p, body) =>
  api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

/* 一个"能读通"的假项目：故意用契约里的三种形状（顶层标量 / 映射列表 / 映射套列表） */
const goodRoot = path.join(tmp, 'good-project');
fs.mkdirSync(path.join(goodRoot, '.bandi'), { recursive: true });
fs.mkdirSync(path.join(goodRoot, 'docs'), { recursive: true });
fs.writeFileSync(
  path.join(goodRoot, '.bandi', 'status.yaml'),
  `# 注释行：解析器要跳过
updated: 2026-10-14 12:00
project: 假项目   # 行尾注释不能被当成取值
stage: 开发
live_version: 2.10.0
doc_index:
  root: docs
  mirrors:
    - README.md
    - docs/入口.md
versions:
  - version: 2.2.0
    title: 老版本
    scope: docs/版本记录.md#v2.2.0
    released: docs/发布/v2.2.0.md
  - version: 2.10.0
    title: 新版本
    scope: docs/版本记录.md#v2.10.0
    released:
# tasks 段：接口已经不输出卡片了，这里故意留着 —— 真项目里都还有，解析器不该被它带歪
tasks:
  - id: T-001
    title: 第一张卡
    owner: 研发
    status: 已发布
    evidence: docs/证据/T-001.md
    version: 2.2.0
  - id: T-002
    title: 第二张卡
    owner: 测试
    status: 待开发
    version: 2.10.0
  - id: T-003
    title: 没挂版本的卡
    owner: 产品经理
    status: 待开发
`,
  'utf8',
);
fs.writeFileSync(
  path.join(goodRoot, 'docs', '版本记录.md'),
  `# 版本记录

## v2.2.0

老版本把地基打了。**只**做三件事：

- 建仓库
- 定契约
- 通链路

## v2.10.0

新版本主线是**面板插件化**，把旧面板收成只读记录。

- 解析 status.yaml
- 声明式面板
- 越权用例
`,
  'utf8',
);

/* 「最新发布」用：多版已发布，且最后一个版本未发布 —— 取的是最后一个 released 非空的项。
 * 版本号故意写 2.9.0 / 2.10.0：按字符串排序会把 2.9.0 排到最后，正好验出"不排序"。 */
const multiRoot = path.join(tmp, 'multi-release-project');
fs.mkdirSync(path.join(multiRoot, '.bandi'), { recursive: true });
fs.writeFileSync(
  path.join(multiRoot, '.bandi', 'status.yaml'),
  `updated: 2026-10-24 10:00
project: 多版发布项目
versions:
  - version: 2.9.0
    title: 九
    released: docs/发布/v2.9.0.md
  - version: 2.10.0
    title: 十
    released: docs/发布/v2.10.0.md
  - version: 2.11.0
    title: 十一
    released:
`,
  'utf8',
);

/* 一个"读不通"的项目：没有 .bandi/status.yaml */
const offlineRoot = path.join(tmp, 'offline-project');
fs.mkdirSync(offlineRoot, { recursive: true });

/* 一个"想越权"的项目：scope 指向项目根之外 */
const escapingRoot = path.join(tmp, 'escaping-project');
fs.mkdirSync(path.join(escapingRoot, '.bandi'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'secret.md'), '# 机密\n\n这段文字绝不该出现在接口返回里。\n', 'utf8');
fs.writeFileSync(
  path.join(escapingRoot, '.bandi', 'status.yaml'),
  `updated: 2026-10-14 12:00
project: 越权项目
versions:
  - version: 1.0.0
    title: 越权读
    scope: ../../secret.md
  - version: 1.0.1
    title: 绝对路径读
    scope: C:\\Windows\\win.ini
tasks: []
`,
  'utf8',
);

console.log('① 解析器本身（不启服务）');
const parsed = parseStatus(fs.readFileSync(path.join(goodRoot, '.bandi', 'status.yaml'), 'utf8'));
check('顶层标量读到了', parsed.project === '假项目', JSON.stringify(parsed.project));
check('行尾注释被切掉', parsed.stage === '开发', JSON.stringify(parsed.stage));
check('映射套列表（doc_index.mirrors）读到了', Array.isArray(parsed.doc_index?.mirrors) && parsed.doc_index.mirrors.length === 2);
check('versions 是映射列表', Array.isArray(parsed.versions) && parsed.versions[0].version === '2.2.0');
check('解析器照旧认映射列表形状（拿 tasks 段当样本，接口已不输出）', Array.isArray(parsed.tasks) && parsed.tasks.length === 3);
const scope = readScope(goodRoot, 'docs/版本记录.md#v2.10.0');
check('锚点定位到了 v2.10.0', scope.title === 'v2.10.0', scope.title);
check('要点抽到了（摘要 + 列表项）', scope.bullets.length >= 4, JSON.stringify(scope.bullets));
check('Markdown 标记折成纯文本', scope.bullets.some((b) => b.includes('面板插件化') && !b.includes('**')));
check('越权路径被拒', readScope(escapingRoot, '../../secret.md').ok === false);

// 服务端日志写文件、不走管道：Windows 受限环境下 `spawn` 配 `pipe` stdio 会 EPERM
// （命名管道打不开）。写文件同样拿得到日志，还不受这个限制。
const logPath = path.join(tmp, 'server.log');
const logFd = fs.openSync(logPath, 'a');
const child = spawn(process.execPath, [path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs')], {
  cwd: repoRoot,
  env: { ...process.env, BANDI_PORT: String(PORT), BANDI_DATA: tmp, BANDI_DB: path.join(tmp, 'bandi.db') },
  windowsHide: true,
  stdio: ['ignore', logFd, logFd],
});
fs.closeSync(logFd);
const serverLog = () => {
  try {
    return fs.readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
};

try {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(BASE + '/api/projects')).ok) break;
    } catch {
      /* 还没起 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log('\n② 接口：三个项目各是一种情况');
  const good = await post('/api/projects', { name: '假项目', root: goodRoot });
  const offline = await post('/api/projects', { name: '读不通的项目', root: offlineRoot });
  const escaping = await post('/api/projects', { name: '越权项目', root: escapingRoot });
  const multi = await post('/api/projects', { name: '多版发布项目', root: multiRoot });
  check('四个项目都登记上了', [good, offline, escaping, multi].every((r) => r.status === 201));

  const list = await api('/api/status/projects');
  check('总览接口 200', list.status === 200);
  const cards = list.body?.projects ?? [];
  const cardOf = (id) => cards.find((c) => c.id === id);
  const goodCard = cardOf(good.body.project.id);
  const offlineCard = cardOf(offline.body.project.id);
  check('能读通的项目标「已纳管」', !!goodCard?.ok, goodCard?.subtitle);
  check('版本数按 status.yaml 算', goodCard?.version_count === 2, String(goodCard?.version_count));
  check('总览里没有卡片数了（task_count 已删）', !('task_count' in (goodCard ?? {})), Object.keys(goodCard ?? {}).join(','));
  check('已发布版本算得对', goodCard?.released_count === 1, String(goodCard?.released_count));
  check('读不通的项目照样列出来且标「未纳管」', !!offlineCard && offlineCard.ok === false && /未纳管/.test(offlineCard.subtitle), offlineCard?.subtitle);

  console.log('\n②-1 总览：最新发布字段');
  check(
    '多版发布：取最后一个 released 非空的（跳过末尾未发布的 2.11.0，也不按字符串排）',
    cardOf(multi.body.project.id)?.latest_released_version === '2.10.0',
    JSON.stringify(cardOf(multi.body.project.id)?.latest_released_version),
  );
  check(
    '多版发布：发布记录路径跟着那一版走',
    cardOf(multi.body.project.id)?.latest_released_path === 'docs/发布/v2.10.0.md',
    JSON.stringify(cardOf(multi.body.project.id)?.latest_released_path),
  );
  check(
    '末版未发布时仍取前一版（不是空串）',
    goodCard?.latest_released_version === '2.2.0' && goodCard?.latest_released_path === 'docs/发布/v2.2.0.md',
    JSON.stringify([goodCard?.latest_released_version, goodCard?.latest_released_path]),
  );
  const escCard = cardOf(escaping.body.project.id);
  check(
    '全未发布：两个字段都是空串（不是 null）',
    escCard?.latest_released_version === '' && escCard?.latest_released_path === '',
    JSON.stringify([escCard?.latest_released_version, escCard?.latest_released_path]),
  );
  check(
    '未纳管项目也出这两个字段且为空串',
    'latest_released_version' in (offlineCard ?? {})
      && offlineCard?.latest_released_version === ''
      && offlineCard?.latest_released_path === '',
    JSON.stringify([offlineCard?.latest_released_version, offlineCard?.latest_released_path]),
  );

  console.log('\n③ 详情：版本 / 要点');
  const detail = await api(`/api/status/projects/${encodeURIComponent(good.body.project.id)}`);
  const d = detail.body ?? {};
  check('详情接口 200', detail.status === 200);
  check('版本清单 2 条（卡片没了，就没有「未归属」那一行）', d.versions?.length === 2, JSON.stringify(d.versions?.map((v) => v.version)));
  check('已发布的那个带发布记录路径', d.versions?.find((v) => v.version === '2.2.0')?.released_path === 'docs/发布/v2.2.0.md');
  check('未发布的标「未发布」', d.versions?.find((v) => v.version === '2.10.0')?.released_note === '未发布');
  check('要点摘出来了', (d.versions?.find((v) => v.version === '2.10.0')?.points_text ?? '').includes('面板插件化'), d.versions?.find((v) => v.version === '2.10.0')?.points_text);
  // 回归：status.yaml 里的 tasks 段还在（真项目都还挂着卡），但它不许再从接口漏出来
  check('卡片不再出现在详情里', !('tasks' in d) && !('task_count' in d) && !JSON.stringify(d).includes('第一张卡'), Object.keys(d).join(','));
  check('版本行上也没有卡片计数', !d.versions?.some((v) => 'total' in v || 'unregistered' in v));

  console.log('\n④ 只读边界');
  const escDetail = await api(`/api/status/projects/${encodeURIComponent(escaping.body.project.id)}`);
  const escText = JSON.stringify(escDetail.body ?? {});
  check('越界 scope 被拒（返回里说明原因）', /scope 必须/.test(escText), escDetail.body?.versions?.[0]?.points_note ?? '');
  check('机密文件的内容一个字都没漏出来', !escText.includes('绝不该出现在接口返回里'));
  check('绝对路径 scope 也被拒', /scope 必须/.test(JSON.stringify(escDetail.body?.versions?.[1]?.points_note ?? '')));
  const missing = await api('/api/status/projects/pj-不存在');
  check('不存在的项目 404', missing.status === 404);
  const write = await api('/api/status/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check('没有写接口（POST 落到 404）', write.status === 404, String(write.status));
  check('冒烟跑完临时项目根里的文件没被动过', fs.readFileSync(path.join(goodRoot, '.bandi', 'status.yaml'), 'utf8').includes('live_version: 2.10.0'));
} catch (err) {
  console.log('\n跑挂了：' + String(err?.message ?? err));
  failed += 1;
} finally {
  try {
    child.kill();
  } catch {
    /* 已经退了 */
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 删不掉就算了 */
  }
}

console.log(`\n结论：${failed ? `${failed} 项没通过` : '全通过'}`);
if (failed) console.log('服务端日志：\n' + serverLog().slice(0, 1500));
process.exit(failed ? 1 : 0);
