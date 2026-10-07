#!/usr/bin/env python3
"""Fake yt-dlp used by host tests: understands just the calls the host makes."""
import json
import os
import re
import sys
import time
from pathlib import Path

args = sys.argv[1:]
for stream in (sys.stdout, sys.stderr):  # the host reads UTF-8; a pipe on Windows would otherwise be cp1252 (and fail on 範例影片)
    stream.reconfigure(encoding="utf-8")


def video_id():
    url = args[-1] if args else ""
    match = re.search(r"[?&]v=([A-Za-z0-9_-]+)", url) or re.search(r"youtu\.be/([A-Za-z0-9_-]+)", url)
    return match.group(1) if match else "v1"


def title_for(vid):
    if vid == "v1":
        return "範例影片"
    if vid.startswith("same"):
        return "相同標題"
    if vid == "xss1":
        return '<img src=x onerror="window.__pwned=1">'
    return f"影片 {vid}"


if "--version" in args:
    print("2099.01.01")
elif "-U" in args:
    print("Updated")
elif "--flat-playlist" in args:
    vid = video_id()
    print(json.dumps({"id": vid, "title": title_for(vid), "duration": 222}, ensure_ascii=False))
elif "--dump-json" in args:
    vid = video_id()
    print(json.dumps({"id": vid, "title": title_for(vid),
                      "description": "說明文字 #標籤一 #標籤二 #標籤三 #標籤四"}, ensure_ascii=False))
else:
    if os.environ.get("YTDL_STUB_LOG"):  # one line per video that was actually downloaded
        with open(os.environ["YTDL_STUB_LOG"], "a", encoding="utf-8") as log:
            log.write(video_id() + "\n")
    print("[ytdl-progress]0|1024|NA|NA|NA", flush=True)  # the download has started
    time.sleep(float(os.environ.get("YTDL_STUB_DELAY", "0")))  # lets tests look at a running download
    # like yt-dlp: the bare -o name goes into the -P home: folder
    home = next(a[len("home:"):] for i, a in enumerate(args) if i and args[i - 1] == "-P" and a.startswith("home:"))
    Path(home, args[args.index("-o") + 1].replace("%%", "%")).write_text("x", encoding="utf-8")
    print("[ytdl-progress]512|1024|NA|100|1", flush=True)
    print(f"[ytdl-done]{args[-1].split('v=')[-1]}|720|avc1.4d401f", flush=True)
