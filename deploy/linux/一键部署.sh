#!/usr/bin/env bash
# 一条命令把待办提醒装到 Ubuntu 云服务器上：Node 22 + Docker + NapCat 容器 + systemd 开机自启。
#
# 用法（在解压出来的项目根目录里）：
#   sudo bash deploy/linux/一键部署.sh
#
# 可选环境变量：
#   BOT_UIN=10001             机器人小号 QQ，用来预置 NapCat 的 OneBot 配置（必填）
#   DST=/opt/todo-reminder    服务安装目录
#   NAPCAT_DIR=/opt/napcat    NapCat 的配置/登录数据目录
#   MIRROR=https://xxx.mirror.aliyuncs.com   Docker 拉镜像失败时用阿里云专属加速器
set -euo pipefail

DST="${DST:-/opt/todo-reminder}"
NAPCAT_DIR="${NAPCAT_DIR:-/opt/napcat}"
BOT_UIN="${BOT_UIN:-}"
IMAGE="${IMAGE:-mlikiowa/napcat-docker:latest}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = 0 ] || die "要用 root 跑：sudo bash $0"
[ -n "$BOT_UIN" ] || die "请先指定机器人 QQ 号：sudo BOT_UIN=你的小号 bash $0"

# ---------------- 1. Node.js 22 ----------------
needs_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 22 ] && needs_node=0 && ok "node 已经是 $(node -v)，跳过"
fi
if [ "$needs_node" = 1 ]; then
  say "安装 Node.js 22"
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) die "不认识的架构 $(uname -m)" ;;
  esac
  VER=v22.11.0
  TMP="$(mktemp -d)"
  if ! curl -fsSL --retry 3 --connect-timeout 10 \
      "https://npmmirror.com/mirrors/node/${VER}/node-${VER}-linux-${ARCH}.tar.xz" -o "$TMP/node.tar.xz"; then
    warn "国内镜像没下来，换官方源"
    curl -fsSL --retry 3 --connect-timeout 10 \
      "https://nodejs.org/dist/${VER}/node-${VER}-linux-${ARCH}.tar.xz" -o "$TMP/node.tar.xz" \
      || die "Node 下载失败，检查安全组是否放通出网"
  fi
  tar -xJf "$TMP/node.tar.xz" -C /usr/local --strip-components=1
  rm -rf "$TMP"
  hash -r
  ok "node $(/usr/local/bin/node -v)"
fi

# ---------------- 2. Docker ----------------
if command -v docker >/dev/null 2>&1; then
  ok "docker 已装：$(docker -v)"
else
  say "安装 Docker"
  export DEBIAN_FRONTEND=noninteractive
  # 开机那几分钟 apt 常被 unattended-upgrades 占着锁，等它一会儿而不是直接失败
  apt-get -o DPkg::Lock::Timeout=180 update -qq || warn "apt update 有报错，继续试"
  if ! apt-get -o DPkg::Lock::Timeout=180 install -y -qq docker.io ca-certificates; then
    warn "源里没有 docker.io，改用官方脚本"
    curl -fsSL https://get.docker.com | sh || die "Docker 装不上"
  fi
  systemctl enable --now docker
  hash -r
  ok "$(docker -v)"
fi

# 国内直连 Docker Hub 基本拉不动，先配几个公共镜像站
mkdir -p /etc/docker
if [ ! -f /etc/docker/daemon.json ]; then
  cat > /etc/docker/daemon.json <<'EOF'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://dockerproxy.net",
    "https://hub.rat.dev"
  ]
}
EOF
  systemctl restart docker
  ok "已写入 Docker 镜像加速"
fi
[ -n "${MIRROR:-}" ] && { printf '{"registry-mirrors":["%s"]}\n' "$MIRROR" > /etc/docker/daemon.json; systemctl restart docker; ok "已改用阿里云加速器 $MIRROR"; }

# ---------------- 3. NapCat ----------------
say "准备 NapCat 配置（HTTP 3000 发消息 / WebSocket 3001 收事件）"
mkdir -p "$NAPCAT_DIR/config" "$NAPCAT_DIR/qq"
# 预置 OneBot 配置，省掉登录后手点「网络配置」。文件名必须和 QQ 号一致。
cat > "$NAPCAT_DIR/config/onebot11_${BOT_UIN}.json" <<EOF
{
  "network": {
    "httpServers": [
      {
        "name": "todo-http",
        "enable": true,
        "host": "0.0.0.0",
        "port": 3000,
        "messagePostFormat": "array",
        "enableCors": true,
        "token": "",
        "debug": false
      }
    ],
    "httpSseServers": [],
    "httpClients": [],
    "websocketServers": [
      {
        "name": "todo-ws",
        "enable": true,
        "host": "0.0.0.0",
        "port": 3001,
        "messagePostFormat": "array",
        "reportSelfMessage": false,
        "token": "",
        "debug": false
      }
    ],
    "websocketClients": [],
    "plugins": []
  },
  "musicSignUrl": "",
  "enableLocalFile2Url": false,
  "parseMultMsg": true
}
EOF
ok "已写入 $NAPCAT_DIR/config/onebot11_${BOT_UIN}.json"

say "拉 NapCat 镜像（几百 MB，第一次慢）"
if ! docker pull "$IMAGE"; then
  warn "直连拉取失败，换镜像站重试"
  pulled=0
  for m in docker.m.daocloud.io dockerproxy.net hub.rat.dev; do
    if docker pull "$m/$IMAGE"; then docker tag "$m/$IMAGE" "$IMAGE"; pulled=1; break; fi
  done
  [ "$pulled" = 1 ] || die "镜像没拉下来。去阿里云控制台「容器镜像服务 → 镜像加速器」拿专属地址，然后：MIRROR=https://xxxx.mirror.aliyuncs.com sudo -E bash $0"
fi
ok "镜像就绪"

say "启动 NapCat 容器"
docker rm -f napcat >/dev/null 2>&1 || true
docker run -d --name napcat --restart=always \
  -e NAPCAT_GID=0 -e NAPCAT_UID=0 \
  -p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001 -p 6099:6099 \
  -v "$NAPCAT_DIR/config":/app/napcat/config \
  -v "$NAPCAT_DIR/qq":/app/.config/QQ \
  "$IMAGE" >/dev/null
ok "容器 napcat 已启动（WebUI 6099，3000/3001 只绑本机）"

# ---------------- 4. 待办服务 ----------------
say "安装待办提醒服务到 $DST"

# 先把 data/ 放好再装：install.sh 会在最后把服务拉起来，而服务一启动就会自己写一份默认
# config.json；等它写完再拷，我们这份带 API Key 的就被"已存在"挡掉了，白装。
mkdir -p "$DST/data"
if [ ! -f "$DST/data/config.json" ] && [ -f "$SRC/data/config.json" ]; then
  cp -a "$SRC/data/config.json" "$DST/data/config.json"
  ok "带上了原有配置"
else
  warn "$DST/data/config.json 已存在，保持不动"
fi
if [ ! -f "$DST/data/db.json" ] && [ -f "$SRC/data/db.json" ]; then
  cp -a "$SRC/data/db.json" "$DST/data/db.json"
  ok "带上了原有待办"
fi

if [ -f "$DST/data/config.json" ]; then
  CFG="$DST/data/config.json" node -e '
    const fs = require("fs");
    const p = process.env.CFG;
    const c = JSON.parse(fs.readFileSync(p, "utf8"));
    c.qq = c.qq || {};
    c.qq.api = c.qq.api || "http://127.0.0.1:3000";
    c.qq.ws = "ws://127.0.0.1:3001";
    c.clipboard = Object.assign({}, c.clipboard, { enabled: false });
    c.notifyDesktop = false;
    fs.writeFileSync(p, JSON.stringify(c, null, 2));
    console.log("  配置已适配云端：qq.ws=" + c.qq.ws + " | 剪贴板已关 | 桌面通知已关");
  '
fi

bash "$SRC/deploy/linux/install.sh" "$DST"
systemctl restart todo-reminder
sleep 2
systemctl is-active --quiet todo-reminder && ok "服务已运行（systemctl status todo-reminder）" || warn "服务没起来，看 journalctl -u todo-reminder -n 50"

# ---------------- 5. 交给你的一步 ----------------
IP="$(curl -s --max-time 3 http://100.100.100.200/latest/meta-data/eipv4 2>/dev/null || true)"
[ -n "$IP" ] || IP="$(curl -s --max-time 5 https://ifconfig.me 2>/dev/null || echo '服务器公网IP')"

cat <<EOF

────────────────────────────────────────────
装完了。剩下一件事只能你自己做：扫码登录小号。

  1. 浏览器打开  http://${IP}:6099
  2. 用手机 QQ 扫屏幕上的二维码（扫的是小号 ${BOT_UIN}，别扫主号）
  3. 登录后点左侧「网络配置」，应该能看到两条已启用：
       todo-http  HTTP 服务器      端口 3000
       todo-ws    WebSocket 服务器 端口 3001
     （没看到就手动加这两条，格式选 array）

  然后回主号给人发一句「查看待办」，收到回复就算通了。

排查用：
  journalctl -u todo-reminder -f      服务日志
  docker logs -f napcat               QQ 那边
  curl -s 127.0.0.1:3000/get_login_info
────────────────────────────────────────────
EOF
