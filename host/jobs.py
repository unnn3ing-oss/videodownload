"""Download jobs: sequential queue, resume bookkeeping and cancellation."""
from __future__ import annotations

import json
import os
import threading
import time
from collections import deque
from pathlib import Path
from typing import Callable

from naming import resolve_target
from quality import parse_quality
from security import VIDEO_ID, is_allowed_url, safe_output_path
from ytdlp import (Engine, ResolveError, build_download_args, classify_error, parse_done_line,
                   parse_progress_line, resolve, stream_download)

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
        self._pending: deque = deque()
        self._closing = False
        self._current: tuple[str | None, threading.Event] | None = None
        self.running = False

    def start(self, job_id: str, items: list[dict], quality: int, output_dir: Path,
              title_override: str | None = None, cooldown: float | None = None) -> None:
        quality = parse_quality(quality)
        seconds = self._delay if cooldown is None else float(cooldown)
        with self._lock:
            if self.running:
                raise RuntimeError("busy")
            self.running = True
            self._closing = False
            self._cancel.clear()
            self._pending = deque(items)
            self._current = None
            self._thread = threading.Thread(
                target=self._run,
                args=(job_id, len(items), quality, Path(output_dir), title_override, seconds),
                daemon=True)
            self._thread.start()

    def enqueue(self, items: list[dict]) -> bool:
        """Append to the running job; False when there is none (or it is already wrapping up)."""
        with self._lock:
            if not self.running or self._closing or self._cancel.is_set():
                return False
            self._pending.extend(items)
            return True

    def remove(self, item_id: str) -> str | None:
        """Drop a waiting item, or cancel just the one being processed (downloading or cooling down)."""
        with self._lock:
            for it in list(self._pending):
                if isinstance(it, dict) and it.get("id") == item_id:
                    self._pending.remove(it)
                    return "pending"
            if self._current and self._current[0] == item_id:
                self._current[1].set()
                return "current"
        return None

    def cancel(self) -> None:
        with self._lock:
            self._cancel.set()
            if self._current:
                self._current[1].set()

    def join(self, timeout: float | None = None) -> None:
        thread = self._thread
        if thread:
            thread.join(timeout)

    def _run(self, job_id, count, quality, output_dir, title_override, cooldown) -> None:
        summary = {"ok": 0, "skipped": 0, "failed": 0, "cancelled": False}

        def fail(item_id: str, code: str, reason: str) -> None:
            summary["failed"] += 1
            self._emit({"type": "item_failed", "jobId": job_id, "itemId": item_id,
                        "reason": reason, "code": code})

        try:
            try:
                output_dir.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                with self._lock:
                    self._closing = True
                    items, self._pending = list(self._pending), deque()
                for it in items:
                    fail(it.get("id") or it.get("url") or "?", "bad_path", f"無法建立輸出資料夾：{exc}")
                return
            archive = Archive(output_dir)
            seen: set[str] = set()
            downloaded_any = False
            while True:
                with self._lock:
                    if self._cancel.is_set() and self._pending:
                        summary["cancelled"] = True
                    if self._cancel.is_set() or not self._pending:
                        self._closing = True
                        break
                    it = self._pending.popleft()
                    item_cancel = threading.Event()
                    self._current = (it.get("id") if isinstance(it, dict) else None, item_cancel)
                try:
                    outcome = self._one(job_id, it, quality, output_dir, archive, seen, fail,
                                        count == 1 and title_override or None, downloaded_any,
                                        cooldown, item_cancel)
                except Exception as exc:  # one bad item must never end the batch
                    fail(str(it.get("id") or it.get("url") or "?") if isinstance(it, dict) else "?",
                         "unknown", f"內部錯誤：{exc}")
                    outcome = "failed"
                finally:
                    with self._lock:
                        self._current = None
                if outcome in ("failed", "removed") and isinstance(it, dict):
                    seen.discard(it.get("id"))  # a retry or a re-added copy must be allowed to run in this job
                if outcome == "ok":
                    summary["ok"] += 1
                    downloaded_any = True
                elif outcome == "skipped":
                    summary["skipped"] += 1
                elif outcome == "cancelled":
                    summary["cancelled"] = True
                    break
        finally:
            with self._lock:
                self._closing = True
            self._emit({"type": "done", "jobId": job_id, "summary": summary})
            self.running = False

    def _stopped(self, job_id: str, item_id: str, item_cancel: threading.Event) -> str | None:
        """'cancelled' when the whole job was stopped, 'removed' when only this item was."""
        if self._cancel.is_set():
            return "cancelled"
        if item_cancel.is_set():
            self._emit({"type": "item_removed", "jobId": job_id, "itemId": item_id})
            return "removed"
        return None

    def _cooldown(self, job_id: str, next_id: str, seconds: float, item_cancel: threading.Event) -> None:
        self._emit({"type": "cooldown", "jobId": job_id, "seconds": seconds, "nextId": next_id})
        remaining = float(seconds)
        while remaining > 0 and not self._cancel.is_set() and not item_cancel.is_set():
            step = min(1.0, remaining)
            self._sleep(step)
            remaining -= step

    def _one(self, job_id, it, quality, output_dir, archive, seen, fail, override, downloaded_any,
             cooldown, item_cancel):
        url = it.get("url")
        vid, title = it.get("id"), it.get("title")
        item_id = vid or url or "?"
        stopped = self._stopped(job_id, item_id, item_cancel)
        if stopped:
            return stopped
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
        if not isinstance(vid, str) or not VIDEO_ID.fullmatch(vid) or not isinstance(title, str):
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
        if downloaded_any and cooldown > 0:
            self._cooldown(job_id, vid, cooldown, item_cancel)
        stopped = self._stopped(job_id, vid, item_cancel)
        if stopped:
            return stopped
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
                                  on_line, item_cancel)
        except Exception as exc:  # engine missing, permission denied, ...
            fail(vid, "unknown", f"無法執行下載引擎：{exc}")
            return "failed"
        if result.cancelled:
            return self._stopped(job_id, vid, item_cancel) or "cancelled"
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
