"""Self-update of the host's own Python files (the extension coordinates it).

Trust model: file names, SHAs and the commit come from the extension (which read them from the
GitHub API over TLS); every downloaded byte must match its git blob SHA exactly.
"""
from __future__ import annotations

import hashlib
import re
import urllib.request
from pathlib import Path

MAX_FILES = 50
MAX_FILE_BYTES = 2 * 1024 * 1024
ALLOWED_NAME = re.compile(r"[A-Za-z0-9_]+\.py")
SHA_RE = re.compile(r"[0-9a-f]{40}")


class UpdateError(Exception):
    def __init__(self, code: str, message: str, rolled_back: bool = False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.rolled_back = rolled_back


def git_blob_sha(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def validate_files(files: object) -> list[dict]:
    """Normalize a file list from the extension; anything unexpected rejects the whole list."""
    def bad(why: str) -> UpdateError:
        return UpdateError("update_bad_file", f"更新清單不正確：{why}")

    if not isinstance(files, list):
        raise bad("不是清單")
    if len(files) > MAX_FILES:
        raise bad(f"檔案超過 {MAX_FILES} 個")
    seen: set[str] = set()
    result = []
    for entry in files:
        if not isinstance(entry, dict):
            raise bad("項目格式錯誤")
        path, sha, size = entry.get("path"), entry.get("sha"), entry.get("size")
        if not isinstance(path, str) or not ALLOWED_NAME.fullmatch(path):
            raise bad(f"檔名不合規：{path!r}")
        if not isinstance(sha, str) or not SHA_RE.fullmatch(sha):
            raise bad(f"{path} 的雜湊格式錯誤")
        if isinstance(size, bool) or not isinstance(size, int) or not 0 <= size <= MAX_FILE_BYTES:
            raise bad(f"{path} 的大小不合規")
        if path in seen:
            raise bad(f"檔名重複：{path}")
        seen.add(path)
        result.append({"path": path, "sha": sha, "size": size})
    return result


def changed_files(host_dir: Path, files: list[dict]) -> list[str]:
    """Names whose local content differs from the listed SHA (CRLF-only differences do not count)."""
    changed = []
    for entry in files:
        path = Path(host_dir) / entry["path"]
        if not path.is_file():
            changed.append(entry["path"])
            continue
        data = path.read_bytes()
        if git_blob_sha(data) != entry["sha"] and git_blob_sha(data.replace(b"\r\n", b"\n")) != entry["sha"]:
            changed.append(entry["path"])
    return changed


def http_get(url: str, timeout: float = 30.0) -> bytes:
    if not url.startswith("https://"):
        raise UpdateError("update_download_failed", "只允許以 HTTPS 下載")
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "ytdl-batch-downloader"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = response.read(MAX_FILE_BYTES + 1)
    except Exception as exc:
        raise UpdateError("update_download_failed", f"下載失敗：{exc}") from exc
    if len(data) > MAX_FILE_BYTES:
        raise UpdateError("update_download_failed", "檔案超過大小上限")
    return data
