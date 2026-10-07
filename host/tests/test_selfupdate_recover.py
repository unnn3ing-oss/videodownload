"""A commit that passed the smoke check but still cannot start is taken back by the next start."""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

import selfupdate
from protocol import write_message
from selfupdate import TRIAL_GRACE, clear_pending, commit_update, recover_pending_update
from test_selfupdate_commit import make_home, pending, put_staged, snapshot
from protocol import read_message
import io

REAL_HOST = Path(__file__).resolve().parent.parent
T0 = 1_000_000


def committed(tmp_path: Path, files=None) -> Path:
    home = make_home(tmp_path)
    put_staged(home, files or {"version.py": b'VERSION = "9.9.9"\n'})
    commit_update(home)
    return home


def set_marker(home: Path, **changes) -> None:
    marker = {**pending(home), **changes}
    (home / "update-pending.json").write_text(json.dumps(marker), encoding="utf-8")


# -- recover_pending_update ---------------------------------------------------------------------------

def test_without_a_marker_nothing_happens(tmp_path):
    assert recover_pending_update(make_home(tmp_path)) == "none"


def test_the_first_start_after_a_commit_becomes_the_trial_and_changes_no_file(tmp_path):
    home = committed(tmp_path)
    after_commit = snapshot(home)
    assert recover_pending_update(home, now=T0) == "first_start"
    assert pending(home)["started"] == T0 and snapshot(home) == after_commit


def test_a_second_start_right_after_the_first_is_left_alone(tmp_path):
    home = committed(tmp_path)
    recover_pending_update(home, now=T0)
    after_commit = snapshot(home)
    assert recover_pending_update(home, now=T0 + TRIAL_GRACE - 1) == "concurrent"
    assert pending(home)["started"] == T0 and snapshot(home) == after_commit


def test_a_trial_that_never_reached_ready_is_restored_once(tmp_path):
    home = make_home(tmp_path)
    before = snapshot(home)
    put_staged(home, {"version.py": b'VERSION = "9.9.9"\n', "extra.py": b"X = 1\n"})
    commit_update(home)
    recover_pending_update(home, now=T0)
    logged = []
    assert recover_pending_update(home, now=T0 + TRIAL_GRACE + 1, log=logged.append) == "restored"
    assert snapshot(home) == before  # old files back, the added one gone
    assert not (home / "update-pending.json").exists()
    assert any("never reached ready" in m for m in logged)
    assert recover_pending_update(home, now=T0 + 1000) == "none"  # never twice for one marker


def test_without_a_backup_the_marker_is_still_dropped_so_it_cannot_loop(tmp_path):
    home = committed(tmp_path)
    shutil.rmtree(home / "backup")
    recover_pending_update(home, now=T0)
    assert recover_pending_update(home, now=T0 + 1000) == "restore_failed"
    assert not (home / "update-pending.json").exists()


def test_an_unreadable_marker_is_dropped(tmp_path):
    home = make_home(tmp_path)
    (home / "update-pending.json").write_text("{not json", encoding="utf-8")
    assert recover_pending_update(home) == "none" and not (home / "update-pending.json").exists()


def test_clear_pending_is_quiet_when_there_is_no_marker(tmp_path):
    clear_pending(make_home(tmp_path))


# -- the real host, started like Chrome starts it -----------------------------------------------------

def run_host(home: Path, *messages: dict, timeout: float = 60):
    stdin = io.BytesIO()
    for message in messages:
        write_message(stdin, message)
    done = subprocess.run([sys.executable, str(home / "host" / "host.py"), "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"],
                          input=stdin.getvalue(), capture_output=True, timeout=timeout,
                          env={**os.environ, "YTDL_HOME": str(home)})
    out, types = io.BytesIO(done.stdout), []
    while (message := read_message(out)) is not None:
        types.append(message["type"])
    return done, types


def crashing_host_py() -> bytes:
    source = (REAL_HOST / "host.py").read_text(encoding="utf-8")
    anchor = "        host = Host(home, emit, log)\n"
    assert anchor in source, "the anchor this test breaks the new host at has moved"
    return source.replace(anchor, anchor + '        raise RuntimeError("new version cannot start")\n').encode("utf-8")


def test_selfcheck_flag_prints_ok_and_leaves_no_trace(tmp_path):
    home = make_home(tmp_path)
    done = subprocess.run([sys.executable, "-B", str(home / "host" / "host.py"), "--selfcheck"], stdin=subprocess.DEVNULL,
                          capture_output=True, text=True, timeout=60, env={**os.environ, "YTDL_HOME": str(home)})
    assert done.returncode == 0 and done.stdout.strip() == "OK"
    assert sorted(p.name for p in home.iterdir()) == ["host"]  # no logs folder, no marker


def test_a_good_update_clears_its_marker_once_ready_is_sent(tmp_path):
    home = committed(tmp_path)
    done, types = run_host(home, {"type": "ping"})
    assert done.returncode == 0 and types == ["ready", "pong"]
    assert not (home / "update-pending.json").exists()
    assert (home / "host" / "version.py").read_bytes() == b'VERSION = "9.9.9"\n'


def test_a_bad_update_that_slipped_through_is_restored_by_a_later_start(tmp_path):
    home = make_home(tmp_path)
    before = snapshot(home)
    put_staged(home, {"host.py": crashing_host_py()})
    commit_update(home)  # imports fine, so the smoke check cannot see this one
    assert (home / "host" / "host.py").read_bytes() == crashing_host_py()

    done, types = run_host(home, {"type": "ping"})  # the trial start: crashes before ready
    assert done.returncode != 0 and types == [] and b"new version cannot start" in done.stderr
    assert pending(home)["started"] is not None
    done, types = run_host(home, {"type": "ping"})  # right after: a parallel start, left alone (and crashes as well)
    assert done.returncode != 0 and (home / "update-pending.json").exists()

    set_marker(home, started=pending(home)["started"] - 3600)  # the person tries again later
    done, types = run_host(home, {"type": "ping", "reqId": 1})
    assert done.returncode == 0 and types == ["ready", "pong"]  # restored, and this very start works
    assert snapshot(home) == before
    assert not (home / "update-pending.json").exists()
    log = (home / "logs" / "host.log").read_text(encoding="utf-8")
    assert "never reached ready" in log and "restored the previous files" in log and "new version cannot start" in log
    done, types = run_host(home, {"type": "ping"})
    assert types == ["ready", "pong"]


def test_a_marker_whose_restore_is_impossible_does_not_stop_the_host(tmp_path):
    home = committed(tmp_path)
    shutil.rmtree(home / "backup")
    set_marker(home, started=1)  # long ago
    done, types = run_host(home, {"type": "ping"})
    assert done.returncode == 0 and types == ["ready", "pong"]
    assert not (home / "update-pending.json").exists()
