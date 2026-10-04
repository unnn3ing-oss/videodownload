import io
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path

import pytest

import host as host_mod
from host import Host, locate_engine, main
from protocol import read_message, write_message

HERE = Path(__file__).parent
HOST_PY = HERE.parent / "host.py"
URL = "https://www.youtube.com/watch?v=v1"


def make_home(tmp_path: Path, with_engine: bool = True) -> Path:
    home = tmp_path / "home"
    (home / "bin").mkdir(parents=True)
    if with_engine:
        stub = home / "bin" / ("yt-dlp.exe" if os.name == "nt" else "yt-dlp")
        shutil.copy(HERE / "stub_ytdlp.py", stub)
        stub.chmod(0o755)
    return home


def new_host(tmp_path, with_engine=True):
    events = []
    h = Host(make_home(tmp_path, with_engine), events.append)
    h.config.set_output_dir(str(tmp_path / "out"))
    return h, events


def frames(*msgs) -> io.BytesIO:
    buf = io.BytesIO()
    for m in msgs:
        write_message(buf, m)
    buf.seek(0)
    return buf


def parse_all(data: bytes) -> list:
    stream, out = io.BytesIO(data), []
    while (m := read_message(stream)) is not None:
        out.append(m)
    return out


def test_locate_engine_reports_missing_parts(tmp_path):
    engine = locate_engine(make_home(tmp_path, with_engine=False))
    assert engine.ffmpeg_dir is None and engine.js_runtime is None


def test_ping_echoes_reqid(tmp_path):
    h, events = new_host(tmp_path)
    h.handle({"type": "ping", "reqId": 7})
    assert events == [{"type": "pong", "reqId": 7}]


def test_download_replies_started(tmp_path):
    h, events = new_host(tmp_path)
    h.handle({"type": "download", "reqId": 1, "quality": 720,
              "items": [{"url": URL, "id": "v1", "title": "範例影片"}]})
    h.wait(10)
    assert events[0]["type"] == "started" and events[0]["reqId"] == 1
    job_id = events[0]["jobId"]
    assert all(e.get("jobId") == job_id for e in events[1:]) and events[-1]["type"] == "done"
    assert events[-1]["summary"]["ok"] == 1


def test_unknown_type(tmp_path):
    h, events = new_host(tmp_path)
    h.handle({"type": "nope"})
    assert events[0]["type"] == "error" and events[0]["code"] == "unknown_type"


def test_bad_quality(tmp_path):
    h, events = new_host(tmp_path)
    h.handle({"type": "download", "quality": 480, "items": [{"url": URL}]})
    assert events[0]["code"] == "bad_quality"


def test_bad_url_on_resolve(tmp_path):
    h, events = new_host(tmp_path)
    h.handle({"type": "resolve", "urls": ["https://evil.com/x"]})
    assert events[0]["code"] == "bad_url"


def test_engine_missing(tmp_path):
    h, events = new_host(tmp_path, with_engine=False)
    h.handle({"type": "download", "quality": 720, "items": [{"url": URL}]})
    assert events[0]["code"] == "engine_missing"


def test_resolve_returns_items(tmp_path):
    h, events = new_host(tmp_path)
    h.handle({"type": "resolve", "reqId": 3, "urls": [URL]})
    h.wait(10)
    assert events[0]["type"] == "resolved" and events[0]["reqId"] == 3
    assert events[0]["items"][0]["title"] == "範例影片"


def test_config_roundtrip(tmp_path):
    h, events = new_host(tmp_path)
    target = str(tmp_path / "elsewhere")
    h.handle({"type": "set_config", "outputDir": target})
    h.handle({"type": "get_config"})
    assert events[0] == {"type": "config", "outputDir": target}
    assert events[1] == {"type": "config", "outputDir": target}
    h.handle({"type": "set_config", "outputDir": ""})
    assert events[2]["code"] == "bad_path"


def run_main(tmp_path, *msgs, monkeypatch=None):
    out = io.BytesIO()
    monkeypatch.setenv("YTDL_HOME", str(make_home(tmp_path)))
    code = main([], stdin=frames(*msgs), stdout=out)
    return code, parse_all(out.getvalue())


def test_main_sends_ready_then_pong(tmp_path, monkeypatch):
    code, out = run_main(tmp_path, {"type": "ping"}, monkeypatch=monkeypatch)
    assert code == 0
    assert [m["type"] for m in out] == ["ready", "pong"]
    assert out[0]["ytdlpVersion"] == "2099.01.01" and out[0]["ffmpegOk"] is False


def test_stray_print_does_not_corrupt_stream(tmp_path, monkeypatch, capsys):
    original = Host._on_ping

    def noisy(self, msg):
        print("noise")
        original(self, msg)

    monkeypatch.setattr(Host, "_on_ping", noisy)
    code, out = run_main(tmp_path, {"type": "ping"}, monkeypatch=monkeypatch)
    captured = capsys.readouterr()
    assert [m["type"] for m in out] == ["ready", "pong"]
    assert "noise" in captured.err and "noise" not in captured.out


def test_eof_cancels_running_job(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(host_mod.JobRunner, "cancel", lambda self: calls.append(1))
    run_main(tmp_path, monkeypatch=monkeypatch)
    assert calls == [1]


def test_bad_json_reports_error_and_continues(tmp_path, monkeypatch):
    import struct

    out = io.BytesIO()
    monkeypatch.setenv("YTDL_HOME", str(make_home(tmp_path)))
    raw = io.BytesIO()
    raw.write(struct.pack("=I", 5) + b"{nope")
    write_message(raw, {"type": "ping"})
    raw.seek(0)
    main([], stdin=raw, stdout=out)
    kinds = [(m["type"], m.get("code")) for m in parse_all(out.getvalue())]
    assert kinds == [("ready", None), ("error", "bad_json"), ("pong", None)]


def test_subprocess_end_to_end(tmp_path):
    home = make_home(tmp_path)
    env = {**os.environ, "YTDL_HOME": str(home)}
    proc = subprocess.Popen([sys.executable, str(HOST_PY)], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    watchdog = threading.Timer(60, proc.kill)
    watchdog.start()

    def expect(kind):
        while True:
            m = read_message(proc.stdout)
            assert m is not None, "host exited early"
            if m["type"] == kind:
                return m

    def send(msg):
        write_message(proc.stdin, msg)

    try:
        assert expect("ready")["ytdlpVersion"] == "2099.01.01"
        out_dir = tmp_path / "e2e-out"
        send({"type": "set_config", "outputDir": str(out_dir)})
        expect("config")
        send({"type": "resolve", "reqId": 2, "urls": [URL]})
        assert expect("resolved")["items"][0]["title"] == "範例影片"
        send({"type": "download", "quality": 720, "items": [{"url": URL, "id": "v1", "title": "範例影片"}]})
        expect("started")
        assert expect("done")["summary"]["ok"] == 1
        assert (out_dir / "範例影片.mp4").exists()
        send({"type": "update_engine"})
        assert expect("engine_updated")["ytdlpVersion"] == "2099.01.01"
        proc.stdin.close()
        assert proc.wait(15) == 0
    finally:
        watchdog.cancel()
        proc.kill()
