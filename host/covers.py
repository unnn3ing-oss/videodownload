"""Cover images saved next to the downloaded videos."""
from __future__ import annotations

import json
import os
import unicodedata
from pathlib import Path

from naming import sanitize_filename
from security import safe_output_path

# base64 grows the image by a third, and one native message may carry 8 MiB in total (protocol.MAX_IN)
MAX_COVER_BYTES = 5 * 1024 * 1024
JPEG_MAGIC = b"\xff\xd8\xff"
REGISTRY = ".ytdl-covers.json"
NAME_CHARS = 6


class CoverError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def cover_name(title: str, video_id: str) -> str:
    """First six characters of the title, ignoring punctuation, symbols and whitespace (no extension)."""
    kept = "".join(ch for ch in title if unicodedata.category(ch)[0] not in "PSZC")
    return sanitize_filename(kept[:NAME_CHARS] or video_id)


_UNSAFE_NAME_CHARS = set('/\\:*?"<>|')


def _is_cover_name(name: str) -> bool:
    """A file name this module could have written: a plain, visible name ending in .jpg.

    No characters that a path or Windows treat specially (a drive letter, an NTFS stream "file:stream", wildcards).
    """
    return (name.lower().endswith(".jpg") and not name.startswith(".")
            and not any(ch in _UNSAFE_NAME_CHARS or ord(ch) < 32 for ch in name))


def _registry(directory: Path) -> dict[str, str]:
    """Video id -> cover file name. Entries that are not plain .jpg names are ignored (the file is user-editable)."""
    try:
        data = json.loads((directory / REGISTRY).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str) and _is_cover_name(v)}


def _record(directory: Path, video_id: str, filename: str) -> None:
    data = _registry(directory)
    data[video_id] = filename
    tmp = directory / (REGISTRY + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, directory / REGISTRY)


def save_cover(directory: Path, video_id: str, title: str, data: bytes) -> Path:
    """Write a JPEG into `directory`; one stable file name per video, a numeric suffix for other videos."""
    if not data.startswith(JPEG_MAGIC):
        raise CoverError("bad_cover", "封面圖片格式不正確")
    if len(data) > MAX_COVER_BYTES:
        raise CoverError("cover_too_large", "封面圖片太大")
    directory = Path(directory)
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise CoverError("bad_path", f"無法建立存放資料夾：{exc}") from exc
    try:
        known = _registry(directory).get(video_id)
        target = safe_output_path(directory, known) if known else None
        if target is None:
            base = cover_name(title, video_id)
            number = 1
            while True:
                suffix = "" if number == 1 else f"_{number}"
                target = safe_output_path(directory, f"{base}{suffix}.jpg")
                if not target.exists():
                    break
                number += 1
        tmp = target.with_name(target.name + ".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, target)
        _record(directory, video_id, target.name)
    except (ValueError, OSError) as exc:
        raise CoverError("bad_path", f"無法儲存封面：{exc}") from exc
    return target
