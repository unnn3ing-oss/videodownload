import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitBlobSha } from "../lib/gitsha.js";
import { UpdateError } from "../lib/updater.js";
import { buildZip, crc32 } from "../lib/zip.js";
import { assertDeployFolder, buildExtensionZip, deployToFolder, fetchExtensionFiles } from "../lib/deploy.js";
import { EXTENSION_NAME } from "../lib/constants.js";

const enc = (text) => new TextEncoder().encode(text);
const dec = (bytes) => new TextDecoder().decode(bytes);
const REPO = { owner: "o", repo: "r", branch: "main" };
const COMMIT = "c".repeat(40);
const TREE = "t".repeat(40);
const API = "https://api.github.com/repos/o/r";

// A folder that behaves like a FileSystemDirectoryHandle: entries(), nested directories, writable files.
function fakeDir({ files = {}, name = "chosen", onWrite = () => {} } = {}) {
  const store = new Map(Object.entries(files));
  const dirs = new Set();
  const make = (prefix, dirName) => ({
    name: dirName,
    async *entries() {
      const seen = new Set();
      for (const key of store.keys()) {
        if (!key.startsWith(prefix)) continue;
        const first = key.slice(prefix.length).split("/")[0];
        if (!seen.has(first)) { seen.add(first); yield [first, {}]; }
      }
    },
    async getFileHandle(fileName, { create } = {}) {
      const full = prefix + fileName;
      if (!create && !store.has(full)) throw new Error("NotFound");
      return {
        async getFile() { return { text: async () => store.get(full) }; },
        async createWritable() { return { async write(bytes) { store.set(full, dec(bytes)); onWrite(full); }, async close() {} }; },
      };
    },
    async getDirectoryHandle(child) { dirs.add(prefix + child); return make(`${prefix}${child}/`, child); },
  });
  return { ...make("", name), store };
}

async function blobItem(file, content) {
  return { path: file, type: "blob", sha: await gitBlobSha(enc(content)), size: enc(content).length };
}

async function githubFor(contents, { tamper = null, calls = [] } = {}) {
  const tree = [];
  for (const [file, content] of Object.entries(contents)) tree.push(await blobItem(file, content));
  const routes = {
    [`${API}/commits/main`]: { json: { sha: COMMIT, commit: { tree: { sha: TREE }, committer: { date: "d" }, message: "m" } } },
    [`${API}/git/trees/${TREE}?recursive=1`]: { json: { tree, truncated: false } },
  };
  for (const [file, content] of Object.entries(contents)) {
    routes[`https://raw.githubusercontent.com/o/r/${COMMIT}/${file}`] = { bytes: enc(tamper === file ? "evil" : content) };
  }
  return async (url) => {
    calls.push(url);
    const route = routes[url];
    if (!route) return { ok: false, status: 404, headers: { get: () => null } };
    if (route.bytes) {
      const b = route.bytes;
      return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
    }
    return { ok: true, status: 200, json: async () => route.json, headers: { get: () => null } };
  };
}

const SITE = {
  "extension/manifest.json": JSON.stringify({ name: EXTENSION_NAME, version: "9" }),
  "extension/lib/a.js": "export const a = 1;",
  "extension/installers/x.cmd": "@echo off",
  "extension/tests/x.test.mjs": "ignored",
  "host/host.py": "print(1)",
};

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(enc("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test("buildZip makes an archive other tools can read, with unicode names and empty files", async () => {
  const big = new Uint8Array(70000).map((_, i) => i % 251);
  const blob = buildZip([
    { name: "dir/測試.js", bytes: enc("// 你好") },
    { name: "empty.txt", bytes: new Uint8Array(0) },
    { name: "big.bin", bytes: big },
  ]);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zip-")), "t.zip");
  fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  const out = execFileSync("python3", ["-c", `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
print(json.dumps({"bad": z.testzip(), "names": z.namelist(), "text": z.read("dir/測試.js").decode(), "big": len(z.read("big.bin")), "empty": len(z.read("empty.txt"))}, ensure_ascii=False))
`, file], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(out), { bad: null, names: ["dir/測試.js", "empty.txt", "big.bin"], text: "// 你好", big: 70000, empty: 0 });
});

test("assertDeployFolder accepts an empty folder or this extension's own folder only", async () => {
  await assertDeployFolder(fakeDir());
  await assertDeployFolder(fakeDir({ files: { "manifest.json": JSON.stringify({ name: EXTENSION_NAME }), "lib/a.js": "x" } }));
  await assert.rejects(assertDeployFolder(fakeDir({ files: { "photo.jpg": "x" }, name: "文件" })),
    (e) => e instanceof UpdateError && /「文件」裡已經有其他檔案/.test(e.message));
  await assert.rejects(assertDeployFolder(fakeDir({ files: { "manifest.json": JSON.stringify({ name: "別的擴充功能" }) } })), /已經有其他檔案/);
  await assert.rejects(assertDeployFolder(fakeDir({ files: { "manifest.json": "{not json" } })), /已經有其他檔案/);
});

test("fetchExtensionFiles returns only extension files, verified, tests excluded", async () => {
  const calls = [];
  const files = await fetchExtensionFiles({ fetchFn: await githubFor(SITE, { calls }), repo: REPO });
  assert.deepEqual(files.map((f) => f.path).sort(), ["installers/x.cmd", "lib/a.js", "manifest.json"]);
  assert.equal(dec(files.find((f) => f.path === "lib/a.js").bytes), "export const a = 1;");
  assert.ok(!calls.some((u) => u.includes("/host/") || u.includes("/tests/")));
});

test("fetchExtensionFiles gives nothing at all when one download does not match", async () => {
  await assert.rejects(fetchExtensionFiles({ fetchFn: await githubFor(SITE, { tamper: "extension/lib/a.js" }), repo: REPO }),
    /a\.js.*不一致/);
});

test("deployToFolder refuses a wrong folder before downloading anything", async () => {
  const calls = [];
  const dir = fakeDir({ files: { "other.txt": "x" } });
  await assert.rejects(deployToFolder(dir, { fetchFn: await githubFor(SITE, { calls }), repo: REPO }), /已經有其他檔案/);
  assert.deepEqual(calls, []);
  assert.deepEqual([...dir.store.keys()], ["other.txt"]);
});

test("deployToFolder writes everything and manifest.json last", async () => {
  const written = [];
  const dir = fakeDir({ onWrite: (p) => written.push(p) });
  const count = await deployToFolder(dir, { fetchFn: await githubFor(SITE), repo: REPO });
  assert.equal(count, 3);
  assert.equal(written.at(-1), "manifest.json");
  assert.deepEqual([...written].sort(), ["installers/x.cmd", "lib/a.js", "manifest.json"]);
});

test("deployToFolder writes nothing when a download is tampered with", async () => {
  const dir = fakeDir();
  await assert.rejects(deployToFolder(dir, { fetchFn: await githubFor(SITE, { tamper: "extension/manifest.json" }), repo: REPO }), /不一致/);
  assert.equal(dir.store.size, 0);
});

test("buildExtensionZip packs the verified files under one folder", async () => {
  const { blob, count } = await buildExtensionZip({ fetchFn: await githubFor(SITE), repo: REPO });
  assert.equal(count, 3);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zip-")), "e.zip");
  fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  const names = JSON.parse(execFileSync("python3", ["-c", "import json,sys,zipfile; print(json.dumps(sorted(zipfile.ZipFile(sys.argv[1]).namelist())))", file], { encoding: "utf8" }));
  assert.deepEqual(names, [
    "YouTube-batch-downloader-extension/installers/x.cmd",
    "YouTube-batch-downloader-extension/lib/a.js",
    "YouTube-batch-downloader-extension/manifest.json",
  ]);
});
