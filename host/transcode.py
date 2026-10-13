"""Turn a downloaded video into a plain H.264 mp4 that every player opens.

Instagram's best video is VP9; yt-dlp puts it into an .mp4, and QuickTime, Finder previews and many editors cannot play
that combination. The sound (AAC) is copied as it is.
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Callable

from ytdlp import Engine, StreamResult, stream_download

# tried in this order: the software encoder every full ffmpeg build has, then the Mac's hardware one
ENCODERS = (
    ("libx264", ["-preset", "veryfast", "-crf", "23"]),
    ("h264_videotoolbox", ["-b:v", "8M"]),
)


def ffmpeg_path(engine: Engine) -> str:
    if engine.ffmpeg_dir is None:
        return "ffmpeg"
    return str(Path(engine.ffmpeg_dir) / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg"))


def ffmpeg_command(ffmpeg: str, src: Path, dst: Path, encoder: str, options: list[str] | None = None) -> list[str]:
    return [ffmpeg, "-y", "-nostdin", "-v", "error", "-i", str(src),
            "-map", "0:v:0", "-map", "0:a:0?",
            "-c:v", encoder, *(options or []), "-pix_fmt", "yuv420p",
            "-c:a", "copy", "-movflags", "+faststart", str(dst)]


def convert_to_h264(engine: Engine, src: Path, work: Path, cancel,
                    stream: Callable[..., StreamResult] = stream_download) -> str:
    """Replace `src` by an H.264 version of itself. Returns "ok", "failed" (src untouched) or "cancelled"."""
    work.mkdir(parents=True, exist_ok=True)
    tmp = work / "h264.mp4"
    try:
        for encoder, options in ENCODERS:
            tmp.unlink(missing_ok=True)
            result = stream(ffmpeg_command(ffmpeg_path(engine), src, tmp, encoder, options), lambda line: None, cancel)
            if result.cancelled:
                return "cancelled"
            if result.returncode == 0 and tmp.exists() and tmp.stat().st_size > 0:
                os.replace(tmp, src)
                return "ok"
        return "failed"
    except OSError:
        return "failed"
    finally:
        tmp.unlink(missing_ok=True)
        try:
            work.rmdir()
        except OSError:
            pass
