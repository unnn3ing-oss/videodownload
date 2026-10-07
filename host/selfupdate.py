"""Self-update of the host's own Python files (the extension coordinates it).

Trust model: file names, SHAs and the commit come from the extension (which read them from the
GitHub API over TLS); every downloaded byte must match its git blob SHA exactly.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path
from typing import Callable

from update_config import OWNER, REPO

MAX_FILES = 50
MAX_FILE_BYTES = 2 * 1024 * 1024
ALLOWED_NAME = re.compile(r"[A-Za-z0-9_]+\.py")
SHA_RE = re.compile(r"[0-9a-f]{40}")
RAW_BASE = f"https://raw.githubusercontent.com/{OWNER}/{REPO}"
_CHECK_CODE = "import sys; sys.path.insert(0, sys.argv[1]); import host"


class UpdateError(Exception):
    def __init__(self, code: str, message: str, rolled_back: bool = False, detail: str = ""):
        super().__init__(message)
        self.code = code
        self.message = message
        self.rolled_back = rolled_back
        self.detail = detail  # the captured error text, for the log and the reply


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


def _staging(home: Path) -> Path:
    return Path(home) / "update" / "staging"


def _rmtree(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)


def _drop_bytecode(host_dir: Path) -> None:
    """Python trusts a cached .pyc when the source's date and size match; a swapped-in file can match by accident."""
    _rmtree(Path(host_dir) / "__pycache__")


def _staged_names(staging: Path) -> list[str]:
    try:
        names = json.loads((staging / "_files.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [n for n in names if isinstance(n, str) and ALLOWED_NAME.fullmatch(n)]


def self_check(home: Path, python: str | None = None) -> None:
    """Import the host with the staged files laid over the installed ones, in a throwaway subprocess."""
    home = Path(home)
    check = home / "update" / "check"
    _rmtree(check)
    check.mkdir(parents=True)
    try:
        for source in (home / "host").glob("*.py"):
            shutil.copy2(source, check / source.name)
        for name in _staged_names(_staging(home)):
            shutil.copy2(_staging(home) / name, check / name)
        try:
            done = subprocess.run([python or sys.executable, "-c", _CHECK_CODE, str(check)], stdin=subprocess.DEVNULL,
                                  capture_output=True, text=True, timeout=30)
        except Exception as exc:
            raise UpdateError("update_selfcheck_failed", f"新版小程式無法檢查：{exc}") from exc
        if done.returncode != 0:
            tail = (done.stderr.strip().splitlines() or ["未知原因"])[-1]
            raise UpdateError("update_selfcheck_failed", f"新版小程式無法載入：{tail}")
    finally:
        _rmtree(check)


def decode_contents(contents: object, files: list[dict]) -> dict[str, bytes]:
    """Decode the optional {name: base64} map the extension sends (Chrome's network stack did the download)."""
    if contents is None:
        return {}
    listed = {entry["path"] for entry in files}
    if not isinstance(contents, dict):
        raise UpdateError("update_bad_file", "更新內容格式不正確")
    decoded = {}
    for name, value in contents.items():
        if name not in listed or not isinstance(value, str):
            raise UpdateError("update_bad_file", f"更新內容不正確：{name!r}")
        try:
            decoded[name] = base64.b64decode(value, validate=True)
        except ValueError as exc:
            raise UpdateError("update_bad_file", f"{name} 的內容不是有效的編碼") from exc
    return decoded


def stage(home: Path, commit: str, files: list[dict], fetch: Callable[[str], bytes] | None = None,
          contents: dict[str, bytes] | None = None) -> int:
    """Put the changed files into staging, verify every byte, and self-check. Returns the file count.

    Bytes come from `contents` when the extension supplied them, otherwise from a download.
    """
    fetch = fetch or http_get  # looked up at call time so tests can replace http_get
    contents = contents or {}
    if not isinstance(commit, str) or not SHA_RE.fullmatch(commit):
        raise UpdateError("update_bad_file", "commit 格式不正確")
    files = validate_files(files)
    if not files:
        raise UpdateError("update_nothing_staged", "沒有需要更新的檔案")
    staging = _staging(home)
    _rmtree(staging)
    staging.mkdir(parents=True)
    try:
        for entry in files:
            try:
                data = contents[entry["path"]] if entry["path"] in contents else fetch(f"{RAW_BASE}/{commit}/host/{entry['path']}")
            except UpdateError:
                raise
            except Exception as exc:
                raise UpdateError("update_download_failed", f"下載 {entry['path']} 失敗：{exc}") from exc
            if len(data) > MAX_FILE_BYTES or git_blob_sha(data) != entry["sha"]:
                raise UpdateError("update_hash_mismatch",
                                  f"{entry['path']} 下載內容和 GitHub 上的不一致，已取消更新")
            (staging / entry["path"]).write_bytes(data)
        (staging / "_files.json").write_text(json.dumps([e["path"] for e in files]), encoding="utf-8")
        self_check(home)
    except BaseException:
        _rmtree(staging)
        raise
    return len(files)


def _backup(home: Path) -> Path:
    return Path(home) / "backup" / "host"


def _restore(home: Path) -> int:
    """Put back what the last commit replaced and remove what it added; returns how many files."""
    backup = _backup(home)
    try:
        record = json.loads((backup / "_backup.json").read_text(encoding="utf-8"))
        replaced = [n for n in record["replaced"] if ALLOWED_NAME.fullmatch(n)]
        added = [n for n in record["added"] if ALLOWED_NAME.fullmatch(n)]
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise UpdateError("update_nothing_staged", "沒有可還原的備份") from exc
    host_dir = Path(home) / "host"
    for name in replaced:
        shutil.copy2(backup / name, host_dir / name)
    for name in added:
        (host_dir / name).unlink(missing_ok=True)
    (backup / "_backup.json").unlink(missing_ok=True)
    _drop_bytecode(host_dir)
    return len(replaced) + len(added)


def commit_update(home: Path) -> int:
    """Swap the staged files into host/, keeping the previous versions in backup/host/."""
    home = Path(home)
    staging, host_dir, backup = _staging(home), home / "host", _backup(home)
    names = _staged_names(staging)
    if not names or not all((staging / n).is_file() for n in names):
        raise UpdateError("update_nothing_staged", "沒有已準備好的更新")
    _rmtree(backup)
    backup.mkdir(parents=True)
    replaced, added = [], []
    for name in names:
        if (host_dir / name).exists():
            shutil.copy2(host_dir / name, backup / name)
            replaced.append(name)
        else:
            added.append(name)
    (backup / "_backup.json").write_text(json.dumps({"replaced": replaced, "added": added}), encoding="utf-8")
    try:
        for name in names:
            os.replace(staging / name, host_dir / name)
    except Exception as exc:
        try:
            _restore(home)
        except Exception:
            pass
        raise UpdateError("update_install_failed", f"安裝更新失敗，已還原：{exc}", rolled_back=True) from exc
    _drop_bytecode(host_dir)
    _rmtree(staging)
    return len(names)


def rollback_update(home: Path) -> int:
    return _restore(Path(home))
