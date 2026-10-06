import hashlib
import io
import json
import os
import stat
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

import installer as setup
from installer import EXTENSION_FOLDER, SetupError

EXT_ID = "a" * 32
ROOT = Path(__file__).resolve().parent.parent.parent


def zip_bytes(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, text in files.items():
            z.writestr(name, text)
    return buf.getvalue()


class Net:
    """Stands in for the downloads: URL -> bytes. Records what was asked for."""

    def __init__(self, files: dict[str, bytes]):
        self.files, self.asked = files, []

    def file(self, url: str, dest: Path) -> None:
        self.asked.append(url)
        for part, data in self.files.items():
            if part in url:
                Path(dest).write_bytes(data)
                return
        raise SetupError(f"no such download in the test: {url}")

    def text(self, url: str) -> str:
        self.asked.append(url)
        for part, data in self.files.items():
            if part in url:
                return data.decode()
        raise SetupError(f"no such text in the test: {url}")


def runs_ok(code_for=None):
    """A `run` that answers by program name; default 0 with a version-like output."""
    def run(cmd):
        name = Path(cmd[0]).name
        code = (code_for or {}).get(name, 0)
        return code, "ok 1.0\n" if code == 0 else "", "" if code == 0 else "broken"
    return run


# ---------------------------------------------------------------- the folder name is the one the web page suggests

def test_the_extension_folder_name_is_the_one_the_web_page_suggests():
    js = (ROOT / "extension/lib/setup-flow.js").read_text(encoding="utf-8")
    assert f'FOLDER_NAME = "{EXTENSION_FOLDER}"' in js


# ---------------------------------------------------------------- tools

def win_net(exe_body=b"MZ yt-dlp", good_sum=True):
    digest = hashlib.sha256(exe_body).hexdigest() if good_sum else "0" * 64
    return Net({
        "yt-dlp.exe": exe_body,
        "SHA2-256SUMS": f"{digest}  yt-dlp.exe\n".encode(),
        "deno-x86_64-pc-windows-msvc.zip": zip_bytes({"deno.exe": "deno"}),
        "ffmpeg-master-latest-win64-gpl.zip": zip_bytes({"ffmpeg-x/bin/ffmpeg.exe": "ffmpeg", "ffmpeg-x/bin/ffplay.exe": "no"}),
    })


def test_windows_tools_are_downloaded_checked_and_put_in_bin(tmp_path):
    net = win_net()
    done = setup.ensure_tools(tmp_path, "win32", run=runs_ok(), fetch_file=net.file, fetch_text=net.text)
    assert sorted(done) == ["Deno", "ffmpeg", "yt-dlp"]
    assert (tmp_path / "bin/yt-dlp.exe").read_bytes() == b"MZ yt-dlp"
    assert (tmp_path / "bin/deno.exe").read_text() == "deno"
    assert (tmp_path / "bin/ffmpeg.exe").read_text() == "ffmpeg"
    assert not (tmp_path / "bin/ffplay.exe").exists()


def test_a_yt_dlp_download_with_the_wrong_checksum_is_rejected_and_not_left_behind(tmp_path):
    net = win_net(good_sum=False)
    with pytest.raises(SetupError, match="校驗碼不符"):
        setup.ensure_tools(tmp_path, "win32", run=runs_ok({"yt-dlp.exe": 127}), fetch_file=net.file, fetch_text=net.text)
    assert not (tmp_path / "bin/yt-dlp.exe").exists()


def test_parts_that_already_run_are_left_alone(tmp_path):
    (tmp_path / "bin").mkdir()
    for name in ("yt-dlp.exe", "deno.exe", "ffmpeg.exe"):
        (tmp_path / "bin" / name).write_text("works")
    net = win_net()
    done = setup.ensure_tools(tmp_path, "win32", run=runs_ok(), fetch_file=net.file, fetch_text=net.text)
    assert done == [] and net.asked == []


def test_a_part_that_exists_but_does_not_run_is_replaced(tmp_path):
    (tmp_path / "bin").mkdir()
    (tmp_path / "bin/deno.exe").write_text("broken")
    net = win_net()
    done = setup.ensure_tools(tmp_path, "win32", run=runs_ok({"deno.exe": 3}), fetch_file=net.file, fetch_text=net.text)
    assert "Deno" in done
    assert (tmp_path / "bin/deno.exe").read_text() == "deno"


def mac_net():
    return Net({
        "deno-aarch64-apple-darwin.zip": zip_bytes({"deno": "deno-arm"}),
        "deno-x86_64-apple-darwin.zip": zip_bytes({"deno": "deno-x64"}),
        "evermeet.cx/ffmpeg": zip_bytes({"ffmpeg": "ffmpeg-mac"}),
    })


@pytest.mark.parametrize("machine, body", [("arm64", "deno-arm"), ("x86_64", "deno-x64")])
def test_mac_tools_use_the_unpacked_engine_and_the_deno_for_this_chip(tmp_path, machine, body):
    net = mac_net()
    engines = []
    done = setup.ensure_tools(tmp_path, "darwin", run=runs_ok({"deno": 127, "ffmpeg": 127, "yt-dlp": 127}),
                              fetch_file=net.file, fetch_text=net.text, machine=machine, which=lambda name: None,
                              install_engine=lambda bin_dir: engines.append(Path(bin_dir)) or "2099.01.01")
    assert engines == [tmp_path / "bin"]
    assert sorted(done) == ["Deno", "ffmpeg", "yt-dlp"]
    assert (tmp_path / "bin/deno").read_text() == body
    assert os.access(tmp_path / "bin/deno", os.X_OK) and os.access(tmp_path / "bin/ffmpeg", os.X_OK)


def test_mac_uses_the_ffmpeg_that_is_already_on_the_computer(tmp_path):
    system_ffmpeg = tmp_path / "usr/ffmpeg"
    system_ffmpeg.parent.mkdir()
    system_ffmpeg.write_text("#!/bin/sh\necho ffmpeg\n")
    net = mac_net()
    setup.ensure_tools(tmp_path / "home", "darwin", run=runs_ok({"ffmpeg": 127 if not (tmp_path / "home/bin/ffmpeg").exists() else 0}),
                       fetch_file=net.file, fetch_text=net.text, machine="arm64", which=lambda name: str(system_ffmpeg),
                       install_engine=lambda bin_dir: "1")
    assert (tmp_path / "home/bin/ffmpeg").is_symlink()
    assert not any("evermeet" in url for url in net.asked)


# ---------------------------------------------------------------- registering with Chrome

def test_mac_registration_writes_a_launcher_and_the_chrome_manifest(tmp_path):
    manifest_path = tmp_path / "nm/host.json"
    result = setup.register(tmp_path / "app", "darwin", EXT_ID, python="/usr/bin/python3", manifest_path=manifest_path)
    launcher = tmp_path / "app/host.sh"
    assert result == manifest_path
    text = launcher.read_text()
    assert text.startswith("#!/bin/bash") and f'YTDL_HOME="{tmp_path / "app"}"' in text and "host/host.py" in text
    assert os.access(launcher, os.X_OK)
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert data["path"] == str(launcher) and data["name"] == setup.HOST_NAME
    assert data["allowed_origins"] == [f"chrome-extension://{EXT_ID}/"]


def test_the_launcher_falls_back_to_another_python_when_the_recorded_one_is_gone(tmp_path):
    setup.register(tmp_path / "app", "darwin", EXT_ID, python=str(tmp_path / "gone/python3"), manifest_path=tmp_path / "m.json")
    (tmp_path / "app/host").mkdir()
    (tmp_path / "app/host/host.py").write_text("import sys; print('hello from', sys.argv[0])\n")
    out = subprocess.run(["bash", str(tmp_path / "app/host.sh")], capture_output=True, text=True)
    assert out.returncode == 0 and "hello from" in out.stdout


def test_windows_registration_writes_a_relative_launcher_and_the_registry_entry(tmp_path):
    keys = []
    result = setup.register(tmp_path, "win32", EXT_ID, set_registry=lambda key, value: keys.append((key, value)))
    assert result == tmp_path / f"{setup.HOST_NAME}.json"
    launcher = (tmp_path / "host.cmd").read_text()
    assert "%~dp0python\\python.exe" in launcher and "%~dp0host\\host.py" in launcher and "YTDL_HOME=%~dp0" in launcher
    assert launcher.isascii()
    data = json.loads(result.read_text(encoding="utf-8"))
    assert data["path"] == str(tmp_path / "host.cmd")
    assert keys == [(rf"Software\Google\Chrome\NativeMessagingHosts\{setup.HOST_NAME}", str(result))]


# ---------------------------------------------------------------- the extension folder

EXT_FILES = {"manifest.json": json.dumps({"name": "YouTube 批量下載器", "version": "1.0"}), "background.js": "// bg", "lib/a.js": "// a"}


def test_the_extension_is_written_into_a_new_folder_inside_the_chosen_one(tmp_path):
    z = tmp_path / "ext.zip"
    z.write_bytes(zip_bytes(EXT_FILES))
    result = setup.deploy_extension(z, tmp_path / "chosen", expected_name="YouTube 批量下載器")
    assert result.path == tmp_path / "chosen" / EXTENSION_FOLDER and result.created is True and result.count == 3
    assert (result.path / "lib/a.js").read_text() == "// a"


def test_installing_again_updates_the_same_folder_in_place(tmp_path):
    z = tmp_path / "ext.zip"
    z.write_bytes(zip_bytes(EXT_FILES))
    first = setup.deploy_extension(z, tmp_path, expected_name="YouTube 批量下載器")
    (first.path / "background.js").write_text("// old")
    again = setup.deploy_extension(z, tmp_path, expected_name="YouTube 批量下載器")
    assert again.path == first.path and again.created is False
    assert (again.path / "background.js").read_text() == "// bg"


def test_a_chosen_folder_that_already_is_the_extension_gets_the_files_directly(tmp_path):
    z = tmp_path / "ext.zip"
    z.write_bytes(zip_bytes(EXT_FILES))
    here = tmp_path / "mine"
    here.mkdir()
    (here / "manifest.json").write_text(EXT_FILES["manifest.json"])
    result = setup.deploy_extension(z, here, expected_name="YouTube 批量下載器")
    assert result.path == here and not (here / EXTENSION_FOLDER).exists()


def test_somebody_elses_folder_of_that_name_is_never_written_into(tmp_path):
    z = tmp_path / "ext.zip"
    z.write_bytes(zip_bytes(EXT_FILES))
    other = tmp_path / EXTENSION_FOLDER
    other.mkdir()
    (other / "photo.jpg").write_text("keep")
    with pytest.raises(SetupError, match="已經有一個叫"):
        setup.deploy_extension(z, tmp_path, expected_name="YouTube 批量下載器")
    assert sorted(p.name for p in other.iterdir()) == ["photo.jpg"]


def test_the_manifest_is_written_last_so_a_half_written_folder_is_not_loadable(tmp_path):
    z = tmp_path / "ext.zip"
    z.write_bytes(zip_bytes(EXT_FILES))
    order = []
    setup.deploy_extension(z, tmp_path, expected_name="YouTube 批量下載器", on_write=order.append)
    assert order[-1] == "manifest.json" and set(order) == set(EXT_FILES)


@pytest.mark.parametrize("bad", ["../evil.js", "/abs.js", "a/../../b.js", "C:/x.js", "a\\b.js"])
def test_a_package_with_an_unsafe_path_is_refused_before_anything_is_written(tmp_path, bad):
    z = tmp_path / "ext.zip"
    z.write_bytes(zip_bytes({**EXT_FILES, bad: "x"}))
    with pytest.raises(SetupError, match="不安全"):
        setup.deploy_extension(z, tmp_path / "chosen", expected_name="YouTube 批量下載器")
    assert not (tmp_path / "chosen").exists()


def test_a_package_without_the_expected_manifest_is_refused(tmp_path):
    z = tmp_path / "ext.zip"
    z.write_bytes(zip_bytes({"background.js": "x"}))
    with pytest.raises(SetupError, match="manifest"):
        setup.deploy_extension(z, tmp_path, expected_name="YouTube 批量下載器")


# ---------------------------------------------------------------- what was installed where

def test_the_install_record_remembers_the_extension_folder(tmp_path):
    assert setup.read_record(tmp_path) == {}
    setup.write_record(tmp_path, extension_folder=tmp_path / "ext", version="1.2.3")
    record = setup.read_record(tmp_path)
    assert record["extensionFolder"] == str(tmp_path / "ext") and record["version"] == "1.2.3"


def test_a_broken_record_reads_as_empty(tmp_path):
    (tmp_path / "install.json").write_text("{not json")
    assert setup.read_record(tmp_path) == {}


def test_the_recorded_folder_is_reused_only_while_it_is_still_the_extension(tmp_path):
    ext = tmp_path / "ext"
    ext.mkdir()
    setup.write_record(tmp_path, extension_folder=ext, version="1")
    assert setup.recorded_extension_folder(tmp_path, "YouTube 批量下載器") is None  # no manifest in it any more
    (ext / "manifest.json").write_text(EXT_FILES["manifest.json"])
    assert setup.recorded_extension_folder(tmp_path, "YouTube 批量下載器") == ext


# ---------------------------------------------------------------- the self test (what Chrome would do, minus Chrome)

def test_the_self_test_starts_the_launcher_and_reads_the_hosts_ready_message(tmp_path):
    home = tmp_path / "home"
    (home / "bin").mkdir(parents=True)
    stub = home / "bin/yt-dlp"
    stub.write_text((ROOT / "host/tests/stub_ytdlp.py").read_text())
    stub.chmod(0o755)
    launcher = tmp_path / "launch.sh"
    launcher.write_text(f'#!/bin/sh\nexport YTDL_HOME="{home}"\nexec "{sys.executable}" "{ROOT / "host/host.py"}"\n')
    launcher.chmod(0o755)
    ready = setup.selftest(launcher)
    assert ready["type"] == "ready" and ready["ytdlpVersion"]


def test_a_launcher_that_dies_is_reported_with_what_it_said(tmp_path):
    launcher = tmp_path / "launch.sh"
    launcher.write_text("#!/bin/sh\necho 'no python here' >&2\nexit 3\n")
    launcher.chmod(0o755)
    with pytest.raises(SetupError, match="no python here"):
        setup.selftest(launcher)


def test_a_launcher_that_says_nothing_times_out_with_a_clear_message(tmp_path):
    launcher = tmp_path / "launch.sh"
    launcher.write_text("#!/bin/sh\nsleep 30\n")
    launcher.chmod(0o755)
    with pytest.raises(SetupError, match="沒有回應"):
        setup.selftest(launcher, timeout=1)


# ---------------------------------------------------------------- dialogs and what to do next

def test_the_mac_folder_dialog_returns_the_chosen_path():
    seen = []
    def run(cmd):
        seen.append(cmd)
        return 0, "/Users/me/Projects/\n", ""
    assert setup.choose_parent("darwin", run) == Path("/Users/me/Projects")
    assert seen[0][0] == "osascript" and "choose folder" in " ".join(seen[0])


def test_cancelling_the_dialog_or_having_none_means_no_choice():
    assert setup.choose_parent("darwin", lambda cmd: (1, "", "User canceled. (-128)")) is None
    assert setup.choose_parent("win32", lambda cmd: (0, "\n", "")) is None
    assert setup.choose_parent("win32", lambda cmd: (127, "", "no powershell")) is None
    assert setup.choose_parent("linux", lambda cmd: (0, "/x", "")) is None


def test_the_windows_folder_dialog_is_a_powershell_folder_browser():
    seen = []
    def run(cmd):
        seen.append(cmd)
        return 0, "C:\\Users\\me\\Videos\r\n", ""
    assert setup.choose_parent("win32", run) == Path("C:\\Users\\me\\Videos")
    assert seen[0][0] == "powershell" and "FolderBrowserDialog" in " ".join(seen[0])


def test_what_to_do_next_opens_the_folder_and_chrome_s_extension_page():
    seen = []
    setup.open_next_steps("darwin", Path("/Users/me/YT批量下載器"), lambda cmd: seen.append(cmd) or (0, "", ""))
    assert ["open", "/Users/me/YT批量下載器"] in seen
    assert any("chrome://extensions" in " ".join(cmd) for cmd in seen)
    seen.clear()
    setup.open_next_steps("win32", Path("C:/x/YT批量下載器"), lambda cmd: seen.append(cmd) or (0, "", ""))
    assert any(cmd[0] == "explorer" for cmd in seen) and any("chrome://extensions" in " ".join(cmd) for cmd in seen)


def test_failing_to_open_things_never_fails_the_install():
    setup.open_next_steps("darwin", Path("/x"), lambda cmd: (127, "", "nope"))


# ---------------------------------------------------------------- the whole run

def fake_parts(tmp_path, **overrides):
    calls = []
    parts = {
        "tools": lambda home, platform: calls.append("tools") or ["yt-dlp"],
        "register": lambda home, platform, ext_id: calls.append("register") or (tmp_path / "m.json"),
        "deploy": lambda parent: calls.append(f"deploy:{parent}") or setup.Deployed(tmp_path / "ext", True, 3),
        "selftest": lambda home, platform: calls.append("selftest") or {"type": "ready"},
        "report": lambda home, ext_id, manifest: calls.append("report") or [],
        "open": lambda folder: calls.append("open"),
        "choose": lambda: calls.append("choose") or tmp_path / "picked",
    }
    parts.update(overrides)
    return calls, parts


def test_a_first_install_asks_where_then_does_everything_in_order(tmp_path, capsys):
    calls, parts = fake_parts(tmp_path)
    code = setup.run_setup(tmp_path / "home", "darwin", EXT_ID, parts=parts)
    assert code == 0
    assert calls == ["tools", "register", "choose", f"deploy:{tmp_path / 'picked'}", "selftest", "report", "open"]
    assert setup.read_record(tmp_path / "home")["extensionFolder"] == str(tmp_path / "ext")
    assert "安裝完成" in capsys.readouterr().out


def test_installing_again_repairs_in_place_without_asking_or_opening_anything(tmp_path, capsys):
    home = tmp_path / "home"
    ext = tmp_path / "ext"
    ext.mkdir()
    (ext / "manifest.json").write_text(EXT_FILES["manifest.json"])
    setup.write_record(home, extension_folder=ext, version="1")
    calls, parts = fake_parts(tmp_path, deploy=lambda parent: calls.append(f"deploy:{parent}") or setup.Deployed(ext, False, 3))
    assert setup.run_setup(home, "darwin", EXT_ID, parts=parts) == 0
    assert "choose" not in calls and "open" not in calls
    assert calls[:3] == ["tools", "register", f"deploy:{ext}"]


def test_a_parent_given_on_the_command_line_skips_the_dialog(tmp_path):
    calls, parts = fake_parts(tmp_path)
    assert setup.run_setup(tmp_path / "home", "darwin", EXT_ID, parent=tmp_path / "given", parts=parts) == 0
    assert "choose" not in calls and f"deploy:{tmp_path / 'given'}" in calls


def test_no_choice_in_the_dialog_uses_the_home_folder(tmp_path):
    calls, parts = fake_parts(tmp_path, choose=lambda: None)
    assert setup.run_setup(tmp_path / "home", "darwin", EXT_ID, parts=parts) == 0
    assert f"deploy:{Path.home()}" in calls


def test_a_step_that_fails_stops_with_its_message_and_a_failure_exit_code(tmp_path, capsys):
    def boom(home, platform):
        raise SetupError("yt-dlp 下載失敗（網路連線失敗？）")
    calls, parts = fake_parts(tmp_path, tools=boom)
    assert setup.run_setup(tmp_path / "home", "darwin", EXT_ID, parts=parts) == 1
    out = capsys.readouterr().out
    assert "安裝失敗" in out and "yt-dlp 下載失敗" in out and "安裝完成" not in out
    assert "register" not in calls


def test_problems_in_the_final_report_mean_not_done(tmp_path, capsys):
    bad = setup.doctor.Check("ffmpeg", "error", "ffmpeg 無法執行", "x", "→ fix")
    calls, parts = fake_parts(tmp_path, report=lambda home, ext_id, manifest: [bad])
    assert setup.run_setup(tmp_path / "home", "darwin", EXT_ID, parts=parts) == 1
    out = capsys.readouterr().out
    assert "✘" in out and "安裝尚未完成" in out and "安裝完成！" not in out


# ---------------------------------------------------------------- found in review: re-runs, failures, Windows

def test_a_half_written_folder_from_an_interrupted_install_is_finished_not_refused(tmp_path):
    z = tmp_path / "ext.zip"
    z.write_bytes(zip_bytes(EXT_FILES))
    target = tmp_path / EXTENSION_FOLDER
    (target / "lib").mkdir(parents=True)
    (target / "background.js").write_text("// half")           # our file, no manifest yet
    (target / "lib/a.js.part").write_text("partial")            # what an interrupted write leaves
    result = setup.deploy_extension(z, tmp_path, expected_name="YouTube 批量下載器")
    assert result.path == target and (target / "manifest.json").is_file() and (target / "background.js").read_text() == "// bg"
    assert not list(target.rglob("*.part")), "leftovers of the interrupted write are removed"


def test_an_old_single_file_yt_dlp_on_a_mac_is_replaced_even_though_it_runs(tmp_path):
    (tmp_path / "bin").mkdir()
    (tmp_path / "bin/yt-dlp").write_bytes(b"\xcf\xfa\xed\xfe" + b"\0" * 8)  # a compiled Mac program: Chrome cannot start it
    net = mac_net()
    engines = []
    setup.ensure_tools(tmp_path, "darwin", run=runs_ok(), fetch_file=net.file, fetch_text=net.text, machine="arm64", which=lambda n: None,
                       install_engine=lambda bin_dir: engines.append(bin_dir) or "1")
    assert engines == [tmp_path / "bin"]


def test_a_failed_first_run_does_not_make_the_next_one_skip_the_load_steps(tmp_path, capsys):
    home = tmp_path / "home"
    calls, parts = fake_parts(tmp_path, deploy=lambda parent: setup.Deployed(tmp_path / "ext", False, 3),
                              report=lambda *a: [setup.doctor.Check("ffmpeg", "error", "ffmpeg 無法執行")])
    assert setup.run_setup(home, "darwin", EXT_ID, parts=parts) == 1
    assert setup.read_record(home) == {}, "nothing is recorded until the whole run worked"
    calls2, parts2 = fake_parts(tmp_path, deploy=lambda parent: setup.Deployed(tmp_path / "ext", False, 3))
    assert setup.run_setup(home, "darwin", EXT_ID, parts=parts2) == 0
    assert "open" in calls2, "the person is still shown the folder and Chrome's extensions page"
    assert "載入未封裝項目" in capsys.readouterr().out


@pytest.mark.parametrize("error", [PermissionError("拒絕存取"), NotADirectoryError("not a directory"), subprocess.TimeoutExpired("curl", 5), ValueError("odd")])
def test_failures_that_are_not_ours_still_end_in_the_failure_message_not_a_traceback(tmp_path, capsys, error):
    def boom(home, platform):
        raise error
    calls, parts = fake_parts(tmp_path, tools=boom)
    assert setup.run_setup(tmp_path / "home", "darwin", EXT_ID, parts=parts) == 1
    out = capsys.readouterr().out
    assert "安裝失敗" in out and "截圖" in out


def test_a_download_falls_back_to_urllib_when_curl_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(setup, "_curl_download", lambda url, dest: False)

    class Response:
        def __init__(self): self.data = io.BytesIO(b"payload")
        def read(self, n=-1): return self.data.read(n)
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(setup.urllib.request, "urlopen", lambda url, timeout=0: Response())
    dest = tmp_path / "f"
    setup.fetch_file("https://example.com/f", dest)
    assert dest.read_bytes() == b"payload"


def test_a_byte_order_mark_in_the_dialog_answer_is_ignored():
    assert setup.choose_parent("win32", lambda cmd: (0, "\ufeffC:\\Users\\me\\Videos\r\n", "")) == Path("C:\\Users\\me\\Videos")


def test_the_windows_yt_dlp_is_started_once_right_after_the_download(tmp_path):
    net = win_net()
    seen = []
    def run(cmd):
        seen.append(Path(cmd[0]).name)
        return 0, "ok", ""
    setup.ensure_tools(tmp_path, "win32", run=lambda cmd: (127, "", "") if not (tmp_path / "bin/yt-dlp.exe").exists() and "yt-dlp.exe" in cmd[0] else run(cmd),
                       fetch_file=net.file, fetch_text=net.text)
    assert "yt-dlp.exe" in seen, "its first (slow, antivirus-scanned) start happens here, not inside the self test"


def test_a_downloaded_yt_dlp_that_cannot_start_is_reported_with_the_likely_cause(tmp_path):
    net = win_net()
    with pytest.raises(SetupError, match="防毒"):
        setup.ensure_tools(tmp_path, "win32", run=runs_ok({"yt-dlp.exe": 127, "deno.exe": 127, "ffmpeg.exe": 127}), fetch_file=net.file, fetch_text=net.text)
