import shutil
import subprocess
import threading
from pathlib import Path

import pytest

from transcode import convert_to_h264, ffmpeg_command, ffmpeg_path
from ytdlp import Engine, StreamResult


def test_ffmpeg_is_found_next_to_the_engine_or_on_the_path():
    assert ffmpeg_path(Engine(Path("yt-dlp"))) == "ffmpeg"
    assert Path(ffmpeg_path(Engine(Path("yt-dlp"), Path("/ff")))).parent == Path("/ff")


def test_command_makes_a_web_friendly_h264_mp4_and_keeps_the_sound():
    cmd = ffmpeg_command("ffmpeg", Path("/o/a.mp4"), Path("/o/b.mp4"), "libx264")
    assert cmd[:2] == ["ffmpeg", "-y"] and cmd[-1] == str(Path("/o/b.mp4"))
    assert cmd[cmd.index("-i") + 1] == str(Path("/o/a.mp4"))
    assert cmd[cmd.index("-c:v") + 1] == "libx264" and cmd[cmd.index("-c:a") + 1] == "copy"
    assert cmd[cmd.index("-pix_fmt") + 1] == "yuv420p" and "+faststart" in cmd


def fake_stream(results, calls):
    def stream(cmd, on_line, cancel):
        calls.append(cmd)
        outcome = results.pop(0)
        if outcome.returncode == 0:
            Path(cmd[-1]).write_bytes(b"h264")
        return outcome
    return stream


def test_the_converted_file_replaces_the_original(tmp_path):
    src = tmp_path / "a.mp4"
    src.write_bytes(b"vp9")
    calls = []
    got = convert_to_h264(Engine(Path("yt-dlp")), src, tmp_path / "work", threading.Event(),
                          stream=fake_stream([StreamResult(0, "", False)], calls))
    assert got == "ok" and src.read_bytes() == b"h264" and len(calls) == 1
    assert not (tmp_path / "work").exists() or not any((tmp_path / "work").iterdir())


def test_a_second_encoder_is_tried_when_the_first_is_missing(tmp_path):
    src = tmp_path / "a.mp4"
    src.write_bytes(b"vp9")
    calls = []
    got = convert_to_h264(Engine(Path("yt-dlp")), src, tmp_path / "work", threading.Event(),
                          stream=fake_stream([StreamResult(1, "Unknown encoder 'libx264'", False),
                                              StreamResult(0, "", False)], calls))
    assert got == "ok" and [c[c.index("-c:v") + 1] for c in calls] == ["libx264", "h264_videotoolbox"]


def test_when_no_encoder_works_the_original_stays(tmp_path):
    src = tmp_path / "a.mp4"
    src.write_bytes(b"vp9")
    got = convert_to_h264(Engine(Path("yt-dlp")), src, tmp_path / "work", threading.Event(),
                          stream=fake_stream([StreamResult(1, "x", False), StreamResult(1, "y", False)], []))
    assert got == "failed" and src.read_bytes() == b"vp9"


def test_cancel_keeps_the_original(tmp_path):
    src = tmp_path / "a.mp4"
    src.write_bytes(b"vp9")
    got = convert_to_h264(Engine(Path("yt-dlp")), src, tmp_path / "work", threading.Event(),
                          stream=fake_stream([StreamResult(255, "", True)], []))
    assert got == "cancelled" and src.read_bytes() == b"vp9"


@pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="needs ffmpeg and ffprobe")
def test_a_real_vp9_file_becomes_h264(tmp_path):
    src = tmp_path / "a.mp4"
    made = subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x284:rate=10:duration=1",
                           "-f", "lavfi", "-i", "sine=duration=1", "-c:v", "libvpx-vp9", "-c:a", "aac", "-shortest",
                           str(src)], capture_output=True)
    if made.returncode != 0:
        pytest.skip("this ffmpeg cannot write VP9")
    from ytdlp import stream_download
    assert convert_to_h264(Engine(Path("yt-dlp")), src, tmp_path / "work", threading.Event(),
                           stream=stream_download) == "ok"
    codec = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name",
                            "-of", "csv=p=0", str(src)], capture_output=True, text=True).stdout.strip()
    assert codec == "h264"
