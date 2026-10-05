#!/usr/bin/env python3
"""Test-only launcher: runs the installed host (YTDL_HOME/host) with GitHub downloads served from a local folder.

The folder FAKE_GITHUB_DIR holds <commit>/host/<name>; every other URL is refused. Not part of the product.
"""
import os
import sys
from pathlib import Path

home = Path(os.environ["YTDL_HOME"])
sys.path.insert(0, str(home / "host"))

import host  # noqa: E402
import selfupdate  # noqa: E402

fake_root = Path(os.environ["FAKE_GITHUB_DIR"])


def fake_http_get(url: str, timeout: float = 30.0) -> bytes:
    prefix = f"{selfupdate.RAW_BASE}/"
    if not url.startswith(prefix):
        raise selfupdate.UpdateError("update_download_failed", f"不允許的網址：{url}")
    parts = url[len(prefix):].split("/")
    if len(parts) != 3 or parts[1] != "host":
        raise selfupdate.UpdateError("update_download_failed", f"不允許的網址：{url}")
    try:
        return (fake_root / parts[0] / "host" / parts[2]).read_bytes()
    except OSError as exc:
        raise selfupdate.UpdateError("update_download_failed", f"下載失敗：{exc}") from exc


selfupdate.http_get = fake_http_get

if __name__ == "__main__":
    sys.exit(host.main())
