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

// ---- the extension wears the same icon as the web page ----
import { inflateSync } from "node:zlib";

const SIZES = ["16", "32", "48", "128"];
const png = (file) => readFileSync(new URL(`../icons/${file}`, import.meta.url));

// First pixel of a PNG, straight from its header and first scanline (the filters leave the first pixel as it is).
function pngInfo(buffer) {
  assert.equal(buffer.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "a PNG file");
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const colorType = buffer[25];
  const chunks = [];
  for (let at = 8; at < buffer.length;) {
    const length = buffer.readUInt32BE(at);
    if (buffer.toString("latin1", at + 4, at + 8) === "IDAT") chunks.push(buffer.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  return { width, height, colorType, firstPixel: [...raw.subarray(1, 5)] };
}

test("the manifest gives the extension and its toolbar button an icon in every size, and the files are those sizes", () => {
  assert.deepEqual(Object.keys(manifest.icons).sort(), [...SIZES].sort());
  assert.deepEqual(manifest.action.default_icon, manifest.icons, "the toolbar button uses the same icons");
  for (const size of SIZES) {
    const info = pngInfo(png(manifest.icons[size].replace("icons/", "")));
    assert.deepEqual([info.width, info.height], [Number(size), Number(size)], `icon ${size}`);
    assert.equal(info.colorType, 6, "RGBA: the rounded corners are transparent");
    assert.equal(info.firstPixel[3], 0, `the corner of icon ${size} is transparent`);
  }
});

test("the web page's tab icon is the very same drawing as the extension's", () => {
  const svg = readFileSync(new URL("../icons/icon.svg", import.meta.url), "utf8");
  assert.match(svg, /#1f5eff/);
  const page = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  assert.match(page, /<link rel="icon" href="extension\/icons\/icon\.svg"/, "one source for both");
  assert.ok(existsSync(new URL("../icons/icon.svg", import.meta.url)));
});

// ---- content security policy: only our own scripts run; the only outside addresses are the ones the code really uses ----
import { readdirSync } from "node:fs";

const csp = (text) => Object.fromEntries(String(text).split(";").map((part) => part.trim().split(/\s+/)).filter((p) => p[0]).map(([name, ...values]) => [name, values]));

test("the extension pages carry a strict content security policy", () => {
  const policy = csp(manifest.content_security_policy?.extension_pages);
  assert.deepEqual(policy["default-src"], ["'none'"]);
  assert.deepEqual(policy["script-src"], ["'self'"]);
  assert.deepEqual(policy["object-src"], ["'none'"]);
  assert.deepEqual(policy["connect-src"].sort(), ["'self'", "https://api.github.com", "https://i.ytimg.com", "https://raw.githubusercontent.com"]);
  for (const [name, values] of Object.entries(policy)) {
    assert.ok(!values.some((v) => /unsafe|\*|^https?:$/.test(v)), `${name} must not allow ${values}`);
  }
});

test("the web page carries the same kind of policy, and no inline script or style needs it to be loosened", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const tag = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(tag, "index.html needs a Content-Security-Policy meta tag");
  const policy = csp(tag[1]);
  assert.deepEqual(policy["script-src"], ["'self'"]);
  // (the page itself fetches the extension's files from GitHub when it puts them in a folder or builds the ZIP)
  assert.deepEqual(policy["connect-src"].sort(), ["'self'", "https://api.github.com", "https://raw.githubusercontent.com"]);
  assert.deepEqual(policy["default-src"], ["'none'"]);
  for (const page of [html, readFileSync(new URL("../sidepanel.html", import.meta.url), "utf8")]) {
    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(page), "no inline <script>");
    assert.ok(!/<style[\s>]/i.test(page) && !/\sstyle=/i.test(page), "no inline style");
    assert.ok(!/\son[a-z]+\s*=/i.test(page), "no inline event handler");
  }
});

test("the code reaches no outside address the policies do not list", () => {
  const allowed = ["https://api.github.com", "https://raw.githubusercontent.com", "https://i.ytimg.com"];
  const files = [...readdirSync(new URL("../lib/", import.meta.url)).filter((f) => f.endsWith(".js")).map((f) => `../lib/${f}`),
                 "../background.js", "../sidepanel.js", "../../web/app.js", "../../web/bridge-client.js"];
  for (const file of files) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const [, origin] of text.matchAll(/(?:fetch\(|\.src\s*=|new Image|url:)\s*[`"'](https?:\/\/[^/`"'$]+)/g)) {
      assert.ok(allowed.includes(origin), `${file} reaches ${origin}`);
    }
  }
});
