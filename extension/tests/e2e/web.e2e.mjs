// End-to-end check of the web version (index.html + web/), served as if from GitHub Pages:
//   A. without the extension it only offers the setup (write the extension into a folder / ZIP);
//   B. with the extension it detects it, connects to the host by itself, and shows the same list as the side panel.
// Exit codes: 0 = OK, 1 = assertion failed, 2 = UNVERIFIED (browser/extension could not be launched).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { PAGES_URL, launchExtension, manifest, registerNativeHost, root, servePages, shotter } from "./helpers.mjs";
import { buildFixture } from "./fake-github.mjs";
import { startFakeYtimg } from "./fake-ytimg.mjs";

const executablePath = process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium";
const opfsPicker = (extra = "") => `
  window.showDirectoryPicker = async () => navigator.storage.getDirectory();
  ${extra}`;
const watch = (id) => `https://www.youtube.com/watch?v=${id}`;

// ---------------------------------------------------------------- A. a browser without the extension
async function withoutExtension() {
  const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    await servePages(context);
    const fixture = buildFixture({ repoRoot: root });
    await fixture.routes(context);
    await context.addInitScript(opfsPicker());
    const page = await context.newPage();
    await page.goto(PAGES_URL);
    await page.waitForSelector("#no-extension:not([hidden])");
    assert.equal(await page.isDisabled("#add-btn"), true);
    assert.equal(await page.locator('#steps li[data-step="1"]').getAttribute("data-s"), "now");

    await page.click("#deploy-pick");
    await page.waitForFunction(() => /已寫入/.test(document.getElementById("deploy-status").textContent), null, { timeout: 30000 });
    const written = await page.evaluate(async () => {
      const dir = await navigator.storage.getDirectory();
      const names = [];
      for await (const [name] of dir.entries()) names.push(name);
      const file = await (await dir.getFileHandle("manifest.json")).getFile();
      return { names, manifestName: JSON.parse(await file.text()).name };
    });
    assert.equal(written.manifestName, manifest.name);
    assert.ok(written.names.includes("background.js") && written.names.includes("bridge.js") && !written.names.includes("tests"));
    assert.equal(await page.locator('#steps li[data-step="1"]').getAttribute("data-s"), "done");
    assert.equal(await page.locator('#steps li[data-step="2"]').getAttribute("data-s"), "now");

    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#deploy-zip")]);
    const zipPath = path.join(fs.mkdtempSync(path.join(process.env.E2E_TMP ?? "/tmp", "web-zip-")), "e.zip");
    await download.saveAs(zipPath);
    const names = JSON.parse(execFileSync("python3", ["-c", "import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({'bad': z.testzip(), 'names': z.namelist()}))", zipPath], { encoding: "utf8" }));
    assert.equal(names.bad, null);
    assert.ok(names.names.includes("YouTube-batch-downloader-extension/manifest.json"));
    await context.close();
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------- B. with the extension
async function withExtension() {
  const ytimg = await startFakeYtimg({ covers: { v1: ["hq720", "mqdefault"], v2: ["mqdefault"], v3: ["mqdefault"], v4: ["mqdefault"] } });
  const { context, extId, work, userData } = await launchExtension({ viewport: { width: 1200, height: 900 }, args: ytimg.args() });
  const home = path.join(work, "home");
  const outDir = path.join(work, "out");
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  const stub = path.join(home, "bin", "yt-dlp");
  fs.copyFileSync(path.join(root, "host/tests/stub_ytdlp.py"), stub);
  fs.chmodSync(stub, 0o755);
  try {
    await servePages(context);
    const web = await context.newPage();
    const shot = shotter(web);
    if (process.env.E2E_SCHEME) await web.emulateMedia({ colorScheme: process.env.E2E_SCHEME });
    await web.goto(PAGES_URL);
    const stepState = (n) => web.locator(`#steps li[data-step="${n}"]`).getAttribute("data-s");
    const untilStep = (n, state, ms = 15000) => web.waitForFunction(([i, s]) => document.querySelector(`#steps li[data-step="${i}"]`).dataset.s === s, [n, state], { timeout: ms });

    // B1. The extension is found by itself; the host is not installed yet.
    await untilStep(2, "done");
    assert.equal(await stepState(1), "done");
    assert.equal(await stepState(3), "now");
    assert.equal(await web.isVisible("#no-extension"), false);
    assert.equal(await web.isDisabled("#add-btn"), false);
    assert.equal(await web.isDisabled("#start-all"), true);
    await shot("web-1-setup");

    // B1v. The page shows which version of the extension it found, and warns when that is older than the page.
    assert.equal(await web.textContent("#ext-version"), `（v${manifest.version}）`);
    assert.equal(await web.isVisible("#ext-version-note"), false, "same version: no warning");
    await context.route(`${PAGES_URL}extension/manifest.json`, (route) => route.fulfill({
      contentType: "application/json", body: JSON.stringify({ ...manifest, version: "9.9.9" }) }));
    const newer = await context.newPage();
    await newer.goto(PAGES_URL);
    await newer.waitForSelector("#ext-version-note:not([hidden])", { timeout: 20000 });
    const warning = await newer.textContent("#ext-version-note");
    assert.ok(warning.includes("9.9.9") && warning.includes(manifest.version), "the warning names both versions");
    await newer.close();
    await context.unroute(`${PAGES_URL}extension/manifest.json`);

    // B1a. The resolution choice sits on the add line, between the address box and the "add" button.
    const box = (selector) => web.locator(selector).boundingBox();
    const [field, group, addButton] = [await box("#add-url"), await box("#quality"), await box("#add-btn")];
    assert.ok(group.x >= field.x + field.width && group.x + group.width <= addButton.x, "resolution is between the box and the add button");
    assert.ok(Math.abs(group.y + group.height / 2 - (addButton.y + addButton.height / 2)) < 4, "and on the same line");
    assert.equal(await web.locator("aside #quality").count(), 0, "it is no longer in the settings list");
    assert.equal(await web.locator('#quality[role="radiogroup"]').getAttribute("aria-label"), "解析度");

    // B1b. "Download installer" really saves the installer. (This machine is Linux, so the worker is told it is a Mac.)
    const worker = context.serviceWorkers().find((w) => w.url().includes(extId));
    await worker.evaluate(() => { chrome.runtime.getPlatformInfo = async () => ({ os: "mac", arch: "x86-64", nacl_arch: "x86-64" }); });
    await web.click("#deploy-installer");
    await web.waitForFunction(() => /已下載「|無法/.test(document.getElementById("deploy-status").textContent), null, { timeout: 20000 });
    assert.match(await web.textContent("#deploy-status"), /已下載「install-mac\.zip」/);
    const saved = await worker.evaluate(() => chrome.downloads.search({}).then((all) => all.map((d) => ({ state: d.state, error: d.error ?? null, filename: d.filename }))));
    assert.deepEqual(saved.map((d) => [d.state, d.error]), [["complete", null]], "Chrome finished the download");
    assert.deepEqual(fs.readFileSync(saved[0].filename), fs.readFileSync(path.join(root, "extension/installers/install-mac.zip")), "and it is the installer, byte for byte");

    // B2. Installing the host is enough: the page connects without any click.
    const wrapper = path.join(work, "host.sh");
    const goodWrapper = `#!/bin/sh\necho $$ > "${path.join(work, "host.pid")}"\nexport YTDL_HOME="${home}"\nexport YTDL_STUB_DELAY=2\nexport YTDL_STUB_LOG="${path.join(work, "downloads.log")}"\nexec python3 "${path.join(root, "host/host.py")}"\n`;
    fs.writeFileSync(wrapper, goodWrapper);
    fs.chmodSync(wrapper, 0o755);
    registerNativeHost({ userData, wrapperPath: wrapper, extId });
    await untilStep(4, "done", 20000);
    assert.equal(await stepState(3), "done");
    await web.waitForFunction(() => document.getElementById("outdir").value !== "");

    // B3. The same list in the web page and in the side panel.
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    await web.bringToFront();
    await web.fill("#outdir", outDir);
    await web.click("#save-outdir");
    await web.waitForFunction((d) => document.getElementById("settings-note").textContent.includes(d), outDir);
    await web.evaluate(() => {
      const range = document.getElementById("cooldown");
      range.value = "3";
      range.dispatchEvent(new Event("input", { bubbles: true }));
      range.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await web.click('#quality label:has(input[value="720"])');
    await panel.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: "queue_get" })).state.settings.quality === 720);
    await web.click('#quality label:has(input[value="1080"])');
    await panel.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: "queue_get" })).state.settings.quality === 1080);
    // the automatic cover setting: on by default, and the page's switch reaches the extension
    const webAutoCover = () => panel.evaluate(async () => (await chrome.runtime.sendMessage({ type: "queue_get" })).state.settings.autoCover);
    assert.equal(await web.isChecked("#auto-cover"), true);
    assert.equal(await webAutoCover(), true);
    await web.uncheck("#auto-cover");
    await panel.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: "queue_get" })).state.settings.autoCover === false);
    await panel.waitForFunction(() => document.getElementById("auto-cover").checked === false); // (the panel shows the same switch)
    await web.check("#auto-cover");
    await panel.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: "queue_get" })).state.settings.autoCover === true);
    // the environment check in the sidebar
    await web.click("#doctor-check");
    await web.waitForSelector("#doctor-list li");
    const webReport = await web.$$eval("#doctor-list li", (items) => items.map((li) => ({ status: li.dataset.status, text: li.textContent })));
    assert.equal(webReport.find((r) => /yt-dlp/.test(r.text)).status, "ok");
    assert.match(await web.textContent("#doctor-summary"), /需要處理/);
    await web.fill("#add-url", watch("v1"));
    await web.press("#add-url", "Enter");
    await web.waitForSelector('#queue-list .qrow[data-kind="waiting"]');
    await panel.waitForSelector('#queue-list .qrow[data-kind="waiting"]');
    assert.match(await web.textContent("#queue-list"), /範例影片/);
    assert.match(await panel.textContent("#queue-list"), /範例影片/);
    await web.fill("#add-url", watch("v2"));
    await web.click("#add-btn");
    await web.waitForFunction(() => document.querySelectorAll("#queue-list .qrow").length === 2);

    await web.click("#start-all");
    for (const view of [web, panel]) await view.waitForSelector('.qrow[data-kind="downloading"]');
    for (const view of [web, panel]) await view.waitForSelector("#cooldown-chip:not([hidden])", { timeout: 20000 });
    assert.match(await web.textContent("#cooldown-chip"), /秒後開始下一支/);
    for (const view of [web, panel]) {
      await view.waitForFunction(() => document.querySelectorAll('.qrow[data-kind="done"]').length === 2, null, { timeout: 40000 });
    }
    assert.ok(fs.existsSync(path.join(outDir, "範例影片.mp4")) && fs.existsSync(path.join(outDir, "影片 v2.mp4")));
    await shot("web-2-done");

    // B4. Both screens press "start" at the same moment: every video is still downloaded once.
    await web.fill("#add-url", `${watch("v3")} ${watch("v4")}`);
    await web.click("#add-btn");
    await web.waitForFunction(() => document.querySelectorAll('#queue-list .qrow[data-kind="waiting"]').length === 2);
    await panel.waitForFunction(() => document.querySelectorAll('#queue-list .qrow[data-kind="waiting"]').length === 2);
    // (sent as messages, not clicks: once the first start lands, the other screen's button turns into "stop")
    const startFromWeb = web.evaluate(() => new Promise((resolve) => {
      const id = Math.random();
      const on = (e) => { if (e.data?.source === "ytdl-ext" && e.data.id === id) { window.removeEventListener("message", on); resolve(e.data.response); } };
      window.addEventListener("message", on);
      window.postMessage({ source: "ytdl-web", id, request: { type: "queue_start" } }, location.origin);
    }));
    const startFromPanel = panel.evaluate(() => chrome.runtime.sendMessage({ type: "queue_start" }));
    assert.deepEqual(await Promise.all([startFromWeb, startFromPanel]), [{ ok: true }, { ok: true }]);
    for (const view of [web, panel]) {
      try {
        await view.waitForFunction(() => document.querySelectorAll('.qrow[data-kind="done"]').length === 4, null, { timeout: 40000 });
      } catch (error) {
        const state = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "queue_get" }));
        console.error("queue at timeout:", JSON.stringify(state.state.items.map((i) => [i.id, i.status, i.dupOf])), state.state.running);
        throw error;
      }
      assert.equal(await view.locator('.qrow[data-kind="failed"]').count(), 0);
    }
    assert.deepEqual(fs.readdirSync(outDir).filter((n) => n.endsWith(".mp4")).sort(), ["影片 v2.mp4", "影片 v3.mp4", "影片 v4.mp4", "範例影片.mp4"].sort());
    // (files alone would not show a video that was downloaded twice: the yt-dlp stub logs every real download)
    assert.deepEqual(fs.readFileSync(path.join(work, "downloads.log"), "utf8").trim().split("\n").sort(), ["v1", "v2", "v3", "v4"], "each video was downloaded exactly once");

    // B5. Removing a row in the web page removes it in the panel too.
    await web.locator(".qrow", { hasText: "影片 v4" }).locator(".qx").click();
    await panel.waitForFunction(() => document.querySelectorAll("#queue-list .qrow").length === 3);

    // B6. Copy text and cover behave the same as in the panel.
    await web.locator(".qrow", { hasText: "範例影片" }).locator(".qcopy").click();
    await web.waitForFunction(() => document.querySelector(".qcopy[data-state='ok']"));
    await web.evaluate(() => { const t = document.createElement("textarea"); t.id = "paste-probe"; document.body.append(t); t.focus(); });
    await web.keyboard.press("Control+V");
    assert.equal(await web.inputValue("#paste-probe"), "【範例影片】\n#標籤一 #標籤二 #標籤三");
    await web.evaluate(() => document.getElementById("paste-probe").remove());
    await web.locator(".qrow", { hasText: "範例影片" }).locator(".qcover").click();
    await web.waitForFunction(() => document.querySelector(".qcover[data-state='ok']"));
    const cover = fs.readFileSync(path.join(outDir, "範例影片.jpg"));
    assert.deepEqual([...cover.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    assert.match(cover.toString("latin1"), /v1:hq720/);

    // B7. A forged message from the page is refused; injecting the bridge again is harmless.
    const forged = await web.evaluate(() => new Promise((resolve) => {
      const on = (e) => { if (e.data?.source === "ytdl-ext" && e.data.id === 99) { window.removeEventListener("message", on); resolve(e.data.response); } };
      window.addEventListener("message", on);
      window.postMessage({ source: "ytdl-web", id: 99, request: { type: "update_commit" } }, location.origin);
    }));
    assert.deepEqual(forged, { ok: false, error: "forbidden" });
    // Injecting the bridge into a tab that already has one (what the extension does after an install or reload)
    // must not make the page hear every answer twice. Reloading the extension itself cannot be tried here:
    // this Chromium leaves a --load-extension extension disabled after chrome.runtime.reload().
    await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: "https://unnn3ing-oss.github.io/videodownload/*" });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["bridge.js"] });
    });
    // (the page's own pings also draw hellos, so count the answers to one request instead)
    const answers = await web.evaluate(() => new Promise((resolve) => {
      let count = 0;
      window.addEventListener("message", (e) => { if (e.data?.source === "ytdl-ext" && e.data.id === 77) count += 1; });
      window.postMessage({ source: "ytdl-web", id: 77, request: { type: "queue_get" } }, location.origin);
      setTimeout(() => resolve(count), 800);
    }));
    assert.equal(answers, 1, "one bridge answers, not two");

    // B9. The extension goes away: the page says so and locks the list, for the keyboard too; it comes back by itself.
    const locked = () => web.evaluate(() => ({ add: document.getElementById("add-card").inert, list: document.getElementById("queue-card").inert }));
    assert.deepEqual(await locked(), { add: false, list: false });
    const bridge = (action) => worker.evaluate(async (what) => {
      const [tab] = await chrome.tabs.query({ url: "https://unnn3ing-oss.github.io/videodownload/*" });
      if (what === "drop") await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { window.__ytdlBridge.dispose(); delete window.__ytdlBridge; } });
      else await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["bridge.js"] });
    }, action);
    await bridge("drop");
    await web.waitForSelector("#no-extension:not([hidden])", { timeout: 20000 });
    assert.match(await web.textContent("#no-extension"), /連線中斷.*重新整理/);
    assert.deepEqual(await locked(), { add: true, list: true });
    await web.evaluate(() => document.getElementById("add-url").focus());
    assert.notEqual(await web.evaluate(() => document.activeElement?.id), "add-url", "the box cannot be focused while locked");
    await bridge("restore");
    await web.waitForSelector("#no-extension", { state: "hidden", timeout: 20000 });
    assert.deepEqual(await locked(), { add: false, list: false });
    await web.waitForFunction(() => document.querySelector(".qrow") !== null);

    // B10. The local host closes right after it is launched: the page retries a few times, then stops and says what to do.
    const launches = path.join(work, "launches.log");
    const count = () => (fs.existsSync(launches) ? fs.readFileSync(launches, "utf8").trim().split("\n").length : 0);
    fs.writeFileSync(wrapper, `#!/bin/sh\necho x >> "${launches}"\nexit 1\n`);
    // (a live region is announced again whenever its text is rewritten, even to the same words: count the rewrites)
    await web.evaluate(() => {
      window.__noteRewrites = 0;
      new MutationObserver((records) => { window.__noteRewrites += records.length; })
        .observe(document.getElementById("conn-note"), { childList: true, characterData: true, subtree: true });
    });
    process.kill(Number(fs.readFileSync(path.join(work, "host.pid"), "utf8")));
    await web.waitForSelector("#conn-note:not([hidden])", { timeout: 20000 });
    assert.match(await web.textContent("#conn-note"), /連線中斷/);
    await web.waitForFunction(() => /自動重試/.test(document.getElementById("conn-note").textContent), null, { timeout: 40000 });
    assert.equal(count(), 5, "five launches, no more");
    await new Promise((resolve) => setTimeout(resolve, 7000));
    assert.equal(count(), 5, "and it stays that way");
    assert.equal(await web.evaluate(() => window.__noteRewrites), 2, "the note was written twice (lost, then given up), not once per failed launch");

    // B10b. With the host gone the cover still arrives, through Chrome's own download (under the same name).
    await worker.evaluate(() => { // (Playwright renames saved files, so note what the extension asked Chrome for)
      self.__asked = [];
      const original = chrome.downloads.download.bind(chrome.downloads);
      chrome.downloads.download = (options) => { self.__asked.push(options); return original(options); };
    });
    const sample = web.locator(".qrow", { hasText: "範例影片" });
    await sample.locator(".qcover").click();
    await sample.locator(".qcover[data-state='ok']").waitFor({ timeout: 20000 });
    assert.match(await sample.locator(".qflash").textContent(), /已存到下載資料夾/);
    const fallback = await worker.evaluate(async () => ({
      asked: self.__asked,
      items: (await chrome.downloads.search({})).filter((d) => d.url.includes("i.ytimg.com")).map((d) => ({ state: d.state, error: d.error ?? null, filename: d.filename })),
    }));
    assert.deepEqual(fallback.items.map((d) => [d.state, d.error]), [["complete", null]]);
    assert.deepEqual(fallback.asked.map((o) => [o.url, o.filename]), [["https://i.ytimg.com/vi/v1/hq720.jpg", "範例影片.jpg"]], "the original-size address, named after the title");
    const viaBrowser = fs.readFileSync(fallback.items[0].filename);
    assert.deepEqual([...viaBrowser.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    assert.match(viaBrowser.toString("latin1"), /v1:hq720/, "the original-size cover");
    fs.writeFileSync(wrapper, goodWrapper);
    await web.click("#start");
    await web.waitForSelector("#conn-note", { state: "hidden", timeout: 20000 });
    await untilStep(4, "done");

    // B8. Narrow and wide layouts.
    for (const width of [320, 480]) {
      await web.setViewportSize({ width, height: 900 });
      assert.equal(await web.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `no horizontal overflow at ${width}px`);
      const narrow = await box("#quality");
      assert.ok(narrow.x >= 0 && narrow.x + narrow.width <= width, `the resolution choice fits at ${width}px`);
      await shot(`web-3-width-${width}`);
    }
  } finally {
    await context.close();
    await ytimg.close();
  }
}

try {
  await withoutExtension();
  await withExtension();
  console.log("OK");
} catch (error) {
  console.log(`FAIL: ${error.stack ?? error}`);
  process.exitCode = 1;
}
