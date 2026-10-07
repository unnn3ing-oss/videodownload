"""The host's log file: <home>/logs/host.log, so "failed, reason unknown" leaves something to read.

Logging must never raise and never hold the host up: every failure to write is swallowed, the folder is created on the
first line, and the file is opened and closed per line (nothing stays locked for the uninstaller or the doctor).
Everything is redacted (home folder and user name) before it is written. Standard library only.
"""
from __future__ import annotations

import getpass
import os
import re
import threading
import time
import traceback
from pathlib import Path

MAX_BYTES = 512 * 1024
FILES = 3  # host.log, host.log.1, host.log.2
LOG_NAME = "host.log"
_SEPARATORS = re.compile(r"[\\/]+")


def clip(text: object, limit: int) -> str:
    text = str(text)
    return text if len(text) <= limit else text[:limit] + "…"


def tail_lines(text: str, lines: int = 15, limit: int = 2048, line_limit: int = 300) -> str:
    """The last few non-empty lines of a tool's output, indented, at most `limit` characters (the end is what matters)."""
    kept = [clip(ln.rstrip(), line_limit) for ln in str(text).splitlines() if ln.strip()][-lines:]
    out = "\n".join("    " + ln for ln in kept)
    return out if len(out) <= limit else "…" + out[-limit:]


def _path_pattern(path: str) -> str | None:
    parts = [re.escape(p) for p in _SEPARATORS.split(path) if p]
    if len(path.strip("\\/")) < 2 or not parts:
        return None  # "/" or "C:" as a home would swallow every path
    lead = r"[\\/]+" if path[0] in "\\/" else ""
    return rf"(?<![\w]){lead}" + r"[\\/]+".join(parts) + r"(?!\w)"


def redact(text: str, home: object = None, user: str | None = None, ignore_case: bool | None = None) -> str:
    """Hide the person's home folder (as ~) and user name (as <user>); `None` means "ask the system", "" means "skip".

    Paths match with either kind of slash, doubled backslashes (JSON) included; case does not matter on Windows.
    """
    if home is None:
        home = os.path.expanduser("~")
        home = "" if home == "~" else home
    if user is None:
        try:
            user = getpass.getuser()
        except Exception:
            user = ""
    flags = re.I if (os.name == "nt" if ignore_case is None else ignore_case) else 0
    text = str(text)
    pattern = _path_pattern(str(home)) if home else None
    if pattern:
        text = re.sub(pattern, lambda m: "~", text, flags=flags)
    if user:
        name = re.escape(user)
        # a very short name ("al") is only safe to replace where it is a folder name
        pattern = rf"(?<!\w){name}(?!\w)" if len(user) >= 3 else rf"(?<=[\\/]){name}(?=[\\/]|$)"
        text = re.sub(pattern, lambda m: "<user>", text, flags=flags)
    return text


class HostLog:
    """Callable: `log("text")` appends one timestamped, redacted entry; `log.exception("what")` adds the traceback."""

    def __init__(self, home, *, max_bytes: int = MAX_BYTES, files: int = FILES, home_dir: object = None,
                 user: str | None = None):
        self.path = Path(home) / "logs" / LOG_NAME
        self._max_bytes = max_bytes
        self._files = files
        self._home_dir = home_dir
        self._user = user
        self._lock = threading.Lock()

    def __call__(self, message: object) -> None:
        try:
            line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {redact(message, self._home_dir, self._user)}\n"
            with self._lock:
                os.makedirs(self.path.parent, exist_ok=True)
                self._rotate()
                with open(self.path, "a", encoding="utf-8", errors="replace", newline="\n") as handle:
                    handle.write(line)
        except Exception:  # (OSError and anything odd): a log that cannot be written must not hurt the host
            pass

    def exception(self, context: str) -> None:
        self(f"{context}\n{traceback.format_exc().rstrip()}")

    def _rotate(self) -> None:
        try:
            if self.path.stat().st_size < self._max_bytes:
                return
        except OSError:
            return
        for index in range(self._files - 1, 0, -1):
            older = self.path.with_name(f"{LOG_NAME}.{index}")
            newer = self.path if index == 1 else self.path.with_name(f"{LOG_NAME}.{index - 1}")
            try:
                os.replace(newer, older)
            except OSError:
                pass
