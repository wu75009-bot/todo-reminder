#!/usr/bin/env bash
# 把服务装成开机自启（systemd）。
# 用法：sudo bash deploy/linux/install.sh [安装目录，默认 /opt/todo-reminder]
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DST="${1:-/opt/todo-reminder}"

command -v node >/dev/null || { echo "没装 node。先执行：curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs"; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || { echo "node 版本太低（$NODE_MAJOR），需要 22+"; exit 1; }

mkdir -p "$DST"
# 不覆盖 data/：配置、待办、日志都在里面，重装时得留住
if command -v rsync >/dev/null; then
  rsync -a --exclude data --exclude node_modules --exclude '.git' "$SRC"/ "$DST"/
else
  cp -a "$SRC"/src "$SRC"/public "$SRC"/rules "$SRC"/package.json "$DST"/
fi
mkdir -p "$DST/data"

NODE_PATH="$(command -v node)"
sed "s#ExecStart=/usr/bin/node#ExecStart=$NODE_PATH#" "$SRC/deploy/linux/todo-reminder.service" > /etc/systemd/system/todo-reminder.service
systemctl daemon-reload
systemctl enable --now todo-reminder

echo
echo "装好了，装在 $DST"
echo "看状态：systemctl status todo-reminder"
echo "看日志：journalctl -u todo-reminder -f"
echo "改配置：$DST/data/config.json（改完 systemctl restart todo-reminder）"
