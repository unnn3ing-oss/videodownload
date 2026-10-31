"""Persisted user settings (currently only the output folder)."""
from __future__ import annotations

import json
import os
from pathlib import Path


OLD_SUBFOLDER = "YT下載"  # the default up to 0.7.8
OLD_ARCHIVE = ".ytdl-archive.json"  # equals jobs.Archive.FILENAME (a test enforces it)


class ConfigStore:
    def __init__(self, path: Path):
        self.path = Path(path)

    def _load(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    @property
    def output_dir(self) -> Path:
        value = self._load().get("outputDir")
        if isinstance(value, str) and value.strip():
            return Path(value)
        downloads = Path.home() / "Downloads"
        old = downloads / OLD_SUBFOLDER
        # whoever already downloaded there keeps that folder: its archive is what stops everything coming down again
        return old if (old / OLD_ARCHIVE).is_file() else downloads

    def set_output_dir(self, value: object) -> Path:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("output directory must be a non-empty string")
        target = Path(value.strip()).expanduser()
        target.mkdir(parents=True, exist_ok=True)
        data = self._load()
        data["outputDir"] = str(target)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self.path)
        return target
