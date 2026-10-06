// Saves the installer for this computer ("download installer" in the side panel and on the web page).
// The file is read inside the extension and handed to Chrome as a data: address: when the background script
// asks Chrome to download a chrome-extension:// address itself, Chrome fails the download with NETWORK_FAILED.
import { installerFor } from "./platform.js";
import { toBase64 } from "./base64.js";

const MIME = { ".zip": "application/zip" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// download() answers as soon as the download has been queued; whether it worked only shows up afterwards.
async function waitForDownload(downloads, id, { pollMs, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [item] = await downloads.search({ id });
    if (item?.state === "complete") return null;
    if (item?.state === "interrupted") return item.error ?? "UNKNOWN";
    if (Date.now() >= deadline) return null; // still going: a big file on a slow disk is not a failure
    await sleep(pollMs);
  }
}

export async function downloadInstaller({ runtime, downloads, fetchFn = fetch, pollMs = 150, timeoutMs = 15000 }) {
  const info = await runtime.getPlatformInfo();
  const installer = installerFor(info.os);
  if (!installer) return { ok: false, error: "目前只支援 Windows 與 Mac" };
  const name = installer.file.split("/").pop();
  let bytes;
  try {
    const response = await fetchFn(runtime.getURL(installer.file));
    if (!response.ok) throw new Error(String(response.status));
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    return { ok: false, error: `找不到安裝檔（${name}）。請回到網頁版的步驟 1 重新部署擴充功能，再試一次。` };
  }
  const mime = MIME[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream";
  try {
    const id = await downloads.download({ url: `data:${mime};base64,${toBase64(bytes)}`, filename: name });
    const problem = await waitForDownload(downloads, id, { pollMs, timeoutMs });
    if (problem === "USER_CANCELED") return { ok: false, error: "安裝檔下載已取消" };
    if (problem) return { ok: false, error: `無法下載安裝檔：Chrome 回報 ${problem}` };
    return { ok: true, os: info.os, name };
  } catch (error) {
    return { ok: false, error: `無法下載安裝檔：${error.message}` };
  }
}
