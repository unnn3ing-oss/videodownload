# 一鍵更新 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 側邊面板能檢查 GitHub `release` 分支上的新版本，並一鍵更新擴充功能與本機小程式，失敗時不留下半套檔案。

**Architecture:** 照圖片套版產生器的做法：擴充功能呼叫 GitHub API 取得最新 commit 的檔案清單，與自己目前的檔案比對 git blob SHA；有差異的檔案從 `raw.githubusercontent.com`（固定在該 commit）下載並驗證後，用 File System Access API 寫回使用者選過一次的資料夾，再 `chrome.runtime.reload()`。小程式的 Python 檔案由小程式自己更新（擴充功能傳檔案清單給它，它下載、驗證、自我檢查、備份後替換），兩邊一起完成，任一邊失敗就還原。

**Tech Stack:** Python 3 標準函式庫（host）、JavaScript ES modules（`node --test`、Playwright e2e）、Chrome Manifest V3（alarms、storage、File System Access）。

**Spec:** `docs/superpowers/specs/2026-10-05-self-update-design.md`

## Global Constraints

- 追蹤：`OWNER = unnn3ing-oss`、`REPO = videodownload`、`BRANCH = release`；JS（`extension/lib/update-config.js`）與 Python（`host/update_config.py`）各一份，測試確保一致。程式碼寫死，不接受訊息或設定覆蓋。
- 擴充功能檔案：repo 的 `extension/` 之下，去掉前綴；排除 `extension/tests/`；包含 `extension/installers/`。小程式檔案：repo 的 `host/` 最上層、檔名符合 `^[A-Za-z0-9_]+\.py$`；排除 `host/tests/`。
- 相等判斷用 git blob SHA（`sha1("blob <位元組數>\0" + 內容)`）；文字檔（`js html css json md svg txt`、小程式的 `.py`）只在**本地比對**時另做 CRLF→LF 正規化再比一次；下載內容必須與清單 SHA 完全相同。
- 只有擴充功能呼叫 GitHub API（每次檢查 2 次：commit、檔案樹）；小程式只從 `https://raw.githubusercontent.com/<OWNER>/<REPO>/<commit>/host/<name>` 下載，僅限 HTTPS、使用系統憑證、永不關閉憑證驗證。
- 檢查頻率：`chrome.alarms` 每 6 小時（360 分鐘）、面板開啟時距上次檢查超過 6 小時、手動按鈕不受限。
- 上限：每次最多 50 個檔案、每個檔案最多 2 MiB（擴充功能與小程式皆同）。
- 寫入順序：`manifest.json` 最後寫；新的 `manifest.json` 的 `key` 必須與目前相同。
- 有下載工作進行中時，小程式拒絕 `update_stage`、`update_commit`（錯誤代碼 `busy`）。
- 備份只保留上一版：`<安裝目錄>/backup/host/`；staging：`<安裝目錄>/update/staging/`。
- 來自 GitHub 的文字（commit 訊息、日期）一律以 `textContent` 顯示。
- 新權限：`alarms`；`host_permissions` 新增 `https://api.github.com/*`、`https://raw.githubusercontent.com/*`。
- 所有給使用者看的文字使用繁體中文（台灣用語）。
- 規格寫「`ready` 新增 `version`」，但 `ready.hostVersion` 已存在且就是小程式版本，**沿用 `hostVersion`、不新增重複欄位**（Task 1 的 ruling，完成後同步修正規格）。
- 修改 `host/*.py` 的任務，提交前都要執行 `python build.py` 並一併提交 `extension/installers/`（既有測試 `test_committed_installers_are_current` 會檢查）。

## Review Focus

1. **危險路徑**：檔案清單含 `..`、絕對路徑、反斜線、`.git`、子資料夾的 `.py`、過大或過多的檔案。預期：整個更新中止，什麼都不寫。→ Task 2、6
2. **只有換行不同**：本機是 CRLF、GitHub 是 LF。預期：不算有新版，不出現假的「有新版本」。→ Task 2、6
3. **GitHub 查不到**：斷網、API 次數用完（403／429）、`release` 分支不存在（404）、檔案樹被截斷。預期：顯示明確的繁體中文原因，不崩潰，不卡住徽章。→ Task 7
4. **更新中途失敗**：第二個檔案雜湊不符、小程式換入失敗、小程式已換入但擴充功能寫入失敗。預期：沒有半套檔案；小程式已還原；再按一次更新會收斂。→ Task 3、4、7
5. **不該更新的時候**：有下載工作進行中、選到不是這個擴充功能的資料夾、小程式未啟動。預期：拒絕並說明原因，不改動任何檔案。→ Task 5、7、9

---

## 檔案結構

| 檔案 | 職責 |
|---|---|
| `host/version.py`、`host/update_config.py` | 小程式版本、追蹤設定 |
| `host/selfupdate.py` | 小程式更新：驗證清單、比對、下載、自我檢查、替換、還原 |
| `host/host.py`（修改） | 四個更新訊息的處理與忙碌檢查 |
| `extension/lib/update-config.js` | 追蹤設定（JS 端） |
| `extension/lib/gitsha.js`、`update-rules.js` | blob SHA、路徑安全、檔案樹對應 |
| `extension/lib/updater.js` | 檢查、下載驗證、寫入、整個更新流程（可注入相依，node 可測） |
| `extension/lib/folder-store.js` | 資料夾授權與記憶（瀏覽器專用，以 e2e 驗證） |
| `extension/lib/update-state.js` | 檢查結果摘要、儲存、徽章 |
| `extension/background.js`（修改） | 定時檢查與圖示徽章 |
| `extension/sidepanel.*`（修改） | 「版本與更新」區與標題徽章 |

---

### Task 1: 版本與追蹤設定

**Files:**
- Create: `host/version.py`、`host/update_config.py`、`extension/lib/update-config.js`、`tests/test_update_config.py`
- Modify: `host/host.py`（刪除 `HOST_VERSION = "0.1.0"`，改為 `from version import VERSION`，`ready_message` 的 `hostVersion` 用它）

**Interfaces:**
- Produces: `version.VERSION: str = "0.1.0"`；`update_config.OWNER / REPO / BRANCH: str`；JS `UPDATE_REPO = { owner, repo, branch }`

- [ ] **Step 1: 寫失敗的測試** `tests/test_update_config.py`

```python
def test_extension_and_host_versions_match():
    # extension/manifest.json 的 version == version.VERSION
def test_tracking_config_matches_between_js_and_python():
    # 以正規表達式讀 extension/lib/update-config.js 的 owner/repo/branch，與 update_config 的 OWNER/REPO/BRANCH 相同，且 BRANCH == "release"
def test_ready_reports_host_version(tmp_path):
    # host.Host(tmp_path, lambda m: None).ready_message()["hostVersion"] == version.VERSION
```

- [ ] **Step 2: 執行確認失敗**：`python -m pytest tests/test_update_config.py -q`，預期 FAIL（模組不存在）。
- [ ] **Step 3: 實作** 上述三個新檔與 `host.py` 的修改。
- [ ] **Step 4: 執行確認通過**：`python build.py && python -m pytest -q`，預期全部通過。
- [ ] **Step 5: Commit**：`git add -A && git commit -m "feat: version and update tracking config"`

### Task 2: 小程式更新（一）：清單驗證與比對

**Files:** Create `host/selfupdate.py`、`host/tests/test_selfupdate_files.py`

**Interfaces:**
- Consumes: `update_config.OWNER / REPO`
- Produces（`selfupdate.py`）：
  - `MAX_FILES = 50`、`MAX_FILE_BYTES = 2 * 1024 * 1024`
  - `class UpdateError(Exception)`：屬性 `code: str`、`message: str`、`rolled_back: bool`；建構 `UpdateError(code, message, rolled_back=False)`
  - `git_blob_sha(data: bytes) -> str`
  - `validate_files(files: object) -> list[dict]`（回傳 `{"path", "sha", "size"}` 的新 list；不合規一律 `UpdateError("update_bad_file", ...)`）
  - `changed_files(host_dir: Path, files: list[dict]) -> list[str]`（回傳有差異或不存在的檔名，維持輸入順序）
  - `http_get(url: str, timeout: float = 30.0) -> bytes`（非 `https://` 或超過 `MAX_FILE_BYTES` → `UpdateError("update_download_failed", ...)`）

- [ ] **Step 1: 寫失敗的測試**

```python
def test_git_blob_sha_known_vectors():
    assert git_blob_sha(b"hello\n") == "ce013625030ba8dba906f756967f9e9ca394464a"
    assert git_blob_sha(b"") == "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
def test_validate_files_accepts_normal_entries():     # [{"path":"host.py","sha":<40 hex>,"size":10}] 原樣回傳（新物件）
@pytest.mark.parametrize("bad", [...])
def test_validate_files_rejects_bad_entries(bad):     # 皆 UpdateError，code == "update_bad_file"
    # 非 list；元素不是 dict；缺欄位；path 為 "../x.py"、"/etc/x.py"、"a/b.py"、"a\\b.py"、".py"、"x.txt"、"é.py"、"x.py "；
    # sha 不是 40 位小寫十六進位；size 為負數、超過 MAX_FILE_BYTES、True、"5"；path 重複；超過 50 個
def test_changed_files_reports_missing_and_different(tmp_path):   # 缺檔、內容不同 → 列出；相同 → 不列
def test_changed_files_ignores_crlf_only_difference(tmp_path):    # 本機 CRLF、清單 SHA 為 LF 版本 → 不列
def test_http_get_rejects_non_https():                # "http://x" → UpdateError("update_download_failed")
def test_http_get_enforces_size_cap(monkeypatch):     # 以假的 urlopen 回傳超過上限的內容 → UpdateError("update_download_failed")
```

- [ ] **Step 2: 執行確認失敗**：`python -m pytest host/tests/test_selfupdate_files.py -q`
- [ ] **Step 3: 實作** 上述介面。`http_get` 用 `urllib.request.urlopen`（預設憑證驗證），先讀 `MAX_FILE_BYTES + 1` 位元組判斷是否超限。
- [ ] **Step 4: 執行確認通過**：`python build.py && python -m pytest -q`
- [ ] **Step 5: Commit**：`git add -A && git commit -m "feat(host): self-update file validation and diff"`

### Task 3: 小程式更新（二）：下載到 staging 與自我檢查

**Files:** Modify `host/selfupdate.py`；Test `host/tests/test_selfupdate_stage.py`

**Interfaces:**
- Consumes: Task 2 的 `UpdateError`、`validate_files`、`git_blob_sha`、`http_get`
- Produces：
  - `RAW_BASE: str`（`https://raw.githubusercontent.com/<OWNER>/<REPO>`）
  - `stage(home: Path, commit: str, files: list[dict], fetch: Callable[[str], bytes] | None = None) -> int`（`fetch` 預設在呼叫時才取用模組內的 `http_get`，讓測試能用 monkeypatch 取代；回傳檔案數）
  - `self_check(home: Path, python: str = sys.executable) -> None`
  - 目錄慣例：`host_dir = home/"host"`、`staging = home/"update"/"staging"`（內含各檔案與 `_files.json`，列出檔名）

- [ ] **Step 1: 寫失敗的測試**（測試輔助函式 `make_home(tmp_path)`：把真實的 `host/*.py` 複製到 `home/host/`）

```python
def test_stage_downloads_verifies_and_writes(tmp_path):    # fetch 收到的網址 == f"{RAW_BASE}/{commit}/host/version.py"；staging/version.py 內容正確；回傳 1
def test_stage_rejects_hash_mismatch_and_leaves_no_staging(tmp_path):   # UpdateError("update_hash_mismatch")；staging 目錄不存在
def test_stage_reports_download_failure(tmp_path):         # fetch 丟 OSError → "update_download_failed"
@pytest.mark.parametrize("commit", ["main", "abc", "A" * 40, "g" * 40])
def test_stage_rejects_bad_commit(tmp_path, commit):       # "update_bad_file"
def test_stage_with_nothing_to_stage(tmp_path):            # files == [] → "update_nothing_staged"
def test_stage_clears_previous_staging(tmp_path):          # 舊 staging 內的殘留檔案不會留下
def test_self_check_rejects_broken_overlay(tmp_path):      # staged 的 host.py 語法錯誤 → "update_selfcheck_failed"；staging 被清除；home/host 內容不變
def test_self_check_accepts_consistent_overlay(tmp_path):  # staged 的 version.py 改成 VERSION = "9.9.9" → 通過
```

- [ ] **Step 2: 執行確認失敗**：`python -m pytest host/tests/test_selfupdate_stage.py -q`
- [ ] **Step 3: 實作** `stage` 與 `self_check`。`stage`：驗證 commit（`^[0-9a-f]{40}$`）與清單 → 清空 staging → 逐檔下載、驗 SHA 與大小 → 寫檔與 `_files.json` → 呼叫 `self_check`；任何失敗都清除 staging 後再丟 `UpdateError`。`self_check`：把 `home/host/*.py` 複製到 `home/update/check/`，以 staging 的檔案覆蓋，用子行程執行 `python -c "import sys; sys.path.insert(0, sys.argv[1]); import host" <check 目錄>`（逾時 30 秒），結束後清除 check 目錄；失敗回報 stderr 末段。
- [ ] **Step 4: 執行確認通過**：`python build.py && python -m pytest -q`
- [ ] **Step 5: Commit**：`git add -A && git commit -m "feat(host): stage and self-check updates"`

### Task 4: 小程式更新（三）：替換、備份與還原

**Files:** Modify `host/selfupdate.py`；Test `host/tests/test_selfupdate_commit.py`

**Interfaces:**
- Consumes: Task 3 的 staging 慣例與 `UpdateError`
- Produces：`commit_update(home: Path) -> int`、`rollback_update(home: Path) -> int`；備份目錄 `home/backup/host/` 含 `_backup.json`（`{"replaced": [...], "added": [...]}`）

- [ ] **Step 1: 寫失敗的測試**

```python
def test_commit_replaces_files_and_keeps_backup(tmp_path):   # host 內檔案換成新內容；backup/host/ 有舊內容；staging 消失；回傳檔案數；新增的檔案記在 added
def test_commit_without_staging_raises_nothing_staged(tmp_path):    # "update_nothing_staged"
def test_commit_failure_midway_restores_everything(tmp_path, monkeypatch):
    # 讓第二次 os.replace 丟 OSError → UpdateError("update_install_failed")，rolled_back is True；所有檔案內容與更新前相同；新增的檔案被移除
def test_rollback_restores_previous_version_and_removes_added_files(tmp_path)
def test_rollback_without_backup_raises(tmp_path):           # "update_nothing_staged"
def test_only_one_previous_version_is_kept(tmp_path):        # 連續兩次 stage+commit 後，backup 內是第二次更新前的狀態
```

- [ ] **Step 2: 執行確認失敗**：`python -m pytest host/tests/test_selfupdate_commit.py -q`
- [ ] **Step 3: 實作** `commit_update`：讀 `_files.json`；清空備份目錄；對每個檔名，目的檔存在則先 `copy2` 到備份並記入 `replaced`，否則記入 `added`；寫 `_backup.json`；逐檔 `os.replace(staging/name, host_dir/name)`；任何例外就呼叫內部還原（`rollback_update` 共用）後丟 `UpdateError("update_install_failed", ..., rolled_back=True)`；成功後清除 staging。`rollback_update`：讀 `_backup.json`，把 `replaced` 從備份複製回去，刪除 `added`（只刪通過檔名白名單的），回傳還原的檔案數。
- [ ] **Step 4: 執行確認通過**：`python build.py && python -m pytest -q`
- [ ] **Step 5: Commit**：`git add -A && git commit -m "feat(host): commit and roll back updates"`

### Task 5: 小程式的更新訊息

**Files:** Modify `host/host.py`；Test `host/tests/test_host_update.py`

**Interfaces:**
- Consumes: `selfupdate.{validate_files, changed_files, stage, commit_update, rollback_update, UpdateError}`
- Produces（Native Messaging 訊息）：
  - 收：`update_check { files }`、`update_stage { commit, files }`、`update_commit {}`、`update_rollback {}`（皆可帶 `reqId`）
  - 回：`update_status { changed: [name], total: int }`、`update_staged { count }`、`update_applied { count }`、`update_rolled_back {}`；錯誤為 `error { code, message, rolledBack? }`，`code` 即 `UpdateError.code`
  - `HANDLED` 加入四個訊息名；`update_stage` 在背景執行緒中執行（`Host.wait()` 會等它）

- [ ] **Step 1: 寫失敗的測試**（沿用 `host/tests/test_host.py` 的 `make_home`、`new_host` 風格，home 內放 `home/host/*.py` 副本）

```python
def test_update_check_reports_changed_names(tmp_path):     # 回 update_status，changed 只含有差異的檔名，total == len(files)，reqId 原樣帶回
def test_update_check_rejects_bad_files(tmp_path):         # files 含 "../x.py" → error.code == "update_bad_file"
def test_update_stage_commit_flow(tmp_path, monkeypatch):  # monkeypatch selfupdate.http_get；stage → update_staged{count:1}；commit → update_applied{count:1}；home/host/version.py 已更新
def test_update_stage_failure_keeps_host_files(tmp_path, monkeypatch):   # 雜湊不符 → error.code == "update_hash_mismatch"；host 檔案不變
def test_update_refused_while_job_running(tmp_path):       # host.runner.running = True 時，update_stage 與 update_commit 都回 error.code == "busy"
def test_update_rollback_flow(tmp_path, monkeypatch):      # commit 後 rollback → update_rolled_back；檔案回到舊內容
def test_update_install_failure_reports_rolled_back(tmp_path, monkeypatch):   # monkeypatch os.replace 失敗 → error.code == "update_install_failed" 且 rolledBack is True
```

- [ ] **Step 2: 執行確認失敗**：`python -m pytest host/tests/test_host_update.py -q`
- [ ] **Step 3: 實作** `_on_update_check`、`_on_update_stage`、`_on_update_commit`、`_on_update_rollback` 與 `UpdateError` → `error` 訊息的轉換；`update_stage`、`update_commit` 先檢查 `self.runner.running`。
- [ ] **Step 4: 執行確認通過**：`python build.py && python -m pytest -q`
- [ ] **Step 5: Commit**：`git add -A && git commit -m "feat(host): self-update messages"`

### Task 6: 擴充功能的比對規則

**Files:** Create `extension/lib/gitsha.js`、`extension/lib/update-rules.js`；Test `extension/tests/update-rules.test.mjs`

**Interfaces:**
- Produces：
  - `gitBlobSha(bytes: Uint8Array): Promise<string>`
  - `sameContent(path: string, localBytes: Uint8Array | null, remoteSha: string): Promise<boolean>`（`null` → `false`；文字副檔名另以 CRLF→LF 正規化再比一次；二進位檔不正規化）
  - `isSafeRelativePath(path: string): boolean`
  - `mapTree(tree: Array<{ path: string, type: string, sha: string, size?: number }>): { extension: Array<{ path, repoPath, sha, size }>, host: Array<{ path, sha, size }> }`（遇到不安全路徑、超過 `MAX_FILE_BYTES`、超過 `MAX_FILES` 就丟 `Error`，訊息為繁體中文）
  - `MAX_FILES = 50`、`MAX_FILE_BYTES = 2 * 1024 * 1024`

- [ ] **Step 1: 寫失敗的測試** `update-rules.test.mjs`

```js
test("gitBlobSha matches git hash-object vectors")           // "hello\n" → ce013625…；空內容 → e69de29b…
test("sameContent ignores CRLF-only differences for text files but not binary")
test("isSafeRelativePath rejects traversal, absolute, backslash, drive letters and .git")
test("mapTree maps extension and host files and applies exclusions")
  // extension/tests/x.js 被排除；extension/installers/a.zip 保留且 path 為 "installers/a.zip"；host/host.py 進 host；host/tests/t.py、README.md 被忽略；type "tree" 被忽略
test("mapTree rejects unsafe paths, oversized files and too many files")
```

- [ ] **Step 2: 執行確認失敗**：`node --test extension/tests/update-rules.test.mjs`，預期 FAIL（模組不存在）。
- [ ] **Step 3: 實作** 兩個模組（`crypto.subtle.digest("SHA-1")`；文字副檔名 `/\.(js|html|css|json|md|svg|txt|py)$/i`）。
- [ ] **Step 4: 執行確認通過**：`node --test extension/tests/*.test.mjs`
- [ ] **Step 5: Commit**：`git add -A && git commit -m "feat(extension): update comparison rules"`

### Task 7: 擴充功能的更新流程

**Files:** Create `extension/lib/updater.js`、`extension/lib/folder-store.js`、`extension/lib/update-state.js`；Test `extension/tests/updater.test.mjs`

**Interfaces:**
- Consumes: Task 6 的 `gitBlobSha`、`sameContent`、`mapTree`；`UPDATE_REPO`
- Produces（`updater.js`）：
  - `class UpdateError extends Error`（訊息為給使用者看的繁體中文）
  - `checkLatest({ fetchFn = fetch, readLocal = readBundled, repo = UPDATE_REPO } = {}): Promise<{ sha, date, message, extChanged: Entry[], hostFiles: HostEntry[], hasUpdate: boolean }>`（`hasUpdate` 只看擴充功能差異；`readLocal(path) → Promise<Uint8Array | null>`，預設讀 `chrome.runtime.getURL(path)`）
  - `shouldCheck(checkedAt: number | undefined, now: number, intervalMs = 21_600_000): boolean`
  - `downloadAll(entries, { sha, fetchFn, repo, onProgress }): Promise<Array<{ path, bytes }>>`（網址 `https://raw.githubusercontent.com/<owner>/<repo>/<sha>/extension/<逐段 encodeURIComponent 的 path>`；任何一個 SHA 不符就丟 `UpdateError`，不回傳部分結果）
  - `assertSameKey(downloads, currentKey): void`
  - `verifyFolder(dir, expectedName): Promise<void>`
  - `writeFiles(dir, downloads): Promise<void>`（`manifest.json` 最後寫；自動建立子資料夾）
  - `runUpdate({ info, hostChanged, getFolder, pickFolder, fetchFn, hostApi, reload, currentKey, expectedName, onProgress }): Promise<void>`；`hostApi = { stage(commit, files), commit(), rollback() }`（皆回傳 Promise）；`hostChanged` 為要更新的小程式檔案項目（`{ path, sha, size }[]`）
- Produces（`update-state.js`）：`summarizeCheck(info, now): { checkedAt, sha, date, message, hasUpdate, extChangedCount }`；`saveSummary(summary)`、`loadSummary()`（`chrome.storage.local`，鍵 `updateInfo`）；`applyBadge(hasUpdate)`（`chrome.action.setBadgeText`：有更新顯示「新」，否則空字串）
- Produces（`folder-store.js`，瀏覽器專用）：`hasSavedFolder(): Promise<boolean>`、`getFolder(expectedName): Promise<FileSystemDirectoryHandle | null>`、`pickFolder(expectedName): Promise<FileSystemDirectoryHandle>`（IndexedDB 資料庫 `ytdl-updater`；`showDirectoryPicker({ id: "ytdl-extension", mode: "readwrite" })`；權限過期時 `requestPermission`；`verifyFolder` 通過才儲存或回傳）

- [ ] **Step 1: 寫失敗的測試** `updater.test.mjs`（假的 `fetchFn`：以網址對應回應物件 `{ ok, status, json(), arrayBuffer() }`；假資料夾 `FakeDir` 記錄寫入順序）

```js
test("checkLatest lists only changed extension files and returns the host files")
test("checkLatest maps GitHub failures to friendly messages")   // 斷網、403、429、404（尚未發佈）、檔案樹 truncated
test("checkLatest does not report CRLF-only differences")
test("shouldCheck honours the 6 hour interval")
test("downloadAll fetches from the pinned commit url")
test("downloadAll verifies every file and returns nothing when one is tampered")
test("assertSameKey rejects a changed manifest key")
test("verifyFolder requires a manifest.json with the extension's name")   // 缺檔、名稱不同皆丟 UpdateError
test("writeFiles writes manifest.json last and creates directories")
test("runUpdate asks for the folder first, then downloads, stages and commits the host, writes, reloads")   // 呼叫順序陣列
test("runUpdate stops before touching anything when a download fails")   // 沒有 hostStage、沒有 write、沒有 reload
test("runUpdate rolls the host back and does not reload when writing fails")
test("runUpdate skips the folder when only host files changed")
test("summarizeCheck keeps what the badge and panel need")
```

- [ ] **Step 2: 執行確認失敗**：`node --test extension/tests/updater.test.mjs`
- [ ] **Step 3: 實作** 三個模組。錯誤訊息固定為：斷網「連不上 GitHub，請確認網路連線」；403／429「GitHub 暫時限制查詢次數，請稍後再試」；commit 404「尚未發佈：找不到 release 分支」；其他非 2xx「連不上 GitHub（HTTP n）」；truncated「檔案太多，GitHub 沒有回傳完整清單」；SHA 不符「<path> 下載內容和 GitHub 上的不一致，已取消更新」；資料夾不符「這個資料夾不是「YouTube 批量下載器」擴充功能的資料夾」。`runUpdate` 的順序：（有擴充功能差異才）`getFolder() ?? pickFolder()` → `downloadAll` → `assertSameKey` → 小程式 `stage` → `commit` → `writeFiles`（失敗則 `hostApi.rollback()` 後重丟）→ `reload()`。
- [ ] **Step 4: 執行確認通過**：`node --test extension/tests/*.test.mjs`
- [ ] **Step 5: Commit**：`git add -A && git commit -m "feat(extension): update check, download, apply and folder store"`

### Task 8: 權限、定時檢查與圖示徽章

**Files:** Modify `extension/manifest.json`、`extension/background.js`；Test `extension/tests/manifest.test.mjs`

**Interfaces:**
- Consumes: `checkLatest`、`shouldCheck`（`updater.js`）；`summarizeCheck`、`saveSummary`、`applyBadge`（`update-state.js`）
- Produces：背景每 360 分鐘的 alarm `check-update`；檢查結果存入 `updateInfo`，並更新圖示徽章；檢查失敗時只存 `{ checkedAt, error }`，不改徽章

- [ ] **Step 1: 寫失敗的測試** `manifest.test.mjs`

```js
test("manifest declares the permissions the updater needs")   // permissions 含 alarms、sidePanel、storage；host_permissions 含 https://api.github.com/*、https://raw.githubusercontent.com/*；key 仍存在
```

- [ ] **Step 2: 執行確認失敗**：`node --test extension/tests/manifest.test.mjs`
- [ ] **Step 3: 實作** manifest 修改，與 `background.js`：啟動時若 `chrome.alarms.get("check-update")` 不存在就 `create({ delayInMinutes: 1, periodInMinutes: 360 })`；`onAlarm` 時執行檢查、`saveSummary`、`applyBadge`（成功時）。
- [ ] **Step 4: 執行確認通過**：`node --test extension/tests/*.test.mjs && node extension/tests/e2e/sidepanel.e2e.mjs`（既有 e2e 仍須通過，輸出 `OK`）
- [ ] **Step 5: Commit**：`git add -A && git commit -m "feat(extension): periodic update check and badge"`

### Task 9: 面板的「版本與更新」與端對端測試

**Files:**
- Create: `extension/tests/e2e/helpers.mjs`、`extension/tests/e2e/fake-github.mjs`、`extension/tests/e2e/host_with_fake_github.py`、`extension/tests/e2e/update.e2e.mjs`
- Modify: `extension/sidepanel.html`、`sidepanel.css`、`sidepanel.js`、`extension/tests/e2e/sidepanel.e2e.mjs`（改用 `helpers.mjs`）、`host/tests/stub_ytdlp.py`（新增環境變數 `YTDL_STUB_DELAY`：設定時，下載前先 `time.sleep(該秒數)`，讓測試能在下載進行中檢查）

**Interfaces:**
- Consumes: Task 5 的訊息、Task 7 的 `checkLatest`、`runUpdate`、`shouldCheck`、`summarizeCheck`、`saveSummary`、`loadSummary`、`applyBadge`、`hasSavedFolder`、`getFolder`、`pickFolder`
- Produces（面板元素 id）：`#update-badge`（標題旁，預設 `hidden`）、`#ver-current`、`#ver-latest`、`#update-note`、`#update-check`、`#update-apply`、`#update-progress`（皆在 `#settings` 之內）
- Produces（測試輔助）：`helpers.mjs` 匯出 `extensionId(keyB64)`、`launchExtension({ viewport })`、`registerNativeHost({ userData, wrapperPath, extId })`；`fake-github.mjs` 匯出 `buildFixture({ repoRoot, overrides })`（回傳檔案樹項目與 `routes(context, { tamper })`）；`host_with_fake_github.py` 把 `selfupdate.http_get` 換成從 `FAKE_GITHUB_DIR/<commit>/host/<name>` 讀檔，再執行 `host.main()`（只給測試用，不屬於正式程式）

- [ ] **Step 1: 寫失敗的端對端測試** `update.e2e.mjs`（沿用 `sidepanel.e2e.mjs` 的結束碼慣例：0 成功、1 失敗、2 無法啟動瀏覽器）
  - 準備：臨時 `home/` 內複製 `host/*.py` 到 `home/host/`、放假 yt-dlp（`host/tests/stub_ytdlp.py`）；原生主機包裝腳本改執行 `host_with_fake_github.py`。假 GitHub 的最新 commit 把 `extension/manifest.json` 的 version 改為 `9.9.9`（`key` 不變）、在 `extension/sidepanel.css` 末尾加註解 `/* e2e */`、把 `host/version.py` 改為 `VERSION = "9.9.9"`，其餘檔案與目前相同；檔案樹另含 `extension/tests/x.js`、`host/tests/t.py` 驗證排除規則。面板頁以 `page.addInitScript` 取代 `showDirectoryPicker`（回傳已寫入同名 `manifest.json` 的 OPFS 根目錄）並把 `chrome.runtime.reload` 換成設定 `window.__reloaded = true`；GitHub 請求以 `context.route` 攔截。
  - 斷言（依序）：
    1. 未啟動時按「檢查更新」→ `#update-badge` 顯示、`#ver-latest` 含假 commit 訊息、`chrome.action.getBadgeText` 為「新」；`#update-apply` 停用且 `#update-progress` 提示先啟動。
    2. 啟動後（`#status` 為 running）重新檢查 → `#update-apply` 啟用。
    3. 竄改 `extension/sidepanel.css` 的回應後按更新 → `#update-progress` 含「不一致」；OPFS 的 `manifest.json` 版本不變；`home/host/version.py` 不變；`window.__reloaded` 為假。
    4. 取消竄改後按更新 → `window.__reloaded` 為真；OPFS 的 `manifest.json` 版本為 `9.9.9` 且最後寫入；`sidepanel.css` 含 `/* e2e */`；`home/host/version.py` 含 `9.9.9`、`home/backup/host/version.py` 含舊版本。
    5. 下載進行中時（`status.busy`）`#update-apply` 停用並說明原因：包裝腳本設 `YTDL_STUB_DELAY=3`，以 `#download` 啟動一個下載，在 `done` 之前檢查；下載結束後按鈕恢復。
- [ ] **Step 2: 執行確認失敗**：`node extension/tests/e2e/update.e2e.mjs`，預期輸出 `FAIL`（找不到面板元素）。
- [ ] **Step 3: 實作** `helpers.mjs`、`fake-github.mjs`、`host_with_fake_github.py`，並讓 `sidepanel.e2e.mjs` 改用 `helpers.mjs`；執行 `node extension/tests/e2e/sidepanel.e2e.mjs`，預期仍為 `OK`。
- [ ] **Step 4: 實作面板**：HTML／CSS 沿用現有樣式語彙（卡片、`.btn`、`.pill`）；`sidepanel.js` 新增：
  - 初始化時 `loadSummary()` 顯示上次結果；已啟動且 `shouldCheck(...)` 為真時自動檢查；手動檢查不受限。
  - `runCheck()`：`checkLatest()` → `saveSummary(summarizeCheck(...))` → `applyBadge`；已啟動時再送 `update_check { files: info.hostFiles }`，把回傳的 `changed` 對應成 `hostChanged`；`hasUpdate` = 擴充功能有差異 或 `hostChanged` 非空。
  - `#update-apply` 的停用條件與說明：未啟動（「請先按『啟動』才能更新本機小程式」）、`status.busy`（「下載進行中，完成後再更新」）、沒有更新。按鈕文字：擴充功能有差異且 `!(await hasSavedFolder())` 時為「選擇擴充功能資料夾並更新」，否則「更新到最新版」。
  - 按下後直接呼叫 `runUpdate`（不要在它之前做任何耗時的 await，以保留使用者操作時效）；`hostApi` 以既有的 `request()` 包 `update_stage`／`update_commit`／`update_rollback`；`reload = () => chrome.runtime.reload()`；`expectedName` 與 `currentKey` 取自 `chrome.runtime.getManifest()`；進度文字寫入 `#update-progress`，錯誤同時以 `note(msg, "error")` 顯示；全部以 `textContent`。
  - `#update-badge` 點擊：展開 `#settings` 並捲到更新區。
- [ ] **Step 5: 執行確認通過**：`node extension/tests/e2e/update.e2e.mjs`（輸出 `OK`）、`node extension/tests/e2e/sidepanel.e2e.mjs`（`OK`）、`node --test extension/tests/*.test.mjs`、`python -m pytest -q`；以 `E2E_SHOTS` 截圖檢查新區塊在 320 與 480 寬度、淺色與深色下沒有溢出。
- [ ] **Step 6: Commit**：`git add -A && git commit -m "feat(extension): update section in the side panel"`

### Task 10: README、規格同步與總驗證

**Files:** Modify `README.md`、`docs/superpowers/specs/2026-10-05-self-update-design.md`

**Interfaces:** Consumes 全部前置任務；無新介面。

- [ ] **Step 1: 更新 `README.md`（繁體中文）**：
  - 「初次安裝」改為從 `https://github.com/unnn3ing-oss/videodownload/archive/refs/heads/release.zip` 下載、解壓縮、載入 `extension` 資料夾；
  - 新增「更新」：面板「設定與工具」→「版本與更新」、第一次要選擇擴充功能資料夾（不要選磁碟根目錄或「下載」「文件」資料夾本身，Chrome 會拒絕）、更新後自動重新載入、再按「啟動」；
  - 新增「維護者：發版」：`python -m pytest`、`python build.py`、更新 `manifest.json` 與 `host/version.py` 的版本、`git push origin <commit>:release`；建議對 `release` 分支開啟分支保護、對 GitHub 帳號啟用雙重驗證；
  - 疑難排解新增：更新後小程式啟動失敗時，把 `<安裝目錄>/backup/host/` 的檔案複製回 `<安裝目錄>/host/` 或重新執行安裝檔；API 次數用完請稍後再試。
- [ ] **Step 2: 同步規格**：第 5 節把「`ready` 新增 `version`」改為「沿用 `ready.hostVersion`」。
- [ ] **Step 3: 總驗證**：`python build.py && python -m pytest -q && node --test extension/tests/*.test.mjs && node extension/tests/e2e/sidepanel.e2e.mjs && node extension/tests/e2e/update.e2e.mjs`，全部通過；`git status` 確認沒有未提交的產物（含 `extension/installers/`）。
- [ ] **Step 4: Commit 與推送**：`git add -A && git commit -m "docs: README and spec sync for self-update"`，然後 `git push -u origin claude/youtube-video-downloader-4gvj18`。**不要建立或推送遠端 `release` 分支**（由使用者決定）。
