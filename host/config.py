"""Persisted user settings (currently only the output folder)."""
from __future__ import annotations

import json
import os
from pathlib import Path


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
        return Path.home() / "Downloads" / "YT下載"

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
