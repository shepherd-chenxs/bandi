/**
 * 平台「停止循环」闸的识别（2026-11-23，实跑踩到的第 5 个问题）。
 *
 * 题 5（note-followed）的员工改完 contract.mjs 后，连续 8 次调同一个
 * `git diff ... && node --test ...`，被 codex 的「停止循环的回复」闸掐断：
 * 平台往会话里塞了一条 text 事件（「这一轮在发给模型之前已被停止…」），
 * `runs` 表却是 `status='done'`、`error=null` —— **没有任何结构化字段**。
 *
 * 旧量具只看到「改了文件但没提重启」，判成员工 fail。可员工根本没收到
 * 最后一轮请求，没机会说后半句。拿半张考卷打分既不该 pass 也不该 fail，
 * 跟 `interrupted` 一样要单列"不作数"。
 *
 * 只放纯函数（可断言）；查库在 tools/regression.mjs 里。判据（suite.mjs）不碰。
 */

/** codex 防循环闸的固定文案片段 —— 命中任一即认定"这一轮被平台掐断"。 */
export const PLATFORM_STOP_RE =
  /这一轮在发给模型之前已被停止|停止循环的回复|模型陷入了重复|连续\s*\d+\s*次调用了同一个工具/;

/**
 * @param {unknown} text text 事件的 text，或 __done 事件的 finalText
 * @returns {boolean}
 */
export function isPlatformStopText(text) {
  return PLATFORM_STOP_RE.test(String(text ?? ''));
}
