# 把控制面部署到一台 Linux 服务器

**这份手册的用途**：在你那台火山服务器上跑起班底的**控制面**，然后从自己的机器上用 SSH 隧道访问、并让本机作为一个**节点**报到上去。这是「托管控制面 ＋ 客户端出站节点」这个形态的**第一次跨机验证**。

> ⚠️ **先读这一条：现在还没有鉴权。**
> `LOCAL_USER` 是写死的，来源守卫（`guardWrite`）只挡"借你的浏览器使坏"，**不认证任何调用方**。
> 所以本手册让它**只听本机**，外面走 SSH 隧道。**不要**把 8787 开到公网。
> 鉴权是独立的一步，别和"先跑起来看看"混在一起。

> **现状说明（2026-10-28）**：自这天起，**多机协同降为可选实验特性，单机是默认形态** ——
> 每台机器跑一个完整班底、各自一份数据；真要跨机协作，推荐项目走 git 仓库 ＋ PR
> （见 [docs/形态决策.md](../docs/形态决策.md) 十四节）。
> 本文档开头的历史叙述（托管控制面 ＋ 出站节点的第一次跨机验证）保留不动；
> 「四、让本机成为一个节点」对应的就是这条已降级的实验线 —— 节点协议冻结（不加功能，不推荐新用户用）。
> 从外面访问这台机器走隧道，见「三之二、公网访问：隧道三选一」。

---

## 推荐：离线安装包（一条命令装好，2026-10-22 起）

在本机打包（Windows 上也能打，`dist/bandi-linux-x64-v<版本>.tar.gz`，**含随包 node**，目标机不用预装任何东西）：

```sh
node deploy/pack-linux.mjs
```

传上去装（有 root/sudo 的机器）：

```sh
scp dist/bandi-linux-x64-v<版本>.tar.gz bandi@<ip>:/tmp/
# 版本号由 pack-linux 从 apps/desktop/version.json 读，别在文档里写死当前号
# 服务器上：
tar xzf /tmp/bandi-linux-x64-*.tar.gz -C /tmp && cd /tmp/bandi
sudo sh install.sh                    # 装好即起：systemd + bandi 命令自动注册
sudo sh install.sh --uninstall        # 卸载（数据保留）；加 --purge 连数据删
```

改端口/监听：`BANDI_PORT=8899 BANDI_HOST=0.0.0.0 sudo -E sh install.sh`。
没有 root 就用不了 /opt 落点，继续走下面的 **B：用户态** 路线（拷源码），两条路都通向同一套代码。

---

## 零、先判断：这台机器有没有 root

```sh
sudo -n true 2>/dev/null && echo "有免密 sudo" || echo "没有免密 sudo"
```

- **有** → 走 **A：系统级 systemd**（「二、装」那条路），带开机自启与崩溃重启。
- **没有** → 走 **B：用户态**（下面这段）。功能一样，只是进程归你自己管、自启靠 crontab。

> **本仓库实测跑通的是 B。** 火山引擎一台 Ubuntu 机器（内核 6.8、x86_64）：
> `bandi` 用户**没有**免密 sudo、系统里**没有** Node、也**没有** git。

### B：用户态装法（无 root）

```sh
# 1) Node 装进自己的家目录（不碰系统）
mkdir -p $HOME/.local/node /tmp/bandi-dl && cd /tmp/bandi-dl
curl -fsSL -m 240 -o node.tar.xz https://npmmirror.com/mirrors/node/v22.21.0/node-v22.21.0-linux-x64.tar.xz \
  || curl -fsSL -m 240 -o node.tar.xz https://nodejs.org/dist/v22.21.0/node-v22.21.0-linux-x64.tar.xz
tar xf node.tar.xz -C $HOME/.local/node --strip-components=1
$HOME/.local/node/bin/node -v      # 要 v22.x

# 2) 代码传到 ~/bandi。这台机器上没有 git，所以从**本机推**：
#    在你自己机器上（<key> <ip> 换成你的；Windows 用 OpenSSH 自带的 tar/scp）：
#      tar -czf /tmp/bandi-src.tgz --exclude=./.git --exclude=./tmp \
#          --exclude=./data --exclude=./apps/desktop/target .
#      scp -i <key> /tmp/bandi-src.tgz bandi@<ip>:/tmp/
#    然后在这台机器上：
mkdir -p $HOME/bandi && tar xzf /tmp/bandi-src.tgz -C $HOME/bandi && rm -f /tmp/bandi-src.tgz
chmod +x $HOME/bandi/deploy/start-control-plane.sh

# 3) 起（数据落 ~/bandi-data，**不在代码目录里**，升级不会冲掉）
$HOME/bandi/deploy/start-control-plane.sh start
$HOME/bandi/deploy/start-control-plane.sh status
tail -6 $HOME/bandi-data/server.log     # 应看到「数据目录：/home/bandi/bandi-data」

# 4) 开机自启（无 root 的办法，装不装你自己定）
crontab -e
#   加一行：
#   @reboot /home/bandi/bandi/deploy/start-control-plane.sh start
```

> ⚠️ **在 Windows 上打包时别被乱码骗了。**
> `tar.exe`（bsdtar）**能**正确处理中文文件名；PowerShell 控制台里那串 `��̬����.md`
> 是按 GBK 解码 UTF-8 造成的**显示**假象。判断对不对只有一个办法：
> **在 Linux 上解压后核对文件数**（实测 112 个文件一个不差；`docs/形态决策.md`
> 的名字在服务器上是好的，`find … -printf '%f' | wc -c` = 15，正是它的 UTF-8 字节数）。
>
> ⚠️ **同一个坑会真的毁文件**：别拿 PowerShell 5.1 的 `Get-Content` / `Set-Content`
> 去**改源码**。它按 ANSI（中文机器上就是 GBK）解码无 BOM 的 UTF-8 —— 不只是中文变乱码，
> GBK 是双字节编码，还会**把行尾的字节当成第二个字节吃掉**，于是换行也丢了。
> 改文件用编辑器/`edit` 工具，别走这个往返。（2026-10-15 实测踩到，一份新用例被写坏、
> 因为没进版本控制而无法 `git checkout` 回来，只能整份重写。）

---

## 一、前置

| 要什么 | 说明 |
| --- | --- |
| Linux（x86_64） | 火山、阿里云、腾讯云都行 |
| **Node 22+** | 服务端用 `node:sqlite`（Node 22 起内置）。实测 22.21 不需要任何 flag，只会打一条 `ExperimentalWarning` |
| 一个能 ssh 的账号 | 建议非 root，能 sudo |
| 磁盘 | 极小。仓库去掉 `target/`、`tmp/`、`data/` 之后约 **1.9 MB**，服务端实际用到 543 KB |

**零依赖**：整个服务端只用 Node 内置模块（`node:http`、`node:sqlite`、`node:child_process`）。
**不需要 `npm install`，不需要构建，不需要装数据库。**

装 Node 22：

```sh
# NodeSource（Debian/Ubuntu）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v     # 要 >= 22
```

---

## 二、装（**A：有 root 时走这条**）

```sh
# 1) 服务账号 + 两个目录
#    /opt/bandi       —— 代码（升级时整个换掉）
#    /var/lib/bandi   —— 数据（库、账本、运行时配置…**升级时绝不动它**）
sudo useradd --system --create-home --shell /usr/sbin/nologin bandi
sudo mkdir -p /opt/bandi /var/lib/bandi
sudo chown -R bandi:bandi /var/lib/bandi

# 2) 代码上去。二选一：

#    (a) 从 gitee 拉（想重复部署就用这条；前提是改动已经 push 上去）
sudo -u bandi git clone https://gitee.com/cm9531/bandi.git /opt/bandi

#    (b) 从本机推（**第一次试跑推荐**，不用先 commit）
#        在**你自己的机器上**执行：
#        rsync -av --delete \
#          --exclude '.git' --exclude 'tmp' --exclude 'data' --exclude 'apps/desktop/target' \
#          ./  <你的账号>@<火山IP>:/tmp/bandi-src/
#        然后在服务器上：
#        sudo rsync -a --delete /tmp/bandi-src/ /opt/bandi/ && sudo chown -R bandi:bandi /opt/bandi

# 3) 语法自检（不启服务，只确认代码能加载）
sudo -u bandi env BANDI_DATA=/var/lib/bandi node /opt/bandi/apps/server/src/server.mjs &
sleep 2 && curl -s http://127.0.0.1:8787/api/state | head -c 120; echo
sudo pkill -f 'apps/server/src/server.mjs'

# 4) 交给 systemd
#    ⚠️ 先确认 node 在哪：`which node`。单元里写的是 /usr/bin/node（NodeSource 装法）；
#       用 nvm 或别的方式装的话，把它改成 `which node` 的输出（绝对路径，别用 shell 的 PATH）。
which node
sudo cp /opt/bandi/deploy/bandi.service /etc/systemd/system/bandi.service
sudo systemctl daemon-reload
sudo systemctl enable --now bandi
systemctl status bandi --no-pager
journalctl -u bandi -n 30 --no-pager
```

启动日志里会打出来**数据落在哪**，先确认这两行：

```
数据目录：/var/lib/bandi
数据库：/var/lib/bandi/bandi.db
```

---

## 三、访问：SSH 隧道（推荐）

在**你自己的机器**上开一条隧道，把远端的 8787 映射到本地的 **9787**：

```sh
ssh -N -L 9787:127.0.0.1:8787 <你的账号>@<火山IP>
```

> 为什么映射到 9787 而不是 8787：本机开发时自己也占着 8787。两个控制面同时存在是对的 —— 只是别让端口撞上。

然后本机浏览器打开 **http://127.0.0.1:9787** 。走隧道时，浏览器看到的源就是 `http://127.0.0.1:9787`…
**等等**：隧道的出口是远端，但**服务器上的 `allowedOrigins()` 只认远端那台的 `127.0.0.1:8787`**，
所以从隧道进来的写请求会被判 403（能看，不能动）。

**两种解法，选一个：**

1. **让本地端口与远端一致**（最省事）：把隧道映射成 `8787:127.0.0.1:8787`，
   但先确认本机没别的服务占 8787（`netstat -ano | findstr :8787`）。这样源就是 `http://127.0.0.1:8787`，正好在白名单里。
2. **把来源加进白名单**：在服务器上给服务加 `Environment=BANDI_ORIGINS=http://127.0.0.1:9787`，
   然后 `systemctl daemon-reload && systemctl restart bandi`。

---

## 三之二、公网访问：隧道三选一（2026-10-28 起）

**先说形态**：班底按**单机形态**跑 —— 每台机器是一个完整实例（自己的库、项目、员工、会话）。
要从外面访问这台机器（手机、笔记本、给外部人看一眼），用**隧道**把它接出去；
隧道/转发中心**只转发、不存状态、不派活** —— 它挂了只影响远程访问，本机照常用。

| 方案 | 适合 | 代价 |
| --- | --- | --- |
| tailscale | 私有网络，只有自己的设备能进 | 每台装客户端；对外分享不方便 |
| cloudflared Tunnel | 走域名 ＋ Cloudflare Access 身份（能按邮箱/OTP 做真身份） | 依赖 Cloudflare；配置稍多 |
| frp | 有自己的 VPS，想完全自控 | 自己维护 frps、TLS、认证 |

**选型建议**：自用优先 tailscale；要给手机/外部人看用 cloudflared ＋ Access；已经有机房 VPS 就 frp。
**三者都不改代码**，只是把 `127.0.0.1:8787` 接出去 —— 班底对"从哪进来"没有意见。
（cloudflared 的用法与取舍另见 [docs/形态决策.md 十三节](../docs/形态决策.md)。）

**安全底线（不管选哪条都要守）**：

- 服务**只监听回环**（默认如此），隧道在机器上连回环 —— 上一节的 SSH 隧道、cloudflared、frp 都是这个姿势；
- 监听非回环时**令牌必开**（规则只看监听地址，见第六节）—— 隧道方案里这条可以不触发，
  但**别为了省事把 `BANDI_HOST` 改成 `0.0.0.0`**；
- 一律 HTTPS/TLS（tailscale 自带加密；cloudflared 自带 TLS；frp 要自己配）；
- **别把 `0.0.0.0:8787` 直接放公网** —— 隧道后面是能执行命令的完整应用，身份这道闸必须有人守
  （tailscale 的私有网、Access 的邮箱验证、强令牌，任选其一，但不能没有）。

---

## 四、让本机成为一个节点，并真的把活派过去（实验）

节点**主动连出**，所以不用在服务器上开任何端口、不用配 SSH 反向通道。
**多机协同自 2026-10-28 起为实验特性，节点协议已冻结 —— 只修 bug、不加功能；
新用户要用远程访问，优先走「三之二」的隧道方案把单机接出去，别从这条实验线进门。**

在**你自己的机器**上（Windows 用 `start-node.cmd` 也行）：

```sh
# 走隧道：控制面地址就是隧道那一头
set BANDI_CONTROL_PLANE=http://127.0.0.1:8787          # Windows cmd
# export BANDI_CONTROL_PLANE=http://127.0.0.1:8787     # Linux/macOS

# 直连公网：控制面监听非回环，所以**必须带令牌**（令牌在服务器 $HOME/bandi-data/token）
set BANDI_CONTROL_PLANE=http://<你的公网IP>:8787
set BANDI_NODE_TOKEN=<控制面令牌>

node apps/server/src/node.mjs
```

期望看到：

```
[节点] 控制面 http://<你的公网IP>:8787
[节点] 我是 <机器名>（node-xxxxxxxx）· win32 x64
[节点] 探到 N 个运行时：Codex CLI、Claude Code…
[节点] 报到成功：心跳每 15 秒一次，同时挂着等活
```

**忘了带令牌**它不会闷着，会直接说："报到被拒：这个控制面要求访问令牌 …… 设 `BANDI_NODE_TOKEN=<令牌>` 再起节点"。

### 怎么把活派到那台机器上

在浏览器里：`设置 → 运行时 → 员工`，把某个员工的 **Runtime** 选成带机器名的那条
（如 `Codex CLI（台式机）`）—— 之后这个人的活就**排到那台机器上**，由它来跑，跑的过程照旧实时流回这里。

- **那台机器不在线也不会丢**：活排队等着，它一上线自己领走（离线排队）。
  设备列表里那台机器会显示「排队 N」。
- **停止**照样有用：节点每 2 秒发一个空批次心跳，所以它一声不吭时也掐得掉。
- **它掉线了**：正在跑的那次判**中断**（那边进程可能还在跑，去那台机器上看一眼）；
  还没开张的活**放回队列**。
- **工作目录**：控制面传的是**它那台机器**的路径。那台机器上没有这个目录时会**明确失败**，
  不会悄悄换个目录干活（要做的是"每台机器各配一份项目路径"，还没做）。
- **排队的活会一直等**那台机器回来。不想等了就点停止。

### 那台机器上的 CLI 用哪个

控制面只告诉它"用哪个**族**"（codex / claude / dsh），**路径由它自己定**：
先看那台机器自己的 `runtimes.json`（`设置 → 运行时 → 设备 → 本机`里接的那些），再自动探测。
所以"我装了但班底没认出来"要**在那台机器上**接，不是在控制面上改（控制面上改节点运行时会被拒，并说明原因）。

### 想换台机器试 / 旧机器一直"离线"？

节点身份认的是它自己的状态文件（默认 `<数据目录>/node.json`）。换了数据目录、或者文件丢了，
它会用**新身份**再报到一次 —— 老的那一行就永远"离线"躺着。在**设备详情页**点「忘掉这台机器」删掉它
（它身上压着的活会一并收掉）。

---

## 五、运维

```sh
journalctl -u bandi -f                  # 看日志
sudo systemctl restart bandi            # 重启（⚠️ 正在跑的执行会被判「中断」，见下）
sudo systemctl stop bandi
```

**重启的代价（现在如此，将来要改）**：进程一起来就执行「启动清账」——把库里还写着 `跑中` 的运行
判成失败，并补一条终止事件。所以**重启会打断正在跑的活，而且不能续跑**。
「中断续跑」是待办项（见 `docs/形态决策.md` §十一 ④）。别在有活跑着的时候重启。

**数据与备份**：全部在 `/var/lib/bandi`。

```sh
ls /var/lib/bandi
# bandi.db  bandi.db-wal  bandi.db-shm   ← 库（WAL 模式，三个文件是一套）
# runtimes.json  plugins.json  connectors.json  node.json  …
sudo systemctl stop bandi                # 备份前停一下最稳（WAL 还没合并）
sudo tar czf /tmp/bandi-$(date +%F).tgz -C /var/lib bandi
sudo systemctl start bandi
```

**升级**：换掉 `/opt/bandi` 的代码，然后 `systemctl restart bandi`。
`/var/lib/bandi` 不要动 —— 库表结构是**启动时自动迁移**的（`store.mjs` 里那一批 `ensureColumn` / 建表）。

### 五之二、开机自启（班底自带，2026-10-16）

**为什么要做**：没有自启时，控制面 / 节点**一没就什么都不会自己回来**。实测踩到过一次：
晚上起的三个进程，8 小时后全没了，而机器**没重启**（uptime 32 小时）—— 从终端会话里起的进程，
会话一收就被一并回收。用户的感受就是"昨晚还好，早上全打不开了"。

所以它是**一条命令**，不是"每台机器手工配一遍"：

```sh
node apps/server/src/autostart.mjs status              # 现在装了什么、走哪种方式
node apps/server/src/autostart.mjs install             # 两个守护都装上
node apps/server/src/autostart.mjs install node        # 只装执行节点（干活的机器装这个）
node apps/server/src/autostart.mjs remove              # 卸掉
```

两个目标：`node`（这台机器当执行节点）／`control-plane`（这台机器当控制面）。
节点连哪个控制面，看**装的时候**环境里的 `BANDI_CONTROL_PLANE`（默认 `http://127.0.0.1:8787`）——
所以给云端那台装要写成：

```sh
BANDI_CONTROL_PLANE=http://<你的公网IP>:8787 node apps/server/src/autostart.mjs install node
```

**各平台走什么**（优先正规做法，退化才用土办法）：

| 平台 | 首选 | 退化 |
| --- | --- | --- |
| Linux | `systemd --user` 单元 ＋ `loginctl enable-linger`（**开机不必先登录**） | `crontab @reboot` ＋ 自带重连循环的脚本 |
| Windows | Startup 文件夹里的 `.vbs`（**隐藏窗口**）＋ 带循环的 `.cmd` | — |
| macOS | `~/Library/LaunchAgents/*.plist`（`KeepAlive`） | — |

**实测过的两处**（2026-10-16）：

- **Windows**：装上 → 从 Startup 的 vbs 起 → 控制面 200、节点在云端显示在线、**0 个可见控制台窗口**。
- **Linux（ThinkPad-P15）**：`systemd --user` + `Linger=yes`；**故意 `kill -9` 主进程，
  12 秒后 systemd 把它拉回来了**（PID 变、服务仍 `active`）—— 这是 crontab 那条给不了的。

**四个坑（都是实测踩出来的）**：

1. **一台机器有两个数据目录，别合成一个**。控制面那份装编排数据（库）＋**它自己的**访问令牌；
   节点那份装**它的身份**＋**连控制面用的**令牌。合成一个会串味三处：纯 worker 机器上莫名多一个库、
   "用哪枚令牌"含糊、身份文件挪窝让控制面上**多出一台僵尸设备**。
   第一次生成就是这么翻车的：节点拿仓库 `data/` 当数据目录 → 找不到令牌 → 报到被拒 **401**。
   节点那份默认在 `%APPDATA%\bandi-node` / `~/.bandi-node`（与手工部署时一致，换过来身份不用搬）；
   要改就用 `BANDI_NODE_DATA`。
2. **启动脚本的重定向不能指向应用自己的日志**。`control-plane.cmd` 一度写成
   `start.mjs >> data\server.log`，而 `start.mjs` **自己也要打开 `server.log`** 把 fd 交给
   脱胎出去的服务 —— 同一个文件被两处打开，Windows 上直接 `EBUSY`，控制面起不来
   （日志里只有一段 `openSync` 堆栈）。所以启动脚本写 `autostart-control-plane.log`（`outLog`），
   应用写 `server.log`（`appLog`）。
3. **生成的 `.cmd` / `.vbs` 必须纯 ASCII**（Windows 那条）。wscript / cmd 按**系统 ANSI 页**读脚本；
   UTF-8 的中文注释被按 GBK 解时某些字节序列会**把换行一起吃掉** —— 下一行并进注释，
   `Set sh = CreateObject(...)` 整行消失，vbs 报 `缺少对象: 'sh'`，**自启静默失效**。
   所以那些文件由 `ascii()` 生成，中文只留在 `autostart.mjs` 里。
4. **别用 `Start-Process` 起，也别指望它常驻**。那样进程留在你终端的进程组里，会话一收就被回收
   （就是"全没了"的原因）。要现在就起，用 WMI 起 `wscript`（父进程是 WmiPrvSE，脱离会话）：
   ```powershell
   Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
     -Arguments @{ CommandLine = 'wscript.exe "<Startup 里的那个 vbs>"' }
   ```
   这条**也是登录时走的那条路** —— 所以"现在起得来"和"以后开机起得来"验的是同一件事。

**只自启两个守护进程**。桌面版是**窗口**不是服务，不该每次登录自己弹出来；控制面已经在跑，
所以点桌面版是秒开的（壳会复用它）。

**出口 IP 变了怎么办**：安全组那条 8787 规则是按**来源 IP** 放的，而家宽出口会变
（实测一天变过一次：`<旧出口IP>` → `<新出口IP>`）。症状是**浏览器和节点一起连不上**，
而服务本身好着。两条路：

- **临时**（不碰控制台）：SSH 隧道，本机 `8790` → 云端 `127.0.0.1:8787`，自愈重连
  （`ssh -N -L 8790:127.0.0.1:8787 <你的账号>@<控制面IP>`）。浏览器开 `http://127.0.0.1:8790/`；
  节点把 `BANDI_CONTROL_PLANE` 改成 `http://127.0.0.1:8790`。
- **根治**：别按 IP 放行 —— 要么开 `0.0.0.0/0` 只靠那枚令牌（弱），要么上
  **Cloudflare Tunnel**（不开端口、不管出口 IP、还带身份；见 [形态决策 §十三](../docs/形态决策.md)）。

---


## 六、真要开公网时（2026-10-15 实测做过一遍）

**闸有两道**：① **访问令牌**（2026-10-15 起，监听非回环就自动开）；② 来源白名单（CSRF，防"借你的浏览器使坏"）。

令牌是**一枚共享的**，不是账号体系 —— 拿到它的人就是「我」（`local-user`）。单操作员自托管够用；
要多人各看各的，那是另一件事（还没做）。

**节点现在用的是它们自己那枚**（2026-10-16 起）：控制面发一个**一次性邀请码** → 节点凭它换回
**只属于自己**的令牌（`<节点数据目录>/config.json`），权限只到"它自己那台的节点接口" ✓，
可以逐台吊销（「忘掉」= 连令牌一起吊销 ✓）。所以那枚共享令牌只给**操作员**用（浏览器 / 脚本）。

**为什么不做用户名＋密码**（2026-10-16 定）：改善的只是"记得住"，**不是更安全** ——
明文 HTTP 下令牌、密码、会话票一样会被抓包；真要防抓包得**加密链路**（SSH 隧道 / Cloudflare 隧道 / TLS）。
而随机令牌被抓**只赔这一个面板**且**能一键换掉**，人设的密码一旦和别处重复就赔一串账号。
理由完整版写在 `apps/server/src/auth.mjs` 文件头，别处别再绕回来问一遍。

### 具体三步

**① 服务端**（改完必须重启）：

```sh
$HOME/bandi/deploy/start-control-plane.sh stop
BANDI_HOST=0.0.0.0 BANDI_ORIGINS=http://<你的公网IP>:8787 \
  $HOME/bandi/deploy/start-control-plane.sh start
```

- `BANDI_HOST=0.0.0.0` 才会听非本机，**同时也就把令牌这道闸打开了**；
- `BANDI_ORIGINS` 必须和你在浏览器里输入的地址**逐字一致**（带 `http://`、带端口）。
  不配它，页面照常显示，但**每个写请求都 403** —— 这是最容易卡住人的一处。

**② 云安全组**：入方向放行 **TCP 8787**，来源填**你自己的出口 IP `/32`**（别用 `0.0.0.0/0`）。
出口 IP 随时可查：`curl -s https://ip.3322.net`。

**③ 系统层防火墙**：`systemctl is-active ufw` 报 `active`，但 `/etc/ufw/ufw.conf` 里是 `ENABLED=no`
—— 两个信号**矛盾**，以实测为准：安全组放行后从外面连一次。真连不通才是系统层在挡，
那时需要 root：`sudo ufw allow 8787/tcp`（`bandi` 用户没有 sudo，得走云控制台的 root 或 root 密钥）。

### 令牌在哪、怎么用

```sh
cat $HOME/bandi-data/token          # 32 字符
# Windows：type <数据目录>\token      例：type %APPDATA%\bandi\token
#（⚠️ 它**不再**打进启动日志了 —— 日志会被贴出去、被备份，而它等于整套控制权）

- **浏览器**：打开 `http://<你的公网IP>:8787/` → 会看到一张登录页 → 把令牌填进去。
  填对之后记进 **HttpOnly Cookie**，之后不用再填（刷新、SSE 重连都自动带）。
  也可以直接 `http://<你的公网IP>:8787/?token=<令牌>`，它会换成 Cookie 并**重定向掉**，
  免得令牌留在地址栏和历史里。
- **节点 / 脚本**：带 `X-Bandi-Token: <令牌>` 头。节点也可以设 `BANDI_NODE_TOKEN`。
- **换令牌**（怀疑泄漏了）：删掉 `$HOME/bandi-data/token` 再重启控制面，会生成新的。
- **不想让它落盘**：启动时用 `BANDI_TOKEN=<你的值>` 指定，它就只活在环境变量里。

### 怎么确认自己没踩「能看不能动」

在服务器上跑：

```sh
T=$(cat $HOME/bandi-data/token)
curl -s -o /dev/null -w 'no_token=%{http_code}\n'    http://127.0.0.1:8787/api/state
curl -s -o /dev/null -w 'with_token=%{http_code}\n' -H "X-Bandi-Token: $T" http://127.0.0.1:8787/api/state
```

- `no_token=401` ＝ 闸是关着的（对）；
- `with_token=200` ＝ 令牌能用；
- 若带令牌仍是 **403**，那是**来源**闸：核 `BANDI_ORIGINS` 是不是逐字一致。

### 开之前想清楚的一件事

现在这台上 `runtimes: []`（没装任何 agent CLI），节点也还不能领活，所以最坏是
**拿到令牌的人能读改编排数据**（会话、任务、项目路径），**执行不了任何命令**。
但等「节点领活」做完、你的机器一注册成节点，**拿到令牌的人就能指挥那台机器** ——
风险等级完全不同。届时要么把令牌当私钥看待，要么就该上真账号体系了。

---

## 七、排障

| 现象 | 多半是什么 |
| --- | --- |
| `Failed to load ... node:sqlite` | Node 版本太低。要 22+ |
| 页面打开是空白/连不上 | 隧道没开、或端口映射不一致（见第三节） |
| 页面能看，一动手就 403 | 来源不在白名单 —— 改 `BANDI_ORIGINS`，或让本地端口与远端一致 |
| 启动就退出，日志说 `EACCES` | `/var/lib/bandi` 属主不对（要 `bandi:bandi`） |
| 数据"不见了" | 多半在看另一个数据目录。**启动日志第二行就写着它在哪** |
| 节点报到失败 404 | 控制面换过库（节点记录没了）—— 节点会自己重新报到，等一个心搏周期 |

---

## 八、局域网加入总机：Windows 防火墙放行（R1）

一台总机要被局域网里的机器「加入」，除了在 班底 → 设置 → 运行时 → 局域网 里打开开关并点重启，
Windows 自带的防火墙还拦着两个端口：

| 端口 | 协议 | 干什么用 |
| --- | --- | --- |
| 8787 | TCP | 控制面本身（页面、接口、SSE） |
| 8788 | UDP | 局域网自动发现（总机的应答器听在这里） |

**需要管理员手动执行，程序不会自动改防火墙**（静默改系统安全设置比功能不灵更糟）。
在总机那台 Windows 机器上，用**管理员身份**打开 PowerShell 或 CMD，执行：

```bat
netsh advfirewall firewall add rule name="bandi control plane 8787" dir=in action=allow protocol=TCP localport=8787
netsh advfirewall firewall add rule name="bandi lan discover 8788" dir=in action=allow protocol=UDP localport=8788
```

撤掉时（比如不再当总机了）：

```bat
netsh advfirewall firewall delete rule name="bandi control plane 8787"
netsh advfirewall firewall delete rule name="bandi lan discover 8788"
```

> - 只在**内网环境**当总机时才需要这两条；只自己一台机器用（只听回环）不用管。
> - 发现被防火墙拦住时**手填地址这条路不受影响**（加入向导第 3 步的兜底），但自动扫描会扫不到。
> - 加完之后不用重启班底：向导里点「重新扫描」即可。

