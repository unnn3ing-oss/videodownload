// A stand-in for the two GitHub endpoints the updater talks to, built from the files of this repository.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { UPDATE_REPO } from "../../lib/update-config.js";

export const COMMIT = "e".repeat(40);
export const TREE = "f".repeat(40);

const blobSha = (bytes) => crypto.createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest("hex");

// overrides: { "<repo path>": string | Buffer | (current: Buffer | undefined) => string | Buffer } replace or add files.
export function buildFixture({ repoRoot, overrides = {}, message = "release: e2e fixture" }) {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "extension", "host"], { cwd: repoRoot })
    .toString().split("\0").filter(Boolean);
  const files = new Map();
  for (const rel of listed) {
    const full = path.join(repoRoot, rel);
    if (fs.existsSync(full)) files.set(rel, fs.readFileSync(full));
  }
  for (const [rel, value] of Object.entries(overrides)) {
    const next = typeof value === "function" ? value(files.get(rel)) : value;
    files.set(rel, Buffer.isBuffer(next) ? next : Buffer.from(next));
  }
  const tree = [...files].map(([rel, bytes]) => ({ path: rel, type: "blob", mode: "100644", sha: blobSha(bytes), size: bytes.length }));
  const { owner, repo, branch } = UPDATE_REPO;

  // tamper: a Set of repo paths (mutable by the caller) whose downloaded content is altered.
  function routes(context, { tamper = new Set() } = {}) {
    const cors = { "access-control-allow-origin": "*" };
    const json = (route, body) => route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify(body) });
    return Promise.all([
      context.route((url) => url.hostname === "api.github.com", (route) => {
        const { pathname } = new URL(route.request().url());
        if (pathname === `/repos/${owner}/${repo}/commits/${branch}`) {
          return json(route, { sha: COMMIT, commit: { message: `${message}\n\nbody`, tree: { sha: TREE }, committer: { date: "2026-10-05T00:00:00Z" } } });
        }
        if (pathname === `/repos/${owner}/${repo}/git/trees/${TREE}`) return json(route, { sha: TREE, tree, truncated: false });
        return route.fulfill({ status: 404, headers: cors, contentType: "application/json", body: "{}" });
      }),
      context.route((url) => url.hostname === "raw.githubusercontent.com", (route) => {
        const prefix = `/${owner}/${repo}/${COMMIT}/`;
        const { pathname } = new URL(route.request().url());
        const rel = pathname.startsWith(prefix) ? decodeURIComponent(pathname.slice(prefix.length)) : null;
        if (rel === null || !files.has(rel)) return route.fulfill({ status: 404, headers: cors, body: "" });
        const bytes = tamper.has(rel) ? Buffer.concat([files.get(rel), Buffer.from("\n/* tampered */")]) : files.get(rel);
        return route.fulfill({ status: 200, headers: cors, contentType: "application/octet-stream", body: bytes });
      }),
    ]);
  }

  return { owner, repo, commit: COMMIT, message, files, tree, routes };
}

// The host downloads its files itself (not through the browser): lay them out where host_with_fake_github.py reads them.
export function writeHostFiles(fixture, dir) {
  const target = path.join(dir, fixture.commit, "host");
  fs.mkdirSync(target, { recursive: true });
  for (const [rel, bytes] of fixture.files) {
    if (/^host\/[A-Za-z0-9_]+\.py$/.test(rel)) fs.writeFileSync(path.join(target, path.basename(rel)), bytes);
  }
}
