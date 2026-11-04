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
#
# 端口想改：BANDI_PORT=8899 sudo -E sh install.sh
# 监听地址**不用在这里传**（2026-11-04 用户定）：它存在数据目录的 config.json 里，
# 界面上「设置 → 安全 → 监听地址」能改、改完重启生效，**升级重装都不丢**。
# 只有"临时钉一次"才用 BANDI_HOST=127.0.0.1（会写进单元，下次安装若不再传就消失）。
#
# ⚠️ 脚本必须待在解压出来的 bandi/ 目录里运行（它按 $PWD 找随包的 node 和代码）。
set -eu

PREFIX=/opt/bandi
DATA=/var/lib/bandi
SVC_USER=bandi
PORT="${BANDI_PORT:-8787}"
# 空 = 不往单元里写地址，交给数据目录里的配置（缺省 0.0.0.0）
HOST="${BANDI_HOST:-}"

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
# ⚠️ 先补执行位再检查 —— Windows 上打的包（fs.copyFileSync / tar）不带 +x，
#    "先检查后补"等于永远过不了（2026-11-03 实报：thinkpad-p15 升级卡在这一步）。
chmod +x "$PWD/node" 2>/dev/null || true
[ -x "$PWD/node" ] || die "找不到随包的 node —— 请在解压出来的 bandi/ 目录里运行"
[ -f "$PWD/apps/server/src/server.mjs" ] || die "找不到服务端入口（包不完整？）"

VER="未知"
if [ -f "$PWD/version.json" ]; then
  VER=$(grep -o '"version"[^,}]*' "$PWD/version.json" | head -1 | sed 's/.*: *"\(.*\)"/\1/')
fi

say "班底 v$VER · 端口 $PORT · 监听 ${HOST:-缺省 0.0.0.0（配置可改）}"
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
      "$PREFIX/deploy/bandi.service" > /etc/systemd/system/bandi.service
  # 监听地址**默认不写死**（2026-11-04）：真源是 $DATA/config.json 的 listenHost，
  # 界面可改、升级不丢。只有显式传了 BANDI_HOST 才钉进单元（临时/特殊部署）。
  # 每次都覆盖写单元 → 旧版本留下的 `Environment=BANDI_HOST=127.0.0.1` 会被清掉 ✓
  if [ -n "$HOST" ]; then
    sed -i "/^\[Service\]/a Environment=BANDI_HOST=$HOST" /etc/systemd/system/bandi.service
    say "⚠ 已按 BANDI_HOST=$HOST 把监听钉进服务单元（下次安装不再传就放开）"
  fi
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
  say "  ⚠ 监听被这次参数钉在回环上 —— 远程访问只能走 SSH 隧道："
  say "     ssh -N -L $PORT:127.0.0.1:$PORT <用户>@<这台机器>"
elif [ "$HOST" = "0.0.0.0" ] || [ -z "$HOST" ]; then
  say "  局域网/远程访问：http://<这台机器的 IP>:$PORT（要登录，令牌在 $DATA/token）"
fi
say "  监听地址以后在界面「设置 → 安全 → 监听地址」里改（改完点重启即可，重装不会改回去）"
say "  新开一个终端敲 bandi 看状态 / 起停 / 日志。"
say "  常用：systemctl status bandi · journalctl -u bandi -f · bandi status"
