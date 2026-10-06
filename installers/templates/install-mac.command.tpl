#!/bin/bash
# YouTube 批量下載器 安裝程式 @@VERSION@@
set -euo pipefail

HOST_NAME="@@HOST_NAME@@"
EXT_ID="@@EXT_ID@@"
HOME_DIR="$HOME/Library/Application Support/YTDownloader"
NM_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
PAYLOAD='@@PAYLOAD_B64@@'

step() { printf '\n==> %s\n' "$1"; }
fail() { printf '\n安裝失敗：%s\n請截圖這個視窗，並聯絡提供工具的同事。\n' "$1"; exit 1; }
# Any command that fails without its own message still stops with a visible reason.
trap 'fail "第 $LINENO 行執行失敗，原因請看上面的訊息"' ERR

step "檢查 python3（需要 3.9 以上）"
PY="$(command -v python3 || true)"
if [ -z "$PY" ] || ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
  fail "找不到 python3（3.9 以上）。請先在終端機執行：xcode-select --install，裝完後重新執行這個安裝檔。"
fi
echo "    $PY"

TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
mkdir -p "$HOME_DIR/host" "$HOME_DIR/bin" "$NM_DIR"

step "寫入本機小程式"
printf '%s' "$PAYLOAD" | "$PY" -c 'import base64, io, sys, zipfile; zipfile.ZipFile(io.BytesIO(base64.b64decode(sys.stdin.read()))).extractall(sys.argv[1])' "$HOME_DIR/host"

step "下載 yt-dlp 並驗證校驗碼"
# The unpacked ("onedir") build, unpacked here once: the single-file build unpacks itself on every run, and when Chrome
# starts the host macOS marks those files "downloaded by Chrome" and refuses to load them ("Python.framework is damaged").
"$PY" "$HOME_DIR/host/macos_engine.py" install "$HOME_DIR/bin" || fail "yt-dlp 安裝失敗（原因請看上面的訊息）"

# Every part is judged by whether it runs, not by whether the file exists: running this installer again repairs what is broken.
if ! "$HOME_DIR/bin/deno" --version >/dev/null 2>&1; then
  step "下載 Deno（YouTube 解題需要）"
  rm -f "$HOME_DIR/bin/deno"
  if [ "$(uname -m)" = "arm64" ]; then DENO_URL="@@URL_DENO_MAC_ARM@@"; else DENO_URL="@@URL_DENO_MAC_X64@@"; fi
  curl -fL --retry 3 -o "$TMP/deno.zip" "$DENO_URL" || fail "Deno 下載失敗"
  unzip -o -q "$TMP/deno.zip" -d "$HOME_DIR/bin"
  chmod +x "$HOME_DIR/bin/deno"
fi

if ! "$HOME_DIR/bin/ffmpeg" -version >/dev/null 2>&1; then
  step "準備 ffmpeg"
  rm -f "$HOME_DIR/bin/ffmpeg"
  if command -v ffmpeg >/dev/null 2>&1; then
    ln -sf "$(command -v ffmpeg)" "$HOME_DIR/bin/ffmpeg"
  else
    curl -fL --retry 3 -o "$TMP/ffmpeg.zip" "@@URL_FFMPEG_MAC@@" || fail "ffmpeg 下載失敗（也可以改用 Homebrew：brew install ffmpeg，再重新執行這個安裝檔）"
    unzip -o -q "$TMP/ffmpeg.zip" -d "$HOME_DIR/bin"
    chmod +x "$HOME_DIR/bin/ffmpeg"
  fi
fi

# Programs that Chrome starts must not carry macOS's "downloaded from the internet" mark.
xattr -dr com.apple.quarantine "$HOME_DIR" 2>/dev/null || true

step "登錄 Chrome Native Messaging"
cat > "$HOME_DIR/host.sh" <<LAUNCHER
#!/bin/bash
export YTDL_HOME="$HOME_DIR"
exec "$PY" -u "$HOME_DIR/host/host.py"
LAUNCHER
chmod +x "$HOME_DIR/host.sh"
"$PY" - "$NM_DIR/$HOST_NAME.json" "$HOST_NAME" "$HOME_DIR/host.sh" "$EXT_ID" <<'PYEOF'
import json, sys
path, name, launcher, ext_id = sys.argv[1:5]
manifest = {
    "name": name,
    "description": "YouTube 批量下載器本機小程式",
    "path": launcher,
    "type": "stdio",
    "allowed_origins": [f"chrome-extension://{ext_id}/"],
}
with open(path, "w", encoding="utf-8") as fh:
    json.dump(manifest, fh, ensure_ascii=False, indent=2)
PYEOF

step "檢查安裝結果"
if ! "$PY" "$HOME_DIR/host/doctor.py" --home "$HOME_DIR" --ext-id "$EXT_ID" --native-manifest "$NM_DIR/$HOST_NAME.json"; then
  printf '\n安裝尚未完成：上面標著 ✘ 的項目需要處理。\n照每一項下面的「→」建議做；解決不了就把這個視窗截圖給提供工具的同事。\n'
  exit 1
fi

printf '\n安裝完成！請回到 Chrome，打開擴充功能並按「啟動」。\n'
printf '之後如果遇到任何問題，重新執行這個安裝檔就會自動檢查並修復。\n'
