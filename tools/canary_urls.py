#!/usr/bin/env python3
"""Canary: do the addresses the installers download from still answer, and does yt-dlp still publish what we rely on?

    python3 tools/canary_urls.py urls    every address in host/installer.py's URL dict (and the two in host/macos_engine.py)
    python3 tools/canary_urls.py sums    yt-dlp's latest SHA2-256SUMS lists the files the installers verify
    python3 tools/canary_urls.py         both

Run nightly by .github/workflows/canary.yml; it never blocks a merge, it tells someone upstream moved a file. Exit 1 on any
failure, with a table. Standard library only (plus the host's own modules, imported from host/).
"""
from __future__ import annotations

import argparse
import http.client
import sys
import time
import urllib.request
from pathlib import Path
from typing import Callable, NamedTuple, Optional
from urllib.error import HTTPError
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
_TIMEOUT = 30
_OK = (200, 206)


class Outcome(NamedTuple):
    name: str
    url: str
    ok: bool
    status: Optional[int]
    error: str
    final: str


def _host_modules(root: Path):
    sys.path.insert(0, str(Path(root) / "host"))
    try:
        import installer
        import macos_engine
    finally:
        sys.path.remove(str(Path(root) / "host"))
    return installer, macos_engine


def load_urls(root: Path = ROOT) -> dict:
    installer, macos_engine = _host_modules(root)
    found = dict(installer.URL)
    found["macos_engine.ZIP_URL"] = macos_engine.ZIP_URL
    found["macos_engine.SUMS_URL"] = macos_engine.SUMS_URL
    return found


def required_assets(root: Path = ROOT) -> list:
    """The release files the installers check against yt-dlp's checksum list, taken from the code, not typed again here."""
    installer, macos_engine = _host_modules(root)
    return [urlsplit(installer.URL["ytdlp_win"]).path.rsplit("/", 1)[-1], macos_engine.ZIP_NAME]


def missing_assets(sums_text: str, names: list) -> list:
    """The names the host's own checksum parser cannot find in `sums_text`."""
    _, macos_engine = _host_modules(ROOT)
    missing = []
    for name in names:
        try:
            macos_engine.checksum_for(sums_text, name)
        except macos_engine.EngineInstallError:
            missing.append(name)
    return missing


# ---------------------------------------------------------------- network

def http_fetch(url: str, method: str) -> tuple:
    """(status, final address) after following redirects. GET asks for one byte only."""
    headers = {"User-Agent": "ytdl-canary/1"}
    if method == "GET":
        headers["Range"] = "bytes=0-0"
    request = urllib.request.Request(url, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT) as response:
            return response.status, response.geturl()
    except HTTPError as exc:
        return exc.code, url


def http_text(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "ytdl-canary/1"})
    with urllib.request.urlopen(request, timeout=_TIMEOUT) as response:
        return response.read(2_000_000).decode("utf-8", errors="replace")


def _transient(status: Optional[int]) -> bool:
    return status is None or status >= 500 or status == 429


def check_url(url: str, fetch: Callable = http_fetch, attempts: int = 3, sleep: Callable = time.sleep, name: str = "") -> Outcome:
    """HEAD first; when that is refused a one-byte GET decides (some download hosts reject HEAD). Only network errors, 429 and
    5xx are retried: a 404 stays a 404."""
    status: Optional[int] = None
    error = ""
    final = url
    for attempt in range(attempts):
        status, error = None, ""
        for method in ("HEAD", "GET"):
            try:
                status, final = fetch(url, method)
            except (OSError, http.client.HTTPException, ValueError) as exc:
                status, error = None, f"{type(exc).__name__}: {exc}"
                continue
            if status in _OK:
                return Outcome(name, url, True, status, "", final)
            error = f"HTTP {status}"
        if not _transient(status) or attempt == attempts - 1:
            break
        sleep(2 ** attempt)
    return Outcome(name, url, False, status, error, final)


def format_table(rows: list) -> str:
    name_w = max([len(r.name) for r in rows] + [4])
    lines = [f"{'RESULT':<6}  {'STATUS':<6}  {'NAME':<{name_w}}  ADDRESS"]
    for r in rows:
        status = str(r.status) if r.status is not None else "-"
        tail = "" if r.ok else f"  <- {r.error}"
        lines.append(f"{'ok' if r.ok else 'FAIL':<6}  {status:<6}  {r.name:<{name_w}}  {r.url}{tail}")
    return "\n".join(lines)


def run_urls(root: Path, fetch: Callable, sleep: Callable) -> int:
    rows = [check_url(url, fetch=fetch, sleep=sleep, name=name) for name, url in load_urls(root).items()]
    print(format_table(rows))
    failed = [r for r in rows if not r.ok]
    print(f"\n{len(failed)} of {len(rows)} addresses failed." if failed else f"\nAll {len(rows)} addresses answer.")
    return 1 if failed else 0


def run_sums(root: Path, fetch_text: Callable) -> int:
    url = load_urls(root)["ytdlp_sums"]
    names = required_assets(root)
    try:
        text = fetch_text(url)
    except (OSError, http.client.HTTPException, ValueError) as exc:
        print(f"FAIL: could not read {url}: {type(exc).__name__}: {exc}")
        return 1
    missing = missing_assets(text, names)
    if missing:
        print(f"FAIL: {url} does not list: {', '.join(missing)}")
        print("      (the installers verify these files against that list; yt-dlp renamed or dropped them)")
        return 1
    print(f"OK: {url} lists {', '.join(names)}")
    return 0


def main(argv: Optional[list] = None, fetch: Callable = http_fetch, fetch_text: Callable = http_text,
         sleep: Callable = time.sleep, root: Path = ROOT) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("what", nargs="?", choices=["urls", "sums", "all"], default="all")
    args = parser.parse_args(argv)
    codes = []
    if args.what in ("urls", "all"):
        codes.append(run_urls(root, fetch, sleep))
    if args.what in ("sums", "all"):
        codes.append(run_sums(root, fetch_text))
    return 1 if any(codes) else 0


if __name__ == "__main__":
    sys.exit(main())
