/**
 * 「建 PR / 列 open PR / 手动合并」的离线验收（2026-10-25）。
 *
 * 这条链路每一步都在打 GitHub，而班底的冒烟铁律是**不联网、不要令牌**
 * （`smoke-git-repos.mjs` 头注释；`tools/run-smokes.mjs` 把要真实 CLI 的单列进 SKIP）。
 * 所以这里把 GitHub 搬到本机：`fixtures/gh-mock.mjs` 起一个假件，`BANDI_GH_API` 指过去 ——
 * 于是「请求体字段写错、422 认不出来、拿旧 sha 去合」这类**只测纯函数永远抓不到**的错，会在这儿红。
 *
 * git 那一半用**真 git + 本地裸仓库当 origin**：`commitAndPush` 真的建分支、真的提交、真的推上去，
 * 断言直接读那个裸仓库（离线也能验推送，和 `smoke-git-repos.mjs` ④ 段同一个思路）。
 *
 * 跑法：node apps/server/src/smoke-pr-create.mjs
 * ⚠️ 前置条件与 `smoke-git-repos.mjs` 相同：本机得有 `git`。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bandi-prcreate-'));
/*
 * **把开发者本机的 git 配置隔掉**（2026-10-25，对齐 `docs/审阅经验.md` 第 1 条：
 * 测试不许依赖开发者本机状态）。不这么做的话，提交身份那一档断言会"本地绿、换台机器红"——
 * 因为开发者往往全局配了 `user.name/user.email`，平台那条"仓库没配身份才兜底"的分支
 * 在他机器上永远走不到，断言就成了永远为真的空话。
 */
const emptyGitConfig = path.join(tmp, 'gitconfig-empty');
fs.writeFileSync(emptyGitConfig, '');
process.env.GIT_CONFIG_GLOBAL = emptyGitConfig;
process.env.GIT_CONFIG_SYSTEM = emptyGitConfig;
const PORT = Number(process.env.SMOKE_PORT ?? 8896);
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
};

const req = async (p, opt = {}) => {
  const r = await fetch(BASE + p, { ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers ?? {}) } });
  const text = await r.text();
  let b = null;
  try {
    b = JSON.parse(text);
  } catch {
    /* 非 JSON 原样带着 */
  }
  return { status: r.status, b, text };
};

/** 本地 git 的同步调用。**只用来搭 fixture** —— 被测代码自己走异步 run()，别混一条路 */
const g = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 没成：${(r.stderr || r.stdout || '').trim()}`);
  return (r.stdout || '').trim();
};

/** 搭一个「本地裸仓库当 origin」的工作目录（已经推好 main，起点干净） */
const makeRepo = (name) => {
  const bare = path.join(tmp, `${name}-bare`);
  const work = path.join(tmp, `${name}-work`);
  fs.mkdirSync(bare, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  g(['init', '--bare', '-q', '-b', 'main', bare]);
  g(['init', '-q', '-b', 'main', work]);
  g(['-c', 'user.name=chu', '-c', 'user.email=chu@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'], work);
  g(['remote', 'add', 'origin', bare], work);
  g(['push', '-q', 'origin', 'main'], work);
  return { bare, work };
};

/* --------------------------------------------------- ① 纯函数：先把规矩钉住 */
console.log('\n① 纯函数：分支名 / 建议名 / 凭据闸 / status -z 解析');

/* ⚠️ BANDI_DATA / BANDI_DB / BANDI_GH_API 必须在 import 之前设好（config 与 git-repos 都在 import 时读） */
const mock = await import('./fixtures/gh-mock.mjs');
const gh = await mock.startGitHubMock();
process.env.BANDI_DATA = tmp;
process.env.BANDI_DB = path.join(tmp, 'bandi.db');
process.env.BANDI_GH_API = `http://127.0.0.1:${gh.port}`;

const git = await import('./git-repos.mjs');
const store = await import('./store.mjs');
const workflows = await import('./workflows.mjs');
const prCreate = await import('./pr-create.mjs');
const prReview = await import('./pr-review.mjs');

const rejected = (list) =>
  list.filter((b) => {
    try {
      git.assertBranchName(b);
      return false;
    } catch {
      return true;
    }
  });
/* `a/b` 是**合法**分支名（feature/ok 就是这么写的），不能混进坏例子当反证 */
check('空格 / .. / 首尾点 / 保留名 / 空段都挡下来', rejected(['a b', 'a..b', '.x', 'x.', 'HEAD', 'x.lock', '/a', 'a/', 'a//b']).length === 9);
check('正常分支名放行', git.assertBranchName('feature/ok-2026') === 'feature/ok-2026');

/*
 * 分支命名规范（2026-10-30）：`<type>/<短描述>`。
 * 老默认名是 `bandi/<标题短串>-<时间戳>`，而"标题"常常是仓库名或纯中文 —— 软件自己生成
 * `bandi/bandi-20261029-125019`（前缀重复、没类型、没语义），历史里 4 次合并都叫这个。
 */
const rejectedNew = (list) =>
  list.filter((b) => {
    try {
      git.assertNewBranchName(b, { repoName: 'bandi' });
      return false;
    } catch {
      return true;
    }
  });
check('建议名 = <type>/<短描述>（英文标题）', git.suggestBranchName('给班底补建 PR v2', new Date('2026-10-25T17:22:03'), { repoName: 'bandi' }) === 'chore/pr-v2', git.suggestBranchName('给班底补建 PR v2', new Date('2026-10-25T17:22:03'), { repoName: 'bandi' }));
check('中文标题折不出短描述 → <type>/<时间戳>（不是空分支名）', /^fix\/20261025-090500$/.test(git.suggestBranchName('修复错字', new Date('2026-10-25T09:05:00'))), git.suggestBranchName('修复错字', new Date('2026-10-25T09:05:00')));
check('Conventional 前缀直接决定类型', git.suggestBranchName('fix(server): pr gate smoke') === 'fix/pr-gate-smoke', git.suggestBranchName('fix(server): pr gate smoke'));
check('短描述不许就是仓库名（老 bandi/bandi-<戳> 的病根）', /^chore\/\d{8}-\d{6}$/.test(git.suggestBranchName('bandi', new Date('2026-10-25T17:22:03'), { repoName: 'bandi' })), git.suggestBranchName('bandi', new Date('2026-10-25T17:22:03'), { repoName: 'bandi' }));
check('新分支名必须 <type>/<短描述>：老前缀 / 错拼 / 没类型 / 大写都拒', rejectedNew(['bandi/old-style', 'andi/x', 'test', '123', 'feat/', 'feat/Bad', 'feature/x']).length === 7);
check('合规的新分支名放行', ['fix/pr-gate-smoke', 'feat/a1', 'chore/20261030-125019', 'docs/readme', 'test/smoke'].every((b) => git.assertNewBranchName(b, { repoName: 'bandi' }) === b));
check('短描述等于仓库名 → 拒', rejectedNew(['chore/bandi']).length === 1);
check('「平台建的分支」= 老 bandi/ 或新 <type>/x（feature/x 是人的分支）', git.isPlatformBranchName('bandi/old') && git.isPlatformBranchName('fix/demo') && !git.isPlatformBranchName('feature/human') && !git.isPlatformBranchName('main'));
check('凭据闸抓住 .env / 私钥 / token 文件', JSON.stringify(git.findSecretPaths(['.env', 'id_rsa', 'a/b/token.json', 'k.pem'])) === '[".env","id_rsa","a/b/token.json","k.pem"]');
check('模板类放过（.env.example 本来就该提交）', JSON.stringify(git.findSecretPaths(['.env.example', 'config.sample.ts', 'README.md'])) === '[]');
check('status -z：带空格的路径不被切两半', JSON.stringify(git.parseStatusZ(' M src/a b.ts\0')) === '[{"status":" M","path":"src/a b.ts"}]');
check('status -z：重命名连着读（下一条是源路径）', JSON.stringify(git.parseStatusZ('R  new/n.ts\0old/n.ts\0?? x.md\0')) === '[{"status":"R ","path":"new/n.ts","from":"old/n.ts"},{"status":"??","path":"x.md"}]', JSON.stringify(git.parseStatusZ('R  new/n.ts\0old/n.ts\0?? x.md\0')));
check('status -z：**未暂存**重命名（` R`）也连着读源路径', JSON.stringify(git.parseStatusZ(' R b.txt\0a.txt\0')) === '[{"status":" R","path":"b.txt","from":"a.txt"}]', JSON.stringify(git.parseStatusZ(' R b.txt\0a.txt\0')));

/* --------------------------------------------------- ② 本地状态（不联网） */
console.log('\n② 接入 + 工作区状态：干净就说干净，脏了要列出脏的、并把凭据标出来');

const { bare, work } = makeRepo('main');
git.saveToken('ghp_smokepr1234abcd');
const row = (await git.connectRepo('smoke/demo', null, work)).repo;
check('接入用本地已有目录（没另建克隆）', row.localPath === work, row.localPath);
check('默认分支从元数据来（假 GitHub 给 main）', row.defaultBranch === 'main', String(row.defaultBranch));

let st = await git.workState(row);
check('干净工作区：dirtyCount 0、ahead 0、canShip=false', st.dirtyCount === 0 && st.ahead === 0 && st.canShip === false, JSON.stringify({ d: st.dirtyCount, a: st.ahead, c: st.canShip }));
check('报告当前分支与 base', st.branch === 'main' && st.base === 'main', `${st.branch}/${st.base}`);
check('给出建议分支名（`<type>/<短描述>`，规则只留服务端一处）', /^chore\/\d{8}-\d{6}$/.test(st.suggest), String(st.suggest));

fs.writeFileSync(path.join(work, 'feature.js'), 'export const x = 1;\n');
fs.writeFileSync(path.join(work, '.env'), 'API_KEY=***\n');
fs.mkdirSync(path.join(work, 'new dir'), { recursive: true });
fs.writeFileSync(path.join(work, 'new dir', 'note file.md'), 'hi\n');
st = await git.workState(row);
check('改完文件：dirtyCount=3（含未跟踪与带空格的路径）', st.dirtyCount === 3, JSON.stringify(st.dirty.map((f) => f.path)));
check('canShip 变 true', st.canShip === true);
check('凭据闸在状态里就报出来（让人点之前就看见）', JSON.stringify(st.secrets) === '[".env"]', JSON.stringify(st.secrets));

/*
 * **回归（2026-10-25 用户实报）**：工作区第一条改动是「 M」（已跟踪文件被改）时，
 * `git status -z` 的原始输出以空格开头；run() 默认 trim 会吃掉它，记录错位后
 * `slice(3)` 把路径首字母切掉（弹窗显示 `pps/server/...`，提交时 git add 报 pathspec 不存在）。
 * 这一档用"只有一条改动、且是已跟踪文件修改"的仓库来钉 —— 之前的用例第一条是 `?? .env`，
 * 不会以空格开头，所以一直没抓到。
 */
const trimRepo = makeRepo('trim');
fs.writeFileSync(path.join(trimRepo.work, 'base.txt'), 'v1\n');
g(['-C', trimRepo.work, 'add', 'base.txt'], trimRepo.work);
g(['-C', trimRepo.work, '-c', 'user.name=trim', '-c', 'user.email=trim@example.invalid', 'commit', '-q', '-m', 'base'], trimRepo.work);
g(['-C', trimRepo.work, 'push', '-q', 'origin', 'main'], trimRepo.work);
fs.writeFileSync(path.join(trimRepo.work, 'base.txt'), 'v2\n');
const trimRow = (await git.connectRepo('smoke/trim', null, trimRepo.work)).repo;
const trimState = await git.workState(trimRow);
check(
  '第一条改动是「 M」：路径没被吃掉首字母（apps 不该变 pps）',
  trimState.dirty[0]?.path === 'base.txt' && trimState.dirty[0]?.status === ' M',
  JSON.stringify(trimState.dirty),
);
check(
  '防御：上游就算 trim 了开头空格，parseStatusZ 也补回来',
  git.parseStatusZ('M apps/x.mjs\0')[0]?.path === 'apps/x.mjs',
  JSON.stringify(git.parseStatusZ('M apps/x.mjs\0')),
);
const trimShip = await git.commitAndPush(trimRow, { message: 'fix: 首条修改的路径解析' });
check('这条改动能真的提交推送（不再撞 pathspec 不存在）', trimShip.files.length === 1 && trimShip.files[0].path === 'base.txt', JSON.stringify(trimShip.files));

/* --------------------------------------------------- ③ 提交并推送（真 git） */
console.log('\n③ 提交并推送：先拦凭据、只提挑中的、只在新分支上、绝不强推');

let blocked = '';
try {
  await git.commitAndPush(row, { message: 'feat: 加一个功能' });
} catch (e) {
  blocked = e.message;
}
check('改动里有 .env → 拒绝推送，并说清为什么', /看着像凭据/.test(blocked) && /\.env/.test(blocked), blocked.slice(0, 70));
check('被拦下时没有产生提交（工作树还是那三个文件）', g(['-C', work, 'log', '--oneline'], work).split('\n').length === 1 && (await git.workState(row)).dirtyCount === 3);

const pushed = await git.commitAndPush(row, {
  message: 'feat: 加一个功能',
  branch: 'fix/feat-demo',
  paths: ['feature.js', 'new dir/note file.md'], // 不含 .env：只提挑中的那两个
});
check('推上去了：返回分支与 base', pushed.branch === 'fix/feat-demo' && pushed.base === 'main', JSON.stringify({ b: pushed.branch, base: pushed.base }));
check('裸仓库里真有了这条分支（推送确实发生）', g(['--git-dir', bare, 'rev-parse', '--verify', 'refs/heads/fix/feat-demo'], repoRoot).length === 40);
check('提交只含挑中的两个文件', g(['-C', work, 'show', '--name-only', '--format=', 'HEAD'], work).split('\n').filter(Boolean).length === 2, g(['-C', work, 'show', '--name-only', '--format=', 'HEAD'], work).replace(/\n/g, ' | '));
check('.env 还在工作区（没被 add -A 顺手带走）', (await git.workState(row)).dirty.some((f) => f.path === '.env'));
check('base 分支 main 没被动（改动只落在新分支上）', g(['--git-dir', bare, 'rev-list', '--count', 'refs/heads/main'], repoRoot) === '1');
/*
 * 提交身份兜底那一档：本机的全局 git 配置已经被 `GIT_CONFIG_GLOBAL` 隔掉（文件头），
 * 所以这里走的**确实**是"仓库没配身份 → 平台给一份"那条分支，而不是借开发者自己的身份混过去。
 */
check('仓库没配身份时平台兜底给作者（不依赖开发者本机配置）', g(['-C', work, 'log', '-1', '--format=%an <%ae>'], work) === 'bandi <bandi@localhost>', g(['-C', work, 'log', '-1', '--format=%an <%ae>'], work));
check('令牌没写进 .git/config（origin 仍是本地路径）', !fs.readFileSync(path.join(work, '.git', 'config'), 'utf8').includes('ghp_smokepr1234abcd'));

/* 撞名那一档单独用**第二个仓库**测：不污染上面那棵工作树 */
const two = makeRepo('clash');
const row2 = (await git.connectRepo('smoke/clash', null, two.work)).repo;
g(['-C', two.work, 'checkout', '-q', '-b', 'chore/dup'], two.work);
g(['-C', two.work, '-c', 'user.name=a', '-c', 'user.email=a@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'remote-side'], two.work);
g(['-C', two.work, 'push', '-q', '-u', 'origin', 'chore/dup'], two.work);
/* 本地这条改成"不含远端那次提交"的历史 → 再推就是 non-fast-forward */
g(['-C', two.work, 'checkout', '-q', '-B', 'chore/dup', 'main'], two.work);
g(['-C', two.work, '-c', 'user.name=b', '-c', 'user.email=b@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'local-side'], two.work);
let clashErr = '';
try {
  await git.commitAndPush(row2, { branch: 'chore/dup', message: '撞名' });
} catch (e) {
  clashErr = e.message;
}
check('远端同名分支历史不同 → 拒绝强推并把原因原样带回', /不会强推|换一个分支名/.test(clashErr), clashErr.slice(0, 90));
check('被拒时没有强推痕迹（远端那条还是 remote-side）', /remote-side/.test(g(['--git-dir', two.bare, 'log', '-1', '--format=%s', 'refs/heads/chore/dup'], repoRoot)));

/*
 * **回归（2026-10-25 用户实报）**：工作区里有**已暂存的重命名**（`git mv`）时，
 * 原来的 addTargets 会把旧路径也传给 `git add -A` —— 旧路径已经不在工作区，
 * git 直接 fatal `pathspec ... did not match any files`，整条建 PR 链断掉。
 * 同时覆盖已暂存的删除（`git rm`）与普通改动，确认三笔能一起提交。
 */
const rn = makeRepo('rename');
for (const [f, v] of [['a.txt', 'a'], ['c.txt', 'c'], ['d.txt', 'd']]) fs.writeFileSync(path.join(rn.work, f), v + '\n');
g(['-C', rn.work, 'add', '.'], rn.work);
g(['-C', rn.work, '-c', 'user.name=r', '-c', 'user.email=r@example.invalid', 'commit', '-q', '-m', 'files'], rn.work);
g(['-C', rn.work, 'push', '-q', 'origin', 'main'], rn.work);
g(['-C', rn.work, 'mv', 'a.txt', 'b.txt'], rn.work); // 已暂存 R
g(['-C', rn.work, 'rm', '-q', 'c.txt'], rn.work); // 已暂存 D
fs.writeFileSync(path.join(rn.work, 'd.txt'), 'd2\n'); // 未暂存 M
const rnRow = (await git.connectRepo('smoke/rename', null, rn.work)).repo;
const rnState = await git.workState(rnRow);
check(
  '工作区状态里认得出已暂存的重命名（path=b.txt，from=a.txt）',
  rnState.dirty.some((f) => f.path === 'b.txt' && f.from === 'a.txt'),
  JSON.stringify(rnState.dirty.filter((f) => f.path === 'b.txt' || f.from)),
);
let rnErr = '';
try {
  await git.commitAndPush(rnRow, { branch: 'fix/rename-case', message: 'rename+delete' });
} catch (e) {
  rnErr = e.message;
}
check('已暂存的重命名/删除 + 普通改动能一起提交（不再报 pathspec）', !rnErr, rnErr.slice(0, 100));
check('提交后工作区干净', g(['-C', rn.work, 'status', '--porcelain'], rn.work) === '');
const rnShow = g(['--git-dir', rn.bare, 'show', '--name-status', '-M', '--format=', 'refs/heads/fix/rename-case'], repoRoot);
check(
  '远端那条分支里真是 R + D + M 三笔（没有把重命名拆成"新增一份"）',
  /^R100\s+a\.txt\s+b\.txt/m.test(rnShow) && /^D\s+c\.txt/m.test(rnShow) && /^M\s+d\.txt/m.test(rnShow),
  rnShow.replace(/\n/g, ' | '),
);

/*
 * 反例的另一半：**未暂存**的重命名（`git mv` 后 reset + add -N，status 是 ` R`）。
 * 这一种旧路径必须一起 add，否则提交出来是"新增 b + 旧 a 还在"。
 */
const un = makeRepo('unstaged-rename');
fs.writeFileSync(path.join(un.work, 'a.txt'), 'a\n');
g(['-C', un.work, 'add', 'a.txt'], un.work);
g(['-C', un.work, '-c', 'user.name=u', '-c', 'user.email=u@example.invalid', 'commit', '-q', '-m', 'a'], un.work);
g(['-C', un.work, 'push', '-q', 'origin', 'main'], un.work);
g(['-C', un.work, 'mv', 'a.txt', 'b.txt'], un.work);
g(['-C', un.work, 'reset', '-q'], un.work);
g(['-C', un.work, 'add', '-N', 'b.txt'], un.work);
const unRow = (await git.connectRepo('smoke/unstaged-rename', null, un.work)).repo;
check(
  '未暂存的重命名（` R`）也带得出 from',
  (await git.workState(unRow)).dirty.some((f) => f.path === 'b.txt' && f.from === 'a.txt'),
  JSON.stringify((await git.workState(unRow)).dirty),
);
await git.commitAndPush(unRow, { branch: 'fix/unstaged-rename-case', message: 'unstaged rename' });
const unShow = g(['--git-dir', un.bare, 'show', '--name-status', '-M', '--format=', 'refs/heads/fix/unstaged-rename-case'], repoRoot);
check('未暂存的重命名提交后仍是 rename（不是"多一份 + 旧的还在"）', /^R100\s+a\.txt\s+b\.txt/m.test(unShow), unShow.replace(/\n/g, ' | '));

/*
 * **合并后的本地收尾**（2026-10-25，用户要求集成到平台）：
 * 切回 base → pull --ff-only → 删本地 `bandi/` 源分支；工作区脏就不动。
 * 这一段单独用两个小仓库钉，不依赖假 GitHub 的合并动作。
 */
const stl = makeRepo('settle');
fs.writeFileSync(path.join(stl.work, 'a.txt'), 'a\n');
g(['-C', stl.work, 'add', 'a.txt'], stl.work);
g(['-C', stl.work, '-c', 'user.name=s', '-c', 'user.email=s@example.invalid', 'commit', '-q', '-m', 'a'], stl.work);
g(['-C', stl.work, 'push', '-q', 'origin', 'main'], stl.work);
g(['-C', stl.work, 'checkout', '-q', '-b', 'bandi/settle-case'], stl.work);
fs.writeFileSync(path.join(stl.work, 'a.txt'), 'a2\n');
g(['-C', stl.work, '-c', 'user.name=s', '-c', 'user.email=s@example.invalid', 'commit', '-q', '-am', 'a2'], stl.work);
g(['-C', stl.work, 'push', '-q', '-u', 'origin', 'bandi/settle-case'], stl.work);
const stlSha = g(['-C', stl.work, 'rev-parse', 'HEAD'], stl.work);
await git.connectRepo('smoke/settle', null, stl.work);
const settled = await git.settleAfterMerge('smoke/settle', { base: 'main', head: 'bandi/settle-case', headSha: stlSha });
check(
  '合并后收尾：切回 main + 拉最新 + 删本地源分支',
  settled.settled === true && settled.switched === true && settled.pulled === true && settled.deleted === 'bandi/settle-case',
  JSON.stringify(settled),
);
check('本地当前分支真的回到 main', g(['-C', stl.work, 'branch', '--show-current'], stl.work) === 'main');
check(
  '本地源分支真没了',
  !g(['-C', stl.work, 'branch', '--format=%(refname:short)'], stl.work).split('\n').includes('bandi/settle-case'),
);

const stlDirty = makeRepo('settle-dirty');
fs.writeFileSync(path.join(stlDirty.work, 'a.txt'), 'a\n');
g(['-C', stlDirty.work, 'add', 'a.txt'], stlDirty.work);
g(['-C', stlDirty.work, '-c', 'user.name=s', '-c', 'user.email=s@example.invalid', 'commit', '-q', '-m', 'a'], stlDirty.work);
g(['-C', stlDirty.work, 'push', '-q', 'origin', 'main'], stlDirty.work);
g(['-C', stlDirty.work, 'checkout', '-q', '-b', 'bandi/dirty-case'], stlDirty.work);
fs.writeFileSync(path.join(stlDirty.work, 'a.txt'), 'a2\n');
g(['-C', stlDirty.work, '-c', 'user.name=s', '-c', 'user.email=s@example.invalid', 'commit', '-q', '-am', 'a2'], stlDirty.work);
fs.writeFileSync(path.join(stlDirty.work, 'keep.txt'), '没提交的东西\n');
await git.connectRepo('smoke/settle-dirty', null, stlDirty.work);
const dirtySettle = await git.settleAfterMerge('smoke/settle-dirty', { base: 'main', head: 'bandi/dirty-case', headSha: g(['-C', stlDirty.work, 'rev-parse', 'HEAD'], stlDirty.work) });
check('工作区有未提交改动 → 不切分支，只说明原因', dirtySettle.settled === false && dirtySettle.skipped === 'dirty' && /未提交/.test(dirtySettle.note), JSON.stringify(dirtySettle));
check('脏工作区下仍停在原分支、分支没被删', g(['-C', stlDirty.work, 'branch', '--show-current'], stlDirty.work) === 'bandi/dirty-case' && g(['-C', stlDirty.work, 'branch', '--format=%(refname:short)'], stlDirty.work).split('\n').includes('bandi/dirty-case'));

/* --------------------------------------------------- ④ createPull：形状与坏脾气 */
console.log('\n④ 建 PR：请求形状、查重、422 分档、403 指明缺哪个权限');

gh.reset();
const made = await git.createPull('smoke/demo', { head: 'fix/feat-demo', base: 'main', title: '加一个功能', body: '验证：跑了冒烟' });
check('201 回来的是平台内部那一份形状（number/url/headRef/state）', made.created === true && made.pr.number >= 101 && /\/pull\//.test(made.pr.url) && made.pr.headRef === 'fix/feat-demo' && made.pr.state === 'open', JSON.stringify(made.pr));
const createCall = gh.lastHit(/^POST \/repos\/smoke\/demo\/pulls$/);
check('请求体用 GitHub 的字段名（head/base/title/body/draft）', createCall?.body?.head === 'fix/feat-demo' && createCall?.body?.base === 'main' && createCall?.body?.draft === false, JSON.stringify(createCall?.body));

/*
 * 2026-10-27「PR 区域」：列表项要把"从哪来 / 能不能合 / CI 什么状态"一起带出来
 * （原来只有编号/标题/作者/headSha，界面画不出 `head → base`、也说不出合并按钮为什么按不了）。
 */
const listed = await git.listOpenPulls('smoke/demo');
const listedRow = listed.find((p) => p.headRef === 'fix/feat-demo');
check(
  'PR 列表项带 baseRef / headRef / mergeable / mergeableState',
  listedRow?.baseRef === 'main' && listedRow?.headRef === 'fix/feat-demo' && listedRow?.mergeable === true && listedRow?.mergeableState === 'clean',
  JSON.stringify(listedRow),
);
gh.seedChecks('smoke/demo', listedRow.headSha, 'success');
const listedChecks = await git.pullChecks('smoke/demo', listedRow.headSha);
check('pullChecks 把 check-runs 归约成 success（PR 行的 gate ✓ 就吃它）', listedChecks.state === 'success' && listedChecks.total === 1, JSON.stringify(listedChecks));

const again = await git.createPull('smoke/demo', { head: 'fix/feat-demo', base: 'main', title: '又点了一次' });
check('同一个 head 再建 → 认成"已存在"，把那个 PR 交回来（不报错、不建第二个）', again.created === false && again.pr.number === made.pr.number, JSON.stringify({ c: again.created, n: again.pr.number }));

let sameRef = '';
try {
  await git.createPull('smoke/demo', { head: 'main', base: 'main', title: '自己合自己' });
} catch (e) {
  sameRef = e.message;
}
check('head 与 base 同名 → 平台自己就挡下（不白带一次请求）', /同一个/.test(sameRef) && gh.hits(/^POST \/repos\/smoke\/demo\/pulls$/).length === 2, sameRef.slice(0, 60));

gh.failWith(/^POST \/repos\/smoke\/demo\/pulls$/, 422, 'Validation Failed: No commits between main and bandi/none');
let noCommits = '';
try {
  await git.createPull('smoke/demo', { head: 'bandi/none', base: 'main', title: '没提交' });
} catch (e) {
  noCommits = e.message;
}
// 2026-10-30 文案改成「没有新提交」并补了"刚合并过"的提示 —— 断言跟着收两种写法，语义没松。
check('422「No commits between」→ 说"没有提交 / base 选错"，原话带着', /没有新?提交/.test(noCommits) && /No commits between/.test(noCommits), noCommits.slice(0, 80));

gh.failWith(/^POST \/repos\/smoke\/demo\/pulls$/, 403, 'Resource not accessible by personal access token');
let noScope = '';
try {
  await git.createPull('smoke/demo', { head: 'bandi/other', base: 'main', title: '另一个' });
} catch (e) {
  noScope = e.message;
}
check('403 → 指明要 Pull requests: Read and write，并说现在挂的是哪个令牌', /Pull requests: Read and write/.test(noScope) && /\*{6}/.test(noScope), noScope.slice(0, 100));

/* --------------------------------------------------- ⑤ mergePull：乐观锁 */
console.log('\n⑤ 合并：拿看过的那个 sha 去合，期间有人推提交就撞 409');

gh.reset();
gh.seed('smoke/demo', { number: 42, head: 'bandi/m42', base: 'main', headSha: 'sha-A' });
gh.seed('smoke/demo', { number: 43, head: 'bandi/m43', base: 'main', headSha: 'sha-B' });
const m1 = await git.mergePull('smoke/demo', 42, { mergeMethod: 'squash', sha: 'sha-A' });
check('sha 对得上 → 合上了', m1.merged === true, JSON.stringify(m1));
const mergeCall = gh.lastHit(/^PUT \/repos\/smoke\/demo\/pulls\/42\/merge$/);
check('请求带上 sha（乐观锁）与 merge_method', mergeCall?.body?.sha === 'sha-A' && mergeCall?.body?.merge_method === 'squash', JSON.stringify(mergeCall?.body));

let stale = '';
try {
  await git.mergePull('smoke/demo', 43, { sha: 'sha-STALE' });
} catch (e) {
  stale = e.message;
}
check('sha 过期（409）→ 说"被人推了新提交"，不是含糊失败', /新提交/.test(stale), stale.slice(0, 60));
let twice = '';
try {
  await git.mergePull('smoke/demo', 42, {});
} catch (e) {
  twice = e.message;
}
check('已合过的再合（405）→ 原话带回原因', /405|拒绝合并/.test(twice), twice.slice(0, 60));
check('删源分支走 DELETE ref', (await git.deleteRemoteBranch('smoke/demo', 'bandi/m42')).deleted === 'bandi/m42' && gh.deletedRefs.includes('bandi/m42'));

/* --------------------------------------------------- 起一个真控制面 */
const logPath = path.join(tmp, 'server.log');
const logFd = fs.openSync(logPath, 'a');
const child = spawn(process.execPath, [path.join(repoRoot, 'apps', 'server', 'src', 'server.mjs')], {
  cwd: repoRoot,
  env: { ...process.env, BANDI_PORT: String(PORT), BANDI_DATA: tmp, BANDI_DB: path.join(tmp, 'bandi.db') },
  windowsHide: true,
  stdio: ['ignore', logFd, logFd],
});
fs.closeSync(logFd);

let up = false;
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(BASE + '/api/git/status')).ok) {
      up = true;
      break;
    }
  } catch {
    /* 还没起 */
  }
  await new Promise((r) => setTimeout(r, 250));
}
check('控制面起来了（连着同一个假 GitHub 与同一个库）', up);
if (!up) console.log(fs.readFileSync(logPath, 'utf8').split('\n').slice(-15).join('\n'));

try {
  if (up) {
    /* ---------------- ⑥ HTTP：读侧两个口 ---------------- */
    console.log('\n⑥ HTTP：/changes 只读本地、/prs 走 GitHub');
    const id = encodeURIComponent(row.id);
    const savedToken = git.readToken();
    git.clearToken();
    const c1 = await req(`/api/git/repos/${id}/changes`);
    check('GET /changes 200：带 dirtyCount / secrets / suggest', c1.status === 200 && c1.b.state?.dirtyCount >= 1 && c1.b.state.secrets.includes('.env') && !!c1.b.state.suggest, JSON.stringify({ d: c1.b.state?.dirtyCount, s: c1.b.state?.secrets }));
    /*
     * 没连 GitHub 也能读工作区状态 —— 这一条**必须在没令牌的时刻测**（原来先取令牌再取状态，
     * 那条"没令牌也不报错"就成了永远为真的空话，2026-10-25 自查时抓到）。
     * 分支不写死 main：③ 的推送已经把当前分支切到 fix/feat-demo 了，
     * 这里要验的是"读到的是**此刻的本地事实**"，不是某个特定名字。
     */
    check('没连 GitHub 也读得到本地状态（/changes 不碰网络，点下去就该有反应）', c1.status === 200 && c1.b.state?.branch === pushed.branch, JSON.stringify({ s: c1.status, b: c1.b.state?.branch }));
    const noTokenList = await req(`/api/git/repos/${id}/prs`);
    check('没连 GitHub 就列 PR → 400 说"先连接 GitHub"（不画一个空清单糊人）', noTokenList.status === 400 && /先连接 GitHub/.test(noTokenList.b?.error ?? ''), String(noTokenList.status));
    if (savedToken) git.saveToken(savedToken);
    check('仓库不在清单里 → 404（不是 500）', (await req('/api/git/repos/gr-nope/changes')).status === 404);
    check('/prs 上不支持的方法 → 405 说清只认 GET/POST', (await req(`/api/git/repos/${id}/prs`, { method: 'PUT', body: JSON.stringify({}) })).status === 405);

    gh.reset();
    gh.seed('smoke/demo', { number: 77, title: '别人提的', head: 'feature/x', base: 'main', author: 'someone' });
    const l1 = await req(`/api/git/repos/${id}/prs`);
    check('GET /prs 列出开着的 PR（number/url/author/headSha）', l1.status === 200 && l1.b.prs?.[0]?.number === 77 && /github\.test/.test(l1.b.prs[0].url) && !!l1.b.prs[0].headSha, JSON.stringify(l1.b.prs?.[0]));
    check('没挂在卡上的 PR taskId=null', l1.b.prs?.[0]?.taskId === null, String(l1.b.prs?.[0]?.taskId));

    /* ---------------- ⑦ HTTP：从任务卡建 PR ---------------- */
    console.log('\n⑦ HTTP：卡上建 PR → 提交推送 + 建出来 + 自动挂回这张卡');
    const project = store.createProject({ name: '冒烟仓库项目', root: work });
    fs.writeFileSync(path.join(work, 'ship.js'), 'export const ship = true;\n');
    const card = store.createProjectTask({ projectId: project.id, title: '把建 PR 接上界面', status: '进行中' });
    const cid = encodeURIComponent(card.id);
    const created = await req(`/api/projects/tasks/${cid}/pr/create`, {
      method: 'POST',
      body: JSON.stringify({ title: 'feat: 把建 PR 接上界面', body: '验证：smoke-pr-create', paths: ['ship.js'] }),
    });
    check('201：返回 pr / branch / base / created', created.status === 201 && created.b.pr?.number >= 101 && /^(feat|fix|chore|docs|refactor|test|perf)\//.test(created.b.branch) && created.b.base === 'main' && created.b.created === true, JSON.stringify({ s: created.status, br: created.b.branch, n: created.b.pr?.number }));
    check('卡自动挂上这个 PR（五个字段落库）', created.b.task?.prRepo === 'smoke/demo' && created.b.task?.prNumber === created.b.pr?.number && created.b.task?.prState === 'open' && !!created.b.task?.prCheckedAt, JSON.stringify(created.b.task?.prRepo));
    check('GitHub 那边真有了这个 PR（假件内存里查得到）', gh.pulls.get('smoke/demo')?.some((p) => p.number === created.b.pr.number && p.head === created.b.branch));
    check('只提交挑中的文件（.env 仍没进去）', g(['-C', work, 'status', '--porcelain'], work).includes('.env'), g(['-C', work, 'status', '--porcelain'], work).replace(/\n/g, ' | '));

    /* 第二次点：工作树没有新东西了（把 .env 撤掉，模拟"同一件事再点一次"） */
    fs.rmSync(path.join(work, '.env'), { force: true });
    const dup = await req(`/api/projects/tasks/${cid}/pr/create`, {
      method: 'POST',
      body: JSON.stringify({ title: '再点一次', branch: created.b.branch }),
    });
    check('同分支重复建 → created=false，把已有那个交回来（不撞 403/422、不建第二个）', dup.status === 201 && dup.b.created === false && dup.b.pr.number === created.b.pr.number, JSON.stringify({ s: dup.status, c: dup.b.created, n: dup.b.pr?.number }));
    check('卡上仍然只有一个 PR', store.getProjectTask(card.id).prNumber === created.b.pr.number);
    check('GitHub 上这条 head 只有一个 PR', gh.pulls.get('smoke/demo')?.filter((p) => p.head === created.b.branch).length === 1);

    /* ---------------- ⑧ HTTP：卡上手动合并 ---------------- */
    console.log('\n⑧ HTTP：卡上点合并 → 「进行中」转「待验收」（合并 ≠ 验收通过）');
    const merged = await req(`/api/projects/tasks/${cid}/pr/merge`, { method: 'POST', body: JSON.stringify({ method: 'merge' }) });
    check('200 且 merged=true', merged.status === 200 && merged.b.merged === true, JSON.stringify({ s: merged.status, m: merged.b?.merged }));
    const after = store.getProjectTask(card.id);
    check('卡上 prState=merged', after.prState === 'merged', String(after.prState));
    check('「进行中」→「待验收」（不自动已完成）', after.status === '待验收', after.status);
    check(
      '卡上合并后本地也收尾了（切回 main，不再停在 PR 分支）',
      merged.b.local?.settled === true && g(['-C', work, 'branch', '--show-current'], work) === 'main',
      JSON.stringify(merged.b.local),
    );

    const again2 = await req(`/api/projects/tasks/${cid}/pr/merge`, { method: 'POST', body: JSON.stringify({}) });
    check('已经合过的再点 → already=true + 说"已经合过了"，不当失败', again2.status === 200 && again2.b.already === true && /合过/.test(String(again2.b.note ?? '')), JSON.stringify({ a: again2.b?.already, n: again2.b?.note }));

    const draftRepo = gh.seed('smoke/demo', { number: 88, title: '草稿', head: 'bandi/d', base: 'main', draft: true });
    const draftTask = store.createProjectTask({ projectId: project.id, title: '挂着草稿的卡', status: '进行中' });
    store.updateProjectTask(draftTask.id, { prRepo: 'smoke/demo', prNumber: draftRepo.number, prState: 'open' });
    const draftMerge = await req(`/api/projects/tasks/${encodeURIComponent(draftTask.id)}/pr/merge`, { method: 'POST', body: JSON.stringify({}) });
    check('草稿 PR 拒绝合并并说明为什么', draftMerge.status === 400 && /草稿/.test(draftMerge.b?.error ?? ''), draftMerge.b?.error);
    check('被拒的草稿没被合（假件里还是 open）', gh.pulls.get('smoke/demo').find((p) => p.number === 88).state === 'open');

    /* ---------------- ⑨ 前置条件不满足：说清缺哪一环 ---------------- */
    console.log('\n⑨ 前置条件不满足时：说清缺哪一环，绝不当成"建好了"');
    const noCard = store.createProjectTask({ projectId: project.id, title: '这张卡没关联 PR', status: '待办' });
    const badMerge = await req(`/api/projects/tasks/${encodeURIComponent(noCard.id)}/pr/merge`, { method: 'POST', body: JSON.stringify({}) });
    check('没关联 PR 就合并 → 400「这张卡还没关联 PR」', badMerge.status === 400 && /还没关联/.test(badMerge.b?.error ?? ''), String(badMerge.status));

    const orphan = store.createProjectTask({ projectId: project.id, title: '项目行没了的卡', status: '待办' });
    // `project_tasks.projectId` 是 NOT NULL，正常口子造不出"没挂项目的卡"；
    // 能造出来的是**项目行没了、卡还在**这种残缺（绕过 deleteProject 直接删项目行才模拟得出）
    const { db } = await import('./store/db.mjs');
    db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
    const noProj = await req(`/api/projects/tasks/${encodeURIComponent(orphan.id)}/pr/create`, { method: 'POST', body: JSON.stringify({ title: 'x' }) });
    check('卡的项目行不在了 → 400 指路去仓库行上建（不知道在哪个目录提交）', noProj.status === 400 && /没挂项目/.test(noProj.b?.error ?? ''), String(noProj.status));
    db.prepare('INSERT INTO projects (id, name, root, extraRoots, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run(project.id, project.name, project.root, '[]', store.nowIso(), store.nowIso());

    const offRepo = store.createProject({ name: '不在仓库里的项目', root: path.join(tmp, 'plain-dir-not-a-repo') });
    fs.mkdirSync(offRepo.root, { recursive: true });
    const offCard = store.createProjectTask({ projectId: offRepo.id, title: '目录不是已接入仓库', status: '待办' });
    const notRepo = await req(`/api/projects/tasks/${encodeURIComponent(offCard.id)}/pr/create`, { method: 'POST', body: JSON.stringify({ title: 'x' }) });
    check('项目目录不在任何已接入仓库 → 400 指路去接入', notRepo.status === 400 && /不在任何已接入的仓库/.test(notRepo.b?.error ?? ''), notRepo.b?.error);

    const savedToken2 = git.readToken();
    git.clearToken();
    const noToken = await req(`/api/git/repos/${id}/prs`, { method: 'POST', body: JSON.stringify({ title: '没令牌' }) });
    check('没连 GitHub 就建 PR → 400 让先去连接', noToken.status === 400 && /先连接 GitHub/.test(noToken.b?.error ?? ''), String(noToken.status));
    if (savedToken2) git.saveToken(savedToken2);

    check('未知 /api/git 路径仍 404（没被新路由吞掉）', (await req('/api/git/repos/nope/nothing')).status === 404);
    check('老接口没被改坏：POST /api/git/repos 仍然认（回归）', (await req('/api/git/repos', { method: 'POST', body: JSON.stringify({ fullName: 'smoke/demo' }) })).status === 400);
    check('完整令牌从没出现在任何响应里', !JSON.stringify([c1.b, l1.b, created.b, merged.b, dup.b]).includes('ghp_smokepr1234abcd'));

    /* ---------------- ⑩ 仓库行那两个接口（「建 PR」弹窗用的就是这两颗） ---------------- */
    /*
     * 前面 ⑦⑧ 走的是**卡**上那两个口；弹窗走的是仓库上那两个口。
     * 两条路共用服务端的 `openPr` / `mergeOne`，但路由是各写一遍的 ——
     * 只测一边就会留一半没人管（台账写的"合完删源分支"这类规则全在这条路上）。
     *
     * 2026-10-29 改契约（用户："提交和建 PR 一起，说不清也不好控制"）：这条路 **includeDirty:false** ——
     * 建 PR 只推**已提交**的东西，一个脏文件都不碰；门槛 = 有领先 base 的提交。
     * 所以先钉"只有脏文件 → 400 说人话"，再真提交一笔 → 201，且推的就是当前分支（不再另起新名）。
     */
    console.log('\n⑩ HTTP：仓库行上建 PR / 合并（弹窗那两颗按钮）');
    gh.reset();
    fs.writeFileSync(path.join(work, 'extra.js'), 'export const extra = 1;\n');
    const rGate = await req(`/api/git/repos/${id}/prs`, {
      method: 'POST',
      body: JSON.stringify({ title: '只有脏文件就建不了' }),
    });
    check(
      '只有脏文件、没有领先提交 → 400 指路先提交（PR 只装已提交的）',
      rGate.status === 400 && /领先|提交/.test(rGate.b?.error ?? ''),
      JSON.stringify({ s: rGate.status, e: rGate.b?.error }),
    );

    g(['-C', work, 'checkout', '-b', 'bandi/feat-repo-pr'], work); // 脏文件跟着工作区走，不碍事
    g(['-C', work, 'add', '.'], work);
    // 直接跑 git 就得自带身份（服务端那条路有 commitIdentityArgs 兜，这里没有）
    g(['-C', work, '-c', 'user.name=smoke', '-c', 'user.email=smoke@test', 'commit', '-m', 'feat: 仓库行建 PR 的提交'], work);
    const rCreate = await req(`/api/git/repos/${id}/prs`, {
      method: 'POST',
      body: JSON.stringify({ title: 'repo 级建 PR', body: '来自仓库行' }),
    });
    check('POST /api/git/repos/:id/prs → 201 并返回 pr', rCreate.status === 201 && rCreate.b.created === true && rCreate.b.pr?.number >= 101, JSON.stringify({ s: rCreate.status, n: rCreate.b.pr?.number, e: rCreate.b?.error }));
    check('只推已提交：推的就是当前分支（不再另起新名字）', rCreate.b.branch === 'bandi/feat-repo-pr', String(rCreate.b.branch));
    check('PR 的 head 就是那个分支（查重 / 合并都认它）', rCreate.b.pr?.headRef === 'bandi/feat-repo-pr', String(rCreate.b.pr?.headRef));

    const n1 = rCreate.b.pr.number;
    const rMerge = await req(`/api/git/repos/${id}/prs/${n1}/merge`, { method: 'POST', body: JSON.stringify({ method: 'squash', deleteBranch: true }) });
    check('合并 200', rMerge.status === 200 && rMerge.b.merged === true, JSON.stringify({ s: rMerge.status, m: rMerge.b?.merged }));
    check('勾了删分支 → 平台那条真的删了（DELETE ref 打到 GitHub）', rMerge.b.branchDeleted === rCreate.b.branch && gh.deletedRefs.includes(rCreate.b.branch), JSON.stringify(gh.deletedRefs));
    check(
      '仓库行合并后本地也收尾了（回到 main）',
      rMerge.b.local?.settled === true && g(['-C', work, 'branch', '--show-current'], work) === 'main',
      JSON.stringify(rMerge.b.local),
    );
    // 断言打在**打到 GitHub 的那一发**上（假件记的是 `/repos/.../pulls/{n}/merge`，不是班底自己的 `/prs/` 路径）
    const ghMerge = gh.lastHit(new RegExp(`PUT /repos/smoke/demo/pulls/${n1}/merge$`));
    check('合并方式按人给的传下去（squash）', ghMerge?.body?.merge_method === 'squash', JSON.stringify(ghMerge?.body));

    // 人自己开的分支删不得：勾了也不动，只把"没删"这件事说出来（合并本身已经成了）
    const human = gh.seed('smoke/demo', { number: 91, title: '人开的分支', head: 'feature/human', base: 'main', headSha: 'sha-H' });
    const rMerge2 = await req(`/api/git/repos/${id}/prs/${human.number}/merge`, { method: 'POST', body: JSON.stringify({ deleteBranch: true }) });
    check('人开的分支（feature/human）：照样合并成功，但不删（删了是砸人正在干的活）', rMerge2.status === 200 && rMerge2.b.merged === true && rMerge2.b.branchDeleted === null, JSON.stringify({ d: rMerge2.b?.branchDeleted }));
    check('并且把"没删"说出来（不当成删了，也不报成失败）', /没删源分支/.test(String(rMerge2.b.note ?? '')), String(rMerge2.b.note));
    check('feature/human 没被发过 DELETE', !gh.deletedRefs.includes('feature/human'));

    const rMerge3 = await req(`/api/git/repos/${id}/prs/${human.number}/merge`, { method: 'POST', body: JSON.stringify({}) });
    check('仓库行上重复合并 → already=true（不当失败）', rMerge3.status === 200 && rMerge3.b.already === true, JSON.stringify({ s: rMerge3.status, a: rMerge3.b?.already }));

    const backRes = await req(`/api/git/repos/${id}/back`, { method: 'POST' });
    check(
      'POST /back 可用（已在 base 时只拉最新，返回收尾说明）',
      backRes.status === 200 && backRes.b.local?.settled === true && backRes.b.local?.switched === false,
      JSON.stringify(backRes.b?.local),
    );

    /* ---------------- ⑪ 流程：开发完成 → 建 PR → 审阅 → 合并（2026-10-25） ---------------- */
    /*
     * 这一条把「让仓库管家提交代码时自动建 PR、全自动合并」整条链跑一遍（真 git + 假 GitHub）：
     *   · 研发节点交付 → 平台动作节点自己提交/推送/开 PR（不经过员工，不碰令牌）；
     *   · PR 编号写回流程、材料塞进「审阅」那一步、看板上多一张值班卡；
     *   · 管理员结论「值得合」+ CI 全绿 + 四闸全过 + 仓库授权 → 自动合并、流程收尾。
     * 管理员**故意不绑**：这条用例自己扮管理员交结论，避免真去起一个数字员工跑模型。
     */
    console.log('\n⑪ 流程：开发完成 → 建 PR → 审阅 → 合并（自动合）');
    prCreate.ensurePrDeliveryTemplate();
    const flowProject = store.createProject({ name: '流程建 PR 项目', root: work });
    fs.writeFileSync(path.join(work, 'flow.js'), 'export const flow = 1;\n');
    store.updateGitRepoSettings(row.id, { autoMerge: true }); // 授权自动合并；管理员留空
    gh.reset();

    const flowRun = workflows.startWorkflow({
      templateId: prCreate.PR_DELIVERY_TEMPLATE_ID,
      title: '流程建 PR',
      intent: '把 flow.js 交成一个 PR',
      projectId: flowProject.id,
      autoStart: false,
    });
    const devTask = store.listWorkflowTasks(flowRun.id)[0];
    check('流程从「开发完成」起步', devTask?.nodeId === 'n1', devTask?.nodeId);
    store.updateWorkflowTask(devTask.id, {
      status: '待验收',
      result: JSON.stringify({ state: 'done', summary: '写完了', finalText: '写完了' }),
    });
    workflows.decide(flowRun.id, '通过');

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 15000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (await fn()) return true;
        await sleep(100);
      }
      return false;
    };

    const reviewReady = await waitFor(() => store.getWorkflowRun(flowRun.id)?.currentNodeId === 'n3');
    check('「建 PR」动作节点到站自动执行（不再停在待办）', reviewReady, String(store.getWorkflowRun(flowRun.id)?.currentNodeId));
    const flowRow = store.getWorkflowRun(flowRun.id);
    check('PR 编号写在流程上（合并节点只认它）', !!flowRow.prRepo && !!flowRow.prNumber, `${flowRow.prRepo}#${flowRow.prNumber}`);

    const flowPr = gh.pulls.get('smoke/demo')?.find((p) => p.number === Number(flowRow.prNumber));
    check('假 GitHub 真收到了建 PR 请求（标题来自流程）', !!flowPr && flowPr.title === '流程建 PR', flowPr?.title);
    check('PR 正文带上了流程的起因', /flow\.js/.test(flowPr?.body ?? ''), flowPr?.body);
    check('新分支是 <type>/ 开头（不往 base 上提）', /^(feat|fix|chore|docs|refactor|test|perf)\//.test(flowPr?.head ?? ''), flowPr?.head);
    check(
      '流程记住管理员看的是哪个 head（自动合并只认它）',
      prReview.reviewedShaOf(flowRun.id) === flowPr.headSha,
      `${prReview.reviewedShaOf(flowRun.id)} vs ${flowPr.headSha}`,
    );

    const reviewTask2 = store.listWorkflowTasks(flowRun.id).find((t) => t.nodeId === 'n3');
    check('审阅那一步没被乱派：仓库没绑管理员 → 阻塞等人（不是静默卡死）', reviewTask2?.status === '已阻塞', reviewTask2?.status);
    check('审阅材料已经写进这一步（管理员一上手就有判断依据）', /【审阅材料】/.test(reviewTask2?.detail ?? ''), String(reviewTask2?.detail).slice(0, 40));
    check('阻塞原因说清怎么补管理员', /没绑管理员/.test(reviewTask2?.note ?? ''), String(reviewTask2?.note).slice(0, 60));

    const flowCard = store.getProjectTaskByExternalKey(flowProject.id, `pr:${flowRow.prNumber}`);
    check('看板上多了一张 PR 值班卡（与巡检同一套去重键）', !!flowCard && flowCard.prNumber === Number(flowRow.prNumber), flowCard?.id);

    gh.seedChecks('smoke/demo', flowPr.headSha, 'success'); // CI 全绿，四闸才有机会全过
    store.updateWorkflowTask(reviewTask2.id, {
      status: '待验收',
      result: JSON.stringify({ state: 'done', summary: '结论：值得合', finalText: '改动就一个文件，没风险。\n结论：值得合' }),
    });
    workflows.decide(flowRun.id, '通过');

    const mergedFlow = await waitFor(() => store.getWorkflowRun(flowRun.id)?.status === '已完成');
    check('「合并」动作节点到站自动执行 → 流程收尾', mergedFlow, store.getWorkflowRun(flowRun.id)?.status);
    const flowMergeCall = gh.lastHit(new RegExp(`PUT /repos/smoke/demo/pulls/${flowRow.prNumber}/merge$`));
    check('自动合并带上了审阅时的 head sha（乐观锁）', flowMergeCall?.body?.sha === flowPr.headSha, JSON.stringify(flowMergeCall?.body));
    check('PR 在假 GitHub 上真的合了', gh.pulls.get('smoke/demo')?.find((p) => p.number === Number(flowRow.prNumber))?.state === 'merged');
    check('值班卡跟着变成 merged', store.getProjectTask(flowCard.id)?.prState === 'merged', String(store.getProjectTask(flowCard.id)?.prState));
    check('自动合并后本地也切回 base 了', g(['-C', work, 'branch', '--show-current'], work) === 'main', g(['-C', work, 'branch', '--show-current'], work));
    const mergeNodeTask = store.listWorkflowTasks(flowRun.id).at(-1);
    check('合并节点备注带本地收尾说明', /本地：/.test(mergeNodeTask?.note ?? ''), String(mergeNodeTask?.note));

    /*
     * 反证：**审阅之后又有人推了新提交** —— 自动合并不许合"没看过的那一份"。
     * 假件里把 head 改掉（模拟推了新提交），CI 也照样给绿（证明拦下它的不是 CI 闸），
     * 平台必须拿审阅时的旧 sha 去合 → GitHub 回 409 → 这一步失败等人重看，PR 仍是 open。
     */
    fs.writeFileSync(path.join(work, 'flow2.js'), 'export const flow2 = 1;\n');
    const flowRun2 = workflows.startWorkflow({
      templateId: prCreate.PR_DELIVERY_TEMPLATE_ID,
      title: '流程建 PR · 审阅后被推新提交',
      intent: '验证自动合并的 SHA 锁',
      projectId: flowProject.id,
      autoStart: false,
    });
    const dev2 = store.listWorkflowTasks(flowRun2.id)[0];
    store.updateWorkflowTask(dev2.id, { status: '待验收', result: JSON.stringify({ state: 'done', finalText: '写完了' }) });
    workflows.decide(flowRun2.id, '通过');
    const ready2 = await waitFor(() => store.getWorkflowRun(flowRun2.id)?.currentNodeId === 'n3');
    const row2 = store.getWorkflowRun(flowRun2.id);
    const flowPr2 = gh.pulls.get('smoke/demo')?.find((p) => p.number === Number(row2.prNumber));
    check('第二个 PR 也建出来了', ready2 && !!flowPr2, `${row2.prRepo}#${row2.prNumber}`);

    const review2 = store.listWorkflowTasks(flowRun2.id).find((t) => t.nodeId === 'n3');
    gh.seedChecks('smoke/demo', 'sha-after-review', 'success'); // 新 head 的 CI 是绿的：拦下合并的不是 CI 闸
    flowPr2.headSha = 'sha-after-review'; // 审阅之后有人推了一提交
    store.updateWorkflowTask(review2.id, {
      status: '待验收',
      result: JSON.stringify({ state: 'done', summary: '结论：值得合', finalText: '结论：值得合' }),
    });
    workflows.decide(flowRun2.id, '通过');

    const mergeTask2 = await waitFor(() => store.listWorkflowTasks(flowRun2.id).at(-1)?.status === '失败');
    const failedTask = store.listWorkflowTasks(flowRun2.id).at(-1);
    check('审阅后被推新提交 → 自动合并撞 409 停下（不合没看过的）', mergeTask2, failedTask?.status);
    check('失败原因说"被人推了新提交"', /新提交/.test(failedTask?.note ?? ''), String(failedTask?.note).slice(0, 80));
    check('PR 没被合掉（假件里还是 open）', gh.pulls.get('smoke/demo')?.find((p) => p.number === Number(row2.prNumber))?.state === 'open');

    /* ---------------- ⑫ gate 明细 + 重跑（2026-10-29 "界面卡住了，得有个修复功能"） ---------------- */
    /*
     * PR 行上那颗 `gate ✗` 现在是个入口：点开 → GET /prs/:n/checks 看哪条红了、红在哪个
     * job / step；偶发红 → POST .../rerun 一键重跑。三段契约在这里钉死：
     *   · 归约还是 summarizeChecks 那套（failure 优先）；
     *   · Actions 下钻只报**非 success、非 skipped** 的 step —— 红在哪要一眼看到；
     *   · 重跑过一次的 run 回到"在跑"（conclusion 清空）→ 再点重跑要说"没有失败的"。
     */
    console.log('\n⑫ HTTP：gate 明细 + 重跑（PR 行上那颗 ✗ 的落点）');
    const gatePr = rCreate.b.pr;
    gh.seedChecks('smoke/demo', gatePr.headSha, 'failure'); // ⑪ 给同一个 sha 种过"全绿"，这里改回红的
    const seededRun = gh.seedActions('smoke/demo', gatePr.headSha, {
      jobs: [{
        name: 'gate (windows-latest)',
        conclusion: 'failure',
        html_url: 'http://github.test/job',
        steps: [{ name: '策略检查', conclusion: 'success' }, { name: '冒烟', conclusion: 'failure' }, { name: '打包', conclusion: 'skipped' }],
      }],
    });
    const g1 = await req(`/api/git/repos/${id}/prs/${gatePr.number}/checks`);
    check('GET /prs/:n/checks → 200，归约成 failure', g1.status === 200 && g1.b.state === 'failure', JSON.stringify({ s: g1.status, st: g1.b?.state }));
    check('runs 明细带名字和结论（假件给的 ci/failure）', g1.b.runs?.[0]?.name === 'ci' && g1.b.runs?.[0]?.conclusion === 'failure', JSON.stringify(g1.b.runs));
    check(
      '失败下钻到 step：只报非 success / 非 skipped —— 红在「冒烟」',
      g1.b.jobs?.length === 1 && g1.b.jobs[0].steps?.length === 1 && g1.b.jobs[0].steps[0].name === '冒烟',
      JSON.stringify(g1.b.jobs),
    );
    check('job 带日志链接（人要的"去哪看全文"就在这）', g1.b.jobs?.[0]?.url === 'http://github.test/job', String(g1.b.jobs?.[0]?.url));

    const rr = await req(`/api/git/repos/${id}/prs/${gatePr.number}/checks/rerun`, { method: 'POST', body: JSON.stringify({}) });
    check('POST /rerun → 200，重跑真的打到 GitHub', rr.status === 200 && rr.b.rerun === true && gh.reruns.includes(seededRun.id), JSON.stringify({ s: rr.status, r: gh.reruns }));
    const rr2 = await req(`/api/git/repos/${id}/prs/${gatePr.number}/checks/rerun`, { method: 'POST', body: JSON.stringify({}) });
    check(
      '重跑过再点 → 400 说"没有失败的检查可重跑"（不当成又跑了一次）',
      rr2.status === 400 && /重跑/.test(rr2.b?.error ?? ''),
      JSON.stringify({ s: rr2.status, e: rr2.b?.error }),
    );

    /* ---------------- ⑬ 「让 AI 帮我修」：一颗按钮建一张卡（2026-10-29 用户："我只要一个按钮"） ----------------
     * 用户不看代码、也不关心报错，所以这条接口**不回明细**：服务端自己取 headSha、判断能不能修、
     * 用界面上选的人（没选就按岗位挑）建一张任务卡挂在他名下。
     *
     * 口径变过一次，别把它当 bug 改回去：
     *   · 2026-10-29 用户定："不要开对话，开任务卡就行了" —— 那一刻是"只建卡、不派活"；
     *   · **2026-10-30 用户改口（"嘉辉为啥没干活啊"）：建卡即开工** —— 卡直接进「进行中」并起 run，
     *     开的是这张卡自己的**工单会话**（kind=exec，不进消息列表），不是执行人那条 1:1 聊天。
     * 所以断言按新口径钉四条：
     *   · 红了就建卡并开工（201 + taskId + personaId + conversationId），卡的会话是 kind=exec；
     *   · 卡挂在选的人名下、状态「进行中」、有 runId；
     *   · 已经全绿不建卡（400 E1121）；
     *   · 卡的描述（brief）里必须写死"不许改 workflow / 删测试骗绿"，否则 agent 会去把闸糊绿。
     */
    console.log('\n⑬ HTTP：让 AI 帮我修（点一下就建一张任务卡）');
    gh.seedChecks('smoke/demo', gatePr.headSha, 'failure'); // ⑫ 重跑过，这里重新种回红的
    gh.seedActions('smoke/demo', gatePr.headSha, {
      jobs: [{ name: 'gate', conclusion: 'failure', html_url: 'http://github.test/job', steps: [{ name: '冒烟', conclusion: 'failure' }] }],
    });
    const fx = await req(`/api/git/repos/${id}/prs/${gatePr.number}/fix`, { method: 'POST', body: JSON.stringify({}) });
    check(
      'POST /fix → 201，回了卡号 + 派给谁 + 开工的会话',
      fx.status === 201 && !!fx.b?.taskId && !!fx.b?.personaId && !!fx.b?.conversationId,
      JSON.stringify({ s: fx.status, t: fx.b?.taskId, c: fx.b?.conversationId, e: fx.b?.error }),
    );
    // 2026-10-30：开工用的是**这张卡的工单会话** —— kind=exec 才是"不出消息列表"的判据，
    // 不是"没有 conversationId"（那条是 10-29 的旧口径）。
    const fixConv = fx.b?.conversationId ? store.getConversation(fx.b.conversationId) : null;
    check('开工的会话是工单会话（kind=exec，不进消息列表）', fixConv?.kind === 'exec', JSON.stringify({ k: fixConv?.kind, id: fixConv?.id }));
    const task = fx.b?.taskId ? await req(`/api/projects/tasks/${encodeURIComponent(fx.b.taskId)}`) : null;
    const trow = task?.b?.task ?? {};
    const brief = String(trow.description ?? '');
    check(
      '卡挂在选的人名下、已经开工（进行中 + 有 runId）',
      trow.assigneePersonaId === fx.b?.personaId && trow.status === '进行中' && !!trow.runId,
      JSON.stringify({ st: trow.status, a: trow.assigneePersonaId, run: trow.runId }),
    );
    check(
      'brief 带现场：仓库本机目录 + PR 号 + 失败的检查',
      brief.includes('修到过为止') && brief.includes(row.localPath) && brief.includes(`#${gatePr.number}`),
      brief.slice(0, 90),
    );
    check('brief 写死"不许改 workflow / 删测试骗绿"', /不许为了让检查变绿/.test(brief));

    gh.seedChecks('smoke/demo', gatePr.headSha, 'success');
    const fx2 = await req(`/api/git/repos/${id}/prs/${gatePr.number}/fix`, { method: 'POST', body: JSON.stringify({}) });
    check(
      '已经全绿 → 400 E1121，不白烧一次派活',
      fx2.status === 400 && fx2.b?.code === 'E1121',
      JSON.stringify({ s: fx2.status, c: fx2.b?.code }),
    );
  }
} finally {
  child.kill();
  await gh.stop();
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 删不掉就算了 */
  }
}

console.log(`\n结论：${failed ? `有 ${failed} 项没通过` : '全通过'}`);
process.exit(failed ? 1 : 0);
