/* connjson.mjs —— 连接器 JSON 的**纯**解析/生成（不碰 DOM，可被 node 直接跑）。
 *
 * **2026-11-22 用户拍板：不做界面化的字段翻译。**
 *   「这个是有技术含量的。即便你做成界面化，用户也不会用的。那不如省事一点，不做这个界面化的翻译。」
 * 所以界面上只剩一个 JSON 框：贴一段 `mcpServers`，形状跟 Claude Desktop / Cursor /
 * 本仓 renderClaudeConfig 吐出来的**完全一致 —— 导出即导入**，不用在脑子里做二次翻译。
 *
 * 这里只做机械映射（键名基本同名），认不出的键收集起来回一句；不做预览、
 * 不做字段级提示、不做"友好报错"。要逐项微调，直接改 data/connectors.json
 * （账本本身就是人可读的 JSON）。
 *
 * 代价（写在这儿免得以后当 bug 修）：`env` 值只回吐键、写成 `env:KEY` 引用形态 ——
 * 账本里原本是字面量的话，改一次就变成引用了。这正是想要的方向（密钥不该落盘）。
 */

/**
 * 账本条目 → mcpServers 的一层。
 *
 * **env / headers 故意不输出**（2026-11-22 修，别再"补全"它）：
 * publicList 只把**键名**发到前端，值根本没下来。硬填成 `env:KEY` 会让"点开看一眼、
 * 什么都不改、直接保存"把字面量凭据改成引用 —— 而那个环境变量可能压根不存在，
 * 一条跑得好好的连接器当场变成"缺环境变量"。填成 `{}` 更糟：保存时整个清空。
 * 不写 = 服务端 saveEntry 是 merge 语义（`{...current, ...patch}`），原值一个字不动。
 * 要改凭据，用户自己在框里写 env；现有键名由弹窗的提示行告诉他。
 */
function entryToMcp(e) {
  const one =
    e.transport === 'streamable-http'
      ? { type: 'http', url: e.url ?? '' }
      : { command: e.command ?? '', args: e.args ?? [] };
  if (e.transport === 'stdio' && e.cwd) one.cwd = e.cwd;
  if (e.bearerTokenEnv) one.bearerTokenEnv = e.bearerTokenEnv;
  if (e.runtimes?.length) one.runtimes = e.runtimes;
  return one;
}

/** 弹窗预填的文本：新装是一副空壳，改是这一条的当前配置 */
export function connJsonText(entry) {
  return JSON.stringify({ mcpServers: entry ? { [entry.id]: entryToMcp(entry) } : {} }, null, 2);
}

/**
 * 工具名 → 一句能力（`download、transcribe、tts 等 12 个工具`）。
 *
 * 这是"接过来的能力"的**事实**来源（服务端 probe 时写进账本的 tools），
 * 只有在条目没写 note 时才用得上 —— note 是人话，优先。
 * 公共前缀是连接器 id（`baoluo_parse_link`），摆在卡上纯占地方，去掉。
 */
export function toolsBrief(tools) {
  const names = (tools ?? []).filter(Boolean);
  if (!names.length) return '';
  const i = names[0].indexOf('_');
  const pre = i > 0 && names.every((n) => n.startsWith(names[0].slice(0, i + 1))) ? names[0].slice(0, i + 1) : '';
  const short = names.map((n) => (pre && n.startsWith(pre) ? n.slice(pre.length) : n).replace(/[_-]+/g, ' '));
  const head = short.slice(0, 5).join('、');
  return short.length > 5 ? `${head} 等 ${short.length} 个工具` : head;
}
/**
 * 最后一级兜底：这东西的连接方式（2026-11-22 用户："这个改成简述"）。
 *
 * 之前直接把 `命令 + 全部参数` 铺上去，一个 electron 的绝对路径就吃满两行截断，
 * 卡上只剩 `E:\CodeSpace\github\...`，等于没说明。这里给的是**最短能认出来的称呼**：
 *   本地进程 → `electron.exe bridge.cjs`（绝对路径只留文件名）
 *   远端服务 → 域名
 * 完整命令行在详情弹窗里，卡上不承担"可复制"的职责。
 */
export function connBrief(c) {
  if (c.transport === 'streamable-http') {
    try {
      return new URL(c.url).host;
    } catch {
      return c.url || '远端服务';
    }
  }
  const base = (p) => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
  // 绝对路径只留文件名（bridge.cjs），包名原样（@scope/pkg 的 / 不是目录分隔的意思）
  const isPath = (a) => /^([A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/])/.test(String(a));
  const pos = (c.args ?? []).filter((a) => !String(a).startsWith('-'));
  const pkg = pos.find((a) => !isPath(a)); // 包名/子命令优先：npx 那条真正的身份是包名，不是它后面的目录
  const file = pos.find(isPath);
  const rest = pkg || (file ? base(file) : '');
  return [base(c.command), rest].filter(Boolean).join(' ') || '本地进程';
}

/** 别家的引用写法统一成账本的 `env:名字`（`${env:X}` / `${X}`），别的一律原样 */
const asRef = (v) => {
  const s = String(v);
  const m = /^\$\{?env:([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(s) || /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(s);
  return m ? `env:${m[1]}` : s;
};

/**
 * 贴进来的文本 → { list: [[id, 账本字段], ...], ignored: ['id.键', ...] }
 * 吃三种形态：{"mcpServers": {...}} / 单条内层对象（有 command 或 url）/ 顶层直接是 id→配置。
 */
export function parseConnJson(text) {
  const src = String(text ?? '').trim();
  if (!src) throw new Error('框里是空的：贴一段 {"mcpServers": {...}}，或者一条 {"command": ...}');
  let obj;
  try {
    obj = JSON.parse(src);
  } catch (err) {
    throw new Error(`这段不是合法 JSON：${err.message}`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('顶层要是一个对象');

  let servers;
  if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
    servers = obj.mcpServers;
  } else if ('command' in obj || 'url' in obj) {
    servers = { [obj.id || `conn-${Date.now().toString(36).slice(-4)}`]: obj };
  } else {
    servers = obj; // 顶层就是 id → 配置
  }

  const KNOWN = new Set(['id', 'type', 'transport', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'bearerTokenEnv', 'label', 'enabled', 'runtimes', 'note']);
  const strMap = (v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, asRef(x)]))
      : {};

  const ignored = [];
  const list = [];
  for (const [id, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`「${id}」不是对象`);
    for (const k of Object.keys(raw)) if (!KNOWN.has(k)) ignored.push(`${id}.${k}`);

    const t = String(raw.type ?? raw.transport ?? '').toLowerCase();
    // 没写 type 但有 url 没 command，按远端算 —— 手写的配置常常不写 type
    const http = t === 'http' || t === 'sse' || t === 'streamable-http' || (!t && !!raw.url && !raw.command);
    const body = {
      id,
      label: String(raw.label ?? id),
      transport: http ? 'streamable-http' : 'stdio',
      command: http ? '' : String(raw.command ?? ''),
      args: Array.isArray(raw.args) ? raw.args.map(String) : [],
      cwd: raw.cwd ? String(raw.cwd) : '',
      url: http ? String(raw.url ?? '') : '',
      bearerTokenEnv: raw.bearerTokenEnv ? String(raw.bearerTokenEnv) : '',
      runtimes: Array.isArray(raw.runtimes) ? raw.runtimes.map(String) : [],
      note: String(raw.note ?? ''),
    };
    /* env / headers **只在原文真写了才进 body**：没写 = 不碰（服务端 merge 保留原值）。
       写成 `env: {}` 显式清空，那是用户的明确意思，照办。
       修复前的写法是默认 `{}`，于是"改个名字"会把凭据整个清空（2026-11-22 实查）。 */
    if (!http && 'env' in raw) body.env = strMap(raw.env);
    if (http && 'headers' in raw) body.headers = strMap(raw.headers);
    if (raw.enabled === false) body.enabled = false;
    list.push([id, body]);
  }
  if (!list.length) throw new Error('这段里没有连接器');
  return { list, ignored };
}
