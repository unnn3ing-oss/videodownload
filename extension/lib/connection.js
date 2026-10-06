import { versionAtLeast } from "./version.js";

// What the web page says about its connection to the extension and the local host, and when it should keep
// asking the extension to launch the host. Plain functions: the page only draws what they return.

export const EXTENSION_MISSING_TEXT = "還沒偵測到擴充功能。請先照設定流程的步驟 1～4 部署並載入；完成後這裡會自動解鎖，不用重新整理。這個網頁需要 Chrome（電腦版）。";
export const EXTENSION_LOST_TEXT = "與擴充功能的連線中斷（它可能被停用、重新載入或移除）。請到 chrome://extensions 確認它已啟用；恢復後這裡會自動解鎖，也可以重新整理本頁。";

export function extensionNotice({ detected, everDetected }) {
  if (detected) return null;
  return everDetected ? EXTENSION_LOST_TEXT : EXTENSION_MISSING_TEXT;
}

// { kind, text } about the local host, or null when there is nothing to say. `wasRunning`: it was connected
// earlier in this page session; `gaveUp`: automatic launching stopped (see createAutoConnect).
export function hostNotice({ detected, status, wasRunning, gaveUp }) {
  if (!detected || status.state === "running") return null;
  if (status.state === "forbidden") {
    return { kind: "error", text: "Chrome 拒絕連線本機小程式（擴充功能識別碼與安裝檔不符）。請重新下載安裝檔並再執行一次。" };
  }
  if (gaveUp) {
    return { kind: "error", text: "本機小程式啟動後馬上又關閉了，自動重試幾次都失敗。請重新執行安裝檔（它會自動檢查並修復，最後列出哪一項有問題），再按步驟 6 的「啟動」重試。" };
  }
  if (wasRunning) return { kind: "info", text: "與本機小程式的連線中斷，下載已暫停。正在嘗試重新連線…" };
  return null;
}

// The page and the extension come from the same repository, so an extension older than the page was probably not
// reloaded (or was written into another folder) after the files were updated.
export function versionNotice({ extensionVersion, pageVersion }) {
  const known = (version) => Boolean(version) && versionAtLeast(version, "0");
  if (!known(extensionVersion) || !known(pageVersion) || versionAtLeast(extensionVersion, pageVersion)) return null;
  return `網頁版是 v${pageVersion}，但你的擴充功能是 v${extensionVersion}，還在跑舊版。請到步驟 2 重新取得檔案，再到 chrome://extensions 按這個擴充功能的重新載入。`;
}

// Once the extension is there the page keeps asking it to launch the host until it answers: the person may still
// be running the installer. A host that is launched and closes right away is not retried forever, though: every
// new "stopped" report that follows one of our requests is a launch that ended, and `maxTries` of them end the
// retrying. A host that is merely slow to start sends no new report, so it is never taken for a failing one.
export function createAutoConnect({ maxTries = 5 } = {}) {
  let asked = 0; // requests sent since the last reset
  let failures = 0; // launches that ended
  let lastReport = null;
  const reset = () => {
    asked = 0;
    failures = 0;
    lastReport = null;
  };
  return {
    next(detected, status) {
      if (!detected || status.state === "forbidden") return { send: false, gaveUp: false };
      if (status.state === "running") {
        reset();
        return { send: false, gaveUp: false };
      }
      if (status.state === "stopped") {
        if (status !== lastReport) {
          lastReport = status;
          if (asked > 0) failures += 1;
        }
        if (failures >= maxTries) return { send: false, gaveUp: true };
        asked += 1;
      }
      return { send: true, gaveUp: false };
    },
    reset,
  };
}
