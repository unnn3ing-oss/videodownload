// End-to-end check of the self-update flow: side panel + background + real host, against a fake GitHub.
// The browser's folder picker is replaced by OPFS (standing in for the extension folder) and
// chrome.runtime.reload by a flag, so nothing real is replaced.
// Exit codes: 0 = OK, 1 = assertion failed, 2 = UNVERIFIED (browser/extension could not be launched).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launchExtension, manifest, registerNativeHost, root, shotter } from "./helpers.mjs";
import { buildFixture } from "./fake-github.mjs";

const { context, extId, work, userData } = await launchExtension({ viewport: { width: 400, height: 860 } });
const home = path.join(work, "home");
const outDir = path.join(work, "out");
fs.mkdirSync(path.join(home, "bin"), { recursive: true });
fs.mkdirSync(path.join(home, "host"), { recursive: true });
for (const name of fs.readdirSync(path.join(root, "host")).filter((n) => n.endsWith(".py"))) {
  fs.copyFileSync(path.join(root, "host", name), path.join(home, "host", name));
}
const stub = path.join(home, "bin", "yt-dlp");
fs.copyFileSync(path.join(root, "host/tests/stub_ytdlp.py"), stub);
fs.chmodSync(stub, 0o755);

const oldVersion = fs.readFileSync(path.join(home, "host/version.py"), "utf8");
const fixture = buildFixture({
  repoRoot: root,
  message: "release: v9.9.9",
  overrides: {
    "extension/manifest.json": (current) => JSON.stringify({ ...JSON.parse(current), version: "9.9.9" }, null, 2) + "\n",
    "extension/sidepanel.css": (current) => `${current}\n/* e2e */\n`,
    "host/version.py": 'VERSION = "9.9.9"\n',
    "extension/tests/x.js": "// excluded from updates\n",
    "host/tests/t.py": "# excluded from updates\n",
  },
});
const tamper = new Set();
await fixture.routes(context, { tamper });

const wrapper = path.join(work, "host.sh");
fs.writeFileSync(wrapper, `#!/bin/sh\nexport YTDL_HOME="${home}"\nexport YTDL_STUB_DELAY=3\n`
  + `exec python3 "${path.join(root, "extension/tests/e2e/host_with_fake_github.py")}"\n`);
fs.chmodSync(wrapper, 0o755);

try {
  const page = await context.newPage();
  const shot = shotter(page);
  if (process.env.E2E_SCHEME) await page.emulateMedia({ colorScheme: process.env.E2E_SCHEME });
  await page.addInitScript((extName) => {
    window.__reloaded = false;
    chrome.runtime.reload = () => { window.__reloaded = true; };
    // The picked folder (OPFS) stands in for the loaded extension folder, so it also has to serve the probe file.
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = String(input);
      const name = /\/(ytdl-probe-[^/?#]+)$/.exec(url)?.[1];
      if (!name) return realFetch(input, init);
      try {
        const dir = await navigator.storage.getDirectory();
        return new Response(await (await (await dir.getFileHandle(name)).getFile()).text());
      } catch {
        return new Response("", { status: 404 });
      }
    };
    window.showDirectoryPicker = async () => {
      const dir = await navigator.storage.getDirectory();
      try {
        await dir.getFileHandle("manifest.json");
      } catch {
        const writable = await (await dir.getFileHandle("manifest.json", { create: true })).createWritable();
        await writable.write(JSON.stringify({ name: extName, version: "0.1.0" }));
        await writable.close();
      }
      return dir;
    };
  }, manifest.name);
  await page.goto(`chrome-extension://${extId}/sidepanel.html`);

  const text = (id) => page.textContent(`#${id}`);
  const state = (s) => page.waitForFunction((x) => document.getElementById("status").dataset.state === x, s);
  const opfsManifest = () => page.evaluate(async () => {
    const dir = await navigator.storage.getDirectory();
    const file = await (await dir.getFileHandle("manifest.json")).getFile();
    return { version: JSON.parse(await file.text()).version, modified: file.lastModified };
  });
  const opfsFile = (name) => page.evaluate(async (n) => {
    const dir = await navigator.storage.getDirectory();
    const file = await (await dir.getFileHandle(n)).getFile();
    return { text: await file.text(), modified: file.lastModified };
  }, name);
  const reloaded = () => page.evaluate(() => window.__reloaded);
  const read = (...parts) => fs.readFileSync(path.join(...parts), "utf8");

  await page.click("#settings > summary");

  // 1. Host not started: the check works, the badge appears, applying needs the host.
  await page.click("#update-check");
  await page.waitForSelector("#update-badge:not([hidden])");
  assert.match(await text("ver-latest"), /release: v9\.9\.9/);
  assert.equal(await page.evaluate(() => chrome.action.getBadgeText({})), "新");
  assert.equal(await page.isDisabled("#update-apply"), true);
  assert.match(await text("update-progress"), /請先按「?『?啟動/);
  await shot("5-update-available");

  registerNativeHost({ userData, wrapperPath: wrapper, extId }); // the panel only finds the host from here on
  // 2. Host started: the host's own files are compared too, and applying is allowed.
  await page.click("#start");
  await state("running");
  await page.click("#update-check");
  await page.waitForFunction(() => !document.getElementById("update-apply").disabled);
  assert.match(await text("update-apply"), /選擇擴充功能資料夾並更新/, "first update asks for the extension folder");

  // 3. A tampered download (the host file too, since Chrome downloads those and the host only verifies) is refused before anything local changes.
  tamper.add("extension/sidepanel.css");
  await page.click("#update-apply");
  await page.waitForFunction(() => document.getElementById("update-progress").textContent.includes("不一致"));
  assert.equal((await opfsManifest()).version, "0.1.0");
  assert.equal(read(home, "host/version.py"), oldVersion);
  assert.equal(await reloaded(), false);
  tamper.clear();
  tamper.add("host/version.py");
  await page.click("#update-apply");
  await page.waitForFunction(() => /version\.py.*不一致/.test(document.getElementById("update-progress").textContent));
  assert.equal(read(home, "host/version.py"), oldVersion);
  await shot("6-update-refused");

  // 4. Without the tampering the update goes through: host first, manifest.json last, then reload.
  tamper.clear();
  await page.waitForFunction(() => !document.getElementById("update-apply").disabled);
  await page.click("#update-apply");
  await page.waitForFunction(() => window.__reloaded === true);
  const written = await opfsManifest();
  assert.equal(written.version, "9.9.9");
  const css = await opfsFile("sidepanel.css");
  assert.match(css.text, /\/\* e2e \*\//);
  assert.ok(written.modified >= css.modified, "manifest.json is written last");
  assert.match(read(home, "host/version.py"), /9\.9\.9/);
  assert.equal(read(home, "backup/host/version.py"), oldVersion);
  assert.equal(fs.existsSync(path.join(home, "host/t.py")), false, "host/tests files are never installed");

  // 5. While a download runs the update is blocked, and it is allowed again afterwards.
  await page.fill("#outdir", outDir);
  await page.click("#save-outdir");
  await page.waitForFunction((d) => document.getElementById("note").textContent.includes(d), outDir);
  await page.fill("#add-url", "https://www.youtube.com/watch?v=v1");
  await page.click("#add-btn");
  await page.waitForSelector('.qrow[data-kind="waiting"]');
  await page.click("#start-all");
  await page.waitForSelector('.qrow[data-kind="downloading"]');
  assert.equal(await page.isDisabled("#update-apply"), true);
  assert.match(await text("update-progress"), /下載進行中/);
  await page.waitForSelector('.qrow[data-kind="done"]');
  await page.waitForFunction(() => !document.getElementById("update-apply").disabled);

  // Layout of the new block at the narrowest and widest side panel widths.
  for (const width of [320, 480]) {
    await page.setViewportSize({ width, height: 860 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true,
      `no horizontal overflow at ${width}px`);
    await shot(`7-update-width-${width}`);
  }
  console.log("OK");
} catch (error) {
  console.log(`FAIL: ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await context.close();
}
