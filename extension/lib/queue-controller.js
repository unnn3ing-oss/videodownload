// Wires the queue state (queue.js) to the local host: resolving, downloading, copy text and covers.
// The background script owns one controller; the side panel and the web page only see its state.
import {
  addPlaceholder, applyHostEvent, applyResolveFailed, applyResolved, createState, hostLost, markRunning,
  markSent, pendingDownloads, removeItem, retryItem, setHostConnected, setSettings, setTags, QueueError,
} from "./queue.js";
import { buildCopyText, extractHashtags } from "./copytext.js";
import { coverName } from "./covername.js";
import { findCover } from "./cover.js";
import { toBase64 } from "./base64.js";
import { versionAtLeast } from "./version.js";
import { MIN_HOST_VERSION } from "./constants.js";

const MAX_RESOLVES = 2; // yt-dlp processes asking YouTube at the same time
const TIMEOUT = { remove: 15000, resolve: 180000, meta: 90000, save_cover: 30000, download: 20000, enqueue: 20000 };
const fail = (error) => ({ ok: false, error });

// deps.host: { connected(), version(), request(message, timeoutMs) -> Promise<event>, send(message) }
export function createController({ host, save, notify, fetchFn = fetch, downloads, now = Date.now, initial = null, retryDelayMs = 400 }) {
  let state = createState(initial);
  const sentIds = new Set(); // video ids the host already has in its current job
  const resolving = new Set(); // uids with a resolve request in flight
  const expectRemoved = new Set(); // video ids the host was told to cancel mid-download; it will confirm each once
  const tasks = new Set();
  let starting = false;
  let restartAfterDone = false;
  let stopRequested = false;
  let stopAfterStart = false; // stop pressed while the start request was still waiting for the host's answer

  const commit = (next) => {
    state = next;
    save(state);
    notify(state);
  };
  const track = (promise) => {
    const task = promise.catch(() => {}).finally(() => tasks.delete(task));
    tasks.add(task);
    return task;
  };
  const idle = async () => {
    while (tasks.size) await Promise.all([...tasks]);
  };
  const hostUsable = () => host.connected() && versionAtLeast(host.version(), MIN_HOST_VERSION);
  const hostOutdated = () => host.connected() && !versionAtLeast(host.version(), MIN_HOST_VERSION);
  const syncHostFlag = () => {
    if (state.hostConnected !== host.connected() || state.hostOutdated !== hostOutdated()) {
      commit(setHostConnected(state, host.connected(), hostOutdated()));
    }
  };
  const find = (uid) => state.items.find((i) => i.uid === uid);

  function resolveOne(uid, url) {
    resolving.add(uid);
    return track((async () => {
      try {
        const event = await host.request({ type: "resolve", urls: [url], limit: state.settings.limit }, TIMEOUT.resolve);
        commit(event.type === "resolved"
          ? applyResolved(state, uid, event.items)
          : applyResolveFailed(state, uid, event.message ?? "解析失敗"));
      } catch (error) {
        // A dropped connection leaves the row waiting; it is resolved again when the host is back.
        if (host.connected()) commit(applyResolveFailed(state, uid, error.message));
      } finally {
        resolving.delete(uid);
      }
      pumpResolves();
      syncRun();
    })());
  }

  // Rows waiting for their title are resolved a couple at a time, in list order: one yt-dlp each.
  function pumpResolves() {
    if (!host.connected()) return;
    for (const item of state.items) {
      if (resolving.size >= MAX_RESOLVES) return;
      if (item.status === "fetching" && !resolving.has(item.uid)) resolveOne(item.uid, item.url);
    }
  }

  async function startRun(items) {
    starting = true;
    stopRequested = false;
    stopAfterStart = false;
    try {
      // "busy" while we think nothing runs means the host is still wrapping up the previous job: wait a moment.
      for (let attempt = 0; ; attempt += 1) {
        const event = await host.request({
          type: "download", items, quality: state.settings.quality, cooldownSec: state.settings.cooldownSec,
        }, TIMEOUT.download);
        if (event.type === "started") {
          sentIds.clear();
          items.forEach((i) => sentIds.add(i.id));
          commit(markSent(markRunning(state, true), items.map((i) => i.id), true));
          break;
        }
        if (event.code !== "busy") return fail(event.message ?? "無法開始下載");
        if (state.running) break; // a job really is running: its events will update the list
        if (attempt >= 2) return fail(event.message ?? "無法開始下載");
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
      if (stopAfterStart) cancelJob(); // the job exists now, so there is something to cancel
    } catch (error) {
      return fail(error.message);
    } finally {
      starting = false;
      stopAfterStart = false;
    }
    syncRun();
    return { ok: true };
  }

  function cancelJob() {
    stopRequested = true;
    try { host.send({ type: "cancel" }); } catch { /* host gone */ }
  }

  // While a job runs, anything that became startable (new rows, retries, promoted duplicates) joins it.
  function syncRun() {
    if (!state.running || !host.connected()) return;
    const items = pendingDownloads(state).filter((i) => !sentIds.has(i.id));
    if (!items.length) return;
    const ids = items.map((i) => i.id);
    ids.forEach((id) => sentIds.add(id));
    commit(markSent(state, ids, true));
    const unsend = () => {
      ids.forEach((id) => sentIds.delete(id));
      commit(markSent(state, ids, false));
    };
    track((async () => {
      try {
        const event = await host.request({ type: "enqueue", items }, TIMEOUT.enqueue);
        if (event.type === "error") {
          unsend();
          if (event.code === "not_running") restartWhenFree();
        }
      } catch {
        unsend();
      }
    })());
  }

  // The job ended just as rows were added. Its `done` event may still be on its way.
  function restartWhenFree() {
    if (state.running) {
      restartAfterDone = true;
      return;
    }
    const items = pendingDownloads(state);
    if (items.length && !starting) track(startRun(items));
  }

  return {
    getState: () => state,
    idle,

    async add(url) {
      syncHostFlag();
      let added;
      try {
        added = addPlaceholder(state, url);
      } catch (error) {
        if (error instanceof QueueError) return fail(error.message);
        throw error;
      }
      commit(added.state);
      pumpResolves();
      return { ok: true };
    },

    remove(uid) {
      const item = find(uid);
      if (!item) return;
      const live = item.status === "waiting" || item.status === "downloading";
      if (live && item.id && !item.dupOf && state.running && sentIds.has(item.id)) {
        sentIds.delete(item.id);
        // Only a download that is already running gets an item_removed event back, and that event must not
        // be mistaken for a duplicate that has just taken this row's place.
        track(host.request({ type: "remove", itemId: item.id }, TIMEOUT.remove).then((event) => {
          if (event.type === "removed" && event.where === "current") expectRemoved.add(item.id);
        }));
      }
      commit(removeItem(state, uid));
      syncRun();
    },

    retry(uid) {
      const item = find(uid);
      commit(retryItem(state, uid));
      if (item?.id) sentIds.delete(item.id);
      syncRun();
    },

    async start() {
      syncHostFlag();
      if (!host.connected()) return fail("請先連線本機小程式");
      if (!versionAtLeast(host.version(), MIN_HOST_VERSION)) return fail("請先更新本機小程式");
      if (state.running || starting) return { ok: true };
      const items = pendingDownloads(state);
      if (!items.length) return fail("沒有可下載的影片");
      return startRun(items);
    },

    stop() {
      if (state.running) cancelJob();
      else if (starting) stopAfterStart = true;
    },

    setSettings(patch) {
      commit(setSettings(state, patch));
    },

    onHostConnected() {
      commit(setHostConnected(state, true, hostOutdated()));
      pumpResolves();
      return idle();
    },

    onHostDisconnected() {
      sentIds.clear();
      starting = false;
      restartAfterDone = false;
      expectRemoved.clear();
      commit(hostLost(state));
    },

    onHostEvent(event) {
      if (event.type === "item_removed" && expectRemoved.delete(event.itemId)) return;
      const next = applyHostEvent(state, event, now());
      if (next !== state) commit(next);
      if (event.type === "item_failed" || event.type === "item_removed") sentIds.delete(event.itemId);
      if (event.type === "done") {
        sentIds.clear();
        const again = restartAfterDone && !stopRequested;
        restartAfterDone = false;
        stopRequested = false;
        const items = again ? pendingDownloads(state) : [];
        if (items.length) track(startRun(items));
      }
    },

    async copyText(uid) {
      const item = find(uid);
      if (!item || !item.id) return fail("找不到這支影片");
      if (item.tags) return { ok: true, text: buildCopyText(item.title, item.tags), tagCount: item.tags.length };
      if (!host.connected()) return fail("請先連線本機小程式");
      if (!hostUsable()) return fail("請先更新本機小程式");
      let event;
      try {
        event = await host.request({ type: "meta", url: item.url }, TIMEOUT.meta);
      } catch (error) {
        return fail(error.message);
      }
      if (event.type !== "meta") return fail(event.message ?? "無法取得影片說明");
      const tags = extractHashtags(event.description);
      commit(setTags(state, uid, tags));
      return { ok: true, text: buildCopyText(find(uid)?.title ?? item.title, tags), tagCount: tags.length };
    },

    async downloadCover(uid) {
      const item = find(uid);
      if (!item || !item.id) return fail("找不到這支影片");
      const cover = await findCover(item.id, fetchFn);
      if (!cover) return fail("找不到封面圖片");
      if (hostUsable()) {
        try {
          const event = await host.request({ type: "save_cover", id: item.id, title: item.title, data: toBase64(cover.bytes) }, TIMEOUT.save_cover);
          if (event.type === "cover_saved") return { ok: true, where: "folder", file: event.file };
          return fail(event.message ?? "無法儲存封面");
        } catch { /* host dropped while saving: fall back to the browser download below */ }
      }
      try {
        await downloads.download({ url: cover.url, filename: `${coverName(item.title, item.id)}.jpg`, conflictAction: "uniquify" });
        return { ok: true, where: "downloads" };
      } catch (error) {
        return fail(`無法下載封面：${error.message}`);
      }
    },
  };
}
