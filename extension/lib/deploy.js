// First install from the web page: write the latest extension files from GitHub into a folder the user picked
// (or pack them into a ZIP). Everything is checked against GitHub's file hashes before anything is written.
import { UPDATE_REPO } from "./update-config.js";
import { EXTENSION_NAME } from "./constants.js";
import { UpdateError, checkLatest, downloadAll, writeFiles } from "./updater.js";
import { buildZip } from "./zip.js";

const ZIP_FOLDER = "YouTube-batch-downloader-extension";

// Only an empty folder, or this extension's own folder, may be written into: never over someone's other files.
export async function assertDeployFolder(dir) {
  const names = [];
  for await (const [name] of dir.entries()) names.push(name);
  if (!names.length) return;
  let ours = false;
  try {
    const file = await (await dir.getFileHandle("manifest.json")).getFile();
    ours = JSON.parse(await file.text()).name === EXTENSION_NAME;
  } catch { /* no readable manifest.json: not our folder */ }
  if (!ours) throw new UpdateError(`「${dir.name}」裡已經有其他檔案。請選一個空的資料夾（選取視窗裡可以按「新增資料夾」）`);
}

// Every file of extension/ on the repository's tracked branch (tests excluded), downloaded and verified.
export async function fetchExtensionFiles({ fetchFn = fetch, repo = UPDATE_REPO, onProgress } = {}) {
  const info = await checkLatest({ fetchFn, repo, readLocal: async () => null });
  return downloadAll(info.extChanged, { sha: info.sha, repo, fetchFn, onProgress });
}

export async function deployToFolder(dir, options = {}) {
  await assertDeployFolder(dir);
  const files = await fetchExtensionFiles(options);
  await writeFiles(dir, files, options.onProgress);
  return files.length;
}

export async function buildExtensionZip(options = {}) {
  const files = await fetchExtensionFiles(options);
  return { blob: buildZip(files.map((f) => ({ name: `${ZIP_FOLDER}/${f.path}`, bytes: f.bytes }))), count: files.length };
}
