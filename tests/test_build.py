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


def test_main_writes_both_installers(tmp_path):
    build.main(tmp_path)
    assert (tmp_path / "install-windows.cmd").read_bytes() == build.render_windows().encode("utf-8")
    assert (tmp_path / "install-mac.zip").read_bytes() == build.render_mac()


def test_committed_installers_are_current():
    out = ROOT / "extension" / "installers"
    assert (out / "install-windows.cmd").read_bytes() == build.render_windows().encode("utf-8")
    assert (out / "install-mac.zip").read_bytes() == build.render_mac()


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
  *yt-dlp_macos) cp "$STUB_DIR/ytdlp" "$out";;
  *deno*) cp "$STUB_DIR/deno.zip" "$out";;
  *) exit 22;;
esac
"""


def run_mac_installer(tmp_path, sums_ok=True, ytdlp_body="echo 2099.01.01\n"):
    for tool in ("shasum", "unzip", "python3"):
        if shutil.which(tool) is None:
            pytest.skip(f"{tool} not installed")
    home, stub, bin_dir = tmp_path / "home", tmp_path / "stub", tmp_path / "bin"
    for d in (home, stub, bin_dir):
        d.mkdir()
    ytdlp = stub / "ytdlp"
    ytdlp.write_text("#!/bin/sh\n" + ytdlp_body)
    (stub / "sums").write_text(f"{hashlib.sha256(ytdlp.read_bytes()).hexdigest()}  yt-dlp_macos\n")
    if sums_ok:
        (stub / "sums_ok").write_text("")
    with zipfile.ZipFile(stub / "deno.zip", "w") as z:
        info = zipfile.ZipInfo("deno")
        info.external_attr = (0o100000 | 0o755) << 16
        z.writestr(info, "#!/bin/sh\necho deno 2\n")
    for name, body in (("curl", CURL_STUB), ("ffmpeg", "#!/bin/sh\necho ffmpeg\n")):
        (bin_dir / name).write_text(body)
        (bin_dir / name).chmod(0o755)
    script = tmp_path / "install-mac.command"
    script.write_text(mac_script(build.render_mac()), encoding="utf-8")
    env = {**os.environ, "HOME": str(home), "PATH": f"{bin_dir}:{os.environ['PATH']}", "STUB_DIR": str(stub)}
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


def test_mac_installer_reports_checksum_fetch_failure(tmp_path):
    proc, _ = run_mac_installer(tmp_path, sums_ok=False)
    assert proc.returncode != 0 and "安裝失敗" in proc.stdout and "安裝完成" not in proc.stdout


def test_mac_installer_reports_unrunnable_ytdlp(tmp_path):
    proc, _ = run_mac_installer(tmp_path, ytdlp_body="exit 3\n")
    assert proc.returncode != 0 and "安裝失敗" in proc.stdout and "安裝完成" not in proc.stdout
