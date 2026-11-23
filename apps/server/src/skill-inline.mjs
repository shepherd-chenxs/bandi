/**
 * **把方法论正文直接放进这一轮的上下文**（2026-11-22，三个缺口里的"第一步"）。
 *
 * ## 为什么（缺口②③的交集，但**两边都只修一半**，别说成谁的解法）
 *
 * 定位先说清楚，免得被记成"缺口②做完了"或"缺口③做完了"：
 *   · 对**缺口②（专业度）**：修的是**到场率**，不是正确率 —— 方法在不在他手里；
 *     他会不会按方法做、做得对不对，这一层管不了（那要判据与回归，见下一轮）。
 *   · 对**缺口③（凭证）**：修的是**问题消失**，不是被核对 —— 正文已经无条件在上下文里，
 *     "他读没读"不再是个可问的问题；但"他照没照做"仍然没有任何凭证。
 *
 *
 * 技能一直是这么用的：首轮只给「名字 + 48 字描述 + 文件路径」，正文让模型
 * **自己按需去 Read**。三个毛病叠在一起：
 *   ① 续接的会话里连这份清单都没有（`skillsBlock` 只在 firstTime 注入）—— 跑到第 30 轮，
 *      技能早沉进上下文深处，"这轮该按哪份方法做"根本不在它的视野里；
 *   ② 读不读全凭自觉，而且清单那句「只在这轮需要时读正文」等于**给了不读的正当理由**；
 *   ③ 事后只能翻 run_events 看它 Read 过哪个文件 —— 那是核对，不是交付（缺口三）。
 *
 * 所以换成"平台先把该用的那份摆到它面前"：**派活时按这轮的任务文本匹配**，命中就把正文
 * 内联进任务（整份、不发路径）。代价是 token，但此前模型真去 Read 也是把同样的正文塞进
 * 上下文 —— 内联不比现状贵，只是不再赌它会不会读。
 *
 * ## 为什么匹配表写在这里，而不是技能文件里
 *
 * 「哪类任务该用哪份方法」是**平台的判断**，不是技能自身的属性；技能文件是内容
 * （正文 + 一句话描述），策略是代码 —— 跟 roles.mjs 把权限与岗位分开同一个理由。
 * 也因此这张表可以 review、可以改、可以被冒烟钉住，而不必动 `skills/` 下那些内置技能。
 *
 * ## 三条边界（改之前先想清楚）
 *
 *   1. **宁可漏，不可误**：只认「显式点名」和「手写的触发词」，不做中文分词/相似度猜测。
 *      误注入的代价不是多几百字，而是**方法论劫持任务**（2026-11-09 李俊那次：brainstorming
 *      描述里的 "MUST use before any creative work" 把问答卡变成了创作题）。
 *   2. **注入 ≠ 强制**：内联块里明说「这是做法，不是任务模式，交什么仍按【本轮任务合同】」。
 *      靠改口吻去约束行为终归是建议性的，真正的闸是合同与交付证据，不是这一块。
 *   3. **有上限**：默认最多 2 份、每份 6000 字（超出截在段落边界并留全文路径）。
 *      不做上限就是把"省一次 Read"换成"每轮多烧几千 token"。
 *
 * 关掉：`BANDI_SKILL_INLINE=0`；调上限：`BANDI_SKILL_INLINE_MAX` / `BANDI_SKILL_INLINE_CHARS`。
 */
import * as skills from './skills.mjs';

const intEnv = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

/** 每轮最多内联几份（0 = 关掉） */
export const SKILL_INLINE_MAX = intEnv('BANDI_SKILL_INLINE_MAX', 2);
/** 单份正文的字数上限（超出截断，留全文路径） */
export const SKILL_INLINE_CHARS = intEnv('BANDI_SKILL_INLINE_CHARS', 6000);

/** 平台侧匹配表：任务文本里出现这些词 → 这一轮认为该用这份方法论。
 *  只收**指向明确**的词；「方案 / 设计 / 总结」这类泛词故意不收（它们几乎每轮都出现）。 */
export const TRIGGERS = Object.freeze({
  // 怎么给雇主写回话（契约第 1 条就指向它，是最常被"该读没读"的一份）
  'bandi-report': ['汇报', '简报', '验收结论', '交差', '结论先行'],
  // 本仓库门禁地图：修 gate / 冒烟红了 时才需要
  'bandi-repo': ['冒烟', '门禁', 'pr 红', '红在哪', '跑哪条命令', 'gate'],
  // 分支与提交的两条规则
  'bandi-git': ['提交信息', '提交说明', '分支名', '建分支', 'commit message'],
  // 排障：先复现再修
  'systematic-debugging': ['报错', '复现', '排查', '排障', '跑不过', '挂了', 'bug'],
  // 交付前必须跑过验证命令（"改好了"要有证据）
  'verification-before-completion': ['交付前', '改好了', '验证一下', '确认通过', '回归'],
  // 改行为 = 先写测试
  'test-driven-development': ['先写测试', '单元测试', 'tdd'],
  // 新东西开工前先发散再收敛
  brainstorming: ['头脑风暴', '出方案', '新功能'],
  // 真在页面上点一遍
  'webapp-testing': ['浏览器', '截图', 'playwright', '页面点一遍'],
});

/** 一份技能命中了哪些词（显式点名 + 触发词）；空数组 = 没命中 */
export function hitsOf(text, name, { triggers = TRIGGERS } = {}) {
  const hay = String(text ?? '').toLowerCase();
  if (!hay.trim()) return [];
  const hits = [];
  // 显式点名：任务里直接写了技能名（等价于雇主说"按这个来"）
  if (hay.includes(String(name).toLowerCase())) hits.push(name);
  for (const t of triggers[name] ?? []) {
    if (hay.includes(String(t).toLowerCase())) hits.push(t);
  }
  return hits;
}

/** 截在段落边界（宁可短一点，也别把一句话截成两半） */
function clip(body, max) {
  const s = String(body ?? '').trim();
  if (s.length <= max) return { body: s, truncated: false, totalChars: s.length };
  const cut = s.slice(0, max);
  const at = Math.max(cut.lastIndexOf('\n## '), cut.lastIndexOf('\n\n'));
  return { body: at > max * 0.5 ? cut.slice(0, at) : cut, truncated: true, totalChars: s.length };
}

/**
 * 这一轮该内联哪几份正文。
 *
 * @param {string} text  这轮的任务文本（雇主原话 / 卡标题+描述 / 流程本步要求）
 * @param {string[]} names  这个员工挂着的技能名
 * @returns {{picked: Array<{name:string,file:string,body:string,hits:string[],chars:number,totalChars:number,truncated:boolean}>,
 *            skipped: Array<{name:string,reason:string}>}}
 *   没命中 / 文件不在 / 超过上限的都进 skipped，**绝不抛错**（宁可少一段，不能让派活挂掉）。
 */
export function planSkillInline(text, names, { maxSkills = SKILL_INLINE_MAX, maxChars = SKILL_INLINE_CHARS } = {}) {
  const picked = [];
  const skipped = [];
  if (!maxSkills) return { picked, skipped };
  for (const name of names ?? []) {
    const hits = hitsOf(text, name);
    if (!hits.length) {
      skipped.push({ name, reason: '本轮任务没命中触发词' });
      continue;
    }
    const s = skills.getSkill(name);
    if (!s) {
      skipped.push({ name, reason: '技能文件不在了' });
      continue;
    }
    if (picked.length >= maxSkills) {
      skipped.push({ name, reason: `超过每轮上限 ${maxSkills} 份` });
      continue;
    }
    const { body, truncated, totalChars } = clip(s.body, maxChars);
    if (!body) {
      skipped.push({ name, reason: '正文是空的' });
      continue;
    }
    picked.push({ name: s.name, file: s.file, body, hits, truncated, totalChars, chars: body.length });
  }
  return { picked, skipped };
}
