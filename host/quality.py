"""Map a requested resolution to a yt-dlp format selector."""
from __future__ import annotations

ALLOWED = (720, 1080)
# Resolution first, then prefer H.264/AAC: never trade 1080p for a 720p H.264 file.
FORMAT_SORT = "res,vcodec:h264,acodec:aac"


def parse_quality(value: object) -> int:
    if isinstance(value, bool):
        raise ValueError("quality must be 720 or 1080")
    if isinstance(value, str) and value.isdigit():
        value = int(value)
    if isinstance(value, int) and value in ALLOWED:
        return value
    raise ValueError("quality must be 720 or 1080")


def format_selector(quality: int) -> str:
    return f"bv*[height<={quality}]+ba/b[height<={quality}]"


def is_h264(codec: str | None) -> bool:
    return bool(codec) and codec.startswith("avc1")
