// A stand-in for the two GitHub endpoints the updater talks to, built from the files of this repository.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
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

  // The answers of the two hosts, as { status, contentType, body } (shared by the routes and the local server below).
  // tamper: a Set of repo paths (mutable by the caller) whose downloaded content is altered.
  function answer(hostname, pathname, tamper) {
    const json = (body) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (hostname === "api.github.com") {
      if (pathname === `/repos/${owner}/${repo}/commits/${branch}`) {
        return json({ sha: COMMIT, commit: { message: `${message}\n\nbody`, tree: { sha: TREE }, committer: { date: "2026-10-05T00:00:00Z" } } });
      }
      if (pathname === `/repos/${owner}/${repo}/git/trees/${TREE}`) return json({ sha: TREE, tree, truncated: false });
      return { status: 404, contentType: "application/json", body: "{}" };
    }
    const prefix = `/${owner}/${repo}/${COMMIT}/`;
    const rel = pathname.startsWith(prefix) ? decodeURIComponent(pathname.slice(prefix.length)) : null;
    if (rel === null || !files.has(rel)) return { status: 404, contentType: "text/plain", body: "" };
    const bytes = tamper.has(rel) ? Buffer.concat([files.get(rel), Buffer.from("\n/* tampered */")]) : files.get(rel);
    return { status: 200, contentType: "application/octet-stream", body: bytes };
  }

  // For requests the page makes itself (Playwright can route those).
  function routes(context, { tamper = new Set() } = {}) {
    const cors = { "access-control-allow-origin": "*" };
    const reply = (route) => route.fulfill({ headers: cors, ...answer(new URL(route.request().url()).hostname, new URL(route.request().url()).pathname, tamper) });
    return Promise.all([
      context.route((url) => url.hostname === "api.github.com", reply),
      context.route((url) => url.hostname === "raw.githubusercontent.com", reply),
    ]);
  }

  // For requests the extension's background script makes (Playwright cannot intercept a service worker's requests): a local
  // HTTPS server, with the browser pointed at it by these arguments for launchExtension.
  async function serve({ tamper = new Set() } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fakegh-"));
    const key = path.join(dir, "key.pem");
    const cert = path.join(dir, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1",
      "-subj", "/CN=api.github.com", "-addext", "subjectAltName=DNS:api.github.com,DNS:raw.githubusercontent.com"], { stdio: "ignore" });
    const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
      const reply = answer(String(req.headers.host).split(":")[0], new URL(req.url, "https://x").pathname, tamper);
      res.writeHead(reply.status, { "content-type": reply.contentType, "access-control-allow-origin": "*" });
      res.end(reply.body);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    return {
      close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }),
      args: () => [`--host-resolver-rules=MAP api.github.com 127.0.0.1:${port}, MAP raw.githubusercontent.com 127.0.0.1:${port}`, "--ignore-certificate-errors", "--no-proxy-server"],
    };
  }

  return { owner, repo, commit: COMMIT, message, files, tree, routes, serve };
}
