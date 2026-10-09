import test from "node:test";
import assert from "node:assert/strict";
import { createController } from "../lib/queue-controller.js";
import { describeItem } from "../lib/queue.js";
import { toBase64 } from "../lib/base64.js";

const url = (id) => `https://www.youtube.com/watch?v=${id}`;
const idOf = (u) => new URL(u).searchParams.get("v");
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);

// A fake local host: records every request/send and answers from `replies` (value, function or Error).
function fakeHost(options = {}) {
  const h = { isConnected: true, ver: "0.2.0", requests: [], sends: [], replies: {}, ...options };
  h.connected = () => h.isConnected;
  h.version = () => h.ver;
  h.send = (message) => { h.sends.push(message); };
  h.request = async (message) => {
    h.requests.push(message);
    const reply = h.replies[message.type];
    const out = typeof reply === "function" ? await reply(message) : reply;
    if (out instanceof Error) throw out;
    return out ?? { type: "error", code: "unhandled", message: `unhandled ${message.type}` };
  };
  h.of = (type) => h.requests.filter((m) => m.type === type);
  h.replies.resolve = (m) => ({ type: "resolved", items: m.urls.map((u) => ({ id: idOf(u), title: `影片 ${idOf(u)}`, url: u, duration: 100 })) });
  h.replies.download = { type: "started", jobId: "j" };
  h.replies.enqueue = (m) => ({ type: "enqueued", count: m.items.length });
  h.replies.meta = { type: "meta", id: "a", title: "影片 a", description: "說明 #標籤一 #標籤二 #標籤三 #標籤四" };
  h.replies.remove = (m) => ({ type: "removed", itemId: m.itemId, where: "pending" });
  h.replies.save_cover = { type: "cover_saved", file: "/out/影片a.jpg" };
  return h;
}

function setup(hostOptions, extra = {}) {
  const host = fakeHost(hostOptions);
  const saved = [];
  const notified = [];
  const downloaded = [];
  const clock = { t: 0 };
  const available = extra.covers ?? {};
  const ctl = createController({
    host,
    save: (s) => saved.push(s),
    notify: (s) => notified.push(s),
    fetchFn: async (u) => {
      const hit = available[u];
      return hit ? { ok: true, status: 200, arrayBuffer: async () => hit.buffer.slice(hit.byteOffset, hit.byteOffset + hit.byteLength) } : { ok: false, status: 404 };
    },
    downloads: { download: async (options) => { downloaded.push(options); return 1; } },
    now: () => clock.t,
    initial: extra.initial ?? null,
    retryDelayMs: 0,
    ...(extra.controller ?? {}),
  });
  return { host, ctl, saved, notified, downloaded, clock };
}

async function withVideos(ids, hostOptions, extra) {
  const env = setup(hostOptions, extra);
  for (const id of ids) await env.ctl.add(url(id));
  await env.ctl.idle();
  return env;
}
const rows = (ctl) => ctl.getState().items;
const byId = (ctl, id) => rows(ctl).find((i) => i.id === id);

test("adding while the host is offline waits, then resolves once the host connects", async () => {
  const { host, ctl } = setup({ isConnected: false });
  assert.deepEqual(await ctl.add(url("a")), { ok: true });
  assert.equal(describeItem(ctl.getState(), rows(ctl)[0], 0).kind, "waiting-host");
  assert.deepEqual(host.requests, []);
  host.isConnected = true;
  await ctl.onHostConnected({ hostVersion: "0.2.0" });
  await ctl.idle();
  assert.equal(host.of("resolve").length, 1);
  assert.deepEqual([host.of("resolve")[0].urls, host.of("resolve")[0].limit], [[url("a")], 50]);
  assert.deepEqual([rows(ctl)[0].id, rows(ctl)[0].title, rows(ctl)[0].status], ["a", "影片 a", "waiting"]);
});

test("adding while connected resolves right away, and a failing resolve marks the row failed", async () => {
  const { host, ctl } = setup();
  host.replies.resolve = { type: "error", code: "private", message: "這是私人影片，沒有權限下載" };
  await ctl.add(url("p"));
  await ctl.idle();
  assert.deepEqual([rows(ctl)[0].status, rows(ctl)[0].error], ["failed", "這是私人影片，沒有權限下載"]);
});

test("a channel that comes back exactly as long as the limit says so on its last row; a short one does not", async () => {
  const { host, ctl } = setup();
  ctl.setSettings({ limit: 3 });
  host.replies.resolve = (m) => ({ type: "resolved", items: ["a", "b", "c"].map((id) => ({ id, title: `影片 ${id}`, url: url(id), duration: 1 })) });
  await ctl.add("https://www.youtube.com/@company/videos");
  await ctl.idle();
  assert.deepEqual(host.of("resolve")[0].limit, 3);
  assert.deepEqual(rows(ctl).map((i) => i.limitHit), [null, null, 3]);
  assert.equal(describeItem(ctl.getState(), rows(ctl)[2], 0).hint, "已達上限 3 支，頻道或播放清單可能還有更多；要更多請調高「最多展開」");

  const short = setup();
  short.ctl.setSettings({ limit: 5 });
  short.host.replies.resolve = host.replies.resolve;
  await short.ctl.add("https://www.youtube.com/@company/videos");
  await short.ctl.idle();
  assert.deepEqual(rows(short.ctl).map((i) => i.limitHit), [null, null, null]);
});

test("add rejects non-YouTube urls and a full list", async () => {
  const { ctl } = setup({ isConnected: false });
  const bad = await ctl.add("https://evil.example/x");
  assert.deepEqual(bad, { ok: false, error: "不是 YouTube 網址" });
  for (let i = 0; i < 500; i += 1) assert.equal((await ctl.add(url(`v${i}`))).ok, true);
  const full = await ctl.add(url("one-too-many"));
  assert.equal(full.ok, false);
  assert.match(full.error, /清單已滿/);
});

test("start sends the waiting rows in order with the chosen quality and cooldown", async () => {
  const { host, ctl } = await withVideos(["a", "b", "c"]);
  ctl.setSettings({ quality: 720, cooldownSec: 7 });
  assert.deepEqual(await ctl.start(), { ok: true });
  const [download] = host.of("download");
  assert.deepEqual(download.items, ["a", "b", "c"].map((id) => ({ id, url: url(id), title: `影片 ${id}` })));
  assert.deepEqual([download.quality, download.cooldownSec], [720, 7]);
  assert.equal(ctl.getState().running, true);
});

test("start leaves duplicates out", async () => {
  const { host, ctl } = await withVideos(["a", "b", "a"]);
  await ctl.start();
  assert.deepEqual(host.of("download")[0].items.map((i) => i.id), ["a", "b"]);
});

test("start is idempotent: two screens pressing it at once send one download", async () => {
  const { host, ctl } = await withVideos(["a", "b"]);
  const [first, second] = await Promise.all([ctl.start(), ctl.start()]);
  assert.deepEqual([first.ok, second.ok], [true, true]);
  assert.equal((await ctl.start()).ok, true);
  assert.equal(host.of("download").length, 1);
});

test("start tries again when the host says it is busy only because its last job is still wrapping up", async () => {
  const { host, ctl } = await withVideos(["a"]);
  let calls = 0;
  host.replies.download = () => (++calls < 3 ? { type: "error", code: "busy", message: "已有下載工作進行中" } : { type: "started", jobId: "j" });
  assert.deepEqual(await ctl.start(), { ok: true });
  assert.equal(host.of("download").length, 3);
  assert.equal(ctl.getState().running, true);
});

test("start gives up with the host's message when it stays busy", async () => {
  const { host, ctl } = await withVideos(["a"]);
  host.replies.download = { type: "error", code: "busy", message: "已有下載工作進行中" };
  assert.deepEqual(await ctl.start(), { ok: false, error: "已有下載工作進行中" });
  assert.equal(ctl.getState().running, false);
  assert.equal((await ctl.start()).ok, false, "and it can be tried again later");
});

test("start explains why it cannot run", async () => {
  const offline = await withVideos(["a"], { isConnected: false });
  assert.deepEqual(await offline.ctl.start(), { ok: false, error: "請先連線下載助手" });
  const old = await withVideos(["a"], { ver: "0.1.0" });
  assert.deepEqual(await old.ctl.start(), { ok: false, error: "請先更新下載助手" });
  assert.deepEqual(old.host.requests.filter((m) => m.type === "download"), []);
  const empty = setup();
  assert.deepEqual(await empty.ctl.start(), { ok: false, error: "沒有可下載的影片" });
});

test("a row added during a run is enqueued once, without pressing start again", async () => {
  const { host, ctl } = await withVideos(["a", "b"]);
  await ctl.start();
  await ctl.add(url("c"));
  await ctl.idle();
  assert.deepEqual(host.of("enqueue").map((m) => m.items.map((i) => i.id)), [["c"]]);
  ctl.onHostEvent({ type: "progress", itemId: "a", percent: 5 });
  await ctl.idle();
  assert.equal(host.of("enqueue").length, 1, "nothing is sent twice");
});

test("enqueue refused because the job just ended: restart after the done event", async () => {
  const { host, ctl } = await withVideos(["a"]);
  await ctl.start();
  host.replies.enqueue = { type: "error", code: "not_running", message: "目前沒有進行中的下載工作" };
  await ctl.add(url("c"));
  await ctl.idle();
  assert.equal(host.of("download").length, 1, "waits for the old job's done event first");
  ctl.onHostEvent({ type: "item_done", itemId: "a", file: "/a.mp4", height: 720 });
  ctl.onHostEvent({ type: "done", jobId: "j", summary: {} });
  await ctl.idle();
  const downloads = host.of("download");
  assert.equal(downloads.length, 2);
  assert.deepEqual(downloads[1].items.map((i) => i.id), ["c"]);
});

test("enqueue refused after the done event was already seen: start a new job right away", async () => {
  const { host, ctl } = await withVideos(["a"]);
  await ctl.start();
  host.replies.enqueue = async () => {
    ctl.onHostEvent({ type: "item_done", itemId: "a", file: "/a.mp4", height: 720 });
    ctl.onHostEvent({ type: "done", jobId: "j", summary: {} });
    return { type: "error", code: "not_running", message: "x" };
  };
  await ctl.add(url("c"));
  await ctl.idle();
  assert.deepEqual(host.of("download").map((m) => m.items.map((i) => i.id)), [["a"], ["c"]]);
});

const ABORTED = { code: "too_many_failures", message: "連續 3 支影片失敗，已停止下載" };

test("a job the host stopped on purpose keeps the rows it never tried waiting, shows why, and is not restarted by itself", async () => {
  const { host, ctl } = await withVideos(["a", "b", "c"]);
  await ctl.start();
  host.replies.enqueue = { type: "error", code: "not_running", message: "目前沒有進行中的下載工作" };
  await ctl.add(url("d")); // joins just as the host stops: a restart is pending for it
  await ctl.idle();
  ctl.onHostEvent({ type: "item_failed", itemId: "a", reason: "網路連線失敗", code: "network" });
  ctl.onHostEvent({ type: "done", jobId: "j", summary: { ok: 0, failed: 1, aborted: ABORTED } });
  await ctl.idle();
  assert.equal(host.of("download").length, 1, "starting again would hit the same trouble: the person decides");
  const state = ctl.getState();
  assert.equal(state.running, false);
  assert.deepEqual(state.aborted, ABORTED);
  assert.deepEqual(rows(ctl).map((i) => i.status), ["failed", "waiting", "waiting", "waiting"]);
  assert.deepEqual(rows(ctl).map((i) => i.sent), [false, false, false, false]);
});

test("an enqueue refused after the host stopped the job on purpose does not start a new job by itself", async () => {
  const { host, ctl } = await withVideos(["a", "b"]);
  await ctl.start();
  host.replies.enqueue = async () => {
    ctl.onHostEvent({ type: "item_failed", itemId: "a", reason: "x", code: "disk_full" });
    ctl.onHostEvent({ type: "done", jobId: "j", summary: { aborted: ABORTED } });
    return { type: "error", code: "not_running", message: "x" };
  };
  await ctl.add(url("c"));
  await ctl.idle();
  assert.equal(host.of("download").length, 1, "the same trouble would hit again at once: the person decides");
  assert.deepEqual(rows(ctl).map((i) => i.status), ["failed", "waiting", "waiting"]);
});

test("after an aborted job the waiting rows can be started again, and the note goes when the new job starts", async () => {
  const { host, ctl } = await withVideos(["a", "b"]);
  await ctl.start();
  ctl.onHostEvent({ type: "item_failed", itemId: "a", reason: "x", code: "network" });
  ctl.onHostEvent({ type: "done", jobId: "j", summary: { aborted: ABORTED } });
  assert.deepEqual(ctl.getState().aborted, ABORTED);
  assert.deepEqual(await ctl.start(), { ok: true });
  assert.deepEqual(host.of("download")[1].items.map((i) => i.id), ["b"], "only what is still waiting");
  ctl.onHostEvent({ type: "started", jobId: "j2" });
  assert.equal(ctl.getState().aborted, null);
});

test("a done event without an aborted note still restarts rows that raced with it", async () => {
  const { host, ctl } = await withVideos(["a"]);
  await ctl.start();
  host.replies.enqueue = { type: "error", code: "not_running", message: "x" };
  await ctl.add(url("c"));
  await ctl.idle();
  ctl.onHostEvent({ type: "item_done", itemId: "a", file: "/a.mp4", height: 720 });
  ctl.onHostEvent({ type: "done", jobId: "j", summary: { ok: 1, aborted: null } });
  await ctl.idle();
  assert.deepEqual(host.of("download").map((m) => m.items.map((i) => i.id)), [["a"], ["c"]]);
});

test("stop does not trigger a restart", async () => {
  const { host, ctl } = await withVideos(["a"]);
  await ctl.start();
  host.replies.enqueue = { type: "error", code: "not_running", message: "x" };
  await ctl.add(url("c"));
  await ctl.idle();
  ctl.stop();
  assert.deepEqual(host.sends, [{ type: "cancel" }]);
  ctl.onHostEvent({ type: "done", jobId: "j", summary: { cancelled: true } });
  await ctl.idle();
  assert.equal(host.of("download").length, 1);
  assert.equal(ctl.getState().running, false);
});

test("a slow playlist that lands the same video in front of a row already handed to the host neither hides that row nor sends its twin", async () => {
  const { host, ctl } = setup();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  host.replies.resolve = async (m) => {
    if (idOf(m.urls[0]) === "list") await gate;
    return { type: "resolved", items: [{ id: "b", title: "影片 b", url: url("b"), duration: 1 }] }; // the playlist holds video b too
  };
  await ctl.add(url("list"));
  await ctl.add(url("b"));
  while (rows(ctl).filter((i) => i.id === "b").length < 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await ctl.start(), { ok: true });
  release();
  await ctl.idle();
  assert.deepEqual(rows(ctl).map((i) => [i.id, i.dupOf === null]), [["b", false], ["b", true]]);
  assert.equal(describeItem(ctl.getState(), rows(ctl)[0], 0).kind, "duplicate");
  assert.deepEqual(host.of("download")[0].items.map((i) => i.id), ["b"]);
  assert.deepEqual(host.of("enqueue"), [], "the twin is not sent");
  ctl.onHostEvent({ type: "progress", itemId: "b", percent: 10 });
  assert.deepEqual(rows(ctl).map((i) => i.status), ["waiting", "downloading"], "progress still reaches the row that is really downloading");
});

test("a slow playlist that lands while the download request is still in flight does not hide the row being sent", async () => {
  const { host, ctl } = setup();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  host.replies.resolve = async (m) => {
    if (idOf(m.urls[0]) === "list") await gate;
    return { type: "resolved", items: [{ id: "b", title: "影片 b", url: url("b"), duration: 1 }] };
  };
  await ctl.add(url("list"));
  await ctl.add(url("b"));
  while (rows(ctl).filter((i) => i.id === "b").length < 1) await new Promise((resolve) => setImmediate(resolve));
  host.replies.download = async () => {
    release(); // the playlist answers before the host's "started" does
    while (rows(ctl).filter((i) => i.id === "b").length < 2) await new Promise((resolve) => setImmediate(resolve));
    return { type: "started", jobId: "j" };
  };
  assert.deepEqual(await ctl.start(), { ok: true });
  await ctl.idle();
  assert.deepEqual(rows(ctl).map((i) => [i.id, i.dupOf === null]), [["b", false], ["b", true]]);
  assert.deepEqual(host.of("enqueue"), [], "the twin is not sent");
  ctl.onHostEvent({ type: "progress", itemId: "b", percent: 10 });
  assert.deepEqual(rows(ctl).map((i) => i.status), ["waiting", "downloading"]);
});

test("two different videos with the same title are both sent to the host", async () => {
  const { host, ctl } = setup();
  host.replies.resolve = (m) => ({ type: "resolved", items: [{ id: idOf(m.urls[0]), title: "Shorts", url: m.urls[0], duration: 1 }] });
  await ctl.add(url("s1"));
  await ctl.add(url("s2"));
  await ctl.idle();
  await ctl.start();
  assert.deepEqual(host.of("download")[0].items.map((i) => i.id), ["s1", "s2"]);
});

test("rows are not left marked sent when the start request fails, or when the host turns out to be busy with a running job", async () => {
  const failing = await withVideos(["a"]);
  failing.host.replies.download = { type: "error", code: "bad", message: "x" };
  assert.equal((await failing.ctl.start()).ok, false);
  assert.deepEqual(rows(failing.ctl).map((i) => i.sent), [false]);
  failing.host.replies.download = { type: "started", jobId: "j" };
  assert.equal((await failing.ctl.start()).ok, true, "and the same row can be sent again");
  assert.deepEqual(failing.host.of("download").at(-1).items.map((i) => i.id), ["a"]);

  const busy = await withVideos(["a"]);
  busy.host.replies.download = async () => {
    busy.ctl.onHostEvent({ type: "started", jobId: "other" }); // another screen's job is already running
    return { type: "error", code: "busy", message: "已有下載工作進行中" };
  };
  assert.equal((await busy.ctl.start()).ok, true);
  await busy.ctl.idle();
  assert.deepEqual(busy.host.of("enqueue").map((m) => m.items.map((i) => i.id)), [["a"]], "it joins the job that is running");
});

test("rows enqueued during a run are marked sent too, and the marks end with the job", async () => {
  const { host, ctl } = await withVideos(["a"]);
  await ctl.start();
  await ctl.add(url("c"));
  await ctl.idle();
  assert.deepEqual(rows(ctl).map((i) => i.sent), [true, true]);
  host.replies.enqueue = { type: "error", code: "busy", message: "x" };
  await ctl.add(url("d"));
  await ctl.idle();
  assert.equal(byId(ctl, "d").sent, false, "a refused enqueue leaves the row unsent");
  ctl.onHostEvent({ type: "done", jobId: "j", summary: {} });
  assert.deepEqual(rows(ctl).map((i) => i.sent), [false, false, false]);
});

test("stop pressed while the start request is still in flight cancels the job as soon as it has started", async () => {
  const { host, ctl } = await withVideos(["a"]);
  host.replies.download = async () => {
    ctl.stop(); // the host has not answered yet: nothing is running as far as the list knows
    assert.deepEqual(host.sends, [], "nothing to cancel yet");
    return { type: "started", jobId: "j" };
  };
  assert.deepEqual(await ctl.start(), { ok: true });
  assert.deepEqual(host.sends, [{ type: "cancel" }]);
  ctl.onHostEvent({ type: "done", jobId: "j", summary: { cancelled: true } });
  await ctl.idle();
  assert.equal(ctl.getState().running, false);
  assert.equal(host.of("download").length, 1, "a cancelled job is not restarted");
});

test("a stop that came during a start that failed does not cancel the next start", async () => {
  const { host, ctl } = await withVideos(["a"]);
  host.replies.download = async () => {
    ctl.stop();
    return { type: "error", code: "bad", message: "x" };
  };
  assert.equal((await ctl.start()).ok, false);
  host.replies.download = { type: "started", jobId: "j2" };
  assert.deepEqual(await ctl.start(), { ok: true });
  assert.deepEqual(host.sends, []);
  assert.equal(ctl.getState().running, true);
});

test("removing the earliest copy during a run enqueues the duplicate that was promoted", async () => {
  const { host, ctl } = await withVideos(["a", "b", "a"]);
  await ctl.start();
  ctl.remove(rows(ctl)[0].uid);
  await ctl.idle();
  assert.deepEqual(host.of("remove").map((m) => m.itemId), ["a"]);
  assert.deepEqual(host.of("enqueue").map((m) => m.items.map((i) => i.id)), [["a"]]);
});

test("the host's item_removed for a row the user removed does not take its promoted duplicate with it", async () => {
  const { host, ctl } = await withVideos(["a", "b", "a"]);
  await ctl.start();
  ctl.onHostEvent({ type: "progress", itemId: "a", percent: 5 });
  host.replies.remove = (m) => ({ type: "removed", itemId: m.itemId, where: "current" });
  ctl.remove(rows(ctl)[0].uid);
  await ctl.idle();
  assert.deepEqual(rows(ctl).map((i) => i.id), ["b", "a"], "the duplicate took over the first row's place");
  ctl.onHostEvent({ type: "item_removed", itemId: "a" }); // the host confirms the cancelled download
  assert.deepEqual(rows(ctl).map((i) => i.id), ["b", "a"]);
  assert.deepEqual(host.of("enqueue").map((m) => m.items.map((i) => i.id)), [["a"]], "and it was sent exactly once");
  ctl.onHostEvent({ type: "item_removed", itemId: "a" }); // a later, unrelated removal of the same video still works
  assert.deepEqual(rows(ctl).map((i) => i.id), ["b"]);
});

test("retrying a failed row during a run enqueues it again", async () => {
  const { host, ctl } = await withVideos(["a", "b"]);
  await ctl.start();
  ctl.onHostEvent({ type: "item_failed", itemId: "a", reason: "網路", code: "network" });
  ctl.retry(byId(ctl, "a").uid);
  await ctl.idle();
  assert.deepEqual(host.of("enqueue").map((m) => m.items.map((i) => i.id)), [["a"]]);
  assert.equal(byId(ctl, "a").status, "waiting");
});

test("removing tells the host only about rows it was given", async () => {
  const { host, ctl } = await withVideos(["a", "b"]);
  ctl.remove(byId(ctl, "a").uid);
  await ctl.idle();
  assert.deepEqual(host.of("remove"), [], "nothing was started yet");
  await ctl.start();
  ctl.onHostEvent({ type: "progress", itemId: "b", percent: 3 });
  ctl.remove(byId(ctl, "b").uid);
  await ctl.idle();
  assert.deepEqual(host.of("remove").map((m) => m.itemId), ["b"]);
  assert.deepEqual(rows(ctl), []);
});

test("host events drive the rows and every change is saved and broadcast", async () => {
  const { host, ctl, saved, notified, clock } = await withVideos(["a", "b"]);
  const before = saved.length;
  await ctl.start();
  ctl.onHostEvent({ type: "progress", itemId: "a", percent: 50, speed: 1048576, eta: 4 });
  ctl.onHostEvent({ type: "item_done", itemId: "a", file: "/a.mp4", height: 720 });
  clock.t = 1000;
  ctl.onHostEvent({ type: "cooldown", seconds: 5, nextId: "b" });
  assert.deepEqual(ctl.getState().cooldown, { until: 6000, nextId: "b" });
  ctl.onHostEvent({ type: "item_failed", itemId: "b", reason: "x", code: "x" });
  ctl.onHostEvent({ type: "done", jobId: "j", summary: {} });
  assert.deepEqual(rows(ctl).map((i) => i.status), ["done", "failed"]);
  assert.equal(ctl.getState().running, false);
  assert.ok(saved.length > before && notified.length === saved.length);
  assert.equal(host.of("enqueue").length, 0);
});

test("a host disconnect ends the run, puts interrupted rows back and allows starting again", async () => {
  const { host, ctl } = await withVideos(["a", "b"]);
  await ctl.start();
  ctl.onHostEvent({ type: "progress", itemId: "a", percent: 30 });
  host.isConnected = false;
  ctl.onHostDisconnected();
  const state = ctl.getState();
  assert.deepEqual([state.running, state.hostConnected, state.cooldown], [false, false, null]);
  assert.deepEqual(rows(ctl).map((i) => i.status), ["waiting", "waiting"]);
  host.isConnected = true;
  await ctl.onHostConnected({});
  await ctl.start();
  assert.deepEqual(host.of("download").map((m) => m.items.map((i) => i.id)), [["a", "b"], ["a", "b"]]);
});

test("copyText asks the host for the description once and keeps the hashtags", async () => {
  const { host, ctl } = await withVideos(["a"]);
  const first = await ctl.copyText(rows(ctl)[0].uid);
  assert.deepEqual(first, { ok: true, text: "【影片 a】\n\n#標籤一 #標籤二 #標籤三", tagCount: 3 });
  assert.deepEqual(host.of("meta").map((m) => m.url), [url("a")]);
  const second = await ctl.copyText(rows(ctl)[0].uid);
  assert.deepEqual(second, first);
  assert.equal(host.of("meta").length, 1);
  assert.deepEqual(rows(ctl)[0].tags, ["標籤一", "標籤二", "標籤三", "標籤四"], "every tag is kept; three are picked when the text is made");
});

test("copyText with no hashtags copies just the title, and needs the host otherwise", async () => {
  const none = await withVideos(["a"]);
  none.host.replies.meta = { type: "meta", id: "a", title: "影片 a", description: "沒有任何標籤" };
  assert.deepEqual(await none.ctl.copyText(rows(none.ctl)[0].uid), { ok: true, text: "【影片 a】", tagCount: 0 });
  const offline = await withVideos(["a"]);
  offline.host.isConnected = false;
  assert.deepEqual(await offline.ctl.copyText(rows(offline.ctl)[0].uid), { ok: false, error: "請先連線下載助手" });
  const failing = await withVideos(["a"]);
  failing.host.replies.meta = { type: "error", code: "network", message: "網路連線失敗或逾時，請稍後再試" };
  assert.deepEqual(await failing.ctl.copyText(rows(failing.ctl)[0].uid), { ok: false, error: "網路連線失敗或逾時，請稍後再試" });
  assert.equal((await failing.ctl.copyText(999)).ok, false);
});

test("an old host is flagged in the state when it connects, and the flag follows the host", async () => {
  const { host, ctl } = setup({ isConnected: false, ver: "0.1.0" });
  assert.equal(ctl.getState().hostOutdated, false);
  host.isConnected = true;
  await ctl.onHostConnected({ hostVersion: "0.1.0" });
  assert.deepEqual([ctl.getState().hostConnected, ctl.getState().hostOutdated], [true, true]);
  ctl.onHostDisconnected();
  assert.deepEqual([ctl.getState().hostConnected, ctl.getState().hostOutdated], [false, false]);
  host.ver = "0.2.0";
  host.isConnected = true;
  await ctl.onHostConnected({ hostVersion: "0.2.0" });
  assert.deepEqual([ctl.getState().hostConnected, ctl.getState().hostOutdated], [true, false]);
});

test("a host that was updated while the page was open is no longer flagged", async () => {
  const env = setup({ ver: "0.1.0" });
  await env.ctl.add(url("a")); // adding refreshes the flags from the host
  assert.equal(env.ctl.getState().hostOutdated, true);
  env.host.ver = "0.2.0";
  await env.ctl.add(url("b"));
  assert.equal(env.ctl.getState().hostOutdated, false);
});

test("copyText says the host must be updated instead of showing the host's unknown-message error", async () => {
  const old = await withVideos(["a"], { ver: "0.1.0" });
  assert.deepEqual(await old.ctl.copyText(rows(old.ctl)[0].uid), { ok: false, error: "請先更新下載助手" });
  assert.deepEqual(old.host.of("meta"), [], "the old host is never sent a message it does not know");
});

const coverUrl = (id, name) => `https://i.ytimg.com/vi/${id}/${name}.jpg`;

test("downloadCover saves through the host when it is connected", async () => {
  const env = setup({}, { covers: { [coverUrl("a", "hq720")]: JPEG } });
  await env.ctl.add(url("a"));
  await env.ctl.idle();
  const result = await env.ctl.downloadCover(rows(env.ctl)[0].uid);
  assert.deepEqual(result, { ok: true, where: "folder", file: "/out/影片a.jpg" });
  assert.deepEqual(env.host.of("save_cover"), [{ type: "save_cover", id: "a", title: "影片 a", data: toBase64(JPEG) }]);
  assert.deepEqual(env.downloaded, []);
});

test("downloadCover falls back to a browser download without the host or with an old one", async () => {
  for (const options of [{ isConnected: false }, { ver: "0.1.0" }]) {
    const env = setup(options, { covers: { [coverUrl("a", "maxresdefault")]: JPEG } });
    await env.ctl.add(url("a"));
    env.host.isConnected = true;
    await env.ctl.onHostConnected({});
    await env.ctl.idle();
    env.host.isConnected = options.isConnected !== false;
    const result = await env.ctl.downloadCover(rows(env.ctl)[0].uid);
    assert.deepEqual(result, { ok: true, where: "downloads" }, JSON.stringify(options));
    assert.deepEqual(env.downloaded, [{ url: coverUrl("a", "maxresdefault"), filename: "影片a.jpg", conflictAction: "uniquify" }]);
    assert.deepEqual(env.host.of("save_cover"), []);
  }
});

test("downloadCover reports a video without any cover", async () => {
  const env = setup({}, { covers: {} });
  await env.ctl.add(url("a"));
  await env.ctl.idle();
  assert.deepEqual(await env.ctl.downloadCover(rows(env.ctl)[0].uid), { ok: false, error: "找不到封面圖片" });
});

test("rows that were still waiting for the host survive a service-worker restart and resolve when it connects", async () => {
  const first = setup({ isConnected: false });
  await first.ctl.add(url("a"));
  await first.ctl.add(url("b"));
  const saved = JSON.parse(JSON.stringify(first.saved.at(-1)));
  const second = setup({ isConnected: false }, { initial: saved });
  assert.deepEqual(rows(second.ctl).map((i) => i.status), ["fetching", "fetching"]);
  second.host.isConnected = true;
  await second.ctl.onHostConnected({});
  await second.ctl.idle();
  assert.deepEqual(rows(second.ctl).map((i) => [i.id, i.status]), [["a", "waiting"], ["b", "waiting"]]);
});

test("at most two resolve requests are in flight at once, in list order", async () => {
  const { host, ctl } = setup();
  let inFlight = 0;
  let peak = 0;
  const gates = [];
  host.replies.resolve = (m) => new Promise((resolve) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    gates.push(() => {
      inFlight -= 1;
      resolve({ type: "resolved", items: [{ id: idOf(m.urls[0]), title: `影片 ${idOf(m.urls[0])}`, url: m.urls[0], duration: 1 }] });
    });
  });
  for (const id of ["a", "b", "c", "d", "e"]) await ctl.add(url(id));
  assert.equal(host.of("resolve").length, 2, "only two started");
  gates.shift()();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(host.of("resolve").length, 3, "finishing one lets the next start");
  while (gates.length || host.of("resolve").length < 5) {
    if (gates.length) gates.shift()();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await ctl.idle();
  assert.equal(peak, 2);
  assert.deepEqual(host.of("resolve").map((m) => idOf(m.urls[0])), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(rows(ctl).map((i) => i.status), ["waiting", "waiting", "waiting", "waiting", "waiting"]);
});

test("the queue is restored from saved state", async () => {
  const first = await withVideos(["a", "b"]);
  const saved = first.saved.at(-1);
  const second = setup({}, { initial: JSON.parse(JSON.stringify(saved)) });
  assert.deepEqual(rows(second.ctl).map((i) => i.id), ["a", "b"]);
  assert.equal(second.ctl.getState().running, false);
});

// ---- the cover of a finished video is saved by itself (setting "autoCover", on by default) ----

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(condition, what) { // a bounded wait: a missing feature fails the test instead of hanging it
  for (let i = 0; i < 200 && !condition(); i += 1) await tick();
  assert.ok(condition(), `gave up waiting for ${what}`);
}
const finish = (ctl, id, extra = {}) => ctl.onHostEvent({ type: "item_done", itemId: id, file: `/out/${id}.mp4`, height: 1080, ...extra });

async function withCovers(ids, { hostOptions, covers } = {}) {
  const env = setup(hostOptions, { covers: covers ?? Object.fromEntries(ids.map((id) => [coverUrl(id, "maxresdefault"), JPEG])) });
  for (const id of ids) await env.ctl.add(url(id));
  await env.ctl.idle();
  return env;
}

test("a finished video gets its cover saved next to it, and the row says so", async () => {
  const { host, ctl } = await withCovers(["a"]);
  finish(ctl, "a");
  await ctl.idle();
  const [request] = host.of("save_cover");
  assert.deepEqual([request.id, request.title, request.data], ["a", "影片 a", toBase64(JPEG)]);
  assert.deepEqual([byId(ctl, "a").status, byId(ctl, "a").cover], ["done", { status: "saved", where: "folder" }]);
});

test("with the setting off nothing is saved by itself, and turning it back on applies to the next videos", async () => {
  const { host, ctl } = await withCovers(["a", "b"]);
  ctl.setSettings({ autoCover: false });
  finish(ctl, "a");
  await ctl.idle();
  assert.deepEqual([host.of("save_cover"), byId(ctl, "a").cover], [[], null]);
  ctl.setSettings({ autoCover: true });
  finish(ctl, "b");
  await ctl.idle();
  assert.deepEqual(host.of("save_cover").map((m) => m.id), ["b"], "only the video that finished after it was turned back on");
});

test("a video that was skipped (already downloaded) gets no cover", async () => {
  const { host, ctl } = await withCovers(["a"]);
  finish(ctl, "a", { skipped: true });
  await ctl.idle();
  assert.deepEqual([host.of("save_cover"), byId(ctl, "a").status, byId(ctl, "a").cover], [[], "skipped", null]);
});

test("a video without any cover is still done; its row says the cover was not found", async () => {
  const { host, ctl } = await withCovers(["a"], { covers: {} });
  finish(ctl, "a");
  await ctl.idle();
  assert.deepEqual(host.of("save_cover"), []);
  assert.deepEqual([byId(ctl, "a").status, byId(ctl, "a").cover], ["done", { status: "failed", error: "找不到封面圖片" }]);
});

test("when the host cannot save the cover the row says why and the video stays done", async () => {
  const { host, ctl } = await withCovers(["a"]);
  host.replies.save_cover = { type: "error", code: "bad_path", message: "無法儲存封面：磁碟已滿" };
  finish(ctl, "a");
  await ctl.idle();
  assert.deepEqual([byId(ctl, "a").status, byId(ctl, "a").cover], ["done", { status: "failed", error: "無法儲存封面：磁碟已滿" }]);
});

test("covers are saved one after another and never hold up what the host is doing", async () => {
  const { host, ctl } = await withCovers(["a", "b", "c"]);
  const gates = [];
  host.replies.save_cover = (m) => new Promise((resolve) => gates.push({ id: m.id, resolve }));
  finish(ctl, "a");
  finish(ctl, "b");
  await until(() => gates.length > 0, "the first cover to be requested");
  await tick();
  assert.deepEqual(gates.map((g) => g.id), ["a"], "b waits for a's cover");
  assert.equal(byId(ctl, "a").cover.status, "saving");
  ctl.onHostEvent({ type: "progress", itemId: "c", percent: 5 }); // the next download goes on meanwhile
  assert.equal(byId(ctl, "c").status, "downloading");
  gates[0].resolve({ type: "cover_saved", file: "/out/a.jpg" });
  await until(() => gates.length > 1, "the second cover to be requested");
  assert.deepEqual(gates.map((g) => g.id), ["a", "b"]);
  gates[1].resolve({ type: "cover_saved", file: "/out/b.jpg" });
  await ctl.idle();
  assert.deepEqual([byId(ctl, "a").cover.status, byId(ctl, "b").cover.status], ["saved", "saved"]);
});

test("a cover still being saved when the whole run ends is finished anyway", async () => {
  const { host, ctl } = await withCovers(["a"]);
  let release;
  host.replies.save_cover = () => new Promise((resolve) => { release = resolve; });
  finish(ctl, "a");
  ctl.onHostEvent({ type: "done", jobId: "j", summary: {} });
  await until(() => release, "the cover to be requested");
  release({ type: "cover_saved", file: "/out/a.jpg" });
  await ctl.idle();
  assert.equal(byId(ctl, "a").cover.status, "saved");
});

test("a repeated video (marked as a duplicate) is covered once, and a row removed meanwhile is no problem", async () => {
  const twice = await withCovers(["a", "a"]);
  finish(twice.ctl, "a");
  await twice.ctl.idle();
  assert.equal(twice.host.of("save_cover").length, 1);
  assert.deepEqual(rows(twice.ctl).map((i) => i.cover?.status ?? null), ["saved", null]);

  const gone = await withCovers(["a"]);
  let release;
  gone.host.replies.save_cover = () => new Promise((resolve) => { release = resolve; });
  finish(gone.ctl, "a");
  await until(() => release, "the cover to be requested");
  gone.ctl.remove(rows(gone.ctl)[0].uid);
  release({ type: "cover_saved", file: "/out/a.jpg" });
  await gone.ctl.idle();
  assert.deepEqual(rows(gone.ctl), []);
});

test("the cover button records its result in the row too, including the browser-download fallback", async () => {
  const folder = await withCovers(["a"]);
  assert.equal((await folder.ctl.downloadCover(rows(folder.ctl)[0].uid)).ok, true);
  assert.deepEqual(byId(folder.ctl, "a").cover, { status: "saved", where: "folder" });

  const old = await withCovers(["a"], { hostOptions: { ver: "0.1.0" } });
  assert.equal((await old.ctl.downloadCover(rows(old.ctl)[0].uid)).where, "downloads");
  assert.deepEqual(byId(old.ctl, "a").cover, { status: "saved", where: "downloads" });

  const none = await withCovers(["a"], { covers: {} });
  assert.equal((await none.ctl.downloadCover(rows(none.ctl)[0].uid)).ok, false);
  assert.deepEqual(byId(none.ctl, "a").cover, { status: "failed", error: "找不到封面圖片" });
});

// ---- two videos whose covers would get the same name ----

async function withTitles(titles, { hostOptions } = {}) {
  const ids = Object.keys(titles);
  const env = setup(hostOptions, { covers: Object.fromEntries(ids.map((id) => [coverUrl(id, "maxresdefault"), JPEG])) });
  env.host.replies.resolve = (m) => ({ type: "resolved", items: m.urls.map((u) => ({ id: idOf(u), title: titles[idOf(u)], url: u, duration: 1 })) });
  for (const id of ids) await env.ctl.add(url(id));
  await env.ctl.idle();
  return env;
}
const SAME_START = { a: "同一個標題一二", b: "同一個標題一三" }; // the first six characters are the same

test("two different videos with the same cover name: the later one is told apart by its id, both covers are kept", async () => {
  const { host, ctl } = await withTitles(SAME_START);
  finish(ctl, "a");
  finish(ctl, "b");
  await ctl.idle();
  const [first, second] = host.of("save_cover");
  assert.equal(first.name, undefined, "the first one is called what it always was: the host names it from the title");
  assert.equal(second.name, "同一個標題一 [b]", "the host is told the name to use");
  assert.deepEqual([byId(ctl, "a").cover.status, byId(ctl, "b").cover.status], ["saved", "saved"]);
});

test("the browser-download fallback uses the told-apart name too, so nothing is overwritten or numbered by the browser", async () => {
  const { ctl, downloaded } = await withTitles(SAME_START, { hostOptions: { ver: "0.1.0" } }); // (an old host cannot save covers)
  assert.equal((await ctl.downloadCover(byId(ctl, "a").uid)).where, "downloads");
  assert.equal((await ctl.downloadCover(byId(ctl, "b").uid)).where, "downloads");
  assert.deepEqual(downloaded.map((d) => d.filename), ["同一個標題一.jpg", "同一個標題一 [b].jpg"]);
});

test("a row that comes before another with the same cover name keeps the plain name whatever order the covers are saved in", async () => {
  const { host, ctl } = await withTitles(SAME_START);
  finish(ctl, "b"); // b finishes first, but a is earlier in the list
  finish(ctl, "a");
  await ctl.idle();
  const byVideo = Object.fromEntries(host.of("save_cover").map((m) => [m.id, m.name]));
  assert.deepEqual(byVideo, { b: "同一個標題一 [b]", a: undefined });
});

test("videos with different cover names are saved as before, with no name field", async () => {
  const { host, ctl } = await withTitles({ a: "甲乙丙丁戊己庚", b: "子丑寅卯辰巳午" });
  finish(ctl, "a");
  finish(ctl, "b");
  await ctl.idle();
  assert.deepEqual(host.of("save_cover").map((m) => Object.keys(m).sort()), [["data", "id", "title", "type"], ["data", "id", "title", "type"]]);
});

// ---- the output folder of a job ----

function withFolder(initial = "/out/A", extra = {}) {
  const env = setup(extra.hostOptions, { covers: { [coverUrl("a", "maxresdefault")]: JPEG, [coverUrl("b", "maxresdefault")]: JPEG } });
  env.dir = { now: initial };
  env.host.outputDir = () => env.dir.now;
  return env;
}
async function started(env, ids = ["a", "b"]) {
  for (const id of ids) await env.ctl.add(url(id));
  await env.ctl.idle();
  await env.ctl.start();
  env.ctl.onHostEvent({ type: "started", jobId: "j" });
  return env;
}

test("a finished video remembers the folder its job was started with", async () => {
  const env = await started(withFolder("/out/A"));
  env.ctl.onHostEvent({ type: "progress", itemId: "a", percent: 5 });
  env.dir.now = "/out/B"; // changed behind the job's back
  finish(env.ctl, "a");
  await env.ctl.idle();
  assert.equal(byId(env.ctl, "a").outDir, "/out/A", "the host keeps writing the whole job into the folder it started with");
});

test("the cover goes where the video went: with the folder changed meanwhile it is not put into the new folder", async () => {
  const env = await started(withFolder("/out/A"));
  env.dir.now = "/out/B";
  finish(env.ctl, "a");
  await env.ctl.idle();
  assert.deepEqual(env.host.of("save_cover"), [], "the host would write it into /out/B, away from the video");
  assert.deepEqual(env.downloaded.map((d) => d.filename), ["影片a.jpg"]);
  assert.deepEqual(byId(env.ctl, "a").cover, { status: "saved", where: "downloads" });
});

test("the cover button on a video from an earlier job does not put the cover into the folder chosen since", async () => {
  const env = await started(withFolder("/out/A"));
  finish(env.ctl, "a");
  await env.ctl.idle();
  assert.equal(env.host.of("save_cover").length, 1, "same folder: next to the video");
  env.ctl.onHostEvent({ type: "done", jobId: "j", summary: {} });
  env.dir.now = "/out/B";
  const result = await env.ctl.downloadCover(byId(env.ctl, "a").uid);
  assert.deepEqual(result, { ok: true, where: "downloads", folderChanged: true });
  assert.equal(env.host.of("save_cover").length, 1, "nothing more went to the host");
  env.dir.now = "/out/A"; // changed back
  assert.deepEqual(await env.ctl.downloadCover(byId(env.ctl, "a").uid), { ok: true, where: "folder", file: "/out/影片a.jpg" });
});

test("a host that does not say its folder, or rows saved before this was recorded, are covered as before", async () => {
  const noFolder = await withCovers(["a"]);
  finish(noFolder.ctl, "a");
  await noFolder.ctl.idle();
  assert.equal(noFolder.host.of("save_cover").length, 1);
  assert.equal(byId(noFolder.ctl, "a").outDir, null);
  const old = withFolder("/out/B");
  await old.ctl.add(url("a"));
  await old.ctl.idle();
  assert.equal((await old.ctl.downloadCover(byId(old.ctl, "a").uid)).where, "folder", "no recorded folder: nothing to compare with");
});

test("the folder cannot be changed while a job runs or is being started, and can again afterwards", async () => {
  const env = withFolder("/out/A");
  for (const id of ["a", "b"]) await env.ctl.add(url(id));
  await env.ctl.idle();
  assert.equal(env.ctl.outputDirLocked(), false);
  let during;
  env.host.replies.download = async () => { during = env.ctl.outputDirLocked(); return { type: "started", jobId: "j" }; };
  await env.ctl.start();
  assert.equal(during, true, "while the start request is on its way");
  assert.equal(env.ctl.outputDirLocked(), true, "while the job runs");
  env.ctl.onHostEvent({ type: "done", jobId: "j", summary: {} });
  assert.equal(env.ctl.outputDirLocked(), false);
});

test("a host that goes away takes the job's folder with it", async () => {
  const env = await started(withFolder("/out/A"));
  env.host.isConnected = false;
  env.ctl.onHostDisconnected();
  assert.equal(env.ctl.outputDirLocked(), false);
  env.host.isConnected = true;
  await env.ctl.onHostConnected({});
  env.dir.now = "/out/B";
  finish(env.ctl, "a"); // a late event of a job this controller never saw start: the folder as it is now
  assert.equal(byId(env.ctl, "a").outDir, "/out/B");
});

test("clearAll empties a finished list and refuses while videos are still waiting or a job runs", async () => {
  const { ctl } = await withVideos(["a", "b"]);
  assert.deepEqual(ctl.clearAll(), { ok: false, error: "清單裡還有影片沒有處理完" });
  assert.equal(rows(ctl).length, 2);
  await ctl.start();
  ctl.onHostEvent({ type: "item_done", itemId: "a", file: "/a.mp4", height: 720 });
  ctl.onHostEvent({ type: "item_done", itemId: "b", file: "/b.mp4", height: 720 });
  assert.equal(ctl.clearAll().ok, false, "the job has not reported done yet");
  ctl.onHostEvent({ type: "done", jobId: "j", summary: { ok: 2 } });
  await ctl.idle();
  assert.deepEqual(ctl.clearAll(), { ok: true });
  assert.equal(rows(ctl).length, 0);
});

test("after clearAll the same videos can be added and downloaded again", async () => {
  const { host, ctl } = await withVideos(["a"]);
  await ctl.start();
  ctl.onHostEvent({ type: "item_done", itemId: "a", file: "/a.mp4", height: 720 });
  ctl.onHostEvent({ type: "done", jobId: "j", summary: { ok: 1 } });
  await ctl.idle();
  ctl.clearAll();
  await ctl.add(url("a"));
  await ctl.idle();
  assert.equal(rows(ctl).length, 1);
  assert.equal(byId(ctl, "a").status, "waiting");
  await ctl.start();
  assert.deepEqual(host.of("download").at(-1).items.map((i) => i.id), ["a"]);
});

// ---- 說明欄文字：每支影片自動抓，一支一支慢慢來 ----
const prefetch = (extra = {}) => ({ controller: { prefetchTags: true, tagGapMs: 4000, pause: async () => {}, ...extra } });

test("with prefetch on, every video's description is read by itself, one after another, and its tags are kept", async () => {
  const waits = [];
  const { host, ctl } = await withVideos(["a", "b", "c"], undefined, prefetch({ pause: async (ms) => { waits.push(ms); } }));
  assert.deepEqual(host.of("meta").map((m) => m.url), [url("a"), url("b"), url("c")]);
  assert.deepEqual(rows(ctl).map((r) => r.tags), Array(3).fill(["標籤一", "標籤二", "標籤三", "標籤四"]));
  assert.equal(waits.length, 2, "a pause between two reads, none after the last");
  assert.ok(waits.every((ms) => ms >= 4000 && ms <= 6000), `paced with a little jitter: ${waits}`);
});

test("prefetch is off unless asked for (the other tests and the old behaviour ask the host only on demand)", async () => {
  const { host } = await withVideos(["a"]);
  assert.equal(host.of("meta").length, 0);
});

async function addAll(env, ids) {
  for (const id of ids) await env.ctl.add(url(id));
  await env.ctl.idle();
}

test("three failed reads in a row stop the reading; the rows say why, and the copy button still tries again", async () => {
  const env = setup(undefined, prefetch());
  env.host.replies.meta = { type: "error", code: "network", message: "網路連線失敗或逾時，請稍後再試" };
  await addAll(env, ["a", "b", "c", "d", "e"]);
  assert.equal(env.host.of("meta").length, 3, "stops after three failures in a row");
  assert.deepEqual(rows(env.ctl).map((r) => r.textError), ["網路連線失敗或逾時，請稍後再試", "網路連線失敗或逾時，請稍後再試", "網路連線失敗或逾時，請稍後再試", null, null]);
  env.host.replies.meta = { type: "meta", id: "a", title: "影片 a", description: "說明 #標籤一" };
  const result = await env.ctl.copyText(rows(env.ctl)[0].uid);
  assert.equal(result.ok, true);
  assert.deepEqual([rows(env.ctl)[0].tags, rows(env.ctl)[0].textError], [["標籤一"], null]);
});

test("a success between failures starts the count again", async () => {
  const env = setup(undefined, prefetch());
  let n = 0;
  env.host.replies.meta = () => (++n % 3 === 0 ? { type: "meta", description: "#好" } : { type: "error", code: "x", message: "壞" });
  await addAll(env, ["a", "b", "c", "d", "e", "f", "g"]);
  assert.equal(env.host.of("meta").length, 7, "never three failures in a row");
});

test("nothing is read while the host is away; it starts when the host comes back", async () => {
  const env = setup({ isConnected: false }, prefetch());
  await addAll(env, ["a"]);
  assert.equal(env.host.of("meta").length, 0);
  env.host.isConnected = true;
  await env.ctl.onHostConnected({});
  await env.ctl.idle();
  assert.equal(env.host.of("meta").length, 1);
  assert.deepEqual(rows(env.ctl)[0].tags, ["標籤一", "標籤二", "標籤三", "標籤四"]);
});

test("a repeated video is read once, and reading rows that already have their tags is skipped after a restart", async () => {
  const env = setup(undefined, prefetch());
  await addAll(env, ["a", "a"]);
  assert.equal(env.host.of("meta").length, 1);
  const saved = JSON.parse(JSON.stringify(env.ctl.getState()));
  const again = setup(undefined, { ...prefetch(), initial: saved });
  await again.ctl.onHostConnected({});
  await again.ctl.idle();
  assert.equal(again.host.of("meta").length, 0);
});

test("the reading waits while the host has stopped the job on purpose", async () => {
  const env = setup(undefined, prefetch());
  await addAll(env, ["a"]);
  env.ctl.onHostEvent({ type: "done", jobId: "j", summary: { aborted: { code: "network", message: "x" } } });
  await addAll(env, ["b"]);
  assert.equal(env.host.of("meta").length, 1, "only the first video was read");
});
