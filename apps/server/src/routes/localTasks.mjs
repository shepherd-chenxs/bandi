/*
 * routes/localTasks.mjs —— **本机软件商店一键安装任务通道**。
 *
 * 多机节点子系统（节点领活 / 回执 / 邀请码 / join / 过程回传）2026-11-09 已整体删除
 * （无存量机）。这里只保留它的**本机那半**：插件页「软件」商店条目的任务下发与进度
 * 查询 —— nodeId 恒为 'local'，任务由控制面进程内直接执行（runLocalExternal），不走
 * "谁先来领"的队列序。
 *
 * 路径从原 /api/nodes/local/tasks 改挂 /api/install/tasks，**响应形状一个字节没变**
 * （前端只改路径）。主分发顺序见 ./chain.mjs 的 CHAIN。
 */

import os from 'node:os';
import { sendJson, fail, readBody } from '../http.mjs';
import * as store from '../store.mjs';
import * as runtimes from '../runtimes.mjs';
import * as externals from '../externals.mjs';

/**
 * **本机就地执行**一件外部件任务（2026-11-04）：插件页「软件」商店条目 —— 用户点一下就装。
 *
 * 为什么现在给本机开了（原来是"复制命令去终端粘"，2026-10-16 定的）：
 * 用户要把 magpie 当软件商店条目 —— "我点一下就可以直接安装了，不要再去找命令或者安装包"。
 * 那条旧边界防的是"控制面替用户跑来路不明的命令"，不是"一键"本身；现在命令仍然**只能来自
 * externals.commandFor 这张写死的表**（调用方递不进命令），Windows 上那条是"下载官方
 * 固定下载口的安装包 + 启动它自己的安装程序"，安装界面是 magpie 的 —— 边界没松。
 *
 * （2026-11-04：原来并排的 `runLocalInstall` —— 装运行时那半 —— 已随 install-runtime
 * 通路整体拆除，"班底只识别、不代装"；这里只剩外部件这一种。）
 *
 * 与被拆掉的那位的一点不同：命令表是 externals 的；Windows 上不包一层 `cmd /c`
 * （表里那条自己就是 cmd.exe 整行，且要 windowsVerbatimArguments ——
 * 见 externals.mjs install.win32 的注释）。
 */
async function runLocalExternal(taskId) {
  const task = store.claimNodeTaskById(taskId);
  if (!task) return; // 已经被领走 / 已经结束：不重复执行
  const step = task.kind === 'external-install' ? 'install' : task.kind === 'external-open' ? 'open' : 'serve';
  const spec = externals.commandFor(step, task.family, `${process.platform} ${process.arch}`, {
    mirror: task.arg ?? '',
  });
  if (!spec) {
    store.appendNodeTaskOutput(task.id, '这台机器上的班底不认识这个外部件，或者这一步在这里没法一键做\n');
    return store.finishNodeTask(task.id, 'failed');
  }
  const isWin = process.platform === 'win32';
  const file = spec.raw ? spec.bin : isWin ? process.env.ComSpec || 'cmd.exe' : spec.bin;
  const args = spec.raw ? spec.args : isWin ? ['/c', spec.bin, ...spec.args] : spec.args;

  let buf = '';
  let lastAt = 0;
  const flush = (force = false) => {
    if (!buf) return;
    const now = Date.now();
    if (!force && now - lastAt < 400) return;
    lastAt = now;
    const chunk = buf;
    buf = '';
    store.appendNodeTaskOutput(task.id, chunk);
  };

  console.log(`[本机] 开始处理外部件 ${task.family}（${step}）：${spec.cmd}`);
  let child;
  try {
    const { spawn } = await import('node:child_process');
    child = spawn(file, args, {
      cwd: os.homedir(),
      windowsHide: true,
      windowsVerbatimArguments: !!spec.raw, // 整行进 cmd —— Node 的默认转义会把引号拆烂
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    store.appendNodeTaskOutput(task.id, `起不来：${[e?.code, e?.message].filter(Boolean).join(' ')}\n`);
    return store.finishNodeTask(task.id, 'failed');
  }
  const onData = (c) => {
    buf += String(c);
    flush();
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  let settled = false; // 'error' 与 'close' 只许收尾一次，别把任务判两遍
  const finish = (status, extra = '') => {
    if (settled) return;
    settled = true;
    clearTimeout(killer);
    if (extra) {
      buf += extra;
      flush(true);
    }
    store.finishNodeTask(task.id, status);
  };
  // 兜底超时：安装包下载卡死（网络挂起）不该让这一行永远"执行中"
  const killer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* 已经退了 */
    }
  }, 15 * 60 * 1000);
  killer.unref();
  child.on('error', (e) => {
    finish('failed', `起不来：${e?.message ?? e}\n`);
    console.log(`[本机] 外部件 ${task.family} ${step} 失败：${e?.message ?? e}`);
  });
  child.on('close', (code) => {
    const ok = code === 0;
    finish(ok ? 'done' : 'failed', ok ? '\n好了。\n' : `\n（${spec.bin} 退出码 ${code}）\n`);
    console.log(`[本机] 外部件 ${task.family} ${step}${ok ? '好了' : `失败了（退出码 ${code}）`}`);
  });
}

/**
 * 本机安装任务：**下发**（POST）/ **列表**（GET）/ **单件查询**（GET /:tid）。
 *
 * ⚠️ 只接受**外部件 id**：命令表在本机这侧（`externals.commandFor`），控制面发不出命令。
 * 谁拿着令牌就能在本机跑这张表里的安装/常驻，所以这条边界是这件事成立的前提，
 * 不是"顺手的设计"。
 *
 * 排完任务由**控制面自己执行**（见 runLocalExternal）—— 边界不变，
 * 命令还是那张固定表里的，前端照样只能发 id 与步骤。
 *
 * （2026-11-04：`install-runtime` 这个 kind 随「班底只识别、不代装」整体拆除 ——
 * 装运行时的入口、本机执行器和节点执行器一并清了；任务队列只剩外部件在用。）
 */
export async function handleLocalTasks(req, res, url) {
  const tasks = /^\/api\/install\/tasks$/.exec(url.pathname);
  const oneTask = /^\/api\/install\/tasks\/([^/]+)$/.exec(url.pathname);

  if (req.method === 'POST' && tasks) {
    const body = await readBody(req);
    const kind = String(body?.kind ?? '');
    const target = String(body?.family ?? body?.id ?? '');

    if (kind !== 'external-install' && kind !== 'external-serve' && kind !== 'external-open') {
      return fail(res, 400, 'E1043', '只认这几种小事：external-install / external-serve / external-open');
    }

    /*
     * 一键装（见 runLocalExternal 的注释）：插件页「软件」条目点一下就要装上。
     * 安全边界不变：命令还是**那张表**里的，控制面只发 id 与步骤；
     * 平台按**目标机器**算 —— 本机就是 `${process.platform} ${process.arch}`。
     * external-open（2026-11-04 新增）：把桌面软件自己的面板窗口拉起来 ——
     * Windows 上 magpie 的面板不是网页，是一扇窗口，"打开面板"就是启动那个 exe。
     */
    const step = kind === 'external-install' ? 'install' : kind === 'external-open' ? 'open' : 'serve';
    /*
     * 走镜像装：`mirror` 是个**参数**，不是命令 —— 它会先过 externals.mirrorOk()
     * （它要被拼进 `sh -c '… --mirror "<前缀>"'`，所以带 shell 元字符的一律拒）。
     * 不能过就直接 400，别让它跑到那台机器上再失败。
     */
    const mirror = String(body?.mirror ?? '').trim();
    if (mirror && !externals.mirrorOk(mirror)) {
      return fail(res, 400, 'E1046', '镜像前缀里不能有空格、引号、反引号、$、;、|、& 这些字符（它会被拼进 shell 命令）—— 给一个普通的 https:// 前缀');
    }
    const spec = externals.commandFor(step, target, `${process.platform} ${process.arch}`, { mirror });
    if (!spec) {
      return fail(res, 400, 'E1045', `「${target}」的这一步在这台机器上没法一键做 —— 手工装。`);
    }
    const task = store.enqueueNodeTask({ nodeId: runtimes.LOCAL_ID, kind, family: target, arg: mirror || null });
    console.log(`[本机] 排了个安装任务：${kind} ${target}${mirror ? `（走镜像 ${mirror}）` : ''}`);
    void runLocalExternal(task.id); // 本机：控制面当场跑
    return sendJson(res, 201, { task: store.publicNodeTask(task), willRun: spec.cmd });
  }

  // 本机最近的任务（新的在前）—— 界面拿它画"装过什么"
  if (req.method === 'GET' && tasks) {
    const list = store.listNodeTasks(runtimes.LOCAL_ID, 20).map((t) => store.publicNodeTask(t));
    return sendJson(res, 200, { tasks: list });
  }

  // 界面轮询"装到哪一步了"
  if (req.method === 'GET' && oneTask) {
    const t = store.getNodeTask(decodeURIComponent(oneTask[1]));
    if (!t || t.nodeId !== runtimes.LOCAL_ID) return fail(res, 404, 'E2043', '没有这个任务');
    return sendJson(res, 200, { task: store.publicNodeTask(t) });
  }

  return false;
}
