# 測試說明

## 各種測試涵蓋什麼

| 測試 | 位置 | 涵蓋 | 怎麼跑 |
| --- | --- | --- | --- |
| Python：下載助手 | `host/tests/` | 通訊協定、yt-dlp 參數與錯誤分類、工作佇列、安裝程式（`installer.py`）、Mac／Windows 引擎安裝、自我更新、診斷（doctor）、紀錄檔 | `python3 -m pytest -q` |
| Python：建置與安裝檔 | `tests/test_build.py` | 內嵌 host 與擴充功能的安裝檔、已提交的安裝檔與最新程式碼一致、Mac 安裝檔用假的 curl 實跑（含 `curl \| bash` 方式）、Windows 安裝檔的 PowerShell 語法（需要 `pwsh`，沒有就跳過） | 同上 |
| Python：發版與外部檢查工具 | `tests/test_release.py`、`tests/test_canary.py` | `tools/release.py`（用暫存的假 repo）、`tools/canary_*.py` 與 `tools/win_registry_smoke.py` 的純邏輯（不連網） | 同上 |
| Node：擴充功能純邏輯 | `extension/tests/*.test.mjs` | 佇列、訊息來源檢查、更新規則與流程、安裝檔下載、連線提示、manifest；**`extension-id.test.mjs` 釘死擴充功能識別碼** | `node --test extension/tests/*.test.mjs`（或 `npm run test:node`） |
| 端對端（e2e） | `extension/tests/e2e/*.e2e.mjs` | 在真的 Chromium 載入擴充功能、跑真的 `host.py`（假的 yt-dlp、假的 GitHub、假的 i.ytimg.com） | `npm run test:e2e` |

六個 e2e suite：

- `queue`：背景程式的清單（增加、解析、重複、依序下載與冷卻、下載中增減、複製內文、封面、誰能呼叫清單）。
- `oldhost`：連到舊版下載助手時，兩個畫面的提示、停用「開始」、複製內文的說明。
- `sidepanel`：側邊面板頁面＋背景程式＋真的 host（假的引擎）。
- `web`：網頁版（`index.html`＋`web/`，以 route 模擬 GitHub Pages）：沒有擴充功能時的部署、有擴充功能時自動偵測與連線。
- `update`：側邊面板的自我更新流程，對假的 GitHub。
- `webupdate`：網頁版的「檢查更新／更新到最新版」，對假的 GitHub，含竄改被擋下。

另外還有幾道靜態保護：`.gitattributes`（換行字元；`extension/installers/*` 是逐位元組比對的產生檔，不轉換、不當文字比對）、
CI 的 `build-fresh`（已提交的安裝檔必須等於重新建置的結果）、`tools/release.py check`（發版前的檢查表）。

## 在本機跑

```bash
pip install -r requirements-dev.txt          # 只有 pytest；host 與建置只用標準函式庫
python3 -m pytest -q                         # pytest.ini 已設好 pythonpath 與 testpaths（host/tests、tests）
python3 -m pytest -q tests/test_release.py   # 只跑某個檔案

node --test extension/tests/*.test.mjs       # 或 npm run test:node

npm ci                                       # 安裝 playwright-core（版本寫在 package.json，目前 1.56.1）
npx playwright-core install chromium         # 沒有現成的 Chromium 時；之後可用 PW_CHROMIUM 指定位置
npm run test:e2e                             # 六個 suite 依序跑，任一個失敗就停
node extension/tests/e2e/queue.e2e.mjs       # 也可以單跑一個
```

e2e 的瀏覽器位置：`PW_CHROMIUM`，沒設就用 `/opt/pw-browsers/chromium`。用 playwright 自己下載的版本時：

```bash
export PW_CHROMIUM="$(node -e "import('playwright-core').then(m => console.log(m.chromium.executablePath()))")"
```

e2e 以 `--headless=new` 啟動 Chromium（擴充功能需要新版無頭模式），**不需要顯示器或 xvfb**。

### 環境變數

| 變數 | 作用 |
| --- | --- |
| `LANG=C.UTF-8`（`LC_ALL` 同） | **必須是 UTF-8 語系。** Chromium 在非 UTF-8 的語系下，會把含中文的檔名交給 `chrome.downloads` 變成 `Invalid filename`，封面與影片的下載測試會因此失敗。`helpers.mjs` 啟動瀏覽器時已經設了，但自己的 shell 與 CI 也建議設好。 |
| `E2E_STRICT=1` | 嚴格模式的旗標：「無法啟動瀏覽器」（結束碼 2，`UNVERIFIED`）要算失敗，不能當作通過。CI 有設；**目前 e2e 腳本（`helpers.mjs`）還沒有讀取它**，真正讓 CI 嚴格的是 CI 的迴圈：任何非 0 的結束碼（包含 2）都算失敗。在本機，結束碼 2 只代表「這台機器驗證不了」，**不代表通過**。 |
| `PW_CHROMIUM` | Chromium 執行檔的位置。 |
| `E2E_TMP` | 暫存工作資料夾（Chrome 的 profile 等）放在哪裡，預設系統暫存目錄。 |
| `E2E_SHOTS=<資料夾>` | 順便截圖到這個資料夾（資料夾要先建立）。CI 失敗時會把它和紀錄一起上傳。 |
| `E2E_SCHEME=dark` | 以深色模式跑側邊面板的測試。 |

結束碼慣例：`0` 通過、`1` 斷言失敗、`2` 無法驗證（瀏覽器或擴充功能啟動不了）。

## CI 涵蓋什麼，只有真機才能驗證什麼

### CI（`.github/workflows/ci.yml`，全部設為必要檢查）

| 工作 | 內容 |
| --- | --- |
| `linux (3.9)`、`linux (3.12)` | 全部 Python 測試；3.9 是 Mac 內建的 Python 版本，3.12 是 Windows 安裝檔內嵌的版本 |
| `node` | 擴充功能的 Node 測試（含識別碼釘選） |
| `build-fresh` | `python3 build.py` 之後，`extension/installers` 必須與已提交的完全相同 |
| `e2e` | 六個 e2e suite（Ubuntu、Chromium、UTF-8、`E2E_STRICT=1`），失敗時上傳紀錄 |
| `windows` | `pytest host/tests tests`、Windows 安裝檔的 PowerShell 語法檢查（不能被跳過）、`tools/win_registry_smoke.py`（用真的登錄表跑 `register()` 再由 doctor 讀回，最後刪除） |
| `macos` | `pytest host/tests` |

不擋合併的每晚檢查（`.github/workflows/canary.yml`）：`tools/canary_urls.py urls`（安裝檔下載的每個網址還活著）、
`tools/canary_urls.py sums`（yt-dlp 最新版的 `SHA2-256SUMS` 仍列出安裝檔要驗證的檔案）、
`tools/canary_flags.py`（最新 yt-dlp 的 `--help` 仍有 host 用到的每個參數）。本機可以直接跑：
`python3 tools/canary_urls.py`；`pip install yt-dlp && python3 tools/canary_flags.py`。

### 只有真的 Windows／Mac 電腦才能驗證的

CI 的 runner 是乾淨、能直連網際網路的虛擬機，沒有下面這些：

- **真實的 Chrome 與 Chrome Web Store 以外的「載入未封裝項目」流程**：在真的 Chrome 裡載入資料夾、按下「重新載入」、Chrome 對下載助手的啟動方式與權限提示。（e2e 用的是 Chromium，且啟動旗標不同。）
- **防毒軟體與 Windows Defender／SmartScreen**：對 `yt-dlp.exe`、`deno.exe`、`ffmpeg.exe` 的攔截、隔離、第一次啟動的掃描延遲。
- **公司網路**：代理伺服器、憑證攔截（TLS 檢查）、被擋的 GitHub／YouTube 網域；Windows 上 curl 的憑證撤銷檢查。
- **macOS 的 Gatekeeper 與隔離屬性**（quarantine）：下載的程式被標記「來自網際網路」之後能不能執行；Apple Silicon 上的 Rosetta；macOS 內建 bash 3.2 與 BSD 工具的差異。
- **各種語系與使用者名稱**：非 ASCII 的使用者名稱／路徑、非 UTF-8 的系統語系、Windows 的 cp950 主控台。
- **真的 YouTube**：YouTube 實際的回應、機器人驗證、年齡限制；CI 用的是假的 yt-dlp，每晚的 canary 只檢查「參數還在」，不代表下載真的成功。
- **真實的自動更新**：對真的 GitHub、真的擴充功能資料夾、真的 `chrome.runtime.reload()`。
- 實際的磁碟、睡眠／喚醒、長時間下載。

所以每次發版後，仍要照 `docs/RELEASING.md` 的「真機檢查」在一台 Windows 與一台 Mac 上實測一次。
