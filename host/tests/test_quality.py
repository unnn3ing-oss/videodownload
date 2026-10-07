import pytest

from quality import format_selector, format_sort, is_h264, parse_quality


def test_format_selector_does_not_filter_on_height():
    # a vertical Short is 1080 wide and 1920 high: any height filter would drop it to a lower resolution
    for quality in (720, 1080):
        assert format_selector(quality) == "bv*+ba/b"


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


def test_format_sort_limits_the_shorter_side_then_prefers_h264():
    assert format_sort(1080) == "res:1080,vcodec:h264,acodec:aac"
    assert format_sort(720) == "res:720,vcodec:h264,acodec:aac"


def _fmt(fid, ext, vcodec, acodec, height=None, abr=None, tbr=1000, width=None):
    d = {"format_id": fid, "ext": ext, "vcodec": vcodec, "acodec": acodec,
         "url": f"http://x/{fid}", "protocol": "https", "tbr": tbr}
    if height:
        d.update(height=height, width=width or int(height * 16 / 9), fps=30)
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
    # parsed the way the command line parses -f / -S, so the exact strings the host passes are what is tested
    opts = yt_dlp.parse_options(["--ignore-config", "-f", format_selector(quality), "-S", format_sort(quality)])
    ydl = yt_dlp.YoutubeDL({**opts.ydl_opts, "quiet": True, "no_warnings": True})
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


def _short(fid, side, vcodec="avc1.640028", tbr=3000):
    """A vertical video `side` wide (9:16)."""
    return _fmt(fid, "mp4" if vcodec.startswith("avc1") else "webm", vcodec, "none", int(side * 16 / 9), tbr=tbr,
                width=side)


_SHORT_ALL = [_short("s1080", 1080, tbr=6000), _short("s720", 720), _short("s480", 480, tbr=1000)] + _AUDIO
_SHORT_NO_1080 = [f for f in _SHORT_ALL if f["format_id"] != "s1080"]


@pytest.mark.parametrize("formats,quality,expected", [
    (_SHORT_ALL, 1080, "s1080+140"),                 # 1080x1920: the old height<=1080 filter only reached 480x853
    (_SHORT_ALL, 720, "s720+140"),
    (_SHORT_NO_1080, 1080, "s720+140"),              # exact size missing: the best one below it
    ([_short("s1440", 1440, "vp09.00.50.08"), *_SHORT_NO_1080], 1080, "s720+140"),
    (_SHORT_ALL[2:], 1080, "s480+140"),
    ([_short("s1440", 1440, "vp09.00.50.08"), *_AUDIO], 1080, "s1440+140"),  # nothing small enough: still a download
    ([_fmt("sq", "mp4", "avc1.640028", "none", 1080, width=1080), *_AUDIO], 1080, "sq+140"),
])
def test_real_yt_dlp_selection_for_vertical_videos(formats, quality, expected):
    assert _pick(formats, quality) == expected


def test_real_yt_dlp_selection_keeps_landscape_behaviour_with_4k_available():
    formats = [_fmt("313", "webm", "vp09.00.50.08", "none", 2160, tbr=14000), *_ALL]
    assert _pick(formats, 1080) == "137+140"
    assert _pick(formats, 720) == "136+140"
