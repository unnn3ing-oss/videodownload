import sys
from pathlib import Path

import hidden
from hidden import FILE_ATTRIBUTE_HIDDEN, hide


class Kernel32:
    def __init__(self, attrs=0x20, fail=None):
        self.attrs = attrs
        self.fail = fail
        self.set_calls = []

    def GetFileAttributesW(self, path):
        if self.fail:
            raise self.fail
        return self.attrs

    def SetFileAttributesW(self, path, attrs):
        self.set_calls.append((path, attrs))
        return 1


def test_windows_adds_the_hidden_flag_and_keeps_the_others(tmp_path):
    k = Kernel32(attrs=0x20)
    assert hide(tmp_path / ".ytdl-archive.json", platform="win32", kernel32=k) is True
    assert k.set_calls == [(str(tmp_path / ".ytdl-archive.json"), 0x20 | FILE_ATTRIBUTE_HIDDEN)]


def test_windows_missing_file_is_left_alone(tmp_path):
    k = Kernel32(attrs=0xFFFFFFFF)  # INVALID_FILE_ATTRIBUTES
    assert hide(tmp_path / "gone", platform="win32", kernel32=k) is False
    assert k.set_calls == []


def test_other_systems_do_nothing(tmp_path):
    k = Kernel32()
    assert hide(tmp_path / ".ytdl-archive.json", platform="darwin", kernel32=k) is False
    assert k.set_calls == []


def test_a_failing_system_call_never_raises(tmp_path):
    assert hide(tmp_path / "x", platform="win32", kernel32=Kernel32(fail=OSError("denied"))) is False
    assert hide(tmp_path / "x", platform="win32", kernel32=Kernel32(fail=AttributeError("no windll"))) is False


def test_without_a_kernel32_it_is_a_no_op_off_windows(tmp_path):
    (tmp_path / "f").write_text("x")
    assert hide(tmp_path / "f", platform=sys.platform if sys.platform != "win32" else "linux") is False
    assert (tmp_path / "f").read_text() == "x"
