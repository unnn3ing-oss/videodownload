# 批量下載清單與網頁版 設計規格

日期：2026-10-05　狀態：待使用者審閱

## 1. 目標與已確認事項

**目標**：把「貼網址 → 預覽 → 開始下載」改成「增加 → 排隊 → 依序下載」的批量清單，並提供與側邊面板同一份清單的網頁版（放在 GitHub Pages）。

**使用者已確認**
- 介面採設計稿 **C「控制台」**（左側設定流程＋右側密集清單）；側邊面板一起改。
- 按「增加」就在下方清單多一欄，欄位有預抓好的**影片標題**、**影片封面**、**X（從清單刪除）**。
- 「開始全部下載」依**加入順序（最早到最晚）**一支一支下載；每支之間有**冷卻間隔**；**即時進度**顯示在該支的欄位內。
- 網頁版要有「部署到 Chrome 插件」按鈕（照 QuickPatterntool）。部署完成後自動偵測並連線。
- **複製內文**：每列後方有按鈕，一鍵複製「`【影片標題】`＋換行＋說明欄前三個 hashtag」，例如：
  ```
  【影片標題文字】
  #標籤一 #標籤二 #標籤三
  ```
- **下載封面**：滑鼠移到封面縮圖上時，縮圖變成反灰並顯示下載符號，點一下就把該影片的**原尺寸**封面存到**影片的存放資料夾**，檔名是影片標題的**前六個字**，例如「颱風假放不放.jpg」。
- **封面依連線狀態自動切換**：擴充功能＋本機小程式都連線 → 存到影片的存放資料夾；只有擴充功能 → 用瀏覽器下載到「下載」資料夾（檔名規則相同）；完全沒有擴充功能 → 網頁版不提供下載功能，只顯示部署引導（純網頁無法可靠取得圖片，也抓不到標題與說明欄）。
- **重複影片**：清單裡網址（影片 ID）或影片標題相同的影片，後加入的那一筆顯示「重複下載」，暫停並略過（不會下載），避免同名影片互相覆蓋。
- 預設值：下載途中新增的影片自動接在後面；冷卻間隔預設 10 秒；拿掉「單支影片自訂檔名」欄位（檔名固定為影片標題）。
- 影片下載仍完全在使用者自己的電腦上（Chrome → 本機小程式 → yt-dlp → YouTube），GitHub 與網頁伺服器不參與。

**不在範圍**：每支重新命名、拖曳排序、單支暫停／續傳、同時多支下載（一律依序）、登入或 cookies、Chrome 以外的瀏覽器。

## 2. 架構：一份清單，三個畫面

```
網頁版 ──postMessage──▶ bridge.js(內容腳本) ──▶┐
側邊面板 ─────────runtime.sendMessage────────▶ background.js(清單的唯一保管者) ──native──▶ host.py ─▶ yt-dlp
                         ◀── queue_state 廣播 ──┘                                   ◀── 事件 ──┘
```

- **background.js** 保管清單（`chrome.storage.local` 的 `queue`，節流寫入），處理「增加、移除、重試、開始、停止、設定」，把本機小程式的事件翻成清單狀態，再廣播給所有畫面。
- **側邊面板與網頁版**只是兩個畫面：看到同一份清單與進度；關閉任何一個都不影響下載。
- 清單邏輯是純函式（`extension/lib/queue.js`），可單元測試；background 只負責接線與持久化。
- 本機小程式負責「依序下載＋冷卻」（見 §4），因此即使畫面關閉、背景程式休眠，一次下載工作仍會跑完。

### 清單狀態

```
queue = {
  items: [{ uid, id, url, title, duration|null, tags: string[]|null, status, dupOf|null, percent, speed, eta, file, height, error }],
  running: boolean,
  settings: { quality: 720|1080, cooldownSec: 3..60 (預設 10), limit: 1..1000 (預設 50) },
  cooldown: { until: epochMs, nextId } | null,
}
status ∈ fetching | waiting | downloading | done | skipped | failed
`dupOf`：重複判定的結果（見 §3），非 null 的項目一律顯示「重複下載」，不會被送去下載。
```
- 「冷卻中」不是獨立狀態：`cooldown.nextId` 指到的那一支顯示「冷卻中，N 秒後開始」。
- 封面不存檔：`https://i.ytimg.com/vi/<id>/mqdefault.jpg`，由畫面用 `<img>` 直接載入。
- 啟動時還原：背景程式重啟後，`downloading` 的項目退回 `waiting`（本機小程式隨之結束，下載會中止，重按開始即可從中斷處續傳）。

### 畫面 → 背景的訊息（兩個畫面共用）

`queue_get`、`queue_add {url}`、`queue_remove {uid}`、`queue_retry {uid}`、`queue_start`、`queue_stop`、`queue_copy_text {uid}`（回覆 `{ ok, text, tagCount }`）、`queue_download_cover {uid}`（回覆 `{ ok, file }` 或錯誤原因）、`settings_set {quality?, cooldownSec?, limit?}`；既有的 `start`（連線本機小程式）、`set_output_dir` 保留。背景程式廣播 `queue_state`（完整狀態，最多每 200 ms 一次）與既有的 `status`。

## 3. 增加、刪除、重試

- **增加**：背景程式立刻插入一列 `fetching`（骨架動畫），送 `resolve` 給本機小程式；回來後把該列換成實際的項目：單一影片 → 一列；播放清單或頻道 → 依 `limit` 展開成多列。重複的影片照樣加入清單，但依下面「重複判定」標示。解析失敗 → 該列變 `failed`（顯示原因，可刪可重試）。
- **標題與時長**：沿用 `resolve`；本機小程式額外回傳 `duration`（秒，抓不到則為 null）。
- **重複判定**（`queue.js` 的純函式，每次清單變動都重算）：
  - 兩支影片的**影片 ID 相同**，或**標題相同**（比對前先做 Unicode NFKC 正規化、去頭尾空白、不分大小寫），視為重複。同一網址貼兩次，解析後 ID 相同，也是重複。
  - 依清單順序，**最早的一筆保持正常**，之後每一筆重複的都標記 `dupOf = 最早那筆的 uid`：欄位顯示「重複下載」與「與第 N 筆相同，已暫停」，進度列隱藏，「開始全部下載」略過它。
  - 重複的列仍可刪除、也可複製內文與下載封面。若最早那筆被刪除，其餘重複者自動重算：下一筆變正常（回到 `waiting`），其餘仍標記為重複。
  - 資料夾裡早就下載過的影片，仍沿用既有的「已下載過，略過」，與這裡無關。
- **刪除（X）**：
  - 等待中／已完成／失敗 → 直接從清單移除。
  - 正在下載中 → 只中止**這一支**，工作繼續下一支（先冷卻）。
  - 執行中被移除的等待項目，也要從本機小程式的待辦移除（新訊息 `remove`，§4）。
- **重試**：失敗的列有「重試」，把它改回 `waiting`（執行中則同時 `enqueue`）。

## 3.5 列內動作：複製內文、下載封面

每列由左到右：封面（可點）｜序號與標題、進度、狀態｜複製內文｜X。

**複製內文**
- 格式：`【標題】` 換行 `#一 #二 #三`；標題取清單上的標題。說明欄沒有 hashtag 時只複製第一行，並提示「說明欄沒有 hashtag」；不足三個就有幾個複製幾個。
- hashtag 規則（純函式 `extension/lib/copytext.js`，可測）：在說明欄文字中依出現順序取前三個不重複的 `#` 開頭詞，接受中文、英文、數字、底線；網址裡的 `#` 片段（例如 `…/watch?v=x#t=30`）不算。
- 說明欄不在批量解析的資料裡，所以在**第一次按下時**才向本機小程式取得（新訊息 `meta`，§4），取回的 hashtag 存在該列（`tags`）供之後直接使用。取得需要幾秒，按鈕顯示「擷取中…」，完成後顯示「已複製」。
- 寫入剪貼簿使用「以 Promise 提供內容的 `ClipboardItem`」，這樣即使網路等待超過瀏覽器的使用者操作時效，網頁版仍能寫入；側邊面板另有 `clipboardWrite` 權限。本機小程式未連線時提示「請先連線本機小程式」。

**下載封面（依連線狀態分兩層）**
- 封面是 `<button>`：滑鼠移過（或鍵盤聚焦）時縮圖反灰並出現下載符號，點擊即下載，不影響整列。觸控裝置不顯示 hover，改為封面角落常駐一個小下載符號。
- 原尺寸圖片依序嘗試 `https://i.ytimg.com/vi/<id>/` 的 `maxresdefault.jpg`、`hq720.jpg`、`sddefault.jpg`、`hqdefault.jpg`，依序以 `GET` 請求，取第一個回應成功、檔頭為 JPEG 且不超過 5 MiB 的（YouTube 並非每支影片都有最高解析度，會自動退而求其次），再由**背景程式（Chrome 的網路）下載圖片位元組**（上限 8 MiB），以新訊息 `save_cover` 交給本機小程式，由小程式寫進**影片的存放資料夾**。小程式不自己連網，避免 Python 在 macOS 憑證、公司網路或代理下失敗。
- 需要新增 `https://i.ytimg.com/*` 的 `host_permissions`。本機小程式未連線時提示「請先連線本機小程式」；找不到任何封面時提示「找不到封面圖片」。
- **檔名規則**（`naming.py` 新增 `cover_name`）：
  1. 取影片標題，先去掉所有標點符號、符號與空白（Unicode 類別 P、S、Z），再取**前六個字**（以字元計，中英文都算一個字）。例如「颱風假放不放？氣象署最新預測」→「颱風假放不放」；「【獨家】直擊跨年」→「獨家直擊跨年」；不足六字就全取；去完是空的則改用影片 ID。
  2. 再套用既有的 `sanitize_filename`（非法字元、Windows 保留字、長度與路徑上限）。副檔名固定 `.jpg`。
  3. **同名衝突（影片資料夾）**：資料夾內隱藏檔 `.ytdl-covers.json` 記錄「影片 ID → 封面檔名」。同一支影片再次下載 → 覆蓋原檔；不同影片前六字相同 → 檔名加 `_2`、`_3`…。
- **第二層（本機小程式沒連線）**：背景程式改用 `chrome.downloads.download` 把同一張圖存到瀏覽器的「下載」資料夾，檔名同樣是「前六字.jpg」（`conflictAction: "uniquify"`，同名自動加序號），並提示「已存到下載資料夾；連線本機小程式後可存到影片資料夾」。這需要在 JavaScript 端有一份與 `naming.py` 相同的 `coverName`（`extension/lib/covername.js`），兩邊以**同一份測試資料**（`tests/fixtures/cover-names.json`）驗證輸出完全一致。
- **第三層（沒有擴充功能）**：網頁版不提供封面與複製內文（見 §5）。
- `save_cover` 的驗證：檔頭必須是 JPEG（`FF D8 FF`）、大小上限 5 MiB（base64 後仍須放得進一則 8 MiB 的原生訊息），路徑一律經 `safe_output_path`，存放資料夾不存在時自動建立。

## 4. 下載、冷卻與進度（本機小程式）

沿用既有 `download` 工作，做以下變更（本機小程式版本升為 0.2.0）：

| 訊息 | 說明 |
|---|---|
| `download { items, quality, cooldownSec }` | `cooldownSec`（0–300，缺省 2 以相容舊版）。每支「實際下載」之間等待冷卻；已下載過而略過的不冷卻。等待可被取消。 |
| `enqueue { items }` | 工作執行中，把新項目接到待辦尾端，回 `enqueued { count }`；沒有執行中的工作則回 `error not_running`，背景程式改送 `download`。 |
| `remove { itemId }` | 待辦中 → 移除；正在下載 → 只取消那一支並繼續；回 `removed`。 |
| `save_cover { id, title, data }` | `data` 為 base64 的 JPEG；依 §3.5 的檔名規則寫入存放資料夾，回 `cover_saved { file }`；格式或大小不符回 `error`。 |
| `meta { url }` | 取得單支影片的說明欄（`yt-dlp --skip-download --no-playlist --dump-json`），回 `meta { id, title, description }`；失敗回 `error`。在背景執行緒進行，不影響進行中的下載。 |
| `cancel`（既有） | 取消整個工作；背景程式把尚未完成的項目退回 `waiting`。 |

新事件：`cooldown { jobId, seconds, nextId }`（開始冷卻時送一次，畫面自己倒數）、`item_removed { itemId }`。既有的 `started`、`progress`、`item_done`、`item_failed`、`done` 不變。

實作要點：`JobRunner` 改用待辦佇列（加鎖），工作結束的判定與 `enqueue` 互斥，避免「剛好結束時新增」的競態；每支下載有自己的取消旗標，整體取消同時觸發。

背景程式的對應：
- `queue_start`：把所有 `waiting` 依序送出 `download`；`started` 後 `running = true`。
- `progress` → 該列 `downloading`＋百分比、速度、剩餘時間；`item_done` → `done`（`skipped` 則顯示「已下載過」）；`item_failed` → `failed`＋原因；`cooldown` → 設定 `queue.cooldown`；`done` → `running = false`、`cooldown = null`。
- 執行中新增 → `enqueue`；收到 `not_running` → 改送 `download`。
- 本機小程式版本低於 0.2.0（沒有冷卻與 `enqueue`）時，畫面提示「請先更新本機小程式」，並停用開始（更新機制已會一併更新）。

## 5. 網頁版

**位置**：repo 根目錄 `index.html` ＋ `web/`（樣式與腳本）＋ `.nojekyll`，以 GitHub Pages 從 `main` 根目錄發佈：`https://unnn3ing-oss.github.io/videodownload/`。啟用 Pages 由使用者在 repo Settings → Pages 操作一次。

**版面**：設計稿 C。左側「設定流程」時間軸（4 步）＋「下載設定」（解析度、冷卻間隔、存放資料夾、展開上限）；右側「增加」輸入列＋清單（共幾支、完成、速度、剩餘；冷卻中顯示「N 秒後開始第 X 支」）。窄螢幕時側欄移到上方。

**與擴充功能的橋接**（不使用 `externally_connectable`，避免網頁已開啟時裝擴充功能還要重新整理）：
- 擴充功能新增內容腳本 `bridge.js`，只注入 `https://unnn3ing-oss.github.io/videodownload/*`；`host_permissions` 加入該網址，新增 `scripting` 權限。
- 擴充功能安裝／重新載入（`onInstalled`）時，用 `chrome.scripting.executeScript` 把 `bridge.js` 注入已開啟的符合分頁，網頁不需重新整理（此行為為推論，需在真的 Chrome 驗證；若不成立，網頁偵測到橋接遺失時提示「請重新整理」）。
- 網頁 ↔ `bridge.js`：`window.postMessage`，檢查 `event.source === window` 與來源網址；`bridge.js` 只轉送白名單：`ping`、`queue_*`（含 `queue_copy_text`、`queue_download_cover`）、`settings_set`、`start`、`set_output_dir`、`deploy_installer`，其餘一律丟棄（`update_*` 只限側邊面板）。
- `bridge.js` 對背景程式開一條長連線（`chrome.runtime.connect`），背景程式把 `queue_state` 與 `status` 推給它，再轉給網頁。
- 信任模型：能控制 Pages 網址內容的人 ＝ 能推 `main` 的人，與自動更新相同；不接受 localhost 或其他來源。

**部署流程（網頁自動偵測）**：
1. 部署擴充功能（QuickPatterntool 做法）：「選擇資料夾並寫入」— 網頁用 GitHub API 取得 `main` 的檔案樹，逐檔以 blob SHA 驗證後寫入所選的**空資料夾或已是此擴充功能的資料夾**，`manifest.json` 最後寫入；或「改下載 ZIP」。沿用 `extension/lib` 的 `update-rules`、`gitsha`、`updater`（下載與驗證）。
2. 在 Chrome 載入：說明＋「複製 chrome://extensions」。網頁每 2 秒送 `ping`，擴充功能一出現就自動打勾。
3. 部署本機小程式：「下載安裝檔」→ 網頁送 `deploy_installer`，由背景程式依系統下載內建安裝檔（與側邊面板的「下載部署」共用同一段程式）。
4. 連線：偵測到擴充功能後，網頁每 3 秒自動送 `start` 嘗試連線本機小程式；安裝完成後即自動變成「已連線」，不必按「啟動」（按鈕保留為備用）。側邊面板開啟時也自動嘗試連線一次。

偵測不到擴充功能時，清單區顯示「請先部署擴充功能」的引導，不提供增加、下載、複製內文與封面。擴充功能已連線但本機小程式未連線時，「增加」仍可用（清單會標示「等待連線」），但「開始全部下載」與「複製內文」停用並說明原因，封面走第二層。

## 6. 側邊面板

- 以相同的清單列（較窄：封面 88 px，複製內文與 X 為圖示按鈕）取代現有「網址框＋預覽＋進度清單」；保留「目前分頁 → 加入」、狀態徽章、設定與工具、版本與更新。
- 拿掉：單支檔名欄位、「最多下載 N 支」輸入列（改在設定裡）、先前的預覽流程與 `viewRows`／`resolved` 邏輯；`progress.js` 的 `seedProgress`／`previewItems` 刪除，`overallProgress` 視需要保留。

## 7. 錯誤與邊界

- 沒有網路／YouTube 要求登入等：沿用既有的失敗原因文字，顯示在該列。
- 本機小程式中途斷線：`running = false`，未完成項目退回 `waiting`，畫面顯示「連線中斷」。
- 同一支影片（或標題相同的影片）重複加入：依 §3「重複判定」顯示「重複下載」並略過。
- 網址不是 YouTube：輸入列下方顯示錯誤，不加入。
- 清單上限 500 列；超過時拒絕新增並提示。

## 8. 測試

- **單元（node）**：`copytext.js`（hashtag 擷取：中英文、重複、不足三個、沒有、網址片段、標題格式）；封面網址挑選（以假 fetch 驗證順序與退而求其次）；檔名清理；`covername.js` 與 `cover_name`（共用 `tests/fixtures/cover-names.json`，兩邊輸出一致）；`queue.js`——重複判定（ID 相同、標題相同、NFKC 與大小寫、最早者保持正常、刪除最早者後重算、重複者不被送去下載）、增加與去重、解析展開、事件對應（進度、完成、略過、失敗、冷卻、結束）、開始的內容與順序、停止、移除（含下載中）、重試、重啟還原、清單上限。
- **本機小程式（pytest）**：冷卻（含可取消、略過不冷卻）、`enqueue`（含與結束的競態）、`remove`（待辦／下載中）、`cover_name`（前六字、標點與空白、不足六字、空白改用 ID、非法字元與保留字）、`save_cover`（成功、同一影片覆蓋、不同影片同名加序號、非 JPEG、過大、路徑逃逸）、`resolve` 回傳 `duration`、`meta`（成功、失敗、說明欄很長）、舊參數相容。
- **端對端（Playwright，沿用既有慣例）**：
  - 側邊面板：增加 → 骨架 → 標題與封面出現；刪除；開始 → 依序下載、冷卻倒數、列內進度；下載途中新增與刪除。
  - 網頁版（以 route 攔截讓本地檔案充當 Pages 網址）：偵測擴充功能、重新載入擴充功能後不需重新整理即重新連線、與側邊面板看到同一份清單、部署流程（OPFS 當資料夾、假的 GitHub）、窄寬度無橫向捲動。
  - 封面第二層：關閉本機小程式後點封面，瀏覽器下載出現「前六字.jpg」。
  - 複製內文：按下後剪貼簿內容符合格式（含「說明欄沒有 hashtag」的情況）；封面：滑鼠移上去時縮圖反灰並出現下載符號，點擊後圖片出現在存放資料夾（以假的 `i.ytimg.com` 回應驗證所選尺寸與檔名「前六字.jpg」）；重複：貼同一網址兩次，第二筆顯示「重複下載」且開始下載時不會被送出。
  - 假的下載引擎（`stub_ytdlp.py`）擴充：依網址的 `v=` 回傳不同影片 ID 與標題，並支援 `--dump-json` 回傳含 hashtag 的說明欄。

## 9. 尚未驗證（需使用者在真實環境確認）

- 真實 YouTube 的下載與冷卻效果、`duration` 欄位是否存在、說明欄的 hashtag 是否完整取得。
- 各影片實際有哪一種封面尺寸（最高解析度不一定存在）；`i.ytimg.com` 的圖片下載在真實 Chrome 的行為。
- 擴充功能安裝或重新載入後，對已開啟網頁的內容腳本注入、網頁是否免重新整理即偵測。自動測試只驗證了注入函式的邏輯與「重複注入不會讓回應加倍」；用 `--load-extension` 載入的擴充功能呼叫 `chrome.runtime.reload()` 後，這個 Chromium 會把它停用，無法端對端測試重新載入。
- GitHub Pages 實際啟用後的網址與行為；Chrome 資料夾選擇器的限制。
- 背景程式在長時間下載中是否持續存活（原生連線通常會維持其存活，屬推論）。

## 10. 使用者一次性設定

1. 在 GitHub repo 的 Settings → Pages，來源選 `main` 分支、根目錄。
2. 驗收後，把功能分支併入 `main`，同事即可由網頁版或 `main.zip` 取得，既有安裝者從面板更新。

## 11. 成功標準

1. 在側邊面板與網頁版按「增加」，清單出現含標題與封面的新列；X 可刪除。
2. 開始後依加入順序下載，欄位內即時顯示進度，每支之間依設定冷卻並顯示倒數。
3. 兩個畫面同時開啟時，清單與進度一致；關閉任一畫面不中斷下載。
4. 網頁版部署完成後，不需手動操作即顯示已連線。
5. 每列的「複製內文」得到 `【標題】` 加前三個 hashtag；滑鼠移到封面會反灰並顯示下載符號，點擊後原尺寸封面以「標題前六字.jpg」存進影片的存放資料夾。
6. 清單裡 ID 或標題相同的影片，後加入者顯示「重複下載」並被略過，不會產生同名檔案。
