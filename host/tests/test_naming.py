from pathlib import Path

import pytest

from naming import resolve_target, sanitize_filename


def test_illegal_chars():
    assert sanitize_filename('a/b:c*d?"e<f>g|h\\i') == "a_b_c_d__e_f_g_h_i"


def test_control_chars():
    assert sanitize_filename("a\x00b\x1fc") == "a_b_c"


def test_trailing_dots_spaces():
    assert sanitize_filename("title. . ") == "title"


@pytest.mark.parametrize("raw,expected", [
    ("CON", "_CON"), ("nul", "_nul"), ("COM1", "_COM1"), ("con.txt", "_con.txt"),
])
def test_reserved_names(raw, expected):
    assert sanitize_filename(raw) == expected


def test_empty_after_clean():
    assert sanitize_filename("...") == ""


def test_max_len():
    assert len(sanitize_filename("字" * 300, 200)) == 200


def test_resolve_plain(tmp_path):
    assert resolve_target(tmp_path, "標題", "abc123") == tmp_path / "標題.mp4"


def test_resolve_collision_adds_id(tmp_path):
    (tmp_path / "標題.mp4").touch()
    assert resolve_target(tmp_path, "標題", "abc123", "mp4", {}) == tmp_path / "標題 [abc123].mp4"


def test_resolve_same_video_reuses(tmp_path):
    (tmp_path / "標題.mp4").touch()
    got = resolve_target(tmp_path, "標題", "abc123", "mp4", {"abc123": "標題.mp4"})
    assert got == tmp_path / "標題.mp4"


def test_resolve_empty_title_uses_id(tmp_path):
    assert resolve_target(tmp_path, "...", "vid") == tmp_path / "vid.mp4"


def test_total_path_limit():
    d = Path("/" + "d" * 200)
    r = resolve_target(d, "字" * 300, "abcdefghijk")
    assert len(str(r)) <= 250 and r.name.endswith(".mp4")


def test_directory_too_long_raises():
    with pytest.raises(ValueError):
        resolve_target(Path("/" + "d" * 245), "title", "abcdefghijk")
