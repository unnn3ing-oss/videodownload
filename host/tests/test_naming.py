from pathlib import Path

import pytest

from naming import partial_dir, resolve_target, sanitize_filename


def test_illegal_chars():
    assert sanitize_filename('a/b:c*d?"e<f>g|h\\i') == "a_b_c_d__e_f_g_h_i"


def test_control_chars():
    assert sanitize_filename("a\x00b\x1fc") == "a_b_c"


def test_trailing_dots_spaces():
    assert sanitize_filename("title. . ") == "title"


@pytest.mark.parametrize("raw,expected", [
    (".hidden", "hidden"), ("...title", "title"), (" . .title ", "title"), ("..", ""), (".gitignore.", "gitignore"),
    ("a.b", "a.b"),
])
def test_leading_dots_do_not_make_a_hidden_file(raw, expected):
    assert sanitize_filename(raw) == expected


@pytest.mark.parametrize("raw,expected", [
    ("CON", "_CON"), ("nul", "_nul"), ("COM1", "_COM1"), ("con.txt", "_con.txt"), (".con", "_con"),
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


def test_resolve_title_starting_with_a_dot_is_visible(tmp_path):
    assert resolve_target(tmp_path, ".秘密 計畫", "abc123") == tmp_path / "秘密 計畫.mp4"


def test_resolve_empty_title_uses_id(tmp_path):
    assert resolve_target(tmp_path, "...", "vid") == tmp_path / "vid.mp4"


def test_total_path_limit():
    d = Path("/" + "d" * 150)
    r = resolve_target(d, "字" * 300, "abcdefghijk")
    assert len(str(r)) <= 240 and r.name.endswith(".mp4")


def test_directory_too_long_raises():
    with pytest.raises(ValueError):
        resolve_target(Path("/" + "d" * 245), "title", "abcdefghijk")


def test_name_is_capped_by_utf8_bytes(tmp_path):
    r = resolve_target(tmp_path, "字" * 100, "abcdefghijk")
    assert len(r.name.encode("utf-8")) <= 255 - 16  # room for yt-dlp's ".f251-drc.webm.part"


def test_temp_files_fit_windows_max_path_even_on_collision(tmp_path):
    deep = tmp_path / ("d" * 25) / ("e" * 25) / ("f" * 25)
    deep.mkdir(parents=True)
    title = "字" * 300
    first = resolve_target(deep, title, "abcdefghijk")
    first.touch()
    second = resolve_target(deep, title, "lmnopqrstuv")  # same title, other video: " [id]" suffix
    assert second != first
    for path, vid in ((first, "abcdefghijk"), (second, "lmnopqrstuv")):
        temp = partial_dir(deep, vid) / (path.stem + ".f251-drc.webm.part")  # where yt-dlp writes while downloading
        assert len(str(temp)) <= 259


def test_oserror_from_exists_becomes_valueerror(tmp_path, monkeypatch):
    def boom(self):
        raise OSError(36, "File name too long")

    monkeypatch.setattr(Path, "exists", boom)
    with pytest.raises(ValueError):
        resolve_target(tmp_path, "x", "vid")


@pytest.mark.parametrize("raw,expected", [
    ("~新品發表", "～新品發表"), ("a~b", "a~b"), ("Pay $HOME now", "Pay ＄HOME now"), ("$5 off", "$5 off"),
    ("${x} and $_y", "＄{x} and ＄_y"),
])
def test_names_yt_dlp_would_expand_stay_literal(raw, expected):
    # yt-dlp runs the -o template through expanduser/expandvars: "~name" would become another user's home folder
    assert sanitize_filename(raw) == expected


@pytest.mark.parametrize("raw", ["~root", "~", "$HOME/x", "${HOME}", "a $PATH b", "~新品發表"])
def test_cleaned_names_survive_expanduser_and_expandvars(raw, monkeypatch):
    import os
    monkeypatch.setenv("HOME", "/home/someone")
    monkeypatch.setenv("USERPROFILE", "C:\\Users\\someone")
    cleaned = sanitize_filename(raw)
    assert os.path.expanduser(cleaned) == cleaned and os.path.expandvars(cleaned) == cleaned
