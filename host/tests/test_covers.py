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


def test_save_cover_does_not_hand_out_a_name_another_video_still_has_registered(tmp_path):
    first = save_cover(tmp_path, "v1", "颱風假放不放", JPEG)
    first.unlink()  # the picture is gone, the registry still says it is v1's
    other = save_cover(tmp_path, "v2", "颱風假放不放二", JPEG + b"2")
    assert other.name != first.name
    again = save_cover(tmp_path, "v1", "颱風假放不放", JPEG + b"1")
    assert again.name == first.name
    assert other.read_bytes() == JPEG + b"2" and again.read_bytes() == JPEG + b"1"


def test_save_cover_does_not_overwrite_when_two_videos_are_registered_to_one_name(tmp_path):
    (tmp_path / "共用.jpg").write_bytes(b"\xff\xd8\xff" + b"other video's cover")
    (tmp_path / ".ytdl-covers.json").write_text(json.dumps({"v1": "共用.jpg", "v2": "共用.jpg"}), encoding="utf-8")
    path = save_cover(tmp_path, "v1", "共用", JPEG)
    assert path.name != "共用.jpg"
    assert (tmp_path / "共用.jpg").read_bytes() == b"\xff\xd8\xff" + b"other video's cover"


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


@pytest.mark.parametrize("entry", ["notes.docx", "../escape.jpg", ".ytdl-covers.json", "", "no-extension", ".hidden.jpg"])
def test_save_cover_ignores_registry_entries_that_are_not_plain_jpg_names(tmp_path, entry):
    victim = tmp_path / "notes.docx"
    victim.write_bytes(b"keep me")
    (tmp_path / ".ytdl-covers.json").write_text(json.dumps({"v1": entry}), encoding="utf-8")
    path = save_cover(tmp_path, "v1", "標題", JPEG)
    assert path.name == "標題.jpg"
    assert victim.read_bytes() == b"keep me"
    assert json.loads((tmp_path / ".ytdl-covers.json").read_text(encoding="utf-8")) == {"v1": "標題.jpg"}


def test_save_cover_reuses_a_registered_jpg_name_in_any_letter_case(tmp_path):
    (tmp_path / ".ytdl-covers.json").write_text(json.dumps({"v1": "舊名字.JPG"}), encoding="utf-8")
    assert save_cover(tmp_path, "v1", "完全不同的新標題", JPEG).name == "舊名字.JPG"


@pytest.mark.parametrize("entry", ["C:x.jpg", "notes.docx:x.jpg", "a*b.jpg", "a?b.jpg", "a<b.jpg", "a|b.jpg", 'a"b.jpg', "a\x00b.jpg"])
def test_save_cover_ignores_registry_entries_with_characters_windows_reads_specially(tmp_path, entry):
    (tmp_path / ".ytdl-covers.json").write_text(json.dumps({"v1": entry}), encoding="utf-8")
    assert save_cover(tmp_path, "v1", "標題", JPEG).name == "標題.jpg"
