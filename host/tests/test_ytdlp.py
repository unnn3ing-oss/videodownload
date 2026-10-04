import json
import sys
import threading
import time
from pathlib import Path

import pytest

from quality import FORMAT_SORT, format_selector
from ytdlp import (DoneInfo, Engine, Progress, ResolveError, StreamResult, VideoRef,
                   build_download_args, classify_error, normalize_url, parse_done_line,
                   parse_progress_line, resolve, run_capture, stream_download)


def test_build_args():
    a = build_download_args(Engine(Path("yt-dlp"), Path("/ff"), Path("/dn/deno")),
                            "https://youtu.be/x", 1080, Path("/o/t.mp4"))
    assert a[0] == "yt-dlp" and "--ignore-config" in a and "--no-playlist" in a
    assert a[a.index("-f") + 1] == format_selector(1080)
    assert a[a.index("-S") + 1] == FORMAT_SORT
    assert a[a.index("--merge-output-format") + 1] == "mp4"
    assert a[a.index("-o") + 1] == "/o/t.mp4"
    assert a[a.index("--js-runtimes") + 1] == "deno:/dn/deno"
    assert a[a.index("--ffmpeg-location") + 1] == "/ff"
    assert a[-2:] == ["--", "https://youtu.be/x"]


def test_build_args_without_optional_parts():
    a = build_download_args(Engine(Path("yt-dlp")), "https://youtu.be/x", 720, Path("/o/t.mp4"))
    assert "--ffmpeg-location" not in a and "--js-runtimes" not in a


def test_target_percent_is_escaped():
    a = build_download_args(Engine(Path("yt-dlp")), "https://youtu.be/x", 720, Path("/o/100%.mp4"))
    assert a[a.index("-o") + 1] == "/o/100%%.mp4"


def test_parse_progress():
    assert parse_progress_line("[ytdl-progress]512|1024|NA|2048.5|3") == Progress(50.0, 2048.5, 3)
    assert parse_progress_line("[ytdl-progress]512|NA|2048|NA|NA") == Progress(25.0, None, None)
    assert parse_progress_line("[ytdl-progress]512|NA|NA|NA|NA") == Progress(None, None, None)
    assert parse_progress_line("random") is None


def test_parse_done():
    assert parse_done_line("[ytdl-done]abc|1080|avc1.640028") == DoneInfo("abc", 1080, "avc1.640028")
    assert parse_done_line("[ytdl-done]abc|NA|NA") == DoneInfo("abc", None, None)
    assert parse_done_line("x") is None


@pytest.mark.parametrize("stderr,code", [
    ("ERROR: [youtube] x: Private video. Sign in if you've been granted access to this video", "private"),
    ("ERROR: [youtube] x: Video unavailable", "unavailable"),
    ("ERROR: This video is not available in your country", "region"),
    ("ERROR: Sign in to confirm you’re not a bot", "login_required"),
    ("ERROR: Sign in to confirm your age", "login_required"),
    ("ERROR: Unable to download webpage: The read operation timed out", "network"),
    ("ERROR: Temporary failure in name resolution", "network"),
    ("ERROR: n challenge solving failed", "engine_outdated"),
    ("ERROR: Unable to extract initial data", "engine_outdated"),
    ("OSError: [Errno 28] No space left on device", "disk_full"),
    ("something odd happened", "unknown"),
])
def test_classify(stderr, code):
    got, message = classify_error(stderr)
    assert got == code and message


ROOT = "https://www.youtube.com"


@pytest.mark.parametrize("src,expected", [
    (f"{ROOT}/@abc", f"{ROOT}/@abc/videos"),
    (f"{ROOT}/@abc/", f"{ROOT}/@abc/videos"),
    (f"{ROOT}/@abc?si=x", f"{ROOT}/@abc/videos?si=x"),
    (f"{ROOT}/channel/UC123", f"{ROOT}/channel/UC123/videos"),
    (f"{ROOT}/c/Name", f"{ROOT}/c/Name/videos"),
    (f"{ROOT}/user/Name", f"{ROOT}/user/Name/videos"),
    (f"{ROOT}/@abc/videos", f"{ROOT}/@abc/videos"),
    (f"{ROOT}/@abc/shorts", f"{ROOT}/@abc/shorts"),
    (f"{ROOT}/watch?v=abc", f"{ROOT}/watch?v=abc"),
    (f"{ROOT}/playlist?list=1", f"{ROOT}/playlist?list=1"),
    ("https://youtu.be/abc", "https://youtu.be/abc"),
])
def test_normalize_url(src, expected):
    assert normalize_url(src) == expected


def fake_run(lines, rc=0, err=""):
    calls = []

    def run(cmd):
        calls.append(cmd)
        return rc, "\n".join(json.dumps(x) for x in lines), err

    return run, calls


def test_resolve_expands_and_dedupes():
    run, calls = fake_run([{"id": "a1", "title": "T1"}, {"id": "a2", "title": None}, {"id": "a1", "title": "T1"}])
    got = resolve(Engine(Path("yt-dlp")), [f"{ROOT}/@abc"], limit=5, run=run)
    assert got == [VideoRef("a1", "T1", f"{ROOT}/watch?v=a1"), VideoRef("a2", "a2", f"{ROOT}/watch?v=a2")]
    cmd = calls[0]
    assert cmd[cmd.index("--playlist-items") + 1] == "1:5"
    assert "--flat-playlist" in cmd and "--dump-json" in cmd and "--ignore-config" in cmd
    assert cmd[-2:] == ["--", f"{ROOT}/@abc/videos"]


def test_resolve_failure_raises():
    run, _ = fake_run([], rc=1, err="ERROR: Private video")
    with pytest.raises(ResolveError) as exc:
        resolve(Engine(Path("yt-dlp")), [f"{ROOT}/watch?v=x"], run=run)
    assert exc.value.code == "private"


def collect(cmd, cancel=None):
    lines = []
    result = stream_download(cmd, lines.append, cancel or threading.Event())
    return result, lines


def test_stream_lines_and_stderr():
    result, lines = collect([sys.executable, "-c", 'print("a");print("b")'])
    assert lines == ["a", "b"] and result.returncode == 0


def test_stream_failure():
    result, _ = collect([sys.executable, "-c", 'import sys;sys.stderr.write("boom");sys.exit(3)'])
    assert result == StreamResult(3, "boom", False)


def test_stream_cancel():
    cancel = threading.Event()
    threading.Timer(0.2, cancel.set).start()
    started = time.monotonic()
    result, _ = collect([sys.executable, "-c", "import time;time.sleep(30)"], cancel)
    assert time.monotonic() - started < 5
    assert result.cancelled is True and result.returncode != 0


def test_resolve_partial_failure_keeps_other_urls():
    def run(cmd):
        if cmd[-1].endswith("bad"):
            return 1, "", "ERROR: Private video"
        return 0, json.dumps({"id": "a1", "title": "T1"}), ""

    got = resolve(Engine(Path("yt-dlp")), [f"{ROOT}/watch?v=ok", f"{ROOT}/watch?v=bad"], run=run)
    assert got == [VideoRef("a1", "T1", f"{ROOT}/watch?v=a1"), VideoRef("", "", f"{ROOT}/watch?v=bad")]


def test_resolve_all_urls_failing_raises():
    run, _ = fake_run([], rc=1, err="ERROR: Video unavailable")
    with pytest.raises(ResolveError) as exc:
        resolve(Engine(Path("yt-dlp")), [f"{ROOT}/watch?v=a", f"{ROOT}/watch?v=b"], run=run)
    assert exc.value.code == "unavailable"


@pytest.mark.parametrize("url,single", [
    (f"{ROOT}/watch?v=abc&list=PL1", True),
    (f"{ROOT}/watch?v=abc", True),
    ("https://youtu.be/abc?list=PL1", True),
    (f"{ROOT}/shorts/abc", True),
    (f"{ROOT}/playlist?list=PL1", False),
    (f"{ROOT}/@abc", False),
    (f"{ROOT}/@abc/videos", False),
])
def test_resolve_no_playlist_only_for_single_video_urls(url, single):
    run, calls = fake_run([{"id": "a1", "title": "T1"}])
    resolve(Engine(Path("yt-dlp")), [url], run=run)
    assert ("--no-playlist" in calls[0]) is single


def test_run_capture_missing_executable_does_not_raise():
    code, out, err = run_capture(["/nonexistent/yt-dlp-xyz", "--version"])
    assert code != 0 and out == "" and err
