// The download list as plain data. Every function takes a state and returns a new one; nothing here
// touches the browser, so the whole list behaviour is unit-tested. See the web-queue design spec.
import { isYouTubeUrl } from "./urls.js";
import { formatEta, formatSpeed, formatWait, parseBoundedInt } from "./format.js";
import { SETTING_RANGES } from "./constants.js";
import { classifyTabUrl } from "./page.js";

export const MAX_ITEMS = 500;
export const DEFAULT_SETTINGS = { quality: 1080, cooldownSec: 10, limit: 50, autoCover: true };
const STATUSES = new Set(["fetching", "waiting", "downloading", "done", "skipped", "failed"]);

export class QueueError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QueueError";
    this.code = code;
  }
}

function cleanSettings(patch, base = DEFAULT_SETTINGS) {
  const next = { ...base };
  if (patch && typeof patch === "object") {
    if ([720, 1080].includes(Number(patch.quality))) next.quality = Number(patch.quality);
    // an empty or invalid number leaves the setting as it was
    next.cooldownSec = parseBoundedInt(patch.cooldownSec, { ...SETTING_RANGES.cooldownSec, fallback: next.cooldownSec });
    next.limit = parseBoundedInt(patch.limit, { ...SETTING_RANGES.limit, fallback: next.limit });
    if (typeof patch.autoCover === "boolean") next.autoCover = patch.autoCover;
  }
  return next;
}

const blankItem = (uid, fields) => ({
  uid, id: null, url: "", title: "", duration: null, tags: null, status: "waiting", dupOf: null,
  percent: null, speed: null, eta: null, file: null, height: null, error: null, sent: false, cover: null,
  outDir: null, // the folder its video was written to (the output folder of the job it finished in)
  limitHit: null, // set on the last row of a channel or playlist that came back as long as the limit: it probably goes on
  ...fields,
});

// What happened to a row's cover: { status: "saving" } | { status: "saved", where: "folder" | "downloads" } | { status: "failed", error }.
// Only a result that is final survives a restart: a cover that was still being saved is not shown as saving forever.
function cleanCover(cover) {
  if (!cover || typeof cover !== "object") return null;
  if (cover.status === "saved") return { status: "saved", where: cover.where === "downloads" ? "downloads" : "folder" };
  if (cover.status === "failed" && typeof cover.error === "string") return { status: "failed", error: cover.error };
  return null;
}

// Why the host stopped the whole job on purpose (the `aborted` of its `done` summary): { code, message } or null.
function cleanAborted(raw) {
  if (!raw || typeof raw !== "object") return null;
  const code = typeof raw.code === "string" && raw.code ? raw.code : null;
  const message = typeof raw.message === "string" && raw.message.trim() ? raw.message : null;
  if (!code && !message) return null;
  return { code: code ?? "aborted", message: message ?? `下載已中止（${code}）` };
}

function coverText(cover) {
  if (!cover) return "";
  if (cover.status === "saving") return "封面下載中…";
  if (cover.status === "saved") return cover.where === "downloads" ? "封面已存到下載資料夾" : "封面已存";
  return `封面失敗：${cover.error ?? "未知原因"}`;
}

const titleKey = (title) => String(title ?? "").normalize("NFKC").trim().toLowerCase();

// The earliest copy stays normal; every later row with the same video id points at it. Only the id counts: two
// different videos can share a title ("Shorts", "Private video"), and the host keeps their files apart with " [id]".
// The exception is a row that is already on its way (handed to the host, downloading, finished): it keeps its place
// as the original even when a slow playlist later lands the same video in front of it, so a running download is never hidden.
function markDuplicates(items) {
  const byId = new Map();
  const counts = (item) => item.status !== "fetching" && (item.id || item.status !== "failed");
  const underway = (item) => item.sent || item.status === "downloading" || item.status === "done" || item.status === "skipped";
  const find = (item) => (item.id && byId.get(item.id)) || null;
  const register = (item) => {
    if (item.id) byId.set(item.id, item.uid);
  };
  for (const item of items) if (counts(item) && underway(item) && !find(item)) register(item);
  return items.map((item) => {
    if (!counts(item)) return item.dupOf === null ? item : { ...item, dupOf: null };
    let original = find(item);
    if (!original) register(item);
    if (original === item.uid) original = null;
    return item.dupOf === original ? item : { ...item, dupOf: original };
  });
}

// uid -> 1-based position of the first earlier row that is a different video with the same title. Only a hint: such a
// row is downloaded like any other. Worked out once per list (the view asks for every row on every redraw).
const sameTitleCache = new WeakMap();
function sameTitleRows(state) {
  let found = sameTitleCache.get(state.items);
  if (!found) {
    found = new Map();
    const first = new Map(); // title -> { id, position } of the first row with it
    state.items.forEach((row, index) => {
      const key = titleKey(row.title);
      if (!key || !row.id || row.dupOf || row.status === "fetching") return;
      const earlier = first.get(key);
      if (!earlier) first.set(key, { id: row.id, position: index + 1 });
      else if (earlier.id !== row.id) found.set(row.uid, earlier.position);
    });
    sameTitleCache.set(state.items, found);
  }
  return found;
}

const withItems = (state, items) => ({ ...state, items: markDuplicates(items) });

export function createState(saved = null) {
  const empty = { items: [], running: false, settings: { ...DEFAULT_SETTINGS }, cooldown: null, aborted: null, hostConnected: false, hostOutdated: false, nextUid: 1 };
  if (!saved || typeof saved !== "object" || !Array.isArray(saved.items)) return empty;
  const items = [];
  for (const raw of saved.items) {
    if (!raw || typeof raw !== "object" || !Number.isInteger(raw.uid) || !STATUSES.has(raw.status)) continue;
    const limitHit = Number.isInteger(raw.limitHit) && raw.limitHit > 0 ? raw.limitHit : null;
    const outDir = typeof raw.outDir === "string" && raw.outDir ? raw.outDir : null;
    let item = { ...blankItem(raw.uid, raw), sent: false, cover: cleanCover(raw.cover), limitHit, outDir }; // a restart ends the host's job
    if (item.status === "downloading") item = { ...item, status: "waiting", percent: null, speed: null, eta: null };
    if (item.status === "fetching") item = { ...item, title: item.title || item.url }; // resolved again once the host is there
    items.push(item);
  }
  const top = items.reduce((m, i) => Math.max(m, i.uid), 0);
  return {
    ...empty,
    items: markDuplicates(items),
    aborted: cleanAborted(saved.aborted), // the reason stays until the next job starts: it explains the rows that are still waiting
    settings: cleanSettings(saved.settings),
    nextUid: Math.max(top + 1, Number.isInteger(saved.nextUid) ? saved.nextUid : 1),
  };
}

export function addPlaceholder(state, url) {
  if (!isYouTubeUrl(url)) throw new QueueError("bad_url", "不是 YouTube 網址");
  if (state.items.length >= MAX_ITEMS) throw new QueueError("queue_full", `清單已滿（上限 ${MAX_ITEMS} 筆）`);
  const uid = state.nextUid;
  const item = blankItem(uid, { url, title: url, status: "fetching" });
  return { state: { ...withItems(state, [...state.items, item]), nextUid: uid + 1 }, uid };
}

const indexOfPlaceholder = (state, uid) => state.items.findIndex((i) => i.uid === uid && i.status === "fetching");

export function applyResolved(state, uid, refs) {
  const at = indexOfPlaceholder(state, uid);
  if (at < 0) return state;
  const room = Math.max(0, MAX_ITEMS - (state.items.length - 1));
  const limit = state.settings.limit;
  const chosen = refs.slice(0, Math.min(limit, room));
  let nextUid = state.nextUid;
  const rows = chosen.map((ref, n) => {
    const rowUid = n === 0 ? uid : nextUid++;
    if (!ref.id) return blankItem(rowUid, { url: ref.url, title: ref.url, status: "failed", error: "無法解析這個網址" });
    return blankItem(rowUid, { id: ref.id, url: ref.url, title: ref.title || ref.id, duration: ref.duration ?? null });
  });
  if (!rows.length) rows.push(blankItem(uid, { url: state.items[at].url, title: state.items[at].url, status: "failed", error: "找不到影片" }));
  // The host does not say when it stopped at the limit, so a list that came back exactly that long is taken to go on.
  // A single video never does; an address that is not plainly a list needs more than one video to count as one.
  const kind = classifyTabUrl(state.items[at].url);
  if (chosen.length === limit && kind !== "video" && (kind || limit > 1)) rows[rows.length - 1].limitHit = limit;
  const items = [...state.items.slice(0, at), ...rows, ...state.items.slice(at + 1)];
  return { ...withItems(state, items), nextUid };
}

export function applyResolveFailed(state, uid, message) {
  if (indexOfPlaceholder(state, uid) < 0) return state;
  return withItems(state, state.items.map((i) => (i.uid === uid ? { ...i, status: "failed", error: message } : i)));
}

export const removeItem = (state, uid) => withItems(state, state.items.filter((i) => i.uid !== uid));

export function retryItem(state, uid) {
  const item = state.items.find((i) => i.uid === uid);
  if (!item || item.status !== "failed" || !item.id) return state;
  return withItems(state, state.items.map((i) => (i.uid === uid
    ? { ...i, status: "waiting", error: null, percent: null, speed: null, eta: null, sent: false, cover: null } : i)));
}

export const setSettings = (state, patch) => ({ ...state, settings: cleanSettings(patch, state.settings) });
export const setCover = (state, uid, cover) => (state.items.some((i) => i.uid === uid)
  ? { ...state, items: state.items.map((i) => (i.uid === uid ? { ...i, cover } : i)) } : state);
export const setTags = (state, uid, tags) => ({ ...state, items: state.items.map((i) => (i.uid === uid ? { ...i, tags } : i)) });
// `outdated`: the host is there but too old for this version of the extension (it needs updating first).
export const setHostConnected = (state, connected, outdated = false) => ({
  ...state, hostConnected: Boolean(connected), hostOutdated: Boolean(connected) && Boolean(outdated),
});
// Rows the host has been given: they keep their place when duplicates are worked out again.
export const markSent = (state, ids, sent) => {
  const wanted = new Set(ids);
  return {
    ...state,
    items: state.items.map((i) => (wanted.has(i.id) && i.sent !== sent && (!sent || !i.dupOf) ? { ...i, sent } : i)),
  };
};
export const markRunning = (state, running) => ({ ...state, running: Boolean(running) });

// A job writes everything into the folder it was started with, and so do its covers: the folder is not changed while one runs.
export const outputDirLocked = (state) => Boolean(state?.running);
export const OUTPUT_DIR_LOCKED_TEXT = "下載進行中，現在不能改存放資料夾。這一批下載完再改，新的資料夾從下一批開始使用。";

// 清除全部: only when nothing is going on any more. A video that waits, loads or downloads (or a running job) keeps the list.
export const canClearAll = (state) => Boolean(state?.items?.length) && !state.running
  && !state.items.some((i) => i.status === "fetching" || i.status === "downloading" || (i.status === "waiting" && !i.dupOf));
export const clearAll = (state) => (canClearAll(state) ? withItems(state, []) : state);

export const pendingDownloads = (state) => state.items
  .filter((i) => i.status === "waiting" && !i.dupOf && i.id)
  .map((i) => ({ id: i.id, url: i.url, title: i.title }));

// The host's job is over: rows it was still working on go back to waiting, and nothing counts as sent any more.
const resetInterrupted = (items) => items.map((i) => {
  if (i.status === "downloading") return { ...i, status: "waiting", percent: null, speed: null, eta: null, sent: false };
  return i.sent ? { ...i, sent: false } : i;
});

export function hostLost(state) {
  return { ...state, running: false, cooldown: null, hostConnected: false, hostOutdated: false, items: resetInterrupted(state.items) };
}

export function applyHostEvent(state, event, now) {
  const live = (id) => state.items.find((i) => i.id === id && !i.dupOf && (i.status === "waiting" || i.status === "downloading"));
  const patch = (id, fields) => {
    const target = live(id);
    return target ? state.items.map((i) => (i.uid === target.uid ? { ...i, ...fields } : i)) : null;
  };
  const endCooldown = (id) => (state.cooldown && state.cooldown.nextId === id ? null : state.cooldown);
  switch (event.type) {
    case "started":
      return { ...state, running: true, cooldown: null, aborted: null };
    case "progress": {
      const items = patch(event.itemId, {
        status: "downloading", percent: event.percent ?? live(event.itemId)?.percent ?? null,
        speed: event.speed ?? null, eta: event.eta ?? null,
      });
      return items ? { ...state, items, running: true, cooldown: endCooldown(event.itemId) } : state;
    }
    case "item_done": {
      const outDir = typeof event.outDir === "string" && event.outDir ? event.outDir : null; // (added by the controller)
      const fields = event.skipped
        ? { status: "skipped", file: event.file ?? null, outDir, percent: null, speed: null, eta: null, sent: false }
        : { status: "done", percent: 100, speed: null, eta: null, file: event.file ?? null, outDir, height: event.height ?? null, sent: false };
      const items = patch(event.itemId, fields);
      return items ? { ...state, items, cooldown: endCooldown(event.itemId) } : state;
    }
    case "item_failed": {
      const items = patch(event.itemId, { status: "failed", error: event.reason ?? "失敗", percent: null, speed: null, eta: null, sent: false });
      return items ? { ...state, items, cooldown: endCooldown(event.itemId) } : state;
    }
    case "item_removed": {
      const target = live(event.itemId);
      if (!target) return state;
      return { ...withItems(state, state.items.filter((i) => i.uid !== target.uid)), cooldown: endCooldown(event.itemId) };
    }
    case "cooldown":
      return { ...state, cooldown: { until: now + Number(event.seconds) * 1000, nextId: event.nextId } };
    case "done": // rows the host never got to (it stopped on purpose) were not touched: they stay waiting
      return { ...state, running: false, cooldown: null, aborted: cleanAborted(event.summary?.aborted), items: resetInterrupted(state.items) };
    default:
      return state;
  }
}

export function describeItem(state, item, now) {
  const same = sameTitleRows(state).get(item.uid) ?? 0;
  const hint = [same ? `標題與第 ${same} 支相同（不同影片）` : "", item.limitHit ? `已達上限 ${item.limitHit} 支，頻道或播放清單可能還有更多；要更多請調高「最多展開」` : ""];
  const base = { kind: item.status, label: "", sub: "", percent: 0, dupIndex: null, hint: hint.filter(Boolean).join(" · ") };
  if (item.dupOf) {
    const dupIndex = state.items.findIndex((i) => i.uid === item.dupOf) + 1;
    return { ...base, kind: "duplicate", label: "重複下載", sub: `與第 ${dupIndex} 筆相同，已暫停`, dupIndex };
  }
  switch (item.status) {
    case "fetching":
      return state.hostConnected
        ? { ...base, kind: "fetching", label: "抓取影片資訊中…" }
        : { ...base, kind: "waiting-host", label: "等待連線下載助手" };
    case "waiting": {
      const length = item.duration ? formatEta(item.duration) : "";
      const cooling = state.cooldown && state.cooldown.nextId === item.id && now < state.cooldown.until;
      const sub = [length, coverText(item.cover)].filter(Boolean).join(" · ");
      return cooling
        ? { ...base, kind: "cooling", label: `冷卻中，${formatWait((state.cooldown.until - now) / 1000)}後開始`, sub }
        : { ...base, kind: "waiting", label: "等待中", sub };
    }
    case "downloading": {
      const percent = item.percent ?? 0;
      const rate = item.speed ? formatSpeed(item.speed) : "";
      const left = item.eta == null ? "" : `剩餘 ${formatEta(item.eta)}`;
      return { ...base, label: item.percent == null ? "下載中…" : `下載中 ${Math.floor(percent)}%`, sub: [rate, left].filter(Boolean).join(" · "), percent };
    }
    case "done":
      return { ...base, label: "完成", sub: [item.height ? `${item.height}p` : "", coverText(item.cover)].filter(Boolean).join(" · "), percent: 100 };
    case "skipped":
      return { ...base, label: "略過", sub: ["已下載過，略過", coverText(item.cover)].filter(Boolean).join(" · "), percent: 100 };
    default:
      return { ...base, kind: "failed", label: "失敗", sub: item.error ?? "" };
  }
}

// The wait before the next video, for the chip above the list ("" when nothing is being waited for).
export function cooldownText(state, now) {
  return state.cooldown && state.cooldown.until > now ? `${formatWait((state.cooldown.until - now) / 1000)}後開始下一支` : "";
}

export function summarize(state) {
  const live = state.items.filter((i) => !i.dupOf);
  const current = live.find((i) => i.status === "downloading");
  const waiting = live.filter((i) => i.status === "waiting").length;
  return {
    total: state.items.length,
    done: live.filter((i) => i.status === "done" || i.status === "skipped").length,
    waiting,
    speed: current?.speed ?? 0,
    etaSec: current || waiting ? (current?.eta ?? 0) + waiting * state.settings.cooldownSec : 0,
  };
}
