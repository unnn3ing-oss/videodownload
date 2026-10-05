import hashlib

import pytest

import selfupdate
from selfupdate import (MAX_FILE_BYTES, MAX_FILES, UpdateError, changed_files, git_blob_sha,
                        http_get, validate_files)


def blob(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


GOOD = {"path": "host.py", "sha": "a" * 40, "size": 10}


def test_git_blob_sha_known_vectors():
    assert git_blob_sha(b"hello\n") == "ce013625030ba8dba906f756967f9e9ca394464a"
    assert git_blob_sha(b"") == "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"


def test_validate_files_accepts_normal_entries():
    entries = [GOOD, {"path": "version.py", "sha": "b" * 40, "size": 0, "extra": "dropped"}]
    got = validate_files(entries)
    assert got == [GOOD, {"path": "version.py", "sha": "b" * 40, "size": 0}]
    assert got[0] is not GOOD


BAD = [
    "not a list", None, [1], [{"path": "host.py", "sha": "a" * 40}],
    *[[{**GOOD, "path": p}] for p in ("../x.py", "/etc/x.py", "a/b.py", "a\\b.py", ".py", "x.txt", "é.py", "x.py ")],
    *[[{**GOOD, "sha": s}] for s in ("zz", "A" * 40, "a" * 39)],
    *[[{**GOOD, "size": n}] for n in (-1, MAX_FILE_BYTES + 1, True, "5")],
    [GOOD, GOOD],
    [{**GOOD, "path": f"f{i}.py"} for i in range(MAX_FILES + 1)],
]


@pytest.mark.parametrize("bad", BAD)
def test_validate_files_rejects_bad_entries(bad):
    with pytest.raises(UpdateError) as exc:
        validate_files(bad)
    assert exc.value.code == "update_bad_file"


def test_changed_files_reports_missing_and_different(tmp_path):
    (tmp_path / "same.py").write_bytes(b"x = 1\n")
    (tmp_path / "diff.py").write_bytes(b"x = 2\n")
    files = [
        {"path": "same.py", "sha": blob(b"x = 1\n"), "size": 6},
        {"path": "diff.py", "sha": blob(b"x = 1\n"), "size": 6},
        {"path": "missing.py", "sha": blob(b"x = 1\n"), "size": 6},
    ]
    assert changed_files(tmp_path, files) == ["diff.py", "missing.py"]


def test_changed_files_ignores_crlf_only_difference(tmp_path):
    (tmp_path / "host.py").write_bytes(b"a = 1\r\nb = 2\r\n")
    assert changed_files(tmp_path, [{"path": "host.py", "sha": blob(b"a = 1\nb = 2\n"), "size": 12}]) == []


def test_http_get_rejects_non_https():
    with pytest.raises(UpdateError) as exc:
        http_get("http://example.com/x")
    assert exc.value.code == "update_download_failed"


def test_http_get_enforces_size_cap(monkeypatch):
    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self, n=-1):
            return b"x" * (n if n >= 0 else MAX_FILE_BYTES + 10)

    monkeypatch.setattr(selfupdate.urllib.request, "urlopen", lambda req, timeout=None: Response())
    with pytest.raises(UpdateError) as exc:
        http_get("https://example.com/big")
    assert exc.value.code == "update_download_failed"
