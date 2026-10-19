import fs from 'node:fs';
import path from 'node:path';

/**
 * 项目进度：读各项目自己的 `.bandi/status.yaml`（只读）。
 *
 * ── 这份代码从哪来 ────────────────────────────────────────────────
 * 旧「班底项目面板」（Python，`_archive/plugins/bandi/scripts/bandi_panel.py`）里
 * 解析 / 版本聚合 / 版本文档要点那半截，按平台插件的数据形状重写。
 * **只搬只读的那半截**——一键部署、登记部署目标、发布记录回写全部留在归档里：
 * 面板在平台里的定位是「看记录」，执行是数字员工的活。
 *
 * ── 契约（见 `docs/契约.md`）────────────
 * 进度文件固定是项目根下的 `.bandi/status.yaml`，只覆盖三种形状：
 *   1. 顶层 `键: 值`；
 *   2. `键:` 下面是 `- 项` 的映射列表（`versions`、`tasks`）；
 *   3. `键:` 下面是映射，映射的值还可以是 `- 项` 列表（`doc_index.mirrors`）。
 * 解析器**故意宽松**：面板要的是「尽量把能读的读出来」，硬性校验是 `bandi_status` 的活。
 *
 * ── 这一版砍掉了什么 ────────────────────────────────────────────
 * 不出 `stage`、`live_version`，也不做「版本进展」聚合进度条 —— 那是被契约
 * 明令禁止的「版本状态」枚举的变体。留下的都是**记录**：版本清单（含 `released`
 * 这个事实字段）与版本文档要点。
 *
 * **卡片（`tasks`）已从接口里删掉**（2026-10-14）：卡片的「状态」和流程节点的
 * 状态是同一件事的两种记账，流程时代里流程才是唯一真相（见 `workflows.mjs`），
 * 面板再摆一份只会与流程打架。文件里的 `tasks` 段照旧能解析（解析器是通用的），
 * 只是不再有任何出口。
 *
 * ── 只读的边界 ─────────────────────────────────────────────────
 * 这个模块**只读文件，不写一个字节**。`scope` 是相对项目根的路径，绝对路径与
 * 跳出项目根的路径一律拒绝 —— 只读不等于可以变成任意文件读取器。
 */

/** 进度文件相对项目根的位置，按契约（`docs/契约.md`）固定。 */
export const STATUS_REL = path.posix.join('.bandi', 'status.yaml');

/** 读版本文档时的字节上限与要点条数上限，避免把整份大文档塞进接口。 */
const MAX_SCOPE_BYTES = 256 * 1024;
const MAX_SCOPE_BULLETS = 6;
/** 单个要点与要点汇总的展示长度上限。 */
const POINT_LIMIT = 160;
const POINTS_TEXT_LIMIT = 160;

/** 只认得 `key: value`，键限定为标识符，避免被取值里的冒号带偏。 */
const MAPPING_RE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s?(.*)$/;
/** 行尾注释：`#` 前面得有空白才算注释（`scope: 需求.md#v1.3.0` 的锚点不能被切掉）。 */
const COMMENT_RE = /\s+#/;
/** 要点里的轻量 Markdown：加粗、行内代码、链接。 */
const MD_RE = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\([^)]*\)/g;

/* ------------------------------------------------------------------ 解析 */

/** 还原一个标量取值：写入时用 JSON 串保证安全，读取时按同样规则还原。 */
function parseScalar(value) {
  const v = String(value ?? '');
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

/**
 * 去掉行尾注释。
 *
 * 只在 `#` 前面有空白时才当注释：契约里的 `scope: 需求.md#v1.3.0` 锚点前面没有空白。
 * 不处理注释的后果不是少读一点，而是**整段读不出来**：`versions:  # 台账` 会让
 * `versions:` 的取值看起来非空，段落下所有 `- version:` 条目全被当成无用缩进丢掉。
 */
function stripComment(value) {
  const v = String(value ?? '');
  if (v.startsWith('"') || v.startsWith("'")) {
    const end = v.lastIndexOf(v[0]);
    return end > 0 ? v.slice(0, end + 1) : v;
  }
  const m = COMMENT_RE.exec(v);
  return m ? v.slice(0, m.index) : v;
}

function splitMapping(text) {
  const m = MAPPING_RE.exec(text);
  if (!m) return null;
  return { key: m[1], value: parseScalar(stripComment(m[2]).trim()) };
}

/** 把 status.yaml 解析成 `{顶层键: 取值}`（见文件头契约）。 */
export function parseStatus(text) {
  const result = {};
  let topKey = null;
  let topKind = null; // null | 'scalar' | 'list' | 'map'
  let currentItem = null;
  let pendingListKey = null;

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;

    const indent = raw.length - raw.trimStart().length;
    const stripped = raw.trim();

    if (indent === 0) {
      const mapping = splitMapping(stripped);
      currentItem = null;
      pendingListKey = null;
      if (!mapping) {
        topKey = null;
        topKind = null;
        continue;
      }
      topKey = mapping.key;
      if (mapping.value === '') {
        result[topKey] = null;
        topKind = null;
      } else {
        result[topKey] = mapping.value;
        topKind = 'scalar';
      }
      continue;
    }

    if (topKey === null || topKind === 'scalar') continue;

    if (stripped.startsWith('- ')) {
      if (topKind === null) {
        result[topKey] = [];
        topKind = 'list';
      }
      if (topKind === 'list') {
        currentItem = {};
        result[topKey].push(currentItem);
        const rest = stripped.slice(2).trim();
        if (rest) {
          const mapping = splitMapping(rest);
          if (mapping) currentItem[mapping.key] = mapping.value;
        }
      } else if (pendingListKey !== null) {
        const bucket = result[topKey];
        if (bucket && typeof bucket === 'object' && !Array.isArray(bucket)) {
          if (!Array.isArray(bucket[pendingListKey])) bucket[pendingListKey] = [];
          bucket[pendingListKey].push(stripComment(stripped.slice(2)).trim());
        }
      }
      continue;
    }

    const mapping = splitMapping(stripped);
    if (!mapping) continue;
    if (topKind === null) {
      result[topKey] = {};
      topKind = 'map';
    }
    if (topKind === 'list') {
      if (currentItem) currentItem[mapping.key] = mapping.value;
    } else {
      result[topKey][mapping.key] = mapping.value;
      pendingListKey = mapping.key;
    }
  }

  return result;
}

/* -------------------------------------------------------- 读一个项目 */

/** 读进度文件；读不通不抛异常，返回 `ok:false` + 一句人话。 */
export function readProject(root) {
  const info = { root, ok: false, error: '', project: '', updated: '', versions: [], docIndex: {} };
  const statusFile = path.join(root, STATUS_REL);

  let text;
  try {
    text = fs.readFileSync(statusFile, 'utf8');
  } catch (err) {
    const code = err?.code;
    const shown = STATUS_REL;
    if (code === 'ENOENT') info.error = `找不到 ${shown}`;
    else if (code === 'EISDIR') info.error = `${shown} 是目录，不是文件`;
    else if (code === 'EACCES' || code === 'EPERM') info.error = `没有权限读取 ${shown}`;
    else info.error = `读取失败：${code ?? err?.message ?? err}`;
    return info;
  }

  const data = parseStatus(text.replace(/^\uFEFF/, ''));
  info.project = String(data.project || '') || path.basename(path.resolve(root));
  info.updated = String(data.updated || '');
  const docIndex = data.doc_index;
  info.docIndex = docIndex && typeof docIndex === 'object' && !Array.isArray(docIndex) ? docIndex : {};
  info.versions = (Array.isArray(data.versions) ? data.versions : []).filter(
    (v) => v && typeof v === 'object' && !Array.isArray(v),
  );
  info.ok = true;
  return info;
}

/* ------------------------------------------------- 版本文档：要点提取 */

/** 把相对路径解析到项目根之内；绝对路径或越界返回 null。 */
function resolveInsideRoot(root, relative) {
  const rel = String(relative ?? '').trim();
  if (!rel) return null;
  if (rel.startsWith('/') || rel.startsWith('\\') || /^[A-Za-z]:/.test(rel)) return null;
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, rel.replace(/[/\\]/g, path.sep));
  const diff = path.relative(rootAbs, target);
  if (!diff || diff.startsWith('..') || path.isAbsolute(diff)) return null;
  return target;
}

/** 把要点折成纯文本：面板不是 Markdown 渲染器，别把标记原样露给用户。 */
function plainMarkdown(text) {
  return String(text ?? '')
    .replace(MD_RE, (_, bold, code, label) => bold ?? code ?? label ?? '')
    .trim();
}

function truncate(text, limit = POINT_LIMIT) {
  const s = String(text ?? '');
  return s.length <= limit ? s : s.slice(0, limit - 1) + '…';
}

/** 按空行切段。 */
function paragraphs(lines) {
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (line.trim()) current.push(line.trim());
    else if (current.length) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length) blocks.push(current);
  return blocks;
}

/**
 * 找锚点对应的标题，返回 `{index, level, text}`；找不到返回 null。
 *
 * 先精确匹配，再要求锚点后面不再跟数字或点——否则 `v1.5` 会抢到 `v1.5.1` 那一节。
 * 最后才退到「标题里包含」。
 */
function sectionForAnchor(lines, anchor) {
  const target = String(anchor ?? '').toLowerCase();
  if (!target) return null;
  const headings = [];
  lines.forEach((line, index) => {
    const m = /^(#+)\s+(.*)$/.exec(line.trim());
    if (m) headings.push({ index, level: m[1].length, text: m[2].trim() });
  });

  for (const h of headings) if (h.text.toLowerCase() === target) return h;
  const strict = new RegExp('^' + escapeRe(target) + '(?![\\d.])');
  for (const h of headings) if (strict.test(h.text.toLowerCase())) return h;
  for (const h of headings) if (h.text.toLowerCase().includes(target)) return h;
  return null;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 取某一节正文：从标题下一行起，到下一个同级或更高级标题为止。 */
function sectionBody(lines, section) {
  const body = [];
  for (const line of lines.slice(section.index + 1)) {
    const m = /^(#+)\s/.exec(line.trim());
    if (m && m[1].length <= section.level) break;
    body.push(line);
  }
  return body;
}

/**
 * 从一段正文里抽要点。
 *
 * 先取开头那一段当摘要（版本记录里通常就是「本版主线是……」这句），再补 `- ` 列表项。
 * 一条都抽不到就返回空列表，宁可不写也不编。
 */
function extractPoints(body) {
  const points = [];
  for (const block of paragraphs(body)) {
    const first = block[0];
    if (first.startsWith('#') || first.startsWith('|') || first.startsWith('```') || first.startsWith('---')
      || first.startsWith('>') || first.startsWith('<')) continue;
    if (/^(?:[-*]\s+|\d+[.、]\s+)/.test(first)) break;
    points.push(truncate(plainMarkdown(block.join(' '))));
    break;
  }
  for (const line of body) {
    const item = /^\s*(?:[-*]\s+|\d+[.、]\s+)(.+)$/.exec(line);
    if (item) {
      points.push(truncate(plainMarkdown(item[1])));
      if (points.length >= MAX_SCOPE_BULLETS) break;
    }
  }
  return points;
}

/**
 * 读版本文档的标题与要点。
 *
 * 两种定位方式：带 `#锚点` 时取锚点那一节的摘要与要点（版本记录里 `v1.8.0` 这种写法）；
 * 没有锚点、或锚点找不到标题时，退回找「要做什么」一节。
 */
export function readScope(root, scope, memo = new Map()) {
  const raw = String(scope ?? '').trim();
  const hash = raw.indexOf('#');
  const relative = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
  const anchor = (hash >= 0 ? raw.slice(hash + 1) : '').trim();

  const result = { path: relative, anchor, ok: false, error: '', title: '', bullets: [] };
  if (!relative) return result;

  const target = resolveInsideRoot(root, relative);
  if (!target) {
    result.error = 'scope 必须是相对项目根的路径（或跳出了项目根）';
    return result;
  }

  let text = memo.get(target);
  if (text === undefined) {
    try {
      const fd = fs.openSync(target, 'r');
      try {
        const buf = Buffer.alloc(MAX_SCOPE_BYTES);
        const n = fs.readSync(fd, buf, 0, MAX_SCOPE_BYTES, 0);
        text = buf.subarray(0, n).toString('utf8').replace(/^\uFEFF/, '');
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      result.error = err?.code === 'ENOENT' ? '文档不存在' : `读不了文档：${err?.code ?? err?.message ?? err}`;
      return result;
    }
    memo.set(target, text);
  }

  result.ok = true;
  const lines = text.split(/\r?\n/);

  const section = anchor ? sectionForAnchor(lines, anchor) : null;
  if (section) {
    result.title = section.text;
    result.bullets = extractPoints(sectionBody(lines, section));
    return result;
  }

  // 没有锚点 / 锚点没找到 → 退回「要做什么」那一节，标题取首个 `# ` 一级标题
  let title = '';
  const body = [];
  let collecting = false;
  for (const line of lines) {
    const stripped = line.trim();
    if (stripped.startsWith('# ') && !stripped.startsWith('## ')) {
      if (!title) title = stripped.slice(2).trim();
      continue;
    }
    if (stripped.startsWith('## ')) {
      collecting = stripped.includes('要做什么');
      continue;
    }
    if (collecting) body.push(line);
  }
  result.title = title;
  result.bullets = extractPoints(body);
  return result;
}

/* ------------------------------------------------------------ 聚合 */

/**
 * 按版本铺开：版本清单（含 `released` 这个事实字段与版本文档要点）。
 *
 * **不做状态计数、不出进展百分比**——「这个版本到哪一步了」是流程的事
 * （`workflow_runs.currentNodeId`），不是给版本编一个状态，也不靠卡片另记一份。
 */
function aggregate(root, info, memo) {
  const versions = info.versions.map((raw) => {
    const version = String(raw.version || '');
    const released = String(raw.released || '');
    const scope = String(raw.scope || '');
    const content = scope ? readScope(root, scope, memo) : null;
    const points = content?.bullets ?? [];
    const note = content && !content.ok ? content.error : '';
    return {
      version,
      version_shown: version,
      title: String(raw.title || ''),
      scope,
      released,
      released_path: released,
      released_note: released ? '已发布' : '未发布',
      points,
      // 取不到要点就把原因写在同一格：空着看不出是「文档没写」还是「文档读不了」
      points_text: points.length ? truncate(points.join(' · '), POINTS_TEXT_LIMIT) : note ? `（${note}）` : '',
      points_note: note,
    };
  });

  return { versions };
}

/* ------------------------------------------------------- 对外：两个形状 */

/** 左栏主列表的一行：平台项目账本 × 各自的进度文件。 */
export function projectCard(project) {
  const root = String(project.root ?? '');
  const info = readProject(root);
  const name = String(project.name || '') || info.project || root;

  if (!info.ok) {
    return {
      id: project.id,
      name,
      root,
      builtIn: !!project.builtIn,
      ok: false,
      error: info.error,
      project: info.project,
      updated: '',
      version_count: 0,
      released_count: 0,
      subtitle: `未纳管 · ${info.error}`,
    };
  }

  // 左栏只要计数，**不去读版本文档**：一屏项目卡不该把每版的文档都翻一遍，
  // 那点正文是右边详情的事。
  const releasedCount = info.versions.filter((v) => String(v.released || '')).length;
  return {
    id: project.id,
    name,
    root,
    builtIn: !!project.builtIn,
    ok: true,
    error: '',
    project: info.project,
    updated: info.updated,
    version_count: info.versions.length,
    released_count: releasedCount,
    subtitle: [
      '已纳管',
      `${info.versions.length} 个版本`,
      releasedCount ? `${releasedCount} 个已发布` : '还没有已发布的版本',
      info.updated ? `更新 ${info.updated}` : '',
    ]
      .filter(Boolean)
      .join(' · '),
  };
}

export function listProjectCards(projects) {
  return (projects ?? []).map((p) => projectCard(p));
}

/** 右侧详情：一个项目的版本清单（平铺，够声明式两级布局用）。 */
export function projectDetail(project) {
  const root = String(project.root ?? '');
  const info = readProject(root);
  const name = String(project.name || '') || info.project || root;

  const base = {
    id: project.id,
    name,
    root,
    builtIn: !!project.builtIn,
    ok: info.ok,
    error: info.error,
    status_file: STATUS_REL,
    project: info.project,
    updated: info.updated,
    state_text: info.ok ? '已纳管' : `未纳管：${info.error}`,
    version_count: 0,
    released_count: 0,
    versions: [],
  };
  if (!info.ok) return base;

  const agg = aggregate(root, info, new Map());
  return {
    ...base,
    version_count: info.versions.length,
    released_count: agg.versions.filter((v) => v.released).length,
    versions: agg.versions,
  };
}
