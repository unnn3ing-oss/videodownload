import test from "node:test";
import assert from "node:assert/strict";
import { gitBlobSha } from "../lib/gitsha.js";
import {
  UpdateError, assertSameKey, checkLatest, downloadAll, runUpdate, shouldCheck, verifyFolder, writeFiles,
} from "../lib/updater.js";
import { summarizeCheck } from "../lib/update-state.js";

const REPO = { owner: "o", repo: "r", branch: "release" };
const COMMIT = "c".repeat(40);
const TREE = "t".repeat(40);
const COMMIT_URL = "https://api.github.com/repos/o/r/commits/release";
const TREE_URL = `https://api.github.com/repos/o/r/git/trees/${TREE}?recursive=1`;
const enc = (text) => new TextEncoder().encode(text);
const dec = (bytes) => new TextDecoder().decode(bytes);
const commitJson = (message = "release: v2\n\nbody") => ({
  sha: COMMIT, commit: { tree: { sha: TREE }, committer: { date: "2026-10-05T00:00:00Z" }, message },
});
const blobItem = async (path, content) => ({ path, type: "blob", sha: await gitBlobSha(enc(content)), size: enc(content).length });
const readLocal = (files) => async (path) => (files[path] === undefined ? null : enc(files[path]));

function makeFetch(routes, calls = []) {
  return async (url) => {
    calls.push(url);
    const route = routes[url];
    if (route instanceof Error) throw route;
    if (!route) return { ok: false, status: 404, json: async () => ({}), headers: { get: () => null } };
    if (route.bytes) {
      const b = route.bytes;
      return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
    }
    const status = route.status ?? 200;
    const headers = { get: (name) => route.headers?.[name.toLowerCase()] ?? null };
    return { ok: status < 400, status, json: async () => route.json, headers };
  };
}

// In-memory stand-in for a FileSystemDirectoryHandle.
function fakeDir({ files = {}, failOn = null, onWrite = () => {} } = {}) {
  const store = new Map(Object.entries(files));
  const dirs = new Set();
  const make = (prefix) => ({
    async getFileHandle(name, { create } = {}) {
      const path = prefix + name;
      if (!create && !store.has(path)) throw new Error("NotFound");
      return {
        async getFile() { return { text: async () => store.get(path) }; },
        async createWritable() {
          if (failOn === path) throw new Error("disk full");
          return { async write(bytes) { store.set(path, dec(bytes)); onWrite(path); }, async close() {} };
        },
      };
    },
    async getDirectoryHandle(name) { dirs.add(prefix + name); return make(`${prefix}${name}/`); },
  });
  return { ...make(""), store, dirs };
}

async function checkRoutes({ tree, message } = {}) {
  return { [COMMIT_URL]: { json: commitJson(message) }, [TREE_URL]: { json: { tree, truncated: false } } };
}

test("checkLatest lists only changed extension files and returns the host files", async () => {
  const calls = [];
  const tree = [
    await blobItem("extension/manifest.json", '{"v":2}'),
    await blobItem("extension/lib/a.js", "same"),
    await blobItem("extension/lib/new.js", "brand new"),
    await blobItem("extension/tests/x.js", "ignored"),
    await blobItem("host/host.py", "print(1)"),
  ];
  const info = await checkLatest({
    fetchFn: makeFetch(await checkRoutes({ tree }), calls), repo: REPO,
    readLocal: readLocal({ "manifest.json": '{"v":1}', "lib/a.js": "same" }),
  });
  assert.deepEqual(calls, [COMMIT_URL, TREE_URL]);
  assert.deepEqual(info.extChanged.map((e) => e.path), ["manifest.json", "lib/new.js"]);
  assert.deepEqual(info.hostFiles.map((e) => e.path), ["host.py"]);
  assert.equal(info.hasUpdate, true);
  assert.deepEqual([info.sha, info.message, info.date], [COMMIT, "release: v2", "2026-10-05T00:00:00Z"]);
});

test("checkLatest does not report CRLF-only differences", async () => {
  const tree = [await blobItem("extension/lib/a.js", "a\nb\n")];
  const info = await checkLatest({
    fetchFn: makeFetch(await checkRoutes({ tree })), repo: REPO, readLocal: readLocal({ "lib/a.js": "a\r\nb\r\n" }),
  });
  assert.equal(info.hasUpdate, false);
});

test("checkLatest maps GitHub failures to friendly messages", async () => {
  const cases = [
    [{ [COMMIT_URL]: new Error("offline") }, /連不上 GitHub，請確認網路連線/],
    [{ [COMMIT_URL]: { status: 403, headers: { "x-ratelimit-remaining": "0" } } }, /暫時限制查詢次數/],
    [{ [COMMIT_URL]: { status: 429 } }, /暫時限制查詢次數/],
    [{ [COMMIT_URL]: { status: 403 } }, /HTTP 403.*代理|HTTP 403.*防火牆/],
    // GitHub answers 422 ("No commit found for SHA: release") for a branch that does not exist.
    [{ [COMMIT_URL]: { status: 422 } }, /尚未發佈：找不到 release 分支/],
    [{ [COMMIT_URL]: { status: 404 } }, /尚未發佈：找不到 release 分支/],
    [{ [COMMIT_URL]: { status: 500 } }, /HTTP 500/],
    [{ [COMMIT_URL]: { json: commitJson() }, [TREE_URL]: { json: { tree: [], truncated: true } } }, /檔案太多/],
    [{ [COMMIT_URL]: { json: commitJson() }, [TREE_URL]: { json: { tree: [{ path: "extension/../x.js", type: "blob", sha: "a".repeat(40), size: 1 }], truncated: false } } }, /不安全/],
  ];
  for (const [routes, pattern] of cases) {
    await assert.rejects(checkLatest({ fetchFn: makeFetch(routes), repo: REPO, readLocal: readLocal({}) }),
      (error) => error instanceof UpdateError && pattern.test(error.message), String(pattern));
  }
});

test("shouldCheck honours the 6 hour interval", () => {
  const now = 10_000_000_000;
  const hour = 3_600_000;
  assert.equal(shouldCheck(undefined, now), true);
  assert.equal(shouldCheck(now - hour, now), false);
  assert.equal(shouldCheck(now - 6 * hour, now), true);
  assert.equal(shouldCheck(now - hour, now, hour), true);
});

test("downloadAll fetches from the pinned commit url", async () => {
  const calls = [];
  const entry = { path: "lib/a b.js", sha: await gitBlobSha(enc("x")) };
  const url = `https://raw.githubusercontent.com/o/r/${COMMIT}/extension/lib/a%20b.js`;
  const got = await downloadAll([entry], { sha: COMMIT, repo: REPO, fetchFn: makeFetch({ [url]: { bytes: enc("x") } }, calls) });
  assert.deepEqual(calls, [url]);
  assert.deepEqual(got.map((f) => [f.path, dec(f.bytes)]), [["lib/a b.js", "x"]]);
});

test("downloadAll verifies every file and returns nothing when one is tampered", async () => {
  const entries = [{ path: "a.js", sha: await gitBlobSha(enc("A")) }, { path: "b.js", sha: await gitBlobSha(enc("B")) }];
  const url = (name) => `https://raw.githubusercontent.com/o/r/${COMMIT}/extension/${name}`;
  const fetchFn = makeFetch({ [url("a.js")]: { bytes: enc("A") }, [url("b.js")]: { bytes: enc("tampered") } });
  await assert.rejects(downloadAll(entries, { sha: COMMIT, repo: REPO, fetchFn }), /b\.js.*不一致/);
  await assert.rejects(downloadAll(entries, { sha: "main", repo: REPO, fetchFn }), /commit/);
});

test("assertSameKey rejects a changed manifest key", () => {
  const manifest = (key) => [{ path: "manifest.json", bytes: enc(JSON.stringify({ key })) }];
  assert.doesNotThrow(() => assertSameKey([], "K"));
  assert.doesNotThrow(() => assertSameKey(manifest("K"), "K"));
  assert.throws(() => assertSameKey(manifest("OTHER"), "K"), /識別碼/);
  assert.throws(() => assertSameKey([{ path: "manifest.json", bytes: enc("{nope") }], "K"), /manifest\.json/);
});

test("verifyFolder requires a manifest.json with the extension's name", async () => {
  await verifyFolder(fakeDir({ files: { "manifest.json": '{"name":"X"}' } }), "X");
  await assert.rejects(verifyFolder(fakeDir(), "X"), /找不到 manifest\.json/);
  await assert.rejects(verifyFolder(fakeDir({ files: { "manifest.json": '{"name":"Y"}' } }), "X"), /不是「X」/);
});

test("writeFiles writes manifest.json last and creates directories", async () => {
  const written = [];
  const dir = fakeDir({ onWrite: (path) => written.push(path) });
  await writeFiles(dir, [
    { path: "manifest.json", bytes: enc("M") }, { path: "lib/a.js", bytes: enc("A") },
    { path: "installers/x.zip", bytes: enc("Z") },
  ]);
  assert.deepEqual(written, ["lib/a.js", "installers/x.zip", "manifest.json"]);
  assert.deepEqual([...dir.dirs].sort(), ["installers", "lib"]);
  await assert.rejects(writeFiles(fakeDir(), [{ path: "../evil.js", bytes: enc("x") }]), /不安全/);
});

// ---- runUpdate ---------------------------------------------------------------------------------
async function updateSetup({ tamper = false, failOn = null, extra = {} } = {}) {
  const calls = [];
  const manifestBytes = enc(JSON.stringify({ name: "X", key: "K", version: "2" }));
  const files = { "manifest.json": manifestBytes, "lib/a.js": enc("new a") };
  const entries = [];
  for (const [path, bytes] of Object.entries(files)) entries.push({ path, sha: await gitBlobSha(bytes), size: bytes.length });
  const routes = {};
  for (const [path, bytes] of Object.entries(files)) {
    routes[`https://raw.githubusercontent.com/o/r/${COMMIT}/extension/${path}`] = { bytes: tamper && path === "lib/a.js" ? enc("evil") : bytes };
  }
  const dir = fakeDir({ onWrite: (p) => calls.push(`write:${p}`), failOn });
  return {
    calls,
    deps: {
      info: { sha: COMMIT, extChanged: entries }, hostChanged: [{ path: "version.py", sha: "a".repeat(40), size: 1 }],
      getFolder: async () => { calls.push("getFolder"); return dir; }, pickFolder: async () => { calls.push("pickFolder"); return dir; },
      fetchFn: makeFetch(routes), repo: REPO, currentKey: "K", expectedName: "X",
      hostApi: {
        stage: async () => { calls.push("stage"); }, commit: async () => { calls.push("commit"); },
        rollback: async () => { calls.push("rollback"); },
      },
      reload: () => calls.push("reload"), onProgress: () => {}, ...extra,
    },
  };
}

test("runUpdate asks for the folder first, then stages and commits the host, writes, reloads", async () => {
  const { calls, deps } = await updateSetup();
  await runUpdate(deps);
  assert.deepEqual(calls, ["getFolder", "stage", "commit", "write:lib/a.js", "write:manifest.json", "reload"]);
});

test("runUpdate stops before touching anything when a download fails", async () => {
  const { calls, deps } = await updateSetup({ tamper: true });
  await assert.rejects(runUpdate(deps), /不一致/);
  assert.deepEqual(calls, ["getFolder"]);
});

test("runUpdate stops before the host is touched when the manifest key changed", async () => {
  const { calls, deps } = await updateSetup({ extra: { currentKey: "DIFFERENT" } });
  await assert.rejects(runUpdate(deps), /識別碼/);
  assert.deepEqual(calls, ["getFolder"]);
});

test("runUpdate rolls the host back and does not reload when writing fails", async () => {
  const { calls, deps } = await updateSetup({ failOn: "lib/a.js" });
  await assert.rejects(runUpdate(deps), /寫入 lib\/a\.js 失敗/);
  assert.deepEqual(calls, ["getFolder", "stage", "commit", "rollback"]);
});

test("runUpdate falls back to picking a folder when none was saved", async () => {
  const { calls, deps } = await updateSetup({ extra: { getFolder: async () => null } });
  await runUpdate(deps);
  assert.equal(calls[0], "pickFolder");
});

test("runUpdate skips the folder when only host files changed", async () => {
  const { calls, deps } = await updateSetup();
  deps.info = { sha: COMMIT, extChanged: [] };
  await runUpdate(deps);
  assert.deepEqual(calls, ["stage", "commit", "reload"]);
});

test("summarizeCheck keeps what the badge and panel need", () => {
  const info = { sha: COMMIT, date: "d", message: "m", hasUpdate: true, extChanged: [1, 2], hostFiles: [1] };
  assert.deepEqual(summarizeCheck(info, 123), {
    checkedAt: 123, sha: COMMIT, date: "d", message: "m", hasUpdate: true, extChangedCount: 2,
  });
});
