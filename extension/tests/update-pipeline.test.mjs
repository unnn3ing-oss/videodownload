import test from "node:test";
import assert from "node:assert/strict";
import { gitBlobSha } from "../lib/gitsha.js";
import { UpdateError } from "../lib/updater.js";
import { applyUpdate, collectUpdateInfo } from "../lib/update-pipeline.js";

const enc = (t) => new TextEncoder().encode(t);
const dec = (b) => new TextDecoder().decode(b);
const SHA = "c".repeat(40);
const KEY = "KEY";
const REPO = { owner: "o", repo: "r", branch: "main" };

async function entry(path, text) {
  return { path, sha: await gitBlobSha(enc(text)), size: enc(text).length };
}

// A GitHub whose raw files are `files` ("extension/..." and "host/..." paths), at the commit SHA.
function fakeFetch(files) {
  return async (url) => {
    const m = /\/([0-9a-f]{40})\/(.+)$/.exec(url);
    const body = m && files[decodeURIComponent(m[2])];
    return body === undefined ? { ok: false, status: 404 } : { ok: true, status: 200, arrayBuffer: async () => enc(body).buffer };
  };
}

const latest = async (over = {}) => ({
  sha: SHA, date: "2026-10-06T00:00:00Z", message: "release", hasUpdate: true,
  extChanged: [await entry("manifest.json", JSON.stringify({ version: "2.0.0", key: KEY })), await entry("background.js", "// new")],
  hostFiles: [await entry("version.py", 'VERSION = "2.0.0"\n'), await entry("host.py", "# same")],
  ...over,
});

const FILES = {
  "extension/manifest.json": JSON.stringify({ version: "2.0.0", key: KEY }), "extension/background.js": "// new",
  "host/version.py": 'VERSION = "2.0.0"\n', "host/host.py": "# same",
};

function host({ changed = ["version.py"], folder = "/Users/me/YT批量下載器", fail = {} } = {}) {
  const sent = [];
  const request = async (message) => {
    sent.push(message);
    if (fail[message.type]) return { type: "error", message: fail[message.type] };
    switch (message.type) {
      case "update_check": return { type: "update_status", changed, total: message.files.length, extensionFolder: folder };
      case "update_stage": return { type: "update_staged", count: message.files.length };
      case "update_commit": return { type: "update_applied", count: 1 };
      case "update_ext": return { type: "update_ext_applied", count: message.files.length, folder };
      default: return { type: "update_rolled_back" };
    }
  };
  return { request, sent };
}

test("the check says what changed, what version is out, and whether the host can write the extension itself", async () => {
  const h = host();
  const info = await collectUpdateInfo({ check: async () => latest(), hostRequest: h.request, fetchFn: fakeFetch(FILES), version: "1.0.0", key: KEY });
  assert.equal(info.current, "1.0.0");
  assert.equal(info.latestVersion, "2.0.0");
  assert.equal(info.sha, SHA);
  assert.deepEqual(info.extChanged.map((f) => f.path), ["manifest.json", "background.js"]);
  assert.deepEqual(info.hostChanged.map((f) => f.path), ["version.py"], "only the host files that differ");
  assert.equal(info.extensionFolder, "/Users/me/YT批量下載器");
  assert.equal(info.hasUpdate, true);
});

test("without the host the extension's own files can still be compared, and the folder is unknown", async () => {
  const info = await collectUpdateInfo({ check: async () => latest(), hostRequest: null, fetchFn: fakeFetch(FILES), version: "1.0.0", key: KEY });
  assert.equal(info.hostChecked, false);
  assert.equal(info.extensionFolder, null);
  assert.equal(info.hasUpdate, true);
});

test("nothing differs: no update, and the version stays the current one", async () => {
  const none = await latest({ extChanged: [], hostFiles: [] });
  const info = await collectUpdateInfo({ check: async () => none, hostRequest: host({ changed: [] }).request, fetchFn: fakeFetch(FILES), version: "1.0.0", key: KEY });
  assert.equal(info.hasUpdate, false);
  assert.equal(info.latestVersion, "1.0.0");
});

test("an unreachable host does not fail the check", async () => {
  const info = await collectUpdateInfo({ check: async () => latest(), hostRequest: async () => { throw new Error("gone"); }, fetchFn: fakeFetch(FILES), version: "1.0.0", key: KEY });
  assert.equal(info.hostChecked, false);
  assert.equal(info.hasUpdate, true);
});

test("applying: host files first, then the extension's files through the host, in that order", async () => {
  const h = host();
  const info = await collectUpdateInfo({ check: async () => latest(), hostRequest: h.request, fetchFn: fakeFetch(FILES), version: "1.0.0", key: KEY });
  h.sent.length = 0;
  const steps = [];
  const result = await applyUpdate({ info, hostRequest: h.request, fetchFn: fakeFetch(FILES), key: KEY, onProgress: (p) => steps.push(p.step) });
  assert.deepEqual(h.sent.map((m) => m.type), ["update_stage", "update_commit", "update_ext"]);
  const ext = h.sent[2];
  assert.deepEqual(ext.files.map((f) => f.path), ["manifest.json", "background.js"]);
  assert.equal(dec(Uint8Array.from(atob(ext.contents["background.js"]), (c) => c.charCodeAt(0))), "// new");
  assert.deepEqual(result, { extFiles: 2, hostFiles: 1 });
  assert.ok(steps.includes("download") && steps.includes("host") && steps.includes("write"));
});

test("a file that does not match GitHub's hash stops the update before the host is touched", async () => {
  const h = host();
  const info = await collectUpdateInfo({ check: async () => latest(), hostRequest: h.request, fetchFn: fakeFetch(FILES), version: "1.0.0", key: KEY });
  h.sent.length = 0;
  await assert.rejects(applyUpdate({ info, hostRequest: h.request, fetchFn: fakeFetch({ ...FILES, "extension/background.js": "// tampered" }), key: KEY }), /不一致/);
  assert.deepEqual(h.sent, []);
});

test("a new manifest with another key is refused", async () => {
  const h = host();
  const info = await collectUpdateInfo({ check: async () => latest(), hostRequest: h.request, fetchFn: fakeFetch(FILES), version: "1.0.0", key: KEY });
  h.sent.length = 0;
  await assert.rejects(applyUpdate({ info, hostRequest: h.request, fetchFn: fakeFetch(FILES), key: "OTHER" }), /識別碼/);
  assert.deepEqual(h.sent, []);
});

test("if writing the extension's files fails, the host files that were already replaced are put back", async () => {
  const h = host({ fail: { update_ext: "磁碟已滿" } });
  const info = await collectUpdateInfo({ check: async () => latest(), hostRequest: h.request, fetchFn: fakeFetch(FILES), version: "1.0.0", key: KEY });
  h.sent.length = 0;
  await assert.rejects(applyUpdate({ info, hostRequest: h.request, fetchFn: fakeFetch(FILES), key: KEY }), /磁碟已滿/);
  assert.deepEqual(h.sent.map((m) => m.type), ["update_stage", "update_commit", "update_ext", "update_rollback"]);
});

test("when the host does not know the folder, the extension's files are not written by it and the person is told what to do", async () => {
  const h = host({ folder: null });
  const info = await collectUpdateInfo({ check: async () => latest(), hostRequest: h.request, fetchFn: fakeFetch(FILES), version: "1.0.0", key: KEY });
  h.sent.length = 0;
  await assert.rejects(applyUpdate({ info, hostRequest: h.request, fetchFn: fakeFetch(FILES), key: KEY }), (e) => e instanceof UpdateError && e.code === "need_folder" && /側邊面板/.test(e.message));
  assert.deepEqual(h.sent, []);
});

test("a host-only update (no extension files differ) is applied without touching the extension's folder", async () => {
  const h = host({ folder: null });
  const only = await latest({ extChanged: [] });
  const info = await collectUpdateInfo({ check: async () => only, hostRequest: h.request, fetchFn: fakeFetch(FILES), version: "1.0.0", key: KEY });
  h.sent.length = 0;
  const result = await applyUpdate({ info, hostRequest: h.request, fetchFn: fakeFetch(FILES), key: KEY });
  assert.deepEqual(h.sent.map((m) => m.type), ["update_stage", "update_commit"]);
  assert.deepEqual(result, { extFiles: 0, hostFiles: 1 });
});
