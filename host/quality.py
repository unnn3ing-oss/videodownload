"""Map a requested resolution to a yt-dlp format selector."""
from __future__ import annotations

ALLOWED = (720, 1080)


def parse_quality(value: object) -> int:
    if isinstance(value, bool):
        raise ValueError("quality must be 720 or 1080")
    if isinstance(value, str) and value.isdigit():
        value = int(value)
    if isinstance(value, int) and value in ALLOWED:
        return value
    raise ValueError("quality must be 720 or 1080")


def format_selector(quality: int) -> str:
    """No size filter here: the limit is in format_sort. A `height<=` filter drops a 1080x1920 Short (height 1920)."""
    return "bv*+ba/b"


def format_sort(quality: int) -> str:
    # res is the shorter side, so a vertical 1080x1920 video counts as 1080. `res:N` ranks the best size up to N first
    # (and the smallest above N when nothing fits); then prefer H.264/AAC, never trading 1080p for a 720p H.264 file.
    return f"res:{quality},vcodec:h264,acodec:aac"


def is_h264(codec: str | None) -> bool:
    return bool(codec) and codec.startswith("avc1")
