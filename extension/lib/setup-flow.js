// The web page's setup flow as plain functions: which step is where, whether the install works, what to tell the
// person when it does not. The page only draws what these return. See the setup-flow tests.
import { UPDATE_REPO } from "./update-config.js";
import { versionNotice } from "./connection.js";

const SAFE = /^[A-Za-z0-9._-]+$/;

// What a Mac person pastes into Terminal: no download, so macOS's Gatekeeper never gets involved.
export function macInstallUrl(repo = UPDATE_REPO) {
  const parts = [repo.owner, repo.repo, repo.branch];
  if (!parts.every((part) => typeof part === "string" && SAFE.test(part) && part !== "." && part !== "..")) {
    throw new Error("invalid repository settings for the install command");
  }
  return `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${repo.branch}/extension/installers/install-mac.sh`;
}

export const macInstallCommand = (repo = UPDATE_REPO) => `curl -fsSL ${macInstallUrl(repo)} | bash`;

// ---------------- which computer, and the folder to suggest ----------------

export function detectOs(nav = globalThis.navigator) {
  const platform = String(nav?.userAgentData?.platform ?? nav?.platform ?? "");
  const agent = String(nav?.userAgent ?? "");
  if (/mac/i.test(platform) || /Macintosh/i.test(agent)) return "mac";
  if (/win/i.test(platform) || /Windows/i.test(agent)) return "win";
  return "other";
}

// A visible folder in the person's home, written the way each system's folder window understands.
const FOLDER = "YT批量下載器擴充功能";
export const defaultFolder = (os) => (os === "mac" ? `~/${FOLDER}` : os === "win" ? `%USERPROFILE%\\${FOLDER}` : FOLDER);

export function folderHint(os) {
  const make = "沒有這個資料夾的話，在選取視窗裡按「新增資料夾」建立。";
  if (os === "mac") return `在選取資料夾的視窗按 Cmd+Shift+G，貼上這個路徑再按 Enter。${make}`;
  if (os === "win") return `在選取資料夾視窗的網址列貼上這個路徑再按 Enter。${make}`;
  return `在你方便找到的地方建立一個空的資料夾（建議取名 ${FOLDER}）。選取視窗裡可以按「新增資料夾」。`;
}

// ---------------- the steps, and whether it works ----------------

// "done" | "now" | "todo" for the four steps: write the files, load them in Chrome, install the host, connect.
export function stepStates({ detected, wroteFiles, status }) {
  const running = status.state === "running";
  const installed = running || status.state === "forbidden" || (status.state === "stopped" && Boolean(status.detail));
  const done = [detected || wroteFiles, detected, detected && installed, detected && running];
  const current = done.indexOf(false);
  return done.map((isDone, index) => (isDone ? "done" : index === current ? "now" : "todo"));
}

// Everything a download needs is there: the extension (not older than this page), a current host that runs, and its parts.
export function isDeployed({ detected, status, hostOutdated, extensionVersion, pageVersion }) {
  if (!detected || status?.state !== "running" || hostOutdated) return false;
  if (versionNotice({ extensionVersion, pageVersion })) return false;
  const ready = status.ready ?? {};
  return Boolean(ready.ytdlpVersion) && ready.ffmpegOk === true && ready.jsRuntimeOk === true;
}

// ---------------- the self-check screen ----------------

const REINSTALL = "重新執行安裝檔（它會自動檢查並修復，最後列出哪一項有問題）";
const item = (id, status, title, detail = "", fix = "") => ({ id, status, title, detail, fix });

function hostItem({ status, hostOutdated, gaveUp }) {
  if (status.state === "running") {
    return hostOutdated
      ? item("host", "error", "本機小程式版本太舊，現在無法下載", "", `${REINSTALL}，或在側邊面板「版本與更新」按「更新」`)
      : item("host", "ok", `本機小程式已連線${status.ready?.hostVersion ? `（v${status.ready.hostVersion}）` : ""}`);
  }
  if (status.state === "not_installed") return item("host", "error", "尚未安裝本機小程式", "", "執行安裝檔（步驟 3）：Mac 貼一行指令，Windows 下載後雙擊");
  if (status.state === "forbidden") {
    return item("host", "error", "Chrome 拒絕連線本機小程式（擴充功能識別碼與安裝檔不符）", "", "重新下載安裝檔並再執行一次（步驟 3）");
  }
  if (gaveUp) return item("host", "error", "本機小程式啟動後馬上又關閉了", status.detail ?? "", REINSTALL);
  return item("host", "warn", "正在連線本機小程式…", status.detail ?? "", "等幾秒；一直連不上就" + REINSTALL);
}

function partItems(ready) {
  return [
    ready.ytdlpVersion ? item("engine", "ok", `下載引擎 yt-dlp ${ready.ytdlpVersion}`) : item("engine", "error", "找不到下載引擎（yt-dlp）", "", REINSTALL),
    ready.ffmpegOk ? item("ffmpeg", "ok", "ffmpeg 可以使用") : item("ffmpeg", "error", "找不到 ffmpeg（合併影片與聲音需要）", "", REINSTALL),
    ready.jsRuntimeOk ? item("deno", "ok", "Deno 可以使用") : item("deno", "error", "找不到 Deno（YouTube 解題需要）", "", REINSTALL),
  ];
}

// What the person sees when it does not work: every part, green or not, with the way forward. `doctor` is the host's own
// environment report (see host/doctor.py), used instead of the quick look at the host's ready message when there is one.
export function selfCheckItems({ detected, everDetected, extensionVersion, pageVersion, status, hostOutdated, gaveUp, doctor }) {
  if (!detected) {
    return [everDetected
      ? item("extension", "error", "與擴充功能的連線中斷", "", "到 chrome://extensions 確認它已啟用；恢復後這裡會自動連上，也可以重新整理本頁")
      : item("extension", "error", "還沒偵測到擴充功能", "", "到步驟 1、2：把擴充功能寫入資料夾，再到 Chrome 載入（這個網頁需要電腦版 Chrome）")];
  }
  const list = [item("extension", "ok", `擴充功能${extensionVersion ? ` v${extensionVersion}` : "已偵測到"}`)];
  if (versionNotice({ extensionVersion, pageVersion })) {
    list.push(item("version", "error", `擴充功能 v${extensionVersion} 比網頁版 v${pageVersion} 舊，還在跑舊版`, "",
      "到步驟 1 重新寫入檔案，再到 chrome://extensions 按這個擴充功能的重新載入"));
  }
  list.push(hostItem({ status, hostOutdated, gaveUp }));
  if (status.state === "running") {
    list.push(...(Array.isArray(doctor) && doctor.length ? doctor.map((c) => item(c.id, c.status, c.title, c.detail, c.fix)) : partItems(status.ready ?? {})));
  }
  return list;
}

// ---------------- when the window opens ----------------

export const FIRST_SHOW_DELAY_MS = 1200; // a working install is not flashed at on its first visit
export const SETTLE_MS = { extension: 3500, host: 8000 }; // time to find the extension, then to start the host

// "setup" (the step by step window), "check" (the self-check) or "hidden".
export function decideView({ firstVisit, deployed, detected, sinceLoadMs, dismissed = false }) {
  if (deployed || dismissed) return "hidden";
  if (firstVisit) return sinceLoadMs >= FIRST_SHOW_DELAY_MS ? "setup" : "hidden";
  return sinceLoadMs >= (detected ? SETTLE_MS.host : SETTLE_MS.extension) ? "check" : "hidden";
}
