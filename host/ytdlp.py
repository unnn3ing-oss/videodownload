"""Everything that talks to the yt-dlp binary: arguments, output parsing, errors."""
from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.parse import parse_qs, urlsplit, urlunsplit

from quality import FORMAT_SORT, format_selector

PROGRESS_PREFIX = "[ytdl-progress]"
DONE_PREFIX = "[ytdl-done]"
_CREATE_NO_WINDOW = 0x08000000


@dataclass
class Engine:
    ytdlp: Path
    ffmpeg_dir: Path | None = None
    js_runtime: Path | None = None

    def base_args(self) -> list[str]:
        args = [str(self.ytdlp), "--ignore-config", "--no-warnings", "--color", "no_color"]
        if self.ffmpeg_dir:
            args += ["--ffmpeg-location", str(self.ffmpeg_dir)]
        if self.js_runtime:
            args += ["--js-runtimes", f"deno:{self.js_runtime}"]
        return args


@dataclass
class Progress:
    percent: float | None
    speed: float | None
    eta: int | None


@dataclass
class DoneInfo:
    video_id: str
    height: int | None
    codec: str | None


@dataclass
class VideoRef:
    id: str
    title: str
    url: str


@dataclass
class StreamResult:
    returncode: int
    stderr: str
    cancelled: bool


class ResolveError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def build_download_args(engine: Engine, url: str, quality: int, target: Path) -> list[str]:
    progress = (f"download:{PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes)s"
                "|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s")
    return engine.base_args() + [
        "--no-playlist",
        "-f", format_selector(quality),
        "-S", FORMAT_SORT,
        "--merge-output-format", "mp4",
        "-o", str(target).replace("%", "%%"),
        "--progress", "--newline",
        "--progress-template", progress,
        "--print", f"after_move:{DONE_PREFIX}%(id)s|%(height)s|%(vcodec)s",
        "--", url,
    ]


def _num(text: str) -> float | None:
    try:
        return float(text)
    except ValueError:
        return None


def parse_progress_line(line: str) -> Progress | None:
    text = line.strip()
    if not text.startswith(PROGRESS_PREFIX):
        return None
    parts = text[len(PROGRESS_PREFIX):].split("|")
    if len(parts) != 5:
        return None
    downloaded, total, estimate, speed, eta = (_num(p) for p in parts)
    size = total or estimate
    percent = min(100.0, downloaded / size * 100) if downloaded is not None and size else None
    return Progress(percent, speed, int(eta) if eta is not None else None)


def parse_done_line(line: str) -> DoneInfo | None:
    text = line.strip()
    if not text.startswith(DONE_PREFIX):
        return None
    parts = text[len(DONE_PREFIX):].split("|")
    if len(parts) != 3:
        return None
    height = _num(parts[1])
    codec = None if parts[2] in ("NA", "none", "") else parts[2]
    return DoneInfo(parts[0], int(height) if height is not None else None, codec)


_ERRORS = [  # order matters: first match wins
    ("private", ("private video",), "這是私人影片，沒有權限下載"),
    ("region", ("in your country", "not available in your region"), "這支影片在目前的地區無法觀看"),
    ("unavailable", ("video unavailable", "has been removed", "no longer available", "has been terminated"),
     "影片無法使用（已下架或不存在）"),
    ("login_required", ("sign in to confirm", "login required", "members-only"),
     "YouTube 要求登入或驗證；請改用住宅或公司網路，或確認是否為年齡限制／會員專屬影片"),
    ("disk_full", ("no space left on device",), "磁碟空間不足"),
    ("network", ("unable to download webpage", "timed out", "temporary failure in name resolution",
                 "network is unreachable", "connection reset", "getaddrinfo failed", "http error 429"),
     "網路連線失敗或逾時，請稍後再試"),
    ("engine_outdated", ("challenge solving failed", "signature solving failed", "unable to extract",
                         "requested format is not available"),
     "下載引擎可能過舊，請按「更新引擎」後再試"),
]


def classify_error(stderr: str) -> tuple[str, str]:
    lowered = stderr.lower()
    for code, needles, message in _ERRORS:
        if any(n in lowered for n in needles):
            return code, message
    last = next((ln for ln in reversed(stderr.strip().splitlines()) if ln.strip()), "")
    return "unknown", f"下載失敗（未知原因）：{last[:200]}"


_CHANNEL_ROOT = re.compile(r"/(@[^/]+|channel/[^/]+|c/[^/]+|user/[^/]+)")


def normalize_url(url: str) -> str:
    parts = urlsplit(url)
    path = parts.path.rstrip("/")
    if _CHANNEL_ROOT.fullmatch(path):
        return urlunsplit(parts._replace(path=path + "/videos"))
    return url


def _popen_kwargs() -> dict:
    if os.name == "nt":
        return {"creationflags": _CREATE_NO_WINDOW}
    return {"start_new_session": True}


def run_capture(cmd: list[str]) -> tuple[int, str, str]:
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=600, **_popen_kwargs())
    except subprocess.TimeoutExpired:
        return 124, "", "timed out"
    except OSError as exc:  # missing, blocked by antivirus/AppLocker, not executable
        return 127, "", str(exc)
    return done.returncode, done.stdout, done.stderr


def _is_single_video(url: str) -> bool:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    path = parts.path.strip("/")
    if host == "youtu.be":
        return bool(path)
    return (path == "watch" and "v" in parse_qs(parts.query)) or path.split("/")[0] in ("shorts", "live", "embed")


def resolve(engine: Engine, urls: list[str], limit: int | None = None,
            run: Callable[[list[str]], tuple[int, str, str]] = run_capture) -> list[VideoRef]:
    refs: list[VideoRef] = []
    failed: list[str] = []
    first_error: ResolveError | None = None
    seen: set[str] = set()
    for url in urls:
        cmd = engine.base_args() + ["--flat-playlist", "--dump-json"]
        if _is_single_video(url):
            cmd.append("--no-playlist")  # a watch URL with &list= means this video, not the whole list
        if limit:
            cmd += ["--playlist-items", f"1:{limit}"]
        cmd += ["--", normalize_url(url)]
        code, out, err = run(cmd)
        entries = []
        for line in out.splitlines():
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if isinstance(entry, dict):
                entries.append(entry)
        if code != 0 and not entries:
            failed.append(url)
            first_error = first_error or ResolveError(*classify_error(err))
            continue
        for entry in entries:
            vid = entry.get("id")
            if not vid or vid in seen:
                continue
            seen.add(vid)
            refs.append(VideoRef(vid, entry.get("title") or vid, f"https://www.youtube.com/watch?v={vid}"))
    if not refs and first_error:
        raise first_error
    refs = refs[:limit] if limit else refs
    # Unresolvable URLs stay in the list without id/title; the job reports each one as a failed item.
    return refs + [VideoRef("", "", url) for url in failed]


def _kill_tree(proc: subprocess.Popen) -> None:
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True,
                       creationflags=_CREATE_NO_WINDOW)
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def stream_download(cmd: list[str], on_line: Callable[[str], None],
                    cancel: threading.Event) -> StreamResult:
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            encoding="utf-8", errors="replace", **_popen_kwargs())
    stderr_parts: list[str] = []
    drain = threading.Thread(target=lambda: stderr_parts.append(proc.stderr.read()), daemon=True)
    drain.start()

    def watch() -> None:
        while proc.poll() is None:
            if cancel.wait(0.1):
                _kill_tree(proc)
                return

    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    for line in proc.stdout:
        on_line(line.rstrip("\r\n"))
    code = proc.wait()
    drain.join()
    watcher.join(timeout=5)
    return StreamResult(code, "".join(stderr_parts), cancel.is_set() and code != 0)
