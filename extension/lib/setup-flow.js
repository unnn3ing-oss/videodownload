// The web page's setup flow as plain functions: which step is where, whether the install works, what to tell the
// person when it does not. The page only draws what these return. See the setup-flow tests.
import { UPDATE_REPO } from "./update-config.js";
import { REINSTALL_ACTION, hostVersionNotice, versionNotice } from "./connection.js";

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

// The folder is made by the person, so it is only a name to type or paste (it does not exist yet, so a path would lead nowhere).
export const FOLDER_NAME = "YT批量下載器";
export const FOLDER_HINTS = [
  "在下一步的選取視窗按「新增資料夾」，貼上這個名稱就好。瀏覽器不能替你預先填好名稱，所以才做了複製按鈕。",
  "也可以直接選一個已經有東西的資料夾：我會在裡面自動建立同名的資料夾，不會動到其他檔案。Chrome 可能不允許直接選「下載」「文件」「桌面」本身，請選它們裡面的資料夾。",
];

// ---------------- the steps, and whether it works ----------------

export const STEP_LABELS = ["下載安裝檔", "執行安裝檔", "載入插件", "完成"];

const hostInstalled = (status) => status.state === "running" || status.state === "forbidden" || (status.state === "stopped" && Boolean(status.detail));

// "done" | "now" | "todo" for each step, and the number (1-4) of the step to show: the first one that is not done.
// A web page cannot see whether the installer ran; it can see the host once the extension is there, and it knows when the
// person moved past those steps (`passedInstaller`).
export function wizardSteps({ detected, passedInstaller = false, status, deployed }) {
  const ranInstaller = (detected && hostInstalled(status)) || passedInstaller;
  const done = [ranInstaller, ranInstaller, detected, Boolean(detected && deployed)];
  const first = done.indexOf(false);
  return {
    states: done.map((isDone, index) => (isDone ? "done" : index === first ? "now" : "todo")),
    suggested: first === -1 ? STEP_LABELS.length : first + 1,
  };
}

// The line on the last step: where the connection stands, and whether that is good.
export function connectSummary({ detected, deployed, status }) {
  if (deployed) return { ok: true, text: "一切正常，已經連線" };
  if (!detected) return { ok: false, text: "還沒偵測到擴充功能（步驟 1～3）" };
  if (status.state === "running") return { ok: false, text: "小程式已連線，但還有地方需要處理：按右上角的「自我檢查」" };
  return { ok: false, text: "還沒連上本機小程式（步驟 2）" };
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
// The page's 「更新到最新版」 button only does something once an update was found: offered as an extra, and only then.
const buttonExtra = (updateAvailable, note = "") => (updateAvailable ? `；也可以改按頁面左側「版本與更新」的「更新到最新版」${note}` : "");

function hostItem({ status, hostOutdated, gaveUp, updateAvailable }) {
  if (status.state === "running") {
    return hostOutdated
      ? item("host", "error", "本機小程式版本太舊，現在無法下載", "", `${REINSTALL}${buttonExtra(updateAvailable)}`)
      : item("host", "ok", `本機小程式已連線${status.ready?.hostVersion ? `（v${status.ready.hostVersion}）` : ""}`);
  }
  if (status.state === "not_installed") return item("host", "error", "尚未安裝本機小程式", "", "執行安裝檔（步驟 1、2）：Mac 貼一行指令，Windows 下載後雙擊");
  if (status.state === "forbidden") {
    return item("host", "error", "Chrome 拒絕連線本機小程式（擴充功能識別碼與安裝檔不符）", "", "重新下載安裝檔並再執行一次（步驟 1、2）");
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
// `updateAvailable`: the 「更新到最新版」 button on the page can be pressed right now (an update was found and can be applied).
export function selfCheckItems({ detected, everDetected, extensionVersion, pageVersion, status, hostOutdated, gaveUp, doctor, updateAvailable = false }) {
  if (!detected) {
    return [everDetected
      ? item("extension", "error", "與擴充功能的連線中斷", "", "到 chrome://extensions 確認它已啟用；恢復後這裡會自動連上，也可以重新整理本頁")
      : item("extension", "error", "還沒偵測到擴充功能", "", "照步驟 1～3：下載並執行安裝檔、載入插件（這個網頁需要電腦版 Chrome）")];
  }
  const list = [item("extension", "ok", `擴充功能${extensionVersion ? ` v${extensionVersion}` : "已偵測到"}`)];
  if (versionNotice({ extensionVersion, pageVersion })) {
    list.push(item("version", "error", `擴充功能 v${extensionVersion} 比網頁版 v${pageVersion} 舊，還在跑舊版`, "",
      `關閉這個視窗，${REINSTALL_ACTION}${buttonExtra(updateAvailable, "（會自動重新載入）")}`));
  }
  list.push(hostItem({ status, hostOutdated, gaveUp, updateAvailable }));
  const hostVersion = status.state === "running" ? status.ready?.hostVersion : null;
  if (hostVersionNotice({ extensionVersion, hostVersion })) {
    list.push(item("hostVersion", "error", `本機小程式 v${hostVersion} 和擴充功能 v${extensionVersion} 版本不一致`, "",
      `${REINSTALL_ACTION}${buttonExtra(updateAvailable)}`));
  }
  if (status.state === "running") {
    list.push(...(Array.isArray(doctor) && doctor.length ? doctor.map((c) => item(c.id, c.status, c.title, c.detail, c.fix)) : partItems(status.ready ?? {})));
  }
  return list;
}

// ---------------- when the window opens ----------------

export const FIRST_SHOW_DELAY_MS = 1200; // a working install is not flashed at on its first visit
export const SETTLE_MS = { extension: 3500, host: 8000 }; // time to find the extension, then to start the host

// "setup" (the step by step window), "check" (the self-check) or "hidden". `unhealthyMs`: how long it has not been working
// (since the page loaded, or since it stopped working), so a short hiccup never pops a window up.
export function decideView({ firstVisit, deployed, detected, unhealthyMs, dismissed = false }) {
  if (deployed || dismissed) return "hidden";
  if (firstVisit) return unhealthyMs >= FIRST_SHOW_DELAY_MS ? "setup" : "hidden";
  return unhealthyMs >= (detected ? SETTLE_MS.host : SETTLE_MS.extension) ? "check" : "hidden";
}
