# YouTube 批量下載工具（Chrome 擴充功能 + 本機小程式）設計文件

日期：2026-10-04
狀態：待使用者審閱

## 1. 目的與背景

**目的**：讓沒有 YouTube 頻道後台權限的部門，能把公司自有頻道的公開影片下載到本機，再人工上傳到其他社群平台。

**已確認的需求（使用者說的）**
- 可選 720p 或 1080p。
- 可批量下載（多行網址、播放清單、頻道網址）。
- 檔名直接使用影片標題；不需要 manifest.csv。
- 介面是 Chrome 擴充功能，有「下載部署」「啟動」兩顆按鈕，以及網址、解析度、影片標題（檔名）、下載。
- 在本機執行；使用者以 Windows 為主，Mac 也要支援，並在「下載部署」時自動判斷系統。
- 保留「最多下載 N 支」欄位。

**限制與前提（事實）**
- 使用者沒有頻道權限，因此只處理公開與不公開連結影片，不使用登入 cookies。
- 擴充功能無法自行安裝軟體或啟動本機程式；只能透過 Chrome 官方的 Native Messaging 與已登錄的本機程式溝通。
- 開發用的雲端沙箱連不上 YouTube，無法在其中驗證真實下載。

## 2. 範圍

**包含**：擴充功能介面、本機小程式、Windows 與 Mac 安裝檔、畫質選擇、批量下載、續傳與跳過已下載、引擎更新、繁體中文 README。

**不包含**：manifest/CSV、登入或 cookies、雲端部署、自動上傳社群平台、格式轉換（9:16 等）、Chrome 商店上架、Linux、Chrome 以外的瀏覽器。

## 3. 整體架構

```
Chrome 擴充功能 (MV3)
  popup  <—runtime message—>  background service worker
                                   │  Native Messaging（stdin/stdout JSON，無網路埠）
                                   ▼
                              本機小程式 host（Python 標準函式庫）
                                   │  subprocess（參數陣列，不經 shell）
                                   ▼
                          yt-dlp（獨立執行檔）+ ffmpeg + JS 執行環境
```

- background service worker 持有 Native Messaging 連線；popup 關閉後下載繼續。關閉 Chrome 會中止下載，已下載的片段在重跑時續傳。
- 不開本機網路埠，避免其他網頁呼叫；host 登錄時以 `allowed_origins` 限定只有本擴充功能能連。
- 擴充功能識別碼以 manifest 的 `key` 固定，安裝檔內寫入同一個識別碼。

## 4. 擴充功能

**popup 欄位與按鈕**
| 項目 | 行為 |
|---|---|
| 網址 | 預設帶入目前分頁網址；可貼多行，或播放清單／頻道網址 |
| 解析度 | 720p / 1080p |
| 檔名 | 單支時預設為影片標題，可修改；多支時各自使用自己的標題，此欄位停用 |
| 最多下載 N 支 | 僅對播放清單／頻道有效，空白代表全部 |
| 下載部署 | 以 `chrome.runtime.getPlatformInfo()` 判斷 win/mac，儲存對應的單檔安裝檔 |
| 啟動 | 呼叫 `connectNative`，由 Chrome 啟動 host |
| 下載 | 送出下載工作 |
| 更新引擎 | 次要連結；呼叫 host 更新 yt-dlp |

**狀態**：未部署（找不到 host）→ 已部署未啟動 → 已啟動。連線失敗訊息為「Specified native messaging host not found」時，提示先按「下載部署」。

**進度顯示**：每支影片的進度、速度、剩餘時間、成功或失敗原因；整批結束顯示摘要。

**最低 Chrome 版本**：110（需要 Native Messaging 連線能維持 service worker 存活）。

## 5. Native Messaging 協定（JSON）

**擴充功能 → host**
- `ping`
- `resolve { urls[], limit? }`：展開播放清單／頻道，回傳 `{ id, title, url }[]`
- `download { items[{ url, id?, title? }], quality: 720|1080, titleOverride? }`（輸出資料夾只由 `set_config` 決定，上限 `limit` 只用在 `resolve`）
- `cancel { jobId }`
- `get_config` / `set_config { outputDir }`
- `update_engine`

**host → 擴充功能**
- `ready { hostVersion, ytdlpVersion, ffmpegOk, jsRuntimeOk, outputDir }`
- `progress { jobId, itemId, percent, speed, eta, stage }`
- `item_done { itemId, file, height, codec }`
- `item_failed { itemId, reason, code }`
- `done { jobId, summary }`

每個請求可帶 `reqId`，host 的直接回覆都會帶回。直接回覆型別：`pong`、`started { jobId }`、`resolved { items[{ id, title, url }] }`、`config { outputDir }`、`engine_updated { ytdlpVersion }`、`error { code, message }`；錯誤代碼：`bad_json`、`unknown_type`、`bad_url`、`bad_quality`、`bad_path`、`busy`、`engine_missing`、`update_failed`、`internal`，以及 `resolve` 失敗時沿用下載錯誤分類的代碼。`cancel` 的 `jobId` 可省略（同一時間只有一個工作）。

單則訊息保持在 1 MB 以內（Chrome 對 host→擴充功能的限制）。

## 6. 本機小程式

**畫質規則**：選 N 就抓「高度不超過 N 的最佳畫質」。優先 H.264 + AAC，輸出 mp4。若只能取得其他編碼，仍輸出 mp4，並在 `item_done.codec` 回報，popup 顯示「非 H.264，部分平台可能需轉檔」。影片原本低於 N 時抓其最高畫質，不算失敗。

**檔名規則**
1. 以影片標題為基礎（或使用者在單支模式輸入的檔名）。
2. 替換 Windows 不允許的字元 `\ / : * ? " < > |`，移除結尾的點與空白，避開保留名稱（CON、NUL 等），長度限制在 200 字元內。
3. 若目標檔案已存在且不屬於同一支影片，檔名後加 ` [影片ID]`。

**批量與續傳**
- 單支失敗只記錄，不中斷整批。
- 輸出資料夾內有隱藏的內部紀錄檔（影片 ID 對應檔名）。已下載且檔案仍在的影片會跳過並回報「已下載過」；檔案被刪除則重新下載。這不是使用者要的 manifest，僅供續跑使用。
- 預設低併發並加間隔，降低被限流的機率。

**錯誤分類**：私人、已下架、地區限制、要求登入或驗證（提示改用住宅或公司網路，不重試）、網路中斷、引擎需更新、磁碟空間不足。

**預設存放位置**：使用者下載資料夾下的 `YT下載`，可由 `set_config` 修改。

**安全**
- 只接受 youtube.com、youtu.be 網域的網址。
- 呼叫 yt-dlp 一律用參數陣列，網址前加 `--`，不使用 shell。
- 輸出路徑檢查，檔名不得跳出輸出資料夾。

**引擎更新**：`update_engine` 執行 yt-dlp 自我更新。YouTube 改版時引擎會失效，沒有更新途徑工具就會失效，所以這項列入範圍。

## 7. 安裝檔（單檔、內嵌 host 程式碼）

由 `build.py` 產生，使用者只需雙擊一次。內容：
1. 把 host 程式碼寫入使用者目錄（Windows：`%LOCALAPPDATA%\YTDownloader`；Mac：`~/Library/Application Support/YTDownloader`）。
2. 取得依賴：獨立 Python（host 只用標準函式庫，不需要 pip）、yt-dlp 獨立執行檔、ffmpeg 靜態版本、JS 執行環境（見第 10 節）。
3. 登錄 Native Messaging：Windows 寫入 `HKCU\Software\Google\Chrome\NativeMessagingHosts\<名稱>` 並指向 host 啟動批次檔；Mac 寫入 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/<名稱>.json`。
4. 結束時顯示成功或失敗原因。

- Windows：`install-windows.cmd`（內含 PowerShell 腳本）。
- Mac：`install-mac.command`；可執行權限與 Gatekeeper 提示記錄在 README。
- `build.py` 產生的安裝檔放入擴充功能資料夾；測試檢查安裝檔內嵌的 host 程式碼雜湊與原始碼一致，避免版本漂移。

## 8. 專案結構

```
extension/
  manifest.json            # MV3，nativeMessaging、downloads、activeTab、storage，固定 key
  background.js
  popup.html / popup.js / popup.css
  installers/              # build.py 產出
host/
  host.py                  # 入口，Native Messaging 迴圈
  protocol.py              # 訊息編解碼
  quality.py               # 畫質 → yt-dlp 格式
  naming.py                # 檔名清理與衝突處理
  jobs.py                  # 佇列、進度、取消、續傳紀錄
  ytdlp.py                 # 呼叫 yt-dlp，解析輸出
  tests/
build.py
README.md                  # 繁體中文，含 Windows 與 Mac 步驟與冒煙測試
docs/superpowers/specs/
```

## 9. 測試與驗證

**可在開發環境測試**
- `protocol`：訊息框架、超長訊息、損壞輸入。
- `quality`：720/1080 對應格式字串。
- `naming`：非法字元、保留名稱、過長、衝突。
- `jobs`：跳過已下載、失敗不中斷、取消。
- `ytdlp`：以假的 yt-dlp 輸出測試進度與錯誤分類。
- 網址白名單與路徑檢查。
- 安裝檔雜湊一致性。
- 擴充功能能否在 Chromium 載入、popup 欄位與狀態切換（以 Playwright 嘗試；若 Native Messaging 在無頭模式無法驗證，則明確標示未驗證）。

**無法在開發環境驗證，需使用者冒煙測試**
- 真實下載 YouTube（沙箱連不上）。
- 安裝檔在真實 Windows／Mac 上的行為。
- Chrome 實際啟動 host。

README 會附冒煙測試步驟：安裝 → 啟動 → 下載一支公開短片（720p）→ 下載一個小播放清單（1080p）→ 確認檔名與畫質。

## 10. 風險與待查證項目

| 風險／待查證 | 說明 | 處理 |
|---|---|---|
| 新版 yt-dlp 需要 JS 執行環境 | 據我所知近期 YouTube 提取需要外部 JS 執行環境（如 Deno）；未在本次查證 | 實作計畫階段查證最新 yt-dlp 文件，必要時安裝檔一併取得並以參數指定；`ready.jsRuntimeOk` 回報狀態 |
| 公司 IT 管控 | 可能禁止開發人員模式擴充功能、腳本執行、Native Messaging，或防毒軟體攔截 yt-dlp | README 列出，需要時請 IT 協助 |
| Windows SmartScreen／Mac Gatekeeper | 瀏覽器下載的安裝檔會有安全性提示 | README 附圖文步驟 |
| 開發人員模式提醒 | Chrome 啟動時可能提示停用此類擴充功能 | 無法避免；企業政策自架為日後選項 |
| 啟動批次檔作為 host（Windows） | 以 `.cmd` 啟動 Python，stdio 傳遞需實測 | 計畫階段列為首要冒煙項目 |
| 下載依賴的連結與版本 | Python、ffmpeg、Deno 的下載網址與版本會變動 | 計畫階段逐一驗證連結可用，版本寫入設定 |
| 服務條款與版權 | YouTube 條款原則上不允許官方功能以外的下載；影片中的音樂、外部素材授權可能僅限 YouTube | 使用前取得頻道管理部門同意；轉發前確認授權 |
| 不用 cookies | 年齡限制、會員專屬、私人影片無法下載 | 在 UI 與 README 說明，失敗訊息明確標示 |

## 11. 成功標準

1. 在 Windows 與 Mac 上，按「下載部署」會取得對應的安裝檔，雙擊一次後，「啟動」按鈕能連上 host。
2. 輸入單支網址，選 720p 或 1080p，下載後檔名為影片標題，畫質符合規則。
3. 輸入播放清單或頻道網址，可批量下載，單支失敗不影響其他，重跑會跳過已完成的影片。
4. 錯誤訊息能讓使用者分辨是網路、權限、被擋或引擎過舊。
5. 以上第 1 至 4 點中「真實下載」與「安裝檔行為」的部分，由使用者依 README 冒煙測試確認，開發端不宣稱已驗證。
