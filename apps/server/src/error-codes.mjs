/**
 * error-codes.mjs —— 面向人的错误码**唯一一份**（2026-11-24）。
 *
 * ## 为什么单独一个文件
 *
 * 码表原来有两个落点：代码里散落的字面量（`throw new GitError('E12xx', …)`）
 * 和文档里手抄的一张表（那份文档 2026-11-24 已删）。手抄那份没有校验，
 * 改码的人改代码、不看文档，两处迟早对不上 —— 文档里写着的码在代码里已经不存在，
 * 或者新加的码永远没人知道。
 *
 * 现在的分工：
 *   · **码 + 意思 + 出路** 只在这里（`GIT_CODES`）—— 文档、检查工具、测试都读它；
 *   · **具体文案** 留在抛错的调用点，因为它要嵌上下文（分支名、规则原文、git 原始输出），
 *     塞进表里就只能写成拼接模板，读起来更难维护。
 *
 * 所以**文档层不再抄表**。`tools/check-doc-drift.mjs` ⑤ 会核对两件事：
 * 文档里出现的码必须在表里、源码里抛出的码必须在表里。
 */

/** git 域错误码：码 → 用户看的意思 + 出路。加码先加这里。 */
export const GIT_CODES = Object.freeze({
  E1201: { summary: '分支保护规则挡的', next: '切新分支推、建 PR，等 gate 绿' },
  E1202: { summary: '历史/同名分支冲突（非快进）', next: '先「更新项目」再推；同名就换分支名，平台不强推' },
  E1203: { summary: '令牌权限不够', next: '给令牌补 Contents: write / 在 Repository access 里选中这个仓库' },
  E1204: { summary: '连不上远端（网络/代理/DNS）', next: '检查网络/代理，恢复后重试' },
  E1205: { summary: '这行仓库没有 GitHub 身份（owner/name）', next: '去本地目录确认 origin 指向 github.com，或用「仓库 URL」重新接入；令牌权限不用改' },
  E1299: { summary: '没认出来的推送失败', next: '原文已垫底；修的时候顺手把它升级成新码，别让 E1299 常住' },
});

/** 码在表里吗（测试和检查工具用） */
export function isGitCode(code) {
  return Object.hasOwn(GIT_CODES, String(code ?? ''));
}

/**
 * 带错误码的领域错（报错规范，2026-11-14 定、2026-11-24 搬到本文件）。
 *
 * 文案自带 `[码]` 前缀 —— 流程卡、信箱、toast 这些**不经过路由**的出口，直接显示就是
 * 合规形态（码 + 人话一起到，用户不用在别处查这个错是什么）；`.code` 是给程序用的：
 * 路由 catch 优先透传它（不再盖一层路由自己的码），流程引擎/审计按码归类常见错。
 */
export class GitError extends Error {
  constructor(code, message) {
    super(`[${code}] ${String(message ?? '')}`);
    this.name = 'GitError';
    this.code = code;
  }
}

/** 抛一条带码的领域错。码没登记就补进 `GIT_CODES` —— 别在调用点现编一个。 */
export function gitFail(code, message) {
  throw new GitError(code, message);
}

/** 交给调用方自己抛的形态（`translatePushFailure` 这类纯函数返回 `{ code, text }`）。 */
export function gitFailure(code, text) {
  return { code, text };
}
