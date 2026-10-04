"""Chrome Native Messaging framing: 4-byte native-endian length + UTF-8 JSON."""
from __future__ import annotations

import json
import struct
from typing import BinaryIO

MAX_OUT = 1_000_000  # Chrome rejects host->extension messages over 1 MB
MAX_IN = 8 * 1024 * 1024


class ProtocolError(Exception):
    pass


class BadMessage(ProtocolError):
    """The body was unusable but framing is intact: the stream can keep being read."""


def read_message(stream: BinaryIO) -> dict | None:
    """Return the next message, or None on a clean EOF before any header byte."""
    header = stream.read(4)
    if not header:
        return None
    if len(header) < 4:
        raise ProtocolError("truncated length header")
    (length,) = struct.unpack("=I", header)
    if length > MAX_IN:
        raise ProtocolError(f"incoming message too large: {length}")
    body = stream.read(length)
    if len(body) < length:
        raise ProtocolError("truncated message body")
    try:
        msg = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise BadMessage(f"invalid JSON: {exc}") from exc
    if not isinstance(msg, dict):
        raise BadMessage("message is not a JSON object")
    return msg


def write_message(stream: BinaryIO, msg: dict) -> None:
    body = json.dumps(msg, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(body) > MAX_OUT:
        raise ProtocolError(f"outgoing message too large: {len(body)}")
    stream.write(struct.pack("=I", len(body)))
    stream.write(body)
    stream.flush()
