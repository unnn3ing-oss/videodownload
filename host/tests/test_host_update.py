import hashlib
import shutil
from pathlib import Path

import selfupdate
from host import Host

REAL_HOST = Path(__file__).resolve().parent.parent
COMMIT = "b" * 40
NEW = b'VERSION = "9.9.9"\n'


def blob(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def entry(name: str, data: bytes) -> dict:
    return {"path": name, "sha": blob(data), "size": len(data)}


def new_host(tmp_path):
    home = tmp_path / "home"
    (home / "host").mkdir(parents=True)
    for source in REAL_HOST.glob("*.py"):
        shutil.copy(source, home / "host" / source.name)
    events = []
    return Host(home, events.append), events, home


def stage_request(h, req_id=1):
    h.handle({"type": "update_stage", "reqId": req_id, "commit": COMMIT, "files": [entry("version.py", NEW)]})
    h.wait(10)


def test_update_check_reports_changed_names(tmp_path):
    h, events, home = new_host(tmp_path)
    same = (home / "host" / "quality.py").read_bytes()
    h.handle({"type": "update_check", "reqId": 5, "files": [entry("version.py", NEW), entry("quality.py", same)]})
    assert events == [{"type": "update_status", "changed": ["version.py"], "total": 2, "reqId": 5}]


def test_update_check_rejects_bad_files(tmp_path):
    h, events, _ = new_host(tmp_path)
    h.handle({"type": "update_check", "reqId": 6, "files": [{"path": "../x.py", "sha": "a" * 40, "size": 1}]})
    assert events[0]["type"] == "error" and events[0]["code"] == "update_bad_file" and events[0]["reqId"] == 6


def test_update_stage_commit_flow(tmp_path, monkeypatch):
    h, events, home = new_host(tmp_path)
    monkeypatch.setattr(selfupdate, "http_get", lambda url: NEW)
    stage_request(h)
    assert events[-1] == {"type": "update_staged", "count": 1, "reqId": 1}
    h.handle({"type": "update_commit", "reqId": 2})
    assert events[-1] == {"type": "update_applied", "count": 1, "reqId": 2}
    assert (home / "host" / "version.py").read_bytes() == NEW


def test_update_stage_failure_keeps_host_files(tmp_path, monkeypatch):
    h, events, home = new_host(tmp_path)
    before = (home / "host" / "version.py").read_bytes()
    monkeypatch.setattr(selfupdate, "http_get", lambda url: b"tampered\n")
    stage_request(h)
    assert events[-1]["type"] == "error" and events[-1]["code"] == "update_hash_mismatch"
    assert (home / "host" / "version.py").read_bytes() == before


def test_update_refused_while_job_running(tmp_path, monkeypatch):
    h, events, home = new_host(tmp_path)
    monkeypatch.setattr(selfupdate, "http_get", lambda url: NEW)
    h.runner.running = True
    stage_request(h)
    h.handle({"type": "update_commit", "reqId": 2})
    assert [e["code"] for e in events] == ["busy", "busy"]
    assert not (home / "update").exists()


def test_update_rollback_flow(tmp_path, monkeypatch):
    h, events, home = new_host(tmp_path)
    old = (home / "host" / "version.py").read_bytes()
    monkeypatch.setattr(selfupdate, "http_get", lambda url: NEW)
    stage_request(h)
    h.handle({"type": "update_commit"})
    h.handle({"type": "update_rollback", "reqId": 3})
    assert events[-1] == {"type": "update_rolled_back", "reqId": 3}
    assert (home / "host" / "version.py").read_bytes() == old


def test_update_install_failure_reports_rolled_back(tmp_path, monkeypatch):
    h, events, home = new_host(tmp_path)
    old = (home / "host" / "version.py").read_bytes()
    monkeypatch.setattr(selfupdate, "http_get", lambda url: NEW)
    stage_request(h)

    def boom(src, dst):
        raise OSError("disk full")

    monkeypatch.setattr(selfupdate.os, "replace", boom)
    h.handle({"type": "update_commit", "reqId": 4})
    assert events[-1]["code"] == "update_install_failed" and events[-1]["rolledBack"] is True
    assert (home / "host" / "version.py").read_bytes() == old


def test_update_stage_accepts_base64_contents_without_network(tmp_path, monkeypatch):
    import base64
    h, events, home = new_host(tmp_path)

    def refuse(url):
        raise AssertionError("no network access expected")

    monkeypatch.setattr(selfupdate, "http_get", refuse)
    h.handle({"type": "update_stage", "reqId": 1, "commit": COMMIT, "files": [entry("version.py", NEW)],
              "contents": {"version.py": base64.b64encode(NEW).decode()}})
    h.wait(10)
    assert events[-1] == {"type": "update_staged", "count": 1, "reqId": 1}


def test_update_stage_rejects_malformed_contents(tmp_path):
    h, events, home = new_host(tmp_path)
    for bad in ({"version.py": "***not base64***"}, {"other.py": "eA=="}, ["x"], {"version.py": 5}):
        h.handle({"type": "update_stage", "reqId": 1, "commit": COMMIT, "files": [entry("version.py", NEW)],
                  "contents": bad})
        h.wait(10)
        assert events[-1]["type"] == "error" and events[-1]["code"] == "update_bad_file", bad
    assert not (home / "update" / "staging").exists()
