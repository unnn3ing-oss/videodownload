// End-to-end check of the batch queue held by the background script: add, resolve, duplicates, ordered downloads
// with cooldown, adding and removing during a run, copy text, covers, and who may talk to the queue.
// A tab of the extension's own page is the driver. Exit codes: 0 = OK, 1 = assertion failed, 2 = UNVERIFIED.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launchExtension, registerNativeHost, root } from "./helpers.mjs";
import { startFakeYtimg } from "./fake-ytimg.mjs";

const ytimg = await startFakeYtimg({ covers: { vA: ["hq720"], vF: ["hq720"] } });
const { context, extId, work, userData } = await launchExtension({ args: ytimg.args() });
const home = path.join(work, "home");
const outDir = path.join(work, "out");
fs.mkdirSync(path.join(home, "bin"), { recursive: true });
const stub = path.join(home, "bin", "yt-dlp");
fs.copyFileSync(path.join(root, "host/tests/stub_ytdlp.py"), stub);
fs.chmodSync(stub, 0o755);
const url = (id) => `https://www.youtube.com/watch?v=${id}`;

try {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/sidepanel.html`);
  const send = (message) => page.evaluate((m) => chrome.runtime.sendMessage(m), message);
  const queue = async () => (await send({ type: "queue_get" })).state;
  const until = async (predicate, what, ms = 25000) => {
    const end = Date.now() + ms;
    for (;;) {
      const state = await queue();
      if (predicate(state)) return state;
      assert.ok(Date.now() < end, `timed out waiting for ${what}`);
      await page.waitForTimeout(100);
    }
  };
  const row = (state, id, nth = 0) => state.items.filter((i) => i.id === id)[nth];

  // 1. Host not registered yet: rows wait for it; once it runs they get titles and durations.
  assert.deepEqual(await send({ type: "queue_add", url: url("vA") }), { ok: true });
  assert.deepEqual(await send({ type: "queue_add", url: url("vB") }), { ok: true });
  let state = await queue();
  assert.deepEqual(state.items.map((i) => i.status), ["fetching", "fetching"]);
  assert.equal(state.hostConnected, false);
  assert.equal((await send({ type: "queue_add", url: "https://evil.example/x" })).ok, false);

  const wrapper = path.join(work, "host.sh");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexport YTDL_HOME="${home}"\nexport YTDL_STUB_DELAY=2\nexec python3 "${path.join(root, "host/host.py")}"\n`);
  fs.chmodSync(wrapper, 0o755);
  registerNativeHost({ userData, wrapperPath: wrapper, extId });
  await send({ type: "start" });
  state = await until((s) => s.items.length === 2 && s.items.every((i) => i.status === "waiting"), "titles to arrive");
  assert.deepEqual(state.items.map((i) => [i.id, i.title, i.duration]), [["vA", "影片 vA", 222], ["vB", "影片 vB", 222]]);
  assert.equal(state.hostConnected, true);

  // 2. Duplicates are marked, not removed; only the same video id counts (same1 and same2 share a title but are different videos).
  await send({ type: "queue_add", url: url("vA") });
  await send({ type: "queue_add", url: url("same1") });
  await send({ type: "queue_add", url: url("same2") });
  state = await until((s) => s.items.length === 5 && s.items.every((i) => i.status !== "fetching"), "duplicates to resolve");
  assert.equal(state.items[2].dupOf, state.items[0].uid);
  assert.equal(state.items[4].dupOf, null);
  assert.deepEqual(state.items.map((i) => i.dupOf === null), [true, true, false, true, true]);

  // 3. Ordered downloads with a cooldown; a row added during the run joins it without pressing start again.
  assert.equal((await send({ type: "set_output_dir", path: outDir })).ok, true);
  await send({ type: "settings_set", settings: { cooldownSec: 3, quality: 720 } });
  state = await queue();
  assert.deepEqual([state.settings.cooldownSec, state.settings.quality], [3, 720]);
  assert.deepEqual(await send({ type: "queue_start" }), { ok: true });
  const seen = { doneA: null, startB: null, sawCooldown: false, addedC: false };
  const started = Date.now();
  for (;;) {
    state = await queue();
    const t = Date.now() - started;
    const a = row(state, "vA");
    const b = row(state, "vB");
    if (a.status === "done" && seen.doneA === null) seen.doneA = t;
    if (b.status === "downloading" && seen.startB === null) {
      seen.startB = t;
      seen.coverBeforeB = fs.existsSync(path.join(outDir, "影片vA.jpg")); // vA's cover comes before vB starts
    }
    if (state.cooldown?.nextId === "vB") seen.sawCooldown = true;
    if (a.status === "downloading" && !seen.addedC) {
      seen.addedC = true;
      assert.equal((await send({ type: "queue_add", url: url("vC") })).ok, true);
    }
    assert.ok(!(b.status === "downloading" && a.status === "waiting"), "vA goes first");
    if (!state.running && seen.addedC && state.items.every((i) => i.dupOf || ["done", "skipped", "failed"].includes(i.status))) break;
    assert.ok(t < 40000, "the run did not finish");
    await page.waitForTimeout(50);
  }
  assert.equal(seen.coverBeforeB, true, "vA's cover was already in the folder when vB started");
  assert.ok(seen.sawCooldown, "a cooldown was reported for the next row");
  assert.ok(seen.startB - seen.doneA >= 2500, `vB started ${seen.startB - seen.doneA} ms after vA finished`);
  assert.deepEqual(state.items.map((i) => [i.id, i.status]), [
    ["vA", "done"], ["vB", "done"], ["vA", "waiting"], ["same1", "done"], ["same2", "done"], ["vC", "done"],
  ]);
  assert.deepEqual(fs.readdirSync(outDir).filter((n) => n.endsWith(".mp4")).sort(),
    ["影片 vA.mp4", "影片 vB.mp4", "影片 vC.mp4", "相同標題.mp4", "相同標題 [same2].mp4"].sort());

  // 3b. Covers are saved by themselves (on by default); a video without any cover is still done; the setting turns it off.
  state = await until((s) => row(s, "vA").cover?.status === "saved", "vA's cover to be saved by itself");
  assert.equal(state.settings.autoCover, true, "on by default");
  assert.deepEqual(row(state, "vA").cover, { status: "saved", where: "folder" });
  state = await until((s) => row(s, "vB").cover?.status === "failed", "vB's missing cover to be reported");
  assert.deepEqual([row(state, "vB").status, row(state, "vB").cover.error], ["done", "找不到封面圖片"]);
  await send({ type: "settings_set", settings: { autoCover: false } });
  await send({ type: "queue_add", url: url("vF") });
  state = await until((s) => row(s, "vF")?.status === "waiting", "vF to resolve");
  await send({ type: "queue_start" });
  state = await until((s) => !s.running && row(s, "vF")?.status === "done", "vF to finish", 30000);
  await page.waitForTimeout(1500);
  assert.ok(!fs.existsSync(path.join(outDir, "影片vF.jpg")), "no cover with the setting off");
  assert.equal(row(await queue(), "vF").cover, null);
  await send({ type: "settings_set", settings: { autoCover: true } });

  // 4. Removing the row that is downloading cancels only that one; the run continues.
  await send({ type: "queue_add", url: url("vD") });
  await send({ type: "queue_add", url: url("vE") });
  state = await until((s) => row(s, "vD") && row(s, "vE") && row(s, "vE").status === "waiting", "vD and vE to resolve");
  await send({ type: "queue_start" });
  state = await until((s) => row(s, "vD").status === "downloading", "vD to start downloading");
  await send({ type: "queue_remove", uid: row(state, "vD").uid });
  state = await until((s) => !s.running && row(s, "vE")?.status === "done", "vE to finish after vD was removed", 30000);
  assert.equal(row(state, "vD"), undefined);
  assert.ok(fs.existsSync(path.join(outDir, "影片 vE.mp4")));
  assert.ok(!fs.existsSync(path.join(outDir, "影片 vD.mp4")), "the removed video was not downloaded");

  // 5. Copy text: title plus the first three hashtags, fetched from the host once.
  const vA = row(state, "vA");
  assert.deepEqual(await send({ type: "queue_copy_text", uid: vA.uid }),
    { ok: true, text: "【影片 vA】\n\n#標籤一 #標籤二 #標籤三", tagCount: 3 });

  // 6. Covers: saved next to the videos using the largest size that exists; none found is reported.
  assert.deepEqual(await send({ type: "queue_download_cover", uid: vA.uid }),
    { ok: true, where: "folder", file: path.join(outDir, "影片vA.jpg") });
  const cover = fs.readFileSync(path.join(outDir, "影片vA.jpg"));
  assert.deepEqual([...cover.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  assert.match(cover.toString("latin1"), /vA:hq720/);
  assert.deepEqual(await send({ type: "queue_download_cover", uid: row(state, "vB").uid }), { ok: false, error: "找不到封面圖片" });

  // 7. The web page may use the queue (through the content script) but not the update commands.
  await context.route("https://unnn3ing-oss.github.io/videodownload/**", (route) => route.fulfill({
    contentType: "text/html; charset=utf-8", body: "<!doctype html><title>web</title><p>web</p>" }));
  const web = await context.newPage();
  await web.goto("https://unnn3ing-oss.github.io/videodownload/");
  await web.evaluate(() => {
    window.__ext = [];
    window.addEventListener("message", (e) => { if (e.data?.source === "ytdl-ext") window.__ext.push(e.data); });
  });
  await web.evaluate(() => window.postMessage({ source: "ytdl-web", ping: true }, location.origin));
  await web.waitForFunction(() => window.__ext.some((m) => m.hello));
  await send({ type: "settings_set", settings: { limit: 51 } }); // any change is pushed to the connected page
  await web.waitForFunction(() => window.__ext.some((m) => m.push?.type === "queue_state" && m.push.state.settings.limit === 51));
  const ask = (request) => web.evaluate((r) => new Promise((resolve) => {
    const id = Math.random();
    const on = (e) => { if (e.data?.source === "ytdl-ext" && e.data.id === id) { window.removeEventListener("message", on); resolve(e.data.response); } };
    window.addEventListener("message", on);
    window.postMessage({ source: "ytdl-web", id, request: r }, location.origin);
  }), request);
  assert.deepEqual(await ask({ type: "update_commit" }), { ok: false, error: "forbidden" });
  assert.deepEqual(await ask({ type: "download", items: [] }), { ok: false, error: "forbidden" });
  const viaWeb = await ask({ type: "queue_get" });
  assert.equal(viaWeb.ok, true);
  assert.equal(viaWeb.state.items.length, (await queue()).items.length);
  console.log("OK");
} catch (error) {
  console.log(`FAIL: ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await context.close();
  await ytimg.close();
}
