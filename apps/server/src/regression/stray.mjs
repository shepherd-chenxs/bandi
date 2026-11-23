/**
 * 回归量具的"员工产物"纯函数（2026-11-23）。
 *
 * 为什么需要：员工跑题时写临时验证脚本是**正常专业行为** —— 题 2 实跑就写了个
 * `test-clean.mjs` 去验证 `cleanCommand` 有没有剥掉 PowerShell 外壳，完全对路。
 * 但旧复原逻辑只做 `git checkout -- .`（只管已跟踪文件），看到 `??` 就 `exit 1`
 * 「宁可停，不能带着脏树跑下一题」。结果是：题 2 判分**已经在内存里算完**，
 * 却因为员工多写了一个文件而整轮中止 —— 判分连同报告一起丢掉，白跑 20 分钟。
 *
 * 前提：`tools/regression.mjs` 的 `ensureCleanTree()` 每题开跑前强制工作区
 * **完全干净（含未跟踪）**，所以复原时出现的 `??` 条目 100% 是这一轮员工产物。
 * 记进报告（`strayFiles`）当证据，然后清掉，比"判死整轮"诚实得多。
 *
 * 这里只放**解析**（纯函数，可断言）；真正删文件（fs.rmSync）在跑法里。
 */

/**
 * 从 `git status --porcelain -z` 的输出里挑出未跟踪（`??`）的路径。
 *
 * 用 `-z` 而不是普通 porcelain：路径带空格 / 中文时，普通格式会加引号并转义，
 * `-z` 用 NUL 分隔且不转义，`slice(3)` 拿到的就是原样路径。
 * 重命名条目会带一条额外记录（`R  new\0old\0`），但它不以 `??` 开头，天然被跳过。
 *
 * @param {string} stdoutZ `git status --porcelain -z` 的 stdout
 * @returns {string[]} 未跟踪路径（相对仓库根，目录以 `/` 结尾）
 */
export function strayUntracked(stdoutZ) {
  const out = [];
  for (const rec of String(stdoutZ ?? '').split('\0')) {
    if (rec.startsWith('?? ')) out.push(rec.slice(3));
  }
  return out;
}
