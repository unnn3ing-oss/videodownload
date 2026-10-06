#!/bin/bash
# YouTube 批量下載器 安裝程式 @@VERSION@@
# This file only gets things started: it makes sure there is a Python and unpacks what is embedded below. The installing
# itself (tools, Chrome registration, the extension's folder, the checks) is host/installer.py, which is unpacked with it.
set -euo pipefail

HOME_DIR="$HOME/Library/Application Support/YTDownloader"
PAYLOAD='@@PAYLOAD_B64@@'
EXTENSION='@@EXTENSION_B64@@'

fail() { printf '\n安裝失敗：%s\n請截圖這個視窗，並聯絡提供工具的同事。\n' "$1"; exit 1; }
# Any command that fails without its own message still stops with a visible reason.
trap 'fail "第 $LINENO 行執行失敗，原因請看上面的訊息"' ERR

printf '\n==> 檢查 python3（需要 3.9 以上）\n'
PY="$(command -v python3 || true)"
if [ -z "$PY" ] || ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
  fail "找不到 python3（3.9 以上）。請先在終端機執行：xcode-select --install，裝完後重新執行這個安裝檔。"
fi
echo "    $PY"

mkdir -p "$HOME_DIR/host"
# The files in the zip all carry the same fixed date, so an old __pycache__ would pass for current: drop it.
rm -rf "$HOME_DIR/host/__pycache__"
printf '%s' "$PAYLOAD" | "$PY" -c 'import base64, io, sys, zipfile; zipfile.ZipFile(io.BytesIO(base64.b64decode(sys.stdin.read()))).extractall(sys.argv[1])' "$HOME_DIR/host"
printf '%s' "$EXTENSION" | "$PY" -c 'import base64, sys; sys.stdout.buffer.write(base64.b64decode(sys.stdin.read()))' > "$HOME_DIR/extension.zip"

# stdin is closed for it: when this script comes through a pipe (curl ... | bash) bash is still reading it from there.
status=0
"$PY" "$HOME_DIR/host/installer.py" --home "$HOME_DIR" --ext-id "@@EXT_ID@@" --extension-zip "$HOME_DIR/extension.zip" --version "@@VERSION@@" </dev/null || status=$?
trap - ERR
exit "$status"
