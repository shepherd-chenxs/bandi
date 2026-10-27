/**
 * 声明式插件的新版式块（2026-10-24）：`stats` / `cards` / `aside` 两列版式。
 *
 * 为什么要单开一个用例：这次给宿主加的是**版式能力**，宿主里的算子（filter / sort / limit /
 * calc 四种聚合）一旦算错，页面只是"数字不对"，不会报错 —— 没人会去点。所以这几种算子
 * 全部拿纯函数直接钉住，再顺手校验两份 manifest 与几个"写错了要拦住"的形状。
 *
 * 不启服务、不碰真实 data/（插件数据整形是纯函数，见 apps/web/js/plugin-data.mjs）。
 * 跑法：node apps/server/src/smoke-plugin-blocks.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from './plugins.mjs';
import { applySource, calcVars } from '../../web/js/plugin-data.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(repoRoot, p), 'utf8'));

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

/* 一份最小的合法面板，用来测"形状写错了会不会被拦" */
const base = (blocks, perms = ['GET:/api/status/projects']) => ({
  id: 'x',
  label: 'X',
  panel: { slot: 'plugins', mode: 'declarative', blocks },
  permissions: perms,
});
const errs = (blocks, perms) => validateManifest(base(blocks, perms), 'x').errors;

/* ------------------------------------------------ ① 两种新块 + aside */

console.log('① 新块通过校验');
{
  const ok = validateManifest(
    base([
      { type: 'stats', source: { api: '/api/status/projects', pick: 'projects' }, items: [{ label: '总数', value: '{n}', calc: 'count' }] },
      {
        type: 'cards',
        heading: '项目进度',
        subheading: '已纳管 {shown_count} 个',
        source: { api: '/api/status/projects', pick: 'projects', filter: { field: 'ok', is: true }, sort: { by: 'updated', dir: 'desc' }, limit: 5 },
        columns: 3,
        card: { title: '{name}', badge: '{status_text}', badgeTone: 'ok', lines: [{ label: '版本', value: '{version_count}' }], href: '#/project/{id}' },
      },
      { type: 'list', aside: true, source: { api: '/api/status/projects', pick: 'projects' }, title: '{name}', subtitle: '{updated}' },
    ]),
    'x',
  );
  check('stats + cards + aside:list 一起是合法的', ok.errors.length === 0, ok.errors.join('；'));
}

console.log('\n② 写错了要拦住（不然只是"画出来不对"，没人发现）');
{
  check('stats 缺 items', errs([{ type: 'stats', items: [] }]).some((e) => e.includes('要有 items')));
  check('stats 项缺 label', errs([{ type: 'stats', items: [{ value: '{n}', calc: 'count' }] }]).some((e) => e.includes('缺 label')));
  check('stats 项既没 value 也没 calc',
    errs([{ type: 'stats', items: [{ label: '总数' }] }]).some((e) => e.includes('要写 value 或 calc')));
  check('calc 算子不认识',
    errs([{ type: 'stats', items: [{ label: '总数', value: '{n}', calc: 'average' }] }]).some((e) => e.includes('算子不认识')));
  check('calc.countIf 缺字段',
    errs([{ type: 'stats', items: [{ label: '总数', value: '{n}', calc: { countIf: '' } }] }]).some((e) => e.includes('要写字段名')));
  check('calc.sumIf 缺 where',
    errs([{ type: 'stats', items: [{ label: '总数', value: '{n}', calc: { sumIf: { field: 'released_count' } } }] }])
      .some((e) => e.includes('缺 where')));
  check('tone 只认三档',
    errs([{ type: 'stats', items: [{ label: '总数', value: '{n}', calc: 'count', tone: 'red' }] }]).some((e) => e.includes('tone')));
  check('cards 缺 card', errs([{ type: 'cards', source: { api: '/api/status/projects' } }]).some((e) => e.includes('要有 card')));
  check('cards.card 缺 title',
    errs([{ type: 'cards', source: { api: '/api/status/projects' }, card: { subtitle: '{x}' } }]).some((e) => e.includes('缺 title')));
  check('cards.badgeTone 不认识的档位',
    errs([{ type: 'cards', source: { api: '/api/status/projects' }, card: { title: '{n}', badgeTone: 'danger' } }])
      .some((e) => e.includes('badgeTone')));
  check('aside 只给 cards / list',
    errs([{ type: 'table', aside: true, source: { api: '/api/status/projects' }, columns: [{ label: 'A', key: 'a' }] }])
      .some((e) => e.includes('aside 只支持')));
  check('source.filter 缺 field',
    errs([{ type: 'cards', source: { api: '/api/status/projects', filter: { is: true } }, card: { title: '{n}' } }])
      .some((e) => e.includes('filter 缺 field')));
  check('source.sort.dir 只认 asc / desc',
    errs([{ type: 'cards', source: { api: '/api/status/projects', sort: { by: 'updated', dir: 'down' } }, card: { title: '{n}' } }])
      .some((e) => e.includes('sort.dir')));
  check('source.limit 要是正整数',
    errs([{ type: 'cards', source: { api: '/api/status/projects', limit: 0 }, card: { title: '{n}' } }])
      .some((e) => e.includes('limit')));
}

/* ------------------------------------------------------- ③ 数据整形算子 */

console.log('\n③ filter / sort / limit / calc 算得对');
{
  const rows = [
    { ok: true, released_count: 3, updated: '2026-10-20 10:00' },
    { ok: false, released_count: 0, updated: '' },
    { ok: true, released_count: 1, updated: '2026-10-23 09:00' },
    { ok: true, released_count: 0, updated: '2026-10-21 12:00' },
  ];
  const f = applySource(rows, { filter: { field: 'ok', is: true } });
  check('filter 按 is:true 筛', f.rows.length === 3, String(f.rows.length));
  check('total 是筛之前的行数', f.total === 4, String(f.total));
  const f2 = applySource(rows, { filter: { field: 'ok', is: false } });
  check('filter 按 is:false 筛（未纳管那一条）', f2.rows.length === 1 && f2.rows[0].updated === '');
  check('filter 省略 is = 取真值', applySource(rows, { filter: { field: 'released_count' } }).rows.length === 2);

  const desc = applySource(rows, { sort: { by: 'updated', dir: 'desc' } }).rows.map((r) => r.updated);
  check('按 updated 倒序（最近的在最前）', desc[0] === '2026-10-23 09:00' && desc[1] === '2026-10-21 12:00', desc.join(' | '));
  const asc = applySource(rows, { sort: { by: 'updated', dir: 'asc' } }).rows.map((r) => r.updated);
  check('升序时空值也垫底（空 = 没有值，不是最小值）', asc[asc.length - 1] === '', asc.join(' | '));
  check('limit 截前 N 行', applySource(rows, { sort: { by: 'updated', dir: 'desc' }, limit: 2 }).rows.length === 2);

  const v = calcVars(
    {
      all: 'count',
      managed: { countIf: 'ok' },
      pending: { countIf: { field: 'ok', is: false } },
      released: { sum: 'released_count' },
      releasedManaged: { sumIf: { field: 'released_count', where: 'ok' } },
    },
    rows,
  );
  check('calc count', v.all === 4, String(v.all));
  check('calc countIf（字段名写法）', v.managed === 3, String(v.managed));
  check('calc countIf（{field,is} 写法）', v.pending === 1, String(v.pending));
  check('calc sum', v.released === 4, String(v.released));
  check('calc sumIf', v.releasedManaged === 4, String(v.releasedManaged));
  check('一条声明算多个变量（每个键各自成变量）',
    ['all', 'managed', 'pending', 'released', 'releasedManaged'].every((k) => typeof v[k] === 'number'),
    JSON.stringify(v));

  // sumIf 真的会筛：把未纳管那条的 released_count 写大，它不该被算进去
  const trap = [
    { ok: true, released_count: 2 },
    { ok: false, released_count: 99 },
  ];
  check('sumIf 不把未纳管的算进来',
    calcVars({ s: { sumIf: { field: 'released_count', where: 'ok' } } }, trap).s === 2,
    String(calcVars({ s: { sumIf: { field: 'released_count', where: 'ok' } } }, trap).s));
}

/* ------------------------------------------------------ ④ 两份 manifest */

console.log('\n④ 两份 manifest 逐字节一致、结构照稿');
{
  const A = 'plugins/project-panel/manifest.json';
  const B = 'apps/server/catalog/plugins/project-panel/manifest.json';
  check('两份 manifest 逐字节一致', fs.readFileSync(path.join(repoRoot, A)).equals(fs.readFileSync(path.join(repoRoot, B))));

  const m = readJson(A);
  check('面板校验通过', validateManifest(m, 'project-panel').errors.length === 0, validateManifest(m, 'project-panel').errors.join('；'));
  check('不再有 split（左列表 + 右详情已否）', !m.panel.split);
  const types = m.panel.blocks.map((b) => b.type);
  check('区块顺序：text → stats → cards（主列）→ cards（右栏）→ list（右栏）',
    types.join(',') === 'text,stats,cards,cards,list', types.join(','));
  const aside = m.panel.blocks.filter((b) => b.aside).map((b) => b.heading ?? b.type);
  check('右栏两块（需要处理 / 最近动态）', aside.join(',') === '需要处理,最近动态', aside.join(','));
  /*
   * 2026-10-27 起面板要能「选择纳管哪些项目」，于是多两个口：账本全量（只读）+ 整表提交。
   * 断言收紧成**穷举**而不是"含这三个" —— 插件一旦多申一个写权限，这里就该红。
   */
  check('权限只有三条（面板数据 + 账本 + 纳管保存）',
    m.permissions.join(',') === 'GET:/api/status/projects,GET:/api/status/ledger,POST:/api/status/managed',
    m.permissions.join(','));
  const manage = m.panel.blocks.find((b) => b.manage)?.manage;
  check('「选择项目」挂在项目进度那张卡的标题行（不是独立一节）',
    !!manage && m.panel.blocks.find((b) => b.manage)?.heading === '项目进度', JSON.stringify(manage?.label));
  check('选择弹窗的数据源是账本全量、保存走整表提交',
    manage?.source?.api === '/api/status/ledger' && manage?.save?.api === '/api/status/managed' && manage?.save?.field === 'ids',
    JSON.stringify([manage?.source?.api, manage?.save]));
  check('首屏没有版本明细表', !m.panel.blocks.some((b) => b.type === 'table'));
  const stats = m.panel.blocks.find((b) => b.type === 'stats');
  check('KPI 四项（已纳入 / 有进度 / 缺进度 / 已发布）', stats.items.length === 4, stats.items.map((i) => i.label).join(' | '));
  check('KPI 的聚合是写在 manifest 里的 calc（宿主没有业务字眼）',
    stats.items.every((i) => i.calc !== undefined), JSON.stringify(stats.items.map((i) => i.calc)));
  const main = m.panel.blocks.filter((b) => b.type === 'cards' && !b.aside)[0];
  check('主列卡片只画已纳管（filter ok:true）', main.source.filter?.field === 'ok' && main.source.filter?.is === true);
  check('主列三列（照稿）', main.columns === 3);
  check('筛掉的条数进 subheading（{shown_count}）', /\{shown_count\}/.test(main.subheading), main.subheading);
  check('卡片可点（data-card-href 的模板）', String(main.card.href).includes('{id}'), String(main.card.href));
  check('卡上带「最新发布」两字段，字段没落时用 fallback 文案',
    main.card.foot?.[0]?.label === '最新发布' && /latest_released_version/.test(main.card.foot[0].value) && !!main.card.foot[0].fallback,
    JSON.stringify(main.card.foot?.[0]));
}

/* ------------------------------------- ⑤ 老插件不受影响（形状没被新规则波及） */

console.log('\n⑤ 老插件（ssh）的 manifest 照样合法');
for (const p of ['plugins/ssh/manifest.json', 'apps/server/catalog/plugins/ssh/manifest.json']) {
  if (!fs.existsSync(path.join(repoRoot, p))) continue;
  const m = readJson(p);
  const r = validateManifest(m, 'ssh');
  check(`${p} 校验通过`, r.errors.length === 0, r.errors.join('；'));
  check(`${p} 没被新块影响（还是老块类型）`,
    m.panel.blocks.every((b) => !['stats', 'cards'].includes(b.type)),
    m.panel.blocks.map((b) => b.type).join(','));
}

console.log(`\n结论：${failed ? `${failed} 项没通过` : '全通过'}`);
process.exit(failed ? 1 : 0);
