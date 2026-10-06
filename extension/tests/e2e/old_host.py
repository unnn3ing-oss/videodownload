#!/usr/bin/env python3
"""A local host from before the batch queue (version 0.1.0): it can look videos up, and answers anything else
with an unknown-message error. Used to check what the extension shows when the host needs updating."""
import json
import struct
import sys


def send(message):
    data = json.dumps(message).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(data)) + data)
    sys.stdout.buffer.flush()


send({"type": "ready", "hostVersion": "0.1.0", "ytdlpVersion": "2099.01.01", "ffmpegOk": True,
      "jsRuntimeOk": True, "outputDir": "/tmp/old-host"})
while True:
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        break
    (length,) = struct.unpack("=I", header)
    message = json.loads(sys.stdin.buffer.read(length).decode("utf-8"))
    if message.get("type") == "resolve":
        url = message["urls"][0]
        send({"type": "resolved", "reqId": message.get("reqId"),
              "items": [{"id": "v1", "title": "範例影片", "url": url}]})
    else:
        send({"type": "error", "code": "unknown", "reqId": message.get("reqId"),
              "message": f"unknown message type: {message.get('type')}"})
