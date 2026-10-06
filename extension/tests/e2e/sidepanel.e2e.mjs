// End-to-end check of the side panel page + background + real host (with a stub yt-dlp) in headless Chromium.
// The side panel itself cannot be opened without a real user gesture, so the page is opened as a tab.
// Exit codes: 0 = OK, 1 = assertion failed, 2 = UNVERIFIED (browser/extension could not be launched).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { HOVER_ARGS, launchExtension, manifest, registerNativeHost, root, shotter } from "./helpers.mjs";
import { startFakeYtimg } from "./fake-ytimg.mjs";

const ytimg = await startFakeYtimg({ covers: {
  v1: ["hq720", "mqdefault"], v2: ["mqdefault"], xss1: ["mqdefault"],
} });
const { context, extId, work, userData } = await launchExtension({ viewport: { width: 400, height: 860 }, args: [...ytimg.args(), ...HOVER_ARGS] });
const home = path.join(work, "home");
const outDir = path.join(work, "out");
fs.mkdirSync(path.join(home, "bin"), { recursive: true });
const stub = path.join(home, "bin", "yt-dlp");
fs.copyFileSync(path.join(root, "host/tests/stub_ytdlp.py"), stub);
fs.chmodSync(stub, 0o755);
const step = (name) => { if (process.env.E2E_VERBOSE) console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${name}`); };
const t0 = Date.now();
const watch = (id) => `https://www.youtube.com/watch?v=${id}`;

try {
  const page = await context.newPage();
  const shot = shotter(page);
  if (process.env.E2E_SCHEME) await page.emulateMedia({ colorScheme: process.env.E2E_SCHEME });
  await page.goto(`chrome-extension://${extId}/sidepanel.html`);
  const state = (s) => page.waitForFunction((x) => document.getElementById("status").dataset.state === x, s);
  const rowByTitle = (text) => page.locator(".qrow", { hasText: text });
  const queueState = () => page.evaluate(async () => (await chrome.runtime.sendMessage({ type: "queue_get" })).state);
  const add = async (url) => { await page.fill("#add-url", url); await page.click("#add-btn"); };

  // The manifest declares a side panel and no popup.
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.equal(manifest.action.default_popup, undefined);
  assert.ok(manifest.permissions.includes("sidePanel"));

  step("1. No native host registered yet");
  // 1. No native host registered yet: onboarding is shown, adding still works, downloading waits for the host.
  await page.click("#start");
  await state("not_installed");
  assert.match(await page.textContent("#status"), /尚未部署/);
  assert.equal(await page.isVisible("#setup"), true);
  await page.fill("#add-url", "http://evil.com/x");
  await page.click("#add-btn");
  await page.waitForFunction(() => /不是 YouTube 網址/.test(document.getElementById("add-note").textContent));
  await add("https://youtu.be/v1");
  await page.waitForSelector('.qrow[data-kind="waiting-host"]');
  assert.match(await page.textContent("#queue-list"), /等待連線本機小程式/);
  assert.equal(await page.isDisabled("#start-all"), true);
  assert.equal(await page.inputValue("#add-url"), "", "the box is emptied after adding");
  await shot("1-not-installed");

  step("2. Register the real host (python) wired");
  // 2. Register the real host (python) wired to the stub engine; the panel connects, the row gets its title and cover.
  const wrapper = path.join(work, "host.sh");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexport YTDL_HOME="${home}"\nexport YTDL_STUB_DELAY=2\nexec python3 "${path.join(root, "host/host.py")}"\n`);
  fs.chmodSync(wrapper, 0o755);
  registerNativeHost({ userData, wrapperPath: wrapper, extId });
  await page.click("#start");
  await state("running");
  assert.match(await page.textContent("#status"), /已啟動/);
  assert.match(await page.textContent("#engine-info"), /2099\.01\.01/);
  assert.equal(await page.isVisible("#setup"), false, "onboarding collapses once running");
  await page.waitForSelector('.qrow[data-kind="waiting"]');
  assert.match(await page.textContent("#queue-list"), /範例影片/);
  assert.match(await page.getAttribute(".qrow .qthumb", "src"), /\/vi\/v1\/mqdefault\.jpg$/);
  await page.waitForFunction(() => { const i = document.querySelector(".qrow .qthumb"); return i && i.complete && i.naturalWidth > 0; });
  await page.click("#settings > summary");
  await page.fill("#outdir", outDir);
  await page.click("#save-outdir");
  await page.waitForFunction((d) => document.getElementById("note").textContent.includes(d), outDir);
  await page.click("#settings > summary");

  step("3. A hostile title is shown as text and ");
  // 3. A hostile title is shown as text and never runs.
  await add(watch("xss1"));
  const hostile = '<img src=x onerror="window.__pwned=1">';
  await page.waitForFunction((t) => [...document.querySelectorAll(".qtitle")].some((n) => n.textContent === t), hostile);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.locator(".qtitle img").count(), 0);

  step("4. The same video again is marked as a d");
  // 4. The same video again is marked as a duplicate, not added twice.
  await add(watch("v1"));
  await page.waitForSelector('.qrow[data-kind="duplicate"]');
  assert.match(await page.textContent('.qrow[data-kind="duplicate"]'), /重複下載/);
  assert.match(await page.textContent('.qrow[data-kind="duplicate"]'), /與第 1 筆相同/);

  step("5. The current-tab card adds the page be");
  // 5. The current-tab card adds the page being viewed.
  await context.route("https://www.youtube.com/**", (route) => route.fulfill({
    contentType: "text/html; charset=utf-8", body: "<title>影片 v2 - YouTube</title><h1>stub</h1>" }));
  const yt = await context.newPage();
  await yt.goto(watch("v2"));
  await page.waitForSelector("#tab-card:not([hidden])");
  assert.match(await page.textContent("#tab-kind"), /影片/);
  await page.evaluate(() => document.getElementById("tab-add").click());
  await rowByTitle("影片 v2").first().waitFor();
  await yt.close();
  await page.bringToFront();
  await shot("2-ready");

  step("6. Settings reach the background script");
  // 6. Settings reach the background script.
  await page.click('label:has(input[name="quality"][value="720"])');
  await page.fill("#cooldown", "3");
  await page.dispatchEvent("#cooldown", "change");
  await page.waitForFunction(async () => {
    const s = (await chrome.runtime.sendMessage({ type: "queue_get" })).state.settings;
    return s.quality === 720 && s.cooldownSec === 3;
  });

  step("7. Start");
  // 7. Start: rows go one by one with progress inside the row and a cooldown in between.
  await page.click("#start-all");
  await page.waitForSelector('.qrow[data-kind="downloading"]');
  assert.match(await page.textContent('.qrow[data-kind="downloading"] .qpill'), /下載中|0%/);
  await page.waitForSelector("#cooldown-chip:not([hidden])", { timeout: 20000 });
  assert.match(await page.textContent("#cooldown-chip"), /秒後開始/);
  assert.match(await page.textContent('.qrow[data-kind="cooling"]'), /冷卻中，\d+ 秒後開始/);
  await shot("3-cooldown");
  await page.waitForFunction(() => document.querySelectorAll('.qrow[data-kind="done"]').length === 3, null, { timeout: 40000 });
  assert.equal(await page.locator('.qrow[data-kind="duplicate"]').count(), 1);
  assert.ok(fs.existsSync(path.join(outDir, "範例影片.mp4")), "downloaded file is named after the title");
  assert.ok(fs.existsSync(path.join(outDir, "影片 v2.mp4")));
  assert.deepEqual(fs.readdirSync(outDir).filter((n) => n.endsWith(".mp4")).length, 3, "the duplicate was not downloaded");
  assert.match(await page.textContent("#start-all"), /全部完成/);
  assert.match(await page.textContent("#queue-stats"), /3/);
  await shot("4-done");

  step("8. Copy text puts 【title】 and the first ");
  // 8. Copy text puts 【title】 and the first three hashtags on the clipboard.
  await rowByTitle("範例影片").first().locator(".qcopy").click();
  await page.waitForFunction(() => document.querySelector(".qrow .qcopy[data-state='ok']"));
  // read the clipboard by pasting into a scratch textarea (readText would need a permission prompt)
  await page.evaluate(() => { const t = document.createElement("textarea"); t.id = "paste-probe"; document.body.append(t); t.focus(); });
  await page.keyboard.press("Control+V");
  assert.equal(await page.inputValue("#paste-probe"), "【範例影片】\n#標籤一 #標籤二 #標籤三");
  await page.evaluate(() => document.getElementById("paste-probe").remove());

  step("9. The cover");
  // 9. The cover: grey with a download symbol on hover; a click saves the original size next to the videos.
  assert.equal(await page.evaluate(() => matchMedia("(hover: hover)").matches), true, "this browser can hover (otherwise the checks below prove nothing)");
  const cover = rowByTitle("範例影片").first().locator(".qcover");
  const thumbFilter = () => cover.locator(".qthumb").evaluate((n) => getComputedStyle(n).filter);
  const symbolOpacity = () => cover.locator(".qdl").evaluate((n) => getComputedStyle(n).opacity);
  await page.mouse.move(0, 0);
  assert.equal(await thumbFilter(), "none", "the cover is in colour without the pointer");
  assert.equal(await symbolOpacity(), "0", "and shows no symbol");
  await cover.hover();
  await page.waitForFunction(() => {
    const row = [...document.querySelectorAll(".qrow")].find((r) => r.textContent.includes("範例影片"));
    return getComputedStyle(row.querySelector(".qdl")).opacity === "1" && /grayscale/.test(getComputedStyle(row.querySelector(".qthumb")).filter);
  }, null, { timeout: 3000 });
  assert.match(await thumbFilter(), /grayscale/, "grey with the pointer over it");
  await cover.click();
  await page.waitForFunction(() => document.querySelector(".qrow .qcover[data-state='ok']"));
  const saved = fs.readFileSync(path.join(outDir, "範例影片.jpg"));
  assert.deepEqual([...saved.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  assert.match(saved.toString("latin1"), /v1:hq720/);

  step("10. The X removes a row (the duplicate h");
  // 10. The X removes a row (the duplicate here).
  await page.locator('.qrow[data-kind="duplicate"] .qx').click();
  await page.waitForFunction(() => document.querySelectorAll(".qrow").length === 3);
  assert.equal((await queueState()).items.length, 3);

  step("11. Screen readers");
  // 11. Every row's buttons say which video they belong to, messages are announced, the bar is a progress bar.
  const labels = await page.$$eval(".qrow", (rows) => rows.map((row) => ({
    copy: row.querySelector(".qcopy").getAttribute("aria-label"),
    remove: row.querySelector(".qx").getAttribute("aria-label"),
    cover: row.querySelector(".qcover").getAttribute("aria-label"),
    retry: row.querySelector(".qretry").getAttribute("aria-label"),
  })));
  assert.equal(labels.length, 3);
  for (const kind of ["copy", "remove", "cover", "retry"]) assert.equal(new Set(labels.map((l) => l[kind])).size, 3, `${kind} buttons are told apart`);
  assert.deepEqual(labels[0], { copy: "複製內文：範例影片", remove: "從清單移除：範例影片", cover: "下載封面圖片：範例影片", retry: "重試：範例影片" });
  const first = page.locator(".qrow").first();
  const bar = await first.locator(".qbar").evaluate((n) => ({
    role: n.getAttribute("role"), min: n.getAttribute("aria-valuemin"), max: n.getAttribute("aria-valuemax"),
    now: n.getAttribute("aria-valuenow"), text: n.getAttribute("aria-valuetext"), label: n.getAttribute("aria-label"),
  }));
  assert.deepEqual([bar.role, bar.min, bar.max, bar.now], ["progressbar", "0", "100", "100"]);
  assert.match(bar.text, /完成/);
  assert.match(bar.label, /範例影片/);
  const message = first.locator(".qflash");
  assert.deepEqual(await message.evaluate((n) => [n.getAttribute("role"), n.getAttribute("aria-live"), n.hidden]), ["status", "polite", false],
    "the message line is a live region that is in the page before it has anything to say");
  await first.locator(".qcopy").click();
  await page.waitForFunction(() => document.querySelector(".qrow .qflash")?.textContent === "已複製");

  assert.equal(await page.evaluate(() => {
    const pill = document.getElementById("status").getBoundingClientRect();
    const title = document.querySelector("h1").getBoundingClientRect();
    return Math.abs(pill.top - title.top) < 30; // pill stays on the header's first row
  }), true, "status pill stays beside the title");

  // Layout holds at the narrowest and widest side panel widths: no horizontal scrolling.
  for (const width of [320, 480]) {
    await page.setViewportSize({ width, height: 860 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true,
      `no horizontal overflow at ${width}px`);
    await shot(`5-width-${width}`);
  }
  console.log("OK");
} catch (error) {
  console.log(`FAIL: ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await context.close();
  await ytimg.close();
}
