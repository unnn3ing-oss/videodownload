import platform

import pytest

import winengine


@pytest.fixture(autouse=True)
def _the_chip_is_the_usual_64_bit_one(monkeypatch):
    # the installers pick downloads (the Windows engine zip, Deno, ffmpeg) by the chip they run on: tests must not
    # depend on the machine that runs them (an Apple Silicon runner would ask for yt-dlp_win_arm64.zip)
    monkeypatch.setattr(platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(winengine, "_machine", lambda: "AMD64")
