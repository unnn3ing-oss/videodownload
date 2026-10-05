import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { EXTENSION_NAME, WEB_ORIGIN, WEB_PATH } from "../lib/constants.js";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

test("manifest declares the permissions the updater needs", () => {
  for (const permission of ["alarms", "sidePanel", "storage"]) assert.ok(manifest.permissions.includes(permission), permission);
  for (const host of ["https://api.github.com/*", "https://raw.githubusercontent.com/*"]) {
    assert.ok(manifest.host_permissions.includes(host), host);
  }
  assert.ok(manifest.key, "the pinned key keeps the extension id stable");
});

test("manifest declares what the queue, covers and the web bridge need", () => {
  for (const permission of ["scripting", "clipboardWrite", "downloads", "nativeMessaging"]) {
    assert.ok(manifest.permissions.includes(permission), permission);
  }
  for (const host of ["https://i.ytimg.com/*", `${WEB_ORIGIN}${WEB_PATH}*`]) assert.ok(manifest.host_permissions.includes(host), host);
  assert.equal(manifest.name, EXTENSION_NAME);
});

test("the content script runs only on the web version and its file exists", () => {
  assert.equal(manifest.content_scripts.length, 1);
  const [script] = manifest.content_scripts;
  assert.deepEqual(script.matches, [`${WEB_ORIGIN}${WEB_PATH}*`]);
  assert.deepEqual(script.js, ["bridge.js"]);
  assert.equal(script.run_at, "document_start");
  assert.ok(existsSync(new URL("../bridge.js", import.meta.url)));
});
