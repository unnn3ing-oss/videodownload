#!/usr/bin/env python3
"""Canary: does the installed yt-dlp still know every option the host passes to it?

The host builds its yt-dlp command lines in host/ytdlp.py (base_args, build_download_args, resolve, fetch_meta). This
script builds them with dummy values, collects the options (-f, --ignore-config, ...), and checks each one appears in
`yt-dlp --help`. Run by .github/workflows/canary.yml after `pip install yt-dlp`; exit 1 = an option disappeared or was
renamed upstream, 2 = yt-dlp could not be run. Standard library plus the host's own modules.

    python3 tools/canary_flags.py [--yt-dlp PATH] [--host DIR]
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path
from typing import Callable, Optional

ROOT = Path(__file__).resolve().parent.parent
_FLAG = re.compile(r"--?[A-Za-z][A-Za-z0-9-]*")
_OPTION_NAMES = re.compile(r"(?<![\w-])(--?[A-Za-z][\w-]*)")
_OPTION_LINE = re.compile(r"^ {1,8}-")  # option entries are indented a little; their wrapped descriptions a lot


def flags_in(args: list) -> list:
    """The options in a command line: everything before `--` (after the program) that looks like -x or --long-name."""
    found = []
    for arg in args[1:]:
        if arg == "--":
            break
        if _FLAG.fullmatch(arg):
            found.append(arg)
    return found


def parse_help_flags(help_text: str) -> set:
    """Every option name that heads an entry of `yt-dlp --help` (names only mentioned in a description do not count)."""
    names = set()
    for line in help_text.splitlines():
        if not _OPTION_LINE.match(line):
            continue
        spec = re.split(r"\s{2,}", line.strip(), maxsplit=1)[0]
        names.update(_OPTION_NAMES.findall(spec))
    return names


def collect_used_flags(host_dir: Path) -> dict:
    """{option: [functions of host/ytdlp.py that pass it]}, found by building the real command lines with dummy values."""
    sys.path.insert(0, str(host_dir))
    try:
        import ytdlp
    finally:
        sys.path.remove(str(host_dir))
    engine = ytdlp.Engine(Path("yt-dlp"), Path("ffmpeg-dir"), Path("deno"))
    commands: dict = {"base_args": [engine.base_args()], "build_download_args": [], "resolve": [], "fetch_meta": []}
    for quality in (720, 1080):
        commands["build_download_args"].append(ytdlp.build_download_args(
            engine, "https://www.youtube.com/watch?v=x", quality, Path("/out/title.mp4"), Path("/out/.part/x")))

    def record(bucket: str, reply: tuple) -> Callable[[list], tuple]:
        def run(cmd: list) -> tuple:
            commands[bucket].append(cmd)
            return reply
        return run

    # a single video (adds --no-playlist) and a channel, with and without a limit, so every branch of resolve() is built
    ytdlp.resolve(engine, ["https://www.youtube.com/watch?v=x&list=y", "https://www.youtube.com/@channel"], limit=5,
                  run=record("resolve", (0, "", "")))
    ytdlp.resolve(engine, ["https://www.youtube.com/@channel"], run=record("resolve", (0, "", "")))
    ytdlp.fetch_meta(engine, "https://www.youtube.com/watch?v=x", run=record("fetch_meta", (0, '{"id": "x"}', "")))
    used: dict = {}
    for function, lists in commands.items():
        for cmd in lists:
            for flag in flags_in(cmd):
                if function not in used.setdefault(flag, []):
                    used[flag].append(function)
    return {flag: sorted(functions) for flag, functions in sorted(used.items())}


def missing_flags(used: dict, available: set) -> dict:
    return {flag: functions for flag, functions in used.items() if flag not in available}


def default_get_help(program: str) -> str:
    done = subprocess.run([program, "--help"], stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=120)
    if done.returncode != 0:
        raise OSError(f"{program} --help exited with {done.returncode}: {done.stderr.strip()[-200:]}")
    return done.stdout


def _version(program: str) -> str:
    try:
        return subprocess.run([program, "--version"], stdin=subprocess.DEVNULL, capture_output=True, text=True,
                              timeout=60).stdout.strip() or "unknown"
    except (OSError, subprocess.SubprocessError):
        return "unknown"


def main(argv: Optional[list] = None, get_help: Callable[[str], str] = default_get_help) -> int:
    parser = argparse.ArgumentParser(description="Check that yt-dlp --help lists every option host/ytdlp.py uses.")
    parser.add_argument("--yt-dlp", dest="program", default="yt-dlp")
    parser.add_argument("--host", default=str(ROOT / "host"), help="the folder with ytdlp.py")
    args = parser.parse_args(argv)
    try:
        help_text = get_help(args.program)
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"could not run {args.program}: {exc}", file=sys.stderr)
        return 2
    used = collect_used_flags(Path(args.host))
    available = parse_help_flags(help_text)
    missing = missing_flags(used, available)
    version = _version(args.program) if args.program else "unknown"
    if not missing:
        print(f"OK: all {len(used)} options used by host/ytdlp.py exist in yt-dlp {version}")
        return 0
    width = max(len(flag) for flag in missing)
    print(f"FAIL: yt-dlp {version} does not list {len(missing)} of the {len(used)} options host/ytdlp.py uses:")
    print(f"  {'OPTION'.ljust(width)}  USED BY")
    for flag, functions in missing.items():
        print(f"  {flag.ljust(width)}  {', '.join(functions)}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
