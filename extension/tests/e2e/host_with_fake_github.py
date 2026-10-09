#!/usr/bin/env python3
"""Test-only launcher: runs the installed host (YTDL_HOME/host) and forbids it from using the network.

The extension downloads the host's update files itself and hands them over, so any attempt by the host to
download must fail the test. Not part of the product.
"""
import os
import sys
from pathlib import Path

home = Path(os.environ["YTDL_HOME"])
sys.path.insert(0, str(home / "host"))

import host  # noqa: E402
import selfupdate  # noqa: E402


def forbidden_http_get(url: str, timeout: float = 30.0) -> bytes:
    raise selfupdate.UpdateError("update_download_failed", f"測試中下載助手不應自己下載：{url}")


selfupdate.http_get = forbidden_http_get

if __name__ == "__main__":
    sys.exit(host.main())
