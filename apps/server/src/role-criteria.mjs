/**
 * **岗位判据（平台能核对的那部分"专业度"）**（2026-11-22，缺口②的正账）
 *
 * ## 为什么要有这一层
 *
 * 岗位手册（`roles/packs/*.md`）里早就写着"验证过再交""不许按进程名清杀"，但平台
 * **一个词都不认识** —— 它只认 `[完成]` 标记和卡状态。于是手册里的红线只是**建议**：
 * 说了不一定做，做了没人核对，改一版手册也没有任何东西能说这版比上版更专业。
 *
 * 这一层把"能确定性核对的动作"从手册里抽出来，变成**平台每轮注入、收尾核对**的判据。
 * 判据不是更长的提示词 —— 提示词是劝，判据是账（对照 `delivery-evidence.mjs` 那条教训：
 * 把完成判据押在员工记得写字上，本身就是错的）。
 *
 * ## 只认三种（别扩张，扩一种就要有一次"误判会不会滚成循环"的推演）
 *
 *   · `must-run`  必须跑过：本轮工具事件里有一条**命令**包含给定候选之一（OR）
 *   · `must-read` 必须读过：本轮有一次读文件命中给定路径之一
 *   · `never`     不许：本轮**任何**工具动作里都不许出现给定串（红线，用正则更稳）
 *
 * ## 能判才判（宁可漏报，不误报 —— 与 `task-claim-audit.mjs` 同一口径）
 *
 *   ① 本轮一条命令工具事件都没有 → `must-run` 记「判不了」，**不记失败**
 *      （有的运行时不吐 tool 事件，凭空判失败就是诬告）；
 *   ② `must-run` / `must-read` 只在**声称完成**那一轮核（`when: 'done'`）——
 *      还在干活的中途当然可以没跑；
 *   ③ `never` 任何时候都核 —— 红线跟交没交差无关。
 *
 * ## 判据从哪来（两层，都在代码里可 review）
 *
 *   · `BASE_CRITERIA`：平台级红线，全体员工。目前只有一条（不许按进程名全量清杀 node），
 *     它是 `dispatch/contract.mjs` 第 12 条的执行侧落地 —— 那条文字是 2026-11-20 的实报：
 *     一张卡红了三轮，全是它自己把运行时杀了。
 *   · 岗位手册的 `## 判据` 段：只给"完成声明必须伴随某个动作"的岗位写（现在只有研发 / 测试）。
 *     **宁少不滥**：判据一多，每轮契约变长、误判概率上升，最后没人看。
 *
 * 纯函数为主（`parseCriteria` / `actionsOf` / `checkCriteria`），文件读取只在 `criteriaFor`：
 * 所以冒烟能直接喂事件测，不用起服务。
 */
import { rolePackBody } from './roles/pack.mjs';

/** 平台级红线（全体员工）。正则而不是字符串：这条命中了就是事故，宁可宽一点 */
export const BASE_CRITERIA = Object.freeze([
  {
    id: 'never:按进程名清杀',
    kind: 'never',
    when: 'always',
    label: '不许按进程名全量清杀（会把运行时 node 一起杀掉，见本轮契约第 12 条）',
    patterns: [
      /Get-Process\s+node[^\n]*Stop-Process/i,
      /taskkill[^\n]*\/IM\s+node/i,
      /killall\s+node/i,
      /pkill[^\n]*\bnode\b/i,
      /Stop-Process[^\n]*-Name\s+['"]?node/i,
    ],
  },
]);

/** 判据段里认的三个动词（顺序即优先级：「不许」先于「必须」） */
const VERBS = [
  { kind: 'never', re: /不许|禁止/ },
  { kind: 'must-run', re: /必须跑过|必须执行过/ },
  { kind: 'must-read', re: /必须读过|必须读过全文/ },
];

/**
 * 解析岗位手册里的 `## 判据` 段。
 *
 * 只认这一段的 `- ` 开头条目，且**必须带反引号里的具体动作** —— 写在别处、或只有形容词的
 * 那一行会被跳过并列进 `warnings`（宁可漏，不要猜）。格式：
 *
 * ```md
 * ## 判据（平台收尾核对）
 * - 声称完成前必须跑过测试（任一）：`npm test`、`node tools/run-smokes.mjs`、`pytest`
 * - 任何时候都不许：`git push --force`
 * ```
 */
export function parseCriteria(body) {
  const criteria = [];
  const warnings = [];
  let inSection = false;
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (/^#{1,6}\s/.test(line)) {
      inSection = /^#{1,6}\s*判据/.test(line);
      continue;
    }
    if (!inSection || !/^[-*]\s+/.test(line)) continue;
    const verb = VERBS.find((v) => v.re.test(line));
    if (!verb) {
      warnings.push(`判据段里有看不懂的行（缺「必须跑过 / 必须读过 / 不许」）：${line}`);
      continue;
    }
    const args = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean);
    if (!args.length) {
      warnings.push(`判据没写反引号里的具体动作（判不了，已跳过）：${line}`);
      continue;
    }
    // 标签 = 冒号之前那半句（**保留动词**：「必须跑过测试」比「测试」说得清是什么判据），
    // 去掉反引号；给契约和信箱当人话用
    const label = line
      .replace(/^[-*]\s+/, '')
      .split(/[：:]/)[0]
      .replace(/`[^`]*`/g, '')
      .replace(/\s+/g, ' ')
      .replace(/[，,、。；;\s]+$/, '')
      .trim();
    criteria.push({
      id: `${verb.kind}:${args[0]}`,
      kind: verb.kind,
      // 红线任何时候都核；"必须…"只在声称完成那一轮核（见文件头②）
      when: verb.kind === 'never' ? 'always' : 'done',
      args,
      label: label || line.replace(/^[-*]\s+/, '').slice(0, 40),
    });
  }
  return { criteria, warnings };
}

const packCriteriaCache = new Map(); // roleKey → { body, criteria }

/** 某个岗位的判据 = 平台级红线 + 手册里能解析出来的那些（找不到手册就只有红线） */
export function criteriaFor(roleKey) {
  const key = String(roleKey ?? '').trim();
  const body = key ? rolePackBody(key) : '';
  const hit = packCriteriaCache.get(key);
  if (hit && hit.body === body) return hit.criteria;
  const parsed = body ? parseCriteria(body).criteria : [];
  const criteria = [...BASE_CRITERIA, ...parsed.filter((c) => !BASE_CRITERIA.some((b) => b.id === c.id))];
  packCriteriaCache.set(key, { body, criteria });
  return criteria;
}

/** 把 run_events 里的事件摊成「动作」，判据只在动作层面核对 */
export function actionsOf(events = []) {
  const out = [];
  for (const e of events) {
    if (e?.type !== 'tool') continue;
    const d = e.input ?? e.detail ?? {};
    const str = (v) => (typeof v === 'string' ? v : '');
    const text = [str(d.command), str(d.cmd), str(d.file_path), str(d.path), str(d.args), str(e.name)]
      .filter(Boolean)
      .join('\n');
    const name = String(e.name ?? '').toLowerCase();
    const kind =
      d.command || d.cmd || /bash|shell|command_execution|exec/.test(name)
        ? 'cmd'
        : name === 'read'
          ? 'read'
          : /write|edit|apply_patch|file_change/.test(name)
            ? 'write'
            : 'other';
    out.push({ kind, name, text });
  }
  return out;
}

/**
 * 核这一轮。
 *
 * @param {object} p
 * @param {Array} p.criteria  criteriaFor() 的结果
 * @param {Array} p.actions   actionsOf() 的结果
 * @param {string|null} p.claimed  claimOf(finalText)：'done' / 'blocked' / 'silent' / null
 * @returns {{checked:Array, failed:Array, skipped:Array}}
 *   `failed` 里每条带 `why`（一句人话：没过在哪），`skipped` 带「为什么判不了」。
 */
export function checkCriteria({ criteria = [], actions = [], claimed = null } = {}) {
  const checked = [];
  const failed = [];
  const skipped = [];
  const cmds = actions.filter((a) => a.kind === 'cmd');
  const reads = actions.filter((a) => a.kind === 'read');

  for (const c of criteria) {
    if (c.when === 'done' && claimed !== 'done') {
      skipped.push({ id: c.id, why: '这轮没声称完成（还在干活，不核这条）' });
      continue;
    }
    if (c.kind === 'must-run') {
      if (!cmds.length) {
        skipped.push({ id: c.id, why: '本轮没有任何命令工具事件（判不了，不记失败）' });
        continue;
      }
      checked.push(c);
      const hit = cmds.find((a) => c.args.some((x) => a.text.toLowerCase().includes(x.toLowerCase())));
      if (!hit) failed.push({ ...c, why: `本轮跑过的命令里没有：${c.args.join(' / ')}` });
      continue;
    }
    if (c.kind === 'must-read') {
      if (!reads.length) {
        skipped.push({ id: c.id, why: '本轮没有读文件动作（判不了，不记失败）' });
        continue;
      }
      checked.push(c);
      const hit = reads.find((a) => c.args.some((x) => a.text.toLowerCase().includes(x.toLowerCase())));
      if (!hit) failed.push({ ...c, why: `本轮读过的文件里没有：${c.args.join(' / ')}` });
      continue;
    }
    if (c.kind === 'never') {
      checked.push(c);
      const hit = actions.find(
        (a) =>
          (c.patterns ?? []).some((re) => re.test(a.text)) ||
          (c.args ?? []).some((x) => a.text.toLowerCase().includes(x.toLowerCase())),
      );
      if (hit) failed.push({ ...c, why: `本轮真的执行了：${hit.text.split('\n')[0].replace(/\s+/g, ' ').slice(0, 100)}` });
    }
  }
  return { checked, failed, skipped };
}

/**
 * 契约里那几行（每轮注入）。没有判据的岗位返回空数组 —— 契约不长一个字。
 *
 * 措辞的边界：**判据只在平台能核对的动作上成立**，所以文案不许写成"你要专业"，
 * 只写"这一轮的动作里必须出现什么"。判据说的和平台核的必须是同一件事。
 */
export function criteriaLines(criteria = []) {
  if (!criteria.length) return [];
  const lines = ['- **本岗判据（平台收尾会核本轮工具动作；对不上这轮不算交付）**：'];
  for (const c of criteria) {
    if (c.kind === 'must-run') lines.push(`  · ${c.label}：${c.args.map((a) => `\`${a}\``).join(' / ')}`);
    else if (c.kind === 'must-read') lines.push(`  · ${c.label}：${c.args.map((a) => `\`${a}\``).join(' / ')}`);
    else lines.push(`  · 红线 · ${c.label}`);
  }
  return lines;
}
