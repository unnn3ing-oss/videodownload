"""Everything the installers do once Python is available: tools, Chrome registration, the extension's folder, a self test.

The installers themselves (the Windows .cmd and the Mac script) are only a bootstrap: they make sure there is a Python,
unpack the files embedded in them, and run this. That keeps what changes (download addresses, new parts, new checks) here,
in a file that ships with the host, so the installers rarely need to change. Running it again repairs what is broken.
Standard library only.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import platform as platform_module
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import zipfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable

import doctor
import macos_engine
import selfupdate
import winengine
from install_record import (EXTENSION_NAME, fingerprint, is_extension as _is_extension, read_engine, read_record,
                            recorded_extension_folder, write_engine, write_record)
from ytdlp import run_capture

HOST_NAME = doctor.HOST_NAME
EXTENSION_FOLDER = "YT批量下載器"  # must equal FOLDER_NAME in extension/lib/setup-flow.js (a test enforces it)

_GH = "https://github.com"
DENO_VERSION = "v2.9.5"  # a fixed release: what is downloaded does not change under us, and PINS below says what it must be
URL = {  # (yt-dlp's own addresses are in winengine.py and macos_engine.py, next to the code that unpacks it)
    "deno_win": f"{_GH}/denoland/deno/releases/download/{DENO_VERSION}/deno-x86_64-pc-windows-msvc.zip",
    "deno_mac_arm": f"{_GH}/denoland/deno/releases/download/{DENO_VERSION}/deno-aarch64-apple-darwin.zip",
    "deno_mac_x64": f"{_GH}/denoland/deno/releases/download/{DENO_VERSION}/deno-x86_64-apple-darwin.zip",
    "ffmpeg_win": f"{_GH}/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip",
    # BtbN only keeps a rolling "latest", so its archive is checked against the list published next to it (not a pinned value).
    "ffmpeg_win_sums": f"{_GH}/BtbN/FFmpeg-Builds/releases/latest/download/checksums.sha256",
    # Built for each chip (so Apple Silicon needs no Rosetta); a fixed release, so what is downloaded does not change under us.
    "ffmpeg_mac_arm": f"{_GH}/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-arm64.gz",
    "ffmpeg_mac_x64": f"{_GH}/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-x64.gz",
}
# SHA-256 of each pinned download (keys are URL's). A file that does not match is never unpacked or run. Changing a version
# means changing the address and the value together (tools/canary_urls.py keeps the addresses alive; RELEASING.md says how).
PINS = {
    "deno_win": "171efab55ac6b9881fd53ee4c20f8bf3bb1340ffc618483746909014db12216a",
    "deno_mac_arm": "b796aadd131f6930560c1ee040cf0d6f53933fbb987464e9ff46bd7ea4830615",
    "deno_mac_x64": "c1b8b89a81e91b2a8b3f96def3195d08cfe3a105651da7908d53061f7140510d",
    "ffmpeg_mac_arm": "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa",
    "ffmpeg_mac_x64": "929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106",
}

Run = Callable[[list], tuple]


class SetupError(Exception):
    """The message is shown to the person as it is."""


LOG_NAME = "install.log"
LOG_MAX_BYTES = 256 * 1024
LOG_KEEP = 3  # install.log, install.log.1, install.log.2
_LOG: dict = {"path": None, "home": "", "user": ""}


def redact(text: str, user_home: str, user_name: str) -> str:
    """What is written to the log carries neither the person's home folder nor their user name."""
    if user_home:
        for variant in sorted({user_home, user_home.replace("\\", "/"), user_home.replace("/", "\\")}, key=len, reverse=True):
            text = re.sub(re.escape(variant), "<user>", text, flags=re.I)
    if user_name and len(user_name) >= 3:  # (a very short name would blank out ordinary words)
        pattern = re.compile(r"(?<!\w)" + re.escape(user_name) + r"(?!\w)", re.I)
        text = "<user>".join(pattern.sub("<user>", piece) for piece in text.split("<user>"))
    return text


def _rotate(path: Path, keep: int) -> None:
    oldest = path.with_name(f"{path.name}.{keep - 1}")
    oldest.unlink(missing_ok=True)
    for number in range(keep - 2, 0, -1):
        older = path.with_name(f"{path.name}.{number}")
        if older.exists():
            os.replace(older, path.with_name(f"{path.name}.{number + 1}"))
    os.replace(path, path.with_name(f"{path.name}.1"))


def start_log(home: Path, *, user_home: str | None = None, user_name: str | None = None, max_bytes: int = LOG_MAX_BYTES) -> None:
    """From now on what is said is also appended to <home>/logs/install.log. Never raises."""
    try:
        path = Path(home) / "logs" / LOG_NAME
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.stat().st_size >= max_bytes:
            _rotate(path, LOG_KEEP)
        if user_name is None:
            import getpass
            try:
                user_name = getpass.getuser()
            except Exception:
                user_name = os.environ.get("USERNAME") or os.environ.get("USER") or ""
        _LOG.update(path=path, home=str(Path.home()) if user_home is None else user_home, user=user_name)
    except Exception:
        _LOG["path"] = None


def stop_log() -> None:
    _LOG["path"] = None


def _log(text: str) -> None:
    path = _LOG["path"]
    if path is None:
        return
    try:
        lines = [line for line in redact(text, _LOG["home"], _LOG["user"]).splitlines() if line.strip()]
        if lines:
            stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            with open(path, "a", encoding="utf-8") as handle:
                handle.write("".join(f"{stamp} {line}\n" for line in lines))
    except Exception:
        pass  # a log that cannot be written is never a reason to stop


def say(text: str = "") -> None:
    print(text, flush=True)
    _log(text)


def step(text: str) -> None:
    say(f"\n==> {text}")


# ---------------------------------------------------------------- downloads

def _curl() -> str | None:
    return shutil.which("curl")


def _curl_download(url: str, dest: Path) -> bool:
    """True when curl fetched it. (curl shows progress and trusts the system's certificates; on Windows its revocation check
    is skipped, which company networks often break.)"""
    curl = _curl()
    if not curl:
        return False
    cmd = [curl, "-fL", "--retry", "3", "-o", str(dest), url]
    if sys.platform.startswith("win"):
        cmd.insert(1, "--ssl-no-revoke")
    try:
        return subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, timeout=1800).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def fetch_file(url: str, dest: Path) -> None:
    """curl when it works, else urllib (which uses the system's certificates on Windows too)."""
    dest = Path(dest)
    say(f"    下載 {url}")
    if _curl_download(url, dest):
        return
    try:
        with urllib.request.urlopen(url, timeout=120) as response, open(dest, "wb") as out:  # noqa: S310 (fixed https addresses)
            shutil.copyfileobj(response, out)
    except (OSError, ValueError) as exc:
        raise SetupError(f"下載失敗（網路連線失敗？）：{url}（{exc}）") from exc
    except Exception as exc:  # http.client errors such as IncompleteRead
        raise SetupError(f"下載失敗：{url}（{exc}）") from exc


def fetch_text(url: str) -> str:
    tmp = Path(tempfile.mkdtemp(prefix="ytdl-text-"))
    try:
        target = tmp / "text"
        fetch_file(url, target)
        return target.read_text(encoding="utf-8", errors="replace")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- tools

def _exe(name: str, platform: str) -> str:
    return f"{name}.exe" if platform.startswith("win") else name


def _works(path: Path, arg: str, run: Run) -> bool:
    return path.exists() and run([str(path), arg])[0] == 0


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _listed_checksum(sums_text: str, name: str) -> str:
    """The SHA-256 that a "<hex>  <name>" list gives for `name`."""
    for line in sums_text.splitlines():
        parts = line.split(None, 1)
        if len(parts) == 2 and parts[1].strip().lstrip("*") == name and re.fullmatch(r"[0-9a-fA-F]{64}", parts[0]):
            return parts[0].lower()
    raise SetupError(f"ffmpeg 官方的校驗碼清單裡找不到 {name}，無法確認檔案是否完整，所以不安裝")


def verify_download(path: Path, expected: str, label: str) -> None:
    """Nothing downloaded is unpacked before it matches the value it must have.
    (Only the installer's own test run, which serves stand-in files and sets YTDL_SKIP_NETWORK=1, is excused.)"""
    if os.environ.get("YTDL_SKIP_NETWORK") == "1":
        return
    actual = _sha256_file(Path(path))
    if actual != expected.lower():
        Path(path).unlink(missing_ok=True)
        raise SetupError(f"{label} 的校驗碼和預期不同，已丟棄、不會安裝。\n    預期：{expected}\n    實際：{actual}\n"
                         "    可能是下載不完整或被中途改過；請確認網路（公司網路若會改寫下載內容，請洽 IT）後重新執行安裝檔。")


def _extract_member(zip_path: Path, wanted: str, dest: Path) -> None:
    """The one file called `wanted` (anywhere in the archive) goes to `dest`; nothing else is written."""
    try:
        with zipfile.ZipFile(zip_path) as z:
            member = next((n for n in z.namelist() if n.rsplit("/", 1)[-1] == wanted), None)
            if member is None:
                raise SetupError(f"下載的壓縮檔裡找不到 {wanted}")
            tmp = dest.with_name(dest.name + ".part")
            with z.open(member) as src, open(tmp, "wb") as out:
                shutil.copyfileobj(src, out)
            os.replace(tmp, dest)
    except zipfile.BadZipFile as exc:
        raise SetupError(f"下載的壓縮檔損毀：{exc}") from exc
    dest.chmod(0o755)


def _extract_gz(gz_path: Path, dest: Path) -> None:
    tmp = dest.with_name(dest.name + ".part")
    try:
        with gzip.open(gz_path, "rb") as src, open(tmp, "wb") as out:
            shutil.copyfileobj(src, out)
    except (OSError, EOFError) as exc:
        tmp.unlink(missing_ok=True)
        raise SetupError(f"下載的壓縮檔損毀：{exc}") from exc
    os.replace(tmp, dest)
    dest.chmod(0o755)


def _must_run(path: Path, arg: str, label: str, run: Run, hint: str = "") -> None:
    """A part that was just installed has to run; if not, say which and why it might be."""
    code, out, err = run([str(path), arg])
    if code != 0:
        detail = (err or out).strip()[-200:]
        raise SetupError(f"{label} 已下載，但無法執行（結束碼 {code}）{('：' + detail) if detail else ''}。{hint}".rstrip())


def _remember_engine(home: Path, path: Path) -> None:
    """Note the verified yt-dlp.exe's SHA-256 and size (for IT to allow-list it, and to tell later that it went missing)."""
    try:
        facts, old = fingerprint(path), read_engine(home)
        write_engine(home, {**old, **facts} if old.get("sha256") == facts["sha256"] else facts)
    except OSError:
        pass


def ensure_tools(home: Path, platform: str, *, run: Run = run_capture, fetch_file: Callable = fetch_file,
                 fetch_text: Callable = fetch_text, machine: str | None = None,
                 install_engine: Callable[[Path], str] = macos_engine.install,
                 install_win_engine: Callable[..., str] = winengine.install) -> list[str]:
    """yt-dlp, Deno and ffmpeg: each one is judged by whether it runs, and only what does not is (re)installed.

    Every part says what it is for and what it did, also when there was nothing to do.
    """
    home = Path(home)
    bin_dir = home / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="ytdl-setup-"))
    done: list[str] = []
    win = platform.startswith("win")
    mac = platform == "darwin"
    chip = machine or platform_module.machine()
    try:
        step("下載引擎 yt-dlp（真正下載影片的程式）")
        check, kind = doctor._engine_state(home, platform, run)
        if kind == "ok":
            say("    已可使用，略過")
            if win:
                _remember_engine(home, doctor.engine_path(home, platform))
        elif kind == "blocked":  # downloading it again would only get it blocked again
            raise SetupError(f"{check.title}。\n    {check.detail}\n    {check.fix}\n    （重新下載也會被攔截，所以這次不重新下載。）")
        else:
            if mac:  # the unpacked build (see macos_engine): the single file one is blocked by macOS when Chrome starts it
                say("    下載官方的免解壓縮版並核對校驗碼")
                try:
                    say(f"    yt-dlp {install_engine(bin_dir)}")
                except macos_engine.EngineInstallError as exc:
                    raise SetupError(f"yt-dlp 安裝失敗：{exc}") from exc
            elif win:  # the unpacked build too (see winengine): the single file one unpacks itself on every start
                if kind == "legacy":
                    say("    目前是舊版單檔 yt-dlp.exe（每次啟動都要先解壓縮，比較慢），改裝免解壓縮版")
                elif kind == "missing" and read_engine(home):
                    say("    上次安裝的 yt-dlp.exe 不見了，可能被防毒軟體隔離；這次重新下載一次")
                say("    下載官方的免解壓縮版並核對校驗碼")
                try:
                    say(f"    yt-dlp {install_win_engine(bin_dir, fetch_text=fetch_text, fetch_file=fetch_file, run=run, machine=chip)}")
                except winengine.EngineInstallError as exc:
                    raise SetupError(str(exc)) from exc
            else:
                raise SetupError("這個系統沒有對應的 yt-dlp 安裝方式（支援 Windows 與 Mac）")
            done.append("yt-dlp")

        deno = bin_dir / _exe("deno", platform)
        step("Deno（YouTube 解題需要的 JavaScript 執行環境）")
        if _works(deno, "--version", run):
            say("    已可使用，略過")
        else:
            deno.unlink(missing_ok=True)
            key = "deno_win" if win else "deno_mac_arm" if chip == "arm64" else "deno_mac_x64"
            url = URL[key]
            archive = work / "deno.zip"
            fetch_file(url, archive)
            verify_download(archive, PINS[key], "Deno")
            _extract_member(archive, _exe("deno", platform), deno)
            _must_run(deno, "--version", "Deno", run)
            say("    已安裝")
            done.append("Deno")

        ffmpeg = bin_dir / _exe("ffmpeg", platform)
        step("ffmpeg（把影片和聲音合併成一個檔案）")
        if not ffmpeg.is_symlink() and _works(ffmpeg, "-version", run):  # (a link to somebody else's copy breaks when that one is removed)
            say("    已可使用，略過")
        else:
            if ffmpeg.is_symlink():
                say("    這是連到別處的連結，改成這裡自己的一份（別處的 ffmpeg 被移除時才不會壞掉）")
            ffmpeg.unlink(missing_ok=True)
            if win:
                archive = work / "ffmpeg.zip"
                fetch_file(URL["ffmpeg_win"], archive)
                verify_download(archive, _listed_checksum(fetch_text(URL["ffmpeg_win_sums"]), "ffmpeg-master-latest-win64-gpl.zip"), "ffmpeg")
                _extract_member(archive, "ffmpeg.exe", ffmpeg)
            else:
                archive = work / "ffmpeg.gz"
                key = "ffmpeg_mac_arm" if chip == "arm64" else "ffmpeg_mac_x64"
                fetch_file(URL[key], archive)
                verify_download(archive, PINS[key], "ffmpeg")
                _extract_gz(archive, ffmpeg)
            _must_run(ffmpeg, "-version", "ffmpeg", run,
                      "Apple Silicon 若出現 bad CPU type，先在終端機執行 softwareupdate --install-rosetta，再重新執行安裝檔。" if mac else "")
            say("    已安裝")
            done.append("ffmpeg")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    if mac:  # programs Chrome starts must not carry macOS's "downloaded from the internet" mark
        run(["xattr", "-dr", "com.apple.quarantine", str(home)])
    return done


# ---------------------------------------------------------------- registering with Chrome

def _set_registry(key: str, value: str) -> None:
    import winreg  # Windows only
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key) as handle:
        winreg.SetValueEx(handle, "", 0, winreg.REG_SZ, value)


def _launcher_text(home: Path, python: str) -> str:
    return ("#!/bin/bash\n"
            "# Written by installer.py: starts the host the way Chrome does.\n"
            f'export YTDL_HOME="{home}"\n'
            f'PY="{python}"\n'
            '[ -x "$PY" ] || PY="$(command -v python3 || true)"\n'
            '[ -x "$PY" ] || PY=/usr/bin/python3\n'
            f'exec "$PY" -u "{home}/host/host.py"\n')


def register(home: Path, platform: str, ext_id: str, *, python: str | None = None, manifest_path: Path | None = None,
             set_registry: Callable[[str, str], None] = _set_registry) -> Path:
    """The launcher Chrome starts, and the file (plus, on Windows, the registry entry) that tells Chrome about it."""
    home = Path(home)
    home.mkdir(parents=True, exist_ok=True)
    if platform.startswith("win"):
        launcher = home / "host.cmd"
        # Relative paths only: the launcher stays ASCII even when the user name is not.
        launcher.write_text('@echo off\r\nset "YTDL_HOME=%~dp0"\r\n"%~dp0python\\python.exe" -u "%~dp0host\\host.py"\r\n', encoding="ascii")
        manifest = Path(manifest_path) if manifest_path else home / f"{HOST_NAME}.json"
    else:
        launcher = home / "host.sh"
        launcher.write_text(_launcher_text(home, python or sys.executable), encoding="utf-8")
        launcher.chmod(0o755)
        manifest = Path(manifest_path) if manifest_path else doctor.default_manifest(platform)
    manifest.parent.mkdir(parents=True, exist_ok=True)
    data = {"name": HOST_NAME, "description": "YouTube 批量下載器下載助手", "path": str(launcher), "type": "stdio",
            "allowed_origins": [f"chrome-extension://{ext_id}/"]}
    manifest.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    if platform.startswith("win"):
        set_registry(rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}", str(manifest))
    return manifest


# ---------------------------------------------------------------- the extension's folder

@dataclass
class Deployed:
    path: Path
    created: bool
    count: int


def _safe_member(name: str) -> bool:
    if not name or len(name) > 200 or name.startswith("/") or "\\" in name or ":" in name:
        return False
    return all(part not in ("", ".", "..", ".git") for part in name.rstrip("/").split("/"))


def _only_ours(folder: Path, names: list[str]) -> bool:
    """Everything in the folder is a file of the package (or a half-written one): what an interrupted install leaves."""
    wanted = set(names)
    for path in Path(folder).rglob("*"):
        if path.is_dir():
            continue
        relative = path.relative_to(folder).as_posix()
        if relative not in wanted and not (relative.endswith(".part") and relative[:-5] in wanted):
            return False
    return True


def deploy_extension(package: Path, parent: Path, *, expected_name: str = EXTENSION_NAME,
                     on_write: Callable[[str], None] = lambda name: None) -> Deployed:
    """Write the extension's files where Chrome will load them from.

    `parent` already is the extension's folder -> written into directly; otherwise into a folder of the suggested name
    inside it (made if needed). Another person's folder of that name is never written into.
    """
    parent = Path(parent)
    try:
        archive = zipfile.ZipFile(package)
    except (OSError, zipfile.BadZipFile) as exc:
        raise SetupError(f"擴充功能的檔案包無法讀取：{exc}") from exc
    with archive:
        names = [n for n in archive.namelist() if not n.endswith("/")]
        for name in names:
            if not _safe_member(name):
                raise SetupError(f"擴充功能的檔案包含不安全的路徑：{name}")
        if "manifest.json" not in names:
            raise SetupError("擴充功能的檔案包裡沒有 manifest.json")
        if parent.is_dir() and _is_extension(parent, expected_name):
            target, created = parent, False
        else:
            target = parent / EXTENSION_FOLDER
            created = not target.exists()
            if target.exists() and any(target.iterdir()) and not _is_extension(target, expected_name) and not _only_ours(target, names):
                raise SetupError(f"「{parent}」裡已經有一個叫「{EXTENSION_FOLDER}」的資料夾，而且裡面有其他檔案。請換一個位置，或把那個資料夾改名。")
        target.mkdir(parents=True, exist_ok=True)
        for leftover in target.rglob("*.part"):
            leftover.unlink(missing_ok=True)
        ordered = [n for n in names if n != "manifest.json"] + ["manifest.json"]  # last: a half-written folder is not loadable
        for name in ordered:
            dest = target / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_name(dest.name + ".part")
            tmp.write_bytes(archive.read(name))
            os.replace(tmp, dest)
            on_write(name)
    return Deployed(target, created, len(ordered))


# ---------------------------------------------------------------- the self test

def selftest(launcher: Path, *, timeout: float = 90) -> dict:
    """Start the launcher the way Chrome does and read the host's first message ("ready", which includes running yt-dlp)."""
    errors = tempfile.TemporaryFile()
    try:
        proc = subprocess.Popen([str(launcher)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors)
    except OSError as exc:
        errors.close()
        raise SetupError(f"下載助手的啟動檔無法執行：{exc}") from exc
    result: dict = {}

    def read() -> None:
        try:
            header = proc.stdout.read(4)
            if len(header) == 4:
                (length,) = struct.unpack("=I", header)
                result["message"] = json.loads(proc.stdout.read(length).decode("utf-8"))
        except (OSError, ValueError):
            pass

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    deadline = time.monotonic() + timeout
    while reader.is_alive() and time.monotonic() < deadline:
        reader.join(0.25)
        if proc.poll() is not None:  # the launcher is gone: something it left behind may still hold the pipe open
            reader.join(2)
            break
    try:
        if "message" not in result:
            if not reader.is_alive():  # the output closed: the process is going, give the system a moment to say so
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
            if proc.poll() is None:
                raise SetupError(f"下載助手啟動後 {int(timeout)} 秒沒有回應")
            errors.seek(0)
            err = errors.read().decode("utf-8", errors="replace").strip()[-300:]
            raise SetupError(f"下載助手一啟動就結束了（結束碼 {proc.returncode}）{('：' + err) if err else ''}")
        message = result["message"]
        if message.get("type") != "ready":
            raise SetupError(f"下載助手第一則訊息不是預期的 ready：{message}")
        return message
    finally:
        try:
            proc.stdin.close()
        except OSError:
            pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        errors.close()


# ---------------------------------------------------------------- dialogs and what to do next

_MAC_DIALOG = 'tell me to activate\nPOSIX path of (choose folder with prompt "選擇要把「YT批量下載器」擴充功能放在哪個資料夾（會在裡面建立一個同名資料夾）")'
_WIN_DIALOG = ("Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding = [Text.Encoding]::UTF8; "
               "$d = New-Object System.Windows.Forms.FolderBrowserDialog; "
               "$d.Description = '選擇要把「YT批量下載器」擴充功能放在哪個資料夾（會在裡面建立一個同名資料夾）'; "
               "$d.ShowNewFolderButton = $true; "
               "$top = New-Object System.Windows.Forms.Form -Property @{TopMost = $true}; "
               "if ($d.ShowDialog($top) -eq 'OK') { $d.SelectedPath }")


def choose_parent(platform: str, run: Run = run_capture) -> Path | None:
    """A folder picked by the person in the system's own dialog, or None (cancelled, or no dialog on this system)."""
    if platform == "darwin":
        code, out, _ = run(["osascript", "-e", _MAC_DIALOG])
    elif platform.startswith("win"):
        code, out, _ = run(["powershell", "-NoProfile", "-STA", "-Command", _WIN_DIALOG])
    else:
        return None
    text = out.lstrip("\ufeff").strip()
    if code != 0 or not text:
        return None
    return Path(text.rstrip("/") if text != "/" else text)


def open_next_steps(platform: str, folder: Path, run: Run = run_capture) -> None:
    """Show the folder and Chrome's extensions page, so loading the extension is the only thing left. Never fatal."""
    if platform == "darwin":
        run(["open", str(folder)])
        run(["open", "-a", "Google Chrome", "chrome://extensions"])
    elif platform.startswith("win"):
        run(["explorer", str(folder)])
        run(["cmd", "/c", "start", "", "chrome", "chrome://extensions"])


# ---------------------------------------------------------------- never an older installer over a newer install

_VERSION = re.compile(r"\d+\.\d+\.\d+")
_VERSION_LINE = re.compile(r'^VERSION\s*=\s*"(\d+\.\d+\.\d+)"', re.M)  # (the installers' bootstraps read it the same way)


def _version_key(text: object) -> tuple | None:
    return tuple(int(part) for part in text.split(".")) if isinstance(text, str) and _VERSION.fullmatch(text) else None


def is_newer(a: str | None, b: str | None) -> bool:
    """Version a is higher than b (x.y.z, by number). Anything unreadable is not newer: it counts as a fresh install."""
    ka, kb = _version_key(a), _version_key(b)
    return ka is not None and kb is not None and ka > kb


def installed_version(home: Path) -> str | None:
    """The version of the host files in `home` (their version.py), None when there are none to speak of."""
    try:
        found = _VERSION_LINE.search((Path(home) / "host" / "version.py").read_text(encoding="utf-8"))
    except OSError:
        return None
    return found.group(1) if found else None


# ---------------------------------------------------------------- the whole run

def _default_parts(home: Path, platform: str, package: Path | None, network: bool) -> dict:
    def deploy(parent: Path) -> Deployed:
        if package is None:
            raise SetupError("安裝檔裡沒有擴充功能的檔案（--extension-zip）")
        return deploy_extension(package, parent)

    def report(home_: Path, ext_id: str, manifest: Path) -> list:
        checks = doctor.diagnose(home_, ext_id=ext_id, native_manifest=manifest, platform=platform, network=network)
        say(doctor.format_report(checks))
        return [c for c in checks if c.status == "error"]

    return {
        "tools": lambda home_, platform_: ensure_tools(home_, platform_),
        "register": lambda home_, platform_, ext_id: register(home_, platform_, ext_id),
        "deploy": deploy,
        "selftest": lambda home_, platform_: selftest(home_ / ("host.cmd" if platform_.startswith("win") else "host.sh")),
        "report": report,
        "open": lambda folder: open_next_steps(platform, folder),
        "choose": lambda: choose_parent(platform),
    }


def run_setup(home: Path, platform: str, ext_id: str, *, parent: Path | None = None, package: Path | None = None,
              version: str = "", open_things: bool = True, network: bool = True, no_deploy: bool = False,
              parts: dict | None = None) -> int:
    home = Path(home)
    start_log(home)
    try:
        return _run_setup(home, platform, ext_id, parent, package, version, open_things, network, no_deploy, parts)
    finally:
        stop_log()


def _run_setup(home: Path, platform: str, ext_id: str, parent: Path | None, package: Path | None, version: str,
               open_things: bool, network: bool, no_deploy: bool, parts: dict | None) -> int:
    steps = {**_default_parts(home, platform, package, network), **(parts or {})}
    installed = installed_version(home)
    say(f"版本：電腦上現有 {installed or '無'}，這個安裝檔 {version or '未知'}")
    if is_newer(installed, version) and not no_deploy:  # (the bootstraps already keep their old files away: this is for any other way of running it)
        no_deploy = True
        say(f"已安裝的版本（{installed}）比這個安裝檔（{version}）新，不會降版。要更新請在網頁按「更新到最新版」。")
    deployed = None
    try:
        steps["tools"](home, platform)

        step("登錄 Chrome Native Messaging")
        manifest = steps["register"](home, platform, ext_id)

        recorded = recorded_extension_folder(home) if parent is None else None
        if no_deploy:
            step("擴充功能的資料夾維持不動")
            say("    不更動下載助手與擴充功能的檔案，只檢查並修復其他項目" + (f"：{recorded}" if recorded else ""))
        else:
            step("放好擴充功能的資料夾")
            if recorded is not None:
                deployed = steps["deploy"](recorded)
            else:
                chosen = parent
                if chosen is None:
                    chosen = steps["choose"]()
                    if chosen is None:
                        chosen = Path.home()
                        say("    沒有選擇資料夾，使用預設位置：使用者資料夾")
                deployed = steps["deploy"](chosen)
            say(f"    {deployed.path}（{deployed.count} 個檔案）")

        if not no_deploy:
            selfupdate.clear_pending(home)  # a marker left by an older update must not undo files this run just laid down

        step("測試下載助手能不能被 Chrome 啟動")
        ready = steps["selftest"](home, platform)
        say(f"    OK（yt-dlp {ready.get('ytdlpVersion') or '?'}）")

        step("檢查安裝結果")
        problems = steps["report"](home, ext_id, manifest)
    except (SetupError, OSError, ValueError, subprocess.SubprocessError) as exc:
        say(f"\n安裝失敗：{exc if isinstance(exc, SetupError) else f'{type(exc).__name__}：{exc}'}")
        say("請截圖這個視窗，並聯絡提供工具的同事。")
        return 1
    if problems:
        say("\n安裝尚未完成：上面標著 ✘ 的項目需要處理。")
        say("照每一項下面的「→」建議做；解決不了就把這個視窗截圖給提供工具的同事。")
        return 1
    if no_deploy:  # nothing was laid down: the record keeps its folder, and says which version really is installed
        write_record(home, extension_folder=read_record(home).get("extensionFolder"), version=installed_version(home) or version)
        say("\n安裝完成！（下載助手與擴充功能的檔案沒有更動）")
        say("回到 Chrome，網頁版會自動連線；沒有反應時按「啟動」。")
        say("之後如果遇到任何問題，重新執行這個安裝檔就會自動檢查並修復。")
        return 0
    write_record(home, extension_folder=deployed.path, version=version)  # (only now: a run that failed leaves the next one a fresh start)
    say("\n安裝完成！")
    if recorded is None and open_things:  # the first run that worked: the extension still has to be loaded
        steps["open"](deployed.path)
        say("最後一步（只要做一次）：在 Chrome 的「擴充功能」頁面打開右上角「開發人員模式」，")
        say(f"按「載入未封裝項目」，選這個資料夾：\n    {deployed.path}")
        say("載入後回到網頁版，它會自動偵測並連線。")
    else:
        say("回到 Chrome，網頁版會自動連線；沒有反應時按「啟動」。")
    say("之後如果遇到任何問題，重新執行這個安裝檔就會自動檢查並修復。")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="安裝（或修復）下載助手與擴充功能資料夾")
    parser.add_argument("--home", default=os.environ.get("YTDL_HOME") or str(Path(__file__).resolve().parent.parent))
    parser.add_argument("--ext-id", required=True)
    parser.add_argument("--extension-zip")
    parser.add_argument("--parent", help="擴充功能資料夾要放進哪個資料夾（不指定就跳出選擇視窗）")
    parser.add_argument("--version", default="")
    parser.add_argument("--platform", default=os.environ.get("YTDL_PLATFORM") or sys.platform, help=argparse.SUPPRESS)  # tests: pretend to be another system
    parser.add_argument("--skip-network", action="store_true", default=os.environ.get("YTDL_SKIP_NETWORK") == "1", help=argparse.SUPPRESS)
    parser.add_argument("--no-open", action="store_true", help="完成後不要自動開啟資料夾與 Chrome 的擴充功能頁")
    parser.add_argument("--no-deploy", action="store_true", help="不更動擴充功能的資料夾（安裝檔比已安裝的版本舊時用：只檢查並修復其他項目）")
    args = parser.parse_args(argv)
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass
    return run_setup(Path(args.home), args.platform, args.ext_id, parent=Path(args.parent) if args.parent else None,
                     package=Path(args.extension_zip) if args.extension_zip else None, version=args.version,
                     open_things=not args.no_open, network=not args.skip_network, no_deploy=args.no_deploy)


if __name__ == "__main__":
    sys.exit(main())
