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
    q = quality
    return (
        f"bv*[height<={q}][vcodec^=avc1]+ba[acodec^=mp4a]"
        f"/bv*[height<={q}]+ba/b[height<={q}]"
    )


def is_h264(codec: str | None) -> bool:
    return bool(codec) and codec.startswith("avc1")
