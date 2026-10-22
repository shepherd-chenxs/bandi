#!/bin/sh
# 班底 · Linux 离线安装包安装脚本（2026-10-22）
#
# 用法（解压后）：
#   sudo sh install.sh              安装并启动（/opt/bandi + systemd + bandi 命令）
#   sudo sh install.sh --uninstall  卸载程序与命令（数据默认保留）
#   sudo sh install.sh --uninstall --purge  连数据一起删
#
# 做的事：代码落 /opt/bandi → 建系统用户与数据目录 → 写 systemd 单元并启动 →
#         注册「bandi」全局命令（部署即装的服务端同款逻辑，install-cli）。
# 端口/监听想改：BANDI_PORT=8899 BANDI_HOST=0.0.0.0 sudo -E sh install.sh
#
# ⚠️ 脚本必须待在解压出来的 bandi/ 目录里运行（它按 $PWD 找随包的 node 和代码）。
set -eu

PREFIX=/opt/bandi
DATA=/var/lib/bandi
SVC_USER=bandi
PORT="${BANDI_PORT:-8787}"
HOST="${BANDI_HOST:-127.0.0.1}"

say() { printf '%s\n' "  $*"; }
die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

RUN_AS=""
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  RUN_AS="sudo -u $SUDO_USER"
fi

# 给"执行安装的那个用户"注册 bandi 命令（install-cli 幂等，自动写 ~/.profile ~/.bashrc）
register_cli() {
  $RUN_AS "$PREFIX/node" "$PREFIX/apps/server/src/cli.mjs" install-cli >/dev/null 2>&1 || true
}

if [ "${1:-}" = "--uninstall" ]; then
  [ "$(id -u)" = "0" ] || die "卸载也要 root：sudo sh install.sh --uninstall"
  systemctl disable --now bandi >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/bandi.service
  systemctl daemon-reload >/dev/null 2>&1 || true
  register_cli
  rm -rf "$PREFIX"
  if [ "${2:-}" = "--purge" ]; then
    rm -rf "$DATA"
    say "已完全卸载（数据也删了）。"
  else
    say "已卸载程序与命令，数据保留在 $DATA（要连数据删：--uninstall --purge）。"
  fi
  exit 0
fi

[ "$(id -u)" = "0" ] || die "请用 root 运行：sudo sh install.sh"
[ -x "$PWD/node" ] || die "找不到随包的 node —— 请在解压出来的 bandi/ 目录里运行"
[ -f "$PWD/apps/server/src/server.mjs" ] || die "找不到服务端入口（包不完整？）"

VER="未知"
if [ -f "$PWD/version.json" ]; then
  VER=$(grep -o '"version"[^,}]*' "$PWD/version.json" | head -1 | sed 's/.*: *"\(.*\)"/\1/')
fi

say "班底 v$VER · 端口 $PORT · 监听 $HOST"
say "落点 $PREFIX · 数据 $DATA"

# 1. 收旧的（升级场景：跑着就先停）
if command -v systemctl >/dev/null 2>&1; then
  systemctl stop bandi >/dev/null 2>&1 || true
fi

# 2. 代码落位（覆盖式；用户数据在 $DATA，不在 $PREFIX 里）
mkdir -p "$PREFIX"
cp -a "$PWD"/. "$PREFIX"/
chmod +x "$PREFIX/node"

# 3. 服务用户与数据目录
id "$SVC_USER" >/dev/null 2>&1 || useradd -r -M -s /usr/sbin/nologin "$SVC_USER" 2>/dev/null || true
mkdir -p "$DATA"
chown -R "$SVC_USER":"$SVC_USER" "$DATA" "$PREFIX" 2>/dev/null || true

# 4. systemd 单元（按随包 node 路径与端口替换模板）
if command -v systemctl >/dev/null 2>&1; then
  sed -e "s|ExecStart=/usr/bin/node|ExecStart=$PREFIX/node|" \
      -e "s|Environment=BANDI_PORT=8787|Environment=BANDI_PORT=$PORT|" \
      -e "s|Environment=BANDI_HOST=127.0.0.1|Environment=BANDI_HOST=$HOST|" \
      "$PREFIX/deploy/bandi.service" > /etc/systemd/system/bandi.service
  systemctl daemon-reload
  systemctl enable --now bandi >/dev/null 2>&1 || systemctl restart bandi

  # 5. 等健康（用随包 node 探测，不要求机器上有 curl）
  i=0
  while [ "$i" -lt 30 ]; do
    if "$PREFIX/node" -e "fetch('http://127.0.0.1:$PORT/api/state').then(()=>process.exit(0),()=>process.exit(1))" >/dev/null 2>&1; then
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  if [ "$i" -ge 30 ]; then
    say "✗ 服务 30 秒内没起来 —— 看日志：journalctl -u bandi -n 40"
    exit 1
  fi
else
  say "⚠ 没检测到 systemd —— 已落好 $PREFIX，起服务用："
  say "    $PREFIX/deploy/start-control-plane.sh start"
  exit 0
fi

# 6. 注册 bandi 全局命令（幂等；PATH 与 rc 文件由 install-cli 自动处理）
register_cli

say ""
say "✓ 就绪  http://127.0.0.1:$PORT"
if [ "$HOST" = "127.0.0.1" ]; then
  say "  远程访问走 SSH 隧道：  ssh -N -L $PORT:127.0.0.1:$PORT <用户>@<这台机器>"
else
  say "  ⚠ 监听非回环 —— 远端访问要求令牌（在 $DATA/token，启动日志也打了一次）"
fi
say "  新开一个终端敲 bandi 看状态 / 起停 / 日志。"
say "  常用：systemctl status bandi · journalctl -u bandi -f · bandi status"
