export const MAX_FILES = 50;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

const HOST_FILE = /^[A-Za-z0-9_]+\.py$/;

export function isSafeRelativePath(path) {
  if (typeof path !== "string" || path === "" || path.length > 200) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes(":")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git");
}

// Turn GitHub's recursive file tree into the two sets of files this tool updates:
//   extension/**        -> the extension folder (minus tests/)
//   host/<name>.py      -> the local host (top level only)
// Anything unsafe, oversized or too numerous aborts the whole update.
export function mapTree(tree) {
  const extension = [];
  const host = [];
  for (const item of tree) {
    if (item.type !== "blob") continue;
    const isExtension = item.path.startsWith("extension/");
    if (!isExtension && !item.path.startsWith("host/")) continue;
    const rest = item.path.slice(isExtension ? "extension/".length : "host/".length);
    if (!isSafeRelativePath(rest)) throw new Error(`更新清單含不安全的路徑：${item.path}`);
    if (isExtension ? rest.startsWith("tests/") : !HOST_FILE.test(rest)) continue;
    const size = Number.isFinite(item.size) ? item.size : 0;
    if (size > MAX_FILE_BYTES) throw new Error(`更新檔案過大：${item.path}`);
    if (isExtension) extension.push({ path: rest, repoPath: item.path, sha: item.sha, size });
    else host.push({ path: rest, sha: item.sha, size });
  }
  if (extension.length > MAX_FILES || host.length > MAX_FILES) throw new Error(`更新檔案數量超過上限（${MAX_FILES}）`);
  return { extension, host };
}
