#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npm run build
bash scripts/build-macos.sh
node dist/src/index.js install
mkdir -p "$HOME/Applications"
TARGET="$HOME/Applications/AIQuota5h.app"
if [[ -d "$TARGET" ]]; then
  BACKUP="$HOME/Library/Application Support/AIQuota5h/backups/app-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP"
  ditto "$TARGET" "$BACKUP/AIQuota5h.app"
fi
pkill -x AIQuota5h 2>/dev/null || true
ditto "$ROOT/dist/AIQuota5h.app" "$TARGET"
echo "已安装 $TARGET；后台随 macOS 登录启动，关闭窗口不会停止后台。"
open "$TARGET"
