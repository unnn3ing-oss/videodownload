// A stand-in for i.ytimg.com (cover images). The extension's background script fetches covers itself, and
// Playwright cannot intercept service-worker requests, so the browser is pointed at this local HTTPS server with
//   --host-resolver-rules="MAP i.ytimg.com 127.0.0.1:<port>" --ignore-certificate-errors --no-proxy-server (a system proxy would otherwise swallow the request)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

// covers: { "<video id>": ["hq720", ...] } lists the sizes that exist; every other size answers 404.
export async function startFakeYtimg({ covers = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ytimg-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1",
    "-subj", "/CN=i.ytimg.com", "-addext", "subjectAltName=DNS:i.ytimg.com"], { stdio: "ignore" });
  const requests = [];
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    const match = /^\/vi\/([^/]+)\/([^/.]+)\.jpg$/.exec(req.url);
    requests.push(req.url);
    if (match && (covers[match[1]] ?? []).includes(match[2])) {
      // minimal JPEG start plus a note of which size this is, so tests can tell the sizes apart
      res.writeHead(200, { "content-type": "image/jpeg", "access-control-allow-origin": "*" });
      res.end(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`${match[1]}:${match[2]}`)]));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
    args: () => [`--host-resolver-rules=MAP i.ytimg.com 127.0.0.1:${server.address().port}`, "--ignore-certificate-errors", "--no-proxy-server"],
  };
}
