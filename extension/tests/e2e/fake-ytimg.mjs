// A stand-in for i.ytimg.com (cover images). The extension's background script fetches covers itself, and
// Playwright cannot intercept service-worker requests, so the browser is pointed at this local HTTPS server with
//   --host-resolver-rules="MAP i.ytimg.com 127.0.0.1:<port>" --ignore-certificate-errors --no-proxy-server (a system proxy would otherwise swallow the request)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

// A real, decodable 16x9 JPEG (so <img> shows it); each answer carries a comment naming its video and size.
const BASE_JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAJABADASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAAAAMF/8QAHRAAAQQCAwAAAAAAAAAAAAAAAQIDBBEAEgVBYf/EABUBAQEAAAAAAAAAAAAAAAAAAAUG/8QAGREAAwADAAAAAAAAAAAAAAAAABESASKB/9oADAMBAAIRAxEAPwC3BMwnpi0zygNBskbr0F2O7HuOdZhMzEJgFBaLYJ0XuLs92fMzcZQRm6fA2tUj/9k=", "base64");
const APP0_END = 20; // SOI (2) + the JFIF APP0 segment (18)
function jpegFor(note) {
  const text = Buffer.from(note);
  const comment = Buffer.concat([Buffer.from([0xff, 0xfe, (text.length + 2) >> 8, (text.length + 2) & 0xff]), text]);
  return Buffer.concat([BASE_JPEG.subarray(0, APP0_END), comment, BASE_JPEG.subarray(APP0_END)]);
}

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
      res.writeHead(200, { "content-type": "image/jpeg", "access-control-allow-origin": "*" });
      res.end(jpegFor(`${match[1]}:${match[2]}`));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    requests,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }), // keep-alive sockets would hold it open
    args: () => [`--host-resolver-rules=MAP i.ytimg.com 127.0.0.1:${server.address().port}`, "--ignore-certificate-errors", "--no-proxy-server"],
  };
}
