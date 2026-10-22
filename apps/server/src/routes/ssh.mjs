/* routes/ssh.mjs —— 2026-10-22 由 server.mjs 按域拆出，handler 逻辑原样搬运。
 * 主分发顺序（先匹配先赢）见 ../server.mjs 的 CHAIN。 */

import { sendJson, fail } from '../http.mjs';
import * as sshRegistry from '../ssh-registry.mjs';
import * as sshExec from '../ssh-exec.mjs';
import * as git from '../git-repos.mjs';

export async function handleSsh(req, res, url) {
  const one = /^\/api\/ssh\/servers\/([^/]+)$/.exec(url.pathname);
  const key = /^\/api\/ssh\/servers\/([^/]+)\/key$/.exec(url.pathname);
  const test = /^\/api\/ssh\/servers\/([^/]+)\/test$/.exec(url.pathname);

  if (req.method === 'DELETE' && one) {
    const r = sshRegistry.removeServer(decodeURIComponent(one[1]));
    if (!r.removed) return fail(res, 404, 'E2031', '登记表里没有这台机器');
    return sendJson(res, 200, { ...sshRegistry.publicServers(), removed: true, alias: r.alias });
  }

  /** 取公钥（只读 .pub）。没生成过就 exists:false + 一句提示，不报错 —— 界面要照常渲染 */
  if (req.method === 'GET' && key) {
    const alias = decodeURIComponent(key[1]);
    const s = sshRegistry.getServer(alias);
    if (!s) return fail(res, 404, 'E2032', '登记表里没有这台机器');
    const pub = sshExec.tryPublicKeyOf(s);
    if (!pub) {
      return sendJson(res, 200, {
        alias: s.alias,
        exists: false,
        public_key: '',
        fingerprint: '',
        guide: '',
        message: `「${s.alias}」还没生成密钥。点下面的按钮生成一对 ed25519；生成后把公钥贴到服务器上。`,
      });
    }
    return sendJson(res, 200, {
      alias: s.alias,
      exists: true,
      public_key: pub,
      fingerprint: sshExec.fingerprintOfPublicFile(`${sshExec.keyPathOf(s)}.pub`),
      // 可整段复制的交付指引，以及**给界面用的结构化步骤**（同一份文案，步骤是来源）
      guide: sshExec.buildGuide(s, pub),
      guide_steps: sshExec.buildGuideSteps(s, pub),
      message: '把下面这一整行贴到服务器的 ~/.ssh/authorized_keys（一行一把钥匙）；也可以直接照下面的步骤做。',
    });
  }

  /** 生成密钥对。**同名一律拒绝，绝不覆盖** —— 和桌面端（T-016）一个规矩 */
  if (req.method === 'POST' && key) {
    const alias = decodeURIComponent(key[1]);
    const s = sshRegistry.getServer(alias);
    if (!s) return fail(res, 404, 'E2033', '登记表里没有这台机器');
    try {
      const r = sshExec.generateKey(s);
      const guide = sshExec.buildGuide(s, r.publicKey);
      sshExec.assertNoCredentials(guide);          // 自检：指引里不许出现凭据正文
      return sendJson(res, 200, {
        alias: s.alias,
        exists: true,
        public_key: r.publicKey,
        fingerprint: r.fingerprint,
        guide,
        guide_steps: sshExec.buildGuideSteps(s, r.publicKey),
        private_path: r.keyPath,
        message: '生成好了。把下面这一整行贴到服务器的 ~/.ssh/authorized_keys（一行一把钥匙）；也可以直接照下面的步骤做。',
        warning: r.aclWarning,
      });
    } catch (e) {
      return fail(res, 400, 'E1036', String(e?.message ?? e));
    }
  }

  /** 连通性探测：真起一次 ssh，跑 hostname; whoami; uname -a */
  if (req.method === 'POST' && test) {
    const alias = decodeURIComponent(test[1]);
    const s = sshRegistry.getServer(alias);
    if (!s) return fail(res, 404, 'E2034', '登记表里没有这台机器');
    const r = await sshExec.testConnection(s);
    return sendJson(res, 200, { alias: s.alias, ok: r.ok, detail: r.detail, fingerprint: r.fingerprint });
  }

  return false;
}

/*
 * **代码托管**（GitHub 仓库接入，2026-10-17）。
 *
 * 令牌只在 git-repos.mjs 里读写，这里**从不回显完整令牌**（只给后 4 位）。
 * 克隆/拉取是**异步子进程**（不 spawnSync）—— 大仓库克隆时控制面不能整台卡住。
 */
