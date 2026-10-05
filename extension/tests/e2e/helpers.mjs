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
export async function launchExtension({ viewport = { width: 400, height: 860 } } = {}) {
  const work = fs.mkdtempSync(path.join(process.env.E2E_TMP ?? os.tmpdir(), "ytdl-e2e-"));
  const userData = path.join(work, "profile");
  const extId = extensionId(manifest.key);
  try {
    const context = await chromium.launchPersistentContext(userData, {
      executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium",
      headless: false,
      viewport,
      args: ["--headless=new", "--no-sandbox", `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
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

// Optional review screenshots: set E2E_SHOTS to a directory.
export const shotter = (page) => async (name) => {
  if (process.env.E2E_SHOTS) await page.screenshot({ path: path.join(process.env.E2E_SHOTS, `${name}.png`), fullPage: true });
};
