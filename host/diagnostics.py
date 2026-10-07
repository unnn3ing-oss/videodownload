"""The diagnostics bundle: one block of plain text a colleague can send to the maintainer.

Versions, the environment check, what the installer recorded, the tail of the host's and the installer's logs and the
last download job. Nothing else: no cover data, no cookies, no environment variables. Everything is redacted and the
whole text is capped, so it fits one Native Messaging reply. Standard library only.
"""
from __future__ import annotations

import json
import platform
import sys
import time
from pathlib import Path
from typing import Callable

from hostlog import redact
from install_record import read_record

MAX_BYTES = 60 * 1024
LOG_LINES = 200
_READ_BYTES = 1 << 20  # a log is read from its last megabyte at most
_CUT = "…cut…\n"


def cap(text: str, limit: int = MAX_BYTES) -> str:
    """At most `limit` bytes of UTF-8; when it does not fit the end is kept (that is the newest) behind a marker."""
    raw = text.encode("utf-8")
    if len(raw) <= limit:
        return text
    keep = limit - len(_CUT.encode("utf-8"))
    return _CUT + raw[-keep:].decode("utf-8", errors="ignore")


def _attempt(fn: Callable[[], object]) -> tuple[object, str | None]:
    try:
        return fn(), None
    except Exception as exc:  # one section failing must not lose the others
        return None, f"（無法取得：{type(exc).__name__}: {exc}）"


def _log_tail(path: Path) -> str | None:
    try:
        with open(path, "rb") as handle:
            handle.seek(0, 2)
            handle.seek(max(0, handle.tell() - _READ_BYTES))
            raw = handle.read()
    except OSError:
        return None
    return "\n".join(raw.decode("utf-8", errors="replace").splitlines()[-LOG_LINES:])


def _title(checks: list, check_id: str, fallback: str) -> str:
    return next((c.title for c in checks if c.id == check_id), fallback)


def _versions(ready: dict, ready_error: str | None, checks: list) -> str:
    ffmpeg, deno = ready.get("ffmpegOk"), ready.get("jsRuntimeOk")
    lines = [f"Python：{sys.version.split()[0]}（{sys.executable}）",
             f"系統：{platform.platform()}（{platform.machine()}）"]
    if ready_error:
        return "\n".join([f"下載助手、yt-dlp、ffmpeg、Deno：{ready_error}"] + lines)
    return "\n".join([f"下載助手：{ready.get('hostVersion')}"] + lines + [
        f"yt-dlp：{ready.get('ytdlpVersion') or '沒有，或無法執行'}",
        f"ffmpeg：{'有' if ffmpeg else '沒有'}（{_title(checks, 'ffmpeg', '未檢查')}）",
        f"Deno：{'有' if deno else '沒有'}（{_title(checks, 'deno', '未檢查')}）",
    ])


def _checks(checks: list) -> str:
    lines = []
    for c in checks:
        lines.append(f"[{c.status}] {c.id} — {c.title}" + (f" — {c.detail}" if c.detail else ""))
        if c.status != "ok" and c.fix:
            lines.append(f"    → {c.fix}")
    return "\n".join(lines) or "（沒有檢查項目）"


def _job(last_job: dict | None) -> str:
    if not last_job:
        return "（還沒有下載工作）"
    return json.dumps(last_job, ensure_ascii=False, indent=2)


def build_report(home, *, ready: Callable[[], dict], diagnose: Callable[[], list], last_job: dict | None,
                 now: str | None = None, home_dir: object = None, user: str | None = None) -> str:
    """`ready` and `diagnose` are called here so that one failing part is written down instead of failing the bundle."""
    home = Path(home)
    hide = lambda text: redact(text, home_dir, user)  # noqa: E731
    ready_info, ready_error = _attempt(ready)
    checks, checks_error = _attempt(diagnose)
    ready_info = ready_info if isinstance(ready_info, dict) else {}
    checks = checks if isinstance(checks, list) else []
    record = read_record(home)
    stamp = now or time.strftime("%Y-%m-%dT%H:%M:%S%z")
    head = [
        f"YT批量下載器 診斷資訊\n{stamp}",
        "== 版本 ==\n" + _versions(ready_info, ready_error, checks),
        "== 檢查環境 ==\n" + (checks_error or _checks(checks)),
        "== 安裝紀錄（install.json） ==\n" + (json.dumps(record, ensure_ascii=False, indent=2) if record else "（沒有安裝紀錄）"),
        "== 最近一次下載工作 ==\n" + _job(last_job),
    ]
    head_text = hide("\n\n".join(head))
    logs = []
    for name in ("host.log", "install.log"):
        tail = _log_tail(home / "logs" / name)
        logs.append((f"== {name}（最後 {LOG_LINES} 行） ==\n", hide(tail) if tail is not None else f"（沒有 {name}）"))
    # the logs get what the rest leaves over, so a long log can never push the versions out of the bundle
    room = (MAX_BYTES - len(head_text.encode("utf-8"))) // len(logs)
    sections = [head_text]
    for title, body in logs:
        sections.append(title + cap(body, max(room - len(title.encode("utf-8")) - 4, len(_CUT) + 16)))
    return cap("\n\n".join(sections))
