// Shared setup for the end-to-end checks: launch Chromium with the extension and register a native host.
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const extDir = path.join(root, "extension");
export const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
export const HOST_NAME = "com.ytdl.batch_downloader";

// Chrome derives an extension id from the pinned public key: sha256, first 16 bytes, hex digits mapped to a-p.
export function extensionId(keyB64) {
  const hex = crypto.createHash("sha256").update(Buffer.from(keyB64, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

// Exit codes of the callers: 0 = OK, 1 = assertion failed, 2 = UNVERIFIED (browser/extension could not be launched).
export async function launchExtension({ viewport = { width: 400, height: 860 }, args = [] } = {}) {
  const work = fs.mkdtempSync(path.join(process.env.E2E_TMP ?? os.tmpdir(), "ytdl-e2e-"));
  const userData = path.join(work, "profile");
  const extId = extensionId(manifest.key);
  try {
    const context = await chromium.launchPersistentContext(userData, {
      executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium",
      headless: false,
      viewport,
      // Chromium turns a non-ASCII file name given to chrome.downloads into "Invalid filename" unless the locale is UTF-8
      env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
      args: ["--headless=new", "--no-sandbox", `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, ...args],
    });
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker", { timeout: 20000 });
    assert.equal(new URL(worker.url()).hostname, extId, "pinned extension id must match the manifest key");
    return { context, extId, work, userData };
  } catch (error) {
    console.log(`UNVERIFIED: could not launch the extension in headless Chromium: ${error.message.split("\n")[0]}`);
    process.exit(2);
  }
}

export function registerNativeHost({ userData, wrapperPath, extId }) {
  const nmDir = path.join(userData, "NativeMessagingHosts");
  fs.mkdirSync(nmDir, { recursive: true });
  fs.writeFileSync(path.join(nmDir, `${HOST_NAME}.json`), JSON.stringify({
    name: HOST_NAME, description: "e2e", path: wrapperPath, type: "stdio",
    allowed_origins: [`chrome-extension://${extId}/`],
  }));
}

// Headless Chromium reports "(hover: none)"; with these flags it behaves like a computer with a mouse,
// which the hover styles of the list need in order to be tested at all.
export const HOVER_ARGS = ["--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4"];

// Optional review screenshots: set E2E_SHOTS to a directory.
export const shotter = (page) => async (name) => {
  if (process.env.E2E_SHOTS) await page.screenshot({ path: path.join(process.env.E2E_SHOTS, `${name}.png`), fullPage: true });
};

// Serve the repository's files as if GitHub Pages hosted them at https://unnn3ing-oss.github.io/videodownload/
// (the extension's content script matches that address).
export const PAGES_URL = "https://unnn3ing-oss.github.io/videodownload/";
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
export async function servePages(context, repoRoot = root) {
  await context.route(`${PAGES_URL}**`, (route) => {
    const { pathname } = new URL(route.request().url());
    let rel = decodeURIComponent(pathname.slice("/videodownload/".length));
    if (rel === "" || rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(repoRoot, rel);
    if (!file.startsWith(repoRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
    }
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] ?? "application/octet-stream", body: fs.readFileSync(file) });
  });
}
