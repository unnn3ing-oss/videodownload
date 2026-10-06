"""Native Messaging host: reads requests from Chrome, drives yt-dlp, streams events back."""
from __future__ import annotations

import base64
import binascii
import os
import re
import sys
import threading
import uuid
from pathlib import Path
from typing import BinaryIO, Callable

import extupdate
import selfupdate
from install_record import recorded_extension_folder
from config import ConfigStore
from covers import CoverError, save_cover
from jobs import JobRunner
from protocol import BadMessage, ProtocolError, read_message, write_message
from quality import parse_quality
from security import VIDEO_ID, is_allowed_url
from version import VERSION
import doctor
import macos_engine
from ytdlp import Engine, ResolveError, fetch_meta, resolve, run_capture

HANDLED = {"ping", "resolve", "download", "cancel", "get_config", "set_config", "update_engine",
           "update_check", "update_stage", "update_commit", "update_rollback", "update_ext", "update_ext_rollback", "save_cover", "meta", "enqueue", "remove", "doctor"}
MAX_LIMIT = 1000
MAX_COOLDOWN = 300


def _uses_macos_engine() -> bool:
    return sys.platform == "darwin"


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
        return {"type": "ready", "hostVersion": VERSION, "ytdlpVersion": self._version(),
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
            except Exception as exc:
                self._error(msg, "internal", f"無法執行下載引擎：{exc}")
                return
            self._reply(msg, {"type": "resolved", "items": [
                {"id": r.id, "title": r.title, "url": r.url, "duration": r.duration} for r in refs]})

        self._background(work)

    def _on_meta(self, msg: dict) -> None:
        url = msg.get("url")
        if not is_allowed_url(url):
            self._error(msg, "bad_url", "只支援 YouTube 網址")
            return
        if not self._engine_present():
            self._error(msg, "engine_missing", "找不到下載引擎，請重新執行安裝檔")
            return

        def work() -> None:
            try:
                meta = fetch_meta(self.engine, url)
            except ResolveError as exc:
                self._error(msg, exc.code, exc.message)
                return
            except Exception as exc:
                self._error(msg, "internal", f"無法執行下載引擎：{exc}")
                return
            self._reply(msg, {"type": "meta", **meta})

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
        cooldown = msg.get("cooldownSec")
        if (isinstance(cooldown, bool) or not isinstance(cooldown, (int, float))
                or not 0 <= cooldown <= MAX_COOLDOWN):
            cooldown = None  # absent or out of range: the runner's default
        job_id = uuid.uuid4().hex
        self._reply(msg, {"type": "started", "jobId": job_id})
        try:
            self.runner.start(job_id, items, quality, self.config.output_dir,
                              override if isinstance(override, str) and override.strip() else None,
                              cooldown)
        except RuntimeError:
            self._error(msg, "busy", "已有下載工作進行中")

    def _on_enqueue(self, msg: dict) -> None:
        items = msg.get("items")
        if (not isinstance(items, list) or not items
                or not all(isinstance(i, dict) and is_allowed_url(i.get("url")) for i in items)):
            self._error(msg, "bad_url", "只支援 YouTube 網址")
            return
        if not self.runner.enqueue(items):
            self._error(msg, "not_running", "目前沒有進行中的下載工作")
            return
        self._reply(msg, {"type": "enqueued", "count": len(items)})

    def _on_remove(self, msg: dict) -> None:
        item_id = msg.get("itemId")
        where = self.runner.remove(item_id) if isinstance(item_id, str) else None
        if where is None:
            self._error(msg, "not_found", "清單中沒有這支影片")
            return
        self._reply(msg, {"type": "removed", "itemId": item_id, "where": where})

    def _on_save_cover(self, msg: dict) -> None:
        video_id, title, data = msg.get("id"), msg.get("title"), msg.get("data")
        if not isinstance(video_id, str) or not VIDEO_ID.fullmatch(video_id):
            self._error(msg, "bad_id", "影片 ID 不正確")
            return
        if not isinstance(title, str) or not isinstance(data, str):
            self._error(msg, "bad_cover", "封面資料格式不正確")
            return
        try:
            raw = base64.b64decode(data, validate=True)
            path = save_cover(self.config.output_dir, video_id, title, raw)
        except (binascii.Error, ValueError):
            self._error(msg, "bad_cover", "封面圖片不是有效的編碼")
            return
        except CoverError as exc:
            self._error(msg, exc.code, exc.message)
            return
        self._reply(msg, {"type": "cover_saved", "file": str(path)})

    # -- self-update of the host's own files (the extension coordinates it) -------------------
    def _update_error(self, msg: dict, exc: selfupdate.UpdateError) -> None:
        payload = {"type": "error", "code": exc.code, "message": exc.message}
        if exc.rolled_back:
            payload["rolledBack"] = True
        self._reply(msg, payload)

    def _busy(self, msg: dict) -> bool:
        if self.runner.running:
            self._error(msg, "busy", "下載進行中，請等下載結束再更新")
            return True
        return False

    def _on_update_check(self, msg: dict) -> None:
        try:
            files = selfupdate.validate_files(msg.get("files"))
        except selfupdate.UpdateError as exc:
            self._update_error(msg, exc)
            return
        changed = selfupdate.changed_files(self.home / "host", files)
        folder = recorded_extension_folder(self.home)
        self._reply(msg, {"type": "update_status", "changed": changed, "total": len(files),
                          "extensionFolder": str(folder) if folder else None})

    def _on_update_stage(self, msg: dict) -> None:
        if self._busy(msg):
            return
        commit, files = msg.get("commit"), msg.get("files")
        try:
            contents = selfupdate.decode_contents(msg.get("contents"), selfupdate.validate_files(files))
        except selfupdate.UpdateError as exc:
            self._update_error(msg, exc)
            return

        def work() -> None:
            try:
                count = selfupdate.stage(self.home, commit, files, contents=contents)
            except selfupdate.UpdateError as exc:
                self._update_error(msg, exc)
                return
            except Exception as exc:
                self._error(msg, "internal", f"更新失敗：{exc}")
                return
            self._reply(msg, {"type": "update_staged", "count": count})

        self._background(work)

    def _on_update_commit(self, msg: dict) -> None:
        if self._busy(msg):
            return
        try:
            count = selfupdate.commit_update(self.home)
        except selfupdate.UpdateError as exc:
            self._update_error(msg, exc)
            return
        self._reply(msg, {"type": "update_applied", "count": count})

    def _on_update_rollback(self, msg: dict) -> None:
        try:
            selfupdate.rollback_update(self.home)
        except selfupdate.UpdateError as exc:
            self._update_error(msg, exc)
            return
        self._reply(msg, {"type": "update_rolled_back"})

    def _on_update_ext(self, msg: dict) -> None:
        if self._busy(msg):
            return
        files, raw = msg.get("files"), msg.get("contents")
        if not isinstance(raw, dict):
            self._error(msg, "update_bad_file", "更新內容格式不正確")
            return
        decoded = {}
        for name, value in raw.items():
            try:
                if not isinstance(value, str):
                    raise ValueError("not text")
                decoded[name] = base64.b64decode(value, validate=True)
            except ValueError:
                self._error(msg, "update_bad_file", f"{name} 的內容不是有效的編碼")
                return

        def work() -> None:
            try:
                count = extupdate.apply(self.home, files, decoded)
            except extupdate.ExtUpdateError as exc:
                payload = {"type": "error", "code": exc.code, "message": exc.message}
                if exc.rolled_back:
                    payload["rolledBack"] = True
                self._reply(msg, payload)
                return
            folder = recorded_extension_folder(self.home)
            self._reply(msg, {"type": "update_ext_applied", "count": count, "folder": str(folder)})

        self._background(work)

    def _on_update_ext_rollback(self, msg: dict) -> None:
        try:
            extupdate.rollback(self.home)
        except extupdate.ExtUpdateError as exc:
            self._error(msg, exc.code, exc.message)
            return
        self._reply(msg, {"type": "update_ext_rolled_back"})

    def _on_doctor(self, msg: dict) -> None:
        ext = msg.get("extensionId")
        ext_id = ext if isinstance(ext, str) and re.fullmatch(r"[a-p]{32}", ext) else None
        fix = msg.get("fix") is True

        def work() -> None:
            output = self.config.output_dir
            fixed = doctor.repair(self.home, output_dir=output) if fix else []
            checks = doctor.diagnose(self.home, ext_id=ext_id, output_dir=output)
            self._reply(msg, {"type": "doctor", "checks": [c.to_dict() for c in checks], "fixed": fixed})

        self._background(work)

    def _on_update_engine(self, msg: dict) -> None:
        # On a Mac the engine is the unpacked build, which cannot update itself (`-U`): it is installed again instead,
        # which also replaces a broken or single-file install.
        mac = _uses_macos_engine()
        if not mac and not self._engine_present():
            self._error(msg, "engine_missing", "找不到下載引擎，請重新執行安裝檔")
            return

        def work() -> None:
            try:
                if mac:
                    macos_engine.install(self.engine.ytdlp.parent)
                else:
                    code, out, err = run_capture([str(self.engine.ytdlp), "-U"])
                    if code != 0:
                        self._error(msg, "update_failed", f"更新失敗：{(err or out).strip()[-200:]}")
                        return
            except Exception as exc:
                self._error(msg, "update_failed", f"更新失敗：{exc}")
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
