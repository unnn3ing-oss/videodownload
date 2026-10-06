// End-to-end check of "check for updates" / "update to the latest" on the web page: web page + background script + real host,
// against a fake GitHub. The extension's folder is the one the installer recorded (a copy of the extension in a temp folder),
// the host runs from its own copy of host/ so its files can really be replaced, and chrome.runtime.reload is a flag.
// Exit codes: 0 = OK, 1 = assertion failed, 2 = UNVERIFIED (browser/extension could not be launched).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PAGES_URL, launchExtension, manifest, registerNativeHost, root, servePages } from "./helpers.mjs";
import { buildFixture } from "./fake-github.mjs";

const fixture = buildFixture({
  repoRoot: root,
  message: "release: v9.9.9",
  overrides: {
    "extension/manifest.json": (current) => JSON.stringify({ ...JSON.parse(current), version: "9.9.9" }, null, 2) + "\n",
    "extension/background.js": (current) => `${current}\n// e2e\n`,
    "host/version.py": 'VERSION = "9.9.9"\n',
  },
});
const tamper = new Set();
const github = await fixture.serve({ tamper }); // (the extension's background script is what talks to GitHub)
const { context, extId, work, userData } = await launchExtension({ viewport: { width: 1200, height: 900 }, args: github.args() });
const home = path.join(work, "home");
const extFolder = path.join(work, "YT批量下載器");
fs.mkdirSync(path.join(home, "bin"), { recursive: true });
fs.mkdirSync(path.join(home, "host"), { recursive: true });
for (const name of fs.readdirSync(path.join(root, "host")).filter((n) => n.endsWith(".py"))) fs.copyFileSync(path.join(root, "host", name), path.join(home, "host", name));
for (const name of ["yt-dlp", "ffmpeg", "deno"]) {
  const file = path.join(home, "bin", name);
  fs.writeFileSync(file, name === "yt-dlp" ? fs.readFileSync(path.join(root, "host/tests/stub_ytdlp.py")) : `#!/bin/sh\necho ${name} 1.0\n`);
  fs.chmodSync(file, 0o755);
}
fs.writeFileSync(path.join(home, "host/version.py"), 'VERSION = "0.2.0"\n'); // the oldest local program that still works, but not the extension's version
// the extension as the installer would have put it in the person's folder (no tests, no installers)
fs.cpSync(path.join(root, "extension"), extFolder, { recursive: true, filter: (src) => !/[\\/](tests|installers)([\\/]|$)/.test(src) });
fs.writeFileSync(path.join(home, "install.json"), JSON.stringify({ extensionFolder: extFolder, version: manifest.version }));
const oldVersionPy = fs.readFileSync(path.join(home, "host/version.py"), "utf8");
const oldBackground = fs.readFileSync(path.join(extFolder, "background.js"), "utf8");

await servePages(context);

const wrapper = path.join(work, "host.sh");
fs.writeFileSync(wrapper, `#!/bin/sh\nexport YTDL_HOME="${home}"\nexec python3 "${path.join(root, "extension/tests/e2e/host_with_fake_github.py")}"\n`);
fs.chmodSync(wrapper, 0o755);
registerNativeHost({ userData, wrapperPath: wrapper, extId });

try {
  const web = await context.newPage();
  await web.goto(PAGES_URL);
  const worker = context.serviceWorkers().find((w) => w.url().includes(extId));
  await worker.evaluate(() => { chrome.runtime.reload = () => { self.__reloaded = true; }; });
  const text = (id) => web.textContent(`#${id}`);
  const read = (...parts) => fs.readFileSync(path.join(...parts), "utf8");

  // 1. Once the host runs, the page checks by itself (quietly) and offers the update.
  await web.waitForFunction(() => document.getElementById("outdir").value !== "", null, { timeout: 30000 });
  await web.waitForFunction(() => !document.getElementById("up-apply").hidden, null, { timeout: 30000 });
  assert.match(await text("up-current"), new RegExp(`擴充功能 v${manifest.version.replaceAll(".", "\\.")} · 小程式 v`));
  assert.match(await text("up-latest"), /v9\.9\.9（release: v9\.9\.9）/);
  assert.equal(await web.isDisabled("#up-apply"), false);
  assert.match(await text("up-note"), /本機小程式是 v0\.2\.0，擴充功能是 v.*版本不一致/, "the page says the two versions differ");

  // 2. A tampered download is refused before anything local changes.
  tamper.add("extension/background.js");
  await web.click("#up-apply");
  await web.waitForFunction(() => /不一致/.test(document.getElementById("up-note").textContent), null, { timeout: 30000 });
  assert.equal(read(extFolder, "background.js"), oldBackground);
  assert.equal(read(home, "host/version.py"), oldVersionPy);
  tamper.clear();

  // 3. Untampered: the host's files first, the extension's files into the recorded folder (manifest.json last), then reload.
  await web.click("#up-check");
  await web.waitForFunction(() => /有新版本可以更新/.test(document.getElementById("up-note").textContent));
  await web.click("#up-apply");
  await web.waitForFunction(() => /更新完成/.test(document.getElementById("up-note").textContent) || /版本仍是/.test(document.getElementById("up-note").textContent), null, { timeout: 30000 });
  assert.match(read(extFolder, "background.js"), /\/\/ e2e/);
  assert.equal(JSON.parse(read(extFolder, "manifest.json")).version, "9.9.9");
  assert.match(read(home, "host/version.py"), /9\.9\.9/);
  assert.equal(read(home, "backup/host/version.py"), oldVersionPy);
  assert.equal(read(home, "backup/extension/background.js"), oldBackground);
  assert.equal(fs.existsSync(path.join(extFolder, "tests")), false, "tests are never written");
  for (let i = 0; i < 20 && !(await worker.evaluate(() => self.__reloaded === true)); i += 1) await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(await worker.evaluate(() => self.__reloaded === true), true, "the extension was told to reload");
  // (The extension that is really loaded here is the repository's, not the folder above, so after the "reload" the page
  // sees the old version and says so: that is what a wrong folder looks like.)
  await web.waitForFunction(() => /版本仍是/.test(document.getElementById("up-note").textContent), null, { timeout: 60000 });
  assert.match(await text("up-note"), new RegExp(`版本仍是 v${manifest.version.replaceAll(".", "\\.")}（預期 v9\\.9\\.9）`));

  // 4. An extension whose folder the host does not know cannot be updated from the page; it says where to go instead.
  fs.rmSync(path.join(home, "install.json"));
  await web.click("#up-check");
  await web.waitForFunction(() => /側邊面板/.test(document.getElementById("up-note").textContent), null, { timeout: 30000 });
  assert.equal(await web.isDisabled("#up-apply"), true);
  console.log("OK");
} catch (error) {
  console.log(`FAIL: ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await context.close();
  await github.close();
}
