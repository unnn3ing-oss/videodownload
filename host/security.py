"""URL allow-list and output-path safety."""
from __future__ import annotations

from pathlib import Path
from urllib.parse import urlsplit


def is_allowed_url(url: object) -> bool:
    if not isinstance(url, str):
        return False
    try:
        parts = urlsplit(url.strip())
        host = (parts.hostname or "").lower()
    except ValueError:
        return False
    if parts.scheme not in ("http", "https"):
        return False
    return host == "youtu.be" or host == "youtube.com" or host.endswith(".youtube.com")


def safe_output_path(base: Path, name: str) -> Path:
    if not name or "/" in name or "\\" in name or name in (".", ".."):
        raise ValueError("invalid file name")
    root = Path(base).resolve()
    target = (root / name).resolve()
    if target.parent != root:
        raise ValueError("path escapes the output directory")
    return target
