import io
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

import host as host_mod
from fake_programs import make_program
from host import Host, locate_engine, main
from protocol import read_message, write_message
from ytdlp import Engine, VideoRef

HERE = Path(__file__).parent
HOST_PY = HERE.parent / "host.py"
URL = "https://www.youtube.com/watch?v=v1"


def make_home(tmp_path: Path, with_engine: bool = True) -> Path:
    home = tmp_path / "home"
    (home / "bin").mkdir(parents=True)
    if with_engine:
        make_program(home / "bin" / ("yt-dlp.exe" if os.name == "nt" else "yt-dlp"), (HERE / "stub_ytdlp.py").read_text(encoding="utf-8"))
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
        if sys.platform not in ("darwin", "win32"):  # (there the engine is installed again, from the network: unit tests cover it)
            send({"type": "update_engine"})
            assert expect("engine_updated")["ytdlpVersion"] == "2099.01.01"
        proc.stdin.close()
        assert proc.wait(15) == 0
    finally:
        watchdog.cancel()
        proc.kill()


def test_resolve_worker_exception_replies_error(tmp_path, monkeypatch):
    def boom(engine, urls, limit, log=None):
        raise OSError("blocked by antivirus")

    monkeypatch.setattr(host_mod, "resolve", boom)
    h, events = new_host(tmp_path)
    h.handle({"type": "resolve", "reqId": 9, "urls": [URL]})
    h.wait(10)
    assert events[0]["type"] == "error" and events[0]["reqId"] == 9


def test_unrunnable_engine_does_not_break_ready(tmp_path):
    home = make_home(tmp_path)
    engine = home / "bin" / ("yt-dlp.exe" if os.name == "nt" else "yt-dlp")
    if os.name == "nt":
        engine.write_bytes(b"not a program")  # exists but Windows cannot start it (WinError 193): there is no exec bit to clear
    else:
        engine.chmod(0o644)  # exists but cannot be executed
    h = Host(home, [].append)
    assert h.ready_message()["ytdlpVersion"] is None


def test_save_cover_message_writes_into_output_dir(tmp_path):
    import base64
    h, events = new_host(tmp_path)
    jpeg = b"\xff\xd8\xff\xe0" + b"\x00" * 8
    h.handle({"type": "save_cover", "reqId": 3, "id": "v1", "title": "颱風假放不放？", "data": base64.b64encode(jpeg).decode()})
    assert events[-1]["type"] == "cover_saved" and events[-1]["reqId"] == 3
    assert (tmp_path / "out" / "颱風假放不放.jpg").read_bytes() == jpeg
    assert Path(events[-1]["file"]).name == "颱風假放不放.jpg"


def test_save_cover_message_honours_the_chosen_name(tmp_path):
    import base64
    h, events = new_host(tmp_path)
    data = base64.b64encode(b"\xff\xd8\xff\xe0" + b"\x00" * 8).decode()
    h.handle({"type": "save_cover", "reqId": 1, "id": "v1", "title": "同標題", "data": data})
    h.handle({"type": "save_cover", "reqId": 2, "id": "v2", "title": "同標題", "name": "同標題 [v2]", "data": data})
    h.handle({"type": "save_cover", "reqId": 3, "id": "v3", "title": "同標題", "name": 5, "data": data})  # not text: ignored
    assert [Path(e["file"]).name for e in events if e["type"] == "cover_saved"] == ["同標題.jpg", "同標題 [v2].jpg", "同標題_2.jpg"]


def test_save_cover_message_rejects_bad_id_and_bad_base64(tmp_path):
    import base64
    h, events = new_host(tmp_path)
    good = base64.b64encode(b"\xff\xd8\xff\xe0").decode()
    h.handle({"type": "save_cover", "id": "../x", "title": "t", "data": good})
    assert events[-1]["type"] == "error" and events[-1]["code"] == "bad_id"
    h.handle({"type": "save_cover", "id": "v1", "title": "t", "data": "***"})
    assert events[-1]["type"] == "error" and events[-1]["code"] == "bad_cover"
    h.handle({"type": "save_cover", "id": "v1", "title": 5, "data": good})
    assert events[-1]["type"] == "error"
    assert not (tmp_path / "out").exists() or not list((tmp_path / "out").glob("*.jpg"))


def test_resolve_reply_has_duration(tmp_path):
    h, events = new_host(tmp_path)
    h.handle({"type": "resolve", "reqId": 4, "urls": [URL]})
    h.wait(10)
    assert events[0]["items"][0]["duration"] == 222


def test_meta_message_returns_description(tmp_path):
    h, events = new_host(tmp_path)
    h.handle({"type": "meta", "reqId": 5, "url": URL})
    h.wait(10)
    assert events[0]["type"] == "meta" and events[0]["reqId"] == 5
    assert events[0]["id"] == "v1" and events[0]["title"] == "範例影片"
    assert "#標籤一 #標籤二 #標籤三 #標籤四" in events[0]["description"]


def test_meta_rejects_non_youtube_url(tmp_path):
    h, events = new_host(tmp_path)
    h.handle({"type": "meta", "reqId": 6, "url": "https://evil.example/x"})
    assert events[0]["type"] == "error" and events[0]["code"] == "bad_url"


def test_meta_without_engine_reports_engine_missing(tmp_path):
    h, events = new_host(tmp_path, with_engine=False)
    h.handle({"type": "meta", "reqId": 7, "url": URL})
    assert events[0]["type"] == "error" and events[0]["code"] == "engine_missing"


def test_download_passes_valid_cooldown_and_ignores_invalid(tmp_path):
    h, events = new_host(tmp_path)
    seen = []
    h.runner.start = lambda job_id, items, quality, out, override=None, cooldown=None: seen.append(cooldown)
    for value, expected in [(7, 7), (0, 0), (2.5, 2.5), (301, None), (-1, None), ("x", None), (True, None), (None, None)]:
        msg = {"type": "download", "quality": 720, "items": [{"url": URL, "id": "v1", "title": "t"}]}
        if value is not None:
            msg["cooldownSec"] = value
        h.handle(msg)
        assert seen[-1] == expected, value


def test_enqueue_message_when_not_running_errors(tmp_path):
    h, events = new_host(tmp_path)
    h.handle({"type": "enqueue", "reqId": 8, "items": [{"url": URL, "id": "v1", "title": "t"}]})
    assert events[-1]["type"] == "error" and events[-1]["code"] == "not_running" and events[-1]["reqId"] == 8
    h.handle({"type": "enqueue", "reqId": 9, "items": []})
    assert events[-1]["code"] == "bad_url"


def test_enqueue_and_remove_messages_on_running_job(tmp_path, monkeypatch):
    monkeypatch.setenv("YTDL_STUB_DELAY", "0.6")
    h, events = new_host(tmp_path)
    h.handle({"type": "download", "reqId": 1, "quality": 720, "cooldownSec": 0,
              "items": [{"url": URL, "id": "v1", "title": "甲"}]})
    two = {"url": "https://www.youtube.com/watch?v=v2", "id": "v2", "title": "乙"}
    three = {"url": "https://www.youtube.com/watch?v=v3", "id": "v3", "title": "丙"}
    h.handle({"type": "enqueue", "reqId": 2, "items": [two, three]})
    assert {"type": "enqueued", "count": 2, "reqId": 2} in events
    h.handle({"type": "remove", "reqId": 3, "itemId": "v3"})
    assert {"type": "removed", "itemId": "v3", "where": "pending", "reqId": 3} in events
    h.wait(15)
    done = [e for e in events if e["type"] == "item_done"]
    assert sorted(Path(e["file"]).name for e in done) == ["乙.mp4", "甲.mp4"]


def test_remove_message_not_found(tmp_path):
    h, events = new_host(tmp_path)
    h.handle({"type": "remove", "reqId": 4, "itemId": "nope"})
    assert events[-1]["type"] == "error" and events[-1]["code"] == "not_found"
    h.handle({"type": "remove", "reqId": 5, "itemId": 5})
    assert events[-1]["type"] == "error"


class BrokenPipe:
    """A native-messaging stdin that delivers `data`, waits for `ready()`, then fails like a closed pipe."""

    def __init__(self, data: bytes, error: Exception, ready=lambda: True):
        self._buf, self._error, self._ready = io.BytesIO(data), error, ready

    def read(self, n):
        chunk = self._buf.read(n)
        if chunk:
            return chunk
        deadline = time.monotonic() + 10
        while not self._ready() and time.monotonic() < deadline:
            time.sleep(0.01)
        raise self._error


@pytest.mark.parametrize("error", [OSError(22, "Invalid argument"), BrokenPipeError(), ValueError("I/O on closed file")])
def test_pipe_error_on_read_stops_the_running_download_and_exits_cleanly(tmp_path, monkeypatch, error):
    log = tmp_path / "started.log"
    monkeypatch.setenv("YTDL_STUB_LOG", str(log))
    monkeypatch.setenv("YTDL_STUB_DELAY", "30")  # yt-dlp is still running when the pipe breaks
    monkeypatch.setenv("YTDL_HOME", str(make_home(tmp_path)))
    out = io.BytesIO()
    stdin = BrokenPipe(frames({"type": "set_config", "outputDir": str(tmp_path / "out")},
                              {"type": "download", "quality": 720,
                               "items": [{"url": URL, "id": "v1", "title": "範例影片"}]}).getvalue(),
                       error, ready=log.exists)
    started = time.monotonic()
    assert main([], stdin=stdin, stdout=out) == 1
    assert time.monotonic() - started < 10
    done = [m for m in parse_all(out.getvalue()) if m["type"] == "done"]
    assert len(done) == 1 and done[0]["summary"]["cancelled"] is True  # the job finished: yt-dlp was killed, not orphaned


class BrokenOut(io.BytesIO):
    """stdout that fails every write that carries `needle`."""

    def __init__(self, needle: bytes):
        super().__init__()
        self._needle = needle

    def write(self, data):
        if self._needle in data:
            raise BrokenPipeError(32, "Broken pipe")
        return super().write(data)


def test_too_large_reply_to_a_broken_pipe_does_not_kill_the_worker_thread(tmp_path, monkeypatch):
    refs = [VideoRef(f"v{i}", "題" * 100, URL, None) for i in range(12000)]  # one reply far over Chrome's 1 MB
    monkeypatch.setattr(host_mod, "resolve", lambda engine, urls, limit, log=None: refs)
    monkeypatch.setenv("YTDL_HOME", str(make_home(tmp_path)))
    died = []
    monkeypatch.setattr(threading, "excepthook", lambda args: died.append(args.exc_value))
    stdin = frames({"type": "resolve", "reqId": 1, "urls": [URL]}, {"type": "ping", "reqId": 2})
    assert main([], stdin=stdin, stdout=BrokenOut(b"too_large")) == 0  # the pipe stays readable until EOF
    for thread in threading.enumerate():
        if thread is not threading.current_thread():
            thread.join(10)
    assert died == []  # the worker must not die writing its "too large" notice into the broken pipe


def _boom(*args, **kwargs):
    raise RuntimeError("boom")


@pytest.mark.parametrize("setup,message", [
    (lambda mp: mp.setattr(host_mod.doctor, "diagnose", _boom), {"type": "doctor"}),
    (lambda mp: (mp.setattr(host_mod, "_engine_installer", lambda: None), mp.setattr(Host, "_version", _boom)),
     {"type": "update_engine"}),
    (lambda mp: mp.setattr(host_mod, "resolve", lambda engine, urls, limit, log=None: [object()]),
     {"type": "resolve", "urls": [URL]}),
    (lambda mp: mp.setattr(host_mod, "fetch_meta", lambda engine, url, log=None: 5), {"type": "meta", "url": URL}),
])
def test_background_handler_that_raises_still_answers_with_an_internal_error(tmp_path, monkeypatch, setup, message):
    setup(monkeypatch)
    h, events = new_host(tmp_path)
    died = []
    monkeypatch.setattr(threading, "excepthook", lambda args: died.append(args.exc_value))
    h.handle({**message, "reqId": 21})
    h.wait(10)
    assert died == []
    assert len(events) == 1 and events[0]["type"] == "error" and events[0]["code"] == "internal"
    assert events[0]["reqId"] == 21 and events[0]["message"].startswith("內部錯誤")


@pytest.mark.parametrize("platform,module", [("win32", "winengine"), ("darwin", "macos_engine")])
def test_update_engine_reinstalls_the_unpacked_build_instead_of_asking_yt_dlp_to_update(tmp_path, monkeypatch, platform, module):
    # the unpacked Windows/Mac builds cannot update themselves (`-U` is refused), so the engine is installed again
    installed = []
    monkeypatch.setattr(host_mod.sys, "platform", platform)
    monkeypatch.setattr(getattr(host_mod, module), "install", lambda bin_dir, **kw: installed.append(bin_dir) or "2099.01.01")
    monkeypatch.setattr(host_mod, "run_capture", lambda cmd: (_ for _ in ()).throw(AssertionError("-U must not run")))
    monkeypatch.setattr(Host, "_version", lambda self: "2099.01.01")
    h, events = new_host(tmp_path)
    h.handle({"type": "update_engine", "reqId": 4})
    h.wait(10)
    assert len(installed) == 1 and installed[0].name == "bin"
    assert events[-1]["type"] == "engine_updated" and events[-1]["reqId"] == 4


def _engine_moves_to(monkeypatch, tmp_path):
    moved = Engine(tmp_path / "elsewhere" / "yt-dlp.exe", None, None)
    monkeypatch.setattr(host_mod, "locate_engine", lambda home: moved)
    return moved


def test_update_engine_points_the_host_and_its_jobs_at_the_engine_that_was_installed(tmp_path, monkeypatch):
    # a Windows install that still had the single-file yt-dlp.exe: the update deletes it, the new build lives elsewhere
    monkeypatch.setattr(host_mod.sys, "platform", "win32")
    monkeypatch.setattr(host_mod.winengine, "install", lambda bin_dir, **kw: "2099.01.01")
    monkeypatch.setattr(Host, "_version", lambda self: "2099.01.01")
    h, events = new_host(tmp_path)
    moved = _engine_moves_to(monkeypatch, tmp_path)
    h.handle({"type": "update_engine", "reqId": 4})
    h.wait(10)
    assert events[-1]["type"] == "engine_updated"
    assert h.engine is moved and h.runner.engine is moved


def test_repairing_the_environment_also_points_the_host_at_the_repaired_engine(tmp_path, monkeypatch):
    monkeypatch.setattr(host_mod.doctor, "repair", lambda home, **kw: ["engine"])
    monkeypatch.setattr(host_mod.doctor, "diagnose", lambda home, **kw: [])
    h, events = new_host(tmp_path)
    moved = _engine_moves_to(monkeypatch, tmp_path)
    h.handle({"type": "doctor", "reqId": 5, "fix": True})
    h.wait(10)
    assert events[-1]["type"] == "doctor" and h.engine is moved and h.runner.engine is moved


def test_update_engine_is_refused_while_a_download_runs(tmp_path, monkeypatch):
    # replacing the program under a running download fails halfway on Windows
    called = []
    monkeypatch.setattr(host_mod.sys, "platform", "win32")
    monkeypatch.setattr(host_mod.winengine, "install", lambda bin_dir, **kw: called.append(bin_dir))
    h, events = new_host(tmp_path)
    h.runner.running = True
    h.handle({"type": "update_engine", "reqId": 6})
    h.wait(10)
    assert called == [] and events[-1]["type"] == "error" and events[-1]["code"] == "busy" and events[-1]["reqId"] == 6
