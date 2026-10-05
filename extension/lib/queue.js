// The download list as plain data. Every function takes a state and returns a new one; nothing here
// touches the browser, so the whole list behaviour is unit-tested. See the web-queue design spec.
import { isYouTubeUrl } from "./urls.js";
import { formatEta, formatSpeed } from "./format.js";

export const MAX_ITEMS = 500;
export const DEFAULT_SETTINGS = { quality: 1080, cooldownSec: 10, limit: 50 };
const STATUSES = new Set(["fetching", "waiting", "downloading", "done", "skipped", "failed"]);
const INTERRUPTED = "已中斷，請重新加入";

export class QueueError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QueueError";
    this.code = code;
  }
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function cleanSettings(patch, base = DEFAULT_SETTINGS) {
  const next = { ...base };
  if (patch && typeof patch === "object") {
    if ([720, 1080].includes(Number(patch.quality))) next.quality = Number(patch.quality);
    if (Number.isFinite(Number(patch.cooldownSec)) && patch.cooldownSec !== "" && patch.cooldownSec !== null) {
      next.cooldownSec = clamp(Math.round(Number(patch.cooldownSec)), 3, 60);
    }
    if (Number.isFinite(Number(patch.limit)) && patch.limit !== "" && patch.limit !== null) {
      next.limit = clamp(Math.round(Number(patch.limit)), 1, 1000);
    }
  }
  return next;
}

const blankItem = (uid, fields) => ({
  uid, id: null, url: "", title: "", duration: null, tags: null, status: "waiting", dupOf: null,
  percent: null, speed: null, eta: null, file: null, height: null, error: null, ...fields,
});

const titleKey = (title) => String(title ?? "").normalize("NFKC").trim().toLowerCase();

// The earliest copy stays normal; every later video with the same id or title points at it.
function markDuplicates(items) {
  const byId = new Map();
  const byTitle = new Map();
  return items.map((item) => {
    const counts = item.status !== "fetching" && (item.id || item.status !== "failed");
    if (!counts) return item.dupOf === null ? item : { ...item, dupOf: null };
    const key = titleKey(item.title);
    const original = (item.id && byId.get(item.id)) || (key && byTitle.get(key)) || null;
    if (!original) {
      if (item.id) byId.set(item.id, item.uid);
      if (key) byTitle.set(key, item.uid);
    }
    return item.dupOf === original ? item : { ...item, dupOf: original };
  });
}

const withItems = (state, items) => ({ ...state, items: markDuplicates(items) });

export function createState(saved = null) {
  const empty = { items: [], running: false, settings: { ...DEFAULT_SETTINGS }, cooldown: null, hostConnected: false, nextUid: 1 };
  if (!saved || typeof saved !== "object" || !Array.isArray(saved.items)) return empty;
  const items = [];
  for (const raw of saved.items) {
    if (!raw || typeof raw !== "object" || !Number.isInteger(raw.uid) || !STATUSES.has(raw.status)) continue;
    let item = blankItem(raw.uid, raw);
    if (item.status === "downloading") item = { ...item, status: "waiting", percent: null, speed: null, eta: null };
    if (item.status === "fetching") item = { ...item, status: "failed", error: INTERRUPTED, title: item.title || item.url };
    items.push(item);
  }
  const top = items.reduce((m, i) => Math.max(m, i.uid), 0);
  return {
    ...empty,
    items: markDuplicates(items),
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
  const chosen = refs.slice(0, Math.min(state.settings.limit, room));
  let nextUid = state.nextUid;
  const rows = chosen.map((ref, n) => {
    const rowUid = n === 0 ? uid : nextUid++;
    if (!ref.id) return blankItem(rowUid, { url: ref.url, title: ref.url, status: "failed", error: "無法解析這個網址" });
    return blankItem(rowUid, { id: ref.id, url: ref.url, title: ref.title || ref.id, duration: ref.duration ?? null });
  });
  if (!rows.length) rows.push(blankItem(uid, { url: state.items[at].url, title: state.items[at].url, status: "failed", error: "找不到影片" }));
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
    ? { ...i, status: "waiting", error: null, percent: null, speed: null, eta: null } : i)));
}

export const setSettings = (state, patch) => ({ ...state, settings: cleanSettings(patch, state.settings) });
export const setTags = (state, uid, tags) => ({ ...state, items: state.items.map((i) => (i.uid === uid ? { ...i, tags } : i)) });
export const setHostConnected = (state, connected) => ({ ...state, hostConnected: Boolean(connected) });
export const markRunning = (state, running) => ({ ...state, running: Boolean(running) });

export const pendingDownloads = (state) => state.items
  .filter((i) => i.status === "waiting" && !i.dupOf && i.id)
  .map((i) => ({ id: i.id, url: i.url, title: i.title }));

const resetInterrupted = (items) => items.map((i) => (i.status === "downloading"
  ? { ...i, status: "waiting", percent: null, speed: null, eta: null } : i));

export function hostLost(state) {
  return { ...state, running: false, cooldown: null, hostConnected: false, items: resetInterrupted(state.items) };
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
      return { ...state, running: true, cooldown: null };
    case "progress": {
      const items = patch(event.itemId, {
        status: "downloading", percent: event.percent ?? live(event.itemId)?.percent ?? null,
        speed: event.speed ?? null, eta: event.eta ?? null,
      });
      return items ? { ...state, items, running: true, cooldown: endCooldown(event.itemId) } : state;
    }
    case "item_done": {
      const fields = event.skipped
        ? { status: "skipped", file: event.file ?? null, percent: null, speed: null, eta: null }
        : { status: "done", percent: 100, speed: null, eta: null, file: event.file ?? null, height: event.height ?? null };
      const items = patch(event.itemId, fields);
      return items ? { ...state, items, cooldown: endCooldown(event.itemId) } : state;
    }
    case "item_failed": {
      const items = patch(event.itemId, { status: "failed", error: event.reason ?? "失敗", percent: null, speed: null, eta: null });
      return items ? { ...state, items, cooldown: endCooldown(event.itemId) } : state;
    }
    case "item_removed": {
      const target = live(event.itemId);
      if (!target) return state;
      return { ...withItems(state, state.items.filter((i) => i.uid !== target.uid)), cooldown: endCooldown(event.itemId) };
    }
    case "cooldown":
      return { ...state, cooldown: { until: now + Number(event.seconds) * 1000, nextId: event.nextId } };
    case "done":
      return { ...state, running: false, cooldown: null, items: resetInterrupted(state.items) };
    default:
      return state;
  }
}

export function describeItem(state, item, now) {
  const base = { kind: item.status, label: "", sub: "", percent: 0, dupIndex: null };
  if (item.dupOf) {
    const dupIndex = state.items.findIndex((i) => i.uid === item.dupOf) + 1;
    return { ...base, kind: "duplicate", label: "重複下載", sub: `與第 ${dupIndex} 筆相同，已暫停`, dupIndex };
  }
  switch (item.status) {
    case "fetching":
      return state.hostConnected
        ? { ...base, kind: "fetching", label: "抓取影片資訊中…" }
        : { ...base, kind: "waiting-host", label: "等待連線本機小程式" };
    case "waiting": {
      const length = item.duration ? formatEta(item.duration) : "";
      const cooling = state.cooldown && state.cooldown.nextId === item.id && now < state.cooldown.until;
      return cooling
        ? { ...base, kind: "cooling", label: `冷卻中，${Math.ceil((state.cooldown.until - now) / 1000)} 秒後開始`, sub: length }
        : { ...base, kind: "waiting", label: "等待中", sub: length };
    }
    case "downloading": {
      const percent = item.percent ?? 0;
      const rate = item.speed ? formatSpeed(item.speed) : "";
      const left = item.eta == null ? "" : `剩餘 ${formatEta(item.eta)}`;
      return { ...base, label: item.percent == null ? "下載中…" : `下載中 ${Math.floor(percent)}%`, sub: [rate, left].filter(Boolean).join(" · "), percent };
    }
    case "done":
      return { ...base, label: "完成", sub: item.height ? `${item.height}p` : "", percent: 100 };
    case "skipped":
      return { ...base, label: "略過", sub: "已下載過，略過", percent: 100 };
    default:
      return { ...base, kind: "failed", label: "失敗", sub: item.error ?? "" };
  }
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
