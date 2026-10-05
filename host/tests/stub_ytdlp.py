#!/usr/bin/env python3
"""Fake yt-dlp used by host tests: understands just the calls the host makes."""
import json
import os
import sys
import time
from pathlib import Path

args = sys.argv[1:]
if "--version" in args:
    print("2099.01.01")
elif "-U" in args:
    print("Updated")
elif "--flat-playlist" in args:
    print(json.dumps({"id": "v1", "title": "範例影片"}))
else:
    time.sleep(float(os.environ.get("YTDL_STUB_DELAY", "0")))  # lets tests look at a running download
    target = args[args.index("-o") + 1].replace("%%", "%")
    Path(target).write_text("x", encoding="utf-8")
    print("[ytdl-progress]512|1024|NA|100|1", flush=True)
    print(f"[ytdl-done]{args[-1].split('v=')[-1]}|720|avc1.4d401f", flush=True)
