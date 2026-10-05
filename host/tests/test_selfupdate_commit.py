import json
import shutil
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
    put_staged(home, {"version.py": b"V = 2\n"})
    commit_update(home)
    put_staged(home, {"version.py": b"V = 3\n"})
    commit_update(home)
    assert (home / "backup" / "host" / "version.py").read_bytes() == b"V = 2\n"
