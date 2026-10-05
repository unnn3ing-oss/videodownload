import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

test("manifest declares the permissions the updater needs", () => {
  for (const permission of ["alarms", "sidePanel", "storage"]) assert.ok(manifest.permissions.includes(permission), permission);
  for (const host of ["https://api.github.com/*", "https://raw.githubusercontent.com/*"]) {
    assert.ok(manifest.host_permissions.includes(host), host);
  }
  assert.ok(manifest.key, "the pinned key keeps the extension id stable");
});
