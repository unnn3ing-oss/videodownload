# 一鍵更新（擴充功能 + 本機小程式）設計文件

日期：2026-10-05
狀態：待使用者審閱
前置文件：`2026-10-04-youtube-batch-downloader-design.md`（本文件擴充其第 4、5、7 節）

## 1. 目的與已確認的決定

**先釐清**：影片下載仍然完全在使用者自己的電腦上執行（Chrome → 本機小程式 → yt-dlp → YouTube），GitHub 不參與。本文件的 GitHub 只用來存放「工具本身的更新包」，GitHub Actions 只在維護者發新版時於 GitHub 伺服器上打包與簽章，使用者的電腦不會用到；更新時本機小程式只下載更新包，不上傳任何東西。

**目的**：側邊面板能顯示目前版本、發現新版時提示，並讓使用者按一下就更新擴充功能與本機小程式，不必重新下載資料夾。

**使用者已確認**
- 範圍：面板內一鍵更新整個工具（擴充功能 + host），失敗自動還原。
- 更新來源：這個 repo（`unnn3ing-oss/videodownload`）的公開 GitHub Release；由使用者在 GitHub 設定中把 repo 改成公開。
- 信任方式：更新包以 Ed25519 簽章，私鑰存在 GitHub Actions secret，公鑰內建在 host。
- 發版方式：推版本標籤（`vX.Y.Z`）後，由 GitHub Actions 自動測試、打包、簽章、建立 Release。

**不在範圍**：自動（不經使用者按鈕）更新、Chrome 商店發佈、Linux、更新 yt-dlp（沿用既有的「更新下載引擎」）、由 Claude 代為公開 repo／建立標籤／建立 Release／設定 secret（這些是對外動作，由使用者親自執行）。

## 2. 為什麼要改安裝位置（已發現的限制）

- 以「載入未封裝項目」安裝的擴充功能無法修改自己的檔案；host 也不知道擴充功能資料夾在哪裡。
- 因此擴充功能必須放在 host 能寫入、且位置固定的資料夾：安裝檔把擴充功能一起安裝到 `<安裝目錄>/extension`（Windows：`%LOCALAPPDATA%\YTDownloader\extension`；Mac：`~/Library/Application Support/YTDownloader/extension`），使用者從那裡載入一次。
- 擴充功能識別碼由 manifest 的 `key` 固定，從不同資料夾載入識別碼不變，Native Messaging 登錄不受影響。

**對既有安裝檔的影響**：`build.py` 產生的安裝檔內嵌內容，除了 `host/*.py`，還要加入 `extension/**`（排除 `tests/` 與 `installers/`，避免安裝檔裡再包安裝檔）；安裝檔把它解到 `<安裝目錄>/extension` 並寫入 `managed.json`。因此從安裝目錄載入的擴充功能資料夾裡沒有安裝檔：此時「下載部署」與「重新下載安裝檔」改成在新分頁開啟 Release 頁面（`https://github.com/unnn3ing-oss/videodownload/releases/latest`），由使用者下載最新安裝檔。

**第一次安裝流程（新）**：到 GitHub Release 頁面下載安裝檔 → 執行 → 從 `<安裝目錄>/extension` 載入未封裝項目 → 啟動。

**已經用舊方式安裝的人（目前的測試版）**：搬一次家，改從 `<安裝目錄>/extension` 載入，之後就能一鍵更新。

**如何判斷是否可更新**：安裝檔在 `<安裝目錄>/extension` 寫入 `managed.json`。擴充功能讀取自己的 `managed.json`：讀得到才表示是從安裝目錄載入，才開放更新；讀不到時，面板顯示「目前不是從安裝資料夾載入，無法自動更新。請改從 `<安裝目錄>/extension` 載入」（安裝目錄由 host 的 `ready` 訊息提供）。

## 3. 發佈

**更新包** `ytdl-update-X.Y.Z.zip`：
- `release.json`：`{ "version": "X.Y.Z" }`
- `host/*.py`（不含測試）
- `extension/**`（不含 `tests/`、`installers/`）

**Release 附件**：`ytdl-update-X.Y.Z.zip`、`ytdl-update-X.Y.Z.zip.sig`（對 zip 位元組的 Ed25519 簽章）、`install-windows.cmd`、`install-mac.zip`（給第一次安裝的人）。

**版本號**：`extension/manifest.json` 的 `version` 與 `host/version.py` 的 `VERSION` 必須相同，測試強制；標籤 `vX.Y.Z` 必須等於它們。

**發版流程（維護者）**：`python tools/bump_version.py X.Y.Z` → 提交 → 推標籤 `vX.Y.Z` → `.github/workflows/release.yml` 執行 pytest 與 JS 測試 → `tools/make_release.py` 打包並用 secret `UPDATE_SIGNING_KEY` 簽章 → 用 `gh release create` 建立 Release（`permissions: contents: write`）。

**金鑰**：`tools/gen_update_key.py` 在使用者本機產生金鑰對，印出私鑰（填入 GitHub secret）並把公鑰寫入 `host/update_key.py`。私鑰絕不進 repo，也不經過 Claude。在公鑰設定之前，`PUBLIC_KEY_HEX` 為空字串，host 拒絕更新並顯示「尚未設定更新金鑰」。

## 4. 協定（擴充既有 Native Messaging 訊息）

**擴充功能 → host**
- `check_update`
- `apply_update`

**host → 擴充功能**
- `update_info { current, latest, available, notes, publishedAt }`：`notes` 為 Release 說明前 500 字，面板以純文字顯示。
- `update_progress { stage: "download"|"verify"|"install", percent? }`
- `update_applied { version }`：新程式碼已就位，需要重新載入擴充功能。
- `error { code }` 新增代碼：`update_check_failed`、`no_release`、`update_key_missing`、`update_bad_signature`、`update_not_newer`、`update_bad_package`、`update_key_changed`、`update_selfcheck_failed`、`update_install_failed`（含 `rolledBack: true`）、`busy`（有下載工作進行中時拒絕更新）。

`ready` 訊息新增 `version`（host 版本）與 `installDir`。

**網路**：由 host 以 `urllib` 對 `https://api.github.com/repos/unnn3ing-oss/videodownload/releases/latest` 發出請求（附 User-Agent），只接受 HTTPS，使用系統憑證驗證，永不關閉憑證驗證。測試用途可以環境變數 `YTDL_UPDATE_API` 改指向本機假伺服器；即使被改指向，簽章驗證仍必須通過。

## 5. 更新流程（host 的 `apply_update`）

1. 下載 zip 與 `.sig` 到 `<安裝目錄>/update/`（大小上限 50 MB）。
2. **驗簽**：用內建公鑰驗證 `.sig` 對 zip 位元組的 Ed25519 簽章。失敗即中止。
3. **檢查 zip 安全**：只允許 `release.json`、`host/`、`extension/` 三個最上層項目；拒絕絕對路徑、`..`、符號連結；檔案數量與解壓後大小設上限。
4. **檢查版本**：`release.json` 的版本必須等於 Release 標籤，且嚴格大於目前版本（拒絕重放舊的已簽包與降版）。
5. 解壓到 `<安裝目錄>/update/staging/`。
6. **更新前自我檢查**：`manifest.json` 為合法 JSON，且 `key` 與目前相同（識別碼不得改變，否則 Native Messaging 白名單會失效）；用目前的 Python 直譯器在子行程中匯入 staging 的 host 確認可載入。
7. **替換**：把現有 `host/` 與 `extension/` 移到 `<安裝目錄>/backup/<目前版本>/`，再把 staging 的對應資料夾移進來。整個資料夾改名失敗時（例如 Windows 檔案被占用），改成逐檔覆蓋；任何一步失敗都從備份還原並回報 `rolledBack: true`。
8. 只保留上一版的備份；清除 staging。
9. 回報 `update_applied`。面板隨即呼叫 `chrome.runtime.reload()`；舊 host 行程在連線關閉後結束，下次啟動使用新程式碼。

**已知限制（如實說明）**：若新版通過自我檢查卻在實際啟動時失敗，擴充功能無法自行還原（損壞的是 host 本身）。處理方式：重新執行最新的安裝檔，或把 `backup/<版本>/` 的內容手動複製回去，README 會說明。

## 6. 側邊面板

- 標題旁：有新版時顯示「有新版本 vX.Y.Z」徽章，點擊捲到更新卡片。
- 「設定與工具」新增「版本與更新」區：目前版本、最新版本、`檢查更新`、有新版時的 `立即更新` 與更新說明。
- 自動檢查：面板開啟且已啟動時檢查，兩次之間至少間隔 6 小時（時間戳存在 `chrome.storage.local`）；手動按鈕不受限制。
- 更新中：顯示「下載中 → 驗證中 → 安裝中 → 重新載入中」；有下載工作進行中時停用更新鈕。
- 擴充功能無法確認自己是否來自安裝目錄時，不顯示 `立即更新`，改顯示第 2 節的搬家提示。
- 所有來自 Release 的文字（版本、說明）一律以 `textContent` 顯示。

## 7. 安全

| 威脅 | 對策 |
|---|---|
| Release 檔案被竄改、網路中間人 | Ed25519 簽章驗證；公鑰內建 |
| 重放舊的已簽包、降版 | 版本必須與標籤相同且嚴格大於目前版本 |
| 惡意 zip（路徑逃逸、符號連結） | 路徑與類型白名單、數量與大小上限 |
| 更新後識別碼改變導致連不上 | 自我檢查要求 manifest `key` 不變 |
| 把更新來源導向其他伺服器 | 倉庫與網域固定；就算改 API 位址，沒有簽章仍會被拒 |
| 憑證驗證失敗（例如部分 Mac 的 Python） | 顯示明確錯誤與處理說明；永不關閉驗證 |

**殘餘風險（使用者已選擇的方案）**：私鑰存在 GitHub Actions secret。能修改 workflow 或取得 secret 的人（例如 GitHub 帳號被盜）仍可簽出惡意更新。若要排除這個風險，需改為離線簽章（每次發版多一步手動操作）。

**Python 標準函式庫沒有 Ed25519**：驗證端以純 Python 實作 RFC 8032 的簽章驗證（約 60 行，只做驗證不做簽章），以官方測試向量與 `cryptography` 套件產生的簽章交叉驗證。簽章端（只在 CI 與測試）使用 `cryptography`。

## 8. 測試與驗證

**可在開發環境測試**
- Ed25519 驗證：RFC 8032 官方測試向量；與 `cryptography` 隨機產生的金鑰、訊息交叉驗證；竄改訊息、竄改簽章、長度錯誤皆被拒。
- 版本比較、標籤與版本一致性。
- zip 安全檢查：`..`、絕對路徑、符號連結、非預期最上層項目、過大。
- 更新流程整合測試（本機 HTTP 假伺服器模擬 GitHub API 與附件）：成功替換並留下備份；錯誤簽章、版本不更新、`key` 被改、新 host 無法匯入、替換中途失敗，皆不留下半套檔案且已還原。
- `make_release.py`：zip 內容、簽章可被 host 驗證、版本一致性檢查。
- 面板端對端測試（假更新伺服器）：出現徽章與說明、更新進度、`update_applied` 後擴充功能重新載入、非安裝目錄時顯示搬家提示。

**無法在開發環境驗證（需要使用者）**
- 真實 GitHub Actions 的執行、真實 Release 的建立與下載。
- Windows／Mac 真機上的資料夾替換與檔案占用行為。
- Chrome 在真機上重新載入未封裝擴充功能。

## 9. 使用者要做的一次性設定

1. 在 GitHub 把 repo 改成公開。
2. 在本機執行 `python tools/gen_update_key.py`，把印出的私鑰設為 repo secret `UPDATE_SIGNING_KEY`，並提交寫入的公鑰。
3. 推第一個版本標籤，確認 Release 與附件出現。
4. 依 README 冒煙測試：從新安裝檔安裝 → 發一個更高版本 → 面板一鍵更新。

## 10. 成功標準

1. 從 Release 的安裝檔安裝後，擴充功能能從 `<安裝目錄>/extension` 載入並正常運作。
2. 發佈更高版本後，面板在開啟時顯示新版本徽章與說明；按「立即更新」後，擴充功能與 host 都換成新版並重新載入。
3. 簽章錯誤、版本不更新、識別碼被改、新版無法匯入、替換中途失敗的更新都不會改動現有安裝。
4. 有下載工作進行中時不會更新。
5. 第 8 節標明的「無法在開發環境驗證」的項目，由使用者依第 9 節冒煙測試確認，開發端不宣稱已驗證。
