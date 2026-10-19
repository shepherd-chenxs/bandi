/**
 * 权限模式（沙箱）**跨运行时换算**。
 *
 * 为什么需要它：这个值挂在**员工**身上（`personas.sandbox`），而可选的取值是
 * **每个运行时族自己的词汇** —— Claude 那边叫 `bypassPermissions` / `acceptEdits` /
 * `default` / `plan`（对应 `--permission-mode`），Codex 那边叫 `danger-full-access` /
 * `workspace-write` / `read-only`（对应 `-c sandbox_mode=`）。
 *
 * 于是"在 Claude 上配好的员工，把运行时改成 Codex"就会把这个值原样带过去，
 * Codex 读配置时直接报错退出（2026-10-17 实报）：
 *   `Error loading config.toml: unknown variant 'bypassPermissions',
 *    expected one of 'read-only', 'workspace-write', 'danger-full-access' in 'sandbox_mode'`
 *
 * 换算是**语义对齐**，不是"挑个能跑的"：
 *   · bypassPermissions（不问就干） ↔ danger-full-access（无沙箱）
 *   · acceptEdits（自动接受编辑）   ↔ workspace-write（只能写工作区）
 *   · default（动手前先问 / 只读为主）→ workspace-write；反过来 workspace-write → acceptEdits
 *   · plan（只规划不动手）           ↔ read-only
 *
 * `default` 落到 workspace-write 而不是 danger-full-access：宁可把权限收小、
 * 让人发现"跑不动命令"再显式放开，也不要**悄悄**把一个"会先问一声"的配置
 * 变成"什么都不问"。降权出错看得见，提权出错看不见。
 */

const SANDBOX_MAP = {
  // Claude 的词 → Codex 的词
  codex: {
    bypassPermissions: 'danger-full-access',
    acceptEdits: 'workspace-write',
    default: 'workspace-write',
    plan: 'read-only',
  },
  // Codex 的词 → Claude 的词
  claude: {
    'danger-full-access': 'bypassPermissions',
    'workspace-write': 'acceptEdits',
    'read-only': 'plan',
  },
};

/**
 * 把 `value` 换算成 `family` 认得的写法。
 * 本来就是本族的写法、或没有映射关系的值，**原样返回** —— 这个函数不负责校验合法性，
 * 只负责"从别的族带过来的词"这一种情况。
 */
export function normalizeSandbox(family, value) {
  if (value == null || value === '') return value ?? null;
  const v = String(value);
  return SANDBOX_MAP[family]?.[v] ?? v;
}
