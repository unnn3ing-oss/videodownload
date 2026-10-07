import hashlib

import install_record as rec


def test_an_old_record_without_an_engine_entry_reads_fine(tmp_path):
    (tmp_path / "install.json").write_text('{"extensionFolder": "/x", "version": "0.2.0"}')
    assert rec.read_record(tmp_path)["version"] == "0.2.0"
    assert rec.read_engine(tmp_path) == {}


def test_the_engine_entry_keeps_path_hash_and_size_of_the_file(tmp_path):
    exe = tmp_path / "yt-dlp.exe"
    exe.write_bytes(b"MZ engine")
    facts = rec.fingerprint(exe)
    assert facts == {"path": str(exe), "sha256": hashlib.sha256(b"MZ engine").hexdigest(), "size": 9}
    rec.write_engine(tmp_path, facts)
    assert rec.read_engine(tmp_path) == facts


def test_writing_the_record_again_keeps_the_engine_entry_and_the_engine_keeps_the_extension_folder(tmp_path):
    rec.write_engine(tmp_path, {"path": "p", "sha256": "a" * 64, "size": 1})
    rec.write_record(tmp_path, extension_folder=tmp_path / "ext", version="1.0.0")
    assert rec.read_engine(tmp_path)["sha256"] == "a" * 64
    rec.write_engine(tmp_path, {"path": "q", "sha256": "b" * 64, "size": 2})
    assert rec.read_record(tmp_path)["extensionFolder"] == str(tmp_path / "ext")


def test_a_garbled_engine_entry_reads_as_none(tmp_path):
    (tmp_path / "install.json").write_text('{"engine": "oops"}')
    assert rec.read_engine(tmp_path) == {}
    (tmp_path / "install.json").write_text('{"engine": {"sha256": 5}}')
    assert rec.read_engine(tmp_path) == {}


def test_no_extension_folder_can_be_written_as_none(tmp_path):
    rec.write_record(tmp_path, extension_folder=None, version="1.0.0")
    assert "extensionFolder" not in rec.read_record(tmp_path)
