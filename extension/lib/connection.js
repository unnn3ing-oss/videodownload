import { versionAtLeast } from "./version.js";

// What the web page says about its connection to the extension and the local host, and when it should keep
// asking the extension to launch the host. Plain functions: the page only draws what they return.

export const EXTENSION_MISSING_TEXT = "還沒偵測到擴充功能。請先照設定流程的步驟 1～3 安裝並載入；完成後這裡會自動解鎖，不用重新整理。這個網頁需要 Chrome（電腦版）。";
export const EXTENSION_LOST_TEXT = "與擴充功能的連線中斷（它可能被停用、重新載入或移除）。請到 chrome://extensions 確認它已啟用；恢復後這裡會自動解鎖，也可以重新整理本頁。";

// `updating`: an update is reloading the extension right now; the page says that itself, and "lost" would contradict it.
export function extensionNotice({ detected, everDetected, updating = false }) {
  if (detected || updating) return null;
  return everDetected ? EXTENSION_LOST_TEXT : EXTENSION_MISSING_TEXT;
}

// { kind, text } about the local host, or null when there is nothing to say. `wasRunning`: it was connected
// earlier in this page session; `gaveUp`: automatic launching stopped (see createAutoConnect).
export function hostNotice({ detected, status, wasRunning, gaveUp, updating = false }) {
  if (!detected || updating || status.state === "running") return null;
  if (status.state === "forbidden") {
    return { kind: "error", text: "Chrome 拒絕連線本機小程式（擴充功能識別碼與安裝檔不符）。請重新下載安裝檔並再執行一次。" };
  }
  if (gaveUp) {
    return { kind: "error", text: "本機小程式啟動後馬上又關閉了，自動重試幾次都失敗。請重新執行安裝檔（它會自動檢查並修復，最後列出哪一項有問題），再按設定流程最後一步的「啟動」重試。" };
  }
  if (wasRunning) return { kind: "info", text: "與本機小程式的連線中斷，下載已暫停。正在嘗試重新連線…" };
  return null;
}

// The one thing to do about a version problem that is always possible: the installer brings every part to the same version.
export const REINSTALL_ACTION = "重新執行安裝檔（Mac 貼上那一行指令，Windows 重新下載後雙擊）";

// The 「更新到最新版」 button only does something once an update was found (otherwise it is hidden or disabled), so it is
// offered as an extra, and only then. `updateAvailable`: the button can be pressed right now.
export const updateButtonExtra = (updateAvailable) => (updateAvailable ? "也可以改按「版本與更新」裡的「更新到最新版」。" : "");

// The side panel's update button: the first time (no folder chosen yet) it asks for the extension's folder.
export const PANEL_UPDATE_BUTTON = { pickFolder: "選擇擴充功能資料夾並更新", apply: "更新到最新版" };

// What the web page says next to a found update: where it can be applied. `info`: the extension's answer to "update_info".
export function updateAdvice(info, connected) {
  if (!info.canUpdateHere && !info.hostChecked) return "下載助手還沒連線，所以不知道擴充功能的資料夾在哪裡。請先讓它連線（設定流程最後一步的「啟動」），再更新。";
  if (!info.canUpdateHere) {
    return `這份擴充功能不是用安裝檔放的，網頁不知道它的資料夾在哪裡。請到擴充功能的側邊面板，打開「設定與工具」的「版本與更新」，按「${PANEL_UPDATE_BUTTON.pickFolder}」（第一次要選一次資料夾，之後這顆按鈕會叫「${PANEL_UPDATE_BUTTON.apply}」），或${REINSTALL_ACTION}。`;
  }
  if (!connected) return "請先讓下載助手連線（設定流程最後一步的「啟動」），再更新。";
  return "有新版本可以更新。";
}

// The page and the extension come from the same repository, so an extension older than the page was probably not
// reloaded (or was written into another folder) after the files were updated.
export function versionNotice({ extensionVersion, pageVersion, updateAvailable = false }) {
  const known = (version) => Boolean(version) && versionAtLeast(version, "0");
  if (!known(extensionVersion) || !known(pageVersion) || versionAtLeast(extensionVersion, pageVersion)) return null;
  const extra = updateAvailable ? "也可以改按頁面左側「版本與更新」的「更新到最新版」（會自動重新載入）。" : "";
  return `網頁版是 v${pageVersion}，但你的擴充功能是 v${extensionVersion}，還在跑舊版。請關閉這個視窗，${REINSTALL_ACTION}。${extra}`;
}

// The local program and the extension are released together. When they differ (one was not updated, or an update stopped
// halfway) things can misbehave in ways that are hard to tell apart, so say so instead of claiming everything is current.
export function hostVersionNotice({ extensionVersion, hostVersion, updateAvailable = false }) {
  const known = (version) => Boolean(version) && versionAtLeast(version, "0");
  if (!known(extensionVersion) || !known(hostVersion) || extensionVersion === hostVersion) return null;
  return `本機小程式是 v${hostVersion}，擴充功能是 v${extensionVersion}，兩者版本不一致，功能可能異常。請${REINSTALL_ACTION}。${updateButtonExtra(updateAvailable)}`;
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
