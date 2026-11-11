/* org.mjs —— 组织架构（2026-11-11 Phase 3）。
 *
 * 左栏一级「组织架构」+ 二级子菜单；当前只有一个子项「岗位权限清单」——
 * 岗位是**系统内置的固定清单**：权限与**技能包**都挂在岗位上（见服务端 roles.mjs），
 * 这一页只做**只读展示**：每个岗位有什么权限、挂哪些技能、现在有谁在岗。
 *
 * 为什么单独开一页而不是塞进设置：用户拍板「左侧菜单栏加一个组织架构菜单，
 * 子菜单做岗位权限清单」—— 这是"组织长什么样"的常驻视图，不是一次性配置。
 *
 * 只读：改岗位权限/技能包只能改 roles.mjs 发版；人不能调岗（换岗 = 解聘重雇）。
 */
import { esc, setRoute } from './shell.mjs';
import { showView } from './contacts.mjs';
import { headRow } from './connectors.mjs';
import { $, S } from './core.mjs';

/** 二级子菜单。以后要加「部门」「在岗人员」之类的页，往这里加一项即可 */
export const ORG_SECTIONS = [
  { id: 'roles', title: '岗位权限清单', sub: '权限与技能包（只读）' },
];

/** 权限 key → 短名（表格里放得下；长说明在 title 里） */
const PERM_SHORT = {
  'card.create': '建卡',
  'card.split': '拆子卡',
  'card.advance': '改卡',
  'team.coordinate': '承接团队卡',
  'task.review': '验收（预留）',
};

const KIND_LABEL = { expert: '专家岗', builtin: '内置岗' };

/** 左栏二级列表：组织架构的子菜单（renderList 在 nav === 'org' 时调它） */
export function renderOrgList() {
  const body = $('listBody');
  if (!body) return;
  body.innerHTML = ORG_SECTIONS.map(
    (s) => `<div class="item ${S.orgSection === s.id ? 'active' : ''}" data-org="${esc(s.id)}">
      <div class="who"><div class="line1"><b>${esc(s.title)}</b></div><div class="line2">${esc(s.sub)}</div></div>
    </div>`,
  ).join('');
  body.querySelectorAll('[data-org]').forEach((el) => {
    el.onclick = () => openOrg(el.dataset.org);
    el.onkeydown = (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      openOrg(el.dataset.org);
    };
  });
}

/** 岗位权限清单的正文（只读） */
function rolesPanelHTML() {
  const roles = S.roles ?? [];
  const people = S.personas ?? [];
  const permText = S.permissions ?? {};
  const skillDesc = new Map((S.skills ?? []).map((s) => [s.name, s.description ?? '']));

  const rows = roles
    .map((r) => {
      const who = people.filter((p) => (p.roleKey ?? '') === r.key);
      const onDuty = who.length
        ? `<span title="${esc(who.map((p) => p.name).join('、'))}">${esc(who.map((p) => p.name).join('、'))}</span>`
        : '<span class="dim">—</span>';
      const perms = (r.permissions ?? []).length
        ? r.permissions
            .map(
              (p) =>
                `<span class="org-chip perm" title="${esc(permText[p] ?? p)}">${esc(PERM_SHORT[p] ?? p)}</span>`,
            )
            .join('')
        : '<span class="dim">无</span>';
      const skills = (r.skills ?? []).length
        ? r.skills
            .map((n) => `<span class="org-chip" title="${esc(skillDesc.get(n) ?? '')}">${esc(n)}</span>`)
            .join('')
        : '<span class="dim">无</span>';
      return `<tr>
        <td class="org-role"><b>${esc(r.name)}</b><span class="dim">${esc(r.key)}</span></td>
        <td>${KIND_LABEL[r.kind] ? `<span class="pill">${KIND_LABEL[r.kind]}</span>` : esc(r.kind ?? '')}</td>
        <td class="org-duty">${onDuty}</td>
        <td>${perms}</td>
        <td>${skills}</td>
      </tr>`;
    })
    .join('');

  // 没落到岗位的人（正常应为 0）：单独提一句，别让它静默藏在表里
  const noRole = people.filter((p) => !p.roleKey);
  const noRoleLine = noRole.length
    ? `<div class="hint-line warn-line">有 ${noRole.length} 位员工没有岗位（${noRole.map((p) => esc(p.name)).join('、')}）—— 没岗位就没有权限，请重新雇佣。</div>`
    : '';

  return `
    <div class="hint-line">岗位是<b>系统内置</b>的：权限和技能包都挂在岗位上，改口径只能发版。
      员工从专家库雇佣即落岗（不提供调岗），岗位就是他的权限来源。</div>
    ${noRoleLine}
    <div class="org-scroll">
      <table class="org-table">
        <thead><tr>
          <th>岗位</th><th>类型</th><th>在岗</th><th>权限</th><th>技能包</th>
        </tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="dim">还没有岗位清单</td></tr>'}</tbody>
      </table>
    </div>`;
}

/** 打开组织架构的某个子页（默认岗位权限清单） */
export function openOrg(section = 'roles') {
  S.orgSection = ORG_SECTIONS.some((s) => s.id === section) ? section : 'roles';
  setRoute('org', { section: S.orgSection });
  showView('org');
  renderOrgList(); // 高亮当前子菜单项（从路由恢复时左栏也已经画好了，这里再对齐一次）
  $('orgView').innerHTML = `${headRow('<b>岗位权限清单</b>')}
    <div class="detail-body">${rolesPanelHTML()}</div>`;
}
