#!/usr/bin/env python3
"""Windows-only smoke check: the installer's register() really writes the Chrome registry key, and the doctor reads it back.

The unit tests replace the registry with a stand-in; this is run once per CI build on a real Windows runner
(.github/workflows/ci.yml, job `windows`) to prove the real winreg calls round-trip. It uses a temporary folder, removes the
key again, and refuses to run when the key already exists (on a developer's computer that would be the real registration)
unless --force is given. Exit 0 = OK, 1 = FAIL, 2 = could not run (not Windows, or the key exists).
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent.parent
EXT_ID = "abcdefghijklmnopabcdefghijklmnop"  # any well-formed id: nothing here talks to Chrome


def main(root: Path = ROOT, argv: Optional[list] = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    try:
        import winreg
    except ImportError:
        print("SKIP: the registry smoke check needs Windows (winreg is not available here)")
        return 2
    sys.path.insert(0, str(Path(root) / "host"))
    try:
        import doctor
        import installer
    finally:
        sys.path.remove(str(Path(root) / "host"))

    key = rf"Software\Google\Chrome\NativeMessagingHosts\{installer.HOST_NAME}"
    try:
        winreg.OpenKey(winreg.HKEY_CURRENT_USER, key).__exit__(None, None, None)
        exists = True
    except OSError:
        exists = False
    if exists and "--force" not in argv:
        print(f"SKIP: HKCU\\{key} already exists (a real registration?); not touching it. Use --force on a throwaway machine.")
        return 2

    problems = []
    try:
        with tempfile.TemporaryDirectory(prefix="ytdl-regsmoke-") as tmp:
            manifest = installer.register(Path(tmp) / "app", "win32", EXT_ID)
            value = doctor._registry_value()
            if Path(value) != manifest:
                problems.append(f"registry value {value!r} is not the manifest path {str(manifest)!r}")
            check = doctor._check_native(manifest, EXT_ID, "win32")
            if check.status != "ok":
                problems.append(f"doctor says {check.status}: {check.title} {check.detail}")
    except Exception as exc:  # any failure here is the answer
        problems.append(f"{type(exc).__name__}: {exc}")
    finally:
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key)
        except OSError:
            pass
    if problems:
        print("FAIL: " + "; ".join(problems))
        return 1
    print(f"OK: register() wrote HKCU\\{key} and the doctor read it back; key removed again")
    return 0


if __name__ == "__main__":
    sys.exit(main())
