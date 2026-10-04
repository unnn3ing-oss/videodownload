// End-to-end check of popup + background + real host (with a stub yt-dlp) in headless Chromium.
// Exit codes: 0 = OK, 1 = assertion failed, 2 = UNVERIFIED (browser/extension could not be launched).
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const extDir = path.join(root, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
const HOST_NAME = "com.ytdl.batch_downloader";

function extensionId(keyB64) {
  const hex = crypto.createHash("sha256").update(Buffer.from(keyB64, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

const work = fs.mkdtempSync(path.join(process.env.E2E_TMP ?? os.tmpdir(), "ytdl-e2e-"));
const userData = path.join(work, "profile");
const home = path.join(work, "home");
const outDir = path.join(work, "out");
fs.mkdirSync(path.join(home, "bin"), { recursive: true });
const stub = path.join(home, "bin", "yt-dlp");
fs.copyFileSync(path.join(root, "host/tests/stub_ytdlp.py"), stub);
fs.chmodSync(stub, 0o755);

let context;
let extId = extensionId(manifest.key);
try {
  context = await chromium.launchPersistentContext(userData, {
    executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium",
    headless: false,
    args: ["--headless=new", "--no-sandbox", `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent("serviceworker", { timeout: 20000 });
  assert.equal(new URL(worker.url()).hostname, extId, "pinned extension id must match the manifest key");
} catch (error) {
  console.log(`UNVERIFIED: could not launch the extension in headless Chromium: ${error.message.split("\n")[0]}`);
  process.exit(2);
}

try {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html`);
  const state = (s) => page.waitForFunction((x) => document.getElementById("status").dataset.state === x, s);

  // Phase A: no native host registered yet.
  await page.click("#start");
  await state("not_installed");
  assert.match(await page.textContent("#status"), /尚未部署/);
  await page.fill("#urls", "https://youtu.be/a\nhttp://evil.com/x");
  await page.waitForSelector("#invalid:not([hidden]) li");
  assert.match(await page.textContent("#invalid"), /http:\/\/evil\.com\/x/);

  // Phase B: register the real host (python) wired to the stub engine, then start it.
  const wrapper = path.join(work, "host.sh");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexport YTDL_HOME="${home}"\nexec python3 "${path.join(root, "host/host.py")}"\n`);
  fs.chmodSync(wrapper, 0o755);
  const nmDir = path.join(userData, "NativeMessagingHosts");
  fs.mkdirSync(nmDir, { recursive: true });
  fs.writeFileSync(path.join(nmDir, `${HOST_NAME}.json`), JSON.stringify({
    name: HOST_NAME, description: "e2e", path: wrapper, type: "stdio",
    allowed_origins: [`chrome-extension://${extId}/`],
  }));
  await page.click("#start");
  await state("running");
  assert.match(await page.textContent("#status"), /已啟動.*2099\.01\.01/);

  await page.fill("#outdir", outDir);
  await page.click("#save-outdir");
  await page.waitForFunction((d) => document.getElementById("note").textContent.includes(d), outDir);

  await page.fill("#urls", "https://www.youtube.com/watch?v=v1");
  await page.waitForFunction(() => document.getElementById("filename").value === "範例影片");
  assert.equal(await page.isEnabled("#filename"), true);
  await page.selectOption("#quality", "720");
  await page.click("#download");
  await page.waitForSelector("#summary:not([hidden])");
  assert.match(await page.textContent("#summary"), /完成 1/);
  assert.ok(fs.existsSync(path.join(outDir, "範例影片.mp4")), "downloaded file is named after the title");
  console.log("OK");
} catch (error) {
  console.log(`FAIL: ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await context.close();
}
