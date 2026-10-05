# 一鍵更新（擴充功能 + 本機小程式）設計文件

日期：2026-10-05
狀態：待使用者審閱
前置文件：`2026-10-04-youtube-batch-downloader-design.md`（本文件擴充其第 4、5 節）

## 1. 目的與已確認的決定

**先釐清**：影片下載仍然完全在使用者自己的電腦上執行（Chrome → 本機小程式 → yt-dlp → YouTube），GitHub 不參與。本文件的 GitHub 只用來存放「工具本身的程式碼」，更新時只下載檔案，不上傳任何東西。

**目的**：側邊面板能顯示更新狀態，發現新版時提示，並讓使用者按一下就更新擴充功能與本機小程式，不必重新下載資料夾。

**使用者已確認**
- 更新方式照使用者的「圖片套版產生器」（`QuickPatterntool`）：不用 Release、不用 GitHub Actions、不用簽章；擴充功能自己比對 GitHub 上的檔案，使用者只需選一次擴充功能資料夾，更新後自動重新載入。
- 追蹤的不是 `main`，而是獨立的 `release` 分支：維護者把測試過的版本推到 `release`，同事才會收到更新，避免做到一半的程式碼直接送出。
- repo 已經公開。

**不在範圍**：Release／Actions／簽章、自動（不經使用者按鈕）套用更新、Chrome 商店、Linux、更新 yt-dlp（沿用既有的「更新下載引擎」）、由 Claude 代為建立或推送遠端的 `release` 分支（對外動作，由使用者決定與執行）。

**參考的實際做法**（讀 `QuickPatterntool/updater.js` 與 `README.md` 得知，未實際執行）：向 GitHub 取得被追蹤分支最新 commit 的檔案清單與每個檔案的 git blob SHA → 與擴充功能自己目前的檔案比對 → 有差異的檔案才下載（網址固定在該 commit，內容不會變）→ 重新計算 blob SHA 確認與清單一致 → 以 File System Access API 寫回使用者選定的資料夾 → `chrome.runtime.reload()`。

## 2. 與圖片套版產生器的差異（本專案多出來的部分）

圖片套版只有擴充功能的 JS 檔，所以一次授權資料夾就夠了。本專案還有本機小程式（Python 檔案，裝在 `<安裝目錄>/host`），瀏覽器的資料夾授權寫不到那裡，所以：

- **擴充功能的檔案**：由擴充功能自己更新（同圖片套版）。
- **小程式的檔案**：由小程式自己更新（同樣的比對與驗證方法），擴充功能負責協調，讓兩邊一起完成。
- 擴充功能不用搬家：維持目前的做法（從任何資料夾載入，「下載部署」按鈕用擴充功能內附的安裝檔），不需要新的安裝位置或標記檔。

## 3. 發佈與初次安裝

**發版（維護者）**：跑完測試後，把確定的 commit 推到遠端 `release` 分支（`git push origin <commit>:release`）。出貨前同步更新 `extension/manifest.json` 的 `version` 與 `host/version.py` 的 `VERSION`，兩者必須相同（測試強制）。已提交的安裝檔必須是最新的（既有測試已強制）。建議對 `release` 分支開啟 GitHub 分支保護（限制誰能推送），並對 GitHub 帳號啟用雙重驗證。

**初次安裝（新同事）**：下載 `https://github.com/unnn3ing-oss/videodownload/archive/refs/heads/release.zip` → 解壓縮 → 從 `extension` 資料夾載入未封裝項目 → 面板內「下載部署」→ 執行安裝檔 → 「啟動」。之後的更新全部在面板內完成。

**追蹤設定**：擴充功能 `extension/lib/update-config.js` 與小程式 `host/update_config.py` 各有一份 `OWNER`、`REPO`、`BRANCH`（`release`），測試確保兩份一致。

## 4. 比對規則

- **擴充功能檔案**：repo 中 `extension/` 之下的檔案，去掉前綴後對應到擴充功能資料夾的相對路徑；排除 `extension/tests/`。包含 `extension/installers/`（讓「下載部署」取得的安裝檔也是最新的）。
- **小程式檔案**：repo 中 `host/` 最上層的 `*.py`（檔名限 `^[A-Za-z0-9_]+\.py$`）；排除 `host/tests/`。
- **相等判斷**：git blob SHA（`sha1("blob <位元組數>\0" + 內容)`）。文字檔另以換行正規化（CRLF → LF）再比一次，換行不同不算有差異（同圖片套版）。
- **API 次數**：只有擴充功能呼叫 GitHub API（取得 commit 與檔案樹，每次檢查 2 次）；小程式不呼叫 API，改由擴充功能把小程式檔案的清單（路徑、SHA、大小）傳給它。避免辦公室多人共用同一個對外 IP 時超過未登入的每小時 60 次限制。下載檔案走 `raw.githubusercontent.com`（不受 API 次數限制）。
- **檢查頻率**：背景以 `chrome.alarms` 每 6 小時檢查一次（只比對擴充功能檔案），有新版時工具列圖示顯示「新」；面板開啟時若距上次檢查超過 6 小時也會檢查；手動「檢查更新」不受限制。

## 5. 協定（擴充既有 Native Messaging 訊息）

**擴充功能 → 小程式**
- `update_check { files: [{ path, sha, size }] }`：小程式回覆有差異的檔名。
- `update_stage { commit, files: [{ path, sha, size }] }`：只傳有差異的檔案。小程式從 `https://raw.githubusercontent.com/<OWNER>/<REPO>/<commit>/host/<path>` 下載到 `<安裝目錄>/update/staging/`，逐一驗證 blob SHA，並做更新前自我檢查。
- `update_commit {}`：把 staging 的檔案換進 `host/`，舊檔備份到 `<安裝目錄>/backup/host/`。
- `update_rollback {}`：從備份還原。

**小程式 → 擴充功能**
- `update_status { changed: [path], total }`
- `update_staged { count }`
- `update_applied { count }`：新程式碼已就位，下次啟動生效。
- `update_rolled_back {}`
- `error { code }` 新增代碼：`update_bad_file`（檔名不合規）、`update_download_failed`、`update_hash_mismatch`、`update_selfcheck_failed`、`update_install_failed`（含 `rolledBack: true`）、`update_nothing_staged`、`busy`（有下載工作進行中時拒絕）。

`ready` 訊息新增 `version`（小程式版本）。

## 6. 更新流程（面板的「更新到最新版」）

1. **（使用者操作當下）取得資料夾**：若擴充功能檔案有差異，立即取得之前選過的資料夾；權限過期就重新要求；第一次則以 `showDirectoryPicker` 請使用者選擴充功能資料夾。選到的資料夾必須有 `manifest.json` 且名稱相同。這一步一定要在按鈕點擊後馬上做，過了瀏覽器的使用者操作時效就不能再叫出選擇視窗。
2. 擴充功能下載有差異的檔案到記憶體，逐一驗證 blob SHA；任何一個不符就中止，不寫入任何東西。
3. 小程式 `update_stage`：下載、驗證、自我檢查（以目前的 Python 直譯器在子行程中匯入 staging 的程式確認可載入）。失敗就中止，現有安裝不動。
4. 小程式 `update_commit`：以逐檔 `os.replace` 換入，先備份舊檔；任何一步失敗就從備份還原並回報 `rolledBack: true`。
5. 擴充功能把檔案寫進選定的資料夾。**`manifest.json` 最後寫**，且新的 `key` 必須與目前相同（識別碼不得改變，否則 Native Messaging 白名單失效，不相同就在第 2 步中止）。
6. 寫入失敗：送出 `update_rollback` 還原小程式，並顯示錯誤。擴充功能檔案是逐檔比對的，重新按一次更新會從剩下的差異繼續，結果收斂。
7. 全部成功：呼叫 `chrome.runtime.reload()`；舊的小程式行程隨連線關閉而結束，下次「啟動」使用新程式碼。

**需要小程式在執行中**：更新必須在小程式已啟動時進行（要更新它的檔案）。未啟動時，面板只顯示「有新版本」並提示先按「啟動」。

**已知限制（如實說明）**：若新版通過自我檢查卻在實際啟動時失敗，擴充功能無法自行還原（壞掉的是小程式本身）。處理方式：把 `backup/host/` 的檔案手動複製回 `host/`，或重新執行安裝檔，README 會說明。

## 7. 側邊面板

- 標題旁：有新版時顯示「有新版本」徽章，點擊捲到更新卡片。
- 「設定與工具」新增「版本與更新」區：目前版本、最新版本的日期與說明（commit 訊息第一行）、`檢查更新`、有新版時的 `更新到最新版`（第一次顯示「選擇擴充功能資料夾並更新」）、進度文字（下載、驗證、寫入）。
- 有下載工作進行中、或小程式未啟動時停用更新鈕並說明原因。
- 所有來自 GitHub 的文字一律以 `textContent` 顯示。
- 新增權限：`alarms`；host 權限新增 `https://api.github.com/*`、`https://raw.githubusercontent.com/*`。

## 8. 安全

| 威脅 | 對策 |
|---|---|
| 下載內容損毀或與清單不一致 | 重新計算 git blob SHA，與清單比對；任何不符就整個中止 |
| 惡意檔名（路徑逃逸） | 擴充功能端：只寫入選定資料夾之內，拒絕絕對路徑、`..`、`.git`；小程式端：檔名白名單 `^[A-Za-z0-9_]+\.py$`、只換入 `host/` 最上層 |
| 更新後識別碼改變導致連不上 | `manifest.json` 的 `key` 不得改變 |
| 更新後小程式無法載入 | 換入前在子行程中匯入驗證 |
| 寫到別的資料夾 | 選取的資料夾必須有同名的 `manifest.json` |
| 有人把更新來源改指向別處 | 倉庫、分支、網域寫死在程式碼中，不接受訊息或設定覆蓋 |

**殘餘風險（與圖片套版產生器相同的信任程度）**：能推送到 `release` 分支的人（例如 GitHub 帳號被盜），就能影響所有同事的電腦；沒有簽章可擋。對策是分支保護與雙重驗證（見第 3 節），而不是程式碼。

## 9. 測試與驗證

**可在開發環境測試**
- 擴充功能端（node）：git blob SHA（已知向量）、換行正規化、路徑對應與排除規則、拒絕不安全路徑、以假的 GitHub 回應計算差異、以記憶體中的假資料夾測試套用（驗證失敗時不寫入任何檔案、`manifest.json` 最後寫入、重試會收斂、`key` 改變被拒）。
- 小程式端（pytest）：blob SHA、檔名白名單、以本機 HTTP 假伺服器模擬 raw 下載；雜湊不符、下載失敗、自我檢查失敗皆不改動現有檔案；換入、備份、還原；有下載工作進行中時拒絕；JS 與 Python 兩份追蹤設定一致；版本號一致。
- 面板端對端（無頭 Chromium）：以 `context.route` 攔截 GitHub 請求，並用瀏覽器的私有檔案系統（OPFS）代替「選到的資料夾」，驗證徽章、檢查、更新進度、更新後呼叫重新載入。

**無法在開發環境驗證（需要使用者）**
- 真實 GitHub 的比對與下載（尚未有 `release` 分支）。
- 真實的資料夾選擇視窗：Chrome 會拒絕某些系統資料夾（例如磁碟根目錄、使用者的「下載」「文件」資料夾本身），擴充功能放在這些位置時無法授權，需要搬到一般子資料夾。
- Windows／Mac 真機上的檔案替換與占用行為。
- Chrome 在真機上重新載入未封裝擴充功能。

## 10. 使用者要做的一次性設定

1. 決定哪個 commit 是第一個正式版本（目前功能還在 `claude/youtube-video-downloader-4gvj18` 分支，尚未合併到任何預設分支），並推送成遠端 `release` 分支。
2. 對 `release` 分支開啟分支保護、對 GitHub 帳號啟用雙重驗證（建議）。
3. 依 README 冒煙測試：從 `release.zip` 安裝 → 推一個更高版本到 `release` → 面板檢查更新、一鍵更新。

## 11. 成功標準

1. 從 `release.zip` 初次安裝後，擴充功能與小程式都能正常運作。
2. 維護者推新版本到 `release` 後，工具列圖示與面板在 6 小時內（或按「檢查更新」立即）顯示有新版本；按「更新到最新版」後，擴充功能與小程式都換成新版並重新載入。
3. 雜湊不符、檔名不合規、識別碼被改、新版小程式無法載入、替換中途失敗的更新，都不會改動現有安裝，或能完整還原。
4. 有下載工作進行中時不會更新。
5. 第 9 節標明「無法在開發環境驗證」的項目，由使用者依第 10 節冒煙測試確認，開發端不宣稱已驗證。
