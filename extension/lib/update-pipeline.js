// The whole update as one flow that the background script runs for the web page (and the side panel): compare with GitHub,
// download and verify, replace the host's files, and have the host write the extension's files into its folder (the
// installer recorded where it is, so nobody has to pick it again). The extension is reloaded by the caller afterwards.
import { UpdateError, assertSameKey, checkLatest, downloadAll } from "./updater.js";
import { toBase64 } from "./base64.js";

const hostError = (event) => (event?.type === "error" ? new UpdateError(event.message ?? "本機小程式回報錯誤") : null);

export async function collectUpdateInfo({ check = checkLatest, hostRequest = null, fetchFn = fetch, version, key }) {
  const latest = await check();
  let hostChanged = [];
  let hostChecked = false;
  let extensionFolder = null;
  if (hostRequest) {
    try {
      const event = await hostRequest({ type: "update_check", files: latest.hostFiles }, 20000);
      if (event.type === "update_status") {
        const changed = new Set(event.changed);
        hostChanged = latest.hostFiles.filter((file) => changed.has(file.path));
        hostChecked = true;
        extensionFolder = event.extensionFolder ?? null;
      }
    } catch { /* the host is not reachable right now: the extension's own files can still be compared */ }
  }
  let latestVersion = version;
  const manifest = latest.extChanged.find((file) => file.path === "manifest.json");
  if (manifest) {
    try {
      const [file] = await downloadAll([manifest], { sha: latest.sha, fetchFn });
      latestVersion = JSON.parse(new TextDecoder().decode(file.bytes)).version ?? version;
    } catch {
      latestVersion = null; // (the apply step downloads it again and refuses a bad one)
    }
  }
  return {
    current: version, latestVersion, key, sha: latest.sha, date: latest.date, message: latest.message,
    extChanged: latest.extChanged, hostChanged, hostChecked, extensionFolder,
    hasUpdate: latest.extChanged.length > 0 || hostChanged.length > 0,
  };
}

// Order matters: nothing local changes until every download is verified; the host's files are replaced before the
// extension's, so a failed write of those can still put the host's back.
export async function applyUpdate({ info, hostRequest, fetchFn = fetch, key, onProgress = () => {} }) {
  if (info.extChanged.length > 0 && !info.extensionFolder) {
    throw new UpdateError("尚未記錄擴充功能資料夾（不是用安裝檔放的）。請改用側邊面板「設定與工具」裡的「更新到最新版」，第一次要選一次資料夾。", "need_folder");
  }
  const extDownloads = await downloadAll(info.extChanged, { sha: info.sha, fetchFn, onProgress });
  assertSameKey(extDownloads, key);
  const hostDownloads = await downloadAll(info.hostChanged, { sha: info.sha, fetchFn, onProgress, base: "host" });
  const entries = (files) => files.map(({ path, sha, size }) => ({ path, sha, size }));
  let hostCommitted = false;
  try {
    if (info.hostChanged.length > 0) {
      onProgress({ step: "host", done: 0, total: info.hostChanged.length });
      const contents = Object.fromEntries(hostDownloads.map((file) => [file.path, toBase64(file.bytes)]));
      const staged = await hostRequest({ type: "update_stage", commit: info.sha, files: entries(info.hostChanged), contents }, 90000); // (its self-check alone can take 30 s)
      if (hostError(staged)) throw hostError(staged);
      const committed = await hostRequest({ type: "update_commit" }, 60000);
      if (hostError(committed)) throw hostError(committed);
      hostCommitted = true;
    }
    if (info.extChanged.length > 0) {
      onProgress({ step: "write", done: 0, total: info.extChanged.length });
      const contents = Object.fromEntries(extDownloads.map((file) => [file.path, toBase64(file.bytes)]));
      const written = await hostRequest({ type: "update_ext", files: entries(info.extChanged), contents }, 60000);
      if (hostError(written)) throw hostError(written);
    }
  } catch (error) {
    if (hostCommitted) {
      const back = await hostRequest({ type: "update_rollback" }).catch((e) => ({ type: "error", message: e.message }));
      if (back.type === "error") {
        throw new UpdateError(`${error.message}。本機小程式已經更新、擴充功能還沒有；請再按一次「更新到最新版」，或重新執行安裝檔。`, error.code);
      }
    }
    throw error;
  }
  return { extFiles: info.extChanged.length, hostFiles: info.hostChanged.length };
}
