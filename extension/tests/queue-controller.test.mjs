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
  });
  return { host, ctl, saved, notified, downloaded, clock };
}

async function withVideos(ids, hostOptions) {
  const env = setup(hostOptions);
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
  assert.deepEqual(await offline.ctl.start(), { ok: false, error: "請先連線本機小程式" });
  const old = await withVideos(["a"], { ver: "0.1.0" });
  assert.deepEqual(await old.ctl.start(), { ok: false, error: "請先更新本機小程式" });
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

test("a slow playlist that lands a same-title video in front of a row already handed to the host neither hides that row nor sends its twin", async () => {
  const { host, ctl } = setup();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  host.replies.resolve = async (m) => {
    const id = idOf(m.urls[0]);
    if (id === "list") await gate;
    return { type: "resolved", items: [{ id: id === "list" ? "p" : id, title: "同一個標題", url: m.urls[0], duration: 1 }] };
  };
  await ctl.add(url("list"));
  await ctl.add(url("b"));
  while (!byId(ctl, "b")) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await ctl.start(), { ok: true });
  release();
  await ctl.idle();
  assert.deepEqual(rows(ctl).map((i) => [i.id, i.dupOf === null]), [["p", false], ["b", true]]);
  assert.equal(describeItem(ctl.getState(), byId(ctl, "p"), 0).kind, "duplicate");
  assert.deepEqual(host.of("download")[0].items.map((i) => i.id), ["b"]);
  assert.deepEqual(host.of("enqueue"), [], "the twin is not sent");
  ctl.onHostEvent({ type: "progress", itemId: "b", percent: 10 });
  assert.equal(byId(ctl, "b").status, "downloading", "progress still reaches the row that is really downloading");
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
  assert.deepEqual(first, { ok: true, text: "【影片 a】\n#標籤一 #標籤二 #標籤三", tagCount: 3 });
  assert.deepEqual(host.of("meta").map((m) => m.url), [url("a")]);
  const second = await ctl.copyText(rows(ctl)[0].uid);
  assert.deepEqual(second, first);
  assert.equal(host.of("meta").length, 1);
  assert.deepEqual(rows(ctl)[0].tags, ["標籤一", "標籤二", "標籤三"]);
});

test("copyText with no hashtags copies just the title, and needs the host otherwise", async () => {
  const none = await withVideos(["a"]);
  none.host.replies.meta = { type: "meta", id: "a", title: "影片 a", description: "沒有任何標籤" };
  assert.deepEqual(await none.ctl.copyText(rows(none.ctl)[0].uid), { ok: true, text: "【影片 a】", tagCount: 0 });
  const offline = await withVideos(["a"]);
  offline.host.isConnected = false;
  assert.deepEqual(await offline.ctl.copyText(rows(offline.ctl)[0].uid), { ok: false, error: "請先連線本機小程式" });
  const failing = await withVideos(["a"]);
  failing.host.replies.meta = { type: "error", code: "network", message: "網路連線失敗或逾時，請稍後再試" };
  assert.deepEqual(await failing.ctl.copyText(rows(failing.ctl)[0].uid), { ok: false, error: "網路連線失敗或逾時，請稍後再試" });
  assert.equal((await failing.ctl.copyText(999)).ok, false);
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
