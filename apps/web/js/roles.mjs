/* roles.mjs —— **身份 → 菜单** 的矩阵（2026-10-28 节点配置面第一刀）。
 *
 * 为什么单独一个文件：以后要做「用户 / 角色 / 菜单」配置（数据表 + CRUD + 菜单配置界面），
 * 唯一的扩展点就应该是这张表 —— 别把"谁能看见哪块"散进各页的 if 里，那种写法加一个角色
 * 要翻十个文件，且没人说得清完整矩阵长什么样。
 *
 * 两个**必须区分**的概念（任务书 §三）：
 *   ① 机器角色（这台机器是谁）：operator = 未加入、本机单机版；node = 已加入某台总机。
 *      来源：服务端 `/api/hello` 的 `role` 字段（现读 config.json 的 controlPlane）。
 *   ② 查看者身份（打开页面的人是谁）：operator = 本机 / 令牌；device = 手机配对令牌。
 *      来源：`/api/pair/me`（前端 `S.isDevice`）。
 *
 * 矩阵的输入是这两个的**组合**（`resolveRole`），本刀只落 `node` 这一列：
 * operator / device 的现有渲染**一行不改** —— 这张表先把口径立起来，下一刀再让渲染吃它。
 */

/** 三个身份。字符串是稳定契约（会进 URL / 配置），别改名 */
export const ROLE = Object.freeze({
  OPERATOR: 'operator',
  NODE: 'node',
  DEVICE: 'device',
});

/**
 * 菜单 key（稳定字符串）。**node.* 这六个与节点配置面的六个分节一一对应** ——
 * 分节渲染前要过 `canSee()`，所以两边必须同源，别在页面里另写一份字面量。
 */
export const MENU_KEYS = Object.freeze({
  // operator / device 的现有导航（本刀只登记，不用它去改渲染）
  MESSAGES: 'messages',
  CONTACTS: 'contacts',
  EXPERTS: 'experts',
  WORKBENCH: 'workbench',
  SETTINGS: 'settings',
  // 节点配置面的六个分节
  NODE_CONNECTION: 'node.connection',
  NODE_MACHINE: 'node.machine',
  NODE_RUNTIMES: 'node.runtimes',
  NODE_ACCESS: 'node.access',
  NODE_DATA: 'node.data',
  NODE_ABOUT: 'node.about',
});

/**
 * 中文标签单独一份：key 进代码、标签给人看。
 * 同一份 key 在不同身份下叫法可能不一样（比如 settings 对手机是「我的」），
 * 所以标签表按 key 存**最中性**的那个说法，页面要更贴切的文案自己覆盖。
 */
export const MENU_LABELS = Object.freeze({
  [MENU_KEYS.MESSAGES]: '会话',
  [MENU_KEYS.CONTACTS]: '通讯录',
  [MENU_KEYS.EXPERTS]: '专家库',
  [MENU_KEYS.WORKBENCH]: '工作台',
  [MENU_KEYS.SETTINGS]: '设置',
  [MENU_KEYS.NODE_CONNECTION]: '连接',
  [MENU_KEYS.NODE_MACHINE]: '这台机器',
  [MENU_KEYS.NODE_RUNTIMES]: '运行时',
  [MENU_KEYS.NODE_ACCESS]: '访问方式',
  [MENU_KEYS.NODE_DATA]: '数据',
  [MENU_KEYS.NODE_ABOUT]: '关于',
});

/**
 * 矩阵本体：每个身份能看见哪些 key，**顺序即渲染顺序**。
 *
 * · operator：照现有左栏导航写全（会话 / 通讯录 / 专家库 / 工作台 / 设置）。
 * · device：照现有手机受限视图写（底部四 tab：工作台 / 通讯录 / 会话 / 我的；
 *   「我的」就是设置页，key 复用 settings）。
 * · node：节点配置面的六节，**不是**总机面板 —— 面板（员工/会话/项目）只在总机上。
 */
export const MENUS_BY_ROLE = Object.freeze({
  [ROLE.OPERATOR]: Object.freeze([
    MENU_KEYS.MESSAGES,
    MENU_KEYS.CONTACTS,
    MENU_KEYS.EXPERTS,
    MENU_KEYS.WORKBENCH,
    MENU_KEYS.SETTINGS,
  ]),
  [ROLE.DEVICE]: Object.freeze([
    MENU_KEYS.WORKBENCH,
    MENU_KEYS.CONTACTS,
    MENU_KEYS.MESSAGES,
    MENU_KEYS.SETTINGS,
  ]),
  [ROLE.NODE]: Object.freeze([
    MENU_KEYS.NODE_CONNECTION,
    MENU_KEYS.NODE_MACHINE,
    MENU_KEYS.NODE_RUNTIMES,
    MENU_KEYS.NODE_ACCESS,
    MENU_KEYS.NODE_DATA,
    MENU_KEYS.NODE_ABOUT,
  ]),
});

/**
 * 由「查看者身份 + 机器角色」算出矩阵里的那一列。
 *
 * **device 最优先**：手机配对令牌进来看的永远是手机视图，跟后面那台机器是不是节点无关
 * （一台 iPad 扫手机器的码，不该因为那台机器加入了总机就变成节点配置面）。
 * 机器角色只认 `'node'`，其余（含 undefined / 脏值）一律当 operator —— 判不准时给
 * **最保守**的那一列，别把节点页画给一台单机。
 */
export function resolveRole({ isDevice = false, machineRole = null } = {}) {
  if (isDevice) return ROLE.DEVICE;
  if (machineRole === 'node') return ROLE.NODE;
  return ROLE.OPERATOR;
}

/** 这个身份能不能看见这个 key。未知身份 / 未知 key 一律 false（不抛） */
export function canSee(role, key) {
  return (MENUS_BY_ROLE[role] ?? []).includes(key);
}
