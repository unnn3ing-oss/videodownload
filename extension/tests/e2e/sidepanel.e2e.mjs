// End-to-end check of side panel page + background + real host (with a stub yt-dlp) in headless Chromium.
// The side panel itself cannot be opened without a real user gesture, so the page is opened as a tab.
// Exit codes: 0 = OK, 1 = assertion failed, 2 = UNVERIFIED (browser/extension could not be launched).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launchExtension, manifest, registerNativeHost, root, shotter } from "./helpers.mjs";

const { context, extId, work, userData } = await launchExtension({ viewport: { width: 400, height: 860 } });
const home = path.join(work, "home");
const outDir = path.join(work, "out");
fs.mkdirSync(path.join(home, "bin"), { recursive: true });
const stub = path.join(home, "bin", "yt-dlp");
fs.copyFileSync(path.join(root, "host/tests/stub_ytdlp.py"), stub);
fs.chmodSync(stub, 0o755);

try {
  const page = await context.newPage();
  const shot = shotter(page);
  if (process.env.E2E_SCHEME) await page.emulateMedia({ colorScheme: process.env.E2E_SCHEME });
  await page.goto(`chrome-extension://${extId}/sidepanel.html`);
  const state = (s) => page.waitForFunction((x) => document.getElementById("status").dataset.state === x, s);

  // The manifest declares a side panel and no popup.
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.equal(manifest.action.default_popup, undefined);
  assert.ok(manifest.permissions.includes("sidePanel"));

  // Phase A: no native host registered yet -> onboarding card is shown.
  await page.click("#start");
  await state("not_installed");
  assert.match(await page.textContent("#status"), /尚未部署/);
  assert.equal(await page.isVisible("#setup"), true);
  await page.fill("#urls", "https://youtu.be/a\nhttp://evil.com/x");
  await page.waitForSelector("#invalid:not([hidden]) li");
  assert.match(await page.textContent("#invalid"), /http:\/\/evil\.com\/x/);
  await shot("1-not-installed");

  // Phase B: register the real host (python) wired to the stub engine, then start it.
  const wrapper = path.join(work, "host.sh");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexport YTDL_HOME="${home}"\nexec python3 "${path.join(root, "host/host.py")}"\n`);
  fs.chmodSync(wrapper, 0o755);
  registerNativeHost({ userData, wrapperPath: wrapper, extId });
  await page.click("#start");
  await state("running");
  assert.match(await page.textContent("#status"), /已啟動/);
  assert.match(await page.textContent("#engine-info"), /2099\.01\.01/);
  assert.equal(await page.isVisible("#setup"), false, "onboarding collapses once running");

  await page.click("#settings > summary");
  await page.fill("#outdir", outDir);
  await page.click("#save-outdir");
  await page.waitForFunction((d) => document.getElementById("note").textContent.includes(d), outDir);
  await page.click("#settings > summary");

  // Current-tab card follows the active tab (YouTube page served from a stub route).
  await context.route("https://www.youtube.com/**", (route) => route.fulfill({
    contentType: "text/html; charset=utf-8", body: "<title>範例影片 - YouTube</title><h1>stub</h1>" }));
  await page.fill("#urls", "");
  const yt = await context.newPage();
  await yt.goto("https://www.youtube.com/watch?v=v1");
  await page.waitForSelector("#tab-card:not([hidden])");
  assert.match(await page.textContent("#tab-title"), /範例影片/);
  assert.match(await page.textContent("#tab-kind"), /影片/);
  await page.evaluate(() => document.getElementById("tab-add").click());
  await page.waitForFunction(() => document.getElementById("urls").value.includes("watch?v=v1"));
  await yt.close();
  await page.bringToFront();

  // Resolve shows a preview list before anything is downloaded.
  await page.waitForFunction(() => document.getElementById("filename").value === "範例影片");
  assert.equal(await page.isEnabled("#filename"), true);
  await page.waitForSelector("#items li");
  assert.match(await page.textContent("#items"), /範例影片/);
  const noScroll = () => page.evaluate(() => { const l = document.getElementById("items"); return l.scrollHeight <= l.clientHeight + 1; });
  assert.equal(await noScroll(), true, "a single row must not make the list scroll");
  await page.waitForTimeout(500); // let the entrance animation settle before the screenshot
  await shot("2-ready");

  await page.click('label:has(input[name="quality"][value="720"])');
  assert.equal(await page.isChecked('input[name="quality"][value="720"]'), true);
  await page.click("#download");
  await page.waitForSelector("#summary:not([hidden])");
  assert.match(await page.textContent("#summary"), /完成 1/);
  assert.match(await page.textContent("#note"), /下載完成/, "the stale 下載中… banner is replaced when the job ends");
  assert.match(await page.textContent("#overall-text"), /1 \/ 1/);
  assert.match(await page.textContent("#items"), /範例影片/, "finished rows keep the video title, not the id");
  assert.doesNotMatch(await page.textContent("#items"), /\bv1\b/);
  assert.equal(await noScroll(), true, "a finished single row must not make the list scroll");
  assert.equal(await page.evaluate(() => {
    const pill = document.getElementById("status").getBoundingClientRect();
    const title = document.querySelector("h1").getBoundingClientRect();
    return Math.abs(pill.top - title.top) < 30; // pill stays on the header's first row
  }), true, "status pill stays beside the title");
  await page.waitForTimeout(500);
  assert.ok(fs.existsSync(path.join(outDir, "範例影片.mp4")), "downloaded file is named after the title");
  await shot("3-done");

  // Layout holds at the narrowest and widest side panel widths: no horizontal scrolling.
  for (const width of [320, 480]) {
    await page.setViewportSize({ width, height: 860 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true,
      `no horizontal overflow at ${width}px`);
    await shot(`4-width-${width}`);
  }
  console.log("OK");
} catch (error) {
  console.log(`FAIL: ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await context.close();
}
