import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS, MAX_ITEMS, QueueError, addPlaceholder, applyHostEvent, applyResolveFailed, applyResolved,
  OUTPUT_DIR_LOCKED_TEXT, cooldownText, createState, describeItem, hostLost, markRunning, outputDirLocked, markSent, pendingDownloads, removeItem, retryItem, setHostConnected,
  setCover, setSettings, setTags, setTagsError, summarize, canClearAll, clearAll,
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
  assert.deepEqual(DEFAULT_SETTINGS, { quality: 1080, cooldownSec: 10, limit: 50, autoCover: true });
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

const LIMIT_HINT = (n) => `已達上限 ${n} 支，頻道或播放清單可能還有更多；要更多請調高「最多展開」`;
function resolveWith(sourceUrl, limit, refs) {
  const added = addPlaceholder(setSettings(createState(), { limit }), sourceUrl);
  return applyResolved(added.state, added.uid, refs);
}
const hintsOf = (state) => state.items.map((i) => describeItem(state, i, 0).hint);

test("a channel or playlist that came back exactly as long as the limit says it may have more", () => {
  const channel = resolveWith("https://www.youtube.com/@company/videos", 2, [ref("a"), ref("b")]);
  assert.deepEqual(hintsOf(channel), ["", LIMIT_HINT(2)], "on the last row: this is where the list stops");
  const playlist = resolveWith("https://www.youtube.com/playlist?list=PL1", 3, [ref("a"), ref("b"), ref("c")]);
  assert.deepEqual(hintsOf(playlist), ["", "", LIMIT_HINT(3)]);
  const host = resolveWith("https://www.youtube.com/@company", 2, [ref("a"), ref("b"), ref("c")]); // (a host that sent more than asked)
  assert.deepEqual(hintsOf(host), ["", LIMIT_HINT(2)]);
});

test("no limit note when the list ended before the limit, or for a single video", () => {
  assert.deepEqual(hintsOf(resolveWith("https://www.youtube.com/@company", 5, [ref("a"), ref("b")])), ["", ""]);
  assert.deepEqual(hintsOf(resolveWith("https://www.youtube.com/watch?v=a&list=PL1", 1, [ref("a")])), [""], "a watch url with &list= is one video");
  assert.deepEqual(hintsOf(resolveWith("https://youtu.be/a", 1, [ref("a")])), [""]);
  assert.deepEqual(hintsOf(resolveWith("https://www.youtube.com/shorts/a", 1, [ref("a")])), [""]);
});

test("a playlist of exactly one video with the limit at 1 still gets the honest 'may have more'", () => {
  assert.deepEqual(hintsOf(resolveWith("https://www.youtube.com/playlist?list=PL1", 1, [ref("a")])), [LIMIT_HINT(1)]);
});

test("a youtube address of an unknown kind is only taken for a list when it returned several videos", () => {
  assert.deepEqual(hintsOf(resolveWith("https://www.youtube.com/@company/streams", 1, [ref("a")])), [""]);
  assert.deepEqual(hintsOf(resolveWith("https://www.youtube.com/@company/streams", 2, [ref("a"), ref("b")])), ["", LIMIT_HINT(2)]);
});

test("the limit note says nothing when the list was cut by a full queue instead (the limit was not reached)", () => {
  let state = createState();
  for (let i = 0; i < MAX_ITEMS - 1; i += 1) state = addPlaceholder(state, url(`v${i}`)).state;
  const added = addPlaceholder(setSettings(state, { limit: 5 }), "https://www.youtube.com/@company");
  const full = applyResolved(added.state, added.uid, [ref("a"), ref("b"), ref("c")]);
  assert.equal(full.items.length, MAX_ITEMS);
  assert.equal(full.items.at(-1).limitHit, null);
});

test("the limit note survives a restart, and a damaged value is dropped", () => {
  const state = resolveWith("https://www.youtube.com/@company", 2, [ref("a"), ref("b")]);
  const restored = createState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(hintsOf(restored), ["", LIMIT_HINT(2)]);
  const damaged = JSON.parse(JSON.stringify(state));
  damaged.items[1].limitHit = "lots";
  assert.deepEqual(hintsOf(createState(damaged)), ["", ""]);
});

test("the limit note and the same-title hint can both be on one row", () => {
  let { state, uid } = addPlaceholder(setSettings(createState(), { limit: 2 }), "https://www.youtube.com/@company");
  state = applyResolved(state, uid, [ref("a", "同名"), ref("b", "同名")]);
  assert.equal(describeItem(state, state.items[1], 0).hint, `標題與第 1 支相同（不同影片） · ${LIMIT_HINT(2)}`);
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

test("duplicates: the same title on a different video is not a duplicate, both are downloaded", () => {
  const state = stateWith(ref("a", "Hello World"), ref("b", "  ｈｅｌｌｏ world "), ref("c", "Shorts"), ref("d", "Shorts"), ref("e", "Private video"));
  assert.deepEqual(state.items.map((i) => i.dupOf), [null, null, null, null, null]);
  assert.deepEqual(pendingDownloads(state).map((i) => i.id), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(state.items.map((i) => describeItem(state, i, 0).kind), ["waiting", "waiting", "waiting", "waiting", "waiting"]);
});

test("duplicates: only the same video id counts, whatever the titles are", () => {
  const state = stateWith(ref("a", "同一個標題"), ref("b", "同一個標題"), ref("a", "同一個標題"), ref("b", "另一個標題"));
  assert.deepEqual(state.items.map((i) => i.dupOf === null), [true, true, false, false]);
  assert.deepEqual([state.items[2].dupOf, state.items[3].dupOf], [state.items[0].uid, state.items[1].uid]);
  assert.deepEqual(pendingDownloads(state).map((i) => i.id), ["a", "b"]);
});

test("a row whose title is the same as an earlier, different video carries a hint saying so", () => {
  const state = stateWith(ref("a", "Hello World"), ref("b", "  ｈｅｌｌｏ world "), ref("c", "完全不同"), ref("d", "HELLO WORLD"));
  const hints = state.items.map((i) => describeItem(state, i, 0).hint);
  assert.deepEqual(hints, ["", "標題與第 1 支相同（不同影片）", "", "標題與第 1 支相同（不同影片）"]);
  assert.equal(describeItem(state, state.items[1], 0).kind, "waiting", "the hint does not hold the row back");
});

test("the same-title hint is not shown on rows that are still fetching, failed without an id, or real duplicates", () => {
  let state = stateWith(ref("a", "標題"), ref("a", "標題"));
  const placeholder = addPlaceholder(state, url("q"));
  state = applyResolveFailed(placeholder.state, placeholder.uid, "x");
  const more = addPlaceholder(state, url("z"));
  state = more.state;
  assert.deepEqual(state.items.map((i) => describeItem(state, i, 0).hint), ["", "", "", ""]);
  assert.equal(describeItem(state, state.items[1], 0).kind, "duplicate");
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

// A slow playlist row sits before a later video that is already on its way; when the playlist resolves,
// the same video lands in front of it (items[0] is the playlist's copy, items[1] the one added on its own).
function slowResolveBeforeStartedVideo(prepare) {
  let state = setHostConnected(createState(), true);
  const slow = addPlaceholder(state, url("list"));
  const quick = addPlaceholder(slow.state, url("b"));
  state = applyResolved(quick.state, quick.uid, [ref("b", "影片 b")]);
  state = prepare(state);
  return applyResolved(state, slow.uid, [ref("b", "影片 b（播放清單裡的）")]);
}

test("duplicates: a later row that is downloading stays the original when an earlier row lands with its id", () => {
  const state = slowResolveBeforeStartedVideo((s) => applyHostEvent(s, { type: "progress", itemId: "b", percent: 5 }, 0));
  const [early, late] = state.items;
  assert.equal(late.dupOf, null);
  assert.equal(early.dupOf, late.uid);
  assert.equal(late.status, "downloading");
  assert.deepEqual(pendingDownloads(state), []);
});

test("duplicates: a finished row stays the original too", () => {
  const state = slowResolveBeforeStartedVideo((s) => applyHostEvent(s, { type: "item_done", itemId: "b", file: "/b.mp4" }, 0));
  const [early, late] = state.items;
  assert.deepEqual([late.dupOf, early.dupOf === late.uid], [null, true]);
});

test("duplicates: a row already handed to the host (still waiting) stays the original", () => {
  const state = slowResolveBeforeStartedVideo((s) => markSent(s, ["b"], true));
  const [early, late] = state.items;
  assert.equal(late.dupOf, null);
  assert.equal(early.dupOf, late.uid);
  assert.equal(describeItem(state, early, 0).sub, "與第 2 筆相同，已暫停");
});

test("duplicates: a row not sent yet still loses to the earlier row", () => {
  const state = slowResolveBeforeStartedVideo((s) => s);
  const [early, late] = state.items;
  assert.equal(early.dupOf, null);
  assert.equal(late.dupOf, early.uid);
});

test("markSent flags only rows that are not duplicates and is cleared when the host job ends or is lost", () => {
  let state = stateWith(ref("a"), ref("a"), ref("c"));
  state = markSent(state, ["a"], true);
  assert.deepEqual(state.items.map((i) => i.sent), [true, false, false], "the repeated row is not a sent row");
  assert.equal(state.items[1].dupOf, state.items[0].uid);
  assert.deepEqual(applyHostEvent(state, { type: "done" }, 0).items.map((i) => i.sent), [false, false, false]);
  assert.deepEqual(hostLost(state).items.map((i) => i.sent), [false, false, false]);
  assert.equal(createState(JSON.parse(JSON.stringify(state))).items[0].sent, false, "nothing is sent after a restart");
  assert.equal(markSent(state, ["a"], false).items[0].sent, false);
});

test("retrying or failing a row takes its sent mark away", () => {
  let state = markSent(stateWith(ref("a")), ["a"], true);
  state = applyHostEvent(state, { type: "item_failed", itemId: "a", reason: "x" }, 0);
  assert.equal(state.items[0].sent, false);
  state = markSent(retryItem(state, state.items[0].uid), ["a"], true);
  assert.equal(retryItem(applyHostEvent(state, { type: "item_failed", itemId: "a", reason: "y" }, 0), state.items[0].uid).items[0].sent, false);
});

test("the state knows when the connected host is too old, and forgets it when the host goes", () => {
  assert.equal(createState().hostOutdated, false);
  let state = setHostConnected(createState(), true, true);
  assert.deepEqual([state.hostConnected, state.hostOutdated], [true, true]);
  assert.equal(setHostConnected(state, true).hostOutdated, false, "outdated defaults to false");
  assert.deepEqual([hostLost(state).hostConnected, hostLost(state).hostOutdated], [false, false]);
  assert.equal(setHostConnected(state, false, true).hostOutdated, false, "a host that is not there cannot be outdated");
  assert.equal(createState(JSON.parse(JSON.stringify(state))).hostOutdated, false, "never restored from storage");
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

test("a long cooldown (the host may wait up to two minutes after failures) is shown in minutes and counts down", () => {
  let state = stateWith(ref("a"), ref("b"));
  state = applyHostEvent(state, { type: "cooldown", seconds: 120, nextId: "b" }, 0);
  const row = (now) => describeItem(state, byId(state, "b"), now);
  assert.deepEqual([row(0).kind, row(0).label], ["cooling", "冷卻中，2 分鐘後開始"]);
  assert.equal(row(30000).label, "冷卻中，1 分 30 秒後開始");
  assert.equal(row(61000).label, "冷卻中，59 秒後開始");
  assert.equal(row(120000).kind, "waiting");
  assert.equal(cooldownText(state, 0), "2 分鐘後開始下一支");
  assert.equal(cooldownText(state, 111000), "9 秒後開始下一支");
  assert.equal(cooldownText(state, 120000), "", "over: nothing to show");
  assert.equal(cooldownText(createState(), 0), "");
});

test("a cooldown event without a usable number of seconds shows nothing instead of NaN", () => {
  let state = stateWith(ref("a"), ref("b"));
  for (const seconds of [undefined, "soon", null]) {
    const next = applyHostEvent(state, { type: "cooldown", seconds, nextId: "b" }, 0);
    assert.equal(cooldownText(next, 0), "", String(seconds));
    assert.equal(describeItem(next, byId(next, "b"), 0).kind, "waiting");
  }
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

test("done with summary.aborted keeps what the host never tried waiting, ends the run and remembers why", () => {
  let state = stateWith(ref("a"), ref("b"), ref("c"));
  state = markSent(state, ["a", "b", "c"], true);
  state = applyHostEvent(state, { type: "started", jobId: "j" }, 0);
  state = applyHostEvent(state, { type: "item_failed", itemId: "a", reason: "網路連線失敗", code: "network" }, 0);
  state = applyHostEvent(state, { type: "progress", itemId: "b", percent: 5 }, 0);
  const aborted = { code: "too_many_failures", message: "連續 3 支影片失敗，已停止下載" };
  const done = applyHostEvent(state, { type: "done", jobId: "j", summary: { ok: 0, failed: 1, aborted } }, 0);
  assert.equal(done.running, false);
  assert.equal(done.cooldown, null);
  assert.deepEqual(done.aborted, aborted);
  assert.deepEqual(done.items.map((i) => i.status), ["failed", "waiting", "waiting"], "b was in flight, c never started: both go back to waiting, none is failed or done");
  assert.deepEqual(done.items.map((i) => i.sent), [false, false, false]);
  assert.deepEqual(pendingDownloads(done).map((i) => i.id), ["b", "c"], "so the next start takes them again");
  assert.equal(done.items[1].percent, null);
});

test("a normal done has no aborted note, and the next job's start clears an old one", () => {
  let state = stateWith(ref("a"));
  const aborted = { code: "disk_full", message: "磁碟已滿，已停止下載" };
  state = applyHostEvent(state, { type: "done", jobId: "j", summary: { aborted } }, 0);
  assert.deepEqual(state.aborted, aborted);
  assert.equal(applyHostEvent(state, { type: "started", jobId: "j2" }, 0).aborted, null);
  assert.equal(applyHostEvent(state, { type: "done", jobId: "j3", summary: { aborted: null } }, 0).aborted, null);
  assert.equal(applyHostEvent(createState(), { type: "done", jobId: "j", summary: {} }, 0).aborted, null);
  assert.equal(applyHostEvent(createState(), { type: "done", jobId: "j" }, 0).aborted, null, "a host that sends no summary at all");
  assert.equal(createState().aborted, null);
});

test("an aborted note without a message still says something, and nonsense is ignored", () => {
  const done = (aborted) => applyHostEvent(createState(), { type: "done", jobId: "j", summary: { aborted } }, 0).aborted;
  assert.deepEqual(done({ code: "tls" }), { code: "tls", message: "下載已中止（tls）" });
  assert.deepEqual(done({ message: "只有訊息" }), { code: "aborted", message: "只有訊息" });
  for (const junk of [undefined, null, "x", 5, [], {}, { code: 1, message: 2 }]) assert.equal(done(junk), null, JSON.stringify(junk));
});

test("the aborted note survives a restart and a lost host, and a damaged one is dropped", () => {
  const aborted = { code: "disk_full", message: "磁碟已滿，已停止下載" };
  const state = applyHostEvent(stateWith(ref("a")), { type: "done", jobId: "j", summary: { aborted } }, 0);
  assert.deepEqual(hostLost(state).aborted, aborted, "the host going away does not make the reason go away");
  assert.deepEqual(createState(JSON.parse(JSON.stringify(state))).aborted, aborted);
  assert.equal(createState({ items: [], aborted: { code: 1 } }).aborted, null);
  assert.equal(createState({ items: [], aborted: "x" }).aborted, null);
});

test("a finished or skipped row keeps the folder the controller says its video went into, and a restart keeps it", () => {
  let state = stateWith(ref("a"), ref("b"), ref("c"));
  state = applyHostEvent(state, { type: "item_done", itemId: "a", file: "/A/a.mp4", outDir: "/A" }, 0);
  state = applyHostEvent(state, { type: "item_done", itemId: "b", file: "/A/b.mp4", skipped: true, outDir: "/A" }, 0);
  state = applyHostEvent(state, { type: "item_done", itemId: "c", file: "/c.mp4" }, 0);
  assert.deepEqual(state.items.map((i) => i.outDir), ["/A", "/A", null], "a host event on its own says nothing about the folder");
  assert.deepEqual(createState(JSON.parse(JSON.stringify(state))).items.map((i) => i.outDir), ["/A", "/A", null]);
  const damaged = JSON.parse(JSON.stringify(state));
  damaged.items[0].outDir = 5;
  assert.equal(createState(damaged).items[0].outDir, null);
});

test("the output folder is locked exactly while a job runs", () => {
  const idle = stateWith(ref("a"));
  assert.equal(outputDirLocked(idle), false);
  assert.equal(outputDirLocked(applyHostEvent(idle, { type: "started", jobId: "j" }, 0)), true);
  assert.equal(outputDirLocked(applyHostEvent(applyHostEvent(idle, { type: "started", jobId: "j" }, 0), { type: "done", jobId: "j", summary: {} }, 0)), false);
  assert.equal(outputDirLocked(null), false);
  assert.match(OUTPUT_DIR_LOCKED_TEXT, /下一批/);
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
  assert.deepEqual(state.settings, { quality: 720, cooldownSec: 60, limit: 50, autoCover: true }, "saved before this setting existed: on");
  assert.equal(addPlaceholder(state, url("n")).uid, 9, "new uids continue after the saved ones");
  assert.deepEqual(createState("nope").items, []);
  assert.deepEqual(createState({ items: "x" }).items, []);
});

test("setSettings clamps values and ignores the unknown", () => {
  let state = setSettings(createState(), { quality: "720", cooldownSec: 1, limit: 5000, bogus: 1 });
  assert.deepEqual(state.settings, { quality: 720, cooldownSec: 3, limit: 1000, autoCover: true });
  state = setSettings(state, { quality: 480, cooldownSec: 61.4, limit: 0 });
  assert.deepEqual(state.settings, { quality: 720, cooldownSec: 60, limit: 1, autoCover: true });
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

test("the automatic cover setting is on by default, switches off and on, and ignores anything that is not true or false", () => {
  let state = createState();
  assert.equal(state.settings.autoCover, true);
  state = setSettings(state, { autoCover: false });
  assert.equal(state.settings.autoCover, false);
  for (const junk of ["no", 0, null, undefined, "false", {}]) {
    assert.equal(setSettings(state, { autoCover: junk }).settings.autoCover, false, `${String(junk)} changes nothing`);
  }
  assert.equal(setSettings(state, { autoCover: true }).settings.autoCover, true);
  assert.equal(setSettings(state, { quality: 720 }).settings.autoCover, false, "other settings leave it alone");
  assert.equal(createState(JSON.parse(JSON.stringify(state))).settings.autoCover, false, "restored from storage");
  assert.equal(createState({ items: [], settings: { autoCover: "x" } }).settings.autoCover, true, "a bad saved value falls back to on");
});

function doneRow() {
  let state = stateWith(ref("a"));
  state = applyHostEvent(state, { type: "item_done", itemId: "a", file: "/a.mp4", height: 1080 }, 0);
  return { state, uid: byId(state, "a").uid };
}

test("a row shows what happened to its cover next to the video's resolution", () => {
  const { state, uid } = doneRow();
  const sub = (s) => describeItem(s, byId(s, "a"), 0).sub;
  assert.equal(byId(state, "a").cover, null);
  assert.equal(sub(state), "1080p");
  assert.equal(sub(setCover(state, uid, { status: "saving" })), "1080p · 封面下載中…");
  assert.equal(sub(setCover(state, uid, { status: "saved", where: "folder" })), "1080p · 封面已存");
  assert.equal(sub(setCover(state, uid, { status: "saved", where: "downloads" })), "1080p · 封面已存到下載資料夾");
  assert.equal(sub(setCover(state, uid, { status: "failed", error: "找不到封面圖片" })), "1080p · 封面失敗：找不到封面圖片");
  assert.equal(sub(setCover(setCover(state, uid, { status: "saved", where: "folder" }), uid, null)), "1080p", "cleared again");
});

test("setCover leaves other rows and unknown rows alone, and a failed cover never changes the video's own status", () => {
  const two = stateWith(ref("a"), ref("b"));
  const next = setCover(two, two.items[1].uid, { status: "failed", error: "x" });
  assert.equal(next.items[0].cover, null);
  assert.equal(next.items[1].status, "waiting");
  assert.equal(setCover(two, 999, { status: "saved", where: "folder" }), two, "unknown row: same state back");
});

test("a cover that was still being saved when the browser closed is not shown as saving after a restart", () => {
  const { state, uid } = doneRow();
  const saving = JSON.parse(JSON.stringify(setCover(state, uid, { status: "saving" })));
  assert.equal(createState(saving).items[0].cover, null);
  const saved = JSON.parse(JSON.stringify(setCover(state, uid, { status: "saved", where: "folder" })));
  assert.deepEqual(createState(saved).items[0].cover, { status: "saved", where: "folder" });
  const failed = JSON.parse(JSON.stringify(setCover(state, uid, { status: "failed", error: "x" })));
  assert.deepEqual(createState(failed).items[0].cover, { status: "failed", error: "x" });
  const junk = JSON.parse(JSON.stringify(state));
  junk.items[0].cover = "nonsense";
  assert.equal(createState(junk).items[0].cover, null);
});

test("retrying a video forgets the old cover result", () => {
  let state = stateWith(ref("a"));
  const uid = state.items[0].uid;
  state = setCover(state, uid, { status: "saved", where: "folder" }); // (the cover button was pressed before the download)
  state = applyHostEvent(state, { type: "item_failed", itemId: "a", reason: "x" }, 0);
  assert.equal(state.items[0].status, "failed");
  assert.deepEqual(state.items[0].cover, { status: "saved", where: "folder" });
  const retried = retryItem(state, uid);
  assert.deepEqual([retried.items[0].status, retried.items[0].cover], ["waiting", null]);
});

// ---- 清除全部：只在沒有任何影片還在等、下載或載入時，而且工作不在進行中 ----
const doneEvent = (id) => ({ type: "item_done", itemId: id, file: `/${id}.mp4`, height: 720 });

test("canClearAll: an empty list has nothing to clear, a list with waiting videos is not finished", () => {
  assert.equal(canClearAll(createState()), false);
  const state = stateWith(ref("a"), ref("b"));
  assert.equal(canClearAll(state), false, "both are still waiting");
});

test("canClearAll: true once every video is done, skipped or failed and no job is running", () => {
  let state = stateWith(ref("a"), ref("b"));
  state = applyHostEvent(state, doneEvent("a"), 1);
  assert.equal(canClearAll(state), false, "b is still waiting");
  state = applyHostEvent(state, doneEvent("b"), 2);
  assert.equal(canClearAll(state), true);
  const failed = applyHostEvent(stateWith(ref("x")), { type: "item_failed", itemId: "x", reason: "網路" }, 1);
  assert.equal(canClearAll(failed), true, "failed rows are finished too");
  assert.equal(canClearAll(markRunning(state, true)), false, "never while a job runs");
});

test("canClearAll: a row that is still being read (fetching) or a held-back duplicate that has not been decided keeps the list", () => {
  const added = addPlaceholder(setHostConnected(createState(), true), url("f"));
  assert.equal(canClearAll(added.state), false, "fetching");
});

test("clearAll empties the list and keeps the settings; it does nothing while something is still going on", () => {
  const settings = { ...DEFAULT_SETTINGS, cooldownSec: 20 };
  let state = setSettings(stateWith(ref("a")), settings);
  const waiting = clearAll(state);
  assert.equal(waiting.items.length, 1, "unchanged while a video waits");
  state = applyHostEvent(state, doneEvent("a"), 1);
  const cleared = clearAll(state);
  assert.deepEqual(cleared.items, []);
  assert.equal(cleared.settings.cooldownSec, settings.cooldownSec);
  assert.equal(cleared.hostConnected, true);
  assert.equal(cleared.aborted, null);
});

// ---- 每支影片的文字（【標題】＋三個標籤）----
test("describeItem gives the text of a video: cleaned title, an empty line, the first three tags that are not the channel's own", () => {
  let state = stateWith(ref("a", "部署321天 航艦林肯號返抵母港 軍眷迎接｜TVBS新聞 @TVBSNEWS01"));
  const uid = state.items[0].uid;
  assert.deepEqual([describeItem(state, state.items[0], 0).text, describeItem(state, state.items[0], 0).textState], [null, "loading"]);
  state = setTags(state, uid, ["TVBS新聞", "TVBS直播", "TVBS新聞網", "航艦", "美軍", "林肯號", "第四"]);
  const info = describeItem(state, state.items[0], 0);
  assert.equal(info.text, "【部署321天 航艦林肯號返抵母港 軍眷迎接】\n\n#航艦 #美軍 #林肯號");
  assert.equal(info.textState, "ready");
  const none = setTags(state, uid, []);
  assert.equal(describeItem(none, none.items[0], 0).text, "【部署321天 航艦林肯號返抵母港 軍眷迎接】", "no tags: just the title");
});

test("a row that failed to get its tags says so, and a later success clears that", () => {
  let state = stateWith(ref("a"));
  const uid = state.items[0].uid;
  state = setTagsError(state, uid, "逾時");
  let info = describeItem(state, state.items[0], 0);
  assert.deepEqual([info.textState, info.textError], ["failed", "逾時"]);
  state = setTags(state, uid, ["x"]);
  info = describeItem(state, state.items[0], 0);
  assert.deepEqual([info.textState, info.textError], ["ready", null]);
});

test("a row still being read has no text yet, and a held-back duplicate shows the text of the row it repeats", () => {
  const added = addPlaceholder(setHostConnected(createState(), true), url("f"));
  assert.equal(describeItem(added.state, added.state.items[0], 0).textState, "none");
  let state = stateWith(ref("a"));
  const first = state.items[0].uid;
  const again = addPlaceholder(state, url("a"));
  state = applyResolved(again.state, again.uid, [ref("a")]);
  state = setTags(state, first, ["甲"]);
  const dup = state.items.find((i) => i.dupOf);
  assert.equal(describeItem(state, dup, 0).text, "【影片 a】\n\n#甲");
});

test("tags saved by an older version are dropped on load: they were cut at three before the channel's own tags were left out", () => {
  let state = setTags(stateWith(ref("a")), 1, ["TVBS新聞", "航艦", "美軍"]);
  const reloaded = createState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(reloaded.items[0].tags, ["TVBS新聞", "航艦", "美軍"], "this version's own tags are kept");
  const old = JSON.parse(JSON.stringify(state));
  delete old.items[0].tagsV;
  assert.equal(createState(old).items[0].tags, null);
});
