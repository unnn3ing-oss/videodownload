"""yt-dlp on Windows: the unpacked ("onedir") build, installed once, instead of the single-file yt-dlp.exe.

The single-file build unpacks itself into %TEMP%\\_MEI... every time it starts: slow, scanned by the antivirus each time, and
a folder is left behind whenever it is killed. The onedir build (`yt-dlp_win.zip`: yt-dlp.exe plus `_internal\\`) is unpacked
here, once, after its checksum was checked against yt-dlp's published list. It cannot update itself (`-U` is not supported for
the onedir builds), so updating means installing it again through `install`.

Layout, as on the Mac (see macos_engine): `bin\\yt-dlp_dir\\yt-dlp.exe` is the program; the single-file `bin\\yt-dlp.exe` of
older installs is only a fallback until the onedir one has started once, then it is removed.

Used by the installer (host/installer.py), by the doctor's repair and by the host's "update engine".
Standard library only.
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path
from typing import Callable

import install_record
from macos_engine import INSTALL_DIR, WORK_DIR, EngineInstallError, checksum_for
from ytdlp import run_capture

_BASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download"
SUMS_URL = f"{_BASE}/SHA2-256SUMS"
EXE_NAME = "yt-dlp.exe"
MAX_ENTRIES = 5000
MAX_BYTES = 1 << 30  # what the archive may unpack to (the real one is about 30 MB)

Run = Callable[[list], tuple]


class EngineBlocked(EngineInstallError):
    """The program was stopped by an antivirus (or a similar rule). The message says what to allow, and where."""

    def __init__(self, message: str, *, path: Path, sha256: str, size: int):
        super().__init__(message)
        self.path, self.sha256, self.size = path, sha256, size


def zip_name_for(machine: str | None) -> str:
    """The release's zip for this chip; the usual 64-bit one unless the chip says otherwise."""
    m = (machine or "").lower()
    if "arm" in m or "aarch64" in m:
        return "yt-dlp_win_arm64.zip"
    if m in ("x86", "i386", "i686"):
        return "yt-dlp_win_x86.zip"
    return "yt-dlp_win.zip"


def engine_path(home: Path) -> Path:
    """The onedir program; the single-file one while only that exists; else where the onedir one is expected."""
    bin_dir = Path(home) / "bin"
    new, legacy = bin_dir / INSTALL_DIR / EXE_NAME, bin_dir / EXE_NAME
    return legacy if not new.exists() and legacy.exists() else new


def classify_start_error(text: str) -> str:
    """"virus" (the antivirus took it), "denied" (access denied: often the antivirus still scanning a new file) or "other"."""
    t = text or ""
    if re.search(r"WinError 225|virus|unwanted|病毒|潛在", t, re.I):
        return "virus"
    if re.search(r"WinError (5|32)\b|access is denied|being used by another process|拒絕存取|另一個處理序", t, re.I):
        return "denied"
    return "other"


def blocked_message(bin_dir: Path, exe: Path, sha256: str, size: int, zip_sha256: str = "", why: str = "") -> str:
    lines = [f"yt-dlp.exe 被防毒軟體攔截了{('（Windows 回報：' + why + '）') if why else ''}。",
             "這通常是防毒軟體把剛下載的 yt-dlp.exe 當成可疑檔案隔離，重新下載也會被再隔離一次，所以安裝檔不會再重試。",
             "請防毒軟體（或請公司 IT）排除這個資料夾並允許下面的檔案，然後重新執行安裝檔：",
             f"    要排除的資料夾：{bin_dir}",
             f"    檔案位置：{exe}",
             f"    SHA-256：{sha256}（{size} 位元組）"]
    if zip_sha256:
        lines.append(f"    官方壓縮檔 yt-dlp 的 SHA-256（已和官方的 SHA2-256SUMS 核對）：{zip_sha256}")
    return "\n".join(lines)


def _tail(text: str) -> str:
    return (text or "").strip()[-200:]


def _download(url: str, dest: Path) -> None:
    """curl when it works (without the revocation check, which company networks often break), else urllib."""
    curl = shutil.which("curl")
    if curl:
        cmd = [curl, "-fL", "--retry", "3", "-o", str(dest), url]
        if sys.platform.startswith("win"):
            cmd.insert(1, "--ssl-no-revoke")
        try:
            if subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, timeout=1800).returncode == 0:
                return
        except (OSError, subprocess.SubprocessError):
            pass
    try:
        with urllib.request.urlopen(url, timeout=120) as response, open(dest, "wb") as out:  # noqa: S310 (fixed https addresses)
            shutil.copyfileobj(response, out)
    except Exception as exc:
        raise EngineInstallError(f"yt-dlp 下載失敗（網路連線失敗？）：{exc}") from exc


def _download_text(url: str) -> str:
    import tempfile
    tmp = Path(tempfile.mkdtemp(prefix="ytdl-sums-"))
    try:
        _download(url, tmp / "text")
        return (tmp / "text").read_text(encoding="utf-8", errors="replace")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _unsafe(name: str) -> bool:
    return (not name or name.startswith("/") or "\\" in name or ":" in name
            or any(part == ".." for part in name.split("/")))


def _extract(archive: Path, dest: Path) -> None:
    """Everything goes inside `dest`; an entry that would land anywhere else stops the whole thing (nothing is trusted)."""
    try:
        with zipfile.ZipFile(archive) as z:
            infos = z.infolist()
            if len(infos) > MAX_ENTRIES or sum(i.file_size for i in infos) > MAX_BYTES:
                raise EngineInstallError("下載的 yt-dlp 壓縮檔大小不尋常，已中止")
            root = os.path.realpath(dest)
            for info in infos:
                target = os.path.realpath(os.path.join(root, info.filename))
                if _unsafe(info.filename) or os.path.commonpath([root, target]) != root:
                    raise EngineInstallError(f"下載的 yt-dlp 壓縮檔含有不安全的路徑，已中止：{info.filename}")
            dest.mkdir(parents=True, exist_ok=True)
            for info in infos:
                target = Path(root) / info.filename
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with z.open(info) as src, open(target, "wb") as out:
                    shutil.copyfileobj(src, out)
    except zipfile.BadZipFile as exc:
        raise EngineInstallError(f"下載的 yt-dlp 壓縮檔損毀：{exc}") from exc


def _start(exe: Path, bin_dir: Path, zip_sha256: str, run: Run, sleep: Callable[[float], None]) -> str:
    """The first start of a new program (virus scan, slow). Returns its version, or says why it did not run."""
    facts = install_record.fingerprint(exe)  # before: an antivirus may remove the file as soon as it is started
    for attempt in (1, 2):
        code, out, err = run([str(exe), "--version"])
        if code == 0 and out.strip():
            return out.strip().splitlines()[0]
        why = _tail(err or out)
        kind = classify_start_error(why)
        if kind == "denied" and attempt == 1:
            sleep(3)  # right after a write the antivirus may still hold the file
            continue
        if kind in ("virus", "denied"):
            final = bin_dir / INSTALL_DIR / EXE_NAME
            raise EngineBlocked(blocked_message(bin_dir, final, facts["sha256"], facts["size"], zip_sha256, why),
                                path=final, sha256=facts["sha256"], size=facts["size"])
        raise EngineInstallError(f"下載的 yt-dlp.exe 已解壓縮，但無法啟動（結束碼 {code}）{('：' + why) if why else ''}。"
                                 "可能被防毒軟體攔截，或缺少 Visual C++ 執行階段；請暫時允許 " + str(bin_dir) + " 後重新執行安裝檔。")
    raise AssertionError("unreachable")


def _retry(action: Callable[[], None], sleep: Callable[[float], None], tries: int = 4) -> None:
    for attempt in range(tries):
        try:
            return action()
        except OSError:
            if attempt == tries - 1:
                raise
            sleep(1)  # a folder whose files the antivirus is looking at cannot be renamed for a moment


def _put_back(target: Path, previous: Path, sleep: Callable[[float], None]) -> None:
    """Best effort: the old install back in place. Never replaces the error the caller is about to raise (an antivirus may
    still hold some of the new files, which then cannot be removed or renamed over)."""
    try:
        if target.exists():
            try:
                _retry(lambda: shutil.rmtree(target), sleep)
            except OSError:
                pass
        if previous.exists() and not target.exists():
            _retry(lambda: previous.rename(target), sleep)
    except OSError:
        pass


def install(bin_dir: Path, *,
            fetch_text: Callable[[str], str] = _download_text,
            fetch_file: Callable[[str, Path], None] = _download,
            run: Run = run_capture,
            machine: str | None = None,
            sleep: Callable[[float], None] = time.sleep) -> str:
    """Put the latest yt-dlp in `bin_dir`: `yt-dlp_dir\\` with the program. Returns its version.

    Everything is prepared and tried next to the old install first, so a failure at any step leaves it untouched; the new one
    is also started where it ends up (an antivirus may act on it only then) and the old one is put back if that fails. The
    single-file yt-dlp.exe of older installs is removed last. The result (path, SHA-256, size) is written to install.json
    in the folder above `bin_dir`.
    """
    bin_dir = Path(bin_dir)
    if bin_dir.name == INSTALL_DIR:  # (given the program's own folder)
        bin_dir = bin_dir.parent
    bin_dir.mkdir(parents=True, exist_ok=True)
    zip_name = zip_name_for(machine if machine is not None else _machine())
    work = bin_dir / WORK_DIR
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir()
    try:
        expected = checksum_for(fetch_text(SUMS_URL), zip_name)
        archive = work / zip_name
        fetch_file(f"{_BASE}/{zip_name}", archive)
        zip_sha = _sha256_of(archive)
        if zip_sha != expected:
            raise EngineInstallError("yt-dlp 校驗碼不符，檔案可能損毀，請重新執行")
        unpacked = work / "new"
        _extract(archive, unpacked)
        if not (unpacked / EXE_NAME).is_file():
            raise EngineInstallError(f"下載的 yt-dlp 裡找不到 {EXE_NAME}（官方檔案的結構可能改了）")
        _start(unpacked / EXE_NAME, bin_dir, zip_sha, run, sleep)

        target, previous = bin_dir / INSTALL_DIR, bin_dir / f"{INSTALL_DIR}.old"
        shutil.rmtree(previous, ignore_errors=True)
        moved = swapped = False
        try:
            if target.exists():
                _retry(lambda: target.rename(previous), sleep)
                moved = True
            _retry(lambda: unpacked.rename(target), sleep)
            swapped = True
        except OSError as exc:
            if swapped:
                shutil.rmtree(target, ignore_errors=True)
            if moved:
                _put_back(target, previous, sleep)
            raise EngineInstallError(f"無法換上新的 yt-dlp：{exc}（下載進行中或有其他視窗正在使用它嗎？）") from exc
        exe = target / EXE_NAME
        try:
            version = _start(exe, bin_dir, zip_sha, run, sleep)
        except EngineInstallError:
            shutil.rmtree(target, ignore_errors=True)
            if moved:
                _put_back(target, previous, sleep)
            raise
        shutil.rmtree(previous, ignore_errors=True)
        (bin_dir / EXE_NAME).unlink(missing_ok=True)  # the old single-file build: only now that the new one has started
        (bin_dir / f"{EXE_NAME}.part").unlink(missing_ok=True)
        try:
            install_record.write_engine(bin_dir.parent, {**install_record.fingerprint(exe), "version": version,
                                                         "zip": zip_name, "zipSha256": zip_sha})
        except OSError:
            pass  # only a note for later: not a reason to fail
        return version
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _machine() -> str:
    import platform
    return platform.machine()


def main(argv: list[str], install_fn: Callable[[Path], str] = install) -> int:
    if len(argv) != 3 or argv[1] != "install":
        print("用法：winengine.py install <bin 資料夾>")
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
