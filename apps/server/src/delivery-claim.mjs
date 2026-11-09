/*
 * delivery-claim.mjs —— 「交付声明」协议（2026-11-09 P4）：**跑完 ≠ 完成**。
 *
 * 为什么单独一个文件：卡 / 流程步骤 / 聊天投影都要回答同一句话 ——「这一轮到底交没交付？」
 * 而它此前被各条链路各自猜：`project-tasks.mjs` 把 `run.status === '完成'` 当"干完了"，
 * `workflows.mjs` 只认 `[受阻]`、别的一律 done。同一件事两处各判一次，迟早给出两种答案。
 *
 * 真实事故（2026-11-09，pt-a6841a5b「爻鉴部署」）：运行 r-551f01e3 正常退出（exit 0），
 * 最终回话是空的；平台按"运行结束"把卡自动推进「待验收」—— 员工没交付，阿里云服务器上
 * 也没有任何服务在跑。用户判词："这是在糊弄用户"。
 * 根因不是模型说了假话，是**平台替员工宣布了"干完了"**：进程正常退出只说明这一轮结束了。
 *
 * 协议（跟 2026-10-23 的 `[受阻]` 同源，在这里收拢成唯一判据）：
 *   · 回话**第一个非空行**以 `[完成]` 开头 = 声明交付了 → 卡可进「待验收」；
 *   · 第一个非空行以 `[受阻]` 开头 = 声明没干成 / 要人拍板 → 「已阻塞」；
 *   · 两者都没有（空回话、纯空白、标记在第二行、正文里提到） = 没交回可验收结论。
 * 只认第一个非空行的行首：正文里说「已完成」「没受阻」都可能是转述，不能当声明。
 *
 * 为什么用显式标记而不是猜文本：判"做完没有"是员工的判断，平台不该替他猜；猜错的代价
 * （假验收）已经付过一次。标记也让冒烟可复现，不依赖模型措辞。
 * 平台契约（dispatch.mjs 的 platformContractBlock）每轮把这条规则交给员工。
 */

/** 交付声明标记（协议字面量只定义在这里，别在别处另拼一份） */
export const DONE_MARK = '[完成]';
export const BLOCKED_MARK = '[受阻]';

/** 回话**第一个非空行**（去掉行首空白）；整段没有内容 → ''. */
function firstNonEmptyLine(finalText) {
  return String(finalText ?? '')
    .split('\n')
    .find((line) => line.trim() !== '') ?? '';
}

/** 员工声明受阻（第一行 `[受阻]`）。正文里提到"受阻"不算。 */
export function blockedMark(finalText) {
  return firstNonEmptyLine(finalText).trimStart().startsWith(BLOCKED_MARK);
}

/** 员工声明交付（第一行 `[完成]`）。正文里提到"完成"不算。 */
export function completeMark(finalText) {
  return firstNonEmptyLine(finalText).trimStart().startsWith(DONE_MARK);
}

/**
 * 这一轮的**交付声明**（平台落状态的唯一依据）：
 *   · `'done'`      第一行 `[完成]` —— 员工声明交了，卡可进「待验收」；
 *   · `'blocked'`   第一行 `[受阻]` —— 员工声明没干成/要拍板，卡进「已阻塞」；
 *   · `'silent'`    一个字都没说（空回话/纯空白） —— 连过程都没有；
 *   · `'unclaimed'` 说了话，但没有声明交付 —— 平台不认它是完成。
 * 区分 silent / unclaimed 只为让收尾说明说人话（"没回话" / "没交回结论"），落点一样。
 */
export function claimOf(finalText) {
  const text = String(finalText ?? '');
  if (!text.trim()) return 'silent';
  if (blockedMark(text)) return 'blocked';
  if (completeMark(text)) return 'done';
  return 'unclaimed';
}

/** 摘要里剥掉首行的声明标记：界面另标状态，正文不必再念一遍「[完成]」 */
export function stripClaimMark(finalText) {
  return String(finalText ?? '').replace(/^\s*(\[完成\]|\[受阻\])\s*/, '');
}
