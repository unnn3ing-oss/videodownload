// What the web page says about its connection to the extension and the local host, and when it should keep
// asking the extension to launch the host. Plain functions: the page only draws what they return.

export const EXTENSION_MISSING_TEXT = "還沒偵測到擴充功能。請先照左邊的步驟 1、2 部署並載入；完成後這裡會自動解鎖，不用重新整理。這個網頁需要 Chrome（電腦版）。";
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
    return { kind: "error", text: "本機小程式啟動後馬上又關閉了，自動重試幾次都失敗。請確認已執行過安裝檔，再按步驟 4 的「啟動」重試。" };
  }
  if (wasRunning) return { kind: "info", text: "與本機小程式的連線中斷，下載已暫停。正在嘗試重新連線…" };
  return null;
}

// Once the extension is there the page keeps asking it to launch the host until it answers: the person may still
// be running the installer. A host that is launched and closes right away is not retried forever, though.
export function createAutoConnect({ maxTries = 5 } = {}) {
  let tries = 0;
  return {
    next(detected, status) {
      if (!detected || status.state === "forbidden") return { send: false, gaveUp: false };
      if (status.state === "running") {
        tries = 0;
        return { send: false, gaveUp: false };
      }
      if (status.state === "stopped") {
        if (tries >= maxTries) return { send: false, gaveUp: true };
        tries += 1;
      }
      return { send: true, gaveUp: false };
    },
    reset() {
      tries = 0;
    },
  };
}
