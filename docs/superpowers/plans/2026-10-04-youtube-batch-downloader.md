# YouTube 批量下載工具 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立「Chrome 擴充功能 + 本機 Native Messaging 小程式」，在 Windows／Mac 本機批量下載 YouTube 公開影片（720p/1080p），檔名用影片標題。

**Architecture:** 擴充功能（MV3）的 background service worker 持有 Native Messaging 連線，popup 透過它與 Python 標準函式庫寫成的 host 溝通；host 以 subprocess 呼叫 yt-dlp 獨立執行檔（搭配 ffmpeg、Deno）。單檔安裝檔由 `build.py` 產生，內嵌 host 程式碼，負責取得依賴並登錄 Native Messaging。

**Tech Stack:** Python 3（host 只用標準函式庫；測試用 pytest）、JavaScript ES modules（測試用 `node --test`，e2e 用 Playwright）、PowerShell／bash 安裝檔、yt-dlp、ffmpeg、Deno。

**Spec:** `docs/superpowers/specs/2026-10-04-youtube-batch-downloader-design.md`

## Global Constraints

- host 只用 Python 標準函式庫；Windows 用 Python 3.12.8 embeddable，Mac 用系統 `python3`（≥3.9）。
- Chrome 最低版本 110；擴充功能 Manifest V3；權限只有 `nativeMessaging`、`downloads`、`activeTab`、`storage`。
- 不開本機網路埠；host 登錄的 `allowed_origins` 只含 `chrome-extension://<固定識別碼>/`。
- 畫質只有 720、1080；優先 H.264（`avc1`）+ AAC（`mp4a`），輸出 mp4；選 N 抓「高度不超過 N 的最佳畫質」，來源較低不算失敗。
- 檔名：用影片標題；`\ / : * ? " < > |` 與控制字元替換為 `_`；移除結尾的點與空白；保留名稱（CON、NUL、COM1 等）前加 `_`；長度 ≤ 200 字元；完整路徑 ≤ 240 字元（為 yt-dlp 暫存檔名留空間）、檔名每段 ≤ 239 位元組；已存在且不屬於同一支影片時加 ` [影片ID]`。
- 只接受 youtube.com（含子網域）與 youtu.be 的 http/https 網址。
- 呼叫 yt-dlp 一律用參數陣列、網址前加 `--`、加 `--ignore-config`，不經 shell。
- host→擴充功能單則訊息 ≤ 1,000,000 位元組。
- yt-dlp 需要 JS 執行環境，預設 Deno；以 `--js-runtimes deno:<路徑>` 指定；獨立執行檔已內含 yt-dlp-ejs（已於 yt-dlp wiki 查證，2026-10-04）。
- 預設存放位置：使用者下載資料夾下的 `YT下載`；安裝目錄：Windows `%LOCALAPPDATA%\YTDownloader`、Mac `~/Library/Application Support/YTDownloader`。
- 一次一個下載工作，工作內逐支下載，支與支之間間隔 2 秒。
- Native Messaging host 名稱固定為 `com.ytdl.batch_downloader`（`build.py` 與 `extension/lib/constants.js` 各一份，由測試確保一致）。
- 所有給使用者看的文字使用繁體中文（台灣用語）。

## Review Focus

1. **頻道根網址**（`youtube.com/@名稱`）：yt-dlp 會列出分頁而不是影片。預期：自動改查 `/videos`。→ Task 5
2. **長中文標題 + 很深的下載資料夾**：Windows 路徑超過 260 字元會寫檔失敗。預期：標題被截短到整條路徑 ≤ 250。→ Task 3
3. **播放清單含私人／已刪除影片**：清單中標題為 `[Private video]`、`[Deleted video]`。預期：該支標記失敗並說明原因，不叫用 yt-dlp、不用這個標題當檔名，其餘照常。→ Task 6
4. **host 的標準輸出被雜訊汙染**：任何 `print` 或函式庫警告都會破壞 Native Messaging 資料流。預期：雜訊進 stderr，訊息串流保持完整。→ Task 7
5. **同一批重複的網址／影片，以及下載中途被中斷**：預期：同一個影片 ID 只下載一次；內部紀錄檔損毀或中斷時不拋錯，只當作沒有紀錄。→ Task 6

---

## 檔案結構

| 檔案 | 職責 |
|---|---|
| `host/protocol.py` | Native Messaging 訊息編解碼 |
| `host/quality.py` | 畫質 → yt-dlp 格式字串 |
| `host/naming.py` | 檔名清理、路徑長度、衝突處理 |
| `host/security.py` | 網址白名單、輸出路徑檢查（規格未列，為第 6 節「安全」新增獨立檔） |
| `host/ytdlp.py` | 引擎參數、輸出解析、錯誤分類、網址正規化、展開清單、串流執行 |
| `host/config.py` | 輸出資料夾設定的讀寫（規格未列） |
| `host/jobs.py` | 內部紀錄檔、下載工作佇列、取消 |
| `host/host.py` | 入口與訊息分派 |
| `extension/lib/*.js` | 純邏輯（網址解析、平台判斷、事件歸併、常數） |
| `extension/manifest.json`、`background.js`、`popup.*` | 擴充功能殼層 |
| `build.py`、`installers/templates/*` | 產生單檔安裝檔 |

---

### Task 1: 專案骨架與 Native Messaging 編解碼

**Files:**
- Create: `pytest.ini`（`pythonpath = host .`、`testpaths = host/tests tests`）、`requirements-dev.txt`（`pytest`）、`.gitignore`、`host/protocol.py`、`host/tests/test_protocol.py`

**Interfaces:**
- Produces: `class ProtocolError(Exception)`；`MAX_OUT = 1_000_000`；`MAX_IN = 8 * 1024 * 1024`；`read_message(stream: BinaryIO) -> dict | None`（乾淨 EOF 回傳 `None`）；`write_message(stream: BinaryIO, msg: dict) -> None`

- [ ] **Step 1: 寫失敗的測試** `host/tests/test_protocol.py`

```python
def test_roundtrip_unicode():            # {"type":"ping","t":"標題"} 寫入後讀回相等
def test_wire_format():                  # write {"a":1} → 前 4 bytes == struct.pack("=I", 7)，其後 == b'{"a":1}'
def test_eof_returns_none():             # read_message(BytesIO(b"")) is None
def test_truncated_header_raises():      # BytesIO(b"\x05\x00") → ProtocolError
def test_truncated_body_raises():        # 標頭宣告 10 bytes、實際 3 bytes → ProtocolError
def test_invalid_json_raises():          # 本文 b"{nope" → ProtocolError
def test_non_object_raises():            # 本文 b"[1]" → ProtocolError
def test_incoming_over_limit_raises():   # 標頭宣告 MAX_IN+1 → ProtocolError，且不讀本文
def test_outgoing_over_limit_raises():   # write_message 超過 MAX_OUT bytes → ProtocolError
```

- [ ] **Step 2: 執行確認失敗**：`pip install -r requirements-dev.txt && pytest host/tests/test_protocol.py -v`，預期 FAIL（`protocol` 模組不存在）。
- [ ] **Step 3: 實作 `host/protocol.py`**：JSON 用 `separators=(",", ":")`、`ensure_ascii=False`、UTF-8；長度標頭用 `struct` 原生位元組序 `=I`。
- [ ] **Step 4: 執行確認通過**：同 Step 2 指令，預期 9 passed。
- [ ] **Step 5: Commit**：`git add -A && git commit -m "feat(host): native messaging protocol codec"`

### Task 2: 畫質格式

**Files:** Create `host/quality.py`、`host/tests/test_quality.py`

**Interfaces:**
- Produces: `parse_quality(value: object) -> int`（只接受 720、1080 或其數字字串，否則 `ValueError`）；`format_selector(quality: int) -> str`；`is_h264(codec: str | None) -> bool`

- [ ] **Step 1: 寫失敗的測試**

```python
def test_format_selector_1080():
    assert format_selector(1080) == "bv*[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=1080]+ba/b[height<=1080]"
def test_format_selector_720():   # 同上，數字換 720
def test_parse_quality_accepts_720_1080_and_strings():  # 720, "1080" → 720, 1080
def test_parse_quality_rejects_others():  # 480, "abc", None, True, 1080.5 → ValueError
def test_is_h264():  # "avc1.640028" True；"vp09.00.40.08"、"av01.0.08M.08"、None、"NA" False
```

- [ ] **Step 2: 執行確認失敗**：`pytest host/tests/test_quality.py -v`
- [ ] **Step 3: 實作** 上述三個函式；`parse_quality` 要拒絕 `bool`。
- [ ] **Step 4: 執行確認通過**：同 Step 2。
- [ ] **Step 5: Commit**：`git commit -am "feat(host): quality selector"`（先 `git add`）

### Task 3: 檔名清理與衝突處理

**Files:** Create `host/naming.py`、`host/tests/test_naming.py`

**Interfaces:**
- Produces: `sanitize_filename(name: str, max_len: int = 200) -> str`；`resolve_target(directory: Path, title: str, video_id: str, ext: str = "mp4", known: dict[str, str] | None = None) -> Path`（`known` 為影片 ID → 檔名）；輸出資料夾本身過長（沒有空間給檔名）時 `ValueError`

- [ ] **Step 1: 寫失敗的測試**

```python
def test_illegal_chars():  assert sanitize_filename('a/b:c*d?"e<f>g|h\\i') == "a_b_c_d__e_f_g_h_i"
def test_control_chars():  assert sanitize_filename("a\x00b\x1fc") == "a_b_c"
def test_trailing_dots_spaces():  assert sanitize_filename("title. . ") == "title"
def test_reserved_names():  # "CON"→"_CON"、"nul"→"_nul"、"COM1"→"_COM1"、"con.txt"→"_con.txt"
def test_empty_after_clean():  assert sanitize_filename("...") == ""
def test_max_len():  assert len(sanitize_filename("字" * 300, 200)) == 200
def test_resolve_plain(tmp_path):  assert resolve_target(tmp_path, "標題", "abc123") == tmp_path / "標題.mp4"
def test_resolve_collision_adds_id(tmp_path):  # 先建立 標題.mp4，known 為空 → tmp_path / "標題 [abc123].mp4"
def test_resolve_same_video_reuses(tmp_path):  # 先建立 標題.mp4，known={"abc123": "標題.mp4"} → tmp_path / "標題.mp4"
def test_resolve_empty_title_uses_id(tmp_path):  # title="..." → tmp_path / "vid.mp4"
def test_total_path_limit():
    d = Path("/" + "d" * 200)
    r = resolve_target(d, "字" * 300, "abcdefghijk")
    assert len(str(r)) <= 250 and r.name.endswith(".mp4")
def test_directory_too_long_raises():  # Path("/" + "d" * 245) → ValueError
```

- [ ] **Step 2: 執行確認失敗**：`pytest host/tests/test_naming.py -v`
- [ ] **Step 3: 實作** 兩個函式。`resolve_target` 先算可用長度 `min(200, 250 - len(str(directory)) - len(f" [{video_id}].{ext}") - 1)`，再截短清理後的標題，最後依存在與否與 `known` 決定是否加 ` [id]`。
- [ ] **Step 4: 執行確認通過**：同 Step 2。
- [ ] **Step 5: Commit**：`git add -A && git commit -m "feat(host): filename sanitizing and collision handling"`

### Task 4: 網址白名單與路徑安全

**Files:** Create `host/security.py`、`host/tests/test_security.py`

**Interfaces:**
- Produces: `is_allowed_url(url: object) -> bool`；`safe_output_path(base: Path, name: str) -> Path`（逃出 `base` 或 `name` 含路徑分隔符時 `ValueError`）

- [ ] **Step 1: 寫失敗的測試**

```python
ALLOWED = ["https://www.youtube.com/watch?v=abc", "https://youtu.be/abc", "http://m.youtube.com/@x/videos",
           "https://music.youtube.com/playlist?list=1", "https://youtube.com/@x"]
DENIED  = ["https://youtube.com.evil.com/x", "https://evil.com/?u=https://youtube.com", "https://youtube.com@evil.com/",
           "https://notyoutube.com/", "ftp://youtube.com/x", "file:///etc/passwd", "javascript:alert(1)",
           "-o /etc/x", "", None, 123]
def test_allowed_urls():  # 全部 True
def test_denied_urls():   # 全部 False
def test_safe_output_path_ok(tmp_path):  # safe_output_path(tmp_path, "a.mp4") == (tmp_path / "a.mp4").resolve()
def test_safe_output_path_rejects(tmp_path):  # "../x"、"/etc/x"、"a/b.mp4"、"a\\b.mp4" → ValueError
```

- [ ] **Step 2: 執行確認失敗**：`pytest host/tests/test_security.py -v`
- [ ] **Step 3: 實作** 兩個函式；網址用 `urllib.parse.urlsplit`，比對 `hostname`（`== "youtube.com"`、`endswith(".youtube.com")`、`== "youtu.be"`）。
- [ ] **Step 4: 執行確認通過**：同 Step 2。
- [ ] **Step 5: Commit**：`git add -A && git commit -m "feat(host): url allow-list and path safety"`

### Task 5: yt-dlp 介面（參數、解析、錯誤分類、展開、串流）

**Files:** Create `host/ytdlp.py`、`host/tests/test_ytdlp.py`

**Interfaces:**
- Consumes: `quality.format_selector(quality: int) -> str`
- Produces:
  - `@dataclass Engine(ytdlp: Path, ffmpeg_dir: Path | None = None, js_runtime: Path | None = None)`
  - `@dataclass Progress(percent: float | None, speed: float | None, eta: int | None)`；`@dataclass DoneInfo(video_id: str, height: int | None, codec: str | None)`；`@dataclass VideoRef(id: str, title: str, url: str)`
  - `@dataclass StreamResult(returncode: int, stderr: str, cancelled: bool)`；`class ResolveError(Exception)`（屬性 `code`、`message`）
  - `PROGRESS_PREFIX = "[ytdl-progress]"`、`DONE_PREFIX = "[ytdl-done]"`
  - `build_download_args(engine: Engine, url: str, quality: int, target: Path) -> list[str]`
  - `parse_progress_line(line: str) -> Progress | None`；`parse_done_line(line: str) -> DoneInfo | None`
  - `classify_error(stderr: str) -> tuple[str, str]`（代碼、繁體中文訊息）；代碼：`private`、`unavailable`、`region`、`login_required`、`network`、`engine_outdated`、`disk_full`、`unknown`
  - `normalize_url(url: str) -> str`
  - `resolve(engine: Engine, urls: list[str], limit: int | None = None, run=run_capture) -> list[VideoRef]`；`run_capture(cmd: list[str]) -> tuple[int, str, str]`
  - `stream_download(cmd: list[str], on_line: Callable[[str], None], cancel: threading.Event) -> StreamResult`

- [ ] **Step 1: 寫失敗的測試**

```python
def test_build_args():
    a = build_download_args(Engine(Path("yt-dlp"), Path("/ff"), Path("/dn/deno")), "https://youtu.be/x", 1080, Path("/o/t.mp4"))
    assert a[0] == "yt-dlp" and "--ignore-config" in a and "--no-playlist" in a
    assert a[a.index("-f") + 1] == format_selector(1080)
    assert a[a.index("--merge-output-format") + 1] == "mp4" and a[a.index("-o") + 1] == "/o/t.mp4"
    assert a[a.index("--js-runtimes") + 1] == "deno:/dn/deno" and a[a.index("--ffmpeg-location") + 1] == "/ff"
    assert a[-2:] == ["--", "https://youtu.be/x"]
def test_build_args_without_optional_parts():   # 沒有 ffmpeg_dir/js_runtime 時不出現 --ffmpeg-location、--js-runtimes
def test_parse_progress():
    assert parse_progress_line("[ytdl-progress]512|1024|NA|2048.5|3") == Progress(50.0, 2048.5, 3)
    assert parse_progress_line("[ytdl-progress]512|NA|2048|NA|NA") == Progress(25.0, None, None)
    assert parse_progress_line("[ytdl-progress]512|NA|NA|NA|NA") == Progress(None, None, None)
    assert parse_progress_line("random") is None
def test_parse_done():
    assert parse_done_line("[ytdl-done]abc|1080|avc1.640028") == DoneInfo("abc", 1080, "avc1.640028")
    assert parse_done_line("[ytdl-done]abc|NA|NA") == DoneInfo("abc", None, None)
    assert parse_done_line("x") is None
def test_classify():   # 每列：stderr 子字串 → 代碼
    # "ERROR: [youtube] x: Private video. Sign in if you've been granted access" → private（優先於 login_required）
    # "Video unavailable" → unavailable；"This video is not available in your country" → region
    # "Sign in to confirm you’re not a bot" 與 "Sign in to confirm your age" → login_required
    # "Unable to download webpage: ... timed out"、"Temporary failure in name resolution" → network
    # "n challenge solving failed"、"Unable to extract" → engine_outdated；"No space left on device" → disk_full；其他 → unknown
def test_normalize_url():
    # https://www.youtube.com/@abc、…/@abc/、…/@abc?si=x → …/@abc/videos、…/@abc/videos、…/@abc/videos?si=x
    # /channel/UC123、/c/Name、/user/Name 末尾補 /videos
    # …/@abc/videos、…/@abc/shorts、watch?v=abc、playlist?list=1、https://youtu.be/abc 不變
def test_resolve_expands_and_dedupes():
    # fake run 回傳 JSON 行：{"id":"a1","title":"T1"}、{"id":"a2","title":None}、{"id":"a1","title":"T1"}
    # → [VideoRef("a1","T1","https://www.youtube.com/watch?v=a1"), VideoRef("a2","a2","https://www.youtube.com/watch?v=a2")]
    # 且 limit=5 時指令含 "--playlist-end", "5"，並含 "--flat-playlist"、"--dump-json"、"--ignore-config"
def test_resolve_failure_raises():   # fake run 回 (1, "", "Private video") 且無輸出 → ResolveError.code == "private"
def test_stream_lines_and_stderr():   # [sys.executable,"-c",'print("a");print("b")'] → lines ["a","b"]、returncode 0
def test_stream_failure():            # 子行程把 "boom" 寫到 stderr 並 exit 3 → StreamResult(3, "boom", False)
def test_stream_cancel():             # 子行程 sleep 30 秒；0.2 秒後 cancel.set() → 5 秒內返回，cancelled True、returncode != 0
```

- [ ] **Step 2: 執行確認失敗**：`pytest host/tests/test_ytdlp.py -v`
- [ ] **Step 3: 實作** 上述介面。`build_download_args` 用 `--progress --newline --no-colors`、`--progress-template "download:[ytdl-progress]%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s"`、`--print "after_move:[ytdl-done]%(id)s|%(height)s|%(vcodec)s"`。`stream_download` 用 `subprocess.Popen`，另開執行緒持續讀 stderr 以免管線塞滿，取消時 terminate 後 kill。
- [ ] **Step 4: 驗證旗標與範本確實存在**：`pip install yt-dlp && yt-dlp --help | grep -E "progress-template|--print |js-runtimes|flat-playlist|ignore-config"`，每個旗標都要有輸出；若有不符，修正 `build_download_args` 與測試的固定字串。
- [ ] **Step 5: 執行確認通過**：同 Step 2。
- [ ] **Step 6: Commit**：`git add -A && git commit -m "feat(host): yt-dlp interface"`

### Task 6: 設定、內部紀錄檔與下載工作

**Files:** Create `host/config.py`、`host/jobs.py`、`host/tests/test_jobs.py`

**Interfaces:**
- Consumes: `naming.resolve_target`、`security.is_allowed_url`、`quality.parse_quality`、`ytdlp.{Engine, VideoRef, StreamResult, build_download_args, parse_progress_line, parse_done_line, classify_error, resolve, stream_download}`
- Produces:
  - `class ConfigStore(path: Path)`：屬性 `output_dir: Path`（預設下載資料夾下的 `YT下載`）；`set_output_dir(value: str) -> Path`（空字串或不是字串時 `ValueError`；父層不存在時建立）
  - `class Archive(directory: Path)`：檔案 `.ytdl-archive.json`；`mapping() -> dict[str, str]`；`lookup(video_id: str) -> str | None`（只在檔案仍存在時回傳檔名）；`record(video_id: str, filename: str) -> None`（寫暫存檔再 `os.replace`）；檔案損毀時視為空
  - `class JobRunner(engine, emit: Callable[[dict], None], stream=stream_download, resolve_fn=resolve, sleep=time.sleep, delay: float = 2.0)`
    - `start(job_id: str, items: list[dict], quality: int, output_dir: Path, title_override: str | None = None) -> None`（背景執行緒；已有工作進行中時 `RuntimeError("busy")`）
    - `cancel() -> None`；`join(timeout: float | None = None) -> None`；`running: bool`
  - `items` 元素為 `{"url": str, "id": str | None, "title": str | None}`
  - 事件：`{"type":"progress","jobId","itemId","percent","speed","eta","stage":"download"}`；`{"type":"item_done","jobId","itemId","file","height","codec","skipped":bool}`；`{"type":"item_failed","jobId","itemId","reason","code"}`；`{"type":"done","jobId","summary":{"ok","skipped","failed","cancelled"}}`

- [ ] **Step 1: 寫失敗的測試**（以假的 `stream` 在 `-o` 指定路徑寫入檔案並回報進度與完成行，`sleep=lambda s: None`）

```python
def test_success_names_file_by_title_and_records():  # item_done.file 結尾為 "標題.mp4"、height 1080；done.summary == {"ok":1,"skipped":0,"failed":0,"cancelled":False}
def test_rerun_skips_downloaded():                   # 第二次 item_done.skipped is True，stream 未被呼叫
def test_deleted_file_is_redownloaded():             # 紀錄存在但檔案被刪 → 重新下載
def test_failure_does_not_stop_batch():              # 第一支 stderr "Private video" → item_failed.code == "private"；第二支成功；summary ok 1、failed 1
def test_placeholder_titles_fail_without_download(): # 標題 "[Private video]" → code "private"；"[Deleted video]" → code "unavailable"；stream 呼叫 0 次
def test_duplicate_ids_downloaded_once():            # 同一 id 兩次 → stream 只呼叫 1 次
def test_lower_height_than_requested_is_success():   # 要求 1080、完成行 height 720 → item_done.height == 720
def test_bad_url_fails():                            # "https://evil.com/x" → item_failed.code == "bad_url"
def test_missing_title_is_resolved():                # 缺 title/id → resolve_fn 補齊後下載
def test_title_override_applies_to_single_item():    # title_override="自訂" → 檔名 "自訂.mp4"
def test_cancel_stops_remaining_items():             # 第一支下載中 cancel() → done.summary.cancelled is True，第二支不啟動
def test_busy_when_job_running():                    # 工作進行中再 start → RuntimeError
def test_archive_corrupt_file_is_empty(tmp_path):    # 內容 "{broken" → mapping() == {}，record 後可讀回
def test_archive_not_recorded_on_failure():          # 失敗項目不在 mapping() 內
def test_config_store(tmp_path):                     # set_output_dir 建立資料夾並持久化；空字串 → ValueError
```

- [ ] **Step 2: 執行確認失敗**：`pytest host/tests/test_jobs.py -v`
- [ ] **Step 3: 實作** `config.py`、`jobs.py`。每支影片流程：白名單檢查 → 以 id 去重 → 佔位標題檢查 → 紀錄查詢（檔案存在則跳過）→ `resolve_target` → `build_download_args` → `stream` → 以 `classify_error` 轉成失敗訊息 → 成功才 `Archive.record`。佔位標題比對（不分大小寫）：`[private video]`→`private`、`[deleted video]`→`unavailable`。
- [ ] **Step 4: 執行確認通過**：`pytest host -v`，預期全部通過。
- [ ] **Step 5: Commit**：`git add -A && git commit -m "feat(host): job runner, archive and config"`

### Task 7: host 入口與訊息分派

**Files:** Create `host/host.py`、`host/tests/stub_ytdlp.py`、`host/tests/test_host.py`

**Interfaces:**
- Consumes: Task 1–6 全部介面
- Produces:
  - `locate_engine(home: Path) -> Engine`（`home/bin/` 內的 `yt-dlp`、`ffmpeg`、`deno`，Windows 為 `.exe`；找不到的欄位為 `None`，`ytdlp` 找不到時為 `home/bin/yt-dlp` 的預期路徑）
  - `class Host(home: Path, emit: Callable[[dict], None])`：`handle(msg: dict) -> None`、`shutdown() -> None`
  - `main(argv=None, stdin=None, stdout=None) -> int`：`YTDL_HOME` 環境變數決定 `home`，否則為 `host.py` 的上一層
  - 協定補充（同步寫回規格第 5 節）：每個請求可帶 `reqId`，直接回覆都會帶回；`download` 欄位為 `{ items, quality, titleOverride? }`（不含 `limit`、`outputDir`，上限只用在 `resolve`，輸出資料夾只由 `set_config` 決定）；host 產生 `jobId`（`uuid4().hex`）並回覆 `started { jobId }`；`cancel` 的 `jobId` 可省略（同時間只有一個工作）；回覆型別 `pong`、`started`、`resolved { items[{id,title,url}] }`、`config { outputDir }`、`engine_updated { ytdlpVersion }`、`error { code, message }`；錯誤代碼 `bad_json`、`unknown_type`、`bad_url`、`bad_quality`、`bad_path`、`busy`、`engine_missing`、`update_failed`
  - 啟動後第一則訊息 `ready { hostVersion, ytdlpVersion, ffmpegOk, jsRuntimeOk, outputDir }`

- [ ] **Step 1: 寫失敗的測試**

`stub_ytdlp.py`：可執行的假 yt-dlp。`--version` 印 `2099.01.01`；`-U` 印 `Updated`；含 `--flat-playlist` 時印一行 `{"id":"v1","title":"範例影片"}`；下載時在 `-o` 路徑寫檔並印進度行與完成行（`[ytdl-done]v1|720|avc1.4d401f`）。

```python
def test_ping_echoes_reqid():          # {"type":"ping","reqId":7} → {"type":"pong","reqId":7}
def test_download_replies_started():   # 假引擎下 download → 先收到 started{jobId, reqId}，之後事件的 jobId 相同
def test_unknown_type():               # → error.code == "unknown_type"
def test_bad_quality():                # download，quality 480 → error.code == "bad_quality"
def test_bad_url_on_resolve():         # resolve 非 YouTube 網址 → error.code == "bad_url"
def test_engine_missing():             # home 沒有 bin/yt-dlp 時 download → error.code == "engine_missing"
def test_config_roundtrip(tmp_path):   # set_config 後 get_config 回傳新路徑；空字串 → error.code == "bad_path"
def test_main_sends_ready_then_pong(): # 輸入 ping + EOF → 輸出依序 ready、pong，回傳 0
def test_stray_print_does_not_corrupt_stream():  # 讓某 handler 內 print("noise") → 輸出整串都能被 read_message 解析
def test_eof_cancels_running_job():    # 工作進行中輸入 EOF → JobRunner.cancel 被呼叫、main 回傳 0
def test_bad_json_reports_error():     # 輸入本文為 b"{nope" 的訊息 → error.code == "bad_json" 並繼續處理後續訊息
def test_subprocess_end_to_end(tmp_path):
    # 以 subprocess 啟動 `python host/host.py`，YTDL_HOME=tmp_path（內有 bin/yt-dlp 假引擎）
    # ready.ytdlpVersion == "2099.01.01"；resolve 回傳 items[0].title == "範例影片"
    # download（quality 720）後收到 item_done 與 done.summary.ok == 1，且輸出資料夾內有 "範例影片.mp4"
    # update_engine → engine_updated.ytdlpVersion == "2099.01.01"
```

- [ ] **Step 2: 執行確認失敗**：`pytest host/tests/test_host.py -v`
- [ ] **Step 3: 實作 `host.py`**：`main` 一開始就把 `sys.stdout` 改指向 `sys.stderr`、保留原始二進位 stdout 專供協定；Windows 以 `msvcrt.setmode` 設為二進位；`emit` 以鎖保護（工作執行緒與主迴圈都會寫）；訊息處理例外一律轉成 `error` 而非讓程式結束；`resolve` 遇 `ResolveError` 回 `error`（沿用其 `code`）。`update_engine` 執行 `[ytdlp, "-U"]` 後重新讀版本。
- [ ] **Step 4: 同步規格**：編輯規格第 5 節，補上本任務「協定補充」的內容。
- [ ] **Step 5: 執行確認通過**：`pytest host -v`
- [ ] **Step 6: Commit**：`git add -A && git commit -m "feat(host): host entry point and message dispatch"`

### Task 8: 擴充功能純邏輯

**Files:** Create `extension/lib/constants.js`、`extension/lib/urls.js`、`extension/lib/platform.js`、`extension/lib/events.js`、`extension/tests/lib.test.mjs`

**Interfaces:**
- Produces（皆為 ES module 具名匯出）：
  - `HOST_NAME = "com.ytdl.batch_downloader"`
  - `parseUrlLines(text: string): { urls: string[], invalid: string[] }`（逐行去頭尾空白、略過空行、去重；只接受 http/https 的 youtube.com／youtu.be，其餘進 `invalid`）
  - `installerFor(os: string): { file: string, label: string } | null`（`win` → `installers/install-windows.cmd`；`mac` → `installers/install-mac.zip`；其他 `null`）
  - `classifyConnectError(message: string | undefined): "not_installed" | "forbidden" | "exited" | "other"`（`Specified native messaging host not found.` → `not_installed`；`Access to the specified native messaging host is forbidden.` → `forbidden`；`Native host has exited.` → `exited`）
  - `emptyProgress(): { items: {}, summary: null }`；`applyEvent(state, event): state`（不修改傳入的 state；處理 `progress`、`item_done`、`item_failed`、`done`；`item_done` 帶 `skipped` 時狀態為 `skipped`；非 H.264 的 `codec` 加上 `warnNotH264: true`）

- [ ] **Step 1: 寫失敗的測試** `extension/tests/lib.test.mjs`（`node:test`）

```js
test("parseUrlLines trims, dedupes, separates invalid")  // "  https://youtu.be/a \n\nhttps://youtu.be/a\nhttp://evil.com/x\nhello" → urls 1 筆；invalid ["http://evil.com/x","hello"]
test("installerFor maps platforms")                       // win、mac 對應檔；"linux"、"cros" → null
test("classifyConnectError")                              // 三種訊息與 undefined、其他字串 → other
test("applyEvent progress then done")                     // progress 50 → items.v1.percent 50；item_done → status "done"、file 保留
test("applyEvent failed keeps reason and code")
test("applyEvent skipped and non-h264 warning")           // skipped → status "skipped"；codec "vp09.00.40.08" → warnNotH264 true
test("applyEvent done sets summary and is immutable")     // 原 state 物件未被改動
```

- [ ] **Step 2: 執行確認失敗**：`node --test extension/tests/`，預期 FAIL（模組不存在）。
- [ ] **Step 3: 實作** 上述四個模組。
- [ ] **Step 4: 執行確認通過**：`node --test extension/tests/`，預期全部通過。
- [ ] **Step 5: Commit**：`git add -A && git commit -m "feat(extension): pure logic modules"`

### Task 9: 擴充功能殼層（manifest、background、popup）

**Files:** Create `extension/manifest.json`、`extension/background.js`、`extension/popup.html`、`extension/popup.css`、`extension/popup.js`、`extension/tests/e2e/popup.e2e.mjs`、`tools/gen_extension_key.sh`

**Interfaces:**
- Consumes: Task 8 全部匯出；`HOST_NAME`
- Produces：popup ↔ background 訊息
  - popup → background：`{type:"get_status"}`、`{type:"start"}`、`{type:"resolve", urls, limit}`、`{type:"download", items, quality, titleOverride}`、`{type:"cancel"}`、`{type:"set_output_dir", path}`、`{type:"update_engine"}`
  - background → popup（廣播）：`{type:"status", state: "not_installed"|"stopped"|"running"|"forbidden", ready?}`、`{type:"host_event", event}`
  - background 以 `chrome.runtime.connectNative(HOST_NAME)` 連線，將 host 事件轉發並保存最後的狀態與 `ready`；連線中斷依 `classifyConnectError` 設定狀態。

- [ ] **Step 1: 產生固定識別碼的金鑰**：`tools/gen_extension_key.sh` 用 `openssl` 產生 RSA 2048 私鑰（寫到 repo 以外的暫存路徑，**不提交**），輸出公鑰 DER 的 base64；把它寫入 `manifest.json` 的 `key`。
- [ ] **Step 2: 寫 `manifest.json`**：MV3；`background.service_worker: "background.js"` 且 `type: "module"`；`minimum_chrome_version: "110"`；權限同 Global Constraints；`action.default_popup: "popup.html"`；名稱、說明為繁體中文。
- [ ] **Step 3: 寫 background.js**：連線管理與訊息轉發；`start` 在已連線時直接回報目前狀態；Port 的 `onDisconnect` 讀 `chrome.runtime.lastError.message` 判斷狀態。
- [ ] **Step 4: 寫 popup**：欄位與按鈕如規格第 4 節。「下載部署」用 `chrome.runtime.getPlatformInfo()` → `installerFor` → `chrome.downloads.download({ url: chrome.runtime.getURL(file) })`，`null` 時顯示「目前只支援 Windows 與 Mac」。按「下載」時若尚未解析，先送 `resolve`；解析結果恰好 1 支才啟用並預填檔名欄，否則停用檔名欄。進度用 `applyEvent` 顯示（含非 H.264 警告、略過、失敗原因）。`invalid` 網址要顯示出來，不要靜默丟棄。
- [ ] **Step 5: 寫 e2e `popup.e2e.mjs`**（Playwright，嘗試性）：以 `launchPersistentContext` 載入未封裝擴充功能，開啟 `chrome-extension://<id>/popup.html`，斷言未部署狀態顯示「尚未部署」、貼入含 `http://evil.com/x` 的多行網址後該行顯示為無效。若 sandbox 無法安裝 Playwright 或無頭模式無法載入擴充功能，在輸出中印出 `UNVERIFIED: <原因>` 並以結束碼 2 結束，不得宣稱已驗證。
- [ ] **Step 6: 執行**：`npm i --no-save playwright-core && node extension/tests/e2e/popup.e2e.mjs`，預期印出 `OK` 或明確的 `UNVERIFIED`；另跑 `node --test extension/tests/` 仍全部通過。
- [ ] **Step 7: Commit**：`git add -A && git commit -m "feat(extension): manifest, background worker and popup"`

### Task 10: 建置腳本與單檔安裝檔

**Files:** Create `build.py`、`installers/templates/install-windows.cmd.tpl`、`installers/templates/install-mac.command.tpl`、`tests/test_build.py`；產出 `extension/installers/install-windows.cmd`、`extension/installers/install-mac.zip`

**Interfaces:**
- Consumes: `extension/manifest.json` 的 `key`；`host/*.py`（不含 `tests/`）；`HOST_NAME`
- Produces：
  - `HOST_NAME`、`DEPS`（各依賴的網址常數）、`VERSION`
  - `extension_id(key_b64: str) -> str`（公鑰 DER 的 SHA-256 前 16 bytes，十六進位字元 `0-f` 對應 `a-p`）
  - `host_manifest(path: str, ext_id: str) -> dict`（`name`、`description`、`path`、`type: "stdio"`、`allowed_origins: ["chrome-extension://<id>/"]`）
  - `payload_b64() -> str`（host 程式檔的 zip，base64）
  - `render_windows() -> str`（CRLF）、`render_mac() -> bytes`（zip，內含權限 `0o755` 的 `install-mac.command`，LF）
  - `main() -> None`：寫出兩個安裝檔
- `DEPS`（網址已於 2026-10-04 自沙箱驗證者標註）：yt-dlp `…/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe`、`yt-dlp_macos`、`SHA2-256SUMS`（已驗證）；Deno `…/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip`、`deno-aarch64-apple-darwin.zip`、`deno-x86_64-apple-darwin.zip`（已驗證）；ffmpeg（Windows）`…/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip`（已驗證）；Python embeddable `https://www.python.org/ftp/python/3.12.8/python-3.12.8-embed-amd64.zip`（沙箱連不上，**未驗證**）；Mac ffmpeg 優先用系統既有的 `ffmpeg`，否則 `https://evermeet.cx/ffmpeg/getrelease/zip`（**未驗證**，Intel 版）

**安裝檔行為**
- Windows（PowerShell，以 `.cmd` 自我載入）：解開內嵌 payload 到 `%LOCALAPPDATA%\YTDownloader\host`；下載 Python、yt-dlp（以 `SHA2-256SUMS` 驗證）、Deno、ffmpeg 到 `bin`／`python`；在 `python312._pth` 加入 `..\host` 一行；寫 `host.cmd`（設定 `YTDL_HOME` 並以內嵌 Python 執行 `host.py`）；寫 Native Messaging manifest；以 `HKCU\Software\Google\Chrome\NativeMessagingHosts\<HOST_NAME>` 登錄；`$ProgressPreference = 'SilentlyContinue'`；任何一步失敗都停下並顯示原因與「按任意鍵結束」。
- Mac（bash，`set -e`）：要求 `python3` ≥ 3.9，沒有時印出 `xcode-select --install` 說明並結束；依 `uname -m` 選 Deno；以安裝當下的 `command -v python3` 絕對路徑寫入 `host.sh`；manifest 寫到 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`。
- 兩者可重複執行（覆蓋安裝），結束時印出成功訊息與下一步（回到擴充功能按「啟動」）。

- [ ] **Step 1: 寫失敗的測試** `tests/test_build.py`

```python
def test_extension_id_shape_and_determinism():   # 32 字元、僅含 a-p；同輸入同輸出
def test_extension_id_matches_openssl():         # 用 openssl 對 DER 算 SHA-256，取前 16 bytes 轉換後與 extension_id 相同（無 openssl 則 skip）
def test_host_manifest():                        # allowed_origins == [f"chrome-extension://{id}/"]、type == "stdio"
def test_host_name_consistent():                 # build.HOST_NAME 與 extension/lib/constants.js 內的值相同
def test_installers_have_no_placeholders():      # 輸出中不含 "@@"
def test_windows_installer_is_crlf_and_has_ext_id():
def test_payload_matches_host_sources():         # 從 install-windows.cmd 取出 payload，解壓後與 host/*.py（不含 tests）逐檔位元組相同
def test_mac_zip_has_executable_script():        # zip 內 install-mac.command 的 external_attr 權限為 0o755，且內容為 LF、含相同 payload
def test_committed_installers_are_current():     # 重新渲染的結果與 extension/installers/ 內已提交的檔案相同（避免漂移）
```

- [ ] **Step 2: 執行確認失敗**：`pytest tests/test_build.py -v`
- [ ] **Step 3: 實作 `build.py` 與兩個範本**，範本佔位符 `@@PAYLOAD_B64@@`、`@@EXT_ID@@`、`@@HOST_NAME@@`、`@@VERSION@@` 與各 `@@URL_*@@`。
- [ ] **Step 4: 產生安裝檔**：`python build.py`，確認 `extension/installers/` 內出現兩個檔案。
- [ ] **Step 5: 靜態檢查**：`bash -n` 檢查 Mac 範本；若環境有 `pwsh`，用 `pwsh -NoProfile -Command "[scriptblock]::Create((Get-Content -Raw <PowerShell 區段>))"` 檢查語法，沒有則在輸出註明「PowerShell 未做語法檢查」。
- [ ] **Step 6: 執行確認通過**：`pytest -v`，預期全部通過。
- [ ] **Step 7: Commit**：`git add -A && git commit -m "feat: build script and single-file installers"`

### Task 11: README、規格同步與總驗證

**Files:** Create `README.md`；Modify `docs/superpowers/specs/2026-10-04-youtube-batch-downloader-design.md`

**Interfaces:** Consumes 全部前置任務；無新介面。

- [ ] **Step 1: 寫 `README.md`（繁體中文）**，章節：這是什麼與適用範圍／先決條件（Chrome ≥ 110）／Windows 安裝（載入未封裝擴充功能 → 下載部署 → 雙擊安裝檔 → 啟動）／Mac 安裝（解壓 zip → 右鍵開啟以通過 Gatekeeper → 需要 `python3`）／使用方式／冒煙測試（下載一支公開短片 720p、一個小播放清單 1080p，確認檔名為標題與畫質）／疑難排解（尚未部署、forbidden、引擎過舊→「更新引擎」、被要求登入或驗證→改用住宅或公司網路、`yt-dlp.exe` 需要 VC++ 執行階段、防毒攔截、Windows SmartScreen、公司 IT 管控）／版權與條款提醒（需頻道管理部門同意；音樂與外部素材授權可能僅限 YouTube）／「這份工具在開發環境未驗證真實下載與安裝流程」的誠實說明。
- [ ] **Step 2: 同步規格**：第 7 節 Mac 安裝檔改為 `install-mac.zip`（Chrome 下載會遺失執行權限，zip 內保留）；Mac 取得 Python 改為「要求系統 `python3` ≥ 3.9」；第 6 節併發改為「一次一支，支與支間隔 2 秒」；第 10 節 JS 執行環境改為「已查證：需要 Deno，獨立執行檔已內含 yt-dlp-ejs」；第 8 節補上 `security.py`、`config.py`；第 5 節 `download` 去掉 `outputDir?`、`limit?`。
- [ ] **Step 3: 總驗證**：`pytest -v && node --test extension/tests/`，預期全部通過；`git status` 確認沒有未提交的產物或金鑰檔。
- [ ] **Step 4: Commit 與推送**：`git add -A && git commit -m "docs: README and spec sync"`，然後 `git push -u origin claude/youtube-video-downloader-4gvj18`。
