/**
 * 「服务器与密钥」界面插件的后端：**生成密钥对** 与 **连通性探测**。
 *
 * 定位说明：这是**插件自己**的后端，服务于 `GET/POST /api/ssh/servers/:alias/key`
 * 和 `POST /api/ssh/servers/:alias/test` 这几个给界面用的接口。
 * MCP 那条连接器（mcp/bandi-ssh.mjs）**有它自己的一份 sshRun**，两边不共享 ——
 * 它们是两个面：一个给数字员工用，一个给人点。桌面版已废弃，不存在"三方同步"的诉求。
 *
 * 密钥生成走**系统 ssh-keygen**（和用系统 ssh 一个道理），不自造 OpenSSH 格式：
 * 自造要么拉依赖，要么手写 openssh-key-v1 容器，出错面大得多。
 *
 * 私钥内容**永不读、永不回显**：这里只把路径交给 ssh，读文件的地方只有 .pub。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { expandHome } from './ssh-registry.mjs';

export const TIMEOUT_MS = Number(process.env.BANDI_SSH_TIMEOUT_MS) || 30000;
const STRICT = process.env.BANDI_SSH_STRICT || 'accept-new';

/**
 * 连通性探测命令：**输出带 key=**，这样界面能贴上中文标签。
 *
 * 原来跑的是 `hostname; whoami; uname -a` —— 三行裸输出，谁是谁只能靠位置猜，
 * 用户看到的就是三行没头没尾的字符串。改成 key=value 解析，标签由界面给。
 * 别在这里塞中文：命令串要走 ssh 到远端 shell，ASCII 最稳。
 */
export const SSH_TEST_COMMAND = 'echo "host=$(hostname)"; echo "user=$(whoami)"; echo "kernel=$(uname -sr)"';

/** ssh 可执行文件：优先环境变量，其次系统 OpenSSH（Windows 上不在 PATH 也能到） */
export function sshBin() {
  if (process.env.BANDI_SSH_BIN) return expandHome(process.env.BANDI_SSH_BIN);
  const win = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
  return process.platform === 'win32' && fs.existsSync(win) ? win : 'ssh';
}

/** ssh-keygen：跟 ssh 挨着放，同一个目录里挑 */
export function sshKeygenBin() {
  if (process.env.BANDI_SSH_KEYGEN_BIN) return expandHome(process.env.BANDI_SSH_KEYGEN_BIN);
  const win = 'C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe';
  if (process.platform === 'win32' && fs.existsSync(win)) return win;
  const beside = path.join(path.dirname(sshBin()), 'ssh-keygen');
  return fs.existsSync(beside) ? beside : 'ssh-keygen';
}

export const keyPathOf = (entry) => expandHome(entry.key_path || `~/.ssh/${entry.alias}`);

/** 公钥文件在不在（登记表里没写 key_path 也能判断） */
export function keyExists(entry) {
  const k = keyPathOf(entry);
  return [k, `${k}.pub`].some((p) => fs.existsSync(p));
}

/**
 * 读公钥全文。找不到就抛（MCP 那边要报错）。
 * 注意：`keyPath` 可能指私钥，所以两个候选都试，**只认 ssh-/ecdsa- 开头的内容**。
 */
export function publicKeyOf(entry) {
  const keyPath = keyPathOf(entry);
  for (const candidate of [`${keyPath}.pub`, keyPath]) {
    if (!fs.existsSync(candidate)) continue;
    const text = fs.readFileSync(candidate, 'utf8').trim();
    if (text.startsWith('ssh-') || text.startsWith('ecdsa-')) return text;
  }
  throw new Error(`找不到公钥文件：${keyPath}.pub`);
}

/** 给界面用的版本：没有就返回 null，不抛 */
export function tryPublicKeyOf(entry) {
  try {
    return publicKeyOf(entry);
  } catch {
    return null;
  }
}

/**
 * 真起一次 ssh。BatchMode=yes 很关键：没配好的话它**立刻失败**，而不是挂在口令提示上等超时。
 */
export function sshRun(entry, command, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const args = [
      '-i', keyPathOf(entry),
      '-p', String(entry.port || 22),
      '-o', 'BatchMode=yes',
      '-o', `StrictHostKeyChecking=${STRICT}`,
      '-o', `ConnectTimeout=${Math.max(3, Math.round(timeoutMs / 1000))}`,
      `${entry.user}@${entry.host}`,
      '--',
      command,
    ];
    const child = spawn(sshBin(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* 已退 */ }
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, code: null, out, err, error: `${Math.round(timeoutMs / 1000)}s 没连上` }),
      timeoutMs + 5000,
    );

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', (e) => finish({ ok: false, code: null, out, err, error: `起不来：${e.message}` }));
    child.on('close', (code) => {
      const text = (err + out).slice(0, 4000);
      finish({
        ok: code === 0,
        code,
        out: out.trim(),
        err: err.trim(),
        error: code === 0 ? null : text || `ssh 退出码 ${code}`,
      });
    });
  });
}

/**
 * 纯函数：拿本地指纹和远端 `ssh-keygen -lf` 的输出，判断核对结果。
 *
 * 抽成纯函数是为了**能测**：三条分支（对上 / 对不上 / 读不到）不必碰真实服务器就能全跑一遍。
 * 不然"对不上"这条最有价值的分支，只能靠把私钥拷来拷去来构造 —— 那种测试不如不做。
 *
 * **指纹本身不往界面上贴**：结论（通过/不通过）才是用户要看的。
 * 不通过时给出的是"哪里不对、可能为什么"，而不是两串哈希让他自己比。
 */
export function fingerprintVerdict(local, remoteOut) {
  const out = String(remoteOut ?? '');
  if (!out.trim() || out.includes('__NO_FP__')) {
    return { state: 'unknown', line: '🔑 指纹核对：跳过（读不到服务器的 authorized_keys，或那边没有 ssh-keygen）' };
  }
  if (!local) {
    return { state: 'unknown', line: '🔑 指纹核对：跳过（本地没有 .pub，取不到本机指纹）' };
  }

  const remote = [...out.matchAll(/SHA256:[A-Za-z0-9+/=]+/g)].map((m) => m[0]);
  if (remote.includes(local)) return { state: 'match', line: '🔑 指纹核对：通过' };

  return {
    state: 'mismatch',
    line: [
      '🔑 指纹核对：不通过',
      '   服务器的 authorized_keys 里没有这把钥匙 —— 这次登录用的是**另一把**已授权的钥匙，',
      '   刚装的这把并没生效。常见原因：装到了别的账号下 / sshd 有 AllowUsers 限制 / 贴的时候串行了。',
    ].join('\n'),
  };
}

/**
 * 连上之后，把服务器 authorized_keys 里的指纹和**本地这把钥匙**的指纹比一下。
 *
 * 为什么值得单独做一步：**连上了 ≠ 装对了**。
 * 这台机器上可能早就有别的钥匙已经授权，ssh 用那把就登进去了 —— 看起来一切正常，
 * 实际新装的那把根本没生效。把指纹对上，才能确认"用的就是我刚装的那把"。
 * （这正是桌面版指引第 4 步让用户肉眼做的事，这里替他办了。）
 */
async function checkRemoteFingerprint(entry, timeoutMs) {
  let local = '';
  try {
    local = fingerprintOfPublicFile(`${keyPathOf(entry)}.pub`);
  } catch { /* 没 .pub 就取不到，verdict 里会跳过 */ }

  // 远端只读一条命令；没有 ssh-keygen 或读不到文件时给个记号，别让整次测试失败
  const r = await sshRun(
    entry,
    'ssh-keygen -lf ~/.ssh/authorized_keys 2>/dev/null || echo __NO_FP__',
    timeoutMs,
  );
  return fingerprintVerdict(local, r.out);
}

/** 跑一次连通性探测 + 指纹核对，把结果整理成一段人能看的话 */
export async function testConnection(entry, timeoutMs = TIMEOUT_MS) {
  const r = await sshRun(entry, SSH_TEST_COMMAND, timeoutMs);
  const where = `${entry.user}@${entry.host}:${entry.port || 22}`;
  if (!r.ok) {
    return {
      ok: false,
      fingerprint: null,
      detail: [
        `❌ 连不上（${where}）`,
        r.out ? `输出：\n${r.out}` : '',
        `错误：${r.error ?? r.err ?? '未知'}`,
        '',
        '常见原因：公钥没装到服务器 / 私钥路径不对 / 端口或安全组没开 / 首次连接的主机指纹没接受。',
      ].filter(Boolean).join('\n'),
    };
  }

  const fp = await checkRemoteFingerprint(entry, timeoutMs);

  // 把 key=value 解析成**带标签的事实**：裸输出（三行字符串）用户看不懂谁是谁
  const kv = {};
  for (const line of (r.out ?? '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const facts = [
    kv.host ? `主机名：${kv.host}` : '',
    kv.user ? `登录用户：${kv.user}` : '',
    kv.kernel ? `系统：${kv.kernel}` : '',
  ].filter(Boolean);
  // 解析不出来（换了 sshd、命令被拦）就把原始输出摊出来，别把信息吞掉
  if (!facts.length && r.out) facts.push(r.out);

  return {
    ok: true,
    fingerprint: fp.state,
    detail: [`✅ 连上了 ${where}`, '', ...facts, '', fp.line].join('\n'),
  };
}

/** `SHA256:...`，直接问 ssh-keygen 要，保证和 `ssh-keygen -lf` 一字不差 */
export function fingerprintOfPublicFile(pubPath) {
  const r = spawnSync(sshKeygenBin(), ['-lf', pubPath], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return '';
  // 输出形如：256 SHA256:xxxx comment (ED25519)
  return (r.stdout || '').trim().split(/\s+/)[1] ?? '';
}

/**
 * 公钥交付指引的**结构化步骤**（从桌面版 `guide.rs` 移植，拆成步骤给界面用）。
 *
 * 这是**唯一的事实来源**：纯文本版 `buildGuide()` 由它拼出来 ——
 * 两处各写一遍文案，改了一边忘了另一边，用户就会照着一份过时的说明操作。
 *
 * 规矩（照抄桌面版，这三条是有意的约束，不是文案风格）：
 *   · 程序**不自己连服务器写公钥、不收服务器口令**，界面上没有口令输入框；
 *   · 占位符（账号、公钥）**生成时就替换成这台服务器的真实值**，复制下来不用改；
 *   · 指引里**不含任何凭据**：没有私钥、没有口令、没有 PEM 段落。公钥是公开信息，可以出现。
 *
 * ⚠️ **顺序不能乱**（这一版修的就是这个）：建账号这件事**必须在目标服务器上做**，
 *    而能在那台机器上执行命令的前提是"你已经登进去了"。所以第 1 步是**用你现有的账号登录**，
 *    建运维账号是第 2 步。原来第 1 步写成 `ssh <运维账号>@主机`，那是**死循环** ——
 *    账号还不存在、公钥还没装，这条命令必然失败（用户实报）。
 *    同理第 3 步不能用 `~`：那时候登的是管理账号，`~` 是**它**的家目录，不是运维账号的。
 */
export function buildGuideSteps(entry, publicKey) {
  const port = entry.port || 22;
  const target = port === 22 ? `${entry.user}@${entry.host}` : `${entry.user}@${entry.host} -p ${port}`;
  const asRoot = port === 22 ? `root@${entry.host}` : `root@${entry.host} -p ${port}`;
  // useradd -m 的家目录。第 3 步要写绝对路径，理由见上面的注释
  const home = `/home/${entry.user}`;
  return [
    {
      where: '本机',
      title: '用你现有的账号登录目标服务器',
      note: '用你有 sudo 权限的那个账号（新买的机器通常就是 root）。不是 root，就把命令里的 root 换成它。',
      command: `ssh ${asRoot}`,
    },
    {
      where: '服务器',
      title: `建运维账号 ${entry.user}`,
      note: '在刚登录的那个终端里执行，不用另开一个。已经建好就跳过这一步；当前是 root 就直接执行，否则前面加 sudo。',
      command: `useradd -m -s /bin/bash ${entry.user}`,
    },
    {
      where: '服务器',
      title: `把公钥装进 ${entry.user} 的 authorized_keys`,
      note: `公钥已是这台机器的实际公钥，不用改。注意路径写的是 ${home}/… 而不是 ~ —— 你现在登的是管理账号，~ 是它的家目录。`,
      command: [
        `mkdir -p ${home}/.ssh`,
        `chmod 700 ${home}/.ssh`,
        `echo '${publicKey}' >> ${home}/.ssh/authorized_keys`,
        `chmod 600 ${home}/.ssh/authorized_keys`,
        `chown -R ${entry.user}:${entry.user} ${home}/.ssh`,
      ].join('\n'),
    },
    {
      where: '服务器',
      title: '核对属主、权限和指纹',
      note: `属主必须是 ${entry.user}；家目录 755 或 750、.ssh 700、authorized_keys 600。第二行回执的指纹要和界面上那把钥匙一致，不一致说明贴错了公钥，回第 3 步重来。`,
      command: `ls -ld ${home} ${home}/.ssh ${home}/.ssh/authorized_keys\nssh-keygen -lf ${home}/.ssh/authorized_keys`,
    },
    {
      where: '本机',
      title: '验证免密登录',
      note: '新开一个终端（别用刚才那个会话）。第一次会问 yes 确认主机指纹；能直接进去就说明装好了。还要口令，就回第 3 步。',
      command: `ssh ${target}`,
    },
  ];
}

/**
 * 纯文本版（MCP 风格的整段指引）：**由步骤拼出来**，别另写一遍文案。
 * `#` 是 **shell 注释**（不是 markdown）—— 注释和命令混在一起，整段贴进终端也不会出错。
 */
export function buildGuide(entry, publicKey) {
  const port = entry.port || 22;
  const target = port === 22 ? `${entry.user}@${entry.host}` : `${entry.user}@${entry.host} -p ${port}`;
  const out = [
    `# ===== 把公钥装到服务器 ${entry.alias}（${target}）=====`,
    '# 这几步有的在你本机、有的在服务器上，每一步都标了在哪执行 —— 别从头到尾都在同一个终端里敲。',
    '# 班底不收口令、不自己写公钥。',
    "# 公钥（就是 <<'EOF' 与 EOF 之间的那一行，已是这台服务器的实际公钥，不用改）：",
    '',
  ];
  buildGuideSteps(entry, publicKey).forEach((s, i) => {
    // 标出**在哪台机器上执行** —— 这几步一半在本机、一半在服务器上，
    // 不标的话用户只能从命令猜（原来就是因此把顺序看错的）。
    out.push(`# —— 第 ${i + 1} 步（在${s.where ?? '本机'}执行）：${s.title} ——`);
    if (s.note) out.push(...String(s.note).split('\n').map((l) => `#     ${l}`));
    out.push(s.command, '');
  });
  out.push('# 做完回班底，点这台机器的「测」验一次。');
  return out.join('\n');
}

/**
 * 指引生成后自检一遍（防回归）—— 桌面版就有这道检查，一并移植。
 * 查的是**凭据正文**，不是"口令"这两个字：说明文案里写「不收口令」是正常的。
 */
export function assertNoCredentials(text) {
  const FORBIDDEN = ['PRIVATE KEY', 'BEGIN OPENSSH', 'BEGIN RSA', 'ssh-ed25519-private'];
  for (const needle of FORBIDDEN) {
    if (String(text).includes(needle)) throw new Error(`指引里出现了不该有的内容：${needle}`);
  }
  return true;
}

/** Windows 上收紧 ACL：去掉继承来的条目，只留当前用户。
 * 不是洁癖 —— **Windows OpenSSH 会因为私钥被别人可读而拒绝加载**。
 * 规矩和桌面端（T-016）一致：`icacls <path> /inheritance:r /grant:r "<user>:(F)"`。
 */
function tightenAcl(target) {
  if (process.platform !== 'win32') return { ok: true };
  const user = process.env.USERNAME;
  if (!user) return { ok: false, error: '取不到用户名（环境变量 USERNAME 不存在）' };
  const r = spawnSync('icacls', [target, '/inheritance:r', '/grant:r', `${user}:(F)`], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0) return { ok: false, error: (r.stderr || '').trim() || `icacls 退出码 ${r.status}` };
  return { ok: true };
}

/**
 * 生成 ed25519 密钥对。**同名一律拒绝，绝不静默覆盖**（和桌面端一个规矩）。
 * 返回公钥全文与指纹；**私钥内容不返回**，只返回路径。
 */
export function generateKey(entry) {
  const keyPath = keyPathOf(entry);
  const pubPath = `${keyPath}.pub`;

  const existing = [keyPath, pubPath].filter((p) => fs.existsSync(p));
  if (existing.length) {
    throw new Error(
      `拒绝生成：${existing.join(' 与 ')} 已经存在。同名文件不覆盖，请先改名或删掉再生成。`,
    );
  }

  fs.mkdirSync(path.dirname(keyPath), { recursive: true });

  // 公钥注释 = `<别名>@<本机主机名>`：同一台服务器可能被多台机器贴过公钥，
  // 注释让人一眼分清哪行是哪台机器贴的。注释不参与认证。
  const comment = `${entry.alias}@${os.hostname()}`;
  const r = spawnSync(
    sshKeygenBin(),
    ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', comment, '-q'],
    { encoding: 'utf8', windowsHide: true },
  );
  if (r.error) throw new Error(`起不来 ssh-keygen：${r.error.message}`);
  if (r.status !== 0) throw new Error(`ssh-keygen 失败：${(r.stderr || '').trim() || `退出码 ${r.status}`}`);

  const acl = tightenAcl(keyPath);
  if (acl.ok) tightenAcl(pubPath);

  return {
    keyPath,
    pubPath,
    publicKey: fs.readFileSync(pubPath, 'utf8').trim(),
    fingerprint: fingerprintOfPublicFile(pubPath),
    aclWarning: acl.ok ? null : `文件权限没收紧成功（${acl.error}）—— 某些环境下 ssh 会因此拒绝这把钥匙`,
  };
}
