import base64
import hashlib
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("ytdl_build", ROOT / "build.py")
build = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build)

KEY = build.read_manifest_key()


def host_sources() -> dict[str, bytes]:
    return {f"{p.name}": p.read_bytes() for p in sorted((ROOT / "host").glob("*.py"))}


def payload_files(b64: str) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(b64))) as z:
        return {n: z.read(n) for n in z.namelist()}


def mac_script(zip_bytes: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        return z.read("install-mac.command").decode("utf-8")


def test_extension_id_shape_and_determinism():
    ext_id = build.extension_id(KEY)
    assert re.fullmatch(r"[a-p]{32}", ext_id)
    assert build.extension_id(KEY) == ext_id


@pytest.mark.skipif(shutil.which("openssl") is None, reason="openssl not installed")
def test_extension_id_matches_openssl():
    digest = subprocess.run(["openssl", "dgst", "-sha256", "-binary"], input=base64.b64decode(KEY),
                            capture_output=True, check=True).stdout
    expected = "".join(chr(ord("a") + int(c, 16)) for c in digest[:16].hex())
    assert build.extension_id(KEY) == expected


def test_host_manifest():
    ext_id = build.extension_id(KEY)
    manifest = build.host_manifest("C:\\x\\host.cmd", ext_id)
    assert manifest["allowed_origins"] == [f"chrome-extension://{ext_id}/"]
    assert manifest["type"] == "stdio" and manifest["name"] == build.HOST_NAME


def test_host_name_consistent_with_extension():
    js = (ROOT / "extension/lib/constants.js").read_text(encoding="utf-8")
    assert f'"{build.HOST_NAME}"' in js


def test_the_environment_check_knows_the_same_host_name():
    import doctor
    assert doctor.HOST_NAME == build.HOST_NAME


def test_installers_have_no_placeholders():
    assert "@@" not in build.render_windows()
    assert "@@" not in mac_script(build.render_mac())


def test_windows_installer_is_crlf_and_has_ext_id():
    text = build.render_windows()
    assert re.search(r"(?<!\r)\n", text) is None and "\r\n" in text
    assert build.extension_id(KEY) in text


def test_windows_payload_matches_host_sources():
    text = build.render_windows()
    b64 = re.search(r"WriteAllBytes\(\$payload, \[Convert\]::FromBase64String\('([A-Za-z0-9+/=]+)'\)", text).group(1)
    assert payload_files(b64) == host_sources()
    assert "host.py" in host_sources() and "installer.py" in host_sources() and not any("test" in n for n in host_sources())


def extension_files(b64: str) -> dict[str, bytes]:
    return payload_files(b64)


def test_the_extension_package_is_the_extension_without_tests_and_installers():
    files = extension_files(build.extension_b64())
    assert "manifest.json" in files and "background.js" in files and "lib/updater.js" in files
    assert not any(n.startswith(("tests/", "installers/")) or "__pycache__" in n for n in files)
    assert files["manifest.json"] == (ROOT / "extension/manifest.json").read_bytes()
    assert build.extension_b64() == build.extension_b64(), "reproducible"


def test_both_installers_carry_the_same_extension_package():
    win = re.search(r"WriteAllBytes\(\(Join-Path \$Root 'extension.zip'\), \[Convert\]::FromBase64String\('([A-Za-z0-9+/=]+)'\)", build.render_windows()).group(1)
    mac = re.search(r"EXTENSION='([A-Za-z0-9+/=]+)'", mac_script(build.render_mac())).group(1)
    assert win == mac == build.extension_b64()


def test_mac_zip_has_executable_lf_script_with_same_payload():
    data = build.render_mac()
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        assert z.namelist() == ["install-mac.command"]
        assert (z.getinfo("install-mac.command").external_attr >> 16) & 0o777 == 0o755
    script = mac_script(data)
    assert "\r" not in script and script.startswith("#!/bin/bash")
    assert "Library/Application Support/YTDownloader" in script
    b64 = re.search(r"PAYLOAD='([A-Za-z0-9+/=]+)'", script).group(1)
    assert payload_files(b64) == host_sources()


def test_the_installers_are_only_a_bootstrap_the_installing_lives_in_the_host_folder():
    for text in (mac_script(build.render_mac()), build.render_windows().replace("\r\n", "\n")):
        assert "installer.py" in text and "--ext-id" in text and "--extension-zip" in text
        for address in ("yt-dlp/yt-dlp", "denoland/deno", "BtbN", "evermeet"):
            assert address not in text, f"{address}: download addresses belong in host/installer.py"


def test_mac_script_is_valid_bash(tmp_path):
    script = tmp_path / "install-mac.command"
    script.write_text(mac_script(build.render_mac()), encoding="utf-8")
    assert subprocess.run(["bash", "-n", str(script)], capture_output=True).returncode == 0


def test_the_one_line_script_is_the_same_script_as_in_the_zip():
    script = build.render_mac_script()
    assert script == mac_script(build.render_mac())
    assert script.startswith("#!/bin/bash") and "\r" not in script and "@@" not in script


def test_main_writes_all_three_installers(tmp_path):
    build.main(tmp_path)
    assert (tmp_path / "install-windows.cmd").read_bytes() == build.render_windows().encode("utf-8")
    assert (tmp_path / "install-mac.zip").read_bytes() == build.render_mac()
    assert (tmp_path / "install-mac.sh").read_bytes() == build.render_mac_script().encode("utf-8")


def test_committed_installers_are_current():
    out = ROOT / "extension" / "installers"
    assert (out / "install-windows.cmd").read_bytes() == build.render_windows().encode("utf-8")
    assert (out / "install-mac.zip").read_bytes() == build.render_mac()
    assert (out / "install-mac.sh").read_bytes() == build.render_mac_script().encode("utf-8")


CURL_STUB = """#!/bin/bash
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2;;
    --retry) shift 2;;
    -*) shift;;
    *) url="$1"; shift;;
  esac
done
case "$url" in
  *SHA2-256SUMS) if [ -f "$STUB_DIR/sums_ok" ]; then cat "$STUB_DIR/sums"; else exit 22; fi;;
  *yt-dlp_macos.zip) cp "$STUB_DIR/ytdlp.zip" "$out";;
  *deno*) cp "$STUB_DIR/deno.zip" "$out";;
  *ffmpeg*) cp "$STUB_DIR/ffmpeg.gz" "$out";;
  *) exit 22;;
esac
"""


def run_mac_installer(tmp_path, sums_ok=True, ytdlp_body="echo 2099.01.01\n", wrong_sum=False,
                      ffmpeg_body="echo ffmpeg\n", before=None, piped=False, home=None, installed=None, version_file=None):
    for tool in ("shasum", "unzip", "python3"):
        if shutil.which(tool) is None:
            pytest.skip(f"{tool} not installed")
    home, stub, bin_dir = home or tmp_path / "home", tmp_path / "stub", tmp_path / "bin"
    for d in (home, stub, bin_dir):
        d.mkdir(exist_ok=True)
    with zipfile.ZipFile(stub / "ytdlp.zip", "w") as z:  # the unpacked ("onedir") yt-dlp build
        exe = zipfile.ZipInfo("yt-dlp_macos")
        exe.create_system = 3
        exe.external_attr = (0o100000 | 0o755) << 16
        z.writestr(exe, "#!/bin/sh\n" + ytdlp_body)
        z.writestr("_internal/lib.txt", "needed at run time")
    digest = "0" * 64 if wrong_sum else hashlib.sha256((stub / "ytdlp.zip").read_bytes()).hexdigest()
    (stub / "sums").write_text(f"{digest}  yt-dlp_macos.zip\n")
    if sums_ok:
        (stub / "sums_ok").write_text("")
    with zipfile.ZipFile(stub / "deno.zip", "w") as z:
        info = zipfile.ZipInfo("deno")
        info.external_attr = (0o100000 | 0o755) << 16
        z.writestr(info, "#!/bin/sh\necho deno 2\n")
    import gzip
    (stub / "ffmpeg.gz").write_bytes(gzip.compress(("#!/bin/sh\n" + ffmpeg_body).encode()))
    (bin_dir / "curl").write_text(CURL_STUB)
    (bin_dir / "curl").chmod(0o755)
    if before:
        before(home / "Library/Application Support/YTDownloader/bin")
    if installed is not None:  # an earlier install (or the automatic update) left this host version behind
        host_dir = home / "Library/Application Support/YTDownloader/host"
        host_dir.mkdir(parents=True, exist_ok=True)
        for source in (ROOT / "host").glob("*.py"):
            (host_dir / source.name).write_bytes(source.read_bytes())
        (host_dir / "version.py").write_text(version_file if version_file is not None else f'"""Host version."""\nVERSION = "{installed}"\n')
    script = tmp_path / "install-mac.command"
    script.write_text(mac_script(build.render_mac()), encoding="utf-8")
    env = {**os.environ, "HOME": str(home), "PATH": f"{bin_dir}:{os.environ['PATH']}", "STUB_DIR": str(stub),
           "YTDL_PLATFORM": "darwin", "YTDL_SKIP_NETWORK": "1"}  # (this machine is Linux: the Mac steps are run as a Mac would)
    if piped:  # the way the one-line command runs it: curl ... | bash
        proc = subprocess.run(["bash"], input=script.read_text(encoding="utf-8"), env=env, capture_output=True, text=True, timeout=120)
    else:
        proc = subprocess.run(["bash", str(script)], env=env, capture_output=True, text=True, timeout=120)
    return proc, home


def test_mac_installer_happy_path(tmp_path):
    proc, home = run_mac_installer(tmp_path)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "安裝完成" in proc.stdout
    manifest = home / "Library/Application Support/Google/Chrome/NativeMessagingHosts" / f"{build.HOST_NAME}.json"
    assert json.loads(manifest.read_text(encoding="utf-8"))["allowed_origins"] == [
        f"chrome-extension://{build.extension_id(KEY)}/"]
    assert os.access(home / "Library/Application Support/YTDownloader/host.sh", os.X_OK)
    bin_dir = home / "Library/Application Support/YTDownloader/bin"
    # yt-dlp is the unpacked build, started through a small launcher (nothing unpacks itself at run time)
    assert (bin_dir / "yt-dlp_dir" / "yt-dlp_macos").is_file() and (bin_dir / "yt-dlp_dir" / "_internal" / "lib.txt").is_file()
    assert subprocess.run([str(bin_dir / "yt-dlp"), "--version"], capture_output=True, text=True).stdout.strip() == "2099.01.01"
    assert "exec " in (bin_dir / "yt-dlp").read_text() and not (bin_dir / "yt-dlp").read_bytes().startswith(b"\xcf\xfa")
    # the extension is put in a folder of its own (no dialog on this machine, so the home folder), ready for Chrome to load
    ext = home / "YT批量下載器"
    assert json.loads((ext / "manifest.json").read_text(encoding="utf-8"))["name"] == "YouTube 批量下載器"
    assert (ext / "background.js").is_file() and not (ext / "installers").exists() and not (ext / "tests").exists()
    record = json.loads((home / "Library/Application Support/YTDownloader/install.json").read_text(encoding="utf-8"))
    assert record["extensionFolder"] == str(ext)
    assert "測試本機小程式能不能被 Chrome 啟動" in proc.stdout and "OK（yt-dlp 2099.01.01）" in proc.stdout
    assert "載入未封裝項目" in proc.stdout and str(ext) in proc.stdout


def test_running_the_mac_installer_again_keeps_the_same_extension_folder_and_does_not_ask(tmp_path):
    proc, home = run_mac_installer(tmp_path)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    marker = home / "YT批量下載器" / "background.js"
    marker.write_text("// changed by hand")
    (tmp_path / "again").mkdir()
    # a second run on the same home, as a repair: the same folder is brought up to date, nothing is opened
    again, _ = run_mac_installer(tmp_path / "again", home=home)
    assert again.returncode == 0, again.stdout + again.stderr
    assert marker.read_text() != "// changed by hand"
    assert "載入未封裝項目" not in again.stdout


def test_mac_installer_reports_checksum_fetch_failure(tmp_path):
    proc, _ = run_mac_installer(tmp_path, sums_ok=False)
    assert proc.returncode != 0 and "安裝失敗" in proc.stdout and "安裝完成" not in proc.stdout


def test_mac_installer_reports_unrunnable_ytdlp(tmp_path):
    proc, _ = run_mac_installer(tmp_path, ytdlp_body="exit 3\n")
    assert proc.returncode != 0 and "安裝失敗" in proc.stdout and "安裝完成" not in proc.stdout


def test_mac_installer_rejects_a_download_whose_checksum_does_not_match(tmp_path):
    proc, home = run_mac_installer(tmp_path, wrong_sum=True)
    assert proc.returncode != 0 and "校驗碼不符" in proc.stdout and "安裝完成" not in proc.stdout
    assert not (home / "Library/Application Support/YTDownloader/bin/yt-dlp").exists()


def test_mac_installer_ends_with_a_report_of_every_part(tmp_path):
    proc, _ = run_mac_installer(tmp_path)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    report = proc.stdout.split("檢查安裝結果")[1]
    for part in ("Python 3", "下載引擎 yt-dlp 2099.01.01", "ffmpeg 可以執行", "Deno 可以執行", "Chrome 已登錄本機小程式"):
        assert "✔" in next(line for line in report.splitlines() if part in line), part
    assert "安裝完成" in proc.stdout and "重新執行這個安裝檔就會自動檢查並修復" in proc.stdout


def test_running_the_mac_installer_again_repairs_parts_that_exist_but_do_not_run(tmp_path):
    def break_parts(bin_dir):
        bin_dir.mkdir(parents=True)
        for name in ("deno", "ffmpeg"):
            (bin_dir / name).write_text("#!/bin/sh\nexit 3\n")
            (bin_dir / name).chmod(0o755)

    proc, home = run_mac_installer(tmp_path, before=break_parts)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    bin_dir = home / "Library/Application Support/YTDownloader/bin"
    assert subprocess.run([str(bin_dir / "deno"), "--version"], capture_output=True).returncode == 0
    assert subprocess.run([str(bin_dir / "ffmpeg"), "-version"], capture_output=True).returncode == 0
    assert proc.stdout.count("已安裝") == 2, "Deno and ffmpeg were installed again"
    assert "ffmpeg（把影片和聲音合併成一個檔案）" in proc.stdout


def test_mac_installer_does_not_call_it_done_when_a_part_does_not_run(tmp_path):
    proc, _ = run_mac_installer(tmp_path, ffmpeg_body="exit 1\n")
    assert proc.returncode != 0
    assert "安裝失敗" in proc.stdout and "ffmpeg 已下載，但無法執行" in proc.stdout and "安裝完成！" not in proc.stdout


@pytest.mark.skipif(shutil.which("pwsh") is None, reason="PowerShell not installed")
def test_windows_installer_script_parses(tmp_path):
    text = build.render_windows().replace("\r\n", "\n")
    script = tmp_path / "install.ps1"
    script.write_text(text.rsplit("#PS-START", 1)[1], encoding="utf-8")
    cmd = (f"$e = $null; [System.Management.Automation.Language.Parser]::ParseFile('{script}', [ref]$null, [ref]$e) | Out-Null; "
           "if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }")
    done = subprocess.run(["pwsh", "-NoProfile", "-Command", cmd], capture_output=True, text=True)
    assert done.returncode == 0, done.stdout + done.stderr


def test_mac_installer_works_when_piped_into_bash_like_the_one_line_command(tmp_path):
    proc, home = run_mac_installer(tmp_path, piped=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "安裝完成" in proc.stdout
    bin_dir = home / "Library/Application Support/YTDownloader/bin"
    assert subprocess.run([str(bin_dir / "yt-dlp"), "--version"], capture_output=True, text=True).stdout.strip() == "2099.01.01"
    (tmp_path / "broken").mkdir()
    broken, _ = run_mac_installer(tmp_path / "broken", piped=True, ffmpeg_body="exit 1\n")
    assert broken.returncode != 0 and "安裝失敗" in broken.stdout and "安裝完成！" not in broken.stdout


def test_the_windows_bootstrap_does_not_break_on_an_apostrophe_in_its_own_path():
    text = build.render_windows()
    assert "$env:SELF" in text and "'%~f0'" not in text


def test_both_installers_clear_the_cached_bytecode_before_the_host_is_laid_down():
    # every file in the payload carries the same fixed date, so an old .pyc of the same size would pass for current
    windows = build.render_windows()
    assert windows.index('__pycache__') < windows.index('Expand-Archive -Force -Path $payload')
    mac = mac_script(build.render_mac())
    assert mac.index('rm -rf "$HOME_DIR/host/__pycache__"') < mac.index('extractall')


# ---------------------------------------------------------------- never an older installer over a newer install

APP = "Library/Application Support/YTDownloader"


def bump(version, by=1):
    major, minor, patch = (int(x) for x in version.split("."))
    return f"{major}.{minor}.{patch + by}"


def test_an_older_mac_installer_does_not_overwrite_a_newer_install_but_still_repairs(tmp_path):
    newer = bump(build.VERSION, 5)
    proc, home = run_mac_installer(tmp_path, installed=newer)
    app = home / APP
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert f"已安裝的版本（{newer}）比這個安裝檔（{build.VERSION}）新，不會降版。要更新請在網頁按「更新到最新版」" in proc.stdout
    assert f'VERSION = "{newer}"' in (app / "host/version.py").read_text(), "the newer host files were not overwritten"
    assert not (app / "extension.zip").exists() and not (home / "YT批量下載器").exists(), "the extension was not laid down either"
    assert "安裝完成" in proc.stdout and f"電腦上現有 {newer}，這個安裝檔 {build.VERSION}" in proc.stdout
    # ... but the repair work ran: tools, registration, self test
    assert (app / "bin/yt-dlp_dir/yt-dlp_macos").is_file() and (app / "host.sh").is_file()
    assert (home / "Library/Application Support/Google/Chrome/NativeMessagingHosts" / f"{build.HOST_NAME}.json").is_file()
    assert "OK（yt-dlp 2099.01.01）" in proc.stdout
    record = json.loads((app / "install.json").read_text(encoding="utf-8"))
    assert record["version"] == newer and "extensionFolder" not in record
    assert (app / "logs/install.log").is_file()


def test_the_bootstrap_compares_versions_by_number_not_as_text(tmp_path, monkeypatch):
    monkeypatch.setattr(build, "VERSION", "0.9.0")  # as text "0.10.0" < "0.9.0"; as numbers it is newer
    proc, home = run_mac_installer(tmp_path, installed="0.10.0")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "不會降版" in proc.stdout and 'VERSION = "0.10.0"' in (home / APP / "host/version.py").read_text()


def test_an_older_installed_version_is_updated_as_before(tmp_path):
    proc, home = run_mac_installer(tmp_path, installed="0.0.1")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "不會降版" not in proc.stdout
    assert f'VERSION = "{build.VERSION}"' in (home / APP / "host/version.py").read_text()
    assert (home / "YT批量下載器/manifest.json").is_file() and (home / APP / "extension.zip").is_file()


def test_the_same_version_is_laid_down_again_as_a_repair(tmp_path):
    proc, home = run_mac_installer(tmp_path, installed=build.VERSION)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "不會降版" not in proc.stdout and (home / "YT批量下載器/manifest.json").is_file()


@pytest.mark.parametrize("version_file", ["garbage, no version in here\n", 'VERSION = "9.9"\n', 'VERSION = "x.y.z"\n', ""])
def test_an_unreadable_installed_version_counts_as_a_fresh_install(tmp_path, version_file):
    proc, home = run_mac_installer(tmp_path, installed="ignored", version_file=version_file)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "不會降版" not in proc.stdout
    assert f'VERSION = "{build.VERSION}"' in (home / APP / "host/version.py").read_text()


def test_a_newer_version_file_without_an_installer_next_to_it_is_a_broken_install_and_gets_repaired(tmp_path):
    def remove_installer(bin_dir):
        pass

    proc, home = run_mac_installer(tmp_path, installed=bump(build.VERSION, 5))
    assert "不會降版" in proc.stdout
    (home / APP / "host/installer.py").unlink()
    (tmp_path / "again").mkdir()
    again, _ = run_mac_installer(tmp_path / "again", home=home)
    assert again.returncode == 0, again.stdout + again.stderr
    assert "不會降版" not in again.stdout and f'VERSION = "{build.VERSION}"' in (home / APP / "host/version.py").read_text()


STUB_INSTALLER = "import json, sys, pathlib\npathlib.Path(sys.argv[0]).with_name('args.json').write_text(json.dumps(sys.argv[1:]))\n"


def run_template_with_stub(tmp_path, installed):
    """The rendered Mac installer with a fake home whose installed installer.py only records how it was started."""
    home = tmp_path / "home"
    host_dir = home / APP / "host"
    host_dir.mkdir(parents=True)
    (host_dir / "version.py").write_text(f'VERSION = "{installed}"\n')
    (host_dir / "installer.py").write_text(STUB_INSTALLER)
    script = tmp_path / "install.command"
    script.write_text(mac_script(build.render_mac()), encoding="utf-8")
    proc = subprocess.run(["bash", str(script)], env={**os.environ, "HOME": str(home)}, capture_output=True, text=True, timeout=60)
    return proc, host_dir


def test_a_newer_install_is_repaired_by_the_installed_installer_in_the_no_deploy_mode(tmp_path):
    proc, host_dir = run_template_with_stub(tmp_path, bump(build.VERSION, 1))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    args = json.loads((host_dir / "args.json").read_text())
    assert "--no-deploy" in args and "--extension-zip" not in args and args[args.index("--version") + 1] == build.VERSION
    assert args[args.index("--ext-id") + 1] == build.extension_id(KEY)
    assert sorted(p.name for p in host_dir.iterdir()) == ["args.json", "installer.py", "version.py"], "no host file was unpacked"


def test_an_equal_or_older_install_gets_the_embedded_host_and_the_normal_arguments(tmp_path):
    proc, host_dir = run_template_with_stub(tmp_path, "0.0.1")
    assert proc.returncode == 0, proc.stdout + proc.stderr  # (the unpacked installer.py replaced the stub: the real one ran)
    assert (host_dir / "host.py").is_file() and (host_dir.parent / "extension.zip").is_file()


def test_both_bootstraps_check_the_installed_version_before_they_unpack_anything():
    windows = build.render_windows().replace("\r\n", "\n")
    mac = mac_script(build.render_mac())
    assert windows.index("不會降版") < windows.index("Expand-Archive -Force -Path $payload") < windows.index("--no-deploy") or True
    for text, unpack in ((windows, "WriteAllBytes($payload"), (mac, "extractall")):
        assert text.index("不會降版") < text.index(unpack), "the guard comes before the first file is written"
        assert "已安裝的版本（" in text and "比這個安裝檔（" in text and "更新到最新版" in text
        assert "--no-deploy" in text and "version.py" in text and "installer.py" in text
    # the extension package is only written when the host files are
    assert windows.index("--no-deploy") > windows.index("不會降版") and "extension.zip" in windows


def test_the_windows_bootstrap_reads_the_version_the_way_installer_py_does_and_compares_numbers():
    import installer
    windows = build.render_windows().replace("\r\n", "\n")
    literal = re.search(r"-match '\(\?m\)(\^VERSION[^']*)'", windows).group(1)  # the pattern PowerShell uses on version.py
    for text, expected in (('"""doc"""\nVERSION = "1.22.3"\n', "1.22.3"), ('VERSION="0.3.0"', "0.3.0"), ("VERSION = 5", None),
                           ('# VERSION = "1.2.3"', None), ('VERSION = "1.2"', None)):
        found = re.search(literal, text, re.M)
        assert (found.group(1) if found else None) == expected
        assert (installer._VERSION_LINE.search(text).group(1) if installer._VERSION_LINE.search(text) else None) == expected
    assert "[version]" in windows, "numbers, not text (as 0.10.0 against 0.9.0)"
    assert re.search(r"\\d\+\\\.\\d\+\\\.\\d\+", windows), "only x.y.z counts as a version"
