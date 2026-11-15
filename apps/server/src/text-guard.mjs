/*
 * text-guard.mjs —— 挡住「中文在到达服务端之前就被压成问号」的请求体（2026-11-12 实报）。
 *
 * 病根不在服务端，也不在库：**调用方**把带中文的 JSON 塞进命令行发送，shell 按 ASCII
 * （或系统本地代码页）编码 body，非 ASCII 字符一律换成一个 `?` —— 一个汉字一个问号，
 * ASCII 原样保留（所以 `yaojian-ui`、`temperature`、`thinkpad-p15` 都活着，只有中文成了
 * `??????`）。这跟"字节解错了"是两码事：那是 U+FFFD（�），还能看出原文残影；这里是
 * 编码时就被替换掉的，服务端拿到手**已经无从还原**。
 *
 * 实测那一轮（r-3469521d，2026-11-12 13:30）：贺韬在 PowerShell 5.1 里
 *   $body = @{ title = "部署爻鉴项目（…）" } | ConvertTo-Json
 *   Invoke-RestMethod -Uri … -Body $body        # ← 少了 -ContentType 'application/json; charset=utf-8'
 * PowerShell 5.1 默认按 ASCII 编 body，于是卡建成了、标题描述全是问号，谁都没收到错。
 *
 * 所以要**在服务端挡**：这种请求"看起来是成功的"——卡真的建出来了，只是没人看得懂，
 * 事后只能人工改。宁可 400 打回去，让调用方当场换写法重发（写进文件、按 UTF-8 原样上传）。
 *
 * 判据（宁可少拦，不要错杀正常英文）：
 *   · 出现 U+FFFD → 一定坏（没人会手打这个字符）；
 *   · 全串没有中日韩字符/全角标点，且
 *       - 半角问号 ≥ 3 个，或
 *       - 半角问号 ≥ 2 个且占了整串的三分之一以上（短标题 "??" 这种兜底）
 *     → 按"被打烂"处理。正常中文不可能一个汉字都没有；正常英文极少连着三个问号。
 */

/** 中日韩字符 + 全角标点：有它就不可能是"被打烂"的文本（打烂时它们全变成问号了） */
const CJK = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/;

/** 这段文字看起来是不是"中文被按 ASCII / 本地代码页编过"了 */
export function looksMangled(text) {
  const s = String(text ?? '');
  if (!s.trim()) return false;
  if (s.includes('\ufffd')) return true;
  if (CJK.test(s)) return false;
  const q = (s.match(/\?/g) ?? []).length;
  if (!q) return false;
  return q >= 3 || (q >= 2 && q * 2 >= s.length);
}

/** 给调用方（模型/人）的改法 —— 话必须能直接照抄，否则它只会再发一遍同样的错 */
const HOW_TO_FIX = [
  '改法：把 JSON **写进文件**再原样上传，别把中文塞进命令行参数 ——',
  '  · PowerShell：先把请求体写进 cards.json（无 BOM UTF-8），再用',
  "    Invoke-WebRequest -Uri \"$env:BANDI_CONTROL_URL/api/agent/cards/batch\" -Method POST -Headers @{ 'X-Bandi-Run-Token' = $env:BANDI_RUN_TOKEN; 'Content-Type' = 'application/json; charset=utf-8' } -InFile \"$env:TEMP\\cards.json\" -UseBasicParsing",
  '  · bash / git-bash：curl -s -X POST "$BANDI_CONTROL_URL/api/agent/cards/batch" -H "X-Bandi-Run-Token: $BANDI_RUN_TOKEN" -H "Content-Type: application/json" --data-binary @cards.json',
].join('\n');

/**
 * 一句话说清"哪儿坏了、为什么、怎么改"。
 * `action` 是这次本来要做的事（建卡 / 发言），拼进"所以这次没有××"里。
 */
export function mangledMessage(field, action = '建卡') {
  return `${field}里的中文在到达服务端之前就被压成「?」了 —— 调用方把带中文的 JSON 塞进命令行、`
    + '按 ASCII/本地代码页发了出去（一个汉字换一个问号，ASCII 原样保留），到这里已经无从还原，'
    + `所以这次**没有${action}**。\n${HOW_TO_FIX}`;
}

/** 不合格就抛（`code` 走 E2075；调用方照常翻成 400 + 信箱） */
export function assertReadableText(value, field, action = '建卡') {
  if (!looksMangled(value)) return;
  throw Object.assign(new Error(mangledMessage(field, action)), { code: 'E2075' });
}
