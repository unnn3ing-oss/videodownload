// Wires the queue state (queue.js) to the local host: resolving, downloading, copy text and covers.
// The background script owns one controller; the side panel and the web page only see its state.
import {
  addPlaceholder, applyHostEvent, applyResolveFailed, applyResolved, createState, hostLost, markRunning,
  canClearAll, clearAll, setTagsError, markSent, outputDirLocked, pendingDownloads, removeItem, retryItem, setCover, setHostConnected, setSettings, setTags, QueueError,
} from "./queue.js";
import { KEEP_TAGS, MAX_TAGS, buildCopyText, extractHashtags, pickTags } from "./copytext.js";
import { coverBaseName, coverName } from "./covername.js";
import { findCover } from "./cover.js";
import { toBase64 } from "./base64.js";
import { versionAtLeast } from "./version.js";
import { MIN_HOST_VERSION } from "./constants.js";

const MAX_RESOLVES = 2; // yt-dlp processes asking YouTube at the same time
const TIMEOUT = { remove: 15000, resolve: 180000, meta: 90000, save_cover: 30000, download: 20000, enqueue: 20000 };
const fail = (error) => ({ ok: false, error });

// deps.host: { connected(), version(), request(message, timeoutMs) -> Promise<event>, send(message) }
// prefetchTags: read every video's description by itself (one at a time, `tagGapMs` apart) so its text is ready under the row.
export function createController({ host, save, notify, fetchFn = fetch, downloads, now = Date.now, initial = null, retryDelayMs = 400,
  prefetchTags = false, tagGapMs = 4000, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  let state = createState(initial);
  const sentIds = new Set(); // video ids the host already has in its current job
  const resolving = new Set(); // uids with a resolve request in flight
  const expectRemoved = new Set(); // video ids the host was told to cancel mid-download; it will confirm each once
  const tasks = new Set();
  let jobDir = null; // the output folder the host's current job was started with (it writes the whole job there)
  let starting = false;
  let restartAfterDone = false;
  let stopRequested = false;
  let stopAfterStart = false; // stop pressed while the start request was still waiting for the host's answer
  let coverChain = Promise.resolve(); // covers are saved one after another

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

  // The description of one video, as its hashtags. Shared by the copy button and the reading that runs by itself.
  async function loadTags(uid) {
    const item = find(uid);
    if (!item || !item.id) return fail("找不到這支影片");
    if (!host.connected()) return fail("請先連線本機小程式");
    if (!hostUsable()) return fail("請先更新本機小程式");
    let event;
    try {
      event = await host.request({ type: "meta", url: item.url }, TIMEOUT.meta);
    } catch (error) {
      return fail(error.message);
    }
    if (event.type !== "meta") return fail(event.message ?? "無法取得影片說明");
    const tags = extractHashtags(event.description, KEEP_TAGS);
    commit(setTags(state, uid, tags));
    return { ok: true, tags };
  }

  // One video at a time with a pause between (every read is a yt-dlp call to YouTube). Three failures in a row end the run:
  // the rows keep their reason and the copy button tries a row again. Rows that repeat a video are not read twice.
  let tagWorker = false;
  const nextUnread = () => state.items.find((i) => i.id && !i.dupOf && !i.tags && !i.textError && i.status !== "fetching");
  function pumpTags() {
    if (!prefetchTags || tagWorker) return;
    tagWorker = true;
    track((async () => {
      let failures = 0;
      try {
        for (;;) {
          if (!hostUsable() || state.aborted) return;
          const item = nextUnread();
          if (!item) return;
          const result = await loadTags(item.uid);
          if (result.ok) {
            failures = 0;
          } else {
            if (!host.connected()) return; // (not a failure of the video: the host went away)
            commit(setTagsError(state, item.uid, result.error));
            if (++failures >= 3) return;
          }
          if (nextUnread()) await pause(tagGapMs + Math.round(Math.random() * tagGapMs * 0.25));
        }
      } finally {
        tagWorker = false;
      }
    })());
  }

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
      pumpTags();
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
    // The rows count as handed over from the moment the request goes out: a slow playlist that answers before the
    // host's reply must not take their place as the original.
    const ids = items.map((i) => i.id);
    ids.forEach((id) => sentIds.add(id));
    commit(markSent(state, ids, true));
    const unsend = () => {
      ids.forEach((id) => sentIds.delete(id));
      commit(markSent(state, ids, false));
    };
    try {
      // "busy" while we think nothing runs means the host is still wrapping up the previous job: wait a moment.
      for (let attempt = 0; ; attempt += 1) {
        const event = await host.request({
          type: "download", items, quality: state.settings.quality, cooldownSec: state.settings.cooldownSec,
        }, TIMEOUT.download);
        if (event.type === "started") {
          jobDir = host.outputDir?.() ?? null;
          commit(markRunning(state, true));
          break;
        }
        if (event.code !== "busy") {
          unsend();
          return fail(event.message ?? "無法開始下載");
        }
        if (state.running) { // a job really is running: its events update the list, and these rows join it below
          unsend();
          break;
        }
        if (attempt >= 2) {
          unsend();
          return fail(event.message ?? "無法開始下載");
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
      if (stopAfterStart) cancelJob(); // the job exists now, so there is something to cancel
    } catch (error) {
      unsend();
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

  // The videos before this one in the list that count when two covers would get the same name.
  const earlierRows = (item) => state.items.slice(0, state.items.findIndex((i) => i.uid === item.uid))
    .filter((i) => i.id && !i.dupOf && i.status !== "fetching" && i.status !== "failed");

  async function storeCover(item) {
    const cover = await findCover(item.id, fetchFn);
    if (!cover) return fail("找不到封面圖片");
    const name = coverBaseName(item.title, item.id, earlierRows(item));
    // The host writes covers into its folder as it is now; the video went into the folder its job started with. When the
    // two differ the cover is not put next to some other folder's videos.
    const folder = host.outputDir?.() ?? null;
    const moved = hostUsable() && Boolean(item.outDir && folder && item.outDir !== folder);
    if (hostUsable() && !moved) {
      try {
        const request = { type: "save_cover", id: item.id, title: item.title, data: toBase64(cover.bytes) };
        if (name !== coverName(item.title, item.id)) request.name = name; // the host's own name would clash with an earlier video's
        const event = await host.request(request, TIMEOUT.save_cover);
        if (event.type === "cover_saved") return { ok: true, where: "folder", file: event.file };
        return fail(event.message ?? "無法儲存封面");
      } catch { /* host dropped while saving: fall back to the browser download below */ }
    }
    try {
      await downloads.download({ url: cover.url, filename: `${name}.jpg`, conflictAction: "uniquify" });
      return moved ? { ok: true, where: "downloads", folderChanged: true } : { ok: true, where: "downloads" };
    } catch (error) {
      return fail(`無法下載封面：${error.message}`);
    }
  }

  const setCoverState = (uid, cover) => {
    const next = setCover(state, uid, cover);
    if (next !== state) commit(next);
  };

  // The cover button and the automatic save both come through here; the row keeps the result.
  async function saveCover(uid) {
    const item = find(uid);
    if (!item || !item.id) return fail("找不到這支影片");
    setCoverState(uid, { status: "saving" });
    let result;
    try {
      result = await storeCover(item);
    } catch (error) {
      result = fail(error.message);
    }
    setCoverState(uid, result.ok ? { status: "saved", where: result.where } : { status: "failed", error: result.error });
    return result;
  }

  // After a video has been downloaded its cover follows, one at a time, without holding up the host.
  function queueCover(uid) {
    coverChain = coverChain.then(() => saveCover(uid));
    track(coverChain);
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
    if (state.aborted) return; // the host stopped on purpose: starting again at once would hit the same trouble
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

    clearAll() {
      if (!canClearAll(state)) return fail("清單裡還有影片沒有處理完");
      sentIds.clear();
      commit(clearAll(state));
      return { ok: true };
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
      pumpTags();
      return idle();
    },

    outputDirLocked: () => starting || outputDirLocked(state),

    onHostDisconnected() {
      jobDir = null;
      sentIds.clear();
      starting = false;
      restartAfterDone = false;
      expectRemoved.clear();
      commit(hostLost(state));
    },

    onHostEvent(event) {
      if (event.type === "item_removed" && expectRemoved.delete(event.itemId)) return;
      if (event.type === "started") jobDir = host.outputDir?.() ?? null;
      // a video's folder is the one its job started with (a late event of a job we never saw start: the folder as it is now)
      const seen = event.type === "item_done" ? { ...event, outDir: jobDir ?? host.outputDir?.() ?? null } : event;
      const next = applyHostEvent(state, seen, now());
      if (next !== state) commit(next);
      if (event.type === "item_failed" || event.type === "item_removed") sentIds.delete(event.itemId);
      if (event.type === "item_done" && !event.skipped && state.settings.autoCover) {
        const finished = state.items.find((i) => i.id === event.itemId && !i.dupOf && i.status === "done");
        if (finished) queueCover(finished.uid);
      }
      if (event.type === "started" || event.type === "done") pumpTags(); // (it waits while the host stopped the job on purpose)
      if (event.type === "done") {
        sentIds.clear();
        // a job the host stopped on purpose (failures in a row, disk full) would only stop again: the person restarts it
        const again = restartAfterDone && !stopRequested && !state.aborted;
        restartAfterDone = false;
        stopRequested = false;
        jobDir = null;
        const items = again ? pendingDownloads(state) : [];
        if (items.length) track(startRun(items));
      }
    },

    async copyText(uid) {
      const item = find(uid);
      if (!item || !item.id) return fail("找不到這支影片");
      let tags = item.tags;
      if (!tags) {
        const loaded = await loadTags(uid);
        if (!loaded.ok) return loaded;
        tags = loaded.tags;
      }
      const picked = pickTags(tags, MAX_TAGS);
      return { ok: true, text: buildCopyText(find(uid)?.title ?? item.title, picked), tagCount: picked.length };
    },

    downloadCover: saveCover,
  };
}
