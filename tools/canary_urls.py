#!/usr/bin/env python3
"""Canary: do the addresses the installers download from still answer, and does yt-dlp still publish what we rely on?

    python3 tools/canary_urls.py urls    every address the host downloads from (host/installer.py's URL dict, macos_engine, winengine)
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
    """(installer, macos_engine, winengine or None): the host's modules that know a download address."""
    host = str(Path(root) / "host")
    sys.path.insert(0, host)
    try:
        import installer
        import macos_engine
        try:
            import winengine
        except ImportError:  # an older host without the unpacked Windows build
            winengine = None
    finally:
        sys.path.remove(host)
    return installer, macos_engine, winengine


def _windows_zip_names(winengine) -> list:
    if winengine is None or not hasattr(winengine, "zip_name_for"):
        return []
    names = []
    for machine in ("AMD64", "arm64", "x86", ""):
        name = winengine.zip_name_for(machine)
        if name not in names:
            names.append(name)
    return names


def load_urls(root: Path = ROOT) -> dict:
    """Every address the host downloads from: installer.URL, every *_URL constant of macos_engine / winengine, and the
    yt-dlp zip of each Windows chip (built from the same pieces winengine uses)."""
    installer, macos_engine, winengine = _host_modules(root)
    found = dict(installer.URL)
    for label, module in (("macos_engine", macos_engine), ("winengine", winengine)):
        for attr, value in vars(module).items() if module is not None else ():
            if attr.endswith("_URL") and isinstance(value, str) and value.startswith("https://"):
                found[f"{label}.{attr}"] = value
    base = getattr(winengine, "_BASE", None)
    for name in _windows_zip_names(winengine):
        if isinstance(base, str):
            found[f"winengine.{name}"] = f"{base}/{name}"
    return found


def sums_url(root: Path = ROOT) -> str:
    installer, macos_engine, winengine = _host_modules(root)
    return getattr(winengine, "SUMS_URL", None) or installer.URL.get("ytdlp_sums") or macos_engine.SUMS_URL


def required_assets(root: Path = ROOT) -> list:
    """The yt-dlp release files the installers check against its checksum list, taken from the code, not typed again here."""
    installer, macos_engine, winengine = _host_modules(root)
    windows = _windows_zip_names(winengine)
    if not windows and "ytdlp_win" in installer.URL:  # older host: the single file
        windows = [urlsplit(installer.URL["ytdlp_win"]).path.rsplit("/", 1)[-1]]
    return [macos_engine.ZIP_NAME] + windows


def missing_assets(sums_text: str, names: list) -> list:
    """The names the host's own checksum parser cannot find in `sums_text`."""
    _, macos_engine, _ = _host_modules(ROOT)
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
    url = sums_url(root)
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
