import hashlib
import io
import zipfile
from pathlib import Path

import pytest

import install_record
import winengine
from macos_engine import EngineInstallError
from winengine import EngineBlocked, install

EXE_BYTES = b"MZ fake yt-dlp"
VIRUS = "[WinError 225] Operation did not complete successfully because the file contains a virus or potentially unwanted software"
DENIED = "[WinError 5] Access is denied"


def make_zip(entries=None, exe=EXE_BYTES) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        if entries is None:
            z.writestr("yt-dlp.exe", exe)
            z.writestr("_internal/lib.txt", "needed at run time")
        else:
            for name, data in entries.items():
                z.writestr(name, data)
    return buf.getvalue()


class Fakes:
    """The downloads and the program start, replaced by recorders (no network, no Windows)."""

    def __init__(self, zip_bytes=None, zip_name="yt-dlp_win.zip", sums=None, starts=None):
        self.zip_bytes = make_zip() if zip_bytes is None else zip_bytes
        self.zip_name = zip_name
        self.sums = f"{hashlib.sha256(self.zip_bytes).hexdigest()}  {zip_name}\n" if sums is None else sums
        self.starts = list(starts or [])  # answers for the first starts: (code, out, err); then it runs fine
        self.asked, self.started, self.slept = [], [], []

    def text(self, url):
        self.asked.append(url)
        return self.sums

    def file(self, url, dest):
        self.asked.append(url)
        Path(dest).write_bytes(self.zip_bytes)

    def run(self, cmd):
        self.started.append(cmd[0])
        return self.starts.pop(0) if self.starts else (0, "2099.01.01\n", "")

    def kwargs(self, **more):
        return {"fetch_text": self.text, "fetch_file": self.file, "run": self.run, "sleep": self.slept.append, **more}


def put_old_install(bin_dir, legacy=True):
    (bin_dir / "yt-dlp_dir").mkdir(parents=True)
    (bin_dir / "yt-dlp_dir" / "yt-dlp.exe").write_bytes(b"old onedir")
    (bin_dir / "yt-dlp_dir" / "marker").write_text("old")
    if legacy:
        (bin_dir / "yt-dlp.exe").write_bytes(b"old single file")


def test_the_onedir_is_unpacked_checked_and_recorded(tmp_path):
    bin_dir = tmp_path / "bin"
    fakes = Fakes()
    assert install(bin_dir, **fakes.kwargs()) == "2099.01.01"
    assert (bin_dir / "yt-dlp_dir" / "yt-dlp.exe").read_bytes() == EXE_BYTES
    assert (bin_dir / "yt-dlp_dir" / "_internal" / "lib.txt").read_text() == "needed at run time"
    assert not (bin_dir / ".yt-dlp-update").exists() and not (bin_dir / "yt-dlp_dir.old").exists()
    assert fakes.asked[0].endswith("/SHA2-256SUMS") and fakes.asked[1].endswith("/yt-dlp_win.zip")
    record = install_record.read_engine(tmp_path)
    assert record["sha256"] == hashlib.sha256(EXE_BYTES).hexdigest() and record["size"] == len(EXE_BYTES)
    assert record["path"] == str(bin_dir / "yt-dlp_dir" / "yt-dlp.exe")


def test_the_zip_is_checked_against_the_published_list_before_anything_is_unpacked(tmp_path):
    bin_dir = tmp_path / "bin"
    put_old_install(bin_dir)
    fakes = Fakes(sums=f"{'0' * 64}  yt-dlp_win.zip\n")
    with pytest.raises(EngineInstallError, match="校驗碼不符"):
        install(bin_dir, **fakes.kwargs())
    assert (bin_dir / "yt-dlp_dir" / "marker").read_text() == "old" and (bin_dir / "yt-dlp.exe").exists()
    assert not (bin_dir / ".yt-dlp-update").exists() and fakes.started == []


def test_a_list_without_our_zip_is_an_error(tmp_path):
    with pytest.raises(EngineInstallError, match="校驗碼"):
        install(tmp_path / "bin", **Fakes(sums=f"{'a' * 64}  yt-dlp_linux.zip\n").kwargs())


@pytest.mark.parametrize("machine, name", [("AMD64", "yt-dlp_win.zip"), ("x86_64", "yt-dlp_win.zip"), ("", "yt-dlp_win.zip"),
                                           ("ARM64", "yt-dlp_win_arm64.zip"), ("x86", "yt-dlp_win_x86.zip"), ("i686", "yt-dlp_win_x86.zip")])
def test_the_zip_is_the_one_for_this_chip(tmp_path, machine, name):
    assert winengine.zip_name_for(machine) == name
    fakes = Fakes(zip_name=name)
    install(tmp_path / "bin", **fakes.kwargs(machine=machine))
    assert fakes.asked[1].endswith("/" + name)


@pytest.mark.parametrize("bad", ["../evil.txt", "a/../../evil.txt", "/abs/evil.txt", "C:/evil.txt", "C:\\evil.txt", "a\\..\\..\\evil.txt"])
def test_an_entry_that_would_leave_the_folder_is_refused_and_nothing_is_written(tmp_path, bad):
    bin_dir = tmp_path / "bin"
    put_old_install(bin_dir)
    with pytest.raises(EngineInstallError, match="不安全"):
        install(bin_dir, **Fakes(make_zip({"yt-dlp.exe": "x", bad: "evil"})).kwargs())
    assert not (tmp_path / "evil.txt").exists() and not (bin_dir / "evil.txt").exists()
    assert (bin_dir / "yt-dlp_dir" / "marker").read_text() == "old"
    assert not (bin_dir / ".yt-dlp-update").exists()


def test_an_archive_without_the_program_at_its_root_is_an_error(tmp_path):
    with pytest.raises(EngineInstallError, match="找不到 yt-dlp.exe"):
        install(tmp_path / "bin", **Fakes(make_zip({"README.txt": "x", "sub/yt-dlp.exe": "x"})).kwargs())


def test_a_damaged_zip_is_reported(tmp_path):
    with pytest.raises(EngineInstallError, match="損毀"):
        install(tmp_path / "bin", **Fakes(b"not a zip").kwargs())


def test_a_program_that_cannot_start_is_never_put_in_place(tmp_path):
    bin_dir = tmp_path / "bin"
    put_old_install(bin_dir)
    with pytest.raises(EngineInstallError, match="無法啟動") as err:
        install(bin_dir, **Fakes(starts=[(3, "", "boom")]).kwargs())
    assert not isinstance(err.value, EngineBlocked)
    assert (bin_dir / "yt-dlp_dir" / "marker").read_text() == "old" and (bin_dir / "yt-dlp.exe").exists()
    assert not (bin_dir / ".yt-dlp-update").exists()


def test_the_single_file_engine_is_removed_only_after_the_new_one_started(tmp_path):
    bin_dir = tmp_path / "bin"
    put_old_install(bin_dir)
    install(bin_dir, **Fakes().kwargs())
    assert not (bin_dir / "yt-dlp.exe").exists() and not (bin_dir / "yt-dlp_dir" / "marker").exists()


def test_a_virus_report_stops_with_the_facts_it_for_IT_and_does_not_try_again(tmp_path):
    bin_dir = tmp_path / "bin"
    put_old_install(bin_dir)
    zip_bytes = make_zip()
    fakes = Fakes(zip_bytes, starts=[(127, "", VIRUS)])
    with pytest.raises(EngineBlocked) as err:
        install(bin_dir, **fakes.kwargs())
    text = str(err.value)
    assert "防毒" in text and str(bin_dir) in text and str(bin_dir / "yt-dlp_dir" / "yt-dlp.exe") in text
    assert hashlib.sha256(EXE_BYTES).hexdigest() in text and hashlib.sha256(zip_bytes).hexdigest() in text
    assert len(fakes.started) == 1 and fakes.slept == [], "a virus report does not go away by waiting"
    assert (bin_dir / "yt-dlp_dir" / "marker").read_text() == "old" and (bin_dir / "yt-dlp.exe").exists()


def test_access_denied_right_after_the_write_is_tried_once_more_after_a_wait(tmp_path):
    fakes = Fakes(starts=[(127, "", DENIED)])
    assert install(tmp_path / "bin", **fakes.kwargs()) == "2099.01.01"
    assert len(fakes.started) == 3 and len(fakes.slept) == 1, "staged twice (after a wait), then once where it ends up"


def test_access_denied_twice_is_reported_as_the_antivirus(tmp_path):
    fakes = Fakes(starts=[(127, "", DENIED), (127, "", DENIED)])
    with pytest.raises(EngineBlocked, match="防毒"):
        install(tmp_path / "bin", **fakes.kwargs())
    assert len(fakes.started) == 2


def test_a_program_blocked_after_it_was_moved_into_place_puts_the_old_install_back(tmp_path):
    bin_dir = tmp_path / "bin"
    put_old_install(bin_dir)
    fakes = Fakes(starts=[(0, "2099.01.01\n", ""), (127, "", VIRUS)])  # the first start (staged) works, the one in place is blocked
    with pytest.raises(EngineBlocked):
        install(bin_dir, **fakes.kwargs())
    assert (bin_dir / "yt-dlp_dir" / "marker").read_text() == "old" and (bin_dir / "yt-dlp.exe").exists()
    assert not (bin_dir / "yt-dlp_dir.old").exists() and not (bin_dir / ".yt-dlp-update").exists()


def test_a_failure_while_swapping_puts_the_old_install_back(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    put_old_install(bin_dir)
    real = Path.rename

    def flaky(self, target):
        if self.name == "new":
            raise OSError("in use")
        return real(self, target)

    monkeypatch.setattr(Path, "rename", flaky)
    with pytest.raises(EngineInstallError, match="無法換上"):
        install(bin_dir, **Fakes().kwargs(sleep=lambda s: None))
    assert (bin_dir / "yt-dlp_dir" / "marker").read_text() == "old" and not (bin_dir / "yt-dlp_dir.old").exists()


@pytest.mark.parametrize("text, kind", [(VIRUS, "virus"), ("contains a virus", "virus"), ("作業無法順利完成，因為檔案包含病毒或潛在的垃圾軟體。", "virus"),
                                        (DENIED, "denied"), ("拒絕存取。", "denied"), ("[WinError 193] not a valid Win32 application", "other"),
                                        ("", "other")])
def test_what_an_antivirus_does_to_a_program_is_recognised_from_the_error(text, kind):
    assert winengine.classify_start_error(text) == kind


def test_the_engine_is_the_onedir_one_and_the_single_file_one_is_the_fallback(tmp_path):
    new, legacy = tmp_path / "bin/yt-dlp_dir/yt-dlp.exe", tmp_path / "bin/yt-dlp.exe"
    assert winengine.engine_path(tmp_path) == new, "nothing there: where it is expected"
    legacy.parent.mkdir(parents=True)
    legacy.write_bytes(b"x")
    assert winengine.engine_path(tmp_path) == legacy
    new.parent.mkdir()
    new.write_bytes(b"x")
    assert winengine.engine_path(tmp_path) == new


def test_the_command_line_installs_into_a_bin_folder(tmp_path, capsys):
    assert winengine.main(["winengine.py", "install", str(tmp_path)], install_fn=lambda b: "9.9") == 0
    assert "yt-dlp 9.9" in capsys.readouterr().out
    assert winengine.main(["winengine.py"], install_fn=lambda b: "9.9") == 2
