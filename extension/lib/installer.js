// Saves the installer for this computer ("download installer" in the side panel and on the web page).
// The file is read inside the extension and handed to Chrome as a data: address: when the background script
// asks Chrome to download a chrome-extension:// address itself, Chrome fails the download with NETWORK_FAILED.
import { installerFor } from "./platform.js";
import { toBase64 } from "./base64.js";
import { WEB_ORIGIN, WEB_PATH } from "./constants.js";

const MIME = { ".zip": "application/zip" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Chrome's own verdicts on a download: anything else (a warning about the file type, say) waits for the person.
const CLEARED = new Set(["safe", "accepted", "allowlistedByPolicy", "deepScannedSafe", "deepScannedOpenedSafe"]);

// download() answers as soon as the download has been queued; whether it worked only shows up afterwards.
// Returns null (saved), "PENDING" (Chrome is still holding or writing it), or Chrome's error code.
async function waitForDownload(downloads, id, { pollMs, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [item] = await downloads.search({ id });
    if (item?.state === "complete") return null;
    if (item?.state === "interrupted") return item.error ?? "UNKNOWN";
    if (item?.danger && !CLEARED.has(item.danger)) return "PENDING"; // waiting for the person to press "keep"
    if (Date.now() >= deadline) return "PENDING"; // a big file, or a "where to save" window nobody answered yet
    await sleep(pollMs);
  }
}

export const installerPendingText = (name) =>
  `「${name}」還沒存好：請看 Chrome 右上角的下載清單，如果出現「保留」或要你選儲存位置，請照著做；存好之後再照步驟執行。`;

export async function downloadInstaller({ runtime, downloads, fetchFn = fetch, pollMs = 150, timeoutMs = 15000 }) {
  const info = await runtime.getPlatformInfo();
  const installer = installerFor(info.os);
  if (!installer) return { ok: false, error: "目前只支援 Windows 與 Mac" };
  const name = installer.file.split("/").pop();
  // The extension's own copy when it has one; the installer puts the extension in a folder without the installers
  // (they contain the extension), so then the copy on the web page, which always is the latest.
  let bytes = null;
  for (const url of [runtime.getURL(installer.file), `${WEB_ORIGIN}${WEB_PATH}extension/${installer.file}`]) {
    try {
      const response = await fetchFn(url);
      if (response.ok) {
        bytes = new Uint8Array(await response.arrayBuffer());
        break;
      }
    } catch { /* try the next place */ }
  }
  if (!bytes) {
    return { ok: false, error: `找不到安裝檔（${name}）。請到網頁版重新下載安裝檔，或把擴充功能更新到最新版再試一次。` };
  }
  const mime = MIME[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream";
  try {
    const id = await downloads.download({ url: `data:${mime};base64,${toBase64(bytes)}`, filename: name });
    const problem = await waitForDownload(downloads, id, { pollMs, timeoutMs });
    if (problem === "USER_CANCELED") return { ok: false, error: "安裝檔下載已取消" };
    if (problem && problem !== "PENDING") return { ok: false, error: `無法下載安裝檔：Chrome 回報 ${problem}` };
    return { ok: true, os: info.os, name, pending: problem === "PENDING" };
  } catch (error) {
    return { ok: false, error: `無法下載安裝檔：${error.message}` };
  }
}
