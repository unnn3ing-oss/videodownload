import pytest

from security import is_allowed_url, safe_output_path

ALLOWED = [
    "https://www.youtube.com/watch?v=abc",
    "https://youtu.be/abc",
    "http://m.youtube.com/@x/videos",
    "https://music.youtube.com/playlist?list=1",
    "https://youtube.com/@x",
]
DENIED = [
    "https://youtube.com.evil.com/x",
    "https://evil.com/?u=https://youtube.com",
    "https://youtube.com@evil.com/",
    "https://notyoutube.com/",
    "ftp://youtube.com/x",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "-o /etc/x",
    "",
    None,
    123,
]


@pytest.mark.parametrize("url", ALLOWED)
def test_allowed_urls(url):
    assert is_allowed_url(url) is True


@pytest.mark.parametrize("url", DENIED)
def test_denied_urls(url):
    assert is_allowed_url(url) is False


def test_safe_output_path_ok(tmp_path):
    assert safe_output_path(tmp_path, "a.mp4") == (tmp_path / "a.mp4").resolve()


@pytest.mark.parametrize("name", ["../x", "/etc/x", "a/b.mp4", "a\\b.mp4"])
def test_safe_output_path_rejects(tmp_path, name):
    with pytest.raises(ValueError):
        safe_output_path(tmp_path, name)
