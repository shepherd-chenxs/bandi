#!/bin/sh
# 用户态起停班底控制面 —— **没有 root 时用这条路径**。
# 有 root 就用 `deploy/bandi.service`（系统级 systemd），那个带开机自启与崩溃重启。
#
#   ./start-control-plane.sh          起（已经在跑就不重复起）
#   ./start-control-plane.sh stop     停
#   ./start-control-plane.sh status   看状态
#
# 为什么要 setsid + nohup：不用它们的话，进程是 SSH 会话的子进程 ——
# 你断开连接它就被收走（或者变成收不到的孤儿）。setsid 让它另起一个会话，SSH 断了也活着。
#
# 开机自启（无 root 时的办法）：`crontab -e` 加一行
#   @reboot /home/bandi/bandi/deploy/start-control-plane.sh start
set -u

NODE="$HOME/.local/node/bin/node"
APP="$HOME/bandi/apps/server/src/server.mjs"
DATA="$HOME/bandi-data"
LOG="$DATA/server.log"
PAT="apps/server/src/server.mjs"

# 想开公网/内网访问时，用环境变量覆盖（默认只听本机）：
#   BANDI_HOST=0.0.0.0 BANDI_ORIGINS=http://<你的公网IP>:8787 \
#     $HOME/bandi/deploy/start-control-plane.sh start
# ⚠️ **BANDI_ORIGINS 不配，远端浏览器就是"能看不能动"** —— 页面正常显示，
#    但每个写请求都被来源闸拦掉（403）。这是最容易踩的一个坑。
PORT="${BANDI_PORT:-8787}"
HOST="${BANDI_HOST:-127.0.0.1}"
ORIGINS="${BANDI_ORIGINS:-}"

# pgrep 匹配的是**完整命令行**：这样不会把别的 node 进程算进来
running() { pgrep -f "$PAT" >/dev/null 2>&1; }
pids() { pgrep -f "$PAT" | tr '\n' ' '; }

# 「部署即装」：把 `bandi` 装成一个全局命令（幂等 —— 装好了什么都不动）。
# 逻辑只在 cli-install.mjs 一份（写 ~/.local/bin/bandi 启动器）；这里显式调一次，
# 盖住 systemd 起法之外的部署；systemd 那条路由服务端启动段自己装。
# ⚠️ 脚本显式设了 BANDI_DATA（真实部署），所以要带 BANDI_INSTALL_CLI=1 放行自动闸门
#    —— 但这里走的是显式 install-cli 子命令，本来就不受闸门管。
install_cli() {
  "$NODE" "$HOME/bandi/apps/server/src/cli.mjs" install-cli >/dev/null 2>&1 || return 0
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) echo "（bandi 命令已装到 ~/.local/bin —— 不在 PATH 的话把这行加进 shell 配置：export PATH=\"\$HOME/.local/bin:\$PATH\"）" ;;
  esac
}

case "${1:-start}" in
  start)
    if running; then
      echo "已经在跑了（PID $(pids)）—— 不重复起"
      echo "要换监听地址/来源，先 stop 再带环境变量 start。"
      install_cli
      exit 0
    fi
    mkdir -p "$DATA"
    export BANDI_DATA="$DATA" BANDI_PORT="$PORT" BANDI_HOST="$HOST"
    [ -n "$ORIGINS" ] && export BANDI_ORIGINS="$ORIGINS"
    setsid nohup "$NODE" "$APP" >>"$LOG" 2>&1 </dev/null &
    sleep 3
    if running; then
      echo "起来了（PID $(pids)）· 监听 $HOST:$PORT · 日志 $LOG"
      install_cli
      if [ "$HOST" = "127.0.0.1" ]; then
        echo "远程访问走 SSH 隧道：  ssh -N -L 8787:127.0.0.1:$PORT <你的账号>@<这台机器>"
      else
        echo "非本机监听 —— 这个控制面**要求访问令牌**（监听非回环就自动开闸，见 apps/server/src/auth.mjs）。"
        if [ -n "$ORIGINS" ]; then echo "允许的来源：$ORIGINS"; else
          echo "⚠️ 没配 BANDI_ORIGINS —— 远端浏览器会「能看不能动」。"
        fi
        echo "令牌在 $DATA/token；启动日志也打了一次。浏览器打开首页填一次即可（会记进 Cookie）。"
      fi
    else
      echo "没起来 —— 日志尾部："
      tail -20 "$LOG" 2>/dev/null || echo "（还没有日志）"
      exit 1
    fi
    ;;
  stop)
    if running; then
      pkill -f "$PAT" && echo "停了"
    else
      echo "本来就没在跑"
    fi
    ;;
  status)
    if running; then
      echo "在跑（PID $(pids)）"
      echo "数据目录：$(grep -m1 '数据目录：' "$LOG" 2>/dev/null | sed 's/.*数据目录：//')"
      echo "监听：$(ss -ltn 2>/dev/null | awk '/:8787/ {print $4; exit}')"
    else
      echo "没在跑"
    fi
    ;;
  *)
    echo "用法：$0 [start|stop|status]"
    exit 2
    ;;
esac
