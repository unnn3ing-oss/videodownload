"""Updating the extension's own files from the host.

The installer put the extension's folder somewhere and recorded where (install_record). The extension downloads the new files
from GitHub and sends them here, so the person is never asked to pick the folder again. Trust model as in selfupdate: names,
hashes and bytes come from the extension (which read the hashes from the GitHub API over TLS); every byte must match its git
blob SHA, nothing is written unless all of them do, and a write that fails halfway puts the replaced files back.
Standard library only.
"""
from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path
from typing import Callable

from install_record import is_extension, recorded_extension_folder
from selfupdate import MAX_FILE_BYTES, SHA_RE, git_blob_sha

MAX_FILES = 100


class ExtUpdateError(Exception):
    def __init__(self, code: str, message: str, rolled_back: bool = False):
        super().__init__(message)
        self.code, self.message, self.rolled_back = code, message, rolled_back


def _safe_path(path: object) -> bool:
    if not isinstance(path, str) or not path or len(path) > 200 or path.startswith("/") or "\\" in path or ":" in path:
        return False
    return all(part not in ("", ".", "..", ".git") for part in path.split("/"))


def validate_files(files: object) -> list[dict]:
    def bad(why: str) -> ExtUpdateError:
        return ExtUpdateError("update_bad_file", f"擴充功能的更新清單不合規：{why}")

    if not isinstance(files, list):
        raise bad("不是清單")
    if len(files) > MAX_FILES:
        raise ExtUpdateError("update_bad_file", f"擴充功能的更新檔案超過 {MAX_FILES} 個")
    seen, result = set(), []
    for entry in files:
        if not isinstance(entry, dict):
            raise bad("項目格式錯誤")
        path, sha, size = entry.get("path"), entry.get("sha"), entry.get("size")
        if not _safe_path(path):
            raise bad(f"檔名 {path!r}")
        if not isinstance(sha, str) or not SHA_RE.fullmatch(sha):
            raise bad(f"{path} 的雜湊格式錯誤")
        if isinstance(size, bool) or not isinstance(size, int) or not 0 <= size <= MAX_FILE_BYTES:
            raise bad(f"{path} 的大小")
        if path in seen:
            raise bad(f"檔名重複：{path}")
        seen.add(path)
        result.append({"path": path, "sha": sha, "size": size})
    return result


def _backup(home: Path) -> Path:
    return Path(home) / "backup" / "extension"


def _restore(home: Path, folder: Path) -> int:
    backup = _backup(home)
    try:
        record = json.loads((backup / "_backup.json").read_text(encoding="utf-8"))
        replaced, added = list(record["replaced"]), list(record["added"])
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise ExtUpdateError("update_nothing_staged", "沒有可還原的擴充功能備份") from exc
    for name in replaced:
        if _safe_path(name):
            shutil.copy2(backup / name, folder / name)
    for name in added:
        if _safe_path(name):
            (folder / name).unlink(missing_ok=True)
    (backup / "_backup.json").unlink(missing_ok=True)
    return len(replaced) + len(added)


def apply(home: Path, files: object, contents: dict[str, bytes], on_write: Callable[[str], None] = lambda name: None) -> int:
    """Write the files into the recorded extension folder. Returns how many."""
    home = Path(home)
    listed = validate_files(files)
    folder = recorded_extension_folder(home)
    if folder is None:
        raise ExtUpdateError("no_extension_folder", "小程式不知道擴充功能資料夾在哪裡（不是用安裝檔放的，或資料夾被搬動了）")
    for entry in listed:  # everything is checked before anything is touched
        data = contents.get(entry["path"])
        if data is None:
            raise ExtUpdateError("update_bad_file", f"沒有收到 {entry['path']} 的內容")
        if len(data) > MAX_FILE_BYTES or git_blob_sha(data) != entry["sha"]:
            raise ExtUpdateError("update_hash_mismatch", f"{entry['path']} 下載內容和 GitHub 上的不一致，已取消更新")
    ordered = [e["path"] for e in listed if e["path"] != "manifest.json"] + [e["path"] for e in listed if e["path"] == "manifest.json"]
    backup = _backup(home)
    replaced, added = [], []
    try:
        shutil.rmtree(backup, ignore_errors=True)
        backup.mkdir(parents=True)
        for name in ordered:
            target = folder / name
            if target.exists():
                (backup / name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, backup / name)
                replaced.append(name)
            else:
                added.append(name)
        (backup / "_backup.json").write_text(json.dumps({"replaced": replaced, "added": added}), encoding="utf-8")
    except OSError as exc:
        raise ExtUpdateError("update_install_failed", f"無法備份擴充功能的舊檔案，已取消更新：{exc}") from exc
    try:
        for name in ordered:
            target = folder / name
            target.parent.mkdir(parents=True, exist_ok=True)
            tmp = target.with_name(target.name + ".part")
            tmp.write_bytes(contents[name])
            os.replace(tmp, target)
            on_write(name)
    except Exception as exc:
        for leftover in folder.rglob("*.part"):
            leftover.unlink(missing_ok=True)
        try:
            _restore(home, folder)
        except Exception as restore_exc:
            raise ExtUpdateError("update_install_failed", f"寫入擴充功能檔案失敗（{exc}），還原也失敗（{restore_exc}）。請重新執行安裝檔修復。") from exc
        raise ExtUpdateError("update_install_failed", f"寫入擴充功能檔案失敗，已還原：{exc}", rolled_back=True) from exc
    return len(ordered)


def rollback(home: Path) -> int:
    folder = recorded_extension_folder(Path(home))
    if folder is None:
        raise ExtUpdateError("no_extension_folder", "小程式不知道擴充功能資料夾在哪裡")
    return _restore(Path(home), folder)
