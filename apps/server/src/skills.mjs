import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoRoot } from './config.mjs';

/** skill 库就在平台根下（平台根会被自动附加为每个员工的目录之一） */
export const skillsRoot = path.join(repoRoot, 'skills');

/** 目录名要当路径用，必须收紧：字母数字开头，后接字母数字/点/下划线/连字符 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * 内置技能（2026-10-22 用户拍板："这些技能只允许用，不许改，只有你自己添加的可以改"）。
 *
 * 登记的是**随仓库走的出厂技能** —— 数字员工的行为挂在它们正文上，改了会直接影响线上跑法。
 * 清单写死在代码里（不是 skills/ 下的文件）：往 skills/ 里加新技能 = 可改；
 * 想让某个新技能也变只读，要走一次代码变更 —— 这正是"不许改"该有的门槛。
 * 判定按**目录名**（frontmatter 的 name 可以跟目录不一致，但落盘位置只有一个）。
 */
const BUILTIN = new Set([
  'bandi-avatar',
  'bandi-expert-architect',
  'bandi-expert-dev',
  'bandi-expert-ops',
  'bandi-expert-pm',
  'bandi-expert-product',
  'bandi-expert-qa',
  'bandi-expert-secretary',
  'bandi-expert-test',
  'bandi-expert-ui',
  // 2026-10-30：本仓库的门禁地图（红在哪、只跑一条的命令、改代码还是改断言）。
  // 随仓库走、被"修 gate"这种活反复用到，所以按出厂技能管 —— 不让运行时改。
  'bandi-repo',
  'bandi-secretary',
  'brainstorming',
  'doc-coauthoring',
  'receiving-code-review',
  'requesting-code-review',
  'skill-creator',
  'systematic-debugging',
  'test-driven-development',
  'verification-before-completion',
  'webapp-testing',
]);

export function isBuiltin(name) {
  return BUILTIN.has(String(name ?? ''));
}

export function isValidSkillName(name) {
  return SAFE_NAME.test(String(name ?? ''));
}

/** 极简 frontmatter 解析：只认顶层的 `键: 值`，够用且不会误吞正文 */
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

function readFromDir(dir) {
  const name = path.basename(dir);
  const file = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const { meta, body } = parseFrontmatter(text);
  return {
    name: meta.name && isValidSkillName(meta.name) ? meta.name : name,
    dirName: name,
    builtin: isBuiltin(name),
    title: meta.name || name,
    description: meta.description || '',
    body,
    dir,
    file,
    updatedAt: fs.statSync(file).mtime.toISOString(),
  };
}

const readOne = readFromDir;

/** 只读文件头。列表只要 name/description，正文动辄几十 KB，读了纯属浪费。 */
function readHead(file, bytes = 8192) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 元信息读取：frontmatter 只在文件开头，所以只读头部。
 * 万一 frontmatter 超过头部窗口（描述写得极长），退回整文件读一次。
 */
function readMetaFromDir(dir) {
  const dirName = path.basename(dir);
  const file = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(file)) return null;

  let text = readHead(file);
  if (!/^---\r?\n[\s\S]*?\r?\n---/.test(text)) text = fs.readFileSync(file, 'utf8');

  const { meta } = parseFrontmatter(text);
  return {
    name: meta.name && isValidSkillName(meta.name) ? meta.name : dirName,
    dirName,
    builtin: isBuiltin(dirName),
    title: meta.name || dirName,
    description: meta.description || '',
    dir,
    file,
    updatedAt: fs.statSync(file).mtime.toISOString(),
  };
}

/**
 * 各 CLI 自己带的技能目录。**只读**：那是 CLI 的地盘，我们只发现、不修改。
 * 用于员工详情里的「从运行时继承」——这些 skill 该运行时本来就会，不用再分配。
 */
export function runtimeSkillDirs(family) {
  const home = os.homedir();
  const map = {
    codex: [path.join(home, '.codex', 'skills')],
    claude: [path.join(home, '.claude', 'skills')],
    dsh: [path.join(process.env.DSH_HOME ?? path.join(home, '.dsh'), 'skills')],
  };
  return (map[family] ?? []).filter((d) => fs.existsSync(d));
}

export function listSkills() {
  fs.mkdirSync(skillsRoot, { recursive: true });
  const out = [];
  for (const e of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || !isValidSkillName(e.name)) continue;
    const s = readMetaFromDir(path.join(skillsRoot, e.name));
    if (s) out.push(s);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.cache', '.venv', '__pycache__']);

/**
 * 在某个根下找 SKILL.md。用来「从本地导入」。
 * 会跳过 .git/node_modules，也会跳过我们自己的 skill 库（免得把自己再导一遍）。
 */
export function discoverSkills(root, { maxDepth = 6 } = {}) {
  const found = [];
  const base = path.resolve(root);
  const own = path.resolve(skillsRoot);

  (function walk(dir, depth) {
    if (depth > maxDepth) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 没权限就算了
    }
    for (const e of ents) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (path.resolve(full) === own) continue;
      if (fs.existsSync(path.join(full, 'SKILL.md'))) {
        const s = readMetaFromDir(full);
        if (s) found.push({ ...s, alreadyInPool: fs.existsSync(path.join(own, s.name)) });
        continue; // 已经是 skill 目录，不再往里钻
      }
      walk(full, depth + 1);
    }
  })(base, 0);

  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 把一个 skill 目录整个搬进库里（含 references/ scripts/ 等附件）。
 * 名字冲突时不覆盖，报回来让用户决定。
 *
 * ⚠️ 覆盖导入也要过内置闸（2026-10-22）：库里那条是内置技能时**永不覆盖** ——
 * 它是编辑/删除之外的第三条改法（拿一个同名目录导进来顶掉），不能留活口。
 */
export function importSkill(srcDir, { overwrite = false } = {}) {
  const src = path.resolve(srcDir);
  const parsed = readFromDir(src);
  if (!parsed) throw new Error('这个目录里没有 SKILL.md');

  let name = parsed.name;
  if (!isValidSkillName(name)) name = name.replace(/[^A-Za-z0-9._-]/g, '-');

  const dest = path.join(skillsRoot, name);
  if (fs.existsSync(dest)) {
    if (isBuiltin(path.basename(dest))) {
      return { skipped: true, name, reason: '内置技能是只读的，不能覆盖导入 —— 想定制就换个名字导入' };
    }
    if (!overwrite) return { skipped: true, name, reason: '库里已经有同名 skill' };
  }

  fs.mkdirSync(skillsRoot, { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: true });
  return { skipped: false, name, skill: readFromDir(dest) };
}

export function getSkill(name) {
  if (!isValidSkillName(name)) return null;
  return readOne(path.join(skillsRoot, name));
}

/**
 * 写一个 skill（新建或覆盖）。文件是唯一真源 —— 数据库只存"挂给谁"。
 */
export function writeSkill(name, { description = '', body = '' } = {}) {
  if (!isValidSkillName(name)) {
    throw new Error('名字只能用字母、数字、点、下划线、连字符，且以字母或数字开头');
  }
  const dir = path.join(skillsRoot, name);
  fs.mkdirSync(dir, { recursive: true });

  const desc = String(description).replace(/\r?\n/g, ' ').trim();
  const text = [
    '---',
    `name: ${name}`,
    `description: ${desc}`,
    '---',
    '',
    String(body).replace(/\r\n?/g, '\n').trim(),
    '',
  ].join('\n');

  fs.writeFileSync(path.join(dir, 'SKILL.md'), text, 'utf8');
  return readFromDir(dir);
}

export function removeSkill(name) {
  if (!isValidSkillName(name)) return false;
  const dir = path.join(skillsRoot, name);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * 首轮注入给模型的那几行。
 * 只给「名字 + 一句话 + 路径」——不塞正文。正文让它按需去读（渐进披露）。
 */
export function skillDigest(names) {
  const lines = [];
  for (const n of names) {
    const s = getSkill(n);
    if (!s) continue; // 文件被删了，静默跳过，不要让运行挂掉
    lines.push(`- ${s.name}：${s.description || '（未写描述）'} —— 读文件 ${s.file}`);
  }
  return lines;
}
