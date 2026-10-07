from __future__ import annotations

import hashlib
import io
import os
import shutil
import stat
import subprocess
import zipfile
from pathlib import Path

import pytest

import host as host_mod
import macos_engine
from macos_engine import ZIP_NAME, EngineInstallError, install

pytestmark = [
    pytest.mark.skipif(shutil.which("unzip") is None, reason="unzip not installed"),
    pytest.mark.skipif(os.name == "nt", reason="macos_engine only ever runs on a Mac: it unpacks yt-dlp_macos.zip (symlinks, a #!/bin/sh "
                                               "stand-in program that Windows cannot start). Windows has its own engine: test_winengine.py"),
]

OLD_VERSION = "old"


def _entry(z: zipfile.ZipFile, name: str, body: str, mode: int = 0o644) -> None:
    info = zipfile.ZipInfo(name)
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | mode) << 16
    z.writestr(info, body)


def make_zip(layout: str = "root", exe_body: str = "echo 2099.09.09\n") -> bytes:
    """A stand-in for yt-dlp_macos.zip: the program, the files it needs next to it, and a symlink like a framework has."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        prefix = "yt-dlp_macos/" if layout == "nested" else ""
        _entry(z, f"{prefix}yt-dlp_macos", "#!/bin/sh\n" + exe_body, 0o755)
        _entry(z, f"{prefix}_internal/lib.txt", "needed at run time")
        link = zipfile.ZipInfo(f"{prefix}_internal/Current")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o755) << 16
        z.writestr(link, "lib.txt")
    return buf.getvalue()


class Fakes:
    """Network and system calls replaced by recorders; `unzip` stays real so layout and symlinks are really tested."""

    def __init__(self, zip_bytes: bytes, sums: str | None = None, fail_download: bool = False):
        self.zip_bytes = zip_bytes
        digest = hashlib.sha256(zip_bytes).hexdigest()
        self.sums = f"{digest}  {ZIP_NAME}\n" if sums is None else sums
        self.fail_download = fail_download
        self.calls: list[str] = []

    def fetch_text(self, url: str) -> str:
        self.calls.append("sums")
        if self.fail_download:
            raise EngineInstallError("連不上")
        return self.sums

    def fetch_file(self, url: str, dest: Path) -> None:
        self.calls.append("zip")
        if self.fail_download:
            raise EngineInstallError("連不上")
        Path(dest).write_bytes(self.zip_bytes)

    def strip_quarantine(self, path: Path) -> None:
        self.calls.append(f"strip:{Path(path).name}")

    def kwargs(self) -> dict:
        return {"fetch_text": self.fetch_text, "fetch_file": self.fetch_file, "strip_quarantine": self.strip_quarantine}


def run_wrapper(bin_dir: Path) -> str:
    return subprocess.run([str(bin_dir / "yt-dlp"), "--version"], capture_output=True, text=True, check=True).stdout.strip()


def test_install_unpacks_once_checks_and_writes_a_launcher(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fakes = Fakes(make_zip())
    assert install(bin_dir, **fakes.kwargs()) == "2099.09.09"
    exe = bin_dir / "yt-dlp_dir" / "yt-dlp_macos"
    assert exe.is_file() and os.access(exe, os.X_OK)
    assert (bin_dir / "yt-dlp_dir" / "_internal" / "lib.txt").read_text() == "needed at run time"
    assert (bin_dir / "yt-dlp_dir" / "_internal" / "Current").is_symlink(), "symlinks inside the build survive unpacking"
    launcher = bin_dir / "yt-dlp"
    assert os.access(launcher, os.X_OK) and launcher.read_text().startswith("#!/bin/bash")
    assert run_wrapper(bin_dir) == "2099.09.09"
    assert not (bin_dir / ".yt-dlp-update").exists() and not (bin_dir / "yt-dlp_dir.old").exists(), "no leftovers"
    # quarantine is removed from what was unpacked (and from the launcher) before anything is run or put in place
    assert fakes.calls[:2] == ["sums", "zip"] and fakes.calls[2:] == ["strip:new", "strip:yt-dlp.tmp"]


def test_install_finds_the_program_inside_a_folder_of_the_archive(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    install(bin_dir, **Fakes(make_zip("nested")).kwargs())
    assert (bin_dir / "yt-dlp_dir" / "yt-dlp_macos" / "yt-dlp_macos").is_file()
    assert run_wrapper(bin_dir) == "2099.09.09"


def test_the_launcher_works_from_a_folder_with_spaces_and_passes_arguments_through(tmp_path):
    bin_dir = tmp_path / "Application Support" / "bin"
    bin_dir.mkdir(parents=True)
    fakes = Fakes(make_zip(exe_body='if [ "$1" = "--version" ]; then echo 1.2.3; else echo "args: $*"; fi\n'))
    install(bin_dir, **fakes.kwargs())
    out = subprocess.run([str(bin_dir / "yt-dlp"), "-f", "best", "--", "a b"], capture_output=True, text=True, check=True).stdout
    assert out.strip() == "args: -f best -- a b"


def test_a_wrong_checksum_changes_nothing(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "yt-dlp").write_text("#!/bin/sh\necho old\n")
    with pytest.raises(EngineInstallError, match="校驗碼不符"):
        install(bin_dir, **Fakes(make_zip(), sums=f"{'0' * 64}  {ZIP_NAME}\n").kwargs())
    assert (bin_dir / "yt-dlp").read_text() == "#!/bin/sh\necho old\n"
    assert not (bin_dir / "yt-dlp_dir").exists() and not (bin_dir / ".yt-dlp-update").exists()


def test_a_checksum_list_without_our_file_is_an_error(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    with pytest.raises(EngineInstallError, match="校驗碼"):
        install(bin_dir, **Fakes(make_zip(), sums=f"{'a' * 64}  yt-dlp_linux.zip\n").kwargs())


def test_checksum_lines_may_mark_binary_mode_and_use_windows_line_endings(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    zip_bytes = make_zip()
    sums = f"{'b' * 64}  yt-dlp.exe\r\n{hashlib.sha256(zip_bytes).hexdigest()} *{ZIP_NAME}\r\n"
    assert install(bin_dir, **Fakes(zip_bytes, sums=sums).kwargs()) == "2099.09.09"


def test_a_failed_download_changes_nothing(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "yt-dlp").write_text("keep")
    with pytest.raises(EngineInstallError, match="連不上"):
        install(bin_dir, **Fakes(make_zip(), fail_download=True).kwargs())
    assert (bin_dir / "yt-dlp").read_text() == "keep"


def test_an_archive_without_the_program_is_an_error(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        _entry(z, "README.txt", "no program here")
    with pytest.raises(EngineInstallError, match="找不到 yt-dlp_macos"):
        install(bin_dir, **Fakes(buf.getvalue()).kwargs())
    assert not (bin_dir / "yt-dlp").exists()


def test_a_program_that_cannot_run_is_never_put_in_place(tmp_path):
    bin_dir = tmp_path / "bin"
    (bin_dir / "yt-dlp_dir").mkdir(parents=True)
    (bin_dir / "yt-dlp_dir" / "marker").write_text(OLD_VERSION)
    (bin_dir / "yt-dlp").write_text("#!/bin/sh\necho old\n")
    with pytest.raises(EngineInstallError, match="無法執行"):
        install(bin_dir, **Fakes(make_zip(exe_body="exit 3\n")).kwargs())
    assert (bin_dir / "yt-dlp_dir" / "marker").read_text() == OLD_VERSION
    assert (bin_dir / "yt-dlp").read_text() == "#!/bin/sh\necho old\n"
    assert not (bin_dir / ".yt-dlp-update").exists()


def test_installing_again_replaces_the_old_build_and_a_legacy_single_file_engine(tmp_path):
    bin_dir = tmp_path / "bin"
    (bin_dir / "yt-dlp_dir").mkdir(parents=True)
    (bin_dir / "yt-dlp_dir" / "marker").write_text(OLD_VERSION)
    (bin_dir / "yt-dlp").write_bytes(b"\xcf\xfa\xed\xfe single file build")  # what the old installer put there
    install(bin_dir, **Fakes(make_zip()).kwargs())
    assert not (bin_dir / "yt-dlp_dir" / "marker").exists()
    assert run_wrapper(bin_dir) == "2099.09.09"
    install(bin_dir, **Fakes(make_zip(exe_body="echo 2100.01.01\n")).kwargs())
    assert run_wrapper(bin_dir) == "2100.01.01"


def test_a_failure_while_swapping_puts_the_old_install_back(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    (bin_dir / "yt-dlp_dir").mkdir(parents=True)
    (bin_dir / "yt-dlp_dir" / "marker").write_text(OLD_VERSION)

    def disk_full(src, dst):
        raise OSError("disk full")

    monkeypatch.setattr(macos_engine.os, "replace", disk_full)
    with pytest.raises(EngineInstallError, match="無法換上"):
        install(bin_dir, **Fakes(make_zip()).kwargs())
    assert (bin_dir / "yt-dlp_dir" / "marker").read_text() == OLD_VERSION
    assert not (bin_dir / "yt-dlp_dir.old").exists() and not (bin_dir / "yt-dlp_dir" / "yt-dlp_macos").exists()


def test_default_quarantine_removal_is_harmless_where_there_is_no_xattr(tmp_path, monkeypatch):
    monkeypatch.setattr(macos_engine.shutil, "which", lambda name: None)
    macos_engine._strip_quarantine(tmp_path)  # nothing to do, nothing raised


def test_command_line_prints_the_version_or_the_reason(tmp_path, capsys):
    assert macos_engine.main(["macos_engine.py", "install", str(tmp_path)], install_fn=lambda bin_dir: "9.9") == 0
    assert "yt-dlp 9.9" in capsys.readouterr().out

    def broken(bin_dir):
        raise EngineInstallError("校驗碼不符，檔案可能損毀")

    assert macos_engine.main(["macos_engine.py", "install", str(tmp_path)], install_fn=broken) == 1
    assert "校驗碼不符" in capsys.readouterr().out
    assert macos_engine.main(["macos_engine.py"], install_fn=broken) == 2


# ---- the host's "update engine" on a Mac goes through the same code, not through `yt-dlp -U` ----

def make_host(tmp_path):
    events = []
    home = tmp_path / "home"
    (home / "bin").mkdir(parents=True)
    return host_mod.Host(home, events.append), events


def test_update_engine_on_a_mac_installs_the_unpacked_build(tmp_path, monkeypatch):
    h, events = make_host(tmp_path)
    seen = []
    monkeypatch.setattr(host_mod, "_engine_installer", lambda: host_mod.macos_engine.install)
    monkeypatch.setattr(host_mod.macos_engine, "install", lambda bin_dir: seen.append(bin_dir) or "2101.02.03")
    monkeypatch.setattr(host_mod.Host, "_version", lambda self: "2101.02.03")
    h.handle({"type": "update_engine", "reqId": 5})
    h.wait(10)
    assert seen == [h.home / "bin"], "even with no engine yet: this is also how a broken one gets replaced"
    assert events == [{"type": "engine_updated", "ytdlpVersion": "2101.02.03", "reqId": 5}]


def test_update_engine_on_a_mac_reports_why_it_failed(tmp_path, monkeypatch):
    h, events = make_host(tmp_path)

    def broken(bin_dir):
        raise EngineInstallError("yt-dlp 校驗碼不符，檔案可能損毀，請重新執行")

    monkeypatch.setattr(host_mod, "_engine_installer", lambda: host_mod.macos_engine.install)
    monkeypatch.setattr(host_mod.macos_engine, "install", broken)
    h.handle({"type": "update_engine", "reqId": 6})
    h.wait(10)
    assert events == [{"type": "error", "code": "update_failed", "message": "更新失敗：yt-dlp 校驗碼不符，檔案可能損毀，請重新執行", "reqId": 6}]
