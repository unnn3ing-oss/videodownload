import { UPDATE_REPO } from "./update-config.js";
import { gitBlobSha, sameContent } from "./gitsha.js";
import { MAX_FILE_BYTES, isSafeRelativePath, mapTree } from "./update-rules.js";
import { toBase64 } from "./base64.js";

export { toBase64 };

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SHA_RE = /^[0-9a-f]{40}$/;

export class UpdateError extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = "UpdateError";
    this.code = code;
  }
}

export function shouldCheck(checkedAt, now = Date.now(), intervalMs = CHECK_INTERVAL_MS) {
  return !Number.isFinite(checkedAt) || now - checkedAt >= intervalMs;
}

// The files of this extension as installed (what the browser is running right now).
export async function readBundled(path) {
  try {
    const response = await fetch(chrome.runtime.getURL(path));
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
}

async function githubJson(fetchFn, url, repo) {
  let response;
  try {
    response = await fetchFn(url, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
  } catch {
    throw new UpdateError("連不上 GitHub，請確認網路連線");
  }
  const rateLimited = response.status === 429
    || (response.status === 403 && response.headers?.get?.("x-ratelimit-remaining") === "0");
  if (rateLimited) throw new UpdateError("GitHub 暫時限制查詢次數，請稍後再試");
  // GitHub answers 422 ("No commit found for SHA: release") for a branch that does not exist.
  if ((response.status === 404 || response.status === 422) && url.includes("/commits/")) {
    throw new UpdateError(`尚未發佈：找不到 ${repo.branch} 分支`);
  }
  if (response.status === 403) {
    throw new UpdateError("GitHub 拒絕了查詢（HTTP 403），可能被公司網路的代理或防火牆擋下");
  }
  if (!response.ok) throw new UpdateError(`連不上 GitHub（HTTP ${response.status}）`);
  return response.json();
}

export async function checkLatest({ fetchFn = fetch, readLocal = readBundled, repo = UPDATE_REPO } = {}) {
  const base = `https://api.github.com/repos/${repo.owner}/${repo.repo}`;
  const commit = await githubJson(fetchFn, `${base}/commits/${repo.branch}`, repo);
  const treeSha = commit?.commit?.tree?.sha;
  if (!SHA_RE.test(commit?.sha ?? "") || !/^[0-9a-z]{1,64}$/.test(treeSha ?? "")) throw new UpdateError("GitHub 回傳的資料格式不正確");
  const tree = await githubJson(fetchFn, `${base}/git/trees/${treeSha}?recursive=1`, repo);
  if (tree.truncated) throw new UpdateError("檔案太多，GitHub 沒有回傳完整清單");
  let mapped;
  try {
    mapped = mapTree(Array.isArray(tree.tree) ? tree.tree : []);
  } catch (error) {
    throw new UpdateError(error.message);
  }
  const extChanged = [];
  for (const entry of mapped.extension) {
    if (!(await sameContent(entry.path, await readLocal(entry.path), entry.sha))) extChanged.push(entry);
  }
  return {
    sha: commit.sha,
    date: commit.commit.committer?.date ?? "",
    message: String(commit.commit.message ?? "").split("\n")[0],
    extChanged,
    hostFiles: mapped.host,
    hasUpdate: extChanged.length > 0,
  };
}

// Download every changed file from the exact commit and verify each against its git blob SHA.
// Nothing is returned unless every file matches.
export async function downloadAll(entries, { sha, repo = UPDATE_REPO, fetchFn = fetch, onProgress = () => {}, base = "extension" }) {
  if (!SHA_RE.test(sha ?? "")) throw new UpdateError("無效的 commit，已取消更新");
  const results = [];
  for (const [index, entry] of entries.entries()) {
    if (!isSafeRelativePath(entry.path)) throw new UpdateError(`不安全的檔案路徑：${entry.path}`);
    const encoded = entry.path.split("/").map(encodeURIComponent).join("/");
    const url = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${sha}/${base}/${encoded}`;
    let bytes;
    try {
      const response = await fetchFn(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw new UpdateError(`下載 ${entry.path} 失敗：${error.message}`);
    }
    if (bytes.length > MAX_FILE_BYTES || (await gitBlobSha(bytes)) !== entry.sha) {
      throw new UpdateError(`${entry.path} 下載內容和 GitHub 上的不一致，已取消更新`);
    }
    results.push({ path: entry.path, bytes });
    onProgress({ step: "download", done: index + 1, total: entries.length });
  }
  return results;
}

// The pinned manifest key keeps the extension id (and so the native-messaging allow-list) stable.
export function assertSameKey(downloads, currentKey) {
  const manifest = downloads.find((file) => file.path === "manifest.json");
  if (!manifest) return;
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(manifest.bytes));
  } catch {
    throw new UpdateError("新版 manifest.json 格式不正確，已取消更新");
  }
  if (parsed.key !== currentKey) throw new UpdateError("新版的擴充功能識別碼和目前不同，已取消更新");
}

// The chosen folder must really be this extension's folder before anything is written into it.
export async function verifyFolder(dir, expectedName) {
  let text;
  try {
    const handle = await dir.getFileHandle("manifest.json");
    text = await (await handle.getFile()).text();
  } catch {
    throw new UpdateError("這個資料夾裡找不到 manifest.json，請選擇擴充功能所在的資料夾");
  }
  let name;
  try {
    name = JSON.parse(text).name;
  } catch {
    name = undefined;
  }
  if (name !== expectedName) throw new UpdateError(`這個資料夾不是「${expectedName}」的擴充功能資料夾`);
}

// Several unzipped copies of the extension can carry the same name. An unpacked extension is served from
// its own folder, so a probe file written into the chosen folder is readable at its URL only in the loaded copy.
export async function proveLoadedFolder(dir, { fetchFn = fetch, getUrl = (path) => chrome.runtime.getURL(path) } = {}) {
  const name = `ytdl-probe-${crypto.randomUUID()}.txt`;
  const token = crypto.randomUUID();
  const wrong = new UpdateError("這個資料夾不是目前載入的擴充功能資料夾（可能有多份解壓縮的副本）。請到 chrome://extensions 查看載入的位置，再選擇那個資料夾");
  try {
    try {
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(new TextEncoder().encode(token));
      await writable.close();
    } catch (error) {
      throw new UpdateError(`無法寫入所選資料夾：${error.message}`);
    }
    let served = null;
    try {
      const response = await fetchFn(getUrl(name), { cache: "no-store" });
      if (response.ok) served = await response.text();
    } catch { /* not readable: handled below */ }
    if (served !== token) throw wrong;
  } finally {
    await dir.removeEntry(name).catch(() => {});
  }
}

async function writeOne(dir, path, bytes) {
  try {
    const parts = path.split("/");
    let current = dir;
    for (const part of parts.slice(0, -1)) current = await current.getDirectoryHandle(part, { create: true });
    const handle = await current.getFileHandle(parts.at(-1), { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
  } catch (error) {
    throw new UpdateError(`寫入 ${path} 失敗：${error.message}`);
  }
}

// manifest.json goes last so a half-written update never looks complete.
export async function writeFiles(dir, downloads, onProgress = () => {}) {
  for (const file of downloads) {
    if (!isSafeRelativePath(file.path)) throw new UpdateError(`不安全的檔案路徑：${file.path}`);
  }
  const ordered = [...downloads.filter((f) => f.path !== "manifest.json"), ...downloads.filter((f) => f.path === "manifest.json")];
  for (const [index, file] of ordered.entries()) {
    await writeOne(dir, file.path, file.bytes);
    onProgress({ step: "write", done: index + 1, total: ordered.length });
  }
}

// Order matters: nothing local changes until every download is verified; the host is swapped before
// the extension files so a failed write can still roll the host back.
export async function runUpdate({
  info, hostChanged = [], getFolder, pickFolder, proveFolder = null, forgetFolder = null, fetchFn = fetch, hostApi, reload, currentKey, expectedName,
  onProgress = () => {}, repo = UPDATE_REPO,
}) {
  let dir = null;
  if (info.extChanged.length > 0) {
    dir = (await getFolder()) ?? (await pickFolder());
    if (!dir) throw new UpdateError("尚未選擇擴充功能資料夾");
    if (proveFolder) {
      try {
        await proveFolder(dir);
      } catch (error) {
        await forgetFolder?.();
        throw error;
      }
    }
  }
  const downloads = dir ? await downloadAll(info.extChanged, { sha: info.sha, repo, fetchFn, onProgress }) : [];
  assertSameKey(downloads, currentKey);
  // Chrome downloads the host files too (its network and proxy settings are known to work);
  // the host re-verifies every byte against the same blob SHA before using it.
  const hostDownloads = hostChanged.length > 0
    ? await downloadAll(hostChanged, { sha: info.sha, repo, fetchFn, onProgress, base: "host" })
    : [];
  let hostCommitted = false;
  if (hostChanged.length > 0) {
    onProgress({ step: "host", done: 0, total: hostChanged.length });
    const contents = Object.fromEntries(hostDownloads.map((file) => [file.path, toBase64(file.bytes)]));
    await hostApi.stage(info.sha, hostChanged, contents);
    await hostApi.commit();
    hostCommitted = true;
  }
  try {
    if (dir) await writeFiles(dir, downloads, onProgress);
  } catch (error) {
    if (hostCommitted) await hostApi.rollback().catch(() => {});
    throw error;
  }
  reload();
}
