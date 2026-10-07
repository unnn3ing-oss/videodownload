#!/usr/bin/env python3
"""Release helper (standard library only, no network, never pushes).

    python3 tools/release.py check          checklist (PASS/FAIL per line); exit 1 when anything fails
    python3 tools/release.py bump 0.4.0     set the version in extension/manifest.json and host/version.py, nothing else

`main` is the live update channel: the extension and the host update themselves from it. So `check` is meant to be run
right before a release is pushed there, and `bump` only prints the commands for the person to run, it runs none of them.
There is deliberately no changelog to maintain.
"""
from __future__ import annotations

import argparse
import contextlib
import importlib.util
import io
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Callable, NamedTuple, Optional

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = "extension/manifest.json"
HOST_VERSION = "host/version.py"
INSTALLERS = "extension/installers"
PIN_TEST = "extension/tests/extension-id.test.mjs"
# What a release commit consists of: the two version strings and the installers regenerated from them.
RELEASE_PATHS = (MANIFEST, HOST_VERSION, INSTALLERS + "/")

Run = Callable[[list, Path], tuple]

_SEMVER = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)")
_MANIFEST_VERSION = re.compile(r'^([ \t]*"version"[ \t]*:[ \t]*")([^"]*)(")', re.MULTILINE)
_HOST_VERSION = re.compile(r'^(VERSION = ")([^"]*)(")', re.MULTILINE)


class ReleaseError(Exception):
    """The message is shown to the person as it is."""


class Result(NamedTuple):
    name: str
    ok: bool
    detail: str = ""


def parse_semver(text: str) -> Optional[tuple]:
    """(major, minor, patch) for a plain x.y.z (what Chrome and the host both accept), else None."""
    if not isinstance(text, str) or not _SEMVER.fullmatch(text):
        return None
    return tuple(int(part) for part in text.split("."))


def default_run(cmd: list, cwd: Path) -> tuple:
    """(exit code, stdout + stderr). A missing program is an exit code, not an exception."""
    try:
        done = subprocess.run(cmd, cwd=str(cwd), stdin=subprocess.DEVNULL, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=600)
    except (OSError, subprocess.SubprocessError) as exc:
        return 127, f"{cmd[0]}: {exc}"
    return done.returncode, (done.stdout or "") + (done.stderr or "")


# ---------------------------------------------------------------- versions

def _read_text(path: Path) -> str:
    return path.read_bytes().decode("utf-8")


def read_versions(root: Path) -> tuple:
    """(manifest version, host version) as written in the two files."""
    root = Path(root)
    manifest = json.loads(_read_text(root / MANIFEST)).get("version")
    found = _HOST_VERSION.search(_read_text(root / HOST_VERSION))
    if not isinstance(manifest, str):
        raise ReleaseError(f'{MANIFEST} has no "version"')
    if not found:
        raise ReleaseError(f'{HOST_VERSION} has no VERSION = "..." line')
    return manifest, found.group(2)


def _replace_one(text: str, pattern: "re.Pattern", new: str, where: str) -> str:
    if len(pattern.findall(text)) != 1:
        raise ReleaseError(f"{where}: expected exactly one version line to edit, found {len(pattern.findall(text))}; nothing was changed")
    return pattern.sub(lambda m: m.group(1) + new + m.group(3), text, count=1)


def bump(root: Path, new: str) -> tuple:
    """Write `new` into both files (only the version string). Returns (old, new). Nothing is written when anything is wrong."""
    root = Path(root)
    new_parsed = parse_semver(new)
    if new_parsed is None:
        raise ReleaseError(f"{new!r} is not a version: use plain x.y.z (digits only, e.g. 0.4.0)")
    manifest_version, host_version = read_versions(root)
    if manifest_version != host_version:
        raise ReleaseError(f"{MANIFEST} ({manifest_version}) and {HOST_VERSION} ({host_version}) disagree; fix that first")
    current = parse_semver(manifest_version)
    if current is None:
        raise ReleaseError(f"the current version {manifest_version!r} is not plain x.y.z; fix it by hand first")
    if new_parsed <= current:
        raise ReleaseError(f"{new} is not greater than the current version {manifest_version}")
    manifest_text = _replace_one(_read_text(root / MANIFEST), _MANIFEST_VERSION, new, MANIFEST)
    host_text = _replace_one(_read_text(root / HOST_VERSION), _HOST_VERSION, new, HOST_VERSION)
    (root / MANIFEST).write_bytes(manifest_text.encode("utf-8"))
    (root / HOST_VERSION).write_bytes(host_text.encode("utf-8"))
    if read_versions(root) != (new, new):
        raise ReleaseError("the versions do not read back as written; check the two files with git diff")
    return manifest_version, new


def _branch(root: Path, run: Run) -> str:
    code, out = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], root)
    name = out.strip()
    return name if code == 0 and name and name != "HEAD" and "\n" not in name else "<branch>"


def next_steps(old: str, new: str, branch: str) -> str:
    return f"""Bumped {old} -> {new} in {MANIFEST} and {HOST_VERSION} (nothing else was changed).

What follows is text only. Nothing below was run for you.

1. Regenerate the installers (they embed the host and the extension):
     python3 build.py
2. Test everything:
     python3 -m pytest -q
     node --test extension/tests/*.test.mjs
     npm run test:e2e
     python3 tools/release.py check
3. Commit and push the branch (CI runs on the pull request):
     git add {MANIFEST} {HOST_VERSION} {INSTALLERS}
     git commit -m "release: v{new}"
     git push origin {branch}
4. When CI is green, fast-forward main. From this moment every installed copy updates itself from it:
     git fetch origin
     git merge-base --is-ancestor origin/main HEAD && git push origin HEAD:main
   (If main is protected by the ruleset in docs/RELEASING.md, merge the pull request on GitHub instead.)
5. Tag what main now points at:
     git tag -a v{new} -m "v{new}"
     git push origin v{new}
6. Check on a real Mac and a real Windows computer (docs/RELEASING.md).
"""


# ---------------------------------------------------------------- check

def _check_versions_agree(root: Path) -> Result:
    name = "manifest.json and host/version.py agree on the version"
    try:
        manifest, host = read_versions(root)
    except (OSError, ValueError, ReleaseError) as exc:
        return Result(name, False, str(exc))
    if manifest != host:
        return Result(name, False, f"{MANIFEST} says {manifest}, {HOST_VERSION} says {host}")
    return Result(name, True, manifest)


def _check_semver(root: Path) -> Result:
    name = "both versions are plain x.y.z"
    try:
        versions = read_versions(root)
    except (OSError, ValueError, ReleaseError) as exc:
        return Result(name, False, str(exc))
    bad = [f"{where}: {value!r}" for where, value in zip((MANIFEST, HOST_VERSION), versions) if parse_semver(value) is None]
    return Result(name, not bad, "; ".join(bad))


def build_into(root: Path, out_dir: Path) -> None:
    """Run the repository's build.py (its main(out_dir)) in this process, writing only into out_dir."""
    root = Path(root)
    spec = importlib.util.spec_from_file_location("_release_check_build", root / "build.py")
    module = importlib.util.module_from_spec(spec)
    previous = sys.dont_write_bytecode
    sys.dont_write_bytecode = True  # importing must not leave bytecode in the repository
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            spec.loader.exec_module(module)
            module.main(Path(out_dir))
    finally:
        sys.dont_write_bytecode = previous


def _check_installers(root: Path) -> Result:
    name = "the generated installers are current (same bytes as a fresh build)"
    try:
        with tempfile.TemporaryDirectory(prefix="ytdl-release-") as tmp:
            build_into(root, Path(tmp))
            fresh = {p.name: p.read_bytes() for p in sorted(Path(tmp).iterdir()) if p.is_file()}
    except Exception as exc:  # whatever build.py raises is a failed check, not a crash
        return Result(name, False, f"build.py could not run: {type(exc).__name__}: {exc}")
    if not fresh:
        return Result(name, False, "build.py wrote nothing")
    stale = []
    for file_name, data in fresh.items():
        committed = Path(root) / INSTALLERS / file_name
        if not committed.is_file():
            stale.append(f"{INSTALLERS}/{file_name} is missing")
        elif committed.read_bytes() != data:
            stale.append(f"{INSTALLERS}/{file_name} differs from a fresh build")
    if stale:
        return Result(name, False, "\n".join(stale) + "\nRun: python3 build.py")
    return Result(name, True, ", ".join(sorted(fresh)))


def _allowed(path: str, allowed: tuple) -> bool:
    return any(path == item or (item.endswith("/") and path.startswith(item)) for item in allowed)


def _check_clean_tree(root: Path, run: Run, extra: tuple) -> Result:
    name = "the working tree is clean except what is being released"
    code, out = run(["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"], root)
    if code != 0:
        return Result(name, False, f"git status failed (not a git repository, or git is missing): {out.strip()[-200:]}")
    entries, tokens, i = [], out.split("\0"), 0
    while i < len(tokens):
        token = tokens[i]
        i += 1
        if len(token) < 4:
            continue
        entries.append(token[3:])
        if token[0] in "RC" or token[1] in "RC":
            i += 1  # the original name of a rename or copy follows
    others = [p for p in entries if not _allowed(p, RELEASE_PATHS + extra)]
    if others:
        shown = ", ".join(others[:10]) + (f" and {len(others) - 10} more" if len(others) > 10 else "")
        return Result(name, False, f"not part of the release: {shown}. Commit or stash them (or name them with --allow)")
    return Result(name, True, f"{len(entries)} release file(s) changed" if entries else "nothing changed")


def _check_pin(root: Path, run: Run) -> Result:
    name = "the extension id pin test passes"
    code, out = run(["node", "--test", PIN_TEST], root)
    if code != 0:
        lines = [line for line in out.strip().splitlines() if line.strip()]
        return Result(name, False, "node --test " + PIN_TEST + " failed:\n" + "\n".join(lines[:12]))
    return Result(name, True)


def run_checks(root: Path, run: Run = default_run, extra: tuple = ()) -> list:
    root = Path(root)
    return [_check_versions_agree(root), _check_semver(root), _check_installers(root),
            _check_clean_tree(root, run, tuple(extra)), _check_pin(root, run)]


def format_results(results: list) -> str:
    lines = []
    for result in results:
        lines.append(f"  {'PASS' if result.ok else 'FAIL'}  {result.name}" + (f" ({result.detail})" if result.ok and result.detail else ""))
        if not result.ok and result.detail:
            lines.extend("        " + line for line in result.detail.splitlines())
    failed = sum(1 for r in results if not r.ok)
    lines.append("")
    lines.append(f"{failed} of {len(results)} checks failed. Do not push main." if failed else f"All {len(results)} checks passed.")
    return "\n".join(lines)


# ---------------------------------------------------------------- command line

def main(argv: Optional[list] = None, run: Run = default_run) -> int:
    parser = argparse.ArgumentParser(prog="release.py", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    check_parser = sub.add_parser("check", help="print a PASS/FAIL checklist; exit 1 if anything fails")
    check_parser.add_argument("--allow", action="append", default=[], metavar="PATH",
                              help="another path that may be uncommitted (a folder ends with /); repeatable")
    bump_parser = sub.add_parser("bump", help="set the version in manifest.json and host/version.py")
    bump_parser.add_argument("version", help="the new version, plain x.y.z")
    for p in (check_parser, bump_parser):
        p.add_argument("--root", default=str(ROOT), help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    root = Path(args.root)

    if args.command == "bump":
        try:
            old, new = bump(root, args.version)
        except (OSError, ValueError, ReleaseError) as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        print(next_steps(old, new, _branch(root, run)))
        return 0

    results = run_checks(root, run, tuple(args.allow))
    try:
        title = f"Release checklist for {read_versions(root)[0]}"
    except (OSError, ValueError, ReleaseError):
        title = "Release checklist"
    print(title)
    print(format_results(results))
    return 0 if all(r.ok for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
