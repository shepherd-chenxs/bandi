/**
 * menus.mjs —— **菜单目录**（2026-10-28 第二刀：角色与菜单可配置化）。
 *
 * 为什么目录在服务端：角色是**数据**，菜单是**它引用的字典**。字典放前端的话，
 * 服务端校验"这个 key 认不认识"就只能靠一份复制品 —— 两边迟早对不上。
 * 现在服务端是唯一真相源，前端 `apps/web/js/roles.mjs` 的 `MENU_KEYS` 是它的镜像，
 * 两边由 `smoke-roles.mjs` 静态比对（少一个/多一个都红）。
 *
 * key 用的是第一刀 `roles.mjs` 里已有的那批字符串，**一个新 key 都不许在这里造**：
 *   · `messages / contacts / experts / workbench / settings` —— 面板（单机/总机那一套）
 *   · `node.*` —— 节点配置面的六个分节（与 `renderNodeMode` 的分节一一对应）
 *
 * `group` 只用来在管理页里分组显示，不参与权限判断（`'面板'` / `'节点配置'`）。
 * 顺序即显示顺序。
 */

/** 分组名（管理页按这个分子块，顺序即数组顺序） */
export const MENU_GROUPS = Object.freeze(['面板', '节点配置']);

/**
 * 目录本体。三个字段都是**硬要求**（冒烟会逐个查）：`key` 稳定、`label` 给人看、`group` 归堆。
 */
export const MENU_CATALOG = Object.freeze([
  { key: 'messages', label: '会话', group: '面板' },
  { key: 'contacts', label: '通讯录', group: '面板' },
  { key: 'experts', label: '专家库', group: '面板' },
  { key: 'workbench', label: '工作台', group: '面板' },
  { key: 'settings', label: '设置', group: '面板' },
  { key: 'node.connection', label: '连接', group: '节点配置' },
  { key: 'node.machine', label: '这台机器', group: '节点配置' },
  { key: 'node.runtimes', label: '运行时', group: '节点配置' },
  { key: 'node.access', label: '访问方式', group: '节点配置' },
  { key: 'node.data', label: '数据', group: '节点配置' },
  { key: 'node.about', label: '关于', group: '节点配置' },
]);

/** 目录里所有 key（顺序同目录）—— 校验与「管理员恒等于全集」都用它 */
export function allMenuKeys() {
  return MENU_CATALOG.map((m) => m.key);
}

/** 这个 key 认不认识（不认识 = 调用方要回 E1114，别静默丢掉） */
export function isMenuKey(key) {
  return MENU_CATALOG.some((m) => m.key === String(key ?? '').trim());
}

/** 按目录顺序整理一组 key（去重；不认识的**留给调用方判**，不在这里吞掉） */
export function sortMenuKeys(keys) {
  const want = new Set((Array.isArray(keys) ? keys : []).map((k) => String(k ?? '').trim()));
  return allMenuKeys().filter((k) => want.has(k));
}
