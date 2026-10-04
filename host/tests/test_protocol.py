import io
import struct

import pytest

from protocol import MAX_IN, MAX_OUT, ProtocolError, read_message, write_message


def frame(body: bytes, declared: int | None = None) -> io.BytesIO:
    n = len(body) if declared is None else declared
    return io.BytesIO(struct.pack("=I", n) + body)


def test_roundtrip_unicode():
    buf = io.BytesIO()
    write_message(buf, {"type": "ping", "t": "標題"})
    buf.seek(0)
    assert read_message(buf) == {"type": "ping", "t": "標題"}


def test_wire_format():
    buf = io.BytesIO()
    write_message(buf, {"a": 1})
    data = buf.getvalue()
    assert data[:4] == struct.pack("=I", 7)
    assert data[4:] == b'{"a":1}'


def test_eof_returns_none():
    assert read_message(io.BytesIO(b"")) is None


def test_truncated_header_raises():
    with pytest.raises(ProtocolError):
        read_message(io.BytesIO(b"\x05\x00"))


def test_truncated_body_raises():
    with pytest.raises(ProtocolError):
        read_message(frame(b"abc", declared=10))


def test_invalid_json_raises():
    with pytest.raises(ProtocolError):
        read_message(frame(b"{nope"))


def test_non_object_raises():
    with pytest.raises(ProtocolError):
        read_message(frame(b"[1]"))


def test_incoming_over_limit_raises():
    class Counting(io.BytesIO):
        reads: list[int] = []

        def read(self, n=-1):
            self.reads.append(n)
            return super().read(n)

    stream = Counting(struct.pack("=I", MAX_IN + 1))
    with pytest.raises(ProtocolError):
        read_message(stream)
    assert stream.reads == [4]  # header only; body never read


def test_outgoing_over_limit_raises():
    with pytest.raises(ProtocolError):
        write_message(io.BytesIO(), {"x": "a" * MAX_OUT})


def test_bad_json_is_distinguishable_from_framing_errors():
    from protocol import BadMessage

    with pytest.raises(BadMessage):
        read_message(frame(b"{nope"))
    with pytest.raises(BadMessage):
        read_message(frame(b"[1]"))
    with pytest.raises(ProtocolError) as exc:
        read_message(frame(b"abc", declared=10))
    assert not isinstance(exc.value, BadMessage)
