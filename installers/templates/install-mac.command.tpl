#!/bin/bash
# YouTube 批量下載器 安裝程式 @@VERSION@@
# This file only gets things started: it makes sure there is a Python and unpacks what is embedded below. The installing
# itself (tools, Chrome registration, the extension's folder, the checks) is host/installer.py, which is unpacked with it.
set -euo pipefail

HOME_DIR="$HOME/Library/Application Support/YTDownloader"
PAYLOAD='@@PAYLOAD_B64@@'
EXTENSION='@@EXTENSION_B64@@'
EMBEDDED_VERSION='@@VERSION@@'

fail() { printf '\n安裝失敗：%s\n請截圖這個視窗，並聯絡提供工具的同事。\n' "$1"; exit 1; }
# Any command that fails without its own message still stops with a visible reason.
trap 'fail "第 $LINENO 行執行失敗，原因請看上面的訊息"' ERR

printf '\n==> 檢查 python3（需要 3.9 以上）\n'
PY="$(command -v python3 || true)"
if [ -z "$PY" ] || ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
  fail "找不到 python3（3.9 以上）。請先在終端機執行：xcode-select --install，裝完後重新執行這個安裝檔。"
fi
echo "    $PY"

# Never an older installer over a newer install: the automatic update may have put a newer host and extension here, and this
# file carries older ones. The version of the host files that are here (an x.y.z in version.py, next to its installer.py):
installed_version() {
  if [ -f "$HOME_DIR/host/installer.py" ] && [ -f "$HOME_DIR/host/version.py" ]; then
    sed -n '/^VERSION/{s/^VERSION[[:space:]]*=[[:space:]]*"\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*$/\1/p;q;}' "$HOME_DIR/host/version.py"
  fi
}
# True when dotted version $1 is higher than $2, by number (0.10.0 is newer than 0.9.0). Both have to be x.y.z.
is_newer() {
  local IFS=. i
  local -a a b
  read -r -a a <<< "$1"
  read -r -a b <<< "$2"
  for i in 0 1 2; do
    if [ "${a[i]}" -gt "${b[i]}" ]; then return 0; fi
    if [ "${a[i]}" -lt "${b[i]}" ]; then return 1; fi
  done
  return 1
}
KEEP=0
INSTALLED_VERSION="$(installed_version)"
if [[ "$INSTALLED_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$EMBEDDED_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && is_newer "$INSTALLED_VERSION" "$EMBEDDED_VERSION"; then
  KEEP=1
  printf '\n已安裝的版本（%s）比這個安裝檔（%s）新，不會降版。要更新請在網頁按「更新到最新版」。\n' "$INSTALLED_VERSION" "$EMBEDDED_VERSION"
fi

mkdir -p "$HOME_DIR/host"
if [ "$KEEP" = 0 ]; then
  # The files in the zip all carry the same fixed date, so an old __pycache__ would pass for current: drop it.
  rm -rf "$HOME_DIR/host/__pycache__"
  printf '%s' "$PAYLOAD" | "$PY" -c 'import base64, io, sys, zipfile; zipfile.ZipFile(io.BytesIO(base64.b64decode(sys.stdin.read()))).extractall(sys.argv[1])' "$HOME_DIR/host"
  printf '%s' "$EXTENSION" | "$PY" -c 'import base64, sys; sys.stdout.buffer.write(base64.b64decode(sys.stdin.read()))' > "$HOME_DIR/extension.zip"
fi

# stdin is closed for it: when this script comes through a pipe (curl ... | bash) bash is still reading it from there.
# With a newer install the INSTALLED installer.py does the repair work, and leaves the host and the extension files alone.
status=0
if [ "$KEEP" = 1 ]; then
  "$PY" "$HOME_DIR/host/installer.py" --home "$HOME_DIR" --ext-id "@@EXT_ID@@" --no-deploy --version "$EMBEDDED_VERSION" </dev/null || status=$?
else
  "$PY" "$HOME_DIR/host/installer.py" --home "$HOME_DIR" --ext-id "@@EXT_ID@@" --extension-zip "$HOME_DIR/extension.zip" --version "$EMBEDDED_VERSION" </dev/null || status=$?
fi
trap - ERR
exit "$status"
