import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS, MAX_ITEMS, QueueError, addPlaceholder, applyHostEvent, applyResolveFailed, applyResolved,
  createState, describeItem, hostLost, markRunning, pendingDownloads, removeItem, retryItem, setHostConnected,
  setSettings, setTags, summarize,
} from "../lib/queue.js";

const url = (id) => `https://www.youtube.com/watch?v=${id}`;
const ref = (id, title = `影片 ${id}`, duration = 100) => ({ id, title, url: url(id), duration });

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

// A state whose rows were added one by one and resolved (each add + resolve is one video).
function stateWith(...refs) {
  let state = setHostConnected(createState(), true);
  for (const r of refs) {
    const added = addPlaceholder(state, r.url ?? url(r.id));
    state = applyResolved(added.state, added.uid, [r]);
  }
  return state;
}
const byId = (state, id) => state.items.find((i) => i.id === id);

test("createState starts empty with the default settings", () => {
  const state = createState();
  assert.deepEqual(state.items, []);
  assert.equal(state.running, false);
  assert.equal(state.cooldown, null);
  assert.deepEqual(state.settings, DEFAULT_SETTINGS);
  assert.deepEqual(DEFAULT_SETTINGS, { quality: 1080, cooldownSec: 10, limit: 50 });
});

test("addPlaceholder inserts a fetching row and validates the url", () => {
  const { state, uid } = addPlaceholder(createState(), url("a"));
  assert.equal(state.items.length, 1);
  assert.deepEqual([state.items[0].uid, state.items[0].status, state.items[0].url, state.items[0].title], [uid, "fetching", url("a"), url("a")]);
  assert.throws(() => addPlaceholder(state, "https://evil.example/x"), (e) => e instanceof QueueError && e.code === "bad_url");
  assert.throws(() => addPlaceholder(state, "not a url"), (e) => e.code === "bad_url");
});

test("addPlaceholder refuses to go past the list limit", () => {
  let state = createState();
  for (let i = 0; i < MAX_ITEMS; i += 1) state = addPlaceholder(state, url(`v${i}`)).state;
  assert.throws(() => addPlaceholder(state, url("extra")), (e) => e.code === "queue_full");
  assert.equal(MAX_ITEMS, 500);
});

test("applyResolved replaces the placeholder with one row per video, in place", () => {
  let { state, uid } = addPlaceholder(createState(), "https://www.youtube.com/@channel");
  state = addPlaceholder(state, url("z")).state;
  state = applyResolved(state, uid, [ref("a"), ref("b"), ref("c")]);
  assert.deepEqual(state.items.map((i) => i.id), ["a", "b", "c", null]);
  assert.equal(state.items[0].uid, uid, "the first row keeps the placeholder's uid so the view does not flicker");
  assert.deepEqual(state.items.slice(0, 3).map((i) => i.status), ["waiting", "waiting", "waiting"]);
  assert.equal(state.items[0].title, "影片 a");
  assert.equal(state.items[0].duration, 100);
  assert.equal(new Set(state.items.map((i) => i.uid)).size, 4);
});

test("applyResolved turns unresolvable urls into failed rows and respects the expand limit", () => {
  let { state, uid } = addPlaceholder(createState(), url("a"));
  state = applyResolved(state, uid, [{ id: "", title: "", url: "https://www.youtube.com/watch?v=bad" }, ref("b")]);
  assert.deepEqual(state.items.map((i) => i.status), ["failed", "waiting"]);
  assert.equal(state.items[0].title, "https://www.youtube.com/watch?v=bad");
  assert.ok(state.items[0].error);

  let limited = setSettings(createState(), { limit: 2 });
  const added = addPlaceholder(limited, "https://www.youtube.com/playlist?list=x");
  limited = applyResolved(added.state, added.uid, [ref("a"), ref("b"), ref("c"), ref("d")]);
  assert.deepEqual(limited.items.map((i) => i.id), ["a", "b"]);

  const empty = addPlaceholder(createState(), url("e"));
  const none = applyResolved(empty.state, empty.uid, []);
  assert.equal(none.items[0].status, "failed");
});

test("applyResolved ignores a placeholder that no longer exists", () => {
  const { state, uid } = addPlaceholder(createState(), url("a"));
  const removed = removeItem(state, uid);
  assert.deepEqual(applyResolved(removed, uid, [ref("a")]).items, []);
  assert.deepEqual(applyResolveFailed(removed, uid, "x").items, []);
});

test("applyResolveFailed marks the placeholder failed with the reason", () => {
  const { state, uid } = addPlaceholder(createState(), url("a"));
  const failed = applyResolveFailed(state, uid, "這是私人影片");
  assert.deepEqual([failed.items[0].status, failed.items[0].error], ["failed", "這是私人影片"]);
});

test("duplicates: same id, later one points at the earliest", () => {
  const state = stateWith(ref("a"), ref("b"), ref("a", "另一個標題"));
  assert.equal(state.items[0].dupOf, null);
  assert.equal(state.items[2].dupOf, state.items[0].uid);
  assert.deepEqual(pendingDownloads(state).map((i) => i.id), ["a", "b"]);
});

test("duplicates: same title after NFKC, trimming and case folding", () => {
  const state = stateWith(ref("a", "Hello World"), ref("b", "  ｈｅｌｌｏ world "), ref("c", "完全不同"));
  assert.equal(state.items[1].dupOf, state.items[0].uid);
  assert.equal(state.items[2].dupOf, null);
});

test("describeItem labels a duplicate and says which row it repeats", () => {
  const state = stateWith(ref("x"), ref("y"), ref("x"));
  const info = describeItem(state, state.items[2], 0);
  assert.equal(info.kind, "duplicate");
  assert.equal(info.label, "重複下載");
  assert.equal(info.sub, "與第 1 筆相同，已暫停");
  assert.equal(info.dupIndex, 1);
  assert.equal(describeItem(state, state.items[0], 0).kind, "waiting");
});

test("removing the earliest copy promotes the next one and keeps the rest marked", () => {
  let state = stateWith(ref("a"), ref("a"), ref("a"));
  assert.deepEqual(state.items.map((i) => i.dupOf === null), [true, false, false]);
  state = removeItem(state, state.items[0].uid);
  assert.deepEqual(state.items.map((i) => i.dupOf === null), [true, false]);
  assert.equal(state.items[1].dupOf, state.items[0].uid);
  assert.equal(describeItem(state, state.items[0], 0).kind, "waiting");
  assert.deepEqual(pendingDownloads(state).map((i) => i.id), ["a"]);
});

test("rows that failed without an id take no part in duplicate detection", () => {
  let { state, uid } = addPlaceholder(createState(), url("q"));
  state = applyResolveFailed(state, uid, "x");
  const added = addPlaceholder(state, url("q"));
  state = applyResolveFailed(added.state, added.uid, "x");
  assert.deepEqual(state.items.map((i) => i.dupOf), [null, null]);
});

test("pendingDownloads lists waiting, non-duplicate rows in order with id, url and title", () => {
  let state = stateWith(ref("a"), ref("b"), ref("c"));
  state = applyHostEvent(state, { type: "item_done", itemId: "a", file: "/x/a.mp4", height: 720 }, 0);
  assert.deepEqual(pendingDownloads(state), [
    { id: "b", url: url("b"), title: "影片 b" }, { id: "c", url: url("c"), title: "影片 c" },
  ]);
});

test("host events: progress, done, skipped and failed update the matching row", () => {
  let state = stateWith(ref("a"), ref("b"), ref("c"));
  state = applyHostEvent(state, { type: "started", jobId: "j" }, 0);
  assert.equal(state.running, true);
  state = applyHostEvent(state, { type: "progress", itemId: "a", percent: 42.5, speed: 2097152, eta: 12 }, 0);
  assert.deepEqual([byId(state, "a").status, byId(state, "a").percent, byId(state, "a").speed, byId(state, "a").eta], ["downloading", 42.5, 2097152, 12]);
  state = applyHostEvent(state, { type: "item_done", itemId: "a", file: "/x/a.mp4", height: 1080, codec: "avc1" }, 0);
  assert.deepEqual([byId(state, "a").status, byId(state, "a").percent, byId(state, "a").height, byId(state, "a").file], ["done", 100, 1080, "/x/a.mp4"]);
  state = applyHostEvent(state, { type: "item_done", itemId: "b", file: "/x/b.mp4", skipped: true }, 0);
  assert.equal(byId(state, "b").status, "skipped");
  state = applyHostEvent(state, { type: "item_failed", itemId: "c", reason: "這是私人影片", code: "private" }, 0);
  assert.deepEqual([byId(state, "c").status, byId(state, "c").error], ["failed", "這是私人影片"]);
});

test("host events never touch duplicates or unknown ids", () => {
  let state = stateWith(ref("a"), ref("a"));
  state = applyHostEvent(state, { type: "progress", itemId: "a", percent: 10 }, 0);
  assert.deepEqual(state.items.map((i) => i.status), ["downloading", "waiting"]);
  const same = applyHostEvent(state, { type: "progress", itemId: "nope", percent: 10 }, 0);
  assert.deepEqual(same.items, state.items);
  assert.deepEqual(applyHostEvent(state, { type: "mystery" }, 0).items, state.items);
});

test("item_removed drops the row; the row may already be gone", () => {
  let state = stateWith(ref("a"), ref("b"));
  state = applyHostEvent(state, { type: "item_removed", itemId: "a" }, 0);
  assert.deepEqual(state.items.map((i) => i.id), ["b"]);
  assert.deepEqual(applyHostEvent(state, { type: "item_removed", itemId: "a" }, 0).items.map((i) => i.id), ["b"]);
});

test("cooldown shows on the next row and counts down with the clock", () => {
  let state = stateWith(ref("a"), ref("b"));
  state = applyHostEvent(state, { type: "cooldown", seconds: 10, nextId: "b" }, 1000);
  assert.deepEqual(state.cooldown, { until: 11000, nextId: "b" });
  const at = (now) => describeItem(state, byId(state, "b"), now);
  assert.deepEqual([at(1000).kind, at(1000).label], ["cooling", "冷卻中，10 秒後開始"]);
  assert.equal(at(7500).label, "冷卻中，4 秒後開始");
  assert.equal(at(11000).kind, "waiting");
  assert.equal(describeItem(state, byId(state, "a"), 1000).kind, "waiting");
});

test("the next row's first progress ends the cooldown, and done clears everything", () => {
  let state = stateWith(ref("a"), ref("b"));
  state = applyHostEvent(state, { type: "cooldown", seconds: 10, nextId: "b" }, 0);
  const started = applyHostEvent(state, { type: "progress", itemId: "b", percent: 1 }, 500);
  assert.equal(started.cooldown, null);
  const failed = applyHostEvent(state, { type: "item_failed", itemId: "b", reason: "x", code: "x" }, 500);
  assert.equal(failed.cooldown, null);
  let busy = applyHostEvent(state, { type: "progress", itemId: "a", percent: 5 }, 0);
  busy = applyHostEvent(busy, { type: "done", jobId: "j", summary: {} }, 0);
  assert.equal(busy.running, false);
  assert.equal(busy.cooldown, null);
  assert.equal(byId(busy, "a").status, "waiting", "an interrupted download goes back to waiting");
  assert.equal(byId(busy, "a").percent, null);
});

test("hostLost resets the run and puts interrupted rows back to waiting", () => {
  let state = stateWith(ref("a"), ref("b"));
  state = markRunning(state, true);
  state = applyHostEvent(state, { type: "progress", itemId: "a", percent: 30, speed: 1, eta: 2 }, 0);
  state = applyHostEvent(state, { type: "cooldown", seconds: 5, nextId: "b" }, 0);
  const lost = hostLost(state);
  assert.deepEqual([lost.running, lost.cooldown, lost.hostConnected], [false, null, false]);
  assert.deepEqual([byId(lost, "a").status, byId(lost, "a").percent, byId(lost, "a").speed], ["waiting", null, null]);
});

test("createState restores a saved queue conservatively", () => {
  const saved = {
    items: [
      { uid: 5, id: "a", url: url("a"), title: "甲", status: "downloading", percent: 60, speed: 1, eta: 1 },
      { uid: 6, id: null, url: url("b"), title: url("b"), status: "fetching" },
      { uid: 7, id: "c", url: url("c"), title: "丙", status: "done", percent: 100 },
      { uid: 8, id: "a", url: url("a"), title: "甲", status: "waiting" },
      "garbage",
    ],
    running: true, cooldown: { until: 9, nextId: "c" }, hostConnected: true,
    settings: { quality: 720, cooldownSec: 99, limit: "x", extra: 1 },
  };
  const state = createState(saved);
  assert.deepEqual([state.running, state.cooldown, state.hostConnected], [false, null, false]);
  assert.deepEqual(state.items.map((i) => i.status), ["waiting", "fetching", "done", "waiting"]);
  assert.equal(state.items[0].percent, null);
  assert.equal(state.items[1].error, null, "a row that never got its title is resolved again, not failed");
  assert.equal(state.items[3].dupOf, 5, "duplicates are recomputed on restore");
  assert.deepEqual(state.settings, { quality: 720, cooldownSec: 60, limit: 50 });
  assert.equal(addPlaceholder(state, url("n")).uid, 9, "new uids continue after the saved ones");
  assert.deepEqual(createState("nope").items, []);
  assert.deepEqual(createState({ items: "x" }).items, []);
});

test("setSettings clamps values and ignores the unknown", () => {
  let state = setSettings(createState(), { quality: "720", cooldownSec: 1, limit: 5000, bogus: 1 });
  assert.deepEqual(state.settings, { quality: 720, cooldownSec: 3, limit: 1000 });
  state = setSettings(state, { quality: 480, cooldownSec: 61.4, limit: 0 });
  assert.deepEqual(state.settings, { quality: 720, cooldownSec: 60, limit: 1 });
  state = setSettings(state, { cooldownSec: "abc" });
  assert.equal(state.settings.cooldownSec, 60);
  assert.equal("bogus" in state.settings, false);
});

test("retryItem puts a failed row with an id back to waiting and ignores everything else", () => {
  let state = stateWith(ref("a"), ref("b"));
  state = applyHostEvent(state, { type: "item_failed", itemId: "a", reason: "網路", code: "network" }, 0);
  const retried = retryItem(state, state.items[0].uid);
  assert.deepEqual([retried.items[0].status, retried.items[0].error, retried.items[0].percent], ["waiting", null, null]);
  assert.deepEqual(retryItem(state, state.items[1].uid).items, state.items);
  const { state: s2, uid } = addPlaceholder(createState(), url("q"));
  const failedPlaceholder = applyResolveFailed(s2, uid, "x");
  assert.deepEqual(retryItem(failedPlaceholder, uid).items, failedPlaceholder.items);
});

test("describeItem covers every kind of row", () => {
  let state = stateWith(ref("a", "甲", 125), ref("b"), ref("c"), ref("d"));
  state = applyHostEvent(state, { type: "progress", itemId: "a", percent: 72.4, speed: 3145728, eta: 65 }, 0);
  const down = describeItem(state, byId(state, "a"), 0);
  assert.deepEqual([down.kind, down.label, down.percent], ["downloading", "下載中 72%", 72.4]);
  assert.equal(down.sub, "3.0 MB/s · 剩餘 1:05");
  state = applyHostEvent(state, { type: "item_done", itemId: "b", file: "/b.mp4", height: 720 }, 0);
  assert.deepEqual([describeItem(state, byId(state, "b"), 0).kind, describeItem(state, byId(state, "b"), 0).label, describeItem(state, byId(state, "b"), 0).sub, describeItem(state, byId(state, "b"), 0).percent], ["done", "完成", "720p", 100]);
  state = applyHostEvent(state, { type: "item_done", itemId: "c", file: "/c.mp4", skipped: true }, 0);
  assert.equal(describeItem(state, byId(state, "c"), 0).sub, "已下載過，略過");
  state = applyHostEvent(state, { type: "item_failed", itemId: "d", reason: "這是私人影片", code: "private" }, 0);
  const failed = describeItem(state, byId(state, "d"), 0);
  assert.deepEqual([failed.kind, failed.label, failed.sub], ["failed", "失敗", "這是私人影片"]);
  const waiting = describeItem(stateWith(ref("w", "甲", 125)), stateWith(ref("w", "甲", 125)).items[0], 0);
  assert.deepEqual([waiting.kind, waiting.label, waiting.sub], ["waiting", "等待中", "2:05"]);
});

test("describeItem tells fetching apart from waiting for the host", () => {
  const connected = setHostConnected(addPlaceholder(createState(), url("a")).state, true);
  assert.deepEqual([describeItem(connected, connected.items[0], 0).kind, describeItem(connected, connected.items[0], 0).label], ["fetching", "抓取影片資訊中…"]);
  const offline = setHostConnected(connected, false);
  assert.deepEqual([describeItem(offline, offline.items[0], 0).kind, describeItem(offline, offline.items[0], 0).label], ["waiting-host", "等待連線本機小程式"]);
});

test("setTags stores hashtags on the row", () => {
  const state = stateWith(ref("a"));
  assert.deepEqual(setTags(state, state.items[0].uid, ["一", "二"]).items[0].tags, ["一", "二"]);
  assert.equal(setTags(state, 999, ["x"]).items[0].tags, null);
});

test("summarize counts finished rows and estimates the time left", () => {
  let state = setSettings(stateWith(ref("a"), ref("b"), ref("c"), ref("a")), { cooldownSec: 10 });
  state = applyHostEvent(state, { type: "item_done", itemId: "a", file: "/a", height: 720 }, 0);
  state = applyHostEvent(state, { type: "progress", itemId: "b", percent: 50, speed: 2097152, eta: 30 }, 0);
  const s = summarize(state);
  assert.deepEqual([s.total, s.done, s.waiting, s.speed, s.etaSec], [4, 1, 1, 2097152, 30 + 10]);
  assert.deepEqual(summarize(createState()), { total: 0, done: 0, waiting: 0, speed: 0, etaSec: 0 });
});

test("state transitions never mutate their input", () => {
  let state = deepFreeze(stateWith(ref("a"), ref("b")));
  const { state: added, uid } = addPlaceholder(state, url("n"));
  state = applyResolved(deepFreeze(added), uid, [ref("n")]);
  state = applyHostEvent(deepFreeze(state), { type: "progress", itemId: "a", percent: 5 }, 0);
  state = removeItem(deepFreeze(state), state.items[0].uid);
  state = hostLost(deepFreeze(state));
  state = setSettings(deepFreeze(state), { quality: 720 });
  assert.equal(state.settings.quality, 720);
});
