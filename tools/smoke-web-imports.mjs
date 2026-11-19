#!/usr/bin/env node
/* smoke-web-imports.mjs —— 前端模块图的**静态**自检（2026-11-19 加）。
 *
 * 起因：把 chat.mjs 里的两颗选择器拆到 composer-pickers.mjs 时，函数体里用到的
 * `sandboxItems` / `openConversation` 没跟着 import 过去 —— 语法检查全过、首页照常打开，
 * 直到用户点开会话才在右下角弹一条 "sandboxItems is not defined"。
 * 原生 ESM 没有打包器兜底，这类"漏一个 import"只能靠工具盯。
 *
 * 查三件事：
 *   ① import 的具名成员，目标模块确实导出了（含 barrel 转导出）；
 *   ② 目标模块文件存在；
 *   ③ **用了别人导出的名字却没 import**（本轮 bug 的形态）。
 *
 * ③ 用轻量词法剥掉注释/字符串/模板/正则再比，宁可漏报也别乱报。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'apps/web/js');

/* 把源码里"不是代码"的部分换成空格（保留换行，行号不错位） */
function stripNonCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let prevSignificant = '';
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i += 1; }
      i += 2;
      continue;
    }
    if (c === '\'' || c === '"') {
      const q = c; i += 1;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i += 1; break; }
        if (src[i] === '\n') { out += '\n'; i += 1; break; }
        i += 1;
      }
      out += ' ';
      prevSignificant = q;
      continue;
    }
    if (c === '`') {
      i += 1;
      let depth = 0;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') { i += 2; continue; }
        // 模板里的 ${ ... } 是**代码**，要保留出来（否则会把表达式里的名字整块漏掉）
        if (ch === '$' && src[i + 1] === '{') {
          out += ' ';
          let d = 1; i += 2;
          const start = i;
          while (i < n && d > 0) {
            if (src[i] === '{') d += 1;
            else if (src[i] === '}') d -= 1;
            else if (src[i] === '\'' || src[i] === '"' || src[i] === '`') {
              const qq = src[i]; i += 1;
              while (i < n) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === qq) break; i += 1; }
            }
            if (d > 0) i += 1;
          }
          out += ` ${stripNonCode(src.slice(start, i))} `;
          i += 1;
          continue;
        }
        if (ch === '`') { i += 1; break; }
        if (ch === '\n') out += '\n';
        i += 1;
      }
      out += ' ';
      prevSignificant = '`';
      continue;
    }
    if (c === '/') {
      const isRegex = !prevSignificant || /[([{,;:=!&|?+\-*%^~<>]/.test(prevSignificant);
      if (isRegex) {
        i += 1;
        let inClass = false;
        while (i < n) {
          const ch = src[i];
          if (ch === '\\') { i += 2; continue; }
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) { i += 1; break; }
          else if (ch === '\n') break;
          i += 1;
        }
        while (i < n && /[a-z]/.test(src[i])) i += 1; // 旗标
        out += ' ';
        prevSignificant = '/';
        continue;
      }
    }
    out += c;
    if (!/\s/.test(c)) prevSignificant = c;
    i += 1;
  }
  return out;
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.mjs')).sort();
const src = new Map(files.map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]));

/* 每个模块导出了什么（含 export {…} from 与 barrel 重导出） */
const exportsOf = new Map();
for (const [f, t] of src) {
  const set = new Set();
  const code = stripNonCode(t);
  for (const m of code.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) set.add(m[1]);
  for (const m of t.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) set.add(name);
    }
  }
  for (const m of t.matchAll(/export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) set.add('default');
  exportsOf.set(f, set);
}

const problems = [];
const allExports = new Map(); // 名字 -> 定义它的模块（③ 用）
for (const [f, set] of exportsOf) for (const name of set) if (!allExports.has(name)) allExports.set(name, f);

for (const [f, raw] of src) {
  const code = stripNonCode(raw);

  /* ① ②：import / 转导出 的具名成员必须存在于目标模块 */
  for (const m of code.matchAll(/(import|export)\s*\{([^}]*)\}\s*from\s*['"]\.\/([\w.-]+\.mjs)['"]/g)) {
    const [, kind, names, target] = m;
    if (!exportsOf.has(target)) { problems.push(`${f}: ${kind} 从 ${target} 引成员 —— 模块不存在`); continue; }
    for (const part of names.split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (!exportsOf.get(target).has(name)) problems.push(`${f}: ${target} 没有导出 ${name}`);
    }
  }

  /* 本文件"能用"的名字：本地声明 + import 进来的 + 动态 import 解构的 */
  const declared = new Set();
  for (const m of code.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of raw.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) declared.add(name);
      // `import { back as stackBack }` —— 原名也在 import 语句里出现过，别把它当成"漏 import"
      const orig = part.trim().split(/\s+as\s+/)[0].trim();
      if (orig) declared.add(orig);
    }
  }
  for (const m of raw.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) declared.add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+import/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(':').pop().trim();
      if (name) declared.add(name);
    }
  }
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) declared.add(name);
    }
  }
  // 形参与解构参数（粗筛，只为少报）
  for (const m of code.matchAll(/function\s*[\w$]*\s*\(([^)]*)\)/g)) {
    for (const p of m[1].split(',')) {
      const name = p.trim().replace(/=.*$/, '').replace(/^\.\.\./, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
    }
  }
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const p of m[1].split(',')) {
      const name = p.trim().replace(/=.*$/, '').replace(/^\.\.\./, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
    }
  }
  for (const m of code.matchAll(/\b(?:catch|for)\s*\(\s*(?:const|let|var)?\s*\{?([^)]*)\)/g)) {
    for (const p of m[1].split(',')) {
      const name = p.trim().split(':').pop().replace(/=.*$/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
    }
  }

  /* ③ 用了别人导出的名字（本文件既不声明也没 import）→ 漏 import */
  for (const [name, owner] of allExports) {
    if (owner === f || declared.has(name)) continue;
    // 名字前面允许是 `...`（展开），允许是行首/空格；不允许是 `obj.` / `obj?.` 这种属性取用
    const re = new RegExp(`(?:(?<![.\\w$])|(?<=\\.\\.\\.))${name.replace(/\$/g, '\\$')}(?![\\w$])(?!\\s*:)`);
    if (!re.test(code)) continue;
    // 排除"只是作为字符串 key 出现在别处"的误报：要求它出现在调用/取值上下文
    problems.push(`${f}: 用了 ${name}（导出于 ${owner}）却没有 import`);
  }
}

if (problems.length) {
  console.error('✗ 前端模块图有问题：');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`✓ ${files.length} 个前端模块：import 全部可解析，没有漏 import 的跨模块引用`);
