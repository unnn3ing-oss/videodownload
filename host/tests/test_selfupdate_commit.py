import json
import os
import py_compile
import re
import shutil
from importlib.util import cache_from_source
from pathlib import Path

import pytest

import selfupdate
from selfupdate import UpdateError, commit_update, rollback_update

REAL_HOST = Path(__file__).resolve().parent.parent


def make_home(tmp_path: Path) -> Path:
    home = tmp_path / "home"
    (home / "host").mkdir(parents=True)
    for source in REAL_HOST.glob("*.py"):
        shutil.copy(source, home / "host" / source.name)
    return home


def put_staged(home: Path, files: dict) -> None:
    staging = home / "update" / "staging"
    staging.mkdir(parents=True)
    for name, data in files.items():
        (staging / name).write_bytes(data)
    (staging / "_files.json").write_text(json.dumps(list(files)), encoding="utf-8")


def host_file(home: Path, name: str) -> bytes:
    return (home / "host" / name).read_bytes()


def test_commit_replaces_files_and_keeps_backup(tmp_path):
    home = make_home(tmp_path)
    old = host_file(home, "version.py")
    put_staged(home, {"version.py": b'VERSION = "9.9.9"\n', "extra.py": b"X = 1\n"})
    assert commit_update(home) == 2
    assert host_file(home, "version.py") == b'VERSION = "9.9.9"\n'
    assert host_file(home, "extra.py") == b"X = 1\n"
    assert (home / "backup" / "host" / "version.py").read_bytes() == old
    assert json.loads((home / "backup" / "host" / "_backup.json").read_text()) == {
        "replaced": ["version.py"], "added": ["extra.py"]}
    assert not (home / "update" / "staging").exists()


def test_commit_without_staging_raises_nothing_staged(tmp_path):
    with pytest.raises(UpdateError) as exc:
        commit_update(make_home(tmp_path))
    assert exc.value.code == "update_nothing_staged"


def test_commit_failure_midway_restores_everything(tmp_path, monkeypatch):
    home = make_home(tmp_path)
    before = {n: host_file(home, n) for n in ("version.py", "quality.py")}
    put_staged(home, {"version.py": b"V = 1\n", "extra.py": b"X = 1\n", "quality.py": b"Q = 1\n"})
    real_replace, calls = selfupdate.os.replace, []

    def flaky(src, dst):
        calls.append(dst)
        if len(calls) == 3:
            raise OSError("disk full")
        return real_replace(src, dst)

    monkeypatch.setattr(selfupdate.os, "replace", flaky)
    with pytest.raises(UpdateError) as exc:
        commit_update(home)
    assert exc.value.code == "update_install_failed" and exc.value.rolled_back is True
    assert {n: host_file(home, n) for n in before} == before
    assert not (home / "host" / "extra.py").exists()


def test_rollback_restores_previous_version_and_removes_added_files(tmp_path):
    home = make_home(tmp_path)
    old = host_file(home, "version.py")
    put_staged(home, {"version.py": b'VERSION = "9.9.9"\n', "extra.py": b"X = 1\n"})
    commit_update(home)
    assert rollback_update(home) == 2
    assert host_file(home, "version.py") == old
    assert not (home / "host" / "extra.py").exists()


def test_rollback_without_backup_raises(tmp_path):
    with pytest.raises(UpdateError) as exc:
        rollback_update(make_home(tmp_path))
    assert exc.value.code == "update_nothing_staged"


def test_only_one_previous_version_is_kept(tmp_path):
    home = make_home(tmp_path)
    put_staged(home, {"version.py": b'VERSION = "2.0.0"\n'})
    commit_update(home)
    put_staged(home, {"version.py": b'VERSION = "3.0.0"\n'})
    commit_update(home)
    assert (home / "backup" / "host" / "version.py").read_bytes() == b'VERSION = "2.0.0"\n'


def plant_bytecode(home: Path) -> Path:
    cache = home / "host" / "__pycache__"
    cache.mkdir()
    (cache / "version.cpython-312.pyc").write_bytes(b"stale")
    return cache


def test_commit_drops_cached_bytecode_so_a_same_size_file_is_not_run_from_an_old_cache(tmp_path):
    home = make_home(tmp_path)
    cache = plant_bytecode(home)
    put_staged(home, {"version.py": b'VERSION = "9.9.9"\n'})
    commit_update(home)
    assert not cache.exists()


def test_rollback_drops_cached_bytecode(tmp_path):
    home = make_home(tmp_path)
    put_staged(home, {"version.py": b'VERSION = "9.9.9"\n'})
    commit_update(home)
    cache = plant_bytecode(home)
    rollback_update(home)
    assert not cache.exists()


# -- the smoke check after the swap, and the marker ---------------------------------------------------

def snapshot(home: Path) -> dict:
    return {p.name: p.read_bytes() for p in (home / "host").glob("*.py")}


def pending(home: Path) -> dict:
    return json.loads((home / "update-pending.json").read_text(encoding="utf-8"))


def test_commit_writes_the_pending_marker_for_the_next_start(tmp_path):
    home = make_home(tmp_path)
    put_staged(home, {"version.py": b'VERSION = "9.9.9"\n'})
    commit_update(home)
    marker = pending(home)
    assert marker["version"] == "9.9.9" and marker["backupDir"] == str(home / "backup" / "host")
    assert isinstance(marker["time"], int) and marker["started"] is None


def test_rollback_removes_the_marker(tmp_path):
    home = make_home(tmp_path)
    put_staged(home, {"version.py": b'VERSION = "9.9.9"\n'})
    commit_update(home)
    rollback_update(home)
    assert not (home / "update-pending.json").exists()


BROKEN = {
    "syntax error": {"ytdlp.py": b"def broken(:\n"},
    "import error": {"quality.py": b"import a_module_that_does_not_exist\n"},
    "error at import time": {"security.py": b"raise RuntimeError('boom at import')\n"},
    "no VERSION": {"version.py": b"V = 1\n"},
    "VERSION is not text": {"version.py": b"VERSION = 5\n"},
}


@pytest.mark.parametrize("name", list(BROKEN))
def test_a_broken_update_is_rolled_back_at_once(tmp_path, name):
    home = make_home(tmp_path)
    before = snapshot(home)
    put_staged(home, {**BROKEN[name], "extra.py": b"X = 1\n"})
    with pytest.raises(UpdateError) as exc:
        commit_update(home)
    assert exc.value.code == "selfcheck_failed" and exc.value.rolled_back is True
    assert exc.value.detail.strip()
    assert snapshot(home) == before  # the old files are intact and nothing was left behind
    assert not (home / "update-pending.json").exists() and not (home / "update" / "staging").exists()


def test_selfcheck_failure_message_carries_the_captured_error(tmp_path):
    home = make_home(tmp_path)
    put_staged(home, {"quality.py": b"import a_module_that_does_not_exist\n"})
    with pytest.raises(UpdateError) as exc:
        commit_update(home)
    assert "a_module_that_does_not_exist" in exc.value.message and "已還原" in exc.value.message
    assert "Traceback" in exc.value.detail


def test_selfcheck_failure_when_the_restore_also_fails_says_so(tmp_path, monkeypatch):
    home = make_home(tmp_path)
    put_staged(home, {"quality.py": b"import a_module_that_does_not_exist\n"})

    def broken_restore(home):
        raise OSError("read-only")

    monkeypatch.setattr(selfupdate, "_restore", broken_restore)
    with pytest.raises(UpdateError) as exc:
        commit_update(home)
    assert exc.value.code == "selfcheck_failed" and exc.value.rolled_back is False
    assert "安裝檔" in exc.value.message


def test_the_smoke_check_times_out_instead_of_hanging(tmp_path, monkeypatch):
    home = make_home(tmp_path)
    put_staged(home, {"version.py": b'VERSION = "9.9.9"\n'})
    monkeypatch.setattr(selfupdate, "SMOKE_TIMEOUT", 0.01)
    (home / "host" / "host.py").write_text("import time\ntime.sleep(30)\n", encoding="utf-8")
    before = snapshot(home)
    with pytest.raises(UpdateError) as exc:
        commit_update(home)
    assert exc.value.code == "selfcheck_failed" and exc.value.rolled_back is True
    assert snapshot(home) == before


def stale_bytecode_setup(home: Path) -> bytes:
    """A cached .pyc of the OLD version.py that Python would trust for a NEW file of the same size and date."""
    stamp = 1_700_000_000
    old = home / "host" / "version.py"
    os.utime(old, (stamp, stamp))
    cache = cache_from_source(str(old))
    Path(cache).parent.mkdir(exist_ok=True)
    py_compile.compile(str(old), cfile=cache, doraise=True)
    text = old.read_bytes()
    current = re.search(rb'VERSION = "([^"]+)"', text).group(1)
    new = text.replace(current, b"9" * len(current))  # same size on purpose
    put_staged(home, {"version.py": new})
    os.utime(home / "update" / "staging" / "version.py", (stamp, stamp))  # the fixed timestamp of a zip's files
    return new


def test_stale_bytecode_would_run_the_old_version_and_the_smoke_check_notices(tmp_path, monkeypatch):
    home = make_home(tmp_path)
    before = snapshot(home)
    stale_bytecode_setup(home)
    monkeypatch.setattr(selfupdate, "_drop_bytecode", lambda host_dir: None)  # what the fix prevents
    with pytest.raises(UpdateError) as exc:
        commit_update(home)
    assert exc.value.code == "selfcheck_failed" and "VERSION" in exc.value.detail
    assert snapshot(home) == before


def test_dropping_bytecode_before_the_check_lets_a_same_size_update_through(tmp_path):
    home = make_home(tmp_path)
    new = stale_bytecode_setup(home)
    assert commit_update(home) == 1
    assert host_file(home, "version.py") == new
    assert not (home / "host" / "__pycache__").exists()  # the check leaves no bytecode behind (python -B)


def test_smoke_check_is_a_separate_python_process(tmp_path, monkeypatch):
    home = make_home(tmp_path)
    put_staged(home, {"version.py": b'VERSION = "9.9.9"\n'})
    seen = []
    real_run = selfupdate.subprocess.run

    def spy(cmd, **kwargs):
        seen.append((cmd, kwargs))
        return real_run(cmd, **kwargs)

    monkeypatch.setattr(selfupdate.subprocess, "run", spy)
    commit_update(home)
    cmd, kwargs = seen[-1]
    assert "--selfcheck" in cmd and cmd[cmd.index("--selfcheck") - 1] == str(home / "host" / "host.py")
    assert kwargs["stdin"] is selfupdate.subprocess.DEVNULL and kwargs["timeout"] == 30
