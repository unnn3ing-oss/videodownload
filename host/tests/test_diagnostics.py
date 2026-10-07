import json
from pathlib import Path

import diagnostics
from diagnostics import MAX_BYTES, build_report
from doctor import Check

READY = {"type": "ready", "hostVersion": "0.3.0", "ytdlpVersion": "2099.01.01", "ffmpegOk": True,
         "jsRuntimeOk": False, "outputDir": "/x"}
CHECKS = [Check("python", "ok", "Python 3.12.3", "/usr/bin/python3"),
          Check("deno", "error", "找不到 Deno（YouTube 解題需要）", "/h/bin/deno", "重新執行安裝檔")]
LAST_JOB = {"jobId": "job1", "items": 3, "quality": 720, "cooldown": 2.0,
            "summary": {"ok": 2, "skipped": 0, "failed": 1, "cancelled": False, "aborted": None},
            "failures": [{"itemId": "v2", "code": "private"}], "finishedAt": "2026-10-07 10:00:00"}


def build(home, **kw):
    kw.setdefault("ready", lambda: READY)
    kw.setdefault("diagnose", lambda: CHECKS)
    kw.setdefault("last_job", LAST_JOB)
    kw.setdefault("home_dir", "")
    kw.setdefault("user", "")
    return build_report(home, **kw)


def put_log(home: Path, name: str, lines: list[str]) -> None:
    (home / "logs").mkdir(parents=True, exist_ok=True)
    (home / "logs" / name).write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_report_has_every_section(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    (home / "install.json").write_text(json.dumps({"extensionFolder": "/ext", "version": "0.3.0"}), encoding="utf-8")
    put_log(home, "host.log", ["host line 1", "host line 2"])
    put_log(home, "install.log", ["install line 1"])
    text = build(home, now="2026-10-07T10:30:00+08:00")
    assert "診斷資訊" in text and "2026-10-07T10:30:00+08:00" in text
    for needle in ("版本", "下載助手：0.3.0", "Python：", "系統：", "yt-dlp：2099.01.01", "ffmpeg：有", "Deno：沒有"):
        assert needle in text, needle
    assert "[ok] python — Python 3.12.3 — /usr/bin/python3" in text
    assert "[error] deno — 找不到 Deno（YouTube 解題需要） — /h/bin/deno" in text and "重新執行安裝檔" in text
    assert '"extensionFolder": "/ext"' in text
    assert "host.log" in text and "host line 2" in text and "install.log" in text and "install line 1" in text
    assert "job1" in text and "private" in text and "v2" in text


def test_report_without_logs_install_record_or_job_is_still_complete(tmp_path):
    text = build(tmp_path / "missing-home", last_job=None)
    assert "（沒有 host.log）" in text and "（沒有 install.log）" in text
    assert "（沒有安裝紀錄）" in text and "（還沒有下載工作）" in text


def test_report_keeps_only_the_last_200_lines_of_each_log(tmp_path):
    put_log(tmp_path, "host.log", [f"entry {i}" for i in range(500)])
    text = build(tmp_path)
    assert "entry 499" in text and "entry 300" in text and "entry 299" not in text


def test_report_redacts_the_home_folder_and_user_name_everywhere(tmp_path):
    put_log(tmp_path, "host.log", ["engine at /home/alice/bin by alice"])
    (tmp_path / "install.json").write_text(json.dumps({"extensionFolder": "/home/alice/ext"}), encoding="utf-8")
    text = build(tmp_path, home_dir="/home/alice", user="alice",
                 diagnose=lambda: [Check("output", "ok", "存放資料夾 /home/alice/Downloads", "alice")])
    assert "alice" not in text
    assert "~/bin by <user>" in text and "~/ext" in text and "~/Downloads" in text


def test_a_failing_section_does_not_sink_the_bundle(tmp_path):
    def boom():
        raise RuntimeError("doctor exploded")

    text = build(tmp_path, diagnose=boom, ready=boom)
    assert "無法取得" in text and "doctor exploded" in text and "診斷資訊" in text and "Python：" in text


def test_report_is_capped_keeping_the_header_and_the_newest_log_lines(tmp_path):
    put_log(tmp_path, "host.log", [f"host {i:05d} " + "h" * 200 for i in range(200)])
    put_log(tmp_path, "install.log", [f"inst {i:05d} " + "i" * 200 for i in range(200)])
    text = build(tmp_path)
    assert len(text.encode("utf-8")) <= MAX_BYTES == 60 * 1024
    assert "…cut…" in text and "下載助手：0.3.0" in text
    assert "host 00199" in text and "inst 00199" in text  # the newest lines survive


def test_cap_keeps_the_tail_and_marks_the_cut():
    text = "".join(f"line {i:06d}\n" for i in range(20000))
    out = diagnostics.cap(text, 1000)
    assert len(out.encode("utf-8")) <= 1000 and out.startswith("…cut…") and out.rstrip().endswith("line 019999")
    assert diagnostics.cap("short", 1000) == "short"


def test_cap_never_splits_a_multibyte_character():
    out = diagnostics.cap("中" * 1000, 100)
    assert len(out.encode("utf-8")) <= 100 and set(out.replace("…cut…\n", "")) == {"中"}


def test_report_never_mentions_the_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("YTDL_SECRET_COOKIE", "sid=topsecret")
    assert "topsecret" not in build(tmp_path)
