"""URL allow-list and output-path safety."""
from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import urlsplit

VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")


ALLOWED_HOSTS = frozenset({"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"})
MAX_URL_LENGTH = 2048
# (extension/lib/urls.js keeps the same list; a test keeps them equal)


def is_allowed_url(url: object) -> bool:
    """Only the YouTube addresses people really paste: a listed host, http(s) on its own port, no user name or password,
    nothing that a program could read as more than one argument or one line."""
    if not isinstance(url, str) or len(url) > MAX_URL_LENGTH:
        return False
    text = url.strip()
    if not text or any(ch.isspace() or ord(ch) < 32 or ord(ch) == 127 or ch == "\\" for ch in text):
        return False
    try:
        parts = urlsplit(text)
        host = (parts.hostname or "").lower()
        port = parts.port
    except ValueError:
        return False
    if parts.scheme not in ("http", "https") or parts.username is not None or parts.password is not None:
        return False
    if port is not None and port != (443 if parts.scheme == "https" else 80):
        return False
    return host in ALLOWED_HOSTS


def safe_output_path(base: Path, name: str) -> Path:
    if not name or "/" in name or "\\" in name or name in (".", ".."):
        raise ValueError("invalid file name")
    root = Path(base).resolve()
    target = (root / name).resolve()
    if target.parent != root:
        raise ValueError("path escapes the output directory")
    return target
