"""Download jobs: sequential queue, resume bookkeeping and cancellation."""
from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Callable

from naming import resolve_target
from quality import parse_quality
from security import is_allowed_url, safe_output_path
from ytdlp import (Engine, ResolveError, build_download_args, classify_error, parse_done_line,
                   parse_progress_line, resolve, stream_download)

_VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")

PLACEHOLDER_TITLES = {
    "[private video]": ("private", "這是私人影片，沒有權限下載"),
    "[deleted video]": ("unavailable", "影片已被刪除"),
}


class Archive:
    """Hidden per-folder record of video id -> file name, used only for resuming."""

    FILENAME = ".ytdl-archive.json"

    def __init__(self, directory: Path):
        self.directory = Path(directory)
        self.path = self.directory / self.FILENAME

    def mapping(self) -> dict[str, str]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        if not isinstance(data, dict):
            return {}
        return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)}

    def lookup(self, video_id: str) -> str | None:
        name = self.mapping().get(video_id)
        return name if name and (self.directory / name).exists() else None

    def record(self, video_id: str, filename: str) -> None:
        data = self.mapping()
        data[video_id] = filename
        self.directory.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self.path)


class JobRunner:
    def __init__(self, engine: Engine, emit: Callable[[dict], None], stream=stream_download,
                 resolve_fn=resolve, sleep=time.sleep, delay: float = 2.0):
        self.engine = engine
        self._emit = emit
        self._stream = stream
        self._resolve = resolve_fn
        self._sleep = sleep
        self._delay = delay
        self._cancel = threading.Event()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self.running = False

    def start(self, job_id: str, items: list[dict], quality: int, output_dir: Path,
              title_override: str | None = None) -> None:
        quality = parse_quality(quality)
        with self._lock:
            if self.running:
                raise RuntimeError("busy")
            self.running = True
            self._cancel.clear()
            self._thread = threading.Thread(
                target=self._run, args=(job_id, items, quality, Path(output_dir), title_override),
                daemon=True)
            self._thread.start()

    def cancel(self) -> None:
        self._cancel.set()

    def join(self, timeout: float | None = None) -> None:
        thread = self._thread
        if thread:
            thread.join(timeout)

    def _run(self, job_id, items, quality, output_dir, title_override) -> None:
        summary = {"ok": 0, "skipped": 0, "failed": 0, "cancelled": False}

        def fail(item_id: str, code: str, reason: str) -> None:
            summary["failed"] += 1
            self._emit({"type": "item_failed", "jobId": job_id, "itemId": item_id,
                        "reason": reason, "code": code})

        try:
            try:
                output_dir.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                for it in items:
                    fail(it.get("id") or it.get("url") or "?", "bad_path", f"無法建立輸出資料夾：{exc}")
                return
            archive = Archive(output_dir)
            seen: set[str] = set()
            downloaded_any = False
            for it in items:
                if self._cancel.is_set():
                    summary["cancelled"] = True
                    break
                try:
                    outcome = self._one(job_id, it, quality, output_dir, archive, seen, fail,
                                        len(items) == 1 and title_override or None, downloaded_any)
                except Exception as exc:  # one bad item must never end the batch
                    fail(str(it.get("id") or it.get("url") or "?") if isinstance(it, dict) else "?",
                         "unknown", f"內部錯誤：{exc}")
                    outcome = "failed"
                if outcome == "ok":
                    summary["ok"] += 1
                    downloaded_any = True
                elif outcome == "skipped":
                    summary["skipped"] += 1
                elif outcome == "cancelled":
                    summary["cancelled"] = True
                    break
        finally:
            self._emit({"type": "done", "jobId": job_id, "summary": summary})
            self.running = False

    def _one(self, job_id, it, quality, output_dir, archive, seen, fail, override, downloaded_any):
        url = it.get("url")
        vid, title = it.get("id"), it.get("title")
        item_id = vid or url or "?"
        if not is_allowed_url(url):
            fail(item_id, "bad_url", "網址不是 YouTube 的網址")
            return "failed"
        if not vid or not title:
            try:
                refs = self._resolve(self.engine, [url], None)
            except ResolveError as exc:
                fail(item_id, exc.code, exc.message)
                return "failed"
            if not refs:
                fail(item_id, "unavailable", "找不到這支影片")
                return "failed"
            vid, title = vid or refs[0].id, title or refs[0].title
        if not isinstance(vid, str) or not _VIDEO_ID.fullmatch(vid) or not isinstance(title, str):
            fail(str(item_id), "bad_id", "影片資料不正確，已略過")
            return "failed"
        if vid in seen:
            return "duplicate"
        seen.add(vid)
        placeholder = PLACEHOLDER_TITLES.get(title.strip().lower())
        if placeholder:
            fail(vid, *placeholder)
            return "failed"
        existing = archive.lookup(vid)
        if existing:
            self._emit({"type": "item_done", "jobId": job_id, "itemId": vid,
                        "file": str(output_dir / existing), "height": None, "codec": None,
                        "skipped": True})
            return "skipped"
        try:
            target = safe_output_path(
                output_dir, resolve_target(output_dir, override or title, vid, "mp4", archive.mapping()).name)
        except ValueError as exc:
            fail(vid, "bad_path", f"輸出路徑太長：{exc}")
            return "failed"
        if downloaded_any:
            self._sleep(self._delay)
            if self._cancel.is_set():
                return "cancelled"
        info = None

        def on_line(line: str) -> None:
            nonlocal info
            progress = parse_progress_line(line)
            if progress:
                self._emit({"type": "progress", "jobId": job_id, "itemId": vid,
                            "percent": progress.percent, "speed": progress.speed,
                            "eta": progress.eta, "stage": "download"})
                return
            done = parse_done_line(line)
            if done:
                info = done

        try:
            result = self._stream(build_download_args(self.engine, url, quality, target),
                                  on_line, self._cancel)
        except Exception as exc:  # engine missing, permission denied, ...
            fail(vid, "unknown", f"無法執行下載引擎：{exc}")
            return "failed"
        if result.cancelled:
            return "cancelled"
        if result.returncode != 0:
            fail(vid, *classify_error(result.stderr))
            return "failed"
        try:
            archive.record(vid, target.name)
        except OSError:
            pass  # file is on disk; a locked record file only means a rerun cannot skip it
        self._emit({"type": "item_done", "jobId": job_id, "itemId": vid, "file": str(target),
                    "height": info.height if info else None, "codec": info.codec if info else None,
                    "skipped": False})
        return "ok"
