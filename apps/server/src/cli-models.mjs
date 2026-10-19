import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dshProfile } from './config.mjs';

/**
 * 「这个运行时能用哪些模型」—— **直接读各个 CLI 自己的配置**。
 *
 * 这个模块里**没有账本**，也不该有。以前班底把各族的模型清单同步进 `data/models.json`，
 * 再加一层 `enabled` 策略，然后满世界从那份账本取。去掉了，两个原因：
 *
 *   ① **账本是事实的副本，副本会过期**。magpie 把模型写进 CLI 的配置、CLI 读它 ——
 *      那才是事实。你在 magpie 里改了模型数量，账本还是旧的，得记得点一次「刷新」。
 *      用户最早那个问题（"我改了网管里的模型数量，bandi 里怎么没变"）根子就在这里。
 *   ② **对账逻辑是一整类麻烦**。增/改/减三段、摘除语义（"读失败 ≠ 上游撤掉了"——
 *      这条规则是踩了真坑才总结出来的：codex 配置缺字段时盲同步差点误删 23 个模型）。
 *      直接读就**没有"对账"这件事**，因为不存在两份数据。
 *
 * 代价说清楚：读一次是有成本的，而且**可能失败**。
 *   · codex：读本地文件，约 2ms
 *   · dsh  ：要发一次 HTTP GET（本机 magpie 约 9ms；配成远程就是几百 ms 甚至超时）
 *   · claude：读本地 `settings.json`，约 1ms（那份可选清单读不到时才发 HTTP）
 * 所以调用方要**按需读**（用户点开才读），失败时**降级**（别显示空盒子，
 * 至少把"当前生效的模型"摆出来）。
 *
 * 为什么不能统一成一种读法：模型列表根本不在 CLI 手里。codex 和 claude 的 `--model`
 * 都只收一个字符串，没有 list 命令；真正知道有哪些模型的是**背后的服务端**。
 * 所以每个族各找各的源头：
 *
 *   codex : `~/.codex/config.toml` 的 `model_catalog_json` 指向的目录文件（本地、离线、带显示名）
 *           没有目录文件就退回它配的 `base_url` + GET /models
 *   dsh   : profile 的 cordis.patch.yml 里 llm-pi-ai 的 baseURL → GET /models
 *   claude: `~/.claude/settings.json` 的 `modelPicker.options`（magpie 把可用模型写在这儿），
 *           没有就退回 `ANTHROPIC_BASE_URL` 上的 /v1/models，都没有才只剩三个官方别名
 *
 * `BANDI_MODELS_URL` 可以指到任何一个 OpenAI 兼容的 /models，作为通用后门。
 */

/**
 * 清掉 U+FFFD（替换字符）。它是"某处解码失败"留下的痕迹，不是数据 ——
 * 典型来源：把带中文/·的文本按 Latin-1 当请求体发出去。
 */
const clean = (s) => String(s ?? '').replace(/\uFFFD/g, '').replace(/\s{2,}/g, ' ').trim();

const CODEX_HOME = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');

/** 一个够用的 TOML 取值：只认 `键 = "值"` 和 `[段]`，够读 codex 那几行 */
function tomlScan(text) {
  const top = {};
  const sections = {};
  let section = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const head = /^\[([^\]]+)\]$/.exec(line);
    if (head) {
      section = head[1].trim();
      sections[section] = sections[section] ?? {};
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2].trim().replace(/^["']|["']$/g, '');
    if (section) sections[section][kv[1]] = value;
    else top[kv[1]] = value;
  }
  return { top, sections };
}

function readCodexCatalog() {
  let cfg = '';
  try {
    cfg = fs.readFileSync(path.join(CODEX_HOME, 'config.toml'), 'utf8');
  } catch {
    return null;
  }
  const { top, sections } = tomlScan(cfg);
  const provider = top.model_provider ?? '';
  const base = sections[`model_providers.${provider}`]?.base_url ?? top.openai_base_url ?? '';
  const catalog = top.model_catalog_json;

  if (catalog) {
    const file = path.isAbsolute(catalog) ? catalog : path.join(CODEX_HOME, catalog);
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      const models = (Array.isArray(doc?.models) ? doc.models : [])
        .map((m) => ({
          id: String(m.slug ?? m.id ?? ''),
          name: clean(m.display_name),
          // codex 的目录里带着上下文窗口与输入模态 —— 顺手带出来，界面就能标
          contextWindow: Number(m.context_window) || 0,
          vision: Array.isArray(m.input_modalities) && m.input_modalities.includes('image'),
        }))
        .filter((m) => m.id);
      if (models.length) {
        return { models, source: path.basename(file), provider, base };
      }
    } catch {
      /* 目录读不了就走下面的 base_url */
    }
  }
  return base ? { models: null, source: base, provider, base } : null;
}

/** dsh：从 profile 的补丁层里抠出 llm-pi-ai 用的 baseURL（只取地址，不取密钥） */
function readDshProvider() {
  const file = path.join(DSH_HOME, 'profiles', dshProfile, 'cordis.patch.yml');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  // 引号可有可无（magpie 两处写法就不一样：llm-pi-ai 那块不带、web-search 那块带），
  // 所以抠出来统一剥一遍 —— 带着引号去 fetch 是打不开的。
  const base = (/^\s*baseURL:\s*(.+?)\s*$/m.exec(text)?.[1] ?? '').replace(/^["']|["']$/g, '');
  // providers: 下面第一个缩进的"名字:"就是供应商 id
  const seg = /^\s*providers:\s*$/m.exec(text);
  let name = '';
  if (seg) {
    for (const line of text.slice(seg.index + seg[0].length).split(/\r?\n/)) {
      if (!line.trim()) continue;
      const m = /^\s{4,}([A-Za-z0-9._-]+):\s*$/.exec(line);
      if (m) { name = m[1]; break; }
      if (/^\s{0,2}\S/.test(line)) break; // 出了这个块
    }
  }
  return base ? { base, name, file } : null;
}

/* ------------------------------------------- 「实际会用哪个模型」 */

/**
 * codex 的默认模型：config.toml 顶层的 `model = "..."`。
 *
 * 为什么要读它：员工**没绑模型**时，真正决定跑去哪条路由的是 CLI 自己的默认值 ——
 * 不看这个，按模型限额就无从谈起（限额会挂在一个根本不会用到的 id 上）。
 */
function readCodexDefaultModel() {
  try {
    const { top } = tomlScan(fs.readFileSync(path.join(CODEX_HOME, 'config.toml'), 'utf8'));
    return top.model || null;
  } catch {
    return null;
  }
}

/**
 * dsh profile 补丁里 `agent-default-model` 那一条的 `config`（`{ model, provider }`）。
 *
 * 为什么不用一句 `/^\s*model:/m` 了事：同一个文件下面还有 `models:`（供应商的模型清单），
 * 只按缩进匹配迟早会抠到清单里的第一行上去 —— 那样限额就会盯住一个**根本不会用到**的模型。
 * 所以先定位到那一条 list item，再在它自己的块里找，遇到下一条 `- ` 就收手。
 *
 * ⚠️ 定位那一行**不能要求 id 后面直接是行尾**：magpie 写进来的是
 *   `- id: agent-default-model # magpie`
 * 带着行尾注释。早先的锚点是 `...agent-default-model\s*$/m`，于是**永远匹配不上**，
 * dsh 员工没绑模型时解析出的默认模型是 null —— 用量全落进"认不出"桶、限额形同虚设
 * （2026-10-15 实测发现，这个 bug 在更早的版本里就存在）。
 *
 * ⚠️ 取值要能剥掉引号：magpie 写的是 `model: "qoder-cn/qfmodel"`，
 * 按 `(\S+)` 抠会把引号一起带走，那个模型名就没人认得了。
 */
function readDshDefaultBlock() {
  const file = path.join(DSH_HOME, 'profiles', dshProfile, 'cordis.patch.yml');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { model: null, provider: null };
  }
  // id 后面允许有注释；`#` 前的空白不算进 id（\S+ 已经把它挡在外面）
  const at = /^\s*-\s*id:\s*agent-default-model\b[^\n]*$/m.exec(text);
  if (!at) return { model: null, provider: null };
  const out = { model: null, provider: null };
  for (const line of text.slice(at.index + at[0].length).split(/\r?\n/)) {
    if (/^\s*-\s/.test(line)) break; // 下一条 list item，不在这个块里
    const kv = /^\s*(model|provider):\s*(.+?)\s*$/.exec(line);
    if (!kv) continue;
    // 剥引号，再剥行尾注释（`foo # 说明` 里的 `#` 前面必有一个空格）
    const value = kv[2].replace(/^["']|["']$/g, '').replace(/\s+#.*$/, '').trim();
    if (value && !out[kv[1]]) out[kv[1]] = value;
  }
  return out;
}

function readDshDefaultModel() {
  return readDshDefaultBlock().model;
}

/**
 * dsh 默认模型所在那一块的 `provider:`。
 *
 * 为什么非得把它读出来再传回去（见 dsh.mjs 的 renderRoutePatch）：
 * dsh 的补丁层是**整块替换 `config`**，不是逐字段合并 —— 实测只写 `model` 的话，
 * profile 里原来的 `provider: magpie` 会一起没了，这一步就不知道该怎么路由了。
 *
 * 所以这一列**不是班底的配置**，只是"把 CLI 自己写的那句原样带回去"。
 * 班底不存 provider、不改 provider，改它要去 magpie 或 dsh 自己的配置里改。
 */
function readDshDefaultProvider() {
  return readDshDefaultBlock().provider;
}

/* ---------------------------------------------------------------- claude */

/**
 * Claude Code 的配置目录（支持 `CLAUDE_CONFIG_DIR`，跟 CLI 自己的规矩一致）。
 */
const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');

/**
 * 读 Claude Code 自己的 `settings.json`（2026-10-17 补的）。
 *
 * 原来这里写着"claude 没有可查的源头，只给三个官方别名" —— 那是**想当然**：
 * 实际机器上 magpie 把账号下能用的模型全写进 `modelPicker.options`（label 给人看、
 * `model` 就是传给 CLI 的那个值），当前默认在 `model` 字段，三个别名各自指向谁在
 * `env.ANTHROPIC_DEFAULT_*_MODEL` 里。用户问"claude code 现在的真实模型是什么"
 * 时，答案就在这份文件里，只是班底一直没去读。
 *
 * 顺带一个不是界面的收益：`effectiveModelOf()` 以前对 claude 一律"不知道" →
 * 没绑模型的 claude 员工，每次运行都记不进 `runs.model`，用量落进"认不出"的黑洞、
 * 按模型的额度永远拦不住。有了 `model` 这个字段就认得出来了。
 *
 * 读不到（文件不在 / 不是 JSON）返回 null —— 调用方退回"三个官方别名"的老样子，
 * **不能因为读不到就让下拉变空**。
 */
function readClaudeCatalog() {
  const file = path.join(CLAUDE_HOME, 'settings.json');
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const env = doc?.env ?? {};
  const alias = (k) => clean(env[k]) || null;
  // `modelPicker.options` 才是真清单。每项：{ label 给人看, model 传给 CLI, description 一行说明 }
  const opts = Array.isArray(doc?.modelPicker?.options) ? doc.modelPicker.options : [];
  const models = opts
    .map((o) => ({ id: clean(o?.model), name: clean(o?.label), note: clean(o?.description) }))
    .filter((m) => m.id);
  return {
    file,
    models,
    defaultModel: clean(doc?.model) || null,
    aliases: {
      sonnet: alias('ANTHROPIC_DEFAULT_SONNET_MODEL'),
      opus: alias('ANTHROPIC_DEFAULT_OPUS_MODEL'),
      haiku: alias('ANTHROPIC_DEFAULT_HAIKU_MODEL'),
    },
    baseUrl: clean(env.ANTHROPIC_BASE_URL) || null,
    key: clean(env.ANTHROPIC_AUTH_TOKEN) || null,
  };
}

/** claude 没绑模型时真正生效的那个 —— 只有 `settings.json` 的 `model` 说得准 */
function readClaudeDefaultModel() {
  return readClaudeCatalog()?.defaultModel ?? null;
}

/**
 * 三个别名条目。
 *
 * 为什么还留着：`--model sonnet` 确实能用，删了等于丢掉一种合法写法。
 * 但必须**标清实际指向** —— 这台机器上三个别名全指向同一个模型，
 * 界面上不说，人会以为"选 Sonnet / Opus / Haiku"是三个不同的东西。
 */
function claudeAliasModels(info) {
  const label = { sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku' };
  return ['sonnet', 'opus', 'haiku'].map((id) => {
    const to = info?.aliases?.[id] ?? null;
    return {
      id,
      // 指向写在**标签里**：下拉里只显示标签，藏在 note 里等于没说
      name: to ? `${label[id]}（别名 → ${to}）` : `${label[id]}（别名）`,
      group: '别名',
      note: to ? `实际指向 ${to}${to === info?.defaultModel ? '（就是当前默认）' : ''}` : 'Claude Code 官方别名',
    };
  });
}

/** 某个族"CLI 自己配的 provider"（班底不存它，只为不冲掉它而回读） */
export function cliProviderOf(family) {
  return family === 'dsh' ? readDshDefaultProvider() : null;
}

/**
 * 这一次派活**实际会用哪个模型**。
 *
 *   · 员工或会话绑了模型 → 就是它（dispatch 会把它当 -m / --model 传下去）
 *   · 没绑 → 用这个协议族 CLI 自己的默认值（员工没绑时真正生效的那个）
 *
 * 返回 `{ id, from }`，id 为 null 表示"不知道"（比如 claude 连 settings.json 都读不到）。
 * **id 为 null 时不能拦人** —— 拿一个假归因去拦，比不拦更糟；这种情况要在界面上说清。
 *
 * 为什么这件事非要有：`runs.model` 记的就是它，按模型算用量、按模型限额全靠它。
 * 记原始字段（可能为空）是不够的 —— 空的时候用量就落进"认不出"的黑洞，
 * 限额永远显示 0、永远拦不住（"设了没用"是最不能有的毛病）。
 */
export function effectiveModelOf({ family = null, model = null } = {}) {
  const bound = clean(model);
  if (bound) return { id: bound, from: '绑定的' };
  const d = family === 'codex' ? readCodexDefaultModel() : family === 'dsh' ? readDshDefaultModel() : family === 'claude' ? readClaudeDefaultModel() : null;
  if (d) return { id: d, from: `${family} 的默认模型` };
  return { id: null, from: '不知道（这个协议族没有可读的默认模型）' };
}

async function fetchModels(baseUrl, key) {
  const url = baseUrl.replace(/\/+$/, '') + '/models';
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    const list = Array.isArray(doc?.data) ? doc.data : Array.isArray(doc?.models) ? doc.models : [];
    return {
      models: list.map((m) => ({ id: String(m.id ?? m.slug ?? ''), name: clean(m.name ?? m.display_name) })).filter((m) => m.id),
      source: url,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉模型清单要用的 Key —— **只认 `BANDI_MODELS_KEY` 这一个环境变量**。
 *
 * 为什么不读 CLI 配置里那个环境变量名（codex 的 `env_key`、dsh 的 `apiKeyEnv`）：
 * **那个变量在服务端进程里根本没人设**（实测 `MAGPIE_GATEWAY_KEY` 就是 undefined），
 * 照着它去 `process.env` 取值永远是空字符串 —— 等于每次都**不带凭据**去调。
 * 本地网关恰好放行，所以这事儿一直没暴露；换成真远程供应商就是 401，
 * 而且报错还是"服务端没给出列表"，你根本猜不到是没带 Key。
 *
 * 所以：本地网关什么都不用设；要拉一个需要鉴权的远程 /models，设 `BANDI_MODELS_KEY`。
 * 派活**不需要**这个 Key —— 那是 CLI 自己带着凭据去跑。
 */
const modelsKey = () => process.env.BANDI_MODELS_KEY ?? '';

/** 没带 Key 时把话说清楚 —— 否则 401 会被当成"服务端不给列表" */
function noKeyHint(key) {
  return key ? '' : '（没带凭据：需要的话设 BANDI_MODELS_KEY）';
}

/**
 * 这个运行时现在能用哪些模型 —— 读它自己那份配置，不查任何本地清单。
 *
 * 返回 `{ ok, family, models, source, note, error, defaultModel }`。
 * `defaultModel` 是"没绑模型时真正生效的那个"（界面把它写在「用 CLI 默认」后面），
 * 各族都能给：codex 读 config.toml 的 `model`、dsh 读补丁里的 agent-default-model、
 * claude 读 settings.json 的 `model`。
 * `ok:false` 是"这个源头没读成功"，与"它那儿没有模型"是两回事 ——
 * 界面要分开说：前者给"当前生效的模型"兜底，后者说"这个服务端没返回模型"。
 */
export async function forRuntime(rt) {
  const family = rt?.family ?? rt?.adapter ?? null;
  const out = { ok: false, family, models: [], source: '', note: '', error: null };

  // 通用后门：任何族都能指到自己的 /models
  if (process.env.BANDI_MODELS_URL) {
    try {
      const r = await fetchModels(process.env.BANDI_MODELS_URL, modelsKey());
      return { ...out, ok: true, models: r.models, source: r.source, note: '来自 BANDI_MODELS_URL' };
    } catch (err) {
      return { ...out, error: `BANDI_MODELS_URL 取不到：${String(err?.message ?? err)}${noKeyHint(modelsKey())}` };
    }
  }

  if (family === 'codex') {
    const info = readCodexCatalog();
    const defaultModel = readCodexDefaultModel();
    if (!info) return { ...out, error: '读不到 ~/.codex/config.toml，不知道它用哪个服务端' };
    if (info.models) {
      return { ...out, ok: true, models: info.models, source: info.source, note: `codex 自己的模型目录（provider：${info.provider || '未命名'}）`, defaultModel };
    }
    try {
      const r = await fetchModels(info.base, modelsKey());
      return { ...out, ok: true, models: r.models, source: r.source, note: `来自 codex 配的 provider（${info.provider || '未命名'}）`, defaultModel };
    } catch (err) {
      return { ...out, error: `codex 的服务端没给出列表：${String(err?.message ?? err)}${noKeyHint(modelsKey())}` };
    }
  }

  if (family === 'dsh') {
    const info = readDshProvider();
    if (!info) return { ...out, error: `profile「${dshProfile}」里没找到 llm provider 的 baseURL` };
    try {
      const r = await fetchModels(info.base, modelsKey());
      return {
        ...out,
        ok: true,
        models: r.models,
        source: r.source,
        note: `来自 dsh profile 里配的 provider（${info.name || '未命名'}）`,
        defaultModel: readDshDefaultModel(),
      };
    } catch (err) {
      return { ...out, error: `dsh 的 provider 没给出列表：${String(err?.message ?? err)}${noKeyHint(modelsKey())}` };
    }
  }

  if (family === 'claude') {
    const info = readClaudeCatalog();
    const aliases = claudeAliasModels(info);
    // ① 首选：Claude Code 自己的 settings.json（离线、带显示名、还知道当前默认是哪个）
    if (info?.models.length) {
      return {
        ...out,
        ok: true,
        models: [...info.models, ...aliases],
        source: info.file,
        note: `读的是 Claude Code 自己的配置${info.defaultModel ? `；当前默认 ${info.defaultModel}` : ''}`,
        defaultModel: info.defaultModel,
      };
    }
    // ② 退路：问它配的那个网关（同机 magpie 是 OpenAI 兼容的，/v1/models 能列全）
    if (info?.baseUrl) {
      const base = info.baseUrl.replace(/\/+$/, '');
      for (const u of [`${base}/v1/models`, `${base}/models`]) {
        try {
          const r = await fetchModels(u, info.key);
          if (r.models.length) {
            return {
              ...out,
              ok: true,
              models: [...r.models, ...aliases],
              source: r.source,
              note: `Claude Code 的配置里没有可选清单，从它配的网关列出来的`,
              defaultModel: info.defaultModel,
            };
          }
        } catch {
          /* 换下一条地址试 */
        }
      }
    }
    // ③ 兜底：还是只有三个别名 —— 但把"为什么只有它"写在 note 里
    return {
      ...out,
      ok: true,
      models: aliases,
      source: 'Claude Code 官方别名',
      note: info
        ? '没读到可选清单（settings.json 里没有 modelPicker，网关也没返回）—— 三个别名照旧能用，完整模型名也可以直接填。'
        : '没读到 ~/.claude/settings.json —— 只能给三个官方别名；完整模型名可以手工填。',
      defaultModel: info?.defaultModel ?? null,
    };
  }

  return { ...out, error: `这个协议族（${family ?? '未知'}）还没接模型列表` };
}
