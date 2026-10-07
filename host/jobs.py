"""Download jobs: sequential queue, resume bookkeeping and cancellation."""
from __future__ import annotations

import json
import os
import random
import shutil
import threading
import time
from collections import deque
from pathlib import Path
from typing import Callable

from naming import PARTIAL_DIR, partial_dir, resolve_target
from quality import parse_quality
from security import VIDEO_ID, is_allowed_url, safe_output_path
from ytdlp import (Engine, ResolveError, build_download_args, classify_error, parse_done_line,
                   parse_progress_line, resolve, stream_download)

# A run of these means YouTube (or the network) is pushing back: wait longer, then give up before it gets worse.
THROTTLE_CODES = {"network", "rate_limited", "login_required", "forbidden", "tls"}
FATAL_CODES = {"disk_full"}  # every following video would fail the same way
MAX_THROTTLE_STREAK = 3
MAX_MERGE_FAILURES = 2  # each one is a full download, so a broken ffmpeg is stopped sooner
MIN_BACKOFF, MAX_BACKOFF = 5.0, 120.0
JITTER = 0.25  # the wait between two attempts gets up to a quarter extra, so the rhythm is not machine-regular
ABORT_MESSAGES = {
    "network": "網路連線連續失敗，已先停止下載；請確認網路正常後再繼續",
    "rate_limited": "YouTube 連續限制了請求，已先停止下載以免被封鎖；請等一個小時以上，並把「每支間隔」調高後再繼續",
    "login_required": "YouTube 連續要求登入或驗證，已先停止下載；請稍後再試，或改用住宅或公司網路",
    "forbidden": "YouTube 連續拒絕了請求（403），已先停止下載；請稍後再試，並把「每支間隔」調高",
    "tls": "公司網路可能攔截了加密連線（憑證驗證失敗），已先停止下載；請洽資訊人員",
    "disk_full": "磁碟空間不足，已先停止下載；請清出空間，或到設定換一個資料夾後再繼續",
    "merge_failed": "影片連續合併失敗（ffmpeg 可能無法使用），已先停止下載；請按「檢查環境」修復後再繼續",
}

PLACEHOLDER_TITLES = {
    "[private video]": ("private", "這是私人影片，沒有權限下載"),
    "[deleted video]": ("unavailable", "影片已被刪除"),
}


def _has_content(path: Path) -> bool:
    try:
        return path.stat().st_size > 0
    except OSError:
        return False


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
                 resolve_fn=resolve, sleep=time.sleep, delay: float = 2.0, jitter=random.random):
        self.engine = engine
        self._emit = emit
        self._stream = stream
        self._resolve = resolve_fn
        self._sleep = sleep
        self._delay = delay
        self._jitter = jitter
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
        summary = {"ok": 0, "skipped": 0, "failed": 0, "cancelled": False, "aborted": None}
        last_code = None  # class of the failure the current item ended with

        def fail(item_id: str, code: str, reason: str) -> None:
            nonlocal last_code
            last_code = code
            summary["failed"] += 1
            self._emit({"type": "item_failed", "jobId": job_id, "itemId": item_id,
                        "reason": reason, "code": code})

        try:
            try:
                output_dir.mkdir(parents=True, exist_ok=True)
            except OSError as exc:  # no item was tried, so none gets an event: they stay waiting in the extension
                with self._lock:
                    self._closing = True
                summary["aborted"] = {"code": "bad_path",
                                      "message": f"無法建立輸出資料夾（{exc}）；請到設定換一個資料夾"}
                return
            archive = Archive(output_dir)
            seen: set[str] = set()
            attempted = touched = False  # any earlier network attempt / this item's first one has begun
            streak = merge_failures = 0  # throttle-class failures in a row, and merge failures in a row

            def wait_turn(next_id: str, item_cancel: threading.Event) -> str | None:
                """Called right before an item first touches the network: waits out the cooldown after an earlier try."""
                nonlocal attempted, touched
                if touched:
                    return None
                touched = True
                if attempted:
                    seconds = self._pause(cooldown, streak)
                    if seconds > 0:
                        self._cooldown(job_id, next_id, seconds, item_cancel)
                attempted = True
                return self._stopped(job_id, next_id, item_cancel)

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
                touched, last_code = False, None
                try:
                    outcome = self._one(job_id, it, quality, output_dir, archive, seen, fail,
                                        count == 1 and title_override or None, wait_turn, item_cancel)
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
                elif outcome == "skipped":
                    summary["skipped"] += 1
                elif outcome == "cancelled":
                    summary["cancelled"] = True
                    break
                if touched and outcome in ("ok", "failed"):  # an item that never reached the network proves nothing
                    streak = streak + 1 if outcome == "failed" and last_code in THROTTLE_CODES else 0
                    merge_failures = merge_failures + 1 if outcome == "failed" and last_code == "merge_failed" else 0
                if outcome == "failed" and (last_code in FATAL_CODES or streak >= MAX_THROTTLE_STREAK
                                            or merge_failures >= MAX_MERGE_FAILURES):
                    summary["aborted"] = {"code": last_code, "message": ABORT_MESSAGES[last_code]}
                    break  # the items still waiting were never tried: they get no event
        finally:
            with self._lock:
                self._closing = True
            try:
                self._emit({"type": "done", "jobId": job_id, "summary": summary})
            finally:
                self.running = False  # a failed send must not leave the runner stuck as busy

    def _pause(self, cooldown: float, streak: int) -> float:
        """Seconds before the next network attempt: the cooldown, doubling per throttle failure in a row."""
        base = max(MIN_BACKOFF, cooldown) * 2 ** (streak - 1) if streak else cooldown
        seconds = base * (1 + JITTER * self._jitter())
        if streak:
            seconds = min(seconds, MAX_BACKOFF)
        return max(seconds, cooldown)  # never less than what the person asked for

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

    def _one(self, job_id, it, quality, output_dir, archive, seen, fail, override, wait_turn, item_cancel):
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
            stopped = wait_turn(item_id, item_cancel)
            if stopped:
                return stopped
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
        stopped = wait_turn(vid, item_cancel) or self._stopped(job_id, vid, item_cancel)
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
            result = self._stream(build_download_args(self.engine, url, quality, target,
                                                      partial_dir(output_dir, vid)),
                                  on_line, item_cancel)
        except Exception as exc:  # engine missing, permission denied, ...
            fail(vid, "unknown", f"無法執行下載引擎：{exc}")
            return "failed"
        if result.cancelled:
            return self._stopped(job_id, vid, item_cancel) or "cancelled"
        if result.returncode != 0:
            fail(vid, *classify_error(result.stderr))
            return "failed"
        if info is None or not _has_content(target):
            # with an unusable ffmpeg yt-dlp still exits 0 and prints its done line, but leaves "Title.f137.mp4" and
            # "Title.f140.m4a" apart instead of "Title.mp4"
            fail(vid, "merge_failed", "影片已下載但沒有合併成功（ffmpeg 可能無法使用），請按「檢查環境」")
            return "failed"
        shutil.rmtree(partial_dir(output_dir, vid), ignore_errors=True)  # kept after a failure: a retry resumes there
        try:
            (output_dir / PARTIAL_DIR).rmdir()  # only goes while no other video has unfinished files in it
        except OSError:
            pass
        try:
            archive.record(vid, target.name)
        except OSError:
            pass  # file is on disk; a locked record file only means a rerun cannot skip it
        self._emit({"type": "item_done", "jobId": job_id, "itemId": vid, "file": str(target),
                    "height": info.height if info else None, "codec": info.codec if info else None,
                    "skipped": False})
        return "ok"
