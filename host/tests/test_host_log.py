import base64
import io
import json
import os
import sys

import pytest

import host as host_mod
from doctor import Check
from host import HANDLED, Host, main
from test_host import URL, frames, make_home, new_host, parse_all


def log_text(h) -> str:
    return h.log.path.read_text(encoding="utf-8") if h.log.path.exists() else ""


def test_every_handled_message_type_is_logged_with_its_req_id(tmp_path):
    h, events = new_host(tmp_path)
    h.handle({"type": "ping", "reqId": 41})
    h.handle({"type": "nope", "reqId": 42})
    text = log_text(h)
    assert "msg ping reqId=41" in text and "msg nope reqId=42" in text


def test_payloads_never_reach_the_log_and_urls_are_cut(tmp_path):
    h, events = new_host(tmp_path)
    secret = base64.b64encode(b"\xff\xd8\xff\xe0" + b"COVERBYTES" * 50).decode()
    h.handle({"type": "save_cover", "reqId": 1, "id": "v1", "title": "標題", "data": secret})
    h.handle({"type": "resolve", "reqId": 2, "urls": [URL + "&x=" + "q" * 300]})
    h.wait(10)
    text = log_text(h)
    assert "msg save_cover reqId=1" in text and secret[:40] not in text and "標題" not in text
    assert "msg resolve reqId=2" in text and "q" * 130 not in text


def test_download_logs_job_start_and_done_through_the_runner(tmp_path):
    h, events = new_host(tmp_path)
    h.handle({"type": "download", "reqId": 1, "quality": 720, "cooldownSec": 0,
              "items": [{"url": URL, "id": "v1", "title": "範例影片"}]})
    h.wait(10)
    text = log_text(h)
    assert "job start" in text and "items=1 quality=720 cooldown=0" in text and "job done" in text
    assert h.runner.last_job["summary"]["ok"] == 1


def test_a_caught_handler_exception_is_logged_with_its_traceback(tmp_path, monkeypatch):
    def boom(self, msg):
        raise RuntimeError("handler blew up")

    monkeypatch.setattr(Host, "_on_ping", boom)
    h, events = new_host(tmp_path)
    h.handle({"type": "ping", "reqId": 3})
    assert events[0]["code"] == "internal"
    text = log_text(h)
    assert "handler blew up" in text and "Traceback" in text


def test_a_background_exception_is_logged_with_its_traceback(tmp_path, monkeypatch):
    monkeypatch.setattr(host_mod, "resolve", lambda engine, urls, limit, log=None: [object()])
    h, events = new_host(tmp_path)
    h.handle({"type": "resolve", "reqId": 4, "urls": [URL]})
    h.wait(10)
    assert events[0]["code"] == "internal" and "Traceback" in log_text(h)


def test_resolve_failures_are_logged_with_the_stderr_tail(tmp_path):
    h, events = new_host(tmp_path)
    h.engine.ytdlp.write_text("#!/bin/sh\necho 'ERROR: [youtube] x: Private video' >&2\nexit 1\n")
    h.handle({"type": "resolve", "reqId": 5, "urls": [URL]})
    h.wait(10)
    assert events[0]["code"] == "private"
    text = log_text(h)
    assert "resolve failed" in text and "ERROR: [youtube] x: Private video" in text


def test_doctor_runs_are_logged(tmp_path, monkeypatch):
    monkeypatch.setattr(host_mod.doctor, "diagnose",
                        lambda *a, **k: [Check("python", "ok", "Python"), Check("deno", "error", "no deno")])
    h, events = new_host(tmp_path)
    h.handle({"type": "doctor", "reqId": 6})
    h.wait(10)
    text = log_text(h)
    assert "doctor" in text and "errors=deno" in text


def test_update_stage_results_are_logged(tmp_path):
    h, events = new_host(tmp_path)
    h.handle({"type": "update_stage", "reqId": 7, "commit": "z", "files": []})
    h.handle({"type": "update_commit", "reqId": 8})
    text = log_text(h)
    assert "update_commit" in text and "update_nothing_staged" in text


def test_main_logs_the_start_and_that_ready_was_sent(tmp_path, monkeypatch):
    home = make_home(tmp_path)
    monkeypatch.setenv("YTDL_HOME", str(home))
    out = io.BytesIO()
    main([], stdin=frames({"type": "ping", "reqId": 1}), stdout=out)
    text = (home / "logs" / "host.log").read_text(encoding="utf-8")
    assert "host start" in text and f"version={host_mod.VERSION}" in text and "python=" in text and "os=" in text
    assert "ready sent" in text and "msg ping reqId=1" in text


# -- diagnostics message -----------------------------------------------------------------------------

def stub_doctor(monkeypatch):
    monkeypatch.setattr(host_mod.doctor, "diagnose", lambda *a, **k: [Check("python", "ok", "Python 3", "/usr/bin/python3")])


def test_diagnostics_message_replies_with_the_text_and_the_req_id(tmp_path, monkeypatch):
    stub_doctor(monkeypatch)
    h, events = new_host(tmp_path)
    h.log("something worth reading")
    h.handle({"type": "diagnostics", "reqId": 11})
    h.wait(10)
    assert len(events) == 1 and set(events[0]) == {"type", "text", "reqId"}
    assert events[0]["type"] == "diagnostics" and events[0]["reqId"] == 11
    text = events[0]["text"]
    assert "診斷資訊" in text and "something worth reading" in text and "yt-dlp：2099.01.01" in text
    assert "[ok] python" in text


def test_diagnostics_includes_the_last_job_and_redacts(tmp_path, monkeypatch):
    stub_doctor(monkeypatch)
    h, events = new_host(tmp_path)
    h.handle({"type": "download", "quality": 720, "cooldownSec": 0, "items": [{"url": URL, "id": "v1", "title": "t"}]})
    h.wait(10)
    events.clear()
    h.handle({"type": "diagnostics", "reqId": 12})
    h.wait(10)
    text = events[0]["text"]
    assert '"jobId"' in text and '"ok": 1' in text


def test_diagnostics_failure_still_answers_with_an_error(tmp_path, monkeypatch):
    import diagnostics

    def boom(*a, **k):
        raise RuntimeError("cannot build")

    monkeypatch.setattr(diagnostics, "build_report", boom)
    h, events = new_host(tmp_path)
    h.handle({"type": "diagnostics", "reqId": 13})
    h.wait(10)
    assert events[0]["type"] == "error" and events[0]["code"] == "internal" and events[0]["reqId"] == 13


def test_diagnostics_is_a_handled_type():
    assert "diagnostics" in HANDLED
