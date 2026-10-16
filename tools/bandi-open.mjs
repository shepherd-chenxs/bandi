#!/usr/bin/env node
/*
 * bandi open —— 只读列出当前「待开发 / 开发中」的卡（按版本分组）。
 *
 * 用法：
 *   bandi open [项目路径]
 *
 * 不传项目路径则读当前目录下的 .bandi/status.yaml。
 * 只读不改任何文件；同一份输入重复执行，输出逐字节一致。
 * 只依赖 Node 标准库（node:fs / node:path），无第三方依赖。
 *
 * 状态判定沿用**老账本**（`status.yaml` 的 `tasks` 段）的 8 态集合；
 * 「待开发」「开发中」视为未开工/进行中的可见卡，其余状态不列出。
 *
 * ⚠️ **这是老账本的工具**（2026-10-16 注）：`tasks` 段已作废，契约写明「平台不读、面板不出、
 *    任何角色都不许再改」。现在要看"有哪些活、都什么状态"走平台的**任务看板**（项目页点进去）。
 *    这个命令只对**还没清理的老账本**（别的项目里那些历史数据）还有点用，别再拿它当进度看。
 *
 * 退出码：0 = 正常（含「一张都没有」的情况，此时只打一行空清单说明）；
 *         1 = 读不通（文件缺失 / 不是目录 / 解析失败 / 字段缺失），stderr 给原因，stdout 不写半个字。
 */

import fs from 'node:fs';
import path from 'node:path';

const STATUS_RELATIVE_PATH = path.join('.bandi', 'status.yaml');

// 老账本那套状态机（契约里已作废的部分）要列出的两类。
const VISIBLE_STATUSES = new Set(['待开发', '开发中']);

// 解析时每张任务必须具备的字段（与 bandi-status 契约对齐）。
const REQUIRED_FIELDS = ['id', 'title', 'status'];

const STATUS_ERROR = Symbol('StatusError');

function fail(message) {
  const err = new Error(message);
  err[STATUS_ERROR] = true;
  return err;
}

// 形如 `key: value` 的映射行。键限定为标识符，避免取值里的冒号带偏。
const MAPPING_RE = /^(?<key>[A-Za-z_][A-Za-z0-9_-]*)\s*:\s?(?<value>.*)$/;
// 形如 `- 内容` 的列表项行。
const ITEM_RE = /^-\s*(?<rest>.*)$/;

/**
 * 把 status.yaml 文本解析成 tasks 列表，保留文件先后顺序。
 * 与归档的 bandi_status.py 同一套结构：顶层 tasks: 下是一串映射。
 */
function parseTasks(text) {
  const tasks = [];
  let current = null;
  let inTasks = false;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineno = i + 1;
    const raw = lines[i];
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;

    const indent = raw.length - raw.replace(/^ /g, '').length;
    const stripped = raw.trim();

    if (indent === 0) {
      const m = MAPPING_RE.exec(stripped);
      if (!m) throw fail(`第 ${lineno} 行不是合法的 \`键: 值\`：${stripped}`);
      inTasks = m.groups.key === 'tasks';
      current = null;
      continue;
    }
    if (!inTasks) continue;

    const item = ITEM_RE.exec(stripped);
    if (item) {
      current = {};
      tasks.push(current);
      const rest = item.groups.rest.trim();
      if (!rest) continue;
      stripped2(rest, lineno, tasks.length, current);
      continue;
    }
    if (!current) throw fail(`第 ${lineno} 行出现在任何任务项之前：${stripped}`);
    stripped2(stripped, lineno, tasks.length, current);
  }
  return tasks;

  function stripped2(s, lineno, pos, cur) {
    const m = MAPPING_RE.exec(s);
    if (!m) throw fail(`第 ${lineno} 行不是合法的 \`键: 值\`：${s}`);
    let value = m.groups.value.trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === "'" || value[0] === '"')) {
      value = value.slice(1, -1);
    }
    cur[m.groups.key] = value;
  }
}

function readTasks(statusPath) {
  let text;
  try {
    text = fs.readFileSync(statusPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw fail(`找不到状态文件：${statusPath}（请确认项目路径有效，且其下有 .bandi/status.yaml）`);
    if (e.code === 'EISDIR') throw fail(`状态文件路径是目录，不是文件：${statusPath}`);
    if (e.code === 'EACCES') throw fail(`没有权限读取状态文件：${statusPath}`);
    throw fail(`读取状态文件失败：${statusPath}（${e.message}）`);
  }
  const tasks = parseTasks(text);
  tasks.forEach((task, idx) => {
    const missing = REQUIRED_FIELDS.filter((f) => !(f in task));
    if (missing.length) throw fail(`第 ${idx + 1} 个任务缺少字段：${missing.join('、')}`);
  });
  return tasks;
}

/** 转义 Markdown 表格单元格，避免取值里的 | 或 \ 撑破表格。 */
function escapeCell(value) {
  return String(value).replace(/[\\|]/g, (m) => '\\' + m);
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** 版本排序键，缺失 version 的排最后。 */
function versionKey(task) {
  const v = task.version;
  if (!v) return [Infinity, Infinity, Infinity];
  const m = VERSION_RE.exec(String(v).trim());
  if (!m) return [Infinity, Infinity, Infinity];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function render(tasks) {
  // 只保留「待开发 / 开发中」。
  const open = tasks.filter((t) => VISIBLE_STATUSES.has(t.status));

  // 按版本分组，组内保持文件顺序。
  const groups = new Map(); // version -> tasks[]
  for (const t of open) {
    const v = t.version || '(未指定版本)';
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v).push(t);
  }

  const out = [];
  out.push(`# 待开发 / 开发中（共 ${open.length} 张）`);
  out.push('');

  if (open.length === 0) {
    out.push('当前没有待开发或开发中的卡。');
    return out.join('\n') + '\n';
  }

  // 版本顺序：按 semver 升序，未指定版本沉底。
  const versions = [...groups.keys()].sort((a, b) => {
    const ka = versionKey({ version: a });
    const kb = versionKey({ version: b });
    for (let i = 0; i < 3; i++) {
      if (ka[i] !== kb[i]) return ka[i] - kb[i];
    }
    return 0;
  });

  for (const v of versions) {
    const list = groups.get(v);
    out.push(`## ${v}（${list.length} 张）`);
    out.push('');
    out.push('| ID | 标题 | 状态 |');
    out.push('| --- | --- | --- |');
    for (const t of list) {
      out.push(`| ${escapeCell(t.id)} | ${escapeCell(t.title)} | ${escapeCell(t.status)} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length > 1) {
    process.stderr.write('用法：bandi open [项目路径]\n');
    return 1;
  }

  const projectPath = argv[0] || '.';
  let stat;
  try {
    stat = fs.statSync(projectPath);
  } catch (e) {
    if (e.code === 'ENOENT') {
      process.stderr.write(`bandi open: 项目路径不存在：${projectPath}\n`);
      return 1;
    }
    process.stderr.write(`bandi open: 无法访问项目路径：${projectPath}（${e.message}）\n`);
    return 1;
  }
  if (!stat.isDirectory()) {
    process.stderr.write(`bandi open: 项目路径不是目录：${projectPath}\n`);
    return 1;
  }

  const statusPath = path.join(projectPath, STATUS_RELATIVE_PATH);
  try {
    const tasks = readTasks(statusPath);
    process.stdout.write(render(tasks));
    return 0;
  } catch (e) {
    if (e && e[STATUS_ERROR]) {
      process.stderr.write(`bandi open: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

process.exit(main());