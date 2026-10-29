/**
 * **假 GitHub** —— 给离线冒烟用的最小 REST 实现（2026-10-25）。
 *
 * 为什么要它（「建 PR」这条链能不能验收，全看这一步）：
 *   班底的冒烟铁律是**不联网、不要令牌**（`smoke-git-repos.mjs` 头注释；`tools/run-smokes.mjs`
 *   把要真实 CLI 的用例单列进 SKIP）。可「建 PR」整条链——查重 → 推送 → `POST /pulls` → 合并——
 *   每一步都在打 GitHub。只测纯函数等于没测：请求体写错、422 认不出来、拿旧 sha 去合，
 *   全都不会被发现。所以把 GitHub 搬到本机：`BANDI_GH_API=http://127.0.0.1:<port>` 一指，
 *   `git-repos.ghFetch` 就只跟这个假件说话，**整条链真跑一遍**。
 *
 * 为什么不是覆盖 `globalThis.fetch`（`smoke-schedules.mjs:179` 那招）：
 *   那招只在**同一个进程**里有效。本域的 server 是子进程起的（`smoke-git-repos.mjs:43`），
 *   父进程换掉的 fetch 影响不到它 —— 所以只能走"可指的服务地址"。
 *   反过来，假件起在**冒烟自己这个进程**里，断言就能直接读它的内存，不用跨进程回读状态。
 *
 * 只实现班底真用到的那几个端点（列 / 查 / 建 / 合 / 删 ref）。**故意保留 GitHub 的坏脾气**
 * 才是这里的全部价值，别把它们抹平：
 *   · 建 PR 撞同一个 head → 422「A pull request already exists」
 *   · head 与 base 没差异 → 422「No commits between」
 *   · 合并时 `sha` 对不上 → 409
 *   · 令牌没权限 → 403「Resource not accessible by personal access token」
 * 地址一律 `http://github.test/...`（假件不发真请求，也不要在本文件里出现 `https://github.com`
 * —— 那是 `tools/check-pr.mjs` 地址白名单会盯着看的东西）。
 */
import http from 'node:http';

/**
 * 起一个假 GitHub。
 * @returns {Promise<{port: number, pulls: Map, calls: Array, seed: Function, failWith: Function, reset: Function, stop: Function}>}
 */
export async function startGitHubMock() {
  const pulls = new Map(); // repo -> PR 数组（GitHub 原形状的字段在这里，返回时才包装）
  const calls = []; // 每一次进来的请求：{ method, pathname, body }
  const deletedRefs = []; // 被删掉的分支 ref
  /** 某个 commit 的 CI 结果（默认 none —— 现有用例靠"没有 CI"钉住闸的坏脾气） */
  const checks = new Map();
  /** Actions（2026-10-29 gate 明细 / 重跑用）：`${repo}#${sha}` -> { runs, jobs } */
  const actions = new Map();
  const reruns = []; // 被 POST /rerun 过的 run id
  let nextNumber = 100;
  let nextRunId = 900;
  let forced = null; // { match: RegExp, status: number, message: string } —— 注入一次性的失败

  const list = (repo) => {
    if (!pulls.has(repo)) pulls.set(repo, []);
    return pulls.get(repo);
  };

  /** 预置一个已经存在的 PR（测「列出来 / 已经合过 / 拿它合并」时用） */
  const seed = (repo, p) => {
    const row = {
      number: p.number ?? ++nextNumber,
      title: p.title ?? 'seeded',
      body: p.body ?? '',
      state: p.state ?? 'open', // open | merged | closed
      head: p.head ?? 'bandi/seed',
      base: p.base ?? 'main',
      draft: !!p.draft,
      headSha: p.headSha ?? 'sha-head-1',
      author: p.author ?? 'octo',
      additions: p.additions ?? 1,
      deletions: p.deletions ?? 1,
      changedFiles: p.changedFiles ?? 1,
    };
    list(repo).push(row);
    return row;
  };

  /** 下一次命中 `match` 的请求强制回这个状态码（测 403/422/409 的文案，不靠运气） */
  const failWith = (match, status, message) => {
    forced = { match: match instanceof RegExp ? match : new RegExp(String(match).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), status, message };
  };

  /**
   * 给某个 commit 预置 CI 结论（2026-10-25，PR 交付流程用例要验"四闸全过自动合"）。
   * 不预置就是 `none` —— "没 CI 不算过"是闸门的规矩，默认保持原样。
   */
  const seedChecks = (repo, sha, state = 'success') => {
    checks.set(`${repo}#${sha}`, state);
  };

  const rawPull = (repo, p) => ({
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state === 'merged' ? 'closed' : p.state, // GitHub 就是这么给的：merged 的 PR state 是 closed + merged=true
    html_url: `http://github.test/${repo}/pull/${p.number}`,
    user: { login: p.author },
    draft: p.draft,
    merged: p.state === 'merged',
    merged_at: p.state === 'merged' ? '2026-10-25T00:00:00Z' : null,
    additions: p.additions,
    deletions: p.deletions,
    changed_files: p.changedFiles,
    mergeable: true,
    mergeable_state: 'clean',
    head: { ref: p.head, sha: p.headSha },
    base: { ref: p.base },
  });

  const send = (res, code, obj) => {
    const text = code === 204 ? '' : JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(text);
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        /* 非 JSON 当空对象 */
      }
      const rec = { method: req.method, pathname: u.pathname, body, search: u.search };
      calls.push(rec);
      const pathname = u.pathname;

      if (forced && forced.match.test(`${req.method} ${pathname}`)) {
        const f = forced;
        forced = null;
        return send(res, f.status, { message: f.message });
      }

      /* GET /user —— 连令牌那一步要验身份（`verifyToken` / `whoami`） */
      if (pathname === '/user' && req.method === 'GET') {
        return send(res, 200, { login: 'bandibot', name: 'Bandi Bot', avatar_url: 'http://github.test/u/bandibot' });
      }

      /* GET /repos/{repo} —— 仓库元数据（接入时要读 default_branch / private） */
      const meta = /^\/repos\/([^/]+\/[^/]+)$/.exec(pathname);
      if (meta && req.method === 'GET') {
        const repo = decodeURIComponent(meta[1]);
        return send(res, 200, {
          full_name: repo,
          name: repo.split('/')[1],
          owner: { login: repo.split('/')[0] },
          private: false,
          default_branch: 'main',
          clone_url: `http://github.test/${repo}.git`,
          permissions: { push: true, pull: true, admin: false },
        });
      }

      /* POST /repos/{repo}/pulls —— 建 */
      const create = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(pathname);
      if (create && req.method === 'POST') {
        const repo = decodeURIComponent(create[1]);
        if (!body.title) return send(res, 422, { message: 'Validation Failed', errors: [{ message: 'title is required' }] });
        if (!body.head || !body.base) return send(res, 422, { message: 'Validation Failed: head and base are required' });
        if (body.head === body.base) return send(res, 422, { message: `Validation Failed: No commits between ${body.base} and ${body.head}` });
        const dup = list(repo).find((p) => p.state === 'open' && p.head === body.head);
        if (dup) return send(res, 422, { message: `Validation Failed: A pull request already exists for owner:${body.head}.`, existing: dup.number });
        const p = { ...seed(repo, { title: body.title, body: body.body, head: body.head, base: body.base, draft: body.draft, author: 'bandi' }) };
        p.title = body.title;
        return send(res, 201, rawPull(repo, p));
      }

      /* GET /repos/{repo}/pulls —— 列（state / head / base 过滤都要支持：查重靠 head 过滤） */
      const listGet = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(pathname);
      if (listGet && req.method === 'GET') {
        const repo = decodeURIComponent(listGet[1]);
        let out = list(repo);
        const state = u.searchParams.get('state');
        if (state && state !== 'all') out = out.filter((p) => p.state === state);
        const head = u.searchParams.get('head');
        if (head) {
          const branch = String(head).includes(':') ? String(head).split(':')[1] : String(head);
          out = out.filter((p) => p.head === branch);
        }
        const base = u.searchParams.get('base');
        if (base) out = out.filter((p) => p.base === base);
        return send(res, 200, out.map((p) => rawPull(repo, p)));
      }

      /* PUT /repos/{repo}/pulls/{n}/merge —— 合（sha 乐观锁 + 404/405 都要还） */
      const merge = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/merge$/.exec(pathname);
      if (merge && req.method === 'PUT') {
        const repo = decodeURIComponent(merge[1]);
        const p = list(repo).find((x) => x.number === Number(merge[2]));
        if (!p) return send(res, 404, { message: 'Not Found' });
        if (p.state !== 'open') return send(res, 405, { message: 'Pull Request is not mergeable' });
        if (body.sha && p.headSha && body.sha !== p.headSha) return send(res, 409, { message: 'Head sha does not match' });
        p.state = 'merged';
        p.mergeMethod = body.merge_method ?? 'merge';
        return send(res, 200, { merged: true, message: 'Pull Request successfully merged', sha: 'sha-merge-1' });
      }

      /* GET /repos/{repo}/pulls/{n} —— 查单条（合并闸与状态回写都读它） */
      const one = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(pathname);
      if (one && req.method === 'GET') {
        const repo = decodeURIComponent(one[1]);
        const p = list(repo).find((x) => x.number === Number(one[2]));
        if (!p) return send(res, 404, { message: 'Not Found' });
        return send(res, 200, rawPull(repo, p));
      }

      /* GET /repos/{repo}/pulls/{n}/files + check-runs：审阅闸要读，给空就够（本域不测闸） */
      if (/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/files$/.test(pathname)) return send(res, 200, []);
      const checksReq = /^\/repos\/([^/]+\/[^/]+)\/commits\/([^/]+)\/check-runs$/.exec(pathname);
      if (checksReq && req.method === 'GET') {
        const repo = decodeURIComponent(checksReq[1]);
        const sha = decodeURIComponent(checksReq[2]);
        const state = checks.get(`${repo}#${sha}`) ?? 'none';
        const run = (conclusion) => ({ name: 'ci', status: 'completed', conclusion });
        return send(res, 200, {
          check_runs:
            state === 'success' ? [run('success')]
            : state === 'failure' ? [run('failure')]
            : [],
        });
      }

      /* DELETE /repos/{repo}/git/refs/heads/{branch} —— 合完删源分支 */
      const ref = /^\/repos\/([^/]+\/[^/]+)\/git\/refs\/heads\/(.+)$/.exec(pathname);
      if (ref && req.method === 'DELETE') {
        deletedRefs.push(decodeURIComponent(ref[2]));
        return send(res, 204, {});
      }

      /* ---- Actions：gate 明细下钻 + 重跑（2026-10-29 "修复功能"）—— 最小实现，够钉契约 ---- */
      const actList = /^\/repos\/([^/]+\/[^/]+)\/actions\/runs$/.exec(pathname);
      if (actList && req.method === 'GET') {
        const repo = decodeURIComponent(actList[1]);
        const sha = u.searchParams.get('head_sha') ?? '';
        const row = actions.get(`${repo}#${sha}`);
        return send(res, 200, { workflow_runs: row ? row.runs.map((r) => ({ ...r, head_sha: sha })) : [] });
      }
      const actJobs = /^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/jobs$/.exec(pathname);
      if (actJobs && req.method === 'GET') {
        const found = [...actions.values()].find((x) => x.runs.some((r) => r.id === Number(actJobs[2])));
        return send(res, 200, { jobs: found ? found.jobs : [] });
      }
      const actRerun = /^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/rerun$/.exec(pathname);
      if (actRerun && req.method === 'POST') {
        const runId = Number(actRerun[2]);
        const found = [...actions.values()].find((x) => x.runs.some((r) => r.id === runId));
        if (!found) return send(res, 404, { message: 'Not Found' });
        reruns.push(runId);
        found.runs.forEach((r) => { if (r.id === runId) r.conclusion = null; }); // 重跑后回到"在跑"
        return send(res, 201, {});
      }

      return send(res, 404, { message: `假 GitHub 里没有这个地址：${req.method} ${pathname}` });
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  return {
    port,
    pulls,
    calls,
    deletedRefs,
    seed,
    seedChecks,
    /** 预置 Actions run（gate 明细 / 重跑的用例）：默认一条失败的 run，jobs 可选 */
    seedActions: (repo, sha, { conclusion = 'failure', jobs = [] } = {}) => {
      const run = { id: ++nextRunId, conclusion, html_url: 'http://github.test/log' };
      actions.set(`${repo}#${sha}`, { runs: [run], jobs });
      return run;
    },
    failWith,
    /** 被 POST /rerun 过的 run id（断言"重跑真的打到 GitHub"） */
    reruns,
    /** 某个正则命中过的请求（断言"建 PR 到底怎么调的"） */
    hits: (re) => calls.filter((c) => re.test(`${c.method} ${c.pathname}`)),
    lastHit: (re) => calls.filter((c) => re.test(`${c.method} ${c.pathname}`)).pop() ?? null,
    reset: () => {
      pulls.clear();
      calls.length = 0;
      deletedRefs.length = 0;
      checks.clear();
      actions.clear();
      reruns.length = 0;
      forced = null;
      nextNumber = 100;
    },
    stop: () => new Promise((r) => server.close(r)),
  };
}
