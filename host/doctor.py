"""Health check of the local host's setup: what is there, what actually runs, what is wrong, what to do about it.

Used by the installers (the report at the end of an install), by the host (the "check" and "repair" buttons in the
extension) and from a terminal (`python doctor.py --home <folder>`). Standard library only.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable

import macos_engine
import winengine
from config import ConfigStore
from install_record import fingerprint, is_extension, read_engine, read_record
from version import VERSION
from ytdlp import run_capture

HOST_NAME = "com.ytdl.batch_downloader"  # must equal build.HOST_NAME (a test enforces it)
MIN_PYTHON = (3, 9)
MIN_FREE_BYTES = 1 << 30
_MACHO = (b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xce\xfa\xed\xfe")  # how a compiled Mac program starts
_REINSTALL = "重新執行安裝檔（它會自動檢查並修復）"
_MARKS = {"ok": "✔", "warn": "⚠", "error": "✘"}

Run = Callable[[list], tuple]


@dataclass
class Check:
    id: str
    status: str  # "ok" | "warn" | "error"
    title: str
    detail: str = ""
    fix: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def _tail(text: str, size: int = 200) -> str:
    return text.strip()[-size:]


def _exe(name: str, platform: str) -> str:
    return f"{name}.exe" if platform.startswith("win") else name


def _check_python() -> Check:
    v = sys.version_info
    title = f"Python {v.major}.{v.minor}.{v.micro}"
    if (v.major, v.minor) < MIN_PYTHON:
        return Check("python", "error", f"{title} 太舊（需要 3.9 以上）", sys.executable,
                     "Mac：在終端機執行 xcode-select --install；Windows：重新執行安裝檔")
    return Check("python", "ok", title, sys.executable)


def engine_path(home: Path, platform: str) -> Path:
    """Where yt-dlp is. On Windows: the unpacked build (bin/yt-dlp_dir/yt-dlp.exe), else the older single file next to it."""
    if platform.startswith("win"):
        return winengine.engine_path(home)
    return Path(home) / "bin" / "yt-dlp"


def _blocked_check(home: Path, path: Path, why: str, expected: dict) -> Check:
    """yt-dlp.exe was stopped by an antivirus: what to allow, and the facts IT needs to allow it."""
    facts = dict(expected)
    if not facts.get("sha256") and path.exists():
        try:
            facts = fingerprint(path)
        except OSError:
            facts = {}
    detail = f"{path}"
    if facts.get("sha256"):
        detail += f"；SHA-256 {facts['sha256']}；大小 {facts.get('size', '?')} 位元組"
    if why:
        detail += f"；Windows 回報：{why}"
    return Check("engine", "error", "下載引擎（yt-dlp.exe）被防毒軟體攔截", detail,
                 f"請防毒軟體（或請公司 IT）排除資料夾 {Path(home) / 'bin'} 並允許上面的檔案，然後" + _REINSTALL)


def _engine_state(home: Path, platform: str, run: Run) -> tuple[Check, str]:
    """The engine's check, and what is the matter: "ok", "legacy" (an older single file build that works), "missing", "blocked"
    (stopped by an antivirus) or "broken"."""
    path = engine_path(home, platform)
    win = platform.startswith("win")
    recorded = read_engine(home) if win else {}
    if not path.exists():
        if win and recorded:
            return Check("engine", "error", "找不到下載引擎（yt-dlp）：上次安裝後它不見了，可能被防毒軟體隔離",
                         f"{path}；SHA-256 {recorded['sha256']}；大小 {recorded.get('size', '?')} 位元組",
                         f"請防毒軟體（或請公司 IT）排除資料夾 {Path(home) / 'bin'}，並從隔離區還原或允許上面的檔案，然後" + _REINSTALL), "missing"
        return Check("engine", "error", "找不到下載引擎（yt-dlp）", str(path), _REINSTALL), "missing"
    if platform == "darwin":
        try:
            head = path.read_bytes()[:4]
        except OSError:
            head = b""
        if head in _MACHO:
            return Check("engine", "error", "yt-dlp 是舊版單檔版，Chrome 啟動它時會被 macOS 擋下", str(path),
                         "按「嘗試自動修復」，或" + _REINSTALL), "broken"
    code, out, err = run([str(path), "--version"])
    legacy = win and path.parent.name != macos_engine.INSTALL_DIR
    if code != 0 or not out.strip():
        why = _tail(err or out)
        if win and not legacy and winengine.classify_start_error(why) in ("virus", "denied"):
            return _blocked_check(home, path, why, recorded), "blocked"
        fix = (_REINSTALL if platform == "darwin"
               else "可能缺少 Visual C++ 執行階段，或被防毒軟體攔截；" + _REINSTALL)
        return Check("engine", "error", "下載引擎（yt-dlp）無法執行", why or f"結束碼 {code}", fix), "broken"
    if legacy:
        return Check("engine", "warn", f"下載引擎 yt-dlp {out.strip()}（舊版單檔，每次啟動都要先解壓縮，比較慢）", str(path),
                     "重新執行安裝檔，會改裝免解壓縮版"), "legacy"
    detail = str(path)
    if win:
        try:
            facts = fingerprint(path)
            detail += f"；SHA-256 {facts['sha256']}；大小 {facts['size']} 位元組"
        except OSError:
            pass
    return Check("engine", "ok", f"下載引擎 yt-dlp {out.strip()}", detail), "ok"


def _check_engine(home: Path, platform: str, run: Run) -> Check:
    return _engine_state(home, platform, run)[0]


def _check_tool(home: Path, name: str, label: str, args: list, why: str, platform: str, run: Run) -> Check:
    path = Path(home) / "bin" / _exe(name, platform)
    if not path.exists():
        return Check(name, "error", f"找不到 {label}（{why}）", str(path), _REINSTALL)
    code, out, err = run([str(path)] + args)
    if code != 0:
        hint = "Apple Silicon 上的 Intel 版需要 Rosetta：softwareupdate --install-rosetta；或" if platform == "darwin" else ""
        return Check(name, "error", f"{label} 無法執行", _tail(err or out) or f"結束碼 {code}", hint + _REINSTALL)
    first = (out.strip().splitlines() or [label])[0]
    return Check(name, "ok", f"{label} 可以執行（{first[:50]}）", str(path))


def _check_output(output_dir: Path) -> Check:
    target = Path(output_dir)
    probe = target
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    title = f"存放資料夾 {target}"
    if not probe.is_dir():
        return Check("output", "error", f"無法使用存放資料夾 {target}", f"{probe} 不是資料夾", "到「設定與工具」改成別的資料夾")
    try:
        with tempfile.TemporaryFile(dir=probe):
            pass
    except OSError as exc:
        return Check("output", "error", f"無法寫入存放資料夾 {target}", str(exc), "到「設定與工具」改成別的資料夾")
    free = shutil.disk_usage(probe)[2]
    if free < MIN_FREE_BYTES:
        return Check("output", "warn", f"存放資料夾所在的磁碟空間不足（剩 {free // (1 << 20)} MB）", str(target), "清出一些空間再下載")
    return Check("output", "ok", title, f"剩 {free // (1 << 30)} GB")


def default_manifest(platform: str) -> Path | None:
    if platform == "darwin":
        return Path.home() / "Library/Application Support/Google/Chrome/NativeMessagingHosts" / f"{HOST_NAME}.json"
    if platform.startswith("win"):
        return None  # next to the program files (see diagnose)
    return Path.home() / ".config/google-chrome/NativeMessagingHosts" / f"{HOST_NAME}.json"


def _registry_value() -> str | None:
    import winreg  # Windows only
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}") as key:
        return winreg.QueryValueEx(key, "")[0]


def _check_native(path: Path, ext_id: str | None, platform: str) -> Check:
    if not path.exists():
        return Check("native", "error", "Chrome 尚未登錄本機小程式", str(path), _REINSTALL)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return Check("native", "error", "Chrome 的登錄檔無法讀取", f"{path}：{exc}", _REINSTALL)
    launcher = Path(str(data.get("path", "")))
    if not launcher.exists():
        return Check("native", "error", "登錄檔指向的啟動檔不存在", str(launcher), _REINSTALL)
    origins = data.get("allowed_origins") or []
    if ext_id and f"chrome-extension://{ext_id}/" not in origins:
        return Check("native", "error", "擴充功能識別碼與登錄檔不符，Chrome 會拒絕連線", f"擴充功能 {ext_id}；登錄檔 {origins}", _REINSTALL)
    if platform.startswith("win"):
        try:
            value = _registry_value()
        except ImportError:
            value = str(path)
        except OSError:
            return Check("native", "error", "Windows 登錄表裡沒有 Chrome 的登錄項目", "", _REINSTALL)
        if os.path.normcase(str(value)) != os.path.normcase(str(path)):
            return Check("native", "error", "Windows 登錄表指向別的登錄檔", f"{value}", _REINSTALL)
    return Check("native", "ok", "Chrome 已登錄本機小程式", str(path))


def _check_extension_folder(home: Path) -> Check | None:
    """Only when the installer put the extension somewhere (an extension deployed by hand is not known to the host)."""
    folder = read_record(home).get("extensionFolder")
    if not isinstance(folder, str):
        return None
    if is_extension(Path(folder)):
        return Check("extension", "ok", "擴充功能資料夾在原位", folder)
    return Check("extension", "warn", "找不到擴充功能資料夾（可能被搬動或刪除了）", folder,
                 "把它搬回去，或" + _REINSTALL + "，然後到 chrome://extensions 重新載入")


def _quarantined(home: Path, run: Run) -> int:
    code, out, _ = run(["xattr", "-r", str(Path(home) / "bin"), str(Path(home) / "host")])
    return sum(1 for line in out.splitlines() if "com.apple.quarantine" in line) if code == 0 else 0


def _check_network(run: Run) -> Check | None:
    code, out, err = run(["curl", "-sS", "-I", "-m", "8", "-o", os.devnull, "-w", "%{http_code}", "https://www.youtube.com"])
    if code == 127:  # no curl here: nothing to say
        return None
    status = out.strip()
    if code == 0 and status[:1] in ("2", "3"):
        return Check("network", "ok", "連得到 YouTube")
    why = _tail(err) or f"回應 {status}"
    return Check("network", "warn", "連不到 YouTube（網路、代理或防火牆）", why, "換個網路再試，公司網路可能需要 IT 放行")


def diagnose(home: Path, *, ext_id: str | None = None, native_manifest: Path | None = None, output_dir: Path | None = None,
             run: Run = run_capture, platform: str = sys.platform, network: bool = True) -> list[Check]:
    home = Path(home)
    manifest = Path(native_manifest) if native_manifest else (default_manifest(platform) or home / f"{HOST_NAME}.json")
    output = Path(output_dir) if output_dir else ConfigStore(home / "config.json").output_dir
    checks = [
        _check_python(),
        Check("files", "ok", f"本機小程式 {VERSION}", str(home / "host")),
        _check_engine(home, platform, run),
        _check_tool(home, "ffmpeg", "ffmpeg", ["-version"], "合併影片與聲音需要", platform, run),
        _check_tool(home, "deno", "Deno", ["--version"], "YouTube 解題需要", platform, run),
        _check_output(output),
        _check_native(manifest, ext_id, platform),
    ]
    if folder_check := _check_extension_folder(home):
        checks.append(folder_check)
    if platform == "darwin":
        marked = _quarantined(home, run)
        checks.append(Check("quarantine", "warn", f"{marked} 個檔案帶有「從網路下載」標記", "macOS 可能因此擋下它們", "按「嘗試自動修復」，或" + _REINSTALL)
                      if marked else Check("quarantine", "ok", "檔案沒有「從網路下載」標記"))
    if network and (net := _check_network(run)):
        checks.append(net)
    return checks


def has_errors(checks: list[Check]) -> bool:
    return any(c.status == "error" for c in checks)


def format_report(checks: list[Check]) -> str:
    lines = []
    for c in checks:
        lines.append(f"  {_MARKS[c.status]} {c.title}")
        if c.status != "ok":
            if c.detail:
                lines.append(f"      {c.detail}")
            if c.fix:
                lines.append(f"      → {c.fix}")
    return "\n".join(lines)


def repair(home: Path, *, platform: str = sys.platform, run: Run = run_capture, output_dir: Path | None = None,
           reinstall_engine: Callable[[Path], str] | None = None) -> list[str]:
    """Safe fixes only. Returns what was done, a line starting with ✘ for what could not be."""
    home = Path(home)
    done: list[str] = []
    output = Path(output_dir) if output_dir else ConfigStore(home / "config.json").output_dir
    if not output.exists():
        try:
            output.mkdir(parents=True, exist_ok=True)
            done.append(f"已建立存放資料夾 {output}")
        except OSError as exc:
            done.append(f"✘ 無法建立存放資料夾 {output}：{exc}")
    win = platform.startswith("win")
    if platform == "darwin" or win:
        check, kind = _engine_state(home, platform, run)
        if kind == "blocked":  # downloading it again would only get it blocked again
            done.append(f"✘ yt-dlp.exe 被防毒軟體攔截，重新下載也會再被攔截。{check.fix}（{check.detail}）")
        elif check.status == "error":
            reinstall = reinstall_engine or (winengine.install if win else macos_engine.install)
            try:
                done.append(f"已重新安裝 yt-dlp（{reinstall(home / 'bin')}）")
            except macos_engine.EngineInstallError as exc:
                done.append(f"✘ 重新安裝 yt-dlp 失敗：{exc}")
    if platform == "darwin":
        run(["xattr", "-dr", "com.apple.quarantine", str(home / "bin"), str(home / "host")])
        done.append("已移除檔案上「從網路下載」的標記")
    return done


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="檢查本機小程式的環境")
    parser.add_argument("--home", default=os.environ.get("YTDL_HOME") or str(Path(__file__).resolve().parent.parent))
    parser.add_argument("--ext-id")
    parser.add_argument("--native-manifest")
    parser.add_argument("--output-dir")
    parser.add_argument("--skip-network", action="store_true")
    parser.add_argument("--fix", action="store_true", help="先做安全的修復，再檢查")
    args = parser.parse_args(argv[1:] if argv is not None else None)
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass
    home = Path(args.home)
    common = {"output_dir": Path(args.output_dir) if args.output_dir else None}
    if args.fix:
        for line in repair(home, **common):
            print(f"  {line}")
    checks = diagnose(home, ext_id=args.ext_id, native_manifest=Path(args.native_manifest) if args.native_manifest else None,
                      network=not args.skip_network, **common)
    print(format_report(checks))
    return 1 if has_errors(checks) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
