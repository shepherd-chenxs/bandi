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
 *   · 回话**第一个或最后一个非空行**以 `[完成]` 开头 = 声明交付了 → 卡可进「待验收」；
 *   · 同一位置以 `[受阻]` 开头 = 声明没干成 / 要人拍板 → 「已阻塞」；
 *   · 两处都没有（空回话、只有正文里提到） = 没交回可验收结论。
 * P5（2026-11-09）：问答题第一行要留给答案，交付标记改放**最后一行**；做事类沿用首行。
 * 正文中间提到 `[完成]` / `[受阻]` 都不算。
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
 *   · `'done'`      有 `[完成]` —— 员工声明交了，卡可进「待验收」；
 *   · `'blocked'`   有 `[受阻]` —— 员工声明没干成/要拍板，卡进「已阻塞」；
 *   · `'silent'`    一个字都没说（空回话/纯空白） —— 连过程都没有；
 *   · `'unclaimed'` 说了话，但没有声明交付 —— 平台不认它是完成。
 * 区分 silent / unclaimed 只为让收尾说明说人话（"没回话" / "没交回结论"），落点一样。
 *
 * **声明位置：第一行或最后一行**（2026-11-09 P5 补最后一行）：问答题的第一行要留给答案
 * （"你问 X，答案是 Y"），交付标记放**最后一行**；做事类沿用第一行。两处都只认行首，
 * 正文中间提到 `[完成]` 不算。
 */
export function claimOf(finalText) {
  const text = String(finalText ?? '');
  if (!text.trim()) return 'silent';
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of [lines[0], lines.at(-1)]) {
    if (!line) continue;
    if (line.startsWith(BLOCKED_MARK)) return 'blocked';
    if (line.startsWith(DONE_MARK)) return 'done';
  }
  return 'unclaimed';
}

/** 摘要里剥掉首行的声明标记：界面另标状态，正文不必再念一遍「[完成]」 */
export function stripClaimMark(finalText) {
  return String(finalText ?? '').replace(/^\s*(\[完成\]|\[受阻\])\s*/, '');
}

/**
 * 摘要用：把**开头或结尾**的声明标记行剥掉（保留同行原因）。
 * 2026-11-09 P5 后问答题把 `[完成]` 放末行，单独 `stripClaimMark` 只剥首行，摘要尾巴会多一行标记。
 */
export function stripClaimMarks(finalText) {
  const lines = String(finalText ?? '').split('\n');
  const nonEmpty = lines.reduce((acc, l, i) => (l.trim() ? [...acc, i] : acc), []);
  if (!nonEmpty.length) return '';
  const first = nonEmpty[0];
  const last = nonEmpty[nonEmpty.length - 1];
  lines[first] = lines[first].replace(/^\s*\[(?:完成|受阻)\]\s*/, '');
  if (first !== last) {
    // 末行：纯标记整行去掉；标记+原因则剥掉标记保留原因
    if (/^\s*\[(?:完成|受阻)\]\s*$/.test(lines[last])) lines[last] = '';
    else lines[last] = lines[last].replace(/^\s*\[(?:完成|受阻)\]\s*/, '');
  }
  return lines.join('\n').trim();
}

/**
 * 受阻原因：`[受阻]` 在第一行或最后一行都认，返回标记后面那句话（其余情况返回 ''）。
 * 2026-11-09 P5：问答题把标记放末行时，卡描述/回执里的"原因"要取末行那段，不能拿答案首行充数。
 */
export function blockedReasonOf(finalText) {
  const lines = String(finalText ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of [lines[0], lines.at(-1)]) {
    if (line && line.startsWith(BLOCKED_MARK)) return line.slice(BLOCKED_MARK.length).trim();
  }
  return '';
}

/**
 * 去掉**最后一行**单独的 `[完成]`（P5：问答类把交付标记放最后一行，别让雇主读到尾巴）。
 * 只剥"整行就是标记"；行里还带正文不剥（那是正文在提"完成"）。`[受阻]` 保留 ——
 * 它后面跟着原因，是给人看的。
 */
export function stripTrailingDoneMark(finalText) {
  return String(finalText ?? '').replace(/(?:\r?\n)[ \t]*\[完成\][ \t]*(?:\r?\n)*$/, '');
}
