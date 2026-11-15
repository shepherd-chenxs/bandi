/*
 * secret-paths.mjs —— 「这文件像不像凭据」的**唯一一份**判据（名字初筛 + 内容扫描）。
 *
 * 为什么单独立成纯模块（2026-11-13）：同一条规则现在有两个执行者 ——
 *   · 平台：`git-repos.commitAll / commitAndPush` 在提交前挡（人点「提交」/「建 PR」那条路）；
 *   · agent 的 pre-push 钩子：数字员工自己有 git 能力之后，推之前也得挡（git-hooks/pre-push.mjs）。
 * 钩子是独立进程、不能 import 会开数据库的大模块，所以规则必须住在一个**没有副作用**的文件里。
 * 两处各抄一份正则 = 迟早一边松一边紧，这条铁律（推上去收不回来）最不能出这种事。
 *
 * v2（2026-11-13 实报）：`secret-paths.mjs` 自己被自己的名字判据拦下了 —— 判据代码长着
 * 一张"凭据脸"（名字里带 secret），流程卡在「提交 PR」等人处理。教训：文件名只能说明
 * "像"，说明不了"是"，光看名字必然把自家判据代码、token-bucket.mjs 这种正经文件全喊来。
 * 所以分两档，让平台自己消化掉"像"，只把"是"端给人：
 *   · **实锤档**（keyfile）：.env 本体 / .p12 / .pfx / .key / .kdbx / .keystore / id_rsa 一族 /
 *     .npmrc / .netrc —— 按约定就该是凭据，直接拦，不问"要不要提交"、没有放行口令；
 *   · **像凭据档**（wordy）：名字带 token/secret/credential/… 的普通文件、以及 .pem
 *     （证书和私钥共用扩展名，只有内容分得清）—— **内容说了算**：扫一遍密钥特征，
 *     干净就自动放行（平台在结果里留一句备注，用户无感），扫出实锤才拦。
 * 测试豁免位（tests?/fixtures?/*.test.* …）与模板名（.env.example 等）两档都认 ——
 * 拦它们等于逼人绕开平台（gitleaks 也给测试假密钥让路）。
 *
 * `.github/workflows/` 在这条里**不算**凭据 —— 那是正常改动（那是 pr-review 的 SENSITIVE_RE 管的）。
 */

/** 模板类放过：`.env.example` 是要提交的东西 */
const SECRET_EXEMPT_RE = /\.(example|sample|template|dist|txt|md)$/i;

/** 实锤档：内容也救不了它 —— 扫得再干净也不该以这个名字进仓库 */
const KEYFILE_PATH_RE =
  /(^|\/)\.env(\.|$)|\.(p12|pfx|key|kdbx|keystore)$|(^|\/)(id_rsa|id_ecdsa|id_ed25519|\.npmrc|\.netrc)(\.|$)/i;

/** 像凭据档：名字像，内容说了算 */
const WORDY_PATH_RE = /[\w.-]*(token|secret|credential|passwd|password)[\w.-]*$|\.(pem)$/i;

/** 测试豁免位：测试里的假密钥是**应该存在的**，拦它就是逼人把测试搬走 */
const TESTISH_PATH_RE =
  /(^|\/)(tests?|__tests__|fixtures?|testdata|spec|specs|snapshots?|mocks?|__mocks__)(\/|$)|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]*$/i;

/*
 * 内容特征（2026-11-13 v2）：高置信度才收 —— 这套结果的含义是"提交即泄露"，
 * 误报一次就是一次不必要的拦截。泛化那档（凭据赋值长随机串）只对"名字已经像凭据"
 * 的文件负责，不对全部改动扫（README 里的示例令牌不该被拦）。
 */
const SECRET_CONTENT_RES = [
  { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, why: '私钥块（PEM/OpenSSH 等）' },
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/, why: 'OpenAI 风格密钥（sk-…）' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{25,}\b/, why: 'GitHub 令牌（gh?_…）' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/, why: 'GitHub fine-grained 令牌' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, why: 'AWS 访问密钥（AKIA…）' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{15,}\b/, why: 'Slack 令牌（xox?-…）' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, why: 'Google API 密钥（AIza…）' },
  { re: /\b(?:api[_-]?key|secret|token|passwd|password)\b["']?\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{24,}/i, why: '疑似凭据的长随机串赋值' },
];

/** 这批路径里哪些像凭据（返回路径清单；空数组 = 干净）—— 名字初筛，平台与钩子共用的老接口 */
export function findSecretPaths(paths) {
  return (paths ?? [])
    .map((p) => String(p ?? ''))
    .filter((p) => p && (KEYFILE_PATH_RE.test(p) || WORDY_PATH_RE.test(p)) && !SECRET_EXEMPT_RE.test(p));
}

/**
 * 名字初筛后的两档分拣（空数组 = 这一档没有）：
 * `keyfiles` = 实锤档（内容也救不了，直接拦）；`wordy` = 像凭据档（内容说了算）。
 */
export function classifySecretSuspects(paths) {
  const list = (paths ?? []).map((p) => String(p ?? '')).filter((p) => p && !SECRET_EXEMPT_RE.test(p));
  const keyfiles = list.filter((p) => KEYFILE_PATH_RE.test(p));
  const keySet = new Set(keyfiles);
  const wordy = list.filter((p) => !keySet.has(p) && WORDY_PATH_RE.test(p));
  return { keyfiles, wordy };
}

/**
 * 内容扫描：这个文件的内容里有没有真实密钥的特征。返回命中原因（人话）或 null（干净）。
 * 模板名（.env.example 等）与测试豁免位里的假密钥直接算干净 —— 那是**应该存在**的东西。
 */
export function scanContentForSecrets(path, text) {
  const p = String(path ?? '');
  if (SECRET_EXEMPT_RE.test(p) || TESTISH_PATH_RE.test(p)) return null;
  const t = String(text ?? '');
  if (!t) return null;
  for (const { re, why } of SECRET_CONTENT_RES) if (re.test(t)) return why;
  return null;
}
