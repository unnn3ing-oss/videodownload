"""Filename cleaning, path-length limits and collision handling."""
from __future__ import annotations

import re
from pathlib import Path

_ILLEGAL = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_RESERVED = {"CON", "PRN", "AUX", "NUL",
             *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
MAX_NAME = 200
MAX_PATH = 250


def sanitize_filename(name: str, max_len: int = MAX_NAME) -> str:
    cleaned = _ILLEGAL.sub("_", name)
    if cleaned.split(".")[0].strip().upper() in _RESERVED:
        cleaned = "_" + cleaned
    return cleaned[:max_len].rstrip(" .").lstrip(" ")


def resolve_target(directory: Path, title: str, video_id: str, ext: str = "mp4",
                   known: dict[str, str] | None = None) -> Path:
    suffix = f" [{video_id}]"
    tail = f".{ext}"
    avail = min(MAX_NAME, MAX_PATH - len(str(directory)) - 1 - len(suffix) - len(tail))
    if avail < 1:
        raise ValueError("output directory path is too long")
    base = sanitize_filename(title, avail) or video_id
    candidate = directory / f"{base}{tail}"
    if candidate.exists() and (known or {}).get(video_id) != candidate.name:
        candidate = directory / f"{base}{suffix}{tail}"
    return candidate
