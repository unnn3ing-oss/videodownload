// First install from the web page: write the latest extension files from GitHub into a folder the user picked
// (or pack them into a ZIP). Everything is checked against GitHub's file hashes before anything is written.
import { UPDATE_REPO } from "./update-config.js";
import { EXTENSION_NAME } from "./constants.js";
import { FOLDER_NAME } from "./setup-flow.js";
import { UpdateError, checkLatest, downloadAll, writeFiles } from "./updater.js";
import { buildZip } from "./zip.js";

const ZIP_FOLDER = "YouTube-batch-downloader-extension";

// "empty", "ours" (this extension's own folder) or "other" (somebody's folder with their things in it).
export async function inspectFolder(dir) {
  const names = [];
  for await (const [name] of dir.entries()) names.push(name);
  if (!names.length) return "empty";
  try {
    const file = await (await dir.getFileHandle("manifest.json")).getFile();
    if (JSON.parse(await file.text()).name === EXTENSION_NAME) return "ours";
  } catch { /* no readable manifest.json: not our folder */ }
  return "other";
}

async function existingChild(dir, name) {
  try {
    return await dir.getDirectoryHandle(name);
  } catch (error) {
    if (error?.name === "NotFoundError") return null;
    throw error;
  }
}

// Every file of extension/ on the repository's tracked branch (tests excluded), downloaded and verified.
export async function fetchExtensionFiles({ fetchFn = fetch, repo = UPDATE_REPO, onProgress } = {}) {
  const info = await checkLatest({ fetchFn, repo, readLocal: async () => null });
  return downloadAll(info.extChanged, { sha: info.sha, repo, fetchFn, onProgress });
}

// The files go into the chosen folder when it is empty or already this extension's. A folder with other things in it is left
// alone: the files go into a folder of the suggested name inside it. Returns { count, inside } (inside: that name, or null).
export async function deployToFolder(dir, { folderName = FOLDER_NAME, ...options } = {}) {
  let inside = null;
  if ((await inspectFolder(dir)) === "other") {
    inside = folderName;
    const child = await existingChild(dir, folderName);
    if (child && (await inspectFolder(child)) === "other") {
      throw new UpdateError(`「${dir.name}」裡已經有一個叫「${folderName}」的資料夾，而且裡面有其他檔案。請換一個資料夾，或把那個資料夾改名。`);
    }
  }
  const files = await fetchExtensionFiles(options); // (nothing is created before every download is verified)
  const target = inside ? await dir.getDirectoryHandle(inside, { create: true }) : dir;
  await writeFiles(target, files, options.onProgress);
  return { count: files.length, inside };
}

export async function buildExtensionZip(options = {}) {
  const files = await fetchExtensionFiles(options);
  return { blob: buildZip(files.map((f) => ({ name: `${ZIP_FOLDER}/${f.path}`, bytes: f.bytes }))), count: files.length };
}
