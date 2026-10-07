import os

import pytest

import hostlog
from hostlog import HostLog, clip, redact, tail_lines


# -- redact ----------------------------------------------------------------------------------

def test_redact_replaces_a_posix_home_with_a_tilde():
    assert redact("open /home/alice/Downloads/a.mp4 failed", home="/home/alice", user="") == \
        "open ~/Downloads/a.mp4 failed"


def test_redact_handles_windows_backslashes_forward_slashes_and_mixes():
    home = r"C:\Users\alice"
    assert redact(r"C:\Users\alice\AppData\x.log", home=home, user="") == r"~\AppData\x.log"
    assert redact("C:/Users/alice/AppData/x.log", home=home, user="") == "~/AppData/x.log"
    assert redact(r"C:/Users\alice/AppData", home=home, user="") == "~/AppData"
    assert redact("C:/Users/alice/x", home="C:/Users/alice", user="") == "~/x"


def test_redact_handles_json_escaped_backslashes():
    assert redact(r'{"path": "C:\\Users\\alice\\bin"}', home=r"C:\Users\alice", user="") == r'{"path": "~\\bin"}'


def test_redact_is_case_insensitive_on_windows_only():
    assert redact(r"c:\users\ALICE\x", home=r"C:\Users\alice", user="", ignore_case=True) == r"~\x"
    assert redact("/home/ALICE/x", home="/home/alice", user="", ignore_case=False) == "/home/ALICE/x"


def test_redact_does_not_touch_a_longer_sibling_name():
    assert redact("/home/alice2/x /mnt/home/alice/x", home="/home/alice", user="") == "/home/alice2/x /mnt/home/alice/x"


def test_redact_replaces_the_user_name_as_a_whole_word():
    out = redact("user alice ran as ALICE; malice and alice2 stay", home="", user="alice", ignore_case=True)
    assert out == "user <user> ran as <user>; malice and alice2 stay"


def test_redact_replaces_the_home_before_the_user_name():
    assert redact("/Users/bob/x by bob", home="/Users/bob", user="bob") == "~/x by <user>"


def test_redact_short_user_names_only_as_a_path_segment():
    assert redact(r"D:\al\x and al ran", home="", user="al") == r"D:\<user>\x and al ran"


def test_redact_with_nothing_to_hide_returns_the_text():
    assert redact("plain", home="", user="") == "plain"
    assert redact("a/b", home="/", user="") == "a/b"  # a root "home" would eat every path


def test_redact_detects_home_and_user_from_the_environment(monkeypatch, tmp_path):
    home = tmp_path / "carol"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("LOGNAME", "carol")
    monkeypatch.setenv("USER", "carol")
    monkeypatch.setenv("USERNAME", "carol")
    assert redact(f"{home}/bin by carol") == "~/bin by <user>"


# -- clip / tail_lines -------------------------------------------------------------------------

def test_clip_truncates_long_text():
    assert clip("x" * 200, 120) == "x" * 120 + "…"
    assert clip("short", 120) == "short"


def test_tail_lines_keeps_the_last_lines_and_limits_the_size():
    text = "\n".join(f"line {i}" for i in range(40))
    out = tail_lines(text, lines=15)
    assert out.splitlines()[-1].strip() == "line 39" and len(out.splitlines()) == 15
    assert "line 24" not in out
    big = tail_lines("\n".join("y" * 300 for _ in range(15)), lines=15, limit=2048)
    assert len(big) <= 2048 + 1 and big.rstrip().endswith("y" * 10)


# -- HostLog -------------------------------------------------------------------------------------

def make_log(tmp_path, **kw):
    kw.setdefault("home_dir", "")
    kw.setdefault("user", "")
    return HostLog(tmp_path / "home", **kw)


def test_log_creates_the_directory_lazily_and_writes_utf8(tmp_path):
    log = make_log(tmp_path)
    assert not (tmp_path / "home").exists()
    log("下載助手 啟動")
    text = (tmp_path / "home" / "logs" / "host.log").read_text(encoding="utf-8")
    assert text.endswith("下載助手 啟動\n") and text[:4].isdigit()


def test_log_redacts_before_writing(tmp_path):
    log = make_log(tmp_path, home_dir="/home/alice", user="alice")
    log("engine at /home/alice/bin by alice")
    text = log.path.read_text(encoding="utf-8")
    assert "alice" not in text and "~/bin by <user>" in text


def test_log_rotates_keeping_a_fixed_number_of_files(tmp_path):
    log = make_log(tmp_path, max_bytes=300, files=3)
    for i in range(60):
        log(f"entry {i:03d} " + "z" * 40)
    names = sorted(p.name for p in log.path.parent.iterdir())
    assert names == ["host.log", "host.log.1", "host.log.2"]
    assert "entry 059" in log.path.read_text(encoding="utf-8")
    assert all(p.stat().st_size < 600 for p in log.path.parent.iterdir())


def test_log_never_raises_when_the_directory_cannot_be_created(tmp_path):
    (tmp_path / "home").write_text("a file where the home folder should be", encoding="utf-8")
    log = make_log(tmp_path)
    log("still fine")
    log.exception("also fine")


def test_log_never_raises_on_odd_input(tmp_path):
    log = make_log(tmp_path)
    log("lone surrogate \ud800 survives")
    log(None)  # type: ignore[arg-type]
    assert "lone surrogate" in log.path.read_text(encoding="utf-8")


def test_log_swallows_os_errors_from_the_file_system(tmp_path, monkeypatch):
    log = make_log(tmp_path)

    def refuse(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(hostlog.os, "makedirs", refuse, raising=False)
    monkeypatch.setattr("builtins.open", refuse)
    log("nothing to write to")


def test_exception_logs_the_context_and_the_traceback(tmp_path):
    log = make_log(tmp_path)
    try:
        raise ValueError("kaboom")
    except ValueError:
        log.exception("handler failed")
    text = log.path.read_text(encoding="utf-8")
    assert "handler failed" in text and "Traceback" in text and "ValueError: kaboom" in text


def test_default_home_is_the_one_the_host_uses(tmp_path):
    assert HostLog(tmp_path).path == tmp_path / "logs" / "host.log"
    assert os.fspath(HostLog(tmp_path).path).endswith(os.path.join("logs", "host.log"))
