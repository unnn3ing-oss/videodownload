from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path

import pytest

import doctor
import host as host_mod
from doctor import Check, diagnose, format_report, has_errors, repair
from macos_engine import EngineInstallError
from ytdlp import run_capture

NAME = doctor.HOST_NAME

# The fake yt-dlp / ffmpeg / deno here are `#!/bin/sh` scripts that are run for real: Windows cannot start those (WinError 193).
# What a Windows machine adds (the .exe names, the unpacked build, the antivirus, the registry) is tested through the `platform=`
# argument on every other system, and Windows really starting a program is tested with host/tests/stub_ytdlp.py in test_host.py.
posix_programs = pytest.mark.skipif(os.name == "nt", reason="the fake programs are #!/bin/sh scripts, which Windows cannot run")
# the platform the tests that are not about a particular system run as (on Windows the default would make them look for .exe files
# and read the registry)
HERE_PLATFORM = "linux" if sys.platform.startswith("win") else sys.platform


def script(path: Path, body: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def make_home(tmp_path: Path, *, engine="echo 2099.01.01\n", ffmpeg="echo ffmpeg version 7\n", deno="echo deno 2.0\n") -> Path:
    home = tmp_path / "home"
    (home / "host").mkdir(parents=True)
    for name, body in (("yt-dlp", engine), ("ffmpeg", ffmpeg), ("deno", deno)):
        if body is not None:
            script(home / "bin" / name, body)
    return home


def manifest(tmp_path: Path, launcher: Path | None = None, origins=None) -> Path:
    tmp_path.mkdir(parents=True, exist_ok=True)
    launcher = launcher or script(tmp_path / "host.sh", "exit 0\n")
    path = tmp_path / f"{NAME}.json"
    path.write_text(json.dumps({"name": NAME, "path": str(launcher), "type": "stdio",
                                "allowed_origins": origins if origins is not None else ["chrome-extension://abc/"]}))
    return path


class Fake:
    """Real tools (small shell scripts) run for real; curl and xattr are answered here."""

    def __init__(self, curl=(0, "200", ""), xattr=(0, "", "")):
        self.curl, self.xattr, self.calls = curl, xattr, []

    def __call__(self, cmd):
        self.calls.append(cmd)
        if cmd[0] == "curl":
            return self.curl
        if cmd[0] == "xattr":
            return self.xattr
        return run_capture(cmd)


def by_id(checks):
    return {c.id: c for c in checks}


def run_all(tmp_path, home=None, **kwargs):
    home = home or make_home(tmp_path)
    if "native_manifest" not in kwargs:  # (not setdefault: that would write the default file over one the test made)
        kwargs["native_manifest"] = manifest(tmp_path)
    kwargs.setdefault("output_dir", tmp_path / "out")
    kwargs.setdefault("run", Fake())
    kwargs.setdefault("platform", HERE_PLATFORM)
    return by_id(diagnose(home, **kwargs))


@posix_programs
def test_a_healthy_install_has_nothing_to_report(tmp_path):
    checks = run_all(tmp_path, ext_id="abc")
    assert all(c.status == "ok" for c in checks.values()), {k: (c.status, c.detail) for k, c in checks.items()}
    assert list(checks) == ["python", "files", "engine", "ffmpeg", "deno", "output", "native", "network"]
    assert "2099.01.01" in checks["engine"].title and "ffmpeg" in checks["ffmpeg"].title.lower() and "deno" in checks["deno"].title.lower()
    assert not has_errors(list(checks.values()))


@posix_programs
def test_missing_parts_are_errors_that_say_what_to_do(tmp_path):
    home = make_home(tmp_path, ffmpeg=None, deno=None)
    checks = run_all(tmp_path, home=home)
    for name in ("ffmpeg", "deno"):
        assert checks[name].status == "error" and "重新執行安裝檔" in checks[name].fix, name
    assert checks["engine"].status == "ok"
    assert has_errors(list(checks.values()))
    missing_engine = run_all(tmp_path / "x", home=make_home(tmp_path / "x", engine=None))
    assert missing_engine["engine"].status == "error" and "找不到下載引擎" in missing_engine["engine"].title


@posix_programs
def test_a_program_that_does_not_run_is_an_error_with_the_reason(tmp_path):
    checks = run_all(tmp_path, home=make_home(tmp_path, engine="echo 'boom: bad cpu type' >&2\nexit 3\n"))
    assert checks["engine"].status == "error"
    assert "boom: bad cpu type" in checks["engine"].detail


@posix_programs
def test_a_single_file_yt_dlp_on_a_mac_is_found_before_it_is_run(tmp_path):
    home = make_home(tmp_path, engine=None)
    (home / "bin" / "yt-dlp").write_bytes(b"\xcf\xfa\xed\xfe" + b"\x00" * 64)  # a Mach-O program: the old single-file build
    (home / "bin" / "yt-dlp").chmod(0o755)
    fake = Fake()
    checks = run_all(tmp_path, home=home, run=fake, platform="darwin")
    assert checks["engine"].status == "error" and "舊版單檔" in checks["engine"].title
    assert not any(c[0].endswith("yt-dlp") for c in fake.calls), "it is not even started"
    unpacked = make_home(tmp_path / "ok")  # the unpacked build is started through a script: fine
    assert run_all(tmp_path / "ok", home=unpacked, platform="darwin")["engine"].status == "ok"


def test_quarantine_marks_on_a_mac_are_a_warning_and_only_looked_for_on_a_mac(tmp_path):
    marked = "/h/bin/yt-dlp_dir/Python: com.apple.quarantine\n/h/bin/deno: com.apple.quarantine\n/h/bin/ffmpeg: com.apple.metadata\n"
    checks = run_all(tmp_path, run=Fake(xattr=(0, marked, "")), platform="darwin")
    assert checks["quarantine"].status == "warn" and "2" in checks["quarantine"].title
    assert run_all(tmp_path / "clean", run=Fake(), platform="darwin")["quarantine"].status == "ok"
    assert "quarantine" not in run_all(tmp_path / "linux", platform="linux")


def test_network_trouble_is_a_warning_and_a_missing_curl_skips_the_check(tmp_path):
    assert run_all(tmp_path, run=Fake(curl=(0, "301", "")))["network"].status == "ok"
    down = run_all(tmp_path / "a", run=Fake(curl=(6, "000", "Could not resolve host")))["network"]
    assert down.status == "warn" and "YouTube" in down.title
    blocked = run_all(tmp_path / "b", run=Fake(curl=(0, "403", "")))["network"]
    assert blocked.status == "warn"
    assert "network" not in run_all(tmp_path / "c", run=Fake(curl=(127, "", "No such file")))


def test_the_output_folder_must_be_writable_and_have_room(tmp_path, monkeypatch):
    blocker = tmp_path / "file"
    blocker.write_text("x")
    bad = run_all(tmp_path, output_dir=blocker / "sub")["output"]
    assert bad.status == "error" and "存放資料夾" in bad.title
    monkeypatch.setattr(doctor.shutil, "disk_usage", lambda p: (100, 99, 1 << 20))
    low = run_all(tmp_path / "x")["output"]
    assert low.status == "warn" and "空間" in low.title


def test_the_chrome_registration_is_checked_against_the_extension(tmp_path):
    ok = run_all(tmp_path, ext_id="abc", native_manifest=manifest(tmp_path))["native"]
    assert ok.status == "ok"
    wrong = run_all(tmp_path / "a", ext_id="zzz", native_manifest=manifest(tmp_path / "a"))["native"]
    assert wrong.status == "error" and "識別碼" in wrong.title and "重新執行安裝檔" in wrong.fix
    missing = run_all(tmp_path / "b", native_manifest=tmp_path / "b" / "nope.json")["native"]
    assert missing.status == "error" and "尚未登錄" in missing.title
    no_launcher = run_all(tmp_path / "c", native_manifest=manifest(tmp_path / "c", launcher=tmp_path / "c" / "gone.sh"))["native"]
    assert no_launcher.status == "error" and "啟動檔" in no_launcher.title
    (tmp_path / "d").mkdir()
    (tmp_path / "d" / "bad.json").write_text("{not json")
    assert run_all(tmp_path / "d", native_manifest=tmp_path / "d" / "bad.json")["native"].status == "error"


def test_on_windows_the_registry_entry_must_point_at_the_registration_file(tmp_path, monkeypatch):
    import contextlib
    import sys
    import types

    path = manifest(tmp_path)
    value = {"v": str(path)}

    def open_key(*args):
        if value["v"] is None:
            raise OSError("no such key")
        return contextlib.nullcontext()

    monkeypatch.setitem(sys.modules, "winreg", types.SimpleNamespace(
        HKEY_CURRENT_USER=1, OpenKey=open_key, QueryValueEx=lambda key, name: (value["v"], 1)))
    assert doctor._check_native(path, None, "win32").status == "ok"
    value["v"] = str(tmp_path / "other.json")
    assert doctor._check_native(path, None, "win32").status == "error"
    value["v"] = None
    missing = doctor._check_native(path, None, "win32")
    assert missing.status == "error" and "登錄表" in missing.title


def test_the_report_marks_each_line_and_gives_the_advice_under_a_problem():
    text = format_report([Check("a", "ok", "Python 3.13"), Check("b", "error", "找不到 ffmpeg", "bin 裡沒有", "重新執行安裝檔"),
                          Check("c", "warn", "連不到 YouTube")])
    lines = text.splitlines()
    assert lines[0].endswith("Python 3.13") and "✔" in lines[0]
    assert "✘" in lines[1] and "找不到 ffmpeg" in lines[1]
    assert "bin 裡沒有" in text and "→ 重新執行安裝檔" in text
    assert "⚠" in lines[-1]


# ---- repair ----

@posix_programs
def test_repair_on_a_mac_removes_the_marks_and_installs_yt_dlp_again_when_it_is_broken(tmp_path):
    home = make_home(tmp_path, engine="exit 3\n")
    fake = Fake()
    installed = []
    done = repair(home, platform="darwin", run=fake, output_dir=tmp_path / "out",
                  reinstall_engine=lambda bin_dir: installed.append(bin_dir) or "2101.01.01")
    assert installed == [home / "bin"]
    assert any(c[:3] == ["xattr", "-dr", "com.apple.quarantine"] for c in fake.calls)
    assert (tmp_path / "out").is_dir()
    assert any("yt-dlp" in line and "2101.01.01" in line for line in done)


@posix_programs
def test_repair_leaves_a_working_engine_alone_and_reports_a_failed_reinstall(tmp_path):
    home = make_home(tmp_path)
    called = []
    repair(home, platform="darwin", run=Fake(), output_dir=tmp_path / "out", reinstall_engine=lambda b: called.append(b) or "x")
    assert called == [], "a yt-dlp that runs is not touched"

    def broken(bin_dir):
        raise EngineInstallError("校驗碼不符")

    done = repair(make_home(tmp_path / "b", engine=None), platform="darwin", run=Fake(), output_dir=tmp_path / "out2", reinstall_engine=broken)
    assert any(line.startswith("✘") and "校驗碼不符" in line for line in done)


def test_repair_elsewhere_only_makes_sure_the_output_folder_exists(tmp_path):
    fake = Fake()
    done = repair(make_home(tmp_path), platform="linux", run=fake, output_dir=tmp_path / "out")
    assert (tmp_path / "out").is_dir() and done and not any(c[0] == "xattr" for c in fake.calls)


# ---- command line and the host's message ----

@posix_programs
def test_the_command_line_prints_the_report_and_exits_with_the_verdict(tmp_path, capsys):
    home = make_home(tmp_path)
    args = ["doctor.py", "--home", str(home), "--native-manifest", str(manifest(tmp_path)), "--output-dir", str(tmp_path / "o"),
            "--skip-network"]
    assert doctor.main(args) == 0
    assert "✔" in capsys.readouterr().out
    broken = make_home(tmp_path / "b", ffmpeg=None)
    assert doctor.main(["doctor.py", "--home", str(broken), "--native-manifest", str(manifest(tmp_path / "b")),
                        "--output-dir", str(tmp_path / "o2"), "--skip-network"]) == 1
    assert "✘" in capsys.readouterr().out


def new_host(tmp_path):
    events = []
    home = make_home(tmp_path)
    h = host_mod.Host(home, events.append)
    h.config.set_output_dir(str(tmp_path / "out"))
    return h, events


@posix_programs
def test_the_host_answers_a_doctor_request_with_the_checks(tmp_path, monkeypatch):
    h, events = new_host(tmp_path)
    monkeypatch.setattr(doctor, "default_manifest", lambda platform: manifest(tmp_path))
    h.handle({"type": "doctor", "reqId": 3, "extensionId": "abc"})
    h.wait(30)
    [reply] = events
    assert reply["type"] == "doctor" and reply["reqId"] == 3 and reply["fixed"] == []
    ids = [c["id"] for c in reply["checks"]]
    assert ids[:5] == ["python", "files", "engine", "ffmpeg", "deno"]
    assert all(set(c) == {"id", "status", "title", "detail", "fix"} for c in reply["checks"])
    assert {c["id"]: c["status"] for c in reply["checks"]}["engine"] == "ok"


def test_a_doctor_request_with_fix_repairs_first_and_checks_afterwards(tmp_path, monkeypatch):
    h, events = new_host(tmp_path)
    monkeypatch.setattr(doctor, "default_manifest", lambda platform: manifest(tmp_path))
    seen = []
    monkeypatch.setattr(host_mod.doctor, "repair", lambda home, **kw: seen.append(home) or ["已建立存放資料夾"])
    h.handle({"type": "doctor", "fix": True})
    h.wait(30)
    assert seen == [h.home] and events[0]["fixed"] == ["已建立存放資料夾"] and events[0]["checks"]


def test_garbage_in_a_doctor_request_does_not_break_it(tmp_path, monkeypatch):
    h, events = new_host(tmp_path)
    monkeypatch.setattr(doctor, "default_manifest", lambda platform: manifest(tmp_path))
    h.handle({"type": "doctor", "extensionId": {"x": 1}, "fix": "yes"})
    h.wait(30)
    assert events[0]["type"] == "doctor" and events[0]["fixed"] == []


# ---------------------------------------------------------------- the extension's folder (when the installer put it there)

def test_no_install_record_means_no_extension_folder_line(tmp_path):
    home = make_home(tmp_path)
    checks = diagnose(home, native_manifest=manifest(tmp_path / "m"), output_dir=tmp_path / "out", run=Fake(), platform="linux", network=False)
    assert "extension" not in by_id(checks)


def test_the_recorded_extension_folder_is_checked(tmp_path):
    from install_record import EXTENSION_NAME, write_record
    home = make_home(tmp_path)
    ext = tmp_path / "ext"
    ext.mkdir()
    write_record(home, extension_folder=ext, version="1")
    common = dict(native_manifest=manifest(tmp_path / "m"), output_dir=tmp_path / "out", run=Fake(), platform="linux", network=False)
    gone = by_id(diagnose(home, **common))["extension"]
    assert gone.status == "warn" and str(ext) in gone.detail and "重新執行安裝檔" in gone.fix
    (ext / "manifest.json").write_text(json.dumps({"name": EXTENSION_NAME}))
    fine = by_id(diagnose(home, **common))["extension"]
    assert fine.status == "ok" and str(ext) in fine.detail


# ---------------------------------------------------------------- Windows: the unpacked yt-dlp, and what an antivirus does to it

VIRUS = "[WinError 225] Operation did not complete successfully because the file contains a virus or potentially unwanted software"


def win_home(tmp_path, *, onedir="echo 2099.01.01\n", legacy=None):
    home = tmp_path / "home"
    (home / "bin").mkdir(parents=True)
    if onedir is not None:
        script(home / "bin" / "yt-dlp_dir" / "yt-dlp.exe", onedir)
    if legacy is not None:
        script(home / "bin" / "yt-dlp.exe", legacy)
    return home


def win_engine(home, run=None):
    return doctor._check_engine(home, "win32", run or Fake())


@posix_programs
def test_on_windows_the_engine_is_the_unpacked_build_and_the_check_says_where_it_is_and_what_file_it_is(tmp_path):
    import hashlib
    home = win_home(tmp_path)
    check = win_engine(home)
    exe = home / "bin" / "yt-dlp_dir" / "yt-dlp.exe"
    assert check.status == "ok" and "2099.01.01" in check.title
    assert str(exe) in check.detail and hashlib.sha256(exe.read_bytes()).hexdigest() in check.detail and str(exe.stat().st_size) in check.detail
    assert doctor.engine_path(home, "win32") == exe


@posix_programs
def test_a_single_file_engine_still_works_but_is_called_old(tmp_path):
    check = win_engine(win_home(tmp_path, onedir=None, legacy="echo 2099.01.01\n"))
    assert check.status == "warn" and "舊版單檔" in check.title and "重新執行安裝檔" in check.fix
    assert doctor._engine_state(win_home(tmp_path / "x", onedir=None, legacy="echo 1\n"), "win32", Fake())[1] == "legacy"


@posix_programs
def test_an_engine_that_an_antivirus_blocks_is_reported_with_the_facts_for_IT(tmp_path):
    from install_record import fingerprint, write_engine
    home = win_home(tmp_path, onedir=f"echo '{VIRUS}' >&2\nexit 127\n")
    exe = home / "bin" / "yt-dlp_dir" / "yt-dlp.exe"
    write_engine(home, {**fingerprint(exe), "sha256": "e" * 64})  # what was verified at install time
    check, kind = doctor._engine_state(home, "win32", Fake())
    assert kind == "blocked" and check.status == "error" and "防毒" in check.title
    assert str(exe) in check.detail and "e" * 64 in check.detail
    assert str(home / "bin") in check.fix and "重新執行安裝檔" in check.fix


def test_a_missing_engine_that_was_installed_before_is_probably_quarantined(tmp_path):
    from install_record import write_engine
    home = win_home(tmp_path, onedir=None)
    assert "防毒" not in win_engine(home).title
    write_engine(home, {"path": str(home / "bin/yt-dlp_dir/yt-dlp.exe"), "sha256": "f" * 64, "size": 7})
    check, kind = doctor._engine_state(home, "win32", Fake())
    assert kind == "missing" and check.status == "error" and "防毒" in check.title
    assert "f" * 64 in check.detail and str(home / "bin/yt-dlp_dir/yt-dlp.exe") in check.detail


@posix_programs
def test_repair_on_windows_installs_the_unpacked_engine_again_when_it_is_missing_or_broken(tmp_path):
    seen = []
    done = repair(win_home(tmp_path, onedir="exit 3\n"), platform="win32", run=Fake(), output_dir=tmp_path / "o",
                  reinstall_engine=lambda bin_dir: seen.append(bin_dir) or "2101.01.01")
    assert seen == [tmp_path / "home" / "bin"] and any("2101.01.01" in line for line in done)
    seen.clear()
    repair(win_home(tmp_path / "b"), platform="win32", run=Fake(), output_dir=tmp_path / "o", reinstall_engine=lambda b: seen.append(b) or "x")
    assert seen == [], "an engine that runs is left alone"


@posix_programs
def test_repair_does_not_download_again_what_the_antivirus_blocks(tmp_path):
    seen = []
    done = repair(win_home(tmp_path, onedir=f"echo '{VIRUS}' >&2\nexit 127\n"), platform="win32", run=Fake(), output_dir=tmp_path / "o",
                  reinstall_engine=lambda bin_dir: seen.append(bin_dir) or "x")
    assert seen == [] and any(line.startswith("✘") and "防毒" in line for line in done)
