"""What the installer remembers: where the extension's folder is, and (on Windows) which yt-dlp.exe it verified. Read by the
installer, the doctor and the host's updates."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

EXTENSION_NAME = "YouTube 批量下載器"  # the "name" in the extension's manifest.json
RECORD_NAME = "install.json"


def is_extension(folder: Path, expected_name: str = EXTENSION_NAME) -> bool:
    try:
        return json.loads((Path(folder) / "manifest.json").read_text(encoding="utf-8")).get("name") == expected_name
    except (OSError, ValueError, AttributeError):
        return False


def read_record(home: Path) -> dict:
    try:
        data = json.loads((Path(home) / RECORD_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write(home: Path, data: dict) -> None:
    Path(home).mkdir(parents=True, exist_ok=True)
    target = Path(home) / RECORD_NAME
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, target)


def write_record(home: Path, *, extension_folder: Path | str | None, version: str) -> None:
    """Other entries (the `engine` one) are kept; no folder means the entry is left out."""
    data = read_record(home)
    data["version"] = version
    if extension_folder is None:
        data.pop("extensionFolder", None)
    else:
        data["extensionFolder"] = str(extension_folder)
    _write(home, data)


def fingerprint(path: Path) -> dict:
    """Where a file is, its SHA-256 and its size: what IT needs to allow-list it."""
    digest, size = hashlib.sha256(), 0
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
            size += len(chunk)
    return {"path": str(path), "sha256": digest.hexdigest(), "size": size}


def write_engine(home: Path, engine: dict) -> None:
    data = read_record(home)
    data["engine"] = engine
    _write(home, data)


def read_engine(home: Path) -> dict:
    """The yt-dlp.exe the installer verified last ({path, sha256, size, ...}); {} for a record that has none (older ones)."""
    engine = read_record(home).get("engine")
    if isinstance(engine, dict) and isinstance(engine.get("sha256"), str):
        return engine
    return {}


def recorded_extension_folder(home: Path, expected_name: str = EXTENSION_NAME) -> Path | None:
    """The folder of the last install, while it still is the extension (it may have been moved or deleted since)."""
    folder = read_record(home).get("extensionFolder")
    if isinstance(folder, str) and is_extension(Path(folder), expected_name):
        return Path(folder)
    return None
