import pytest

from security import is_allowed_url, safe_output_path

ALLOWED = [
    "https://www.youtube.com/watch?v=abc",
    "https://youtu.be/abc",
    "http://m.youtube.com/@x/videos",
    "https://music.youtube.com/playlist?list=1",
    "https://youtube.com/@x",
    "https://WWW.YouTube.com:443/watch?v=abc",
    "  https://youtu.be/abc  ",
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
    "https://evil.youtube.com/x",
    "https://studio.youtube.com/",
    "https://www.youtube.com:8443/watch?v=abc",
    "https://user:pass@www.youtube.com/watch?v=abc",
    "https://user@www.youtube.com/",
    "https://www.youtube.com/watch?v=abc --exec x",
    "https://www.youtube.com/watch?v=abc\nhttps://evil.com/",
    "https://www.youtube.com\\@evil.com/",
    "https://www.youtube.com./x",
    "https://www.youtube.com/" + "a" * 2100,
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


def test_python_and_javascript_allow_the_same_hosts():
    import re
    from pathlib import Path
    from security import ALLOWED_HOSTS
    js = (Path(__file__).resolve().parents[2] / "extension/lib/urls.js").read_text(encoding="utf-8")
    listed = re.search(r"ALLOWED_HOSTS = \[([^\]]+)\]", js).group(1)
    assert set(re.findall(r'"([^"]+)"', listed)) == set(ALLOWED_HOSTS)
