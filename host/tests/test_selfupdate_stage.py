import hashlib
import shutil
from pathlib import Path

import pytest

from selfupdate import RAW_BASE, UpdateError, self_check, stage

REAL_HOST = Path(__file__).resolve().parent.parent
COMMIT = "a" * 40
NEW_VERSION = b'VERSION = "9.9.9"\n'


def blob(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def entry(name: str, data: bytes) -> dict:
    return {"path": name, "sha": blob(data), "size": len(data)}


def make_home(tmp_path: Path) -> Path:
    home = tmp_path / "home"
    (home / "host").mkdir(parents=True)
    for source in REAL_HOST.glob("*.py"):
        shutil.copy(source, home / "host" / source.name)
    return home


def staging(home: Path) -> Path:
    return home / "update" / "staging"


def test_stage_downloads_verifies_and_writes(tmp_path):
    home = make_home(tmp_path)
    urls = []

    def fetch(url):
        urls.append(url)
        return NEW_VERSION

    assert stage(home, COMMIT, [entry("version.py", NEW_VERSION)], fetch) == 1
    assert urls == [f"{RAW_BASE}/{COMMIT}/host/version.py"]
    assert (staging(home) / "version.py").read_bytes() == NEW_VERSION


def test_stage_rejects_hash_mismatch_and_leaves_no_staging(tmp_path):
    home = make_home(tmp_path)
    with pytest.raises(UpdateError) as exc:
        stage(home, COMMIT, [entry("version.py", NEW_VERSION)], lambda url: b"tampered\n")
    assert exc.value.code == "update_hash_mismatch"
    assert not staging(home).exists()


def test_stage_reports_download_failure(tmp_path):
    home = make_home(tmp_path)

    def fetch(url):
        raise OSError("network down")

    with pytest.raises(UpdateError) as exc:
        stage(home, COMMIT, [entry("version.py", NEW_VERSION)], fetch)
    assert exc.value.code == "update_download_failed"
    assert not staging(home).exists()


@pytest.mark.parametrize("commit", ["main", "abc", "A" * 40, "g" * 40, None])
def test_stage_rejects_bad_commit(tmp_path, commit):
    with pytest.raises(UpdateError) as exc:
        stage(make_home(tmp_path), commit, [entry("version.py", NEW_VERSION)], lambda url: NEW_VERSION)
    assert exc.value.code == "update_bad_file"


def test_stage_with_nothing_to_stage(tmp_path):
    with pytest.raises(UpdateError) as exc:
        stage(make_home(tmp_path), COMMIT, [], lambda url: b"")
    assert exc.value.code == "update_nothing_staged"


def test_stage_clears_previous_staging(tmp_path):
    home = make_home(tmp_path)
    staging(home).mkdir(parents=True)
    (staging(home) / "old.py").write_text("stale")
    stage(home, COMMIT, [entry("version.py", NEW_VERSION)], lambda url: NEW_VERSION)
    assert not (staging(home) / "old.py").exists()


def test_self_check_rejects_broken_overlay(tmp_path):
    home = make_home(tmp_path)
    original = (home / "host" / "host.py").read_bytes()
    broken = b"def (\n"
    with pytest.raises(UpdateError) as exc:
        stage(home, COMMIT, [entry("host.py", broken)], lambda url: broken)
    assert exc.value.code == "update_selfcheck_failed"
    assert not staging(home).exists()
    assert (home / "host" / "host.py").read_bytes() == original


def test_self_check_accepts_consistent_overlay(tmp_path):
    home = make_home(tmp_path)
    stage(home, COMMIT, [entry("version.py", NEW_VERSION)], lambda url: NEW_VERSION)
    self_check(home)  # staged files overlaid on the installed ones import cleanly
    assert not (home / "update" / "check").exists()
