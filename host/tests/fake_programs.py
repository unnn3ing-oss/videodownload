"""Stand-in programs the tests start for real (a fake yt-dlp).

POSIX starts a script through its `#!` line; Windows cannot: a `.py` renamed to `yt-dlp.exe` is "not a valid Win32
application" (WinError 193/216). There the program is a real .exe made the way pip makes the `pip.exe` of a Python
install: the launcher .exe that ships inside pip, then a `#!python.exe` line, then a zip holding `__main__.py`.
"""
import io
import os
import struct
import sys
import sysconfig
import zipfile
from pathlib import Path

import pytest


def _launcher() -> bytes:
    try:
        import pip._vendor.distlib as distlib
    except ImportError:
        pytest.skip("pip's vendored launcher .exe is needed to build a fake yt-dlp.exe")
    arm = sysconfig.get_platform() == "win-arm64"
    name = "t64-arm.exe" if arm else ("t64.exe" if struct.calcsize("P") == 8 else "t32.exe")
    path = Path(distlib.__file__).with_name(name)
    if not path.is_file():
        pytest.skip(f"{name} is missing from pip's distlib")
    return path.read_bytes()


def make_program(path: Path, source: str) -> Path:
    """`path` becomes a program that runs the Python `source` (an .exe on Windows, so `path` must end in .exe there)."""
    path = Path(path)
    if os.name != "nt":
        path.write_text(source if source.startswith("#!") else "#!/usr/bin/env python3\n" + source, encoding="utf-8")
        path.chmod(0o755)
        return path
    assert path.suffix == ".exe", path
    interpreter = f'"{sys.executable}"' if " " in sys.executable else sys.executable
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr("__main__.py", source.encode("utf-8"))
    path.write_bytes(_launcher() + f"#!{interpreter}\r\n".encode("utf-8") + archive.getvalue())
    return path
