import threading
from pathlib import Path

import pytest

from config import ConfigStore
from jobs import Archive, JobRunner
from ytdlp import Engine, ResolveError, StreamResult, VideoRef

URL = "https://www.youtube.com/watch?v={}"


def item(vid="v1", title="標題"):
    return {"url": URL.format(vid), "id": vid, "title": title}


class Harness:
    """JobRunner wired to a fake yt-dlp that writes the -o target and prints a done line."""

    def __init__(self, tmp_path, *, height=1080, codec="avc1.640028", fail=None, resolve_fn=None, delay=0):
        self.out = tmp_path / "out"
        self.events, self.calls = [], []
        self.height, self.codec, self.fail = height, codec, fail or {}
        self.runner = JobRunner(Engine(Path("yt-dlp")), self.events.append, stream=self.stream,
                                resolve_fn=resolve_fn or (lambda e, u, limit=None: []),
                                sleep=lambda s: None, delay=delay)

    def stream(self, cmd, on_line, cancel):
        self.calls.append(cmd)
        vid = cmd[-1].split("v=")[-1]
        if vid in self.fail:
            return StreamResult(1, self.fail[vid], False)
        Path(cmd[cmd.index("-o") + 1].replace("%%", "%")).write_text("x", encoding="utf-8")
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
    assert h.summary == {"ok": 1, "skipped": 0, "failed": 0, "cancelled": False}
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
    assert h.summary == {"ok": 1, "skipped": 0, "failed": 1, "cancelled": False}


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
    assert h.summary == {"ok": 1, "skipped": 0, "failed": 0, "cancelled": False}


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
