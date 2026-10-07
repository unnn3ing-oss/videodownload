# 發版流程（維護者用）

先講最重要的一件事：**擴充功能與下載助手都會從 `main` 分支自己更新**（網頁版與 Mac 一行指令也直接從 `main` 提供）。
更新沒有數位簽章，信任來源就是 `main` 本身。所以「能把東西推上 `main` 的人」＝「能在每位同事的電腦上執行程式碼的人」
（下載助手是以同事本人的身分在 Chrome 的沙盒之外執行的 Python）。這份文件的每一步都是為了讓這件事不會發生得太輕易、
也不會發生得太意外。

## 發版前一次看完：指令一覽

```bash
python3 tools/release.py bump 0.4.0     # 只改 manifest.json 與 host/version.py 兩處版本號
python3 build.py                        # 重新產生 extension/installers/（安裝檔內嵌 host 與擴充功能）
python3 -m pytest -q                    # Python 測試
node --test extension/tests/*.test.mjs  # 擴充功能測試（含擴充功能識別碼釘選）
npm ci && npm run test:e2e              # 端對端測試，需要 Chromium，見 docs/TESTING.md
python3 tools/release.py check          # 發版檢查表，每行 PASS／FAIL，有 FAIL 就不要往下
```

`tools/release.py` 只用標準函式庫、不連網、不會推送任何東西；`bump` 只會印出後面要你自己執行的 git 指令。
沒有 CHANGELOG 要維護。

## 步驟

1. **改版本號**：`python3 tools/release.py bump X.Y.Z`。
   版本必須是純 `x.y.z`（只有數字），而且比目前的大。它只改兩處：`extension/manifest.json` 的 `version` 與
   `host/version.py` 的 `VERSION`（兩者必須相同，測試也會檢查）。
   **絕對不要動 `manifest.json` 的 `key`**：擴充功能識別碼 `mimlajbhpiphbndalphgmkdehgclnglg` 是由它算出來的，
   每台電腦上的 Chrome 登錄檔只允許這個識別碼；識別碼一變，所有已安裝的複本都會失去與下載助手的連線
   （「Chrome 拒絕連線」），自動更新也救不回來，每個人都得手動重裝。`extension/tests/extension-id.test.mjs` 會擋下這件事。
2. **重新建置**：`python3 build.py`，並把 `extension/installers/` 一併提交（安裝檔內嵌了 host 與擴充功能，忘了建置就會發出舊程式）。
3. **跑 Python 與 Node 測試**（上面的兩行）。
4. **跑端對端測試**：`npm ci && npm run test:e2e`（六個 suite 依序執行；需要 UTF-8 語系，見 docs/TESTING.md）。
5. **跑發版檢查**：`python3 tools/release.py check`。它確認：兩處版本相同且是 x.y.z、已提交的安裝檔和重新建置的結果
   逐位元組相同、工作目錄除了要發的檔案（版本號與安裝檔）之外是乾淨的、擴充功能識別碼釘選測試通過。有任何 FAIL 就先處理。
6. **提交並推送分支**（不要直接推 `main`）：
   ```bash
   git add extension/manifest.json host/version.py extension/installers
   git commit -m "release: vX.Y.Z"
   git push origin <你的分支>
   ```
7. **開 Pull Request，等 CI 全綠**。CI（`.github/workflows/ci.yml`）只在 Pull Request 與推送到 `main` 時執行；
   只推分支而沒開 Pull Request 不會觸發 CI。需要時也可以在 Actions 頁面手動執行 `ci`（Run workflow）。
   必須全綠：`linux (3.9)`、`linux (3.12)`、`node`、`build-fresh`、`e2e`、`windows`、`macos`。
8. **併入 `main`**：在 GitHub 合併這個 Pull Request。**從這一刻起，所有同事的擴充功能與下載助手最多 6 小時內就會開始更新**
   （或他們按「檢查更新」立即更新）。
   - 已套用 `保護 main` 的規則集之後，只能用 Pull Request 合併（直接推 `main` 會被擋下）。
   - 還沒套用規則集、而且你是唯一的維護者時，也可以在本機快轉：
     `git fetch origin && git merge-base --is-ancestor origin/main HEAD && git push origin HEAD:main`
     （若 `main` 不是你分支的祖先，指令會停下來，不會硬推。）
9. **打標籤**（標在 `main` 現在指向的那個提交上，方便日後回溯）：
   ```bash
   git fetch origin
   git tag -a vX.Y.Z -m "vX.Y.Z" origin/main
   git push origin vX.Y.Z
   ```
10. **真機檢查**（CI 做不到的部分，見 docs/TESTING.md）：
    - **Windows**：乾淨的使用者帳號（或虛擬機）用單檔安裝檔安裝一次；再在已安裝的電腦上按「檢查更新」確認能更新到新版。
      留意防毒軟體與公司網路（代理、憑證攔截）。
    - **Mac**（Intel 與 Apple Silicon 各一台更好）：用一行指令或 `install-mac.zip` 安裝；確認 Chrome 能啟動下載助手、
      下載一支影片並合併成功。
    - 都要確認：擴充功能與下載助手的版本號相同（側邊面板不會出現「版本不一致」警告）。

## 更換外部元件的版本（Deno、ffmpeg、Python）

安裝檔下載的元件都固定了版本，而且下載後先核對 SHA-256，不符就丟棄、不安裝：

| 元件 | 位置 | 怎麼核對 |
|---|---|---|
| Deno（Windows、Mac 兩種晶片） | `host/installer.py` 的 `DENO_VERSION`、`URL`、`PINS` | 寫死的 SHA-256 |
| ffmpeg（Mac 兩種晶片） | 同上 | 寫死的 SHA-256 |
| ffmpeg（Windows） | 同上 | BtbN 只提供滾動的 `latest`，所以和同一個 release 的 `checksums.sha256` 核對（防的是下載不完整或被中途改過，不是上游本身被入侵） |
| Python（Windows 內嵌版） | `build.py` 的 `DEPS` | 寫死的 SHA-256，由 `.cmd` 在解開前核對 |
| yt-dlp | `host/winengine.py`、`host/macos_engine.py` | 和官方 `SHA2-256SUMS` 核對 |

換版本時，網址和 SHA-256 要一起改（`sha256sum` 自己下載的檔案算出來），再跑 `python3 build.py` 重新產生安裝檔。`tests` 會檢查每個固定下載都有 64 位數的雜湊、網址不是 `latest`。

## 更新出問題時怎麼辦

目標只有一個：**讓 `main` 回到好的內容，同事的電腦會自己跟著回來。**

更新是用「內容」比對的：擴充功能把 `main` 上每個檔案的 git blob SHA 與自己本地的檔案比，不一樣就更新。
所以只要 `main` 上的內容回到好的狀態，已經更新到壞版本的電腦下一次檢查時就會被改回來，還沒更新的電腦則什麼都不會發生。

1. **立刻止血：還原，不要重寫歷史。**
   ```bash
   git fetch origin
   git checkout -b revert-vX.Y.Z origin/main
   git revert <壞的提交>          # 有多個提交就一個一個還原（合併提交用 git revert -m 1 <合併提交>）
   python3 build.py              # 安裝檔要跟還原後的程式一致
   python3 tools/release.py check
   git push origin revert-vX.Y.Z  # 開 Pull Request，等 CI，合併
   ```
   緊急而且 CI 要等很久時，擁有者可以暫時用最短的路：只做 `git revert` 並直接合併；但仍然要補跑 `build.py`、測試與 CI。
   **不要 `git reset --hard` 加強制推送**：規則集會擋下（也應該擋），而且重寫已公開的歷史會讓大家的比對基準亂掉。
2. **還原後再升一個版本號**（例如壞的是 0.4.0，還原後發 0.4.1）：讓版本號對應唯一的內容，也讓側邊面板的版本檢查有意義。
   走完整的發版流程即可。
3. **不要把舊版的安裝檔或舊版的 host 檔案發給同事「降版本」。**
   - 更新機制以 `main` 為準：手動換上的舊檔案，下一次檢查就會被 `main` 上的內容再次覆蓋，中間還會出現擴充功能與下載助手
     版本不一致的狀態。
   - 安裝檔與 host 會寫入狀態檔（安裝記錄 `install.json`、紀錄檔、更新備份等），這些格式會隨版本改變；
     「舊程式讀新格式」沒有任何測試涵蓋，不應該靠人手去冒這個險。
   - 舊安裝檔還會把舊的擴充功能一起寫回資料夾。要修就修在 `main`。
   - 0.4.0 起的安裝檔會先比對版本：電腦上已經是較新的版本時，不會解壓縮覆蓋，只做檢查與修復。**0.4.0 以前的安裝檔沒有這道保護**，
     仍然會降版，所以舊的安裝檔檔案不要再流傳（需要的人請重新下載目前 `main` 上的安裝檔）。
4. 已經有人壞到無法自動更新（例如下載助手連不上）時，才請他重新執行**目前 `main` 上**的安裝檔（重新執行就是修復）。
5. 事後：把原因與修正寫進提交說明；如果是 CI 沒擋住的類型，補一個測試。

## 保護 main

CI 擋得住失誤，擋不住惡意：任何能推送 `main` 的人，仍然能讓所有同事的電腦執行他寫的程式碼。
GitHub 的分支規則集（ruleset）與雙重驗證只是把門關上、上鎖，**無法**讓這個信任模型變安全：
repo 的管理員可以改規則集，帳號被盜的人也能照樣合併。實際的防線是：

- 能推送 `main` 的人越少越好（Settings → Collaborators and teams：只給真正要發版的人 Write 以上的權限）。
- 這些人的 GitHub 帳號都要啟用雙重驗證（建議用 passkey 或安全金鑰）。
- 合併前，真的看過 `host/`、`extension/` 的差異（尤其是新增的網路位址、`subprocess`、`eval`、新的權限）。
- 有兩位以上維護者時，要求至少一位核准（下方 required approvals 設 1）。

### 要手動套用的設定（只有 repo 擁有者能做）

**一、`main` 分支的規則集**：repo → Settings → Rules → Rulesets → New ruleset → **New branch ruleset**

| 欄位 | 設定 |
| --- | --- |
| Ruleset Name | `protect-main` |
| Enforcement status | **Active** |
| Bypass list | **留空**（把自己加進去，保護對你自己就不存在） |
| Target branches | Add target → Include default branch（或 Include by pattern：`main`） |
| Restrict deletions | 勾選 |
| Block force pushes | 勾選 |
| Require a pull request before merging | 勾選。Required approvals：只有你一個維護者時設 0（自己不能核准自己的 PR），有兩位以上時設 1；建議勾「Dismiss stale pull request approvals when new commits are pushed」 |
| Require status checks to pass | 勾選，並勾「Require branches to be up to date before merging」。Add checks（來源選 GitHub Actions）：`linux (3.9)`、`linux (3.12)`、`node`、`build-fresh`、`e2e`、`windows`、`macos` |

注意：
- 檢查名稱要先讓 CI 在這個 repo 跑過至少一次，才會出現在可選的清單裡（過去 7 天內執行過的才會列出）。
  `linux` 工作用了 Python 版本矩陣，所以實際的檢查名稱是 `linux (3.9)` 與 `linux (3.12)`，兩個都要加。
- **不要**把 `canary`（每晚的外部世界檢查）加進必要檢查：它故意不擋合併。
- 這個規則集一啟用，直接推送 `main` 就會被擋下（包含快轉推送）；之後一律走 Pull Request。

**二、標籤規則集**（避免版本標籤被改寫或刪除）：Settings → Rules → Rulesets → New ruleset → **New tag ruleset**，
名稱 `protect-tags`，Enforcement **Active**，Target tags：Include by pattern `v*`，勾選 Restrict deletions 與 Block force pushes。

**三、雙重驗證**
- 個人帳號：GitHub 右上角頭像 → Settings → Password and authentication → Two-factor authentication。每一位有推送權限的人都要做。
- 若 repo 屬於組織：組織的 Settings → Authentication security → **Require two-factor authentication for everyone in your organization**。

**四、GitHub Pages**（網頁版）：Settings → Pages，來源選 `main` 分支、根目錄（只需設定一次）。因為網頁版也直接從 `main` 提供，
上面的保護同樣適用。

**五、Actions 權限**：Settings → Actions → General → Workflow permissions 選 **Read repository contents and packages permissions**
（`ci.yml` 與 `canary.yml` 本來就只要求 `contents: read`，這裡設成預設唯讀可以避免日後有人加的工作流程取得寫入權限）。
