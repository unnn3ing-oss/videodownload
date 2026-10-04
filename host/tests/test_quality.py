import pytest

from quality import FORMAT_SORT, format_selector, is_h264, parse_quality


def test_format_selector_1080():
    assert format_selector(1080) == "bv*[height<=1080]+ba/b[height<=1080]"


def test_format_selector_720():
    assert format_selector(720) == "bv*[height<=720]+ba/b[height<=720]"


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


def test_format_sort_prefers_resolution_then_h264():
    assert FORMAT_SORT == "res,vcodec:h264,acodec:aac"


def _fmt(fid, ext, vcodec, acodec, height=None, abr=None, tbr=1000):
    d = {"format_id": fid, "ext": ext, "vcodec": vcodec, "acodec": acodec,
         "url": f"http://x/{fid}", "protocol": "https", "tbr": tbr}
    if height:
        d.update(height=height, width=int(height * 16 / 9), fps=30)
    if abr:
        d["abr"] = abr
    return d


_AUDIO = [_fmt("140", "m4a", "none", "mp4a.40.2", abr=128, tbr=128),
          _fmt("251", "webm", "none", "opus", abr=160, tbr=160)]
_ALL = [_fmt("137", "mp4", "avc1.640028", "none", 1080, tbr=4000),
        _fmt("248", "webm", "vp09.00.40.08", "none", 1080, tbr=2500),
        _fmt("136", "mp4", "avc1.4d401f", "none", 720, tbr=2000),
        _fmt("247", "webm", "vp09.00.31.08", "none", 720, tbr=1200)] + _AUDIO
_NO_AVC_1080 = [f for f in _ALL if f["format_id"] != "137"]


def _pick(formats, quality):
    yt_dlp = pytest.importorskip("yt_dlp")
    ydl = yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "format": format_selector(quality),
                            "format_sort": FORMAT_SORT.split(",")})
    info = {"id": "x", "title": "t", "extractor": "generic", "extractor_key": "Generic",
            "webpage_url": "http://x/", "formats": [dict(f) for f in formats]}
    return ydl.process_video_result(info, download=False)["format_id"]


@pytest.mark.parametrize("formats,quality,expected", [
    (_ALL, 1080, "137+140"),            # H.264 1080p wins when it exists
    (_ALL, 720, "136+140"),
    (_NO_AVC_1080, 1080, "248+140"),    # no H.264 1080p: keep 1080p (VP9), never fall back to 720p
    (_NO_AVC_1080, 720, "136+140"),
])
def test_real_yt_dlp_selection(formats, quality, expected):
    assert _pick(formats, quality) == expected
