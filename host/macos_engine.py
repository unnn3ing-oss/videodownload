"""yt-dlp on macOS: the unpacked ("onedir") build, installed once, instead of the single-file build.

The single-file yt-dlp_macos unpacks itself into a temporary folder every time it runs. Everything that a program
Chrome started writes (the local host, and the yt-dlp the host runs) is marked "downloaded by Chrome" by macOS, so
macOS refuses to load the freshly unpacked Python: "Python.framework is damaged". The onedir build has nothing to
unpack at run time: it is unpacked here, once, after its checksum was checked against yt-dlp's published list.

Used by the Mac installer (`python3 macos_engine.py install <bin folder>`) and by the host's "update engine".
Standard library only, so the installer can run it as a plain script. Network access goes through the system's curl
(it trusts the system certificates; a python.org Python often does not).
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Callable

_BASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download"
ZIP_URL = f"{_BASE}/yt-dlp_macos.zip"
SUMS_URL = f"{_BASE}/SHA2-256SUMS"
ZIP_NAME = "yt-dlp_macos.zip"
EXE_NAME = "yt-dlp_macos"
INSTALL_DIR = "yt-dlp_dir"
WORK_DIR = ".yt-dlp-update"
_TIMEOUT = 900
_MAX_DEPTH = 3  # how deep inside the archive the program may sit
_SAFE_PATH = re.compile(r"[A-Za-z0-9._ /+-]+")


class EngineInstallError(Exception):
    """The message is meant to be shown to the person as it is."""


def _tail(text: str) -> str:
    return text.strip()[-200:]


def _curl_text(url: str) -> str:
    try:
        done = subprocess.run(["curl", "-fsSL", "--retry", "3", url], stdin=subprocess.DEVNULL, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=_TIMEOUT)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise EngineInstallError(f"無法取得 yt-dlp 的校驗碼清單：{exc}") from exc
    if done.returncode != 0:
        raise EngineInstallError(f"無法取得 yt-dlp 的校驗碼清單（網路連線失敗？）{_tail(done.stderr)}")
    return done.stdout


def _curl_file(url: str, dest: Path) -> None:
    try:
        done = subprocess.run(["curl", "-fL", "--retry", "3", "-o", str(dest), url], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              timeout=_TIMEOUT)  # (curl's progress meter goes to stderr: visible in the installer)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise EngineInstallError(f"yt-dlp 下載失敗：{exc}") from exc
    if done.returncode != 0:
        raise EngineInstallError("yt-dlp 下載失敗（網路連線失敗？）")


def _unzip(zip_path: Path, dest: Path) -> None:
    # The system unzip, not zipfile: the build contains symbolic links and executable files, which zipfile would flatten.
    dest.mkdir(parents=True, exist_ok=True)
    try:
        done = subprocess.run(["unzip", "-q", "-o", str(zip_path), "-d", str(dest)], stdin=subprocess.DEVNULL, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=_TIMEOUT)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise EngineInstallError(f"解壓縮 yt-dlp 失敗：{exc}") from exc
    if done.returncode > 1:  # 1 is only a warning
        raise EngineInstallError(f"解壓縮 yt-dlp 失敗：{_tail(done.stderr or done.stdout)}")


def _strip_quarantine(path: Path) -> None:
    """Remove macOS's "downloaded from the internet" mark. Only done for files whose checksum was just verified."""
    xattr = shutil.which("xattr")
    if not xattr:  # not a Mac
        return
    try:
        subprocess.run([xattr, "-dr", "com.apple.quarantine", str(path)], stdin=subprocess.DEVNULL, capture_output=True, timeout=300, check=False)
    except (OSError, subprocess.TimeoutExpired):
        pass  # the check below shows whether it still runs


def _run_version(exe: Path) -> str:
    try:
        done = subprocess.run([str(exe), "--version"], stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=120)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise EngineInstallError(f"下載的 yt-dlp 無法執行：{exc}") from exc
    version = done.stdout.strip()
    if done.returncode != 0 or not version:
        raise EngineInstallError(f"下載的 yt-dlp 無法執行：{_tail(done.stderr) or '沒有輸出'}")
    return version


def checksum_for(sums_text: str, name: str) -> str:
    """The SHA-256 listed for `name` in yt-dlp's SHA2-256SUMS ("<hex>  <name>", the name may start with *)."""
    for line in sums_text.splitlines():
        parts = line.split(None, 1)
        if len(parts) == 2 and parts[1].strip().lstrip("*") == name and re.fullmatch(r"[0-9a-fA-F]{64}", parts[0]):
            return parts[0].lower()
    raise EngineInstallError(f"yt-dlp 的校驗碼清單裡找不到 {name}，無法確認檔案是否完整")


def _find_exe(root: Path) -> Path | None:
    found = [p for p in root.rglob(EXE_NAME)
             if p.is_file() and not p.is_symlink() and len(p.relative_to(root).parts) <= _MAX_DEPTH]
    return min(found, key=lambda p: (len(p.relative_to(root).parts), str(p)), default=None)


def _launcher(relative: str) -> str:
    return ('#!/bin/bash\n'
            '# Written by macos_engine.py: starts the unpacked yt-dlp that sits next to this file.\n'
            f'exec "$(cd "$(dirname "$0")" && pwd)/{INSTALL_DIR}/{relative}" "$@"\n')


def install(bin_dir: Path, *,
            fetch_text: Callable[[str], str] = _curl_text,
            fetch_file: Callable[[str, Path], None] = _curl_file,
            extract: Callable[[Path, Path], None] = _unzip,
            strip_quarantine: Callable[[Path], None] = _strip_quarantine,
            run_version: Callable[[Path], str] = _run_version) -> str:
    """Put the latest yt-dlp in `bin_dir`: `yt-dlp_dir/` with the program, `yt-dlp` as the file that starts it.

    Everything is prepared and tried next to the old install first, so a failure at any step leaves it untouched.
    Returns the version of the new yt-dlp.
    """
    bin_dir = Path(bin_dir)
    bin_dir.mkdir(parents=True, exist_ok=True)
    work = bin_dir / WORK_DIR
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir()
    try:
        expected = checksum_for(fetch_text(SUMS_URL), ZIP_NAME)
        archive = work / ZIP_NAME
        fetch_file(ZIP_URL, archive)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
            raise EngineInstallError("yt-dlp 校驗碼不符，檔案可能損毀，請重新執行")
        unpacked = work / "new"
        extract(archive, unpacked)
        exe = _find_exe(unpacked)
        if exe is None:
            raise EngineInstallError(f"下載的 yt-dlp 裡找不到 {EXE_NAME}（官方檔案的結構可能改了）")
        relative = exe.relative_to(unpacked).as_posix()
        if not _SAFE_PATH.fullmatch(relative):
            raise EngineInstallError("下載的 yt-dlp 檔案路徑含有不尋常的字元，已中止")
        exe.chmod(0o755)
        strip_quarantine(unpacked)
        version = run_version(exe)

        launcher_tmp = bin_dir / "yt-dlp.tmp"
        launcher_tmp.write_text(_launcher(relative), encoding="utf-8")
        launcher_tmp.chmod(0o755)
        strip_quarantine(launcher_tmp)

        target = bin_dir / INSTALL_DIR
        previous = bin_dir / f"{INSTALL_DIR}.old"
        shutil.rmtree(previous, ignore_errors=True)
        moved = swapped = False
        try:
            if target.exists():
                target.rename(previous)
                moved = True
            unpacked.rename(target)
            swapped = True
            os.replace(launcher_tmp, bin_dir / "yt-dlp")
        except OSError as exc:
            if swapped:
                shutil.rmtree(target, ignore_errors=True)
            if moved and not target.exists():
                previous.rename(target)  # back to the install that was there
            raise EngineInstallError(f"無法換上新的 yt-dlp：{exc}") from exc
        shutil.rmtree(previous, ignore_errors=True)
        return version
    finally:
        shutil.rmtree(work, ignore_errors=True)
        (bin_dir / "yt-dlp.tmp").unlink(missing_ok=True)


def main(argv: list[str], install_fn: Callable[[Path], str] = install) -> int:
    if len(argv) != 3 or argv[1] != "install":
        print("用法：macos_engine.py install <bin 資料夾>")
        return 2
    try:
        version = install_fn(Path(argv[2]))
    except EngineInstallError as exc:
        print(f"    錯誤：{exc}")
        return 1
    print(f"    yt-dlp {version}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
