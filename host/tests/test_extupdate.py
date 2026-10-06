import base64
import hashlib
import json
import shutil
from pathlib import Path

import pytest

import extupdate
from extupdate import ExtUpdateError
from install_record import EXTENSION_NAME, write_record
from host import Host

REAL_HOST = Path(__file__).resolve().parent.parent


def blob(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def entry(path: str, data: bytes) -> dict:
    return {"path": path, "sha": blob(data), "size": len(data)}


def installed(tmp_path):
    home = tmp_path / "home"
    ext = tmp_path / "ext"
    (ext / "lib").mkdir(parents=True)
    (ext / "manifest.json").write_text(json.dumps({"name": EXTENSION_NAME, "version": "1"}))
    (ext / "background.js").write_text("// old")
    (ext / "lib/a.js").write_text("// old a")
    write_record(home, extension_folder=ext, version="1")
    return home, ext


MANIFEST = json.dumps({"name": EXTENSION_NAME, "version": "2"}).encode()


def files(**named):
    return [entry(p, d) for p, d in named.items()], dict(named)


def test_changed_files_are_written_and_the_manifest_goes_last(tmp_path):
    home, ext = installed(tmp_path)
    listed = [entry("manifest.json", MANIFEST), entry("background.js", b"// new"), entry("lib/b.js", b"// b")]
    order = []
    count = extupdate.apply(home, listed, {"manifest.json": MANIFEST, "background.js": b"// new", "lib/b.js": b"// b"}, on_write=order.append)
    assert count == 3 and order[-1] == "manifest.json"
    assert (ext / "background.js").read_text() == "// new" and (ext / "lib/b.js").read_text() == "// b"
    assert json.loads((ext / "manifest.json").read_text())["version"] == "2"
    assert (ext / "lib/a.js").read_text() == "// old a", "files that were not listed are left alone"


def test_a_file_that_does_not_match_its_hash_stops_everything_before_anything_is_written(tmp_path):
    home, ext = installed(tmp_path)
    listed = [entry("background.js", b"// new"), entry("lib/a.js", b"// expected")]
    with pytest.raises(ExtUpdateError, match="不一致"):
        extupdate.apply(home, listed, {"background.js": b"// new", "lib/a.js": b"// tampered"})
    assert (ext / "background.js").read_text() == "// old"


@pytest.mark.parametrize("bad", ["../x.js", "/x.js", "a/../../x.js", "C:/x.js", "a\\b.js", ".git/config", ""])
def test_unsafe_paths_are_refused(tmp_path, bad):
    home, ext = installed(tmp_path)
    with pytest.raises(ExtUpdateError, match="不合規"):
        extupdate.apply(home, [entry(bad, b"x")], {bad: b"x"})


def test_an_update_needs_the_recorded_folder_to_still_be_the_extension(tmp_path):
    home = tmp_path / "home"
    with pytest.raises(ExtUpdateError, match="不知道擴充功能資料夾"):
        extupdate.apply(home, [entry("a.js", b"x")], {"a.js": b"x"})
    home, ext = installed(tmp_path)
    (ext / "manifest.json").unlink()
    with pytest.raises(ExtUpdateError, match="不知道擴充功能資料夾"):
        extupdate.apply(home, [entry("a.js", b"x")], {"a.js": b"x"})


def test_rollback_puts_back_what_the_update_replaced_and_removes_what_it_added(tmp_path):
    home, ext = installed(tmp_path)
    extupdate.apply(home, [entry("background.js", b"// new"), entry("lib/b.js", b"// b")], {"background.js": b"// new", "lib/b.js": b"// b"})
    assert extupdate.rollback(home) == 2
    assert (ext / "background.js").read_text() == "// old" and not (ext / "lib/b.js").exists()
    with pytest.raises(ExtUpdateError, match="沒有可還原"):
        extupdate.rollback(home)


def test_a_write_that_fails_halfway_restores_the_files_already_replaced(tmp_path, monkeypatch):
    home, ext = installed(tmp_path)
    real = extupdate.os.replace
    calls = []

    def flaky(src, dst):
        calls.append(dst)
        if len(calls) == 2:
            raise OSError("disk full")
        return real(src, dst)

    monkeypatch.setattr(extupdate.os, "replace", flaky)
    with pytest.raises(ExtUpdateError, match="已還原"):
        extupdate.apply(home, [entry("background.js", b"// new"), entry("lib/a.js", b"// new a")], {"background.js": b"// new", "lib/a.js": b"// new a"})
    assert (ext / "background.js").read_text() == "// old" and (ext / "lib/a.js").read_text() == "// old a"


def test_missing_contents_and_oversized_lists_are_refused(tmp_path):
    home, ext = installed(tmp_path)
    with pytest.raises(ExtUpdateError):
        extupdate.apply(home, [entry("background.js", b"x")], {})
    many = [entry(f"f{i}.js", b"x") for i in range(extupdate.MAX_FILES + 1)]
    with pytest.raises(ExtUpdateError, match="超過"):
        extupdate.apply(home, many, {e["path"]: b"x" for e in many})


# ---------------------------------------------------------------- through the host's messages

def new_host(tmp_path):
    home, ext = installed(tmp_path)
    (home / "host").mkdir(exist_ok=True)
    for source in REAL_HOST.glob("*.py"):
        shutil.copy(source, home / "host" / source.name)
    events = []
    return Host(home, events.append), events, home, ext


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def test_the_host_applies_and_rolls_back_an_extension_update(tmp_path):
    h, events, home, ext = new_host(tmp_path)
    h.handle({"type": "update_ext", "reqId": 1, "files": [entry("background.js", b"// new")], "contents": {"background.js": b64(b"// new")}})
    h.wait(10)
    assert events[-1] == {"type": "update_ext_applied", "count": 1, "folder": str(ext), "reqId": 1}
    assert (ext / "background.js").read_text() == "// new"
    h.handle({"type": "update_ext_rollback", "reqId": 2})
    assert events[-1] == {"type": "update_ext_rolled_back", "reqId": 2} and (ext / "background.js").read_text() == "// old"


def test_the_host_says_where_the_extension_is_when_asked_to_check(tmp_path):
    h, events, home, ext = new_host(tmp_path)
    h.handle({"type": "update_check", "reqId": 3, "files": []})
    assert events[-1]["extensionFolder"] == str(ext)
    h2, events2, _, _ = new_host(tmp_path / "other")
    (h2.home / "install.json").unlink()
    h2.handle({"type": "update_check", "reqId": 4, "files": []})
    assert events2[-1]["extensionFolder"] is None


def test_a_bad_extension_update_request_gets_an_error_reply_not_a_crash(tmp_path):
    h, events, home, ext = new_host(tmp_path)
    h.handle({"type": "update_ext", "reqId": 5, "files": "nope", "contents": {}})
    h.wait(10)
    assert events[-1]["type"] == "error" and events[-1]["reqId"] == 5
    h.handle({"type": "update_ext", "reqId": 6, "files": [entry("a.js", b"x")], "contents": {"a.js": "***not base64***"}})
    h.wait(10)
    assert events[-1]["type"] == "error"


# ---------------------------------------------------------------- found in review

def test_a_failure_while_making_the_backup_is_an_update_error_not_a_dead_thread(tmp_path, monkeypatch):
    home, ext = installed(tmp_path)
    monkeypatch.setattr(extupdate.shutil, "copy2", lambda *a, **k: (_ for _ in ()).throw(OSError("read-only")))
    with pytest.raises(ExtUpdateError, match="備份"):
        extupdate.apply(home, [entry("background.js", b"// new")], {"background.js": b"// new"})
    assert (ext / "background.js").read_text() == "// old"


def test_a_restore_that_fails_is_not_reported_as_restored(tmp_path, monkeypatch):
    home, ext = installed(tmp_path)
    real = extupdate.os.replace
    calls = []

    def flaky(src, dst):
        calls.append(dst)
        if len(calls) == 2:
            raise OSError("disk full")
        return real(src, dst)

    monkeypatch.setattr(extupdate.os, "replace", flaky)
    monkeypatch.setattr(extupdate, "_restore", lambda *a: (_ for _ in ()).throw(OSError("locked")))
    with pytest.raises(ExtUpdateError) as caught:
        extupdate.apply(home, [entry("background.js", b"// new"), entry("lib/a.js", b"// new a")], {"background.js": b"// new", "lib/a.js": b"// new a"})
    assert "還原也失敗" in caught.value.message and caught.value.rolled_back is False


def test_an_unexpected_error_in_the_update_still_gets_an_error_reply(tmp_path, monkeypatch):
    h, events, home, ext = new_host(tmp_path)
    monkeypatch.setattr(extupdate, "apply", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    h.handle({"type": "update_ext", "reqId": 9, "files": [entry("a.js", b"x")], "contents": {"a.js": b64(b"x")}})
    h.wait(10)
    assert events[-1]["type"] == "error" and events[-1]["reqId"] == 9 and "boom" in events[-1]["message"]
