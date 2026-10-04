import pytest

from quality import format_selector, is_h264, parse_quality


def test_format_selector_1080():
    assert format_selector(1080) == (
        "bv*[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]"
        "/bv*[height<=1080]+ba/b[height<=1080]"
    )


def test_format_selector_720():
    assert format_selector(720) == (
        "bv*[height<=720][vcodec^=avc1]+ba[acodec^=mp4a]"
        "/bv*[height<=720]+ba/b[height<=720]"
    )


def test_parse_quality_accepts_720_1080_and_strings():
    assert parse_quality(720) == 720
    assert parse_quality(1080) == 1080
    assert parse_quality("720") == 720
    assert parse_quality("1080") == 1080


@pytest.mark.parametrize("bad", [480, "abc", None, True, 1080.5, "1080p", ""])
def test_parse_quality_rejects_others(bad):
    with pytest.raises(ValueError):
        parse_quality(bad)


def test_is_h264():
    assert is_h264("avc1.640028") is True
    for other in ("vp09.00.40.08", "av01.0.08M.08", None, "NA"):
        assert is_h264(other) is False
