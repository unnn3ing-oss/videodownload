import json
from pathlib import Path

import pytest

from covers import MAX_COVER_BYTES, CoverError, cover_name, save_cover

FIXTURE = Path(__file__).resolve().parent.parent.parent / "tests" / "fixtures" / "cover-names.json"
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 16


def test_cover_name_matches_shared_fixture():
    for case in json.loads(FIXTURE.read_text(encoding="utf-8")):
        assert cover_name(case["title"], case["id"]) == case["expected"], case["title"]


def test_save_cover_writes_jpeg_and_registers(tmp_path):
    path = save_cover(tmp_path, "v1", "颱風假放不放？氣象署", JPEG)
    assert path == (tmp_path / "颱風假放不放.jpg").resolve()
    assert path.read_bytes() == JPEG
    assert json.loads((tmp_path / ".ytdl-covers.json").read_text(encoding="utf-8")) == {"v1": "颱風假放不放.jpg"}


def test_save_cover_same_video_overwrites_same_name(tmp_path):
    first = save_cover(tmp_path, "v1", "颱風假放不放", JPEG)
    second = save_cover(tmp_path, "v1", "標題改了但同一支影片", JPEG + b"1")
    assert second == first and second.read_bytes() == JPEG + b"1"
    assert len(list(tmp_path.glob("*.jpg"))) == 1


def test_save_cover_different_video_same_name_gets_suffix(tmp_path):
    names = [save_cover(tmp_path, f"v{i}", "颱風假放不放一", JPEG).name for i in range(3)]
    assert names == ["颱風假放不放.jpg", "颱風假放不放_2.jpg", "颱風假放不放_3.jpg"]


@pytest.mark.parametrize("data", [b"", b"<html>not an image</html>", b"\xff\xd8"])
def test_save_cover_rejects_non_jpeg(tmp_path, data):
    with pytest.raises(CoverError) as exc:
        save_cover(tmp_path, "v1", "標題", data)
    assert exc.value.code == "bad_cover"
    assert not list(tmp_path.glob("*.jpg"))


def test_save_cover_rejects_too_large(tmp_path):
    with pytest.raises(CoverError) as exc:
        save_cover(tmp_path, "v1", "標題", JPEG + b"\x00" * MAX_COVER_BYTES)
    assert exc.value.code == "cover_too_large"


def test_save_cover_creates_missing_directory(tmp_path):
    target = tmp_path / "a" / "b"
    assert save_cover(target, "v1", "標題", JPEG).exists()


def test_save_cover_ignores_corrupt_registry(tmp_path):
    (tmp_path / ".ytdl-covers.json").write_text("{not json", encoding="utf-8")
    assert save_cover(tmp_path, "v1", "標題", JPEG).name == "標題.jpg"


def test_largest_cover_fits_in_one_native_message():
    import base64
    import json
    import protocol
    biggest = base64.b64encode(b"\xff\xd8\xff" + b"\x00" * (MAX_COVER_BYTES - 3)).decode()
    message = json.dumps({"type": "save_cover", "id": "x" * 64, "title": "題" * 200, "data": biggest, "reqId": "bg:123456"})
    assert len(message.encode("utf-8")) < protocol.MAX_IN
