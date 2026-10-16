import fs from 'node:fs';
import path from 'node:path';
import { dataDir, repoRoot } from './config.mjs';

/**
 * 插件（界面插槽）＋ 插件市场。
 *
 * ── 两个地方，两个角色 ──────────────────────────────────────────────
 * - **市场**（`catalog/plugins/<id>/`）：随仓库走的插件源，是"可以装的东西"。
 * - **已装**（`plugins/<id>/`）：装完之后的实体，rail 里那个「插件」只认这里。
 * - **账本**（`data/plugins.json`）：记谁装了、启没启用。**卸载＝删目录＋删账本条目；
 *   停用＝只改账本**（和连接器那套语义对齐：连接器的卸载也是删条目）。
 *
 * ── manifest.json 契约（v1）────────────────────────────────────────
 * {
 *   "id": "ssh",                       // 必须等于目录名，[a-z0-9][a-z0-9._-]{0,63}
 *   "label": "服务器与密钥",
 *   "version": "0.1.0",
 *   "description": "一句话说明",
 *   "connector": "ssh",                // 可选：这条插件的"给 agent 的工具"是哪个连接器
 *   "panel": {
 *     "slot": "plugins",               // v1 只实现 "plugins"
 *     "mode": "declarative",           // L1：不执行插件代码，宿主按声明渲染
 *     "blocks": [...]
 *   },
 *   "permissions": ["GET:/api/ssh/servers"]   // 白名单，宿主只碰这里面的接口
 * }
 *
 * ── blocks（v1 支持的积木）────────────────────────────────────────
 * { "type":"text",     "heading":"小标题（可选）", "text":"一段说明" }
 * { "type":"list",     "source":{"api":"/api/x","pick":"servers"},
 *                      "title":"{alias}", "subtitle":"{user}@{host}:{port}", "empty":"没有",
 *                      "add":{ "label":"＋ 添加", "form":"server" },        // 标题行右侧的按钮
 *                      "actions":[ {"label":"编辑","kind":"edit","form":"<表单 formId>"},
 *                                   {"label":"删除","kind":"delete","method":"DELETE",
 *                                    "api":"/api/x/{alias}","confirm":"删掉「{alias}」？"} ] }
 * { "type":"table",    "source":{...}, "columns":[{"label":"主机","key":"host"}] }
 *                      // 列可以带 `width`（如 "72px"）：任意一列写了，整张表切 fixed ——
 *                      // 写了的按声明，没写的平分剩下的。不写就按内容自动分，
 *                      // 但中文每个字都能断行，长文本列会把窄列压成竖排
 * { "type":"keyvalue", "source":{...}, "rows":[{"label":"路径","value":"{path}"}] }
 * { "type":"button",   "label":"重新检测",
 *                      "action":{"method":"POST","api":"/api/x","body":{}}, "confirm":"确定？" }
 * { "type":"form",     "formId":"server", "heading":"登记一台",
 *                      "fields":[{"key":"alias","label":"别名","required":true}],
 *                      "submit":{"method":"POST","api":"/api/x","label":"保存"} }
 *
 * 表单的两种形态**不用额外声明**：被 list 的 `add` 或行内 `edit` 引用到 → 作为弹窗
 * （按钮画在被引用那张表的标题行右侧）；没人引用 → 就内嵌在面板里。
 *
 * 取值用 `{字段}` 模板；取不到的字段渲染成空串（不报错、不显示 undefined）。
 * **heading 也能用同一数据源的根对象取值**（例如 "登记表 {path}"）。
 *
 * **权限是"君子协定"**：L1 声明式下插件根本不跑代码，宿主按白名单代取；
 * 但 L2（iframe）要靠 sandbox + 服务端 guardWrite 才真正挡得住 —— 别把这里当安全边界。
 */
export const pluginsRoot = path.join(repoRoot, 'plugins');
export const catalogRoot = path.join(repoRoot, 'apps', 'server', 'catalog', 'plugins');
const LEDGER = path.join(dataDir, 'plugins.json');

export const KNOWN_SLOTS = ['plugins', 'persona.section', 'settings.section'];
export const IMPLEMENTED_SLOTS = ['plugins'];
export const KNOWN_MODES = ['declarative', 'iframe'];
export const IMPLEMENTED_MODES = ['declarative'];
const BLOCK_TYPES = ['text', 'list', 'table', 'keyvalue', 'button', 'form', 'code', 'steps'];
const ROW_ACTION_KINDS = ['edit', 'call', 'delete'];

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// 路径里允许 {占位}：行内操作要按行取值（例如 DELETE:/api/ssh/servers/{alias}）
const PERM_RE = /^(GET|POST|PUT|PATCH|DELETE):\/api\/[A-Za-z0-9._~{}%\-/]*$/;

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/* ------------------------------------------------------------------ 校验 */

/** 校验一份 manifest。返回 { errors: [...] }，空数组＝合法 */
export function validateManifest(m, dirName) {
  const errors = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { errors: ['manifest 不是一个对象'] };

  const id = str(m.id);
  if (!id) errors.push('缺 id');
  else if (!ID_RE.test(id)) errors.push(`id 不合法：${id}`);
  else if (id !== dirName) errors.push(`id（${id}）必须和目录名（${dirName}）一致`);

  if (!str(m.label)) errors.push('缺 label');
  if (m.connector !== undefined && !str(m.connector)) errors.push('connector 写了但为空（不想关联就别写这个字段）');
  if (!Array.isArray(m.permissions)) errors.push('permissions 必须是数组（没有就给 []）');
  else {
    for (const p of m.permissions) {
      if (!PERM_RE.test(String(p))) errors.push(`权限写法不对：${p}（应为 "GET:/api/xxx"）`);
    }
  }

  const panel = m.panel;
  if (!panel || typeof panel !== 'object') errors.push('缺 panel');
  else {
    if (!KNOWN_SLOTS.includes(panel.slot)) errors.push(`slot 不认识：${panel.slot}`);
    else if (!IMPLEMENTED_SLOTS.includes(panel.slot)) {
      errors.push(`slot「${panel.slot}」还没实现（现在只有 ${IMPLEMENTED_SLOTS.join('/')}）`);
    }
    if (!KNOWN_MODES.includes(panel.mode)) errors.push(`mode 不认识：${panel.mode}`);
    else if (!IMPLEMENTED_MODES.includes(panel.mode)) {
      errors.push(`mode「${panel.mode}」还没实现（L2 沙箱 iframe 属于 P1）`);
    }

    if (!Array.isArray(panel.blocks) || !panel.blocks.length) errors.push('panel.blocks 要有内容');
    else {
      // 详情区（动作按钮 + 内容块）也要一起校验 ——
      // 不然"把越权的块塞进 split.detail"就是个绕过白名单的口子
      const detailActions = Array.isArray(panel.split?.detail?.actions) ? panel.split.detail.actions : [];
      const detailBlocks = Array.isArray(panel.split?.detail?.blocks) ? panel.split.detail.blocks : [];
      if (panel.split && !panel.split.master?.source?.api) {
        errors.push('panel.split.master 要有 source.api');
      }
      const lists = [
        { name: 'blocks', list: panel.blocks },
        { name: 'split.detail.actions', list: detailActions },
        { name: 'split.detail.blocks', list: detailBlocks },
      ];

      // 表单 id 先收集一遍：add.form / actions[].form / button.edit 引用的必须真的存在（防拼错）
      const formIds = new Set(
        lists
          .flatMap(({ list }) => list)
          .map((b, i) => (b?.type === 'form' ? b.formId || 'f' + i : null))
          .filter(Boolean),
      );
      const refOk = (ref, where) => {
        if (ref && !formIds.has(ref)) errors.push(`${where} 指向的表单不存在：${ref}（现有：${[...formIds].join('/') || '无'}）`);
      };

      for (const { name, list } of lists)
      list.forEach((b, i) => {
        const at = `${name}[${i}]`;
        if (!b || typeof b !== 'object') return errors.push(`${at} 不是对象`);
        if (!BLOCK_TYPES.includes(b.type)) errors.push(`${at} 类型不认识：${b.type}`);
        if (b.source) {
          const api = str(b.source.api);
          if (!api) errors.push(`${at}.source 缺 api`);
          else if (!m.permissions?.some((p) => p.endsWith(':' + api))) {
            errors.push(`${at} 取了 ${api}，但 permissions 里没声明`);
          }
        }
        if (b.type === 'button') {
          // edit：打开某个表单弹窗（把当前行灌进去），不需要权限
          if (b.edit) refOk(str(b.edit), `${at}（button.edit）`);
          const a = b.action ?? {};
          const api = str(a.api);
          const method = str(a.method).toUpperCase();
          if (!b.edit && !api) errors.push(`${at}（button）缺 action.api`);
          else if (api && !m.permissions?.some((p) => p === `${method}:${api}`)) {
            errors.push(`${at}（button）要调 ${method} ${api}，但 permissions 里没声明`);
          }
        }
        // code：取一段文本摊出来（公钥、指引、命令输出）
        if (b.type === 'code') {
          if (!b.source?.api) errors.push(`${at}（code）要有 source.api`);
          if (!str(b.source?.pick)) errors.push(`${at}（code）要写 source.pick: <取哪个字段>`);
          const ea = b.emptyAction;
          if (ea) {
            const gApi = str(ea.api);
            const gMethod = str(ea.method || 'POST').toUpperCase();
            if (!gApi) errors.push(`${at}.emptyAction 缺 api`);
            else if (!m.permissions?.some((p) => p === `${gMethod}:${gApi}`)) {
              errors.push(`${at}.emptyAction 要调 ${gMethod} ${gApi}，但 permissions 里没声明`);
            }
          }
        }
        // steps：一组 [{title, note, command}]，一步一块
        if (b.type === 'steps') {
          if (!b.source?.api) errors.push(`${at}（steps）要有 source.api`);
          if (!str(b.source?.pick)) errors.push(`${at}（steps）要写 source.pick: <取哪个字段>`);
        }
        if (b.type === 'form') {
          if (!Array.isArray(b.fields) || !b.fields.length) errors.push(`${at}（form）要有 fields`);
          else {
            b.fields.forEach((f, fi) => {
              if (!str(f.key)) errors.push(`${at}.fields[${fi}] 缺 key`);
              if (!str(f.label)) errors.push(`${at}.fields[${fi}] 缺 label`);
            });
          }
          const sub = b.submit ?? {};
          const api = str(sub.api);
          const method = str(sub.method || 'POST').toUpperCase();
          if (!api) errors.push(`${at}（form）缺 submit.api`);
          else if (!m.permissions?.some((p) => p === `${method}:${api}`)) {
            errors.push(`${at}（form）要提交到 ${method} ${api}，但 permissions 里没声明`);
          }
        }
        // list 上的「添加」按钮：指向某个表单块
        if (b.add) {
          if (!str(b.add.form)) errors.push(`${at}.add 缺 form`);
          else refOk(str(b.add.form), `${at}.add`);
          if (!str(b.add.label)) errors.push(`${at}.add 缺 label`);
        }
        // list 上的行内操作（编辑 / 删除）
        for (const [ai, a] of (b.actions ?? []).entries()) {
          const kind = str(a.kind || 'call');
          if (!ROW_ACTION_KINDS.includes(kind)) {
            errors.push(`${at}.actions[${ai}] kind 不认识：${a.kind}`);
            continue;
          }
          if (!str(a.label)) errors.push(`${at}.actions[${ai}] 缺 label`);
          if (kind === 'edit') {
            if (!str(a.form)) errors.push(`${at}.actions[${ai}]（edit）要写 form: <表单块的 formId>`);
            else refOk(str(a.form), `${at}.actions[${ai}]`);
            continue;
          }
          const api = str(a.api);
          const method = str(a.method || 'POST').toUpperCase();
          if (!api) errors.push(`${at}.actions[${ai}] 缺 api`);
          else if (!m.permissions?.some((p) => p === `${method}:${api}`)) {
            errors.push(`${at}.actions[${ai}] 要调 ${method} ${api}，但 permissions 里没声明`);
          }
        }
      });
    }
  }
  return { errors };
}

/** 读某个目录下的 manifest 并校验（目录名当 id 基准） */
function readPluginDir(dir) {
  const file = path.join(dir, 'manifest.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { errors: ['读不到 manifest.json'] };
  }
  let m;
  try {
    m = JSON.parse(raw);
  } catch (e) {
    return { errors: ['manifest.json 不是合法 JSON：' + e.message] };
  }
  return { manifest: m, ...validateManifest(m, path.basename(dir)) };
}

/** 扫一个目录下的所有插件目录。**不合法的也列出来**（带 errors），否则作者不知道为什么没生效 */
function scan(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const dir = path.join(root, e.name);
    const { manifest, errors } = readPluginDir(dir);
    out.push({
      id: manifest?.id ?? e.name,
      dirName: e.name,
      label: str(manifest?.label) || e.name,
      version: str(manifest?.version),
      description: str(manifest?.description),
      category: str(manifest?.category) || '',   // 工作台宫格按它分组
      connector: str(manifest?.connector) || null,
      panel: manifest?.panel ?? null,
      permissions: Array.isArray(manifest?.permissions) ? manifest.permissions : [],
      valid: errors.length === 0,
      errors,
      dir,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/* ------------------------------------------------------------------ 账本 */

function readLedger() {
  try {
    const j = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

function writeLedger(obj) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(LEDGER, JSON.stringify(obj, null, 2), 'utf8');
}

/** 已装插件：目录在 plugins/ 下的那些（账本里没记录的**也算已装**，否则手写进去的插件会凭空消失） */
function installedIds() {
  return scan(pluginsRoot).map((p) => p.id);
}

/* ------------------------------------------------------------------ 对外 */

/**
 * 市场：可装的（目录里的源）＋ 已装的（无论来路）。
 * 每条带 `installed` / `enabled`，界面据此决定显示"安装"还是"停用/卸载"。
 */
export function marketList() {
  const ledger = readLedger();
  const cat = scan(catalogRoot);
  const inst = scan(pluginsRoot);
  const byId = new Map();

  for (const c of cat) {
    byId.set(c.id, { ...c, fromCatalog: true, installed: false, enabled: false, installedDir: null });
  }
  for (const i of inst) {
    const prev = byId.get(i.id);
    byId.set(i.id, {
      ...(prev ?? {}),
      ...i,
      fromCatalog: !!prev,
      installed: true,
      // 账本里没记录 → 视为启用（宽容默认：手写进 plugins/ 的插件不该凭空消失）
      enabled: ledger[i.id] ? ledger[i.id].enabled !== false : true,
      installedDir: i.dir,
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** rail 里能用的：**已装 ＋ 启用 ＋ 有界面** */
export function activePanels() {
  return marketList().filter((p) => p.installed && p.enabled && p.valid && p.panel?.slot === 'plugins');
}

export function getPlugin(id) {
  return marketList().find((p) => p.id === id) ?? null;
}

/** 从市场源装一个。已经装过就报错，别默默覆盖掉用户改过的文件 */
export function install(id) {
  if (!ID_RE.test(String(id))) return { error: '插件 id 不合法' };
  const src = path.join(catalogRoot, String(id));
  if (!fs.existsSync(path.join(src, 'manifest.json'))) return { error: `市场里没有这个插件：${id}` };

  const dest = path.join(pluginsRoot, String(id));
  if (fs.existsSync(dest)) return { error: `${id} 已经装过了` };

  fs.mkdirSync(pluginsRoot, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });

  const ledger = readLedger();
  ledger[id] = { enabled: true, installedAt: new Date().toISOString(), source: { kind: 'builtin', ref: `catalog/plugins/${id}` } };
  writeLedger(ledger);
  return { plugin: getPlugin(id) };
}

export function setEnabled(id, enabled) {
  const p = getPlugin(id);
  if (!p?.installed) return { error: `没有装 ${id}` };
  const ledger = readLedger();
  ledger[id] = { ...(ledger[id] ?? {}), enabled: !!enabled };
  writeLedger(ledger);
  return { plugin: getPlugin(id) };
}

/**
 * 卸载：**删掉装进来的目录**，并移除账本记录。
 * 只敢删 pluginsRoot 底下的东西 —— 路径校验不过就直接拒绝。
 */
export function uninstall(id) {
  const p = getPlugin(id);
  if (!p?.installed) return { error: `没有装 ${id}` };

  const dest = path.resolve(pluginsRoot, String(id));
  if (dest !== path.join(path.resolve(pluginsRoot), String(id)) || !dest.startsWith(path.resolve(pluginsRoot) + path.sep)) {
    return { error: '路径校验不过，拒绝删除' };
  }
  try {
    fs.rmSync(dest, { recursive: true, force: true });
  } catch (e) {
    return { error: `删不掉：${e.message}` };
  }

  const ledger = readLedger();
  delete ledger[id];
  writeLedger(ledger);
  return { removed: true, path: dest };
}

export const ledgerPath = LEDGER;
