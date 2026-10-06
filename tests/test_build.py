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
    assert "HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts" in text
    assert build.HOST_NAME in text


def test_windows_payload_matches_host_sources():
    text = build.render_windows()
    b64 = re.search(r"FromBase64String\('([A-Za-z0-9+/=]+)'\)", text).group(1)
    assert payload_files(b64) == host_sources()
    assert "host.py" in host_sources() and not any("test" in n for n in host_sources())


def test_mac_zip_has_executable_lf_script_with_same_payload():
    data = build.render_mac()
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        assert z.namelist() == ["install-mac.command"]
        assert (z.getinfo("install-mac.command").external_attr >> 16) & 0o777 == 0o755
    script = mac_script(data)
    assert "\r" not in script and script.startswith("#!/bin/bash")
    assert "Library/Application Support/Google/Chrome/NativeMessagingHosts" in script
    b64 = re.search(r"PAYLOAD='([A-Za-z0-9+/=]+)'", script).group(1)
    assert payload_files(b64) == host_sources()


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
  *) exit 22;;
esac
"""


def run_mac_installer(tmp_path, sums_ok=True, ytdlp_body="echo 2099.01.01\n", wrong_sum=False,
                      ffmpeg_body="echo ffmpeg\n", before=None, piped=False):
    for tool in ("shasum", "unzip", "python3"):
        if shutil.which(tool) is None:
            pytest.skip(f"{tool} not installed")
    home, stub, bin_dir = tmp_path / "home", tmp_path / "stub", tmp_path / "bin"
    for d in (home, stub, bin_dir):
        d.mkdir()
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
    for name, body in (("curl", CURL_STUB), ("ffmpeg", "#!/bin/sh\n" + ffmpeg_body)):
        (bin_dir / name).write_text(body)
        (bin_dir / name).chmod(0o755)
    if before:
        before(home / "Library/Application Support/YTDownloader/bin")
    script = tmp_path / "install-mac.command"
    script.write_text(mac_script(build.render_mac()), encoding="utf-8")
    env = {**os.environ, "HOME": str(home), "PATH": f"{bin_dir}:{os.environ['PATH']}", "STUB_DIR": str(stub)}
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


def test_mac_installer_does_not_use_the_single_file_yt_dlp():
    script = mac_script(build.render_mac())
    assert "macos_engine.py" in script
    assert "releases/latest/download/yt-dlp_macos\"" not in script and "-o \"$HOME_DIR/bin/yt-dlp\"" not in script


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
    assert "下載 Deno" in proc.stdout and "準備 ffmpeg" in proc.stdout


def test_mac_installer_does_not_call_it_done_when_the_check_finds_a_problem(tmp_path):
    proc, _ = run_mac_installer(tmp_path, ffmpeg_body="exit 1\n")
    assert proc.returncode != 0
    assert "✘" in proc.stdout and "ffmpeg 無法執行" in proc.stdout and "→" in proc.stdout
    assert "安裝尚未完成" in proc.stdout and "安裝完成！" not in proc.stdout


def test_mac_installer_removes_the_downloaded_from_internet_mark_before_registering_with_chrome():
    script = mac_script(build.render_mac())
    mark = script.index("xattr -dr com.apple.quarantine")
    assert script.index('step "下載 yt-dlp') < mark < script.index('step "登錄 Chrome Native Messaging"')


def test_windows_installer_judges_parts_by_running_them_and_ends_with_the_same_report():
    text = build.render_windows().replace("\r\n", "\n")
    assert "function Works(" in text
    for part in ("deno.exe", "ffmpeg.exe"):
        assert f"Works (Join-Path $BinDir '{part}')" in text
    assert "(Works $py '--version')" in text
    assert "doctor.py" in text and "--native-manifest $manifestPath" in text and "--ext-id $ExtId" in text
    assert "重新執行這個安裝檔就會自動檢查並修復" in text


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
    assert broken.returncode != 0 and "安裝尚未完成" in broken.stdout
