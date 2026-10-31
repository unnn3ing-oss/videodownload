"""Make our bookkeeping files hidden on Windows (a leading dot already hides them on a Mac)."""
from __future__ import annotations

import sys
from pathlib import Path

FILE_ATTRIBUTE_HIDDEN = 0x2
INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF


def _kernel32():
    import ctypes
    from ctypes import wintypes

    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.GetFileAttributesW.argtypes = [wintypes.LPCWSTR]
    k.GetFileAttributesW.restype = wintypes.DWORD
    k.SetFileAttributesW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD]
    k.SetFileAttributesW.restype = wintypes.BOOL
    return k


def hide(path: Path, platform: str | None = None, kernel32=None) -> bool:
    """Set the hidden attribute of a file or folder; True when it was set. Best effort: it never raises."""
    if (platform or sys.platform) != "win32":
        return False
    try:
        k = kernel32 or _kernel32()
        attrs = k.GetFileAttributesW(str(path))
        if attrs == INVALID_FILE_ATTRIBUTES:
            return False
        return bool(k.SetFileAttributesW(str(path), attrs | FILE_ATTRIBUTE_HIDDEN))
    except Exception:  # a missing windll, a locked file: the file only stays visible
        return False
