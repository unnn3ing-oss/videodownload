import test from "node:test";
import assert from "node:assert/strict";
import { gitBlobSha, sameContent } from "../lib/gitsha.js";
import { isSafeRelativePath, mapTree, MAX_FILES, MAX_FILE_BYTES } from "../lib/update-rules.js";

const enc = (text) => new TextEncoder().encode(text);
const h = (c) => c.repeat(40);

test("gitBlobSha matches git hash-object vectors", async () => {
  assert.equal(await gitBlobSha(enc("hello\n")), "ce013625030ba8dba906f756967f9e9ca394464a");
  assert.equal(await gitBlobSha(enc("")), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
});

test("sameContent ignores CRLF-only differences for text files but not binary", async () => {
  const sha = await gitBlobSha(enc("a\nb\n"));
  assert.equal(await sameContent("x.js", enc("a\nb\n"), sha), true);
  assert.equal(await sameContent("x.js", enc("a\r\nb\r\n"), sha), true);
  assert.equal(await sameContent("x.png", enc("a\r\nb\r\n"), sha), false);
  assert.equal(await sameContent("x.js", enc("other"), sha), false);
  assert.equal(await sameContent("x.js", null, sha), false);
});

test("isSafeRelativePath rejects traversal, absolute, backslash, drive letters and .git", () => {
  for (const ok of ["a.js", "lib/a.js", "installers/install-mac.zip", "a b.js"]) {
    assert.equal(isSafeRelativePath(ok), true, ok);
  }
  for (const bad of ["", "/a", "../a", "a/../b", "a//b", "a\\b", "C:/a", ".git/config", "a/.git/x", "a/", ".", "x".repeat(201)]) {
    assert.equal(isSafeRelativePath(bad), false, bad);
  }
});

test("mapTree maps extension and host files and applies exclusions", () => {
  const out = mapTree([
    { path: "README.md", type: "blob", sha: h("a"), size: 1 },
    { path: "extension", type: "tree", sha: h("b") },
    { path: "extension/manifest.json", type: "blob", sha: h("c"), size: 100 },
    { path: "extension/lib/updater.js", type: "blob", sha: h("d"), size: 200 },
    { path: "extension/installers/install-mac.zip", type: "blob", sha: h("e"), size: 300 },
    { path: "extension/tests/x.js", type: "blob", sha: h("f"), size: MAX_FILE_BYTES + 1 },
    { path: "host/host.py", type: "blob", sha: h("1"), size: 50 },
    { path: "host/tests/t.py", type: "blob", sha: h("2"), size: 5 },
    { path: "host/notes.txt", type: "blob", sha: h("3"), size: 5 },
    { path: "tests/test_build.py", type: "blob", sha: h("4"), size: 5 },
  ]);
  assert.deepEqual(out.extension.map((e) => e.path), ["manifest.json", "lib/updater.js"]);
  assert.deepEqual(out.extension[0], { path: "manifest.json", repoPath: "extension/manifest.json", sha: h("c"), size: 100 });
  assert.deepEqual(out.host, [{ path: "host.py", sha: h("1"), size: 50 }]);
});

test("mapTree rejects unsafe paths, oversized files and too many files", () => {
  const blob = (path, size = 1) => ({ path, type: "blob", sha: h("a"), size });
  for (const path of ["extension/../x.js", "extension/a\\b.js", "extension/.git/config", "extension/C:/x", "host/../x.py", "host/.git/x"]) {
    assert.throws(() => mapTree([blob(path)]), /不安全/, path);
  }
  assert.throws(() => mapTree([blob("extension/big.bin", MAX_FILE_BYTES + 1)]), /過大/);
  assert.throws(() => mapTree([blob("host/big.py", MAX_FILE_BYTES + 1)]), /過大/);
  const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => blob(`extension/f${i}.js`));
  assert.throws(() => mapTree(many), /數量/);
});
