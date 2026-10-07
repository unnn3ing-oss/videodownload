import threading
from pathlib import Path

import pytest

from config import ConfigStore
from jobs import Archive, JobRunner
from ytdlp import Engine, ResolveError, StreamResult, VideoRef

URL = "https://www.youtube.com/watch?v={}"


def item(vid="v1", title="標題"):
    return {"url": URL.format(vid), "id": vid, "title": title}


def paths_of(cmd):
    """(home dir, temp dir, file name) the way yt-dlp reads them: -P home:/temp: and the -o template (% unescaped)."""
    def given(kind):
        return next((cmd[i + 1][len(kind) + 1:] for i, a in enumerate(cmd[:-1])
                     if a == "-P" and cmd[i + 1].startswith(kind + ":")), None)

    return given("home"), given("temp"), cmd[cmd.index("-o") + 1].replace("%%", "%")


class Harness:
    """JobRunner wired to a fake yt-dlp that writes the -o target and prints a done line."""

    def __init__(self, tmp_path, *, height=1080, codec="avc1.640028", fail=None, resolve_fn=None, delay=0, jitter=0.0):
        self.out = tmp_path / "out"
        self.events, self.calls, self.logged = [], [], []
        self.height, self.codec, self.fail = height, codec, fail or {}
        self.runner = JobRunner(Engine(Path("yt-dlp")), self.events.append, stream=self.stream,
                                resolve_fn=resolve_fn or (lambda e, u, limit=None: []),
                                sleep=lambda s: None, delay=delay, jitter=lambda: jitter, log=self.logged.append)

    def stream(self, cmd, on_line, cancel):
        self.calls.append(cmd)
        vid = cmd[-1].split("v=")[-1]
        if vid in self.fail:
            return StreamResult(1, self.fail[vid], False)
        home, _, name = paths_of(cmd)
        Path(home, name).write_text("x", encoding="utf-8")
        on_line("[ytdl-progress]512|1024|NA|100|1")
        on_line(f"[ytdl-done]{vid}|{self.height}|{self.codec}")
        return StreamResult(0, "", False)

    def run(self, items, job_id="j", quality=1080, title_override=None, cooldown=None):
        self.runner.start(job_id, items, quality, self.out, title_override, cooldown)
        self.runner.join(10)
        return self

    def of(self, kind):
        return [e for e in self.events if e["type"] == kind]

    @property
    def summary(self):
        return self.of("done")[-1]["summary"]


def test_success_names_file_by_title_and_records(tmp_path):
    h = Harness(tmp_path).run([item()])
    done = h.of("item_done")[0]
    assert done["file"].endswith("標題.mp4") and done["height"] == 1080 and done["skipped"] is False
    assert h.of("progress")[0]["percent"] == 50.0
    assert h.summary == {"ok": 1, "skipped": 0, "failed": 0, "cancelled": False, "aborted": None}
    assert Archive(h.out).mapping() == {"v1": "標題.mp4"}


def test_rerun_skips_downloaded(tmp_path):
    h = Harness(tmp_path).run([item()]).run([item()], job_id="j2")
    assert h.of("item_done")[-1]["skipped"] is True
    assert len(h.calls) == 1


def test_deleted_file_is_redownloaded(tmp_path):
    h = Harness(tmp_path).run([item()])
    (h.out / "標題.mp4").unlink()
    h.run([item()], job_id="j2")
    assert len(h.calls) == 2 and h.of("item_done")[-1]["skipped"] is False


def test_failure_does_not_stop_batch(tmp_path):
    h = Harness(tmp_path, fail={"v1": "ERROR: Private video. Sign in"}).run([item("v1", "甲"), item("v2", "乙")])
    assert h.of("item_failed")[0]["code"] == "private"
    assert h.of("item_done")[0]["file"].endswith("乙.mp4")
    assert h.summary == {"ok": 1, "skipped": 0, "failed": 1, "cancelled": False, "aborted": None}


def test_placeholder_titles_fail_without_download(tmp_path):
    h = Harness(tmp_path).run([item("p1", "[Private video]"), item("d1", "[Deleted video]")])
    assert [e["code"] for e in h.of("item_failed")] == ["private", "unavailable"]
    assert h.calls == []


def test_duplicate_ids_downloaded_once(tmp_path):
    h = Harness(tmp_path).run([item(), item()])
    assert len(h.calls) == 1 and h.summary["ok"] == 1


def test_lower_height_than_requested_is_success(tmp_path):
    h = Harness(tmp_path, height=720).run([item()], quality=1080)
    assert h.of("item_done")[0]["height"] == 720 and h.summary["ok"] == 1


def test_bad_url_fails(tmp_path):
    h = Harness(tmp_path).run([{"url": "https://evil.com/x", "id": None, "title": None}])
    assert h.of("item_failed")[0]["code"] == "bad_url" and h.calls == []


def test_missing_title_is_resolved(tmp_path):
    resolver = lambda e, urls, limit=None: [VideoRef("v9", "解析標題", URL.format("v9"))]
    h = Harness(tmp_path, resolve_fn=resolver).run([{"url": URL.format("v9")}])
    assert h.of("item_done")[0]["file"].endswith("解析標題.mp4")


def test_resolve_failure_fails_item(tmp_path):
    def resolver(e, urls, limit=None):
        raise ResolveError("network", "網路連線失敗")

    h = Harness(tmp_path, resolve_fn=resolver).run([{"url": URL.format("v9")}])
    assert h.of("item_failed")[0]["code"] == "network"


def test_title_override_applies_to_single_item(tmp_path):
    h = Harness(tmp_path).run([item()], title_override="自訂")
    assert h.of("item_done")[0]["file"].endswith("自訂.mp4")


def test_title_override_ignored_for_multiple_items(tmp_path):
    h = Harness(tmp_path).run([item("v1", "甲"), item("v2", "乙")], title_override="自訂")
    assert sorted(Path(e["file"]).name for e in h.of("item_done")) == ["乙.mp4", "甲.mp4"]


def test_cancel_stops_remaining_items(tmp_path):
    h = Harness(tmp_path)

    def cancelling(cmd, on_line, cancel):
        h.calls.append(cmd)
        h.runner.cancel()
        return StreamResult(-15, "", True)

    h.runner._stream = cancelling
    h.run([item("v1", "甲"), item("v2", "乙")])
    assert h.summary["cancelled"] is True and len(h.calls) == 1


def test_busy_when_job_running(tmp_path):
    h = Harness(tmp_path)
    entered, gate = threading.Event(), threading.Event()
    original = h.stream

    def blocking(cmd, on_line, cancel):
        entered.set()
        gate.wait(5)
        return original(cmd, on_line, cancel)

    h.runner._stream = blocking
    h.runner.start("j1", [item()], 1080, h.out)
    assert entered.wait(5)
    with pytest.raises(RuntimeError):
        h.runner.start("j2", [item("v2")], 1080, h.out)
    gate.set()
    h.runner.join(10)


def test_archive_corrupt_file_is_empty(tmp_path):
    (tmp_path / ".ytdl-archive.json").write_text("{broken", encoding="utf-8")
    archive = Archive(tmp_path)
    assert archive.mapping() == {}
    archive.record("a", "f.mp4")
    assert Archive(tmp_path).mapping() == {"a": "f.mp4"}


def test_archive_lookup_requires_existing_file(tmp_path):
    archive = Archive(tmp_path)
    archive.record("a", "f.mp4")
    assert archive.lookup("a") is None
    (tmp_path / "f.mp4").write_text("x")
    assert archive.lookup("a") == "f.mp4"


def test_archive_not_recorded_on_failure(tmp_path):
    h = Harness(tmp_path, fail={"v1": "ERROR: Video unavailable"}).run([item()])
    assert Archive(h.out).mapping() == {}


def test_config_store(tmp_path):
    path = tmp_path / "config.json"
    assert ConfigStore(path).output_dir == Path.home() / "Downloads" / "YT下載"
    target = tmp_path / "a" / "b"
    assert ConfigStore(path).set_output_dir(str(target)) == target and target.is_dir()
    assert ConfigStore(path).output_dir == target
    for bad in ("", "   ", None, 5):
        with pytest.raises(ValueError):
            ConfigStore(path).set_output_dir(bad)


def test_oserror_on_one_item_does_not_stop_batch(tmp_path, monkeypatch):
    import jobs

    real = jobs.resolve_target

    def flaky(directory, title, vid, ext="mp4", known=None):
        if vid == "v1":
            raise OSError(36, "File name too long")
        return real(directory, title, vid, ext, known)

    monkeypatch.setattr(jobs, "resolve_target", flaky)
    h = Harness(tmp_path).run([item("v1", "甲"), item("v2", "乙")])
    assert h.of("item_failed")[0]["itemId"] == "v1"
    assert h.of("item_done")[0]["file"].endswith("乙.mp4")
    assert h.summary["failed"] == 1 and h.summary["ok"] == 1


def test_non_string_title_fails_item_not_job(tmp_path):
    h = Harness(tmp_path).run([{"url": URL.format("v1"), "id": "v1", "title": 5}, item("v2", "乙")])
    assert h.of("item_failed")[0]["itemId"] == "v1"
    assert h.summary["ok"] == 1


@pytest.mark.parametrize("bad_id", ["../../x", "a/b", "a\\b", "x" * 65])
def test_bad_ids_are_rejected(tmp_path, bad_id):
    h = Harness(tmp_path).run([{"url": URL.format("v1"), "id": bad_id, "title": "..."}])
    assert h.of("item_failed")[0]["code"] == "bad_id" and h.calls == []


def test_archive_record_failure_still_reports_done(tmp_path, monkeypatch):
    def boom(self, vid, name):
        raise PermissionError("locked by another process")

    monkeypatch.setattr(Archive, "record", boom)
    h = Harness(tmp_path).run([item()])
    assert h.of("item_done")[0]["skipped"] is False and h.summary["ok"] == 1


def blocking_stream(h, block_ids, entered, gate):
    """Stream that holds the listed video ids until `gate` is set or the item is cancelled."""
    original = h.stream

    def stream(cmd, on_line, cancel):
        vid = cmd[-1].split("v=")[-1]
        if vid in block_ids:
            entered.set()
            while not (gate.is_set() or cancel.is_set()):
                cancel.wait(0.01)
            if cancel.is_set():
                h.calls.append(cmd)
                return StreamResult(-15, "", True)
        return original(cmd, on_line, cancel)

    h.runner._stream = stream


def test_cooldown_waits_between_real_downloads_and_emits_event(tmp_path):
    h = Harness(tmp_path)
    sleeps = []
    h.runner._sleep = sleeps.append
    h.run([item("v1", "甲"), item("v2", "乙")], cooldown=3)
    cooldowns = h.of("cooldown")
    assert len(cooldowns) == 1
    assert cooldowns[0]["seconds"] == 3 and cooldowns[0]["nextId"] == "v2" and cooldowns[0]["jobId"] == "j"
    assert sum(sleeps) == 3 and all(step <= 1 for step in sleeps)
    kinds = [e["type"] for e in h.events]
    assert kinds.index("item_done") < kinds.index("cooldown") < len(kinds) - 1 - kinds[::-1].index("progress")


def test_no_cooldown_for_skipped_or_first_item(tmp_path):
    h = Harness(tmp_path).run([item("v1", "甲")], cooldown=3)
    h.events.clear()
    sleeps = []
    h.runner._sleep = sleeps.append
    h.run([item("v1", "甲"), item("v2", "乙")], job_id="j2", cooldown=3)
    assert h.of("cooldown") == [] and sleeps == []
    assert [e["skipped"] for e in h.of("item_done")] == [True, False]


def test_cancel_interrupts_cooldown(tmp_path):
    h = Harness(tmp_path)
    h.runner._sleep = lambda seconds: h.runner.cancel()
    h.run([item("v1", "甲"), item("v2", "乙")], cooldown=5)
    assert len(h.calls) == 1 and h.summary["cancelled"] is True and h.summary["ok"] == 1


def test_default_cooldown_when_not_given(tmp_path):
    h = Harness(tmp_path, delay=2).run([item("v1", "甲"), item("v2", "乙")])
    assert [e["seconds"] for e in h.of("cooldown")] == [2]


def test_enqueue_appends_to_running_job(tmp_path):
    h = Harness(tmp_path)
    entered, gate = threading.Event(), threading.Event()
    blocking_stream(h, {"v1"}, entered, gate)
    h.runner.start("j", [item("v1", "甲")], 1080, h.out)
    assert entered.wait(5)
    assert h.runner.enqueue([item("v2", "乙")]) is True
    gate.set()
    h.runner.join(10)
    assert len(h.calls) == 2 and h.summary["ok"] == 2 and len(h.of("done")) == 1


def test_enqueue_after_finish_returns_false(tmp_path):
    h = Harness(tmp_path).run([item()])
    assert h.runner.enqueue([item("v2")]) is False
    assert h.runner.enqueue([item("v2")]) is False  # still no job: nothing was queued behind its back


def test_enqueue_without_job_returns_false(tmp_path):
    assert Harness(tmp_path).runner.enqueue([item()]) is False


def test_remove_pending_item_never_downloads_it(tmp_path):
    h = Harness(tmp_path)
    entered, gate = threading.Event(), threading.Event()
    blocking_stream(h, {"v1"}, entered, gate)
    h.runner.start("j", [item("v1", "甲"), item("v2", "乙"), item("v3", "丙")], 1080, h.out)
    assert entered.wait(5)
    assert h.runner.remove("v2") == "pending"
    gate.set()
    h.runner.join(10)
    assert [Path(e["file"]).name for e in h.of("item_done")] == ["甲.mp4", "丙.mp4"]


def test_remove_current_item_continues_with_next(tmp_path):
    h = Harness(tmp_path)
    entered, gate = threading.Event(), threading.Event()
    blocking_stream(h, {"v1"}, entered, gate)
    h.runner.start("j", [item("v1", "甲"), item("v2", "乙")], 1080, h.out)
    assert entered.wait(5)
    assert h.runner.remove("v1") == "current"
    h.runner.join(10)
    assert [e["itemId"] for e in h.of("item_removed")] == ["v1"]
    assert [Path(e["file"]).name for e in h.of("item_done")] == ["乙.mp4"]
    assert h.summary == {"ok": 1, "skipped": 0, "failed": 0, "cancelled": False, "aborted": None}


def test_remove_item_during_cooldown(tmp_path):
    h = Harness(tmp_path)
    removed = []

    def sleeper(seconds):
        if not removed:
            removed.append(h.runner.remove("v2"))

    h.runner._sleep = sleeper
    h.run([item("v1", "甲"), item("v2", "乙"), item("v3", "丙")], cooldown=3)
    assert removed == ["current"]
    assert [e["itemId"] for e in h.of("item_removed")] == ["v2"]
    assert [Path(e["file"]).name for e in h.of("item_done")] == ["甲.mp4", "丙.mp4"]
    assert h.summary["cancelled"] is False


def test_remove_unknown_returns_none(tmp_path):
    h = Harness(tmp_path).run([item()])
    assert h.runner.remove("nope") is None


def test_failed_item_can_be_enqueued_again_in_the_same_job(tmp_path):
    h = Harness(tmp_path, fail={"v1": "ERROR: Unable to download webpage: timed out"})
    entered, gate = threading.Event(), threading.Event()
    blocking_stream(h, {"v2"}, entered, gate)
    h.runner.start("j", [item("v1", "甲"), item("v2", "乙")], 1080, h.out)
    assert entered.wait(5)  # v1 has failed by now and v2 is running
    h.fail.clear()
    assert h.runner.enqueue([item("v1", "甲")]) is True
    gate.set()
    h.runner.join(10)
    assert [e["itemId"] for e in h.of("item_failed")] == ["v1"]
    assert sorted(Path(e["file"]).name for e in h.of("item_done")) == ["乙.mp4", "甲.mp4"]


def test_removed_item_can_be_enqueued_again_in_the_same_job(tmp_path):
    h = Harness(tmp_path)
    entered, gate = threading.Event(), threading.Event()
    blocking_stream(h, {"v1"}, entered, gate)
    h.runner.start("j", [item("v1", "甲"), item("v2", "乙")], 1080, h.out)
    assert entered.wait(5)
    assert h.runner.remove("v1") == "current"
    assert h.runner.enqueue([item("v1", "甲")]) is True
    gate.set()
    h.runner.join(10)
    assert [e["itemId"] for e in h.of("item_removed")] == ["v1"]
    assert sorted(Path(e["file"]).name for e in h.of("item_done")) == ["乙.mp4", "甲.mp4"]


def test_every_video_downloads_through_its_own_partial_dir(tmp_path):
    h = Harness(tmp_path).run([item("v1", "同名"), item("v2", "同名")])
    (home1, temp1, name1), (home2, temp2, name2) = (paths_of(c) for c in h.calls)
    assert home1 == home2 == str(h.out)
    assert temp1 == str(h.out / ".ytdl-partial" / "v1") and temp2 == str(h.out / ".ytdl-partial" / "v2")
    assert "/" not in name1 and "\\" not in name1  # an absolute -o would make yt-dlp ignore -P temp:
    assert sorted([name1, name2]) == ["同名 [v2].mp4", "同名.mp4"]


def test_other_videos_unfinished_download_is_never_resumed(tmp_path):
    h = Harness(tmp_path)
    seen = []
    original = h.stream

    def stream(cmd, on_line, cancel):
        _, temp, name = paths_of(cmd)
        part = Path(temp, name + ".part")
        seen.append(part.exists())  # yt-dlp resumes whatever .part it finds under the name it is about to write
        if cmd[-1].endswith("v1"):
            part.parent.mkdir(parents=True, exist_ok=True)
            part.write_text("first video's bytes", encoding="utf-8")
            return StreamResult(1, "ERROR: Unable to download webpage: The read operation timed out", False)
        return original(cmd, on_line, cancel)

    h.runner._stream = stream
    h.run([item("v1", "同名"), item("v2", "同名")])
    assert seen == [False, False] and h.summary["ok"] == 1


def test_partial_dir_is_removed_after_success_and_the_parent_with_it(tmp_path):
    h = Harness(tmp_path)
    original = h.stream

    def stream(cmd, on_line, cancel):
        Path(paths_of(cmd)[1]).mkdir(parents=True)  # yt-dlp creates it while downloading
        return original(cmd, on_line, cancel)

    h.runner._stream = stream
    h.run([item()])
    assert h.summary["ok"] == 1
    assert not (h.out / ".ytdl-partial").exists() and (h.out / "標題.mp4").exists()


def test_partial_dir_of_a_failed_video_is_kept_for_the_retry(tmp_path):
    h = Harness(tmp_path)
    original = h.stream

    def stream(cmd, on_line, cancel):
        _, temp, name = paths_of(cmd)
        if cmd[-1].endswith("v1"):
            Path(temp).mkdir(parents=True, exist_ok=True)
            Path(temp, name + ".part").write_text("half", encoding="utf-8")
            return StreamResult(1, "ERROR: Unable to download webpage: The read operation timed out", False)
        Path(temp).mkdir(parents=True, exist_ok=True)
        return original(cmd, on_line, cancel)

    h.runner._stream = stream
    h.run([item("v1", "甲"), item("v2", "乙")])
    assert (h.out / ".ytdl-partial" / "v1" / "甲.mp4.part").read_text(encoding="utf-8") == "half"
    assert not (h.out / ".ytdl-partial" / "v2").exists()  # v2 finished: only its own dir goes away


def test_percent_in_a_title_is_escaped_in_the_template_only(tmp_path):
    h = Harness(tmp_path).run([item("v1", "100% 成長")])
    cmd = h.calls[0]
    assert cmd[cmd.index("-o") + 1] == "100%% 成長.mp4"
    assert (h.out / "100% 成長.mp4").exists() and h.of("item_done")[0]["file"].endswith("100% 成長.mp4")


MERGE_FAILED = "影片已下載但沒有合併成功（ffmpeg 可能無法使用），請按「檢查環境」"


def unmerged_stream(h, *, write_final=None, done_line=True):
    """yt-dlp with a broken ffmpeg: exit code 0, a done line, and the two streams left apart."""
    def stream(cmd, on_line, cancel):
        h.calls.append(cmd)
        home, _, name = paths_of(cmd)
        stem = Path(name).stem
        Path(home, f"{stem}.f137.mp4").write_text("video only", encoding="utf-8")
        Path(home, f"{stem}.f140.m4a").write_text("audio only", encoding="utf-8")
        if write_final is not None:
            Path(home, name).write_text(write_final, encoding="utf-8")
        if done_line:
            on_line(f"[ytdl-done]{cmd[-1].split('v=')[-1]}|1080|avc1.640028")
        return StreamResult(0, "", False)

    return stream


def test_unmerged_streams_are_a_failure_not_a_success(tmp_path):
    h = Harness(tmp_path)
    h.runner._stream = unmerged_stream(h)
    h.run([item()])
    assert h.of("item_done") == []
    failed = h.of("item_failed")
    assert [(e["itemId"], e["code"], e["reason"]) for e in failed] == [("v1", "merge_failed", MERGE_FAILED)]
    assert h.summary["ok"] == 0 and h.summary["failed"] == 1


def test_unmerged_streams_are_not_recorded_in_the_archive(tmp_path):
    h = Harness(tmp_path)
    h.runner._stream = unmerged_stream(h)
    h.run([item()])
    assert Archive(h.out).mapping() == {}
    h.runner._stream = h.stream  # ffmpeg fixed: the same video is downloaded again, not skipped
    h.run([item()], job_id="j2")
    assert h.of("item_done")[-1]["skipped"] is False and Archive(h.out).mapping() == {"v1": "標題.mp4"}


def test_empty_final_file_is_a_failure(tmp_path):
    h = Harness(tmp_path)
    h.runner._stream = unmerged_stream(h, write_final="")
    h.run([item()])
    assert [e["code"] for e in h.of("item_failed")] == ["merge_failed"] and h.of("item_done") == []


def test_exit_zero_without_the_done_line_is_a_failure(tmp_path):
    h = Harness(tmp_path)
    h.runner._stream = unmerged_stream(h, write_final="video", done_line=False)
    h.run([item()])
    assert [e["code"] for e in h.of("item_failed")] == ["merge_failed"] and Archive(h.out).mapping() == {}


def test_merge_failure_does_not_stop_the_batch(tmp_path):
    h = Harness(tmp_path)
    good, broken = h.stream, unmerged_stream(h)

    def stream(cmd, on_line, cancel):
        return (broken if cmd[-1].endswith("v1") else good)(cmd, on_line, cancel)

    h.runner._stream = stream
    h.run([item("v1", "甲"), item("v2", "乙")])
    assert h.summary["ok"] == 1 and h.summary["failed"] == 1
    assert [Path(e["file"]).name for e in h.of("item_done")] == ["乙.mp4"]


def test_two_merge_failures_in_a_row_stop_the_job(tmp_path):
    # a broken ffmpeg fails every video only after it was downloaded in full: stop before wasting the whole channel
    h = Harness(tmp_path)
    h.runner._stream = unmerged_stream(h)
    h.run([item("v1", "甲"), item("v2", "乙"), item("v3", "丙")])
    assert [e["itemId"] for e in h.of("item_failed")] == ["v1", "v2"]
    assert h.summary["aborted"]["code"] == "merge_failed" and "檢查環境" in h.summary["aborted"]["message"]


def test_a_good_video_between_merge_failures_keeps_the_job_going(tmp_path):
    h = Harness(tmp_path)
    good, broken = h.stream, unmerged_stream(h)

    def stream(cmd, on_line, cancel):
        return (good if cmd[-1].endswith("v2") else broken)(cmd, on_line, cancel)

    h.runner._stream = stream
    h.run([item("v1", "甲"), item("v2", "乙"), item("v3", "丙")])
    assert h.summary["aborted"] is None and h.summary["ok"] == 1 and h.summary["failed"] == 2


TIMEOUT = "ERROR: [youtube] x: Unable to download webpage: The read operation timed out"
TOO_MANY = "ERROR: [youtube] x: Unable to download webpage: HTTP Error 429: Too Many Requests"
DISK_FULL = "ERROR: unable to write data: [Errno 28] No space left on device"
LOCKED = "ERROR: Unable to rename file: [WinError 32] The process cannot access the file because it is being used by another process"
PRIVATE = "ERROR: [youtube] x: Private video. Sign in if you've been granted access to this video"


def recording(h):
    sleeps = []
    h.runner._sleep = sleeps.append
    return sleeps


def waits(h):
    return [(e["nextId"], e["seconds"]) for e in h.of("cooldown")]


def test_failures_are_spaced_by_the_cooldown_too(tmp_path):
    h = Harness(tmp_path, fail={"v1": PRIVATE})
    sleeps = recording(h)
    h.run([item("v1", "甲"), item("v2", "乙")], cooldown=3)
    assert waits(h) == [("v2", 3)] and sum(sleeps) == 3 and h.summary["failed"] == 1 and h.summary["ok"] == 1


def test_no_wait_before_items_that_never_touch_the_network(tmp_path):
    h = Harness(tmp_path).run([item("v1", "甲")], cooldown=3)  # v1 is now in the archive
    h.events.clear()
    sleeps = recording(h)
    h.run([item("v2", "乙"), item("p1", "[Private video]"), {"url": "https://evil.com/x", "id": None, "title": None},
           {"url": URL.format("x"), "id": "../x", "title": "t"}, item("v1", "甲"), item("v3", "丙")],
          job_id="j2", cooldown=3)
    assert waits(h) == [("v3", 3)] and sum(sleeps) == 3  # v2 is the first attempt; only v3 follows one
    assert [e["code"] for e in h.of("item_failed")] == ["private", "bad_url", "bad_id"]


def test_resolving_a_bare_url_counts_as_a_network_attempt(tmp_path):
    resolver = lambda e, urls, limit=None: [VideoRef("v9", "解析標題", URL.format("v9"))]
    h = Harness(tmp_path, resolve_fn=resolver)
    sleeps = recording(h)
    h.run([item("v1", "甲"), {"url": URL.format("v9")}], cooldown=3)
    assert waits(h) == [(URL.format("v9"), 3)] and sum(sleeps) == 3  # once, before the resolve (no id yet), not again
    assert h.summary["ok"] == 2


def test_cooldown_gets_between_zero_and_a_quarter_extra_never_less(tmp_path):
    for jitter, expected in [(0.0, 8), (0.5, 9), (0.999, 8 * 1.24975)]:
        h = Harness(tmp_path / str(jitter), jitter=jitter)
        sleeps = recording(h)
        h.run([item("v1", "甲"), item("v2", "乙")], cooldown=8)
        assert waits(h) == [("v2", pytest.approx(expected))] and sum(sleeps) == pytest.approx(expected)


def test_default_jitter_is_random_within_a_quarter(tmp_path):
    h = Harness(tmp_path)
    h.runner = JobRunner(h.runner.engine, h.events.append, stream=h.stream, sleep=lambda s: None, delay=0)
    h.run([item(f"v{i}", f"標題{i}") for i in range(1, 12)], cooldown=10)
    seconds = [e["seconds"] for e in h.of("cooldown")]
    assert len(seconds) == 10 and all(10 <= s <= 12.5 for s in seconds) and len(set(seconds)) > 1


def test_throttle_failures_double_the_wait_and_a_success_resets_it(tmp_path):
    h = Harness(tmp_path, fail={"v1": TIMEOUT, "v2": TOO_MANY})
    recording(h)
    h.run([item("v1", "一"), item("v2", "二"), item("v3", "三"), item("v4", "四")], cooldown=3)
    # after one failure max(5, 3) * 1, after two max(5, 3) * 2; v3 succeeded, so v4 waits the plain cooldown again
    assert waits(h) == [("v2", 5), ("v3", 10), ("v4", 3)]
    assert h.summary["aborted"] is None and h.summary["ok"] == 2


def test_throttle_wait_is_capped_and_never_below_the_configured_cooldown(tmp_path):
    h = Harness(tmp_path, fail={"v1": TIMEOUT, "v2": TIMEOUT, "v3": TIMEOUT})
    recording(h)
    h.run([item("v1", "一"), item("v2", "二"), item("v3", "三")], cooldown=100)
    assert waits(h) == [("v2", 100), ("v3", 120)]  # 100 * 2 = 200 is capped to 120
    h2 = Harness(tmp_path / "again", fail={"v1": TIMEOUT, "v2": TIMEOUT, "v3": TIMEOUT})
    recording(h2)
    h2.run([item("v1", "一"), item("v2", "二"), item("v3", "三")], cooldown=300)
    assert waits(h2) == [("v2", 300), ("v3", 300)]  # the cap never undercuts what the person asked for


def test_throttle_wait_with_zero_cooldown_is_still_at_least_five_seconds(tmp_path):
    h = Harness(tmp_path, fail={"v1": TIMEOUT})
    recording(h)
    h.run([item("v1", "一"), item("v2", "二")], cooldown=0)
    assert waits(h) == [("v2", 5)]


def test_three_throttle_failures_in_a_row_stop_the_job(tmp_path):
    h = Harness(tmp_path, fail={f"v{i}": TIMEOUT for i in range(1, 6)})
    recording(h)
    h.run([item(f"v{i}", f"標題{i}") for i in range(1, 6)], cooldown=3)
    assert len(h.calls) == 3
    assert [e["itemId"] for e in h.of("item_failed")] == ["v1", "v2", "v3"]  # v4 and v5 were never tried: no event
    aborted = h.summary["aborted"]
    assert aborted["code"] == "network" and "網路" in aborted["message"]
    assert h.summary["failed"] == 3 and h.summary["cancelled"] is False
    assert h.of("done")[-1]["jobId"] == "j" and len(h.of("done")) == 1


@pytest.mark.parametrize("stderr,code,needle", [
    (TOO_MANY, "rate_limited", "YouTube"),
    ("ERROR: unable to download video data: HTTP Error 403: Forbidden", "forbidden", "403"),
    ("ERROR: [youtube] x: Sign in to confirm you're not a bot", "bot_check", "機器人"),
    ("ERROR: Unable to download webpage: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed", "tls", "資訊人員"),
])
def test_every_throttle_class_counts_towards_the_stop(tmp_path, stderr, code, needle):
    h = Harness(tmp_path, fail={f"v{i}": stderr for i in range(1, 5)})
    recording(h)
    h.run([item(f"v{i}", f"標題{i}") for i in range(1, 5)])
    assert h.summary["aborted"]["code"] == code and needle in h.summary["aborted"]["message"]
    assert len(h.calls) == 3


@pytest.mark.parametrize("stderr", [
    "ERROR: [youtube] x: Sign in to confirm your age",
    "ERROR: [youtube] x: Join this channel to get access to members-only content",
])
def test_restricted_videos_in_a_row_do_not_stop_the_job(tmp_path, stderr):
    # age-gated or members-only videos say nothing about the connection: the job walks past all of them
    h = Harness(tmp_path, fail={f"v{i}": stderr for i in range(1, 5)})
    recording(h)
    h.run([item(f"v{i}", f"標題{i}") for i in range(1, 6)])
    assert h.summary["aborted"] is None and len(h.calls) == 5
    assert h.summary["failed"] == 4 and h.summary["ok"] == 1


def test_mixed_throttle_classes_stop_with_the_last_ones_code(tmp_path):
    h = Harness(tmp_path, fail={"v1": TIMEOUT, "v2": TOO_MANY, "v3": TOO_MANY, "v4": TIMEOUT})
    recording(h)
    h.run([item(f"v{i}", f"標題{i}") for i in range(1, 5)])
    assert h.summary["aborted"]["code"] == "rate_limited" and len(h.calls) == 3


def test_a_success_or_another_kind_of_failure_breaks_the_run(tmp_path):
    h = Harness(tmp_path, fail={"v1": TIMEOUT, "v2": TIMEOUT, "v4": TIMEOUT, "v5": TIMEOUT, "v6": PRIVATE,
                                "v7": TIMEOUT, "v8": TIMEOUT})
    recording(h)
    h.run([item(f"v{i}", f"標題{i}") for i in range(1, 9)])
    assert len(h.calls) == 8 and h.summary["aborted"] is None
    assert h.summary["failed"] == 7 and h.summary["ok"] == 1


DENO_WARNING = ("WARNING: [youtube] No supported JavaScript runtime could be found\n"
                "ERROR: [youtube] x: Requested format is not available")


def test_missing_deno_twice_in_a_row_stops_the_job(tmp_path):
    # without a JavaScript runtime every video fails the same way: stop after the second
    h = Harness(tmp_path, fail={f"v{i}": DENO_WARNING for i in range(1, 4)})
    recording(h)
    h.run([item(f"v{i}", f"標題{i}") for i in range(1, 4)])
    assert [e["code"] for e in h.of("item_failed")] == ["deno_missing", "deno_missing"] and len(h.calls) == 2
    assert h.summary["aborted"]["code"] == "deno_missing" and "Deno" in h.summary["aborted"]["message"]


def test_one_odd_failure_that_mentions_deno_does_not_end_the_batch(tmp_path):
    # a video that fails for another reason on a machine without Deno must not take the others with it
    h = Harness(tmp_path, fail={"v1": DENO_WARNING})
    recording(h)
    h.run([item(f"v{i}", f"標題{i}") for i in range(1, 4)])
    assert h.summary["aborted"] is None and h.summary["ok"] == 2 and h.summary["failed"] == 1


def test_disk_full_stops_the_job_at_once(tmp_path):
    h = Harness(tmp_path, fail={"v2": DISK_FULL})
    recording(h)
    h.run([item("v1", "甲"), item("v2", "乙"), item("v3", "丙")])
    assert [e["itemId"] for e in h.of("item_failed")] == ["v2"] and h.of("item_failed")[0]["code"] == "disk_full"
    assert len(h.calls) == 2
    aborted = h.summary["aborted"]
    assert aborted["code"] == "disk_full" and "磁碟" in aborted["message"]
    assert h.summary["ok"] == 1 and h.summary["failed"] == 1


def test_file_locked_is_not_fatal(tmp_path):
    h = Harness(tmp_path, fail={"v1": LOCKED})
    recording(h)
    h.run([item("v1", "甲"), item("v2", "乙")])
    assert h.of("item_failed")[0]["code"] == "file_locked"
    assert h.summary["aborted"] is None and h.summary["ok"] == 1


def test_output_folder_path_too_long_stops_the_job_without_touching_any_item(tmp_path):
    h = Harness(tmp_path)
    h.out = tmp_path / ("d" * 200)  # no room is left for a file name below it
    h.run([item("v1", "甲"), item("v2", "乙")])
    assert h.calls == [] and h.of("item_failed") == [] and h.of("item_done") == []
    aborted = h.summary["aborted"]
    assert aborted["code"] == "bad_path" and "太長" in aborted["message"]
    assert h.summary["failed"] == 0 and h.runner.running is False


def test_unusable_output_folder_stops_the_job_without_touching_any_item(tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("x", encoding="utf-8")
    h = Harness(tmp_path)
    h.out = blocker / "out"  # a folder cannot be created below a file
    h.run([item("v1", "甲"), item("v2", "乙")])
    assert h.calls == [] and h.of("item_failed") == [] and h.of("item_done") == []
    aborted = h.summary["aborted"]
    assert aborted["code"] == "bad_path" and "資料夾" in aborted["message"]
    assert h.summary["failed"] == 0 and h.runner.running is False


def test_normal_finish_reports_no_abort_and_a_cancel_is_not_an_abort(tmp_path):
    assert Harness(tmp_path).run([item()]).summary["aborted"] is None
    h = Harness(tmp_path / "c")
    h.runner._sleep = lambda seconds: h.runner.cancel()
    h.run([item("v1", "甲"), item("v2", "乙")], cooldown=5)
    assert h.summary["cancelled"] is True and h.summary["aborted"] is None


def test_cancel_during_a_backoff_wait_stops_promptly(tmp_path):
    h = Harness(tmp_path, fail={"v1": TIMEOUT, "v2": TIMEOUT})
    steps = []

    def sleeper(seconds):
        steps.append(seconds)
        if len(steps) == 2:
            h.runner.cancel()

    h.runner._sleep = sleeper
    h.run([item("v1", "一"), item("v2", "二"), item("v3", "三")], cooldown=3)
    assert len(steps) == 2 and all(step <= 1 for step in steps)  # the 5 s wait is sliced; cancel ends it after two
    assert len(h.calls) == 1 and h.summary["cancelled"] is True


def test_remove_current_item_during_a_backoff_wait(tmp_path):
    h = Harness(tmp_path, fail={"v1": TIMEOUT})
    removed = []

    def sleeper(seconds):
        if not removed:
            removed.append(h.runner.remove("v2"))

    h.runner._sleep = sleeper
    h.run([item("v1", "一"), item("v2", "二"), item("v3", "三")], cooldown=3)
    assert removed == ["current"] and [e["itemId"] for e in h.of("item_removed")] == ["v2"]
    assert [Path(e["file"]).name for e in h.of("item_done")] == ["三.mp4"]


@pytest.mark.filterwarnings("ignore::pytest.PytestUnhandledThreadExceptionWarning")
def test_running_flag_is_cleared_even_when_the_done_event_cannot_be_sent(tmp_path):
    h = Harness(tmp_path)

    def emit(event):
        if event["type"] == "done":
            raise BrokenPipeError(32, "Broken pipe")

    h.runner._emit = emit
    h.run([item()])
    assert h.runner.running is False


# -- log ---------------------------------------------------------------------------------------------

def test_log_records_job_start_and_the_done_summary(tmp_path):
    h = Harness(tmp_path).run([item("v1", "甲"), item("v2", "乙")], job_id="job1", quality=720, cooldown=0)
    text = "\n".join(h.logged)
    assert "job start id=job1 items=2 quality=720 cooldown=0" in text
    assert "job done id=job1" in text and "ok=2" in text and "aborted=None" in text


def test_log_item_failed_has_code_and_the_stderr_tail_capped(tmp_path):
    noisy = "\n".join(f"WARNING: noise {i}" for i in range(40)) + "\nERROR: [youtube] v1: Private video. Sign in"
    h = Harness(tmp_path, fail={"v1": noisy}).run([item("v1", "甲")])
    entry = next(m for m in h.logged if m.startswith("item_failed"))
    assert "item=v1" in entry and "code=private" in entry and "Private video" in entry
    assert "noise 39" in entry and "noise 5\n" not in entry  # only the last ~15 lines
    assert len(entry) < 2048 + 300


def test_log_item_failed_for_a_big_stderr_stays_under_2kb_of_stderr(tmp_path):
    h = Harness(tmp_path, fail={"v1": "\n".join("E" * 500 for _ in range(30))}).run([item("v1", "甲")])
    entry = next(m for m in h.logged if m.startswith("item_failed"))
    assert len(entry) < 2048 + 300


def test_log_keeps_warnings_of_a_successful_download(tmp_path):
    h = Harness(tmp_path)
    plain = h.stream

    def warn(cmd, on_line, cancel):
        result = plain(cmd, on_line, cancel)
        return StreamResult(result.returncode, "WARNING: [youtube] No supported JavaScript runtime could be found", False)

    h.runner._stream = warn
    h.run([item()])
    assert any("No supported JavaScript runtime" in m and m.startswith("item_warnings") for m in h.logged)
    assert h.summary["ok"] == 1 and not h.of("item_failed")


def test_log_records_cooldown_waits_and_backoff(tmp_path):
    h = Harness(tmp_path, fail={v: "ERROR: HTTP Error 429: Too Many Requests" for v in ("v1", "v2")})
    h.run([item("v1", "甲"), item("v2", "乙"), item("v3", "丙")], cooldown=10)
    waits = [m for m in h.logged if m.startswith("cooldown")]
    assert waits[0].startswith("cooldown 10.0s before v2") and "streak 1" in waits[0]
    assert waits[1].startswith("cooldown 20.0s before v3") and "streak 2" in waits[1]


def test_log_records_an_abort_in_the_done_line(tmp_path):
    h = Harness(tmp_path, fail={v: "ERROR: HTTP Error 429: Too Many Requests" for v in ("v1", "v2", "v3")})
    h.run([item("v1", "甲"), item("v2", "乙"), item("v3", "丙"), item("v4", "丁")], cooldown=0)
    done = next(m for m in h.logged if m.startswith("job done"))
    assert "rate_limited" in done and "failed=3" in done


def test_log_records_an_unexpected_exception_with_its_traceback(tmp_path):
    h = Harness(tmp_path)

    def boom(cmd, on_line, cancel):
        raise OSError("blocked by antivirus")

    h.runner._stream = boom
    h.run([item()])
    entry = next(m for m in h.logged if m.startswith("item_failed"))
    assert "code=unknown" in entry and "blocked by antivirus" in entry and "Traceback" in entry


def test_last_job_keeps_a_summary_in_memory(tmp_path):
    h = Harness(tmp_path, fail={"v2": "ERROR: Private video"})
    assert h.runner.last_job is None
    h.run([item("v1", "甲"), item("v2", "乙")], job_id="job9", quality=1080, cooldown=0)
    last = h.runner.last_job
    assert last["jobId"] == "job9" and last["items"] == 2 and last["quality"] == 1080 and last["cooldown"] == 0
    assert last["summary"]["ok"] == 1 and last["summary"]["failed"] == 1
    assert last["failures"] == [{"itemId": "v2", "code": "private"}]
    assert isinstance(last["finishedAt"], str)


def test_runner_without_a_log_still_works(tmp_path):
    runner = JobRunner(Engine(Path("yt-dlp")), [].append, stream=lambda c, o, k: StreamResult(0, "", False),
                       sleep=lambda s: None, delay=0)
    runner.start("j", [item()], 720, tmp_path / "out")
    runner.join(10)
