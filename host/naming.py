"""Filename cleaning, path-length limits and collision handling."""
from __future__ import annotations

import re
from pathlib import Path

_ILLEGAL = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_EXPANDED = re.compile(r"\$(?=[A-Za-z_{])")  # "$HOME" in a name: yt-dlp would swap in the variable's value
_RESERVED = {"CON", "PRN", "AUX", "NUL",
             *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
MAX_NAME = 200
MAX_PATH = 240  # leaves room for yt-dlp temp names (".f251-drc.webm.part") under Windows' 259
PARTIAL_DIR = ".ytdl-partial"  # yt-dlp's unfinished files, one sub-folder per video, inside the output folder
MAX_COMPONENT_BYTES = 255  # common file-system limit (ext4, many NAS shares)
TEMP_SUFFIX_BYTES = 16


def sanitize_filename(name: str, max_len: int = MAX_NAME, max_bytes: int | None = None) -> str:
    cleaned = _EXPANDED.sub("＄", _ILLEGAL.sub("_", name)).lstrip(" .")  # a leading dot would make a hidden file
    if cleaned.startswith("~"):  # yt-dlp reads "~name" as another user's home folder
        cleaned = "～" + cleaned[1:]
    if cleaned.split(".")[0].strip().upper() in _RESERVED:
        cleaned = "_" + cleaned
    cleaned = cleaned[:max_len]
    while max_bytes is not None and len(cleaned.encode("utf-8")) > max_bytes:
        cleaned = cleaned[:-1]
    return cleaned.rstrip(" .")


def partial_dir(directory: Path, video_id: str) -> Path:
    """Where yt-dlp keeps one video's unfinished files: two videos with the same title must never share a .part."""
    return Path(directory) / PARTIAL_DIR / video_id


def resolve_target(directory: Path, title: str, video_id: str, ext: str = "mp4",
                   known: dict[str, str] | None = None) -> Path:
    suffix = f" [{video_id}]"
    tail = f".{ext}"
    in_partial = len(PARTIAL_DIR) + 1 + len(video_id) + 1  # "<dir>/.ytdl-partial/<id>/<name>" while downloading
    avail = min(MAX_NAME, MAX_PATH - len(str(directory)) - 1 - in_partial - len(suffix) - len(tail))
    if avail < 1:
        raise ValueError("output directory path is too long")
    max_bytes = MAX_COMPONENT_BYTES - TEMP_SUFFIX_BYTES - len(suffix.encode("utf-8")) - len(tail.encode("utf-8"))
    base = sanitize_filename(title, avail, max_bytes) or video_id
    candidate = directory / f"{base}{tail}"
    try:
        taken = candidate.exists()
    except OSError as exc:
        raise ValueError(f"cannot use this path: {exc}") from exc
    if taken and (known or {}).get(video_id) != candidate.name:
        candidate = directory / f"{base}{suffix}{tail}"
    return candidate
