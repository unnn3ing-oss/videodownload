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
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import doctor
import macos_engine
from install_record import EXTENSION_NAME, is_extension as _is_extension, read_record, recorded_extension_folder, write_record
from ytdlp import run_capture

HOST_NAME = doctor.HOST_NAME
EXTENSION_FOLDER = "YT批量下載器"  # must equal FOLDER_NAME in extension/lib/setup-flow.js (a test enforces it)

_GH = "https://github.com"
URL = {
    "ytdlp_win": f"{_GH}/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
    "ytdlp_sums": f"{_GH}/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS",
    "deno_win": f"{_GH}/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip",
    "deno_mac_arm": f"{_GH}/denoland/deno/releases/latest/download/deno-aarch64-apple-darwin.zip",
    "deno_mac_x64": f"{_GH}/denoland/deno/releases/latest/download/deno-x86_64-apple-darwin.zip",
    "ffmpeg_win": f"{_GH}/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip",
    # Built for each chip (so Apple Silicon needs no Rosetta); a fixed release, so what is downloaded does not change under us.
    "ffmpeg_mac_arm": f"{_GH}/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-arm64.gz",
    "ffmpeg_mac_x64": f"{_GH}/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-x64.gz",
}

Run = Callable[[list], tuple]


class SetupError(Exception):
    """The message is shown to the person as it is."""


def say(text: str = "") -> None:
    print(text, flush=True)


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


def _verified_ytdlp_exe(bin_dir: Path, fetch_file_: Callable, fetch_text_: Callable) -> None:
    target = bin_dir / "yt-dlp.exe"
    part = bin_dir / "yt-dlp.exe.part"
    fetch_file_(URL["ytdlp_win"], part)
    try:
        expected = macos_engine.checksum_for(fetch_text_(URL["ytdlp_sums"]), "yt-dlp.exe")
        if hashlib.sha256(part.read_bytes()).hexdigest() != expected:
            raise SetupError("yt-dlp.exe 校驗碼不符，檔案可能損毀，請重新執行")
    except macos_engine.EngineInstallError as exc:
        raise SetupError(str(exc)) from exc
    except BaseException:
        part.unlink(missing_ok=True)
        raise
    os.replace(part, target)


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


def ensure_tools(home: Path, platform: str, *, run: Run = run_capture, fetch_file: Callable = fetch_file,
                 fetch_text: Callable = fetch_text, machine: str | None = None,
                 install_engine: Callable[[Path], str] = macos_engine.install) -> list[str]:
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
        engine = bin_dir / _exe("yt-dlp", platform)
        step("下載引擎 yt-dlp（真正下載影片的程式）")
        if doctor._check_engine(home, platform, run).status != "error":
            say("    已可使用，略過")
        else:
            if mac:  # the unpacked build (see macos_engine): the single file one is blocked by macOS when Chrome starts it
                say("    下載官方的免解壓縮版並核對校驗碼")
                try:
                    say(f"    yt-dlp {install_engine(bin_dir)}")
                except macos_engine.EngineInstallError as exc:
                    raise SetupError(f"yt-dlp 安裝失敗：{exc}") from exc
            elif win:
                engine.unlink(missing_ok=True)
                say("    下載官方的 yt-dlp.exe 並核對校驗碼")
                _verified_ytdlp_exe(bin_dir, fetch_file, fetch_text)
                if not _works(engine, "--version", run):  # its first start (virus scan, unpacking) is slow: it happens here, not in the self test
                    raise SetupError("下載的 yt-dlp.exe 無法啟動：可能被防毒軟體攔截。請暫時允許 " + str(engine) + " 後重新執行安裝檔。")
            else:
                raise SetupError("這個系統沒有對應的 yt-dlp 安裝方式（支援 Windows 與 Mac）")
            done.append("yt-dlp")

        deno = bin_dir / _exe("deno", platform)
        step("Deno（YouTube 解題需要的 JavaScript 執行環境）")
        if _works(deno, "--version", run):
            say("    已可使用，略過")
        else:
            deno.unlink(missing_ok=True)
            url = URL["deno_win"] if win else URL["deno_mac_arm"] if chip == "arm64" else URL["deno_mac_x64"]
            archive = work / "deno.zip"
            fetch_file(url, archive)
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
                _extract_member(archive, "ffmpeg.exe", ffmpeg)
            else:
                archive = work / "ffmpeg.gz"
                fetch_file(URL["ffmpeg_mac_arm"] if chip == "arm64" else URL["ffmpeg_mac_x64"], archive)
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
    data = {"name": HOST_NAME, "description": "YouTube 批量下載器本機小程式", "path": str(launcher), "type": "stdio",
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
        raise SetupError(f"小程式的啟動檔無法執行：{exc}") from exc
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
    reader.join(timeout)
    try:
        if "message" not in result:
            if proc.poll() is None:
                raise SetupError(f"小程式啟動後 {int(timeout)} 秒沒有回應")
            errors.seek(0)
            err = errors.read().decode("utf-8", errors="replace").strip()[-300:]
            raise SetupError(f"小程式一啟動就結束了（結束碼 {proc.returncode}）{('：' + err) if err else ''}")
        message = result["message"]
        if message.get("type") != "ready":
            raise SetupError(f"小程式第一則訊息不是預期的 ready：{message}")
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
              version: str = "", open_things: bool = True, network: bool = True, parts: dict | None = None) -> int:
    home = Path(home)
    steps = {**_default_parts(home, platform, package, network), **(parts or {})}
    try:
        steps["tools"](home, platform)

        step("登錄 Chrome Native Messaging")
        manifest = steps["register"](home, platform, ext_id)

        step("放好擴充功能的資料夾")
        recorded = recorded_extension_folder(home) if parent is None else None
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

        step("測試本機小程式能不能被 Chrome 啟動")
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
    parser = argparse.ArgumentParser(description="安裝（或修復）本機小程式與擴充功能資料夾")
    parser.add_argument("--home", default=os.environ.get("YTDL_HOME") or str(Path(__file__).resolve().parent.parent))
    parser.add_argument("--ext-id", required=True)
    parser.add_argument("--extension-zip")
    parser.add_argument("--parent", help="擴充功能資料夾要放進哪個資料夾（不指定就跳出選擇視窗）")
    parser.add_argument("--version", default="")
    parser.add_argument("--platform", default=os.environ.get("YTDL_PLATFORM") or sys.platform, help=argparse.SUPPRESS)  # tests: pretend to be another system
    parser.add_argument("--skip-network", action="store_true", default=os.environ.get("YTDL_SKIP_NETWORK") == "1", help=argparse.SUPPRESS)
    parser.add_argument("--no-open", action="store_true", help="完成後不要自動開啟資料夾與 Chrome 的擴充功能頁")
    args = parser.parse_args(argv)
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass
    return run_setup(Path(args.home), args.platform, args.ext_id, parent=Path(args.parent) if args.parent else None,
                     package=Path(args.extension_zip) if args.extension_zip else None, version=args.version,
                     open_things=not args.no_open, network=not args.skip_network)


if __name__ == "__main__":
    sys.exit(main())
