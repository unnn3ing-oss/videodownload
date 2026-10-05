import { UpdateError, verifyFolder } from "./updater.js";

// The extension's own folder, chosen once by the user (File System Access API), is kept as a handle
// in IndexedDB so later updates need no further picking.
const DB_NAME = "ytdl-updater";
const STORE = "handles";
const KEY = "extension-folder";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, action) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = action(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

const loadHandle = () => withStore("readonly", (store) => store.get(KEY));
const saveHandle = (handle) => withStore("readwrite", (store) => store.put(handle, KEY));

export async function hasSavedFolder() {
  try {
    return Boolean(await loadHandle());
  } catch {
    return false;
  }
}

// The saved folder when it is still usable, otherwise null (the caller then asks the user to pick).
export async function getFolder(expectedName) {
  let handle;
  try {
    handle = await loadHandle();
  } catch {
    return null;
  }
  if (!handle) return null;
  const options = { mode: "readwrite" };
  try {
    let permission = await handle.queryPermission(options);
    if (permission !== "granted") permission = await handle.requestPermission(options);
    if (permission !== "granted") return null;
    await verifyFolder(handle, expectedName);
    return handle;
  } catch {
    return null;
  }
}

export async function pickFolder(expectedName) {
  if (typeof globalThis.showDirectoryPicker !== "function") {
    throw new UpdateError("這個瀏覽器不支援選擇資料夾，請改用 Chrome");
  }
  let handle;
  try {
    handle = await globalThis.showDirectoryPicker({ id: "ytdl-extension", mode: "readwrite" });
  } catch (error) {
    if (error?.name === "AbortError") throw new UpdateError("已取消選擇資料夾");
    throw new UpdateError(`無法選擇資料夾：${error?.message ?? error}`);
  }
  await verifyFolder(handle, expectedName);
  await saveHandle(handle);
  return handle;
}
