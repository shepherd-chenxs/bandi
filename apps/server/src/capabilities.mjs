/**
 * **能力清单**：平台「能做什么」的唯一事实源（2026-11-19）。
 *
 * 由来（实报 r-3e67b107）：注入给模型的台账句写着「要查全部卡用运行钥匙调
 * GET /api/tasks」—— 那段话是手写的，没给基址、没给请求头，而运行说明里又只提了
 * 钥匙变量名。模型信了这句话，连试 6 次命令都找不到入口，45.6 秒里 34 秒花在这上面；
 * 最后它把第一轮就已经想对的答案原样说了第二遍。
 *
 * 所以这里立两条规矩，改动这层时别破：
 *
 *   ① **能力清单从真源生成** —— 能调什么 = `security/route-policy.mjs` 里 `run: true`
 *      的条目，怎么调 = 同一行的 `call`。改路由文案自动跟着变，不会出现"说了做不到"。
 *   ② **凡写"可以调 X"，必须同时写"怎么调"**（基址变量 + 请求头），否则那句话就是
 *      不可执行指令。宁可什么都不写（模型答"台账里就是这些"），也不要写半句。
 *
 * 反例留档：`- 你的任务台账：当前没有未完的卡（要查全部卡用运行钥匙调 GET /api/tasks）`
 * 就是第 ② 条的反面教材 —— 它没有出现在这里，而是被删掉了；台账句只讲状态，不讲路径。
 */
import { ROUTES } from './security/route-policy.mjs';

/** 平台基址：运行态注入到子进程环境里（runs.mjs 的 agentEnv），不是配置文件 */
export const CONTROL_URL_ENV = 'BANDI_CONTROL_URL';
/** 每轮现发的运行钥匙（收尾吊销），同样走环境变量 */
export const RUN_TOKEN_ENV = 'BANDI_RUN_TOKEN';
/** 调平台接口时带这个头 */
export const RUN_TOKEN_HEADER = 'X-Bandi-Run-Token';

/**
 * 运行钥匙能调的接口。**只读 route-policy**，这里不新增任何路径 ——
 * 新增一条能力 = 在 ROUTES 里加 `run: true` + `call`，两处不会再漂。
 */
export function runTokenCalls() {
  return ROUTES.filter((r) => r.run && r.call).map((r) => ({
    id: r.id,
    call: r.call,
    // note 是给人看的注释，可能很长；取前 40 字够模型判断"这条能不能满足我"
    note: briefNote(r.note),
  }));
}

/**
 * note → 一行用途。路线上的 note 是**给维护者看的**（为什么开这条、谁在用），
 * 直接把第一句搬给模型会出现"运行钥匙可读 × 4"这种零信息。
 *
 * 取法：括号里的正文优先（写 note 的人把真用途写在括号里，例如「（秘书台账：全部任务卡）」），
 * 前缀是"运行钥匙可读/可达"这类废话时尤其如此；否则取第一个分句。
 */
function briefNote(note) {
  const s = String(note ?? '').trim();
  if (!s) return '';
  const clip = (t) => (t.length > 40 ? `${t.slice(0, 40)}…` : t);
  const m = s.match(/^(.*?)[（(]([^）)]+)[）)]/);
  if (m && m[1].trim().length <= 10) return clip(m[2].trim());
  return clip((m ? m[1] : s).split(/[；;。]/)[0].trim());
}

/**
 * 运行钥匙的说明块（原来手写在 runs.mjs 的 runCredentialBrief 里）。
 *
 * 保留原来的三条硬信息：钥匙每轮现发、别抄历史里的旧值、两个错误码的含义 ——
 * 那三条是踩过坑的（贺韬抄旧钥匙 → 每轮 401 E2056，判断成"通道没恢复"）。
 */
export function runCredentialBrief({ pm = false } = {}) {
  const calls = runTokenCalls();
  const lines = [
    `【平台接口 · 运行钥匙】基址在环境变量 \`${CONTROL_URL_ENV}\`，钥匙在 \`${RUN_TOKEN_ENV}\`（这次运行现发、收尾作废、每轮都换）：`,
    `调的时候现场取这两个变量（别抄历史命令里的旧值），请求头 \`${RUN_TOKEN_HEADER}\`。`,
    `两个变量**已经注入你的进程**，不必先 echo 验证、直接拼进命令；取到空值基本都是 shell 语法不对（PowerShell 要 \`$env:NAME\`，bash/curl 是 \`$NAME\`）。`,
    `Windows 下最省事的一条（PowerShell 里没有 \`| head\`，\`curl\` 是别名，拿 JSON 用 Invoke-RestMethod）：\`Invoke-RestMethod -Uri "$env:${CONTROL_URL_ENV}/api/tasks" -Headers @{'${RUN_TOKEN_HEADER}'=$env:${RUN_TOKEN_ENV}}\``,
    `\`401 E2056\` = 旧/错钥匙（重取一次重试，不是权限问题）；\`403 E4034\` = 这个接口不归运行钥匙管。`,
  ];
  if (calls.length) {
    lines.push(`能调的只有下面这几条 —— **清单之外的一律不存在，别猜路径**：`);
    for (const c of calls) lines.push(`  · \`${c.call}\`${c.note ? ` —— ${c.note}` : ''}`);
  }
  if (pm) {
    lines.push(
      '建卡走 `POST /api/agent/cards/batch`：体 `{cards:[…]}`、裸数组、单张卡都认；项目可省略（群派活默认用群关联项目）；失败先读 `{code,error}` 按提示改，**最多 2 次**，别整批重发；2 次仍失败就按【统筹职责】降级（群里 @ 人 + 报群主），不许自己写代码。',
      '补卡（补记已经发生的活）：同接口带 `"backfill": true` + 实际状态的**码**（`review` 待验收 / `blocked` 已阻塞 / `done` 已完成 / `cancelled` 已取消 / `failed` 失败），补记不重跑；改卡走 `PATCH /api/projects/tasks/<id>`（只对你建的卡 / 你当群助手那张）。状态**只收码**，写中文会 400。',
    );
  }
  return lines.join('\n');
}
