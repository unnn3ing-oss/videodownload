#!/usr/bin/env python3
"""Generate the single-file installers (Windows .cmd, Mac .zip) with the host code embedded."""
from __future__ import annotations

import base64
import hashlib
import io
import json
import re
import stat
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HOST_NAME = "com.ytdl.batch_downloader"  # must match extension/lib/constants.js (tests enforce)
VERSION = re.search(r'VERSION = "([^"]+)"', (ROOT / "host" / "version.py").read_text(encoding="utf-8")).group(1)
OUT = ROOT / "extension" / "installers"
TEMPLATES = ROOT / "installers" / "templates"

# The only address the installers themselves need: the Python they run host/installer.py with on Windows (a Mac has one).
# Every other download address lives in host/installer.py, so it can be fixed without a new installer.
DEPS = {
    "URL_PYTHON_WIN": "https://www.python.org/ftp/python/3.12.8/python-3.12.8-embed-amd64.zip",
}
_ZIP_DATE = (1980, 1, 1, 0, 0, 0)  # fixed so output is reproducible


def read_manifest_key() -> str:
    manifest = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))
    return manifest["key"]


def extension_id(key_b64: str) -> str:
    digest = hashlib.sha256(base64.b64decode(key_b64)).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def host_manifest(path: str, ext_id: str) -> dict:
    return {
        "name": HOST_NAME,
        "description": "YouTube 批量下載器本機小程式",
        "path": path,
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{ext_id}/"],
    }


def payload_b64() -> str:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted((ROOT / "host").glob("*.py")):
            info = zipfile.ZipInfo(path.name, _ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            z.writestr(info, path.read_bytes())
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _extension_files() -> list[Path]:
    root = ROOT / "extension"
    skipped = {"tests", "installers", "__pycache__"}  # (the installers would contain themselves)
    return sorted(p for p in root.rglob("*") if p.is_file() and not skipped & set(p.relative_to(root).parts))


def extension_b64() -> str:
    """The extension's files (what the browser loads), for the installer to put in the person's folder."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for path in _extension_files():
            info = zipfile.ZipInfo(path.relative_to(ROOT / "extension").as_posix(), _ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            z.writestr(info, path.read_bytes())
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _render(template: str) -> str:
    text = (TEMPLATES / template).read_text(encoding="utf-8")
    values = {**DEPS, "HOST_NAME": HOST_NAME, "EXT_ID": extension_id(read_manifest_key()),
              "VERSION": VERSION, "PAYLOAD_B64": payload_b64(), "EXTENSION_B64": extension_b64()}
    for name, value in values.items():
        text = text.replace(f"@@{name}@@", value)
    if "@@" in text:
        raise ValueError(f"unreplaced placeholder in {template}")
    return text


def render_windows() -> str:
    return _render("install-windows.cmd.tpl").replace("\r\n", "\n").replace("\n", "\r\n")


def render_mac_script() -> str:
    """The Mac installer as plain text: what `curl -fsSL <address> | bash` runs, and what the zip's .command file holds."""
    return _render("install-mac.command.tpl").replace("\r\n", "\n")


def render_mac() -> bytes:
    script = render_mac_script()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        info = zipfile.ZipInfo("install-mac.command", _ZIP_DATE)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3  # Unix, so the executable bit survives extraction
        info.external_attr = (stat.S_IFREG | 0o755) << 16
        z.writestr(info, script.encode("utf-8"))
    return buf.getvalue()


def main(out_dir: Path = OUT) -> None:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "install-windows.cmd").write_bytes(render_windows().encode("utf-8"))
    (out_dir / "install-mac.zip").write_bytes(render_mac())
    (out_dir / "install-mac.sh").write_bytes(render_mac_script().encode("utf-8"))
    print(f"wrote installers to {out_dir}")


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else OUT)
