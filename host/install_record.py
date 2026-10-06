"""What the installer remembers: where the extension's folder is. Read by the installer, the doctor and the host's updates."""
from __future__ import annotations

import json
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


def write_record(home: Path, *, extension_folder: Path, version: str) -> None:
    Path(home).mkdir(parents=True, exist_ok=True)
    data = {"extensionFolder": str(extension_folder), "version": version}
    (Path(home) / RECORD_NAME).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def recorded_extension_folder(home: Path, expected_name: str = EXTENSION_NAME) -> Path | None:
    """The folder of the last install, while it still is the extension (it may have been moved or deleted since)."""
    folder = read_record(home).get("extensionFolder")
    if isinstance(folder, str) and is_extension(Path(folder), expected_name):
        return Path(folder)
    return None
