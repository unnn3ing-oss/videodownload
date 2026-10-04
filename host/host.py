"""Native Messaging host: reads requests from Chrome, drives yt-dlp, streams events back."""
from __future__ import annotations

import os
import sys
import threading
import uuid
from pathlib import Path
from typing import BinaryIO, Callable

from config import ConfigStore
from jobs import JobRunner
from protocol import BadMessage, ProtocolError, read_message, write_message
from quality import parse_quality
from security import is_allowed_url
from ytdlp import Engine, ResolveError, resolve, run_capture

HOST_VERSION = "0.1.0"
HANDLED = {"ping", "resolve", "download", "cancel", "get_config", "set_config", "update_engine"}
MAX_LIMIT = 1000


def locate_engine(home: Path) -> Engine:
    exe = ".exe" if os.name == "nt" else ""
    bin_dir = Path(home) / "bin"
    return Engine(
        bin_dir / f"yt-dlp{exe}",
        bin_dir if (bin_dir / f"ffmpeg{exe}").exists() else None,
        bin_dir / f"deno{exe}" if (bin_dir / f"deno{exe}").exists() else None,
    )


class Host:
    def __init__(self, home: Path, emit: Callable[[dict], None]):
        self.home = Path(home)
        self._emit = emit
        self.engine = locate_engine(self.home)
        self.config = ConfigStore(self.home / "config.json")
        self.runner = JobRunner(self.engine, emit)
        self._threads: list[threading.Thread] = []

    # -- helpers ---------------------------------------------------------
    def _reply(self, msg: dict, payload: dict) -> None:
        if "reqId" in msg:
            payload = {**payload, "reqId": msg["reqId"]}
        self._emit(payload)

    def _error(self, msg: dict, code: str, message: str) -> None:
        self._reply(msg, {"type": "error", "code": code, "message": message})

    def _background(self, fn: Callable[[], None]) -> None:
        thread = threading.Thread(target=fn, daemon=True)
        self._threads.append(thread)
        thread.start()

    def _engine_present(self) -> bool:
        return self.engine.ytdlp.exists()

    def _version(self) -> str | None:
        if not self._engine_present():
            return None
        code, out, _ = run_capture([str(self.engine.ytdlp), "--version"])
        return out.strip() if code == 0 and out.strip() else None

    def ready_message(self) -> dict:
        return {"type": "ready", "hostVersion": HOST_VERSION, "ytdlpVersion": self._version(),
                "ffmpegOk": self.engine.ffmpeg_dir is not None,
                "jsRuntimeOk": self.engine.js_runtime is not None,
                "outputDir": str(self.config.output_dir)}

    def wait(self, timeout: float | None = None) -> None:
        for thread in list(self._threads):
            thread.join(timeout)
        self.runner.join(timeout)

    def shutdown(self) -> None:
        self.runner.cancel()
        self.runner.join(5)

    # -- dispatch --------------------------------------------------------
    def handle(self, msg: dict) -> None:
        kind = msg.get("type")
        if kind not in HANDLED:
            self._error(msg, "unknown_type", f"未知的訊息類型：{kind}")
            return
        try:
            getattr(self, f"_on_{kind}")(msg)
        except Exception as exc:  # never let one bad request end the host
            self._error(msg, "internal", f"內部錯誤：{exc}")

    def _on_ping(self, msg: dict) -> None:
        self._reply(msg, {"type": "pong"})

    def _on_get_config(self, msg: dict) -> None:
        self._reply(msg, {"type": "config", "outputDir": str(self.config.output_dir)})

    def _on_set_config(self, msg: dict) -> None:
        try:
            path = self.config.set_output_dir(msg.get("outputDir"))
        except (ValueError, OSError) as exc:
            self._error(msg, "bad_path", f"無法使用這個資料夾：{exc}")
            return
        self._reply(msg, {"type": "config", "outputDir": str(path)})

    def _on_cancel(self, msg: dict) -> None:
        self.runner.cancel()

    def _on_resolve(self, msg: dict) -> None:
        urls, limit = msg.get("urls"), msg.get("limit")
        if not isinstance(urls, list) or not urls or not all(is_allowed_url(u) for u in urls):
            self._error(msg, "bad_url", "只支援 YouTube 網址")
            return
        if limit is not None and not (isinstance(limit, int) and not isinstance(limit, bool)
                                      and 1 <= limit <= MAX_LIMIT):
            limit = None
        if not self._engine_present():
            self._error(msg, "engine_missing", "找不到下載引擎，請重新執行安裝檔")
            return

        def work() -> None:
            try:
                refs = resolve(self.engine, urls, limit)
            except ResolveError as exc:
                self._error(msg, exc.code, exc.message)
                return
            self._reply(msg, {"type": "resolved", "items": [
                {"id": r.id, "title": r.title, "url": r.url} for r in refs]})

        self._background(work)

    def _on_download(self, msg: dict) -> None:
        items = msg.get("items")
        if (not isinstance(items, list) or not items
                or not all(isinstance(i, dict) and is_allowed_url(i.get("url")) for i in items)):
            self._error(msg, "bad_url", "只支援 YouTube 網址")
            return
        try:
            quality = parse_quality(msg.get("quality"))
        except ValueError:
            self._error(msg, "bad_quality", "畫質只能是 720 或 1080")
            return
        if not self._engine_present():
            self._error(msg, "engine_missing", "找不到下載引擎，請重新執行安裝檔")
            return
        if self.runner.running:
            self._error(msg, "busy", "已有下載工作進行中")
            return
        override = msg.get("titleOverride")
        job_id = uuid.uuid4().hex
        self._reply(msg, {"type": "started", "jobId": job_id})
        try:
            self.runner.start(job_id, items, quality, self.config.output_dir,
                              override if isinstance(override, str) and override.strip() else None)
        except RuntimeError:
            self._error(msg, "busy", "已有下載工作進行中")

    def _on_update_engine(self, msg: dict) -> None:
        if not self._engine_present():
            self._error(msg, "engine_missing", "找不到下載引擎，請重新執行安裝檔")
            return

        def work() -> None:
            code, out, err = run_capture([str(self.engine.ytdlp), "-U"])
            if code != 0:
                self._error(msg, "update_failed", f"更新失敗：{(err or out).strip()[-200:]}")
                return
            self._reply(msg, {"type": "engine_updated", "ytdlpVersion": self._version()})

        self._background(work)


def main(argv=None, stdin: BinaryIO | None = None, stdout: BinaryIO | None = None) -> int:
    if stdin is None or stdout is None:
        if os.name == "nt":
            import msvcrt
            msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
            msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
        stdin = stdin or sys.stdin.buffer
        stdout = stdout or sys.stdout.buffer
    home = Path(os.environ.get("YTDL_HOME") or Path(__file__).resolve().parent.parent)
    lock = threading.Lock()
    host: Host | None = None

    def emit(message: dict) -> None:
        with lock:
            try:
                write_message(stdout, message)
            except ProtocolError:
                write_message(stdout, {"type": "error", "code": "too_large",
                                       "message": "回應太大，無法傳送"})
            except (OSError, ValueError):
                if host:
                    host.runner.cancel()

    real_stdout, sys.stdout = sys.stdout, sys.stderr  # stray prints must not hit the protocol stream
    try:
        host = Host(home, emit)
        emit(host.ready_message())
        while True:
            try:
                msg = read_message(stdin)
            except BadMessage as exc:
                emit({"type": "error", "code": "bad_json", "message": str(exc)})
                continue
            except ProtocolError:
                host.shutdown()
                return 1
            if msg is None:
                break
            host.handle(msg)
        host.shutdown()
        return 0
    finally:
        sys.stdout = real_stdout


if __name__ == "__main__":
    sys.exit(main())
