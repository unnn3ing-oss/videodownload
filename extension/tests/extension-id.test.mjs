// Pins the extension id.
//
// Chrome derives the id from the public key in extension/manifest.json ("key"): sha256 of the DER bytes, the first 16
// bytes, each hex digit shown as a letter a-p. The id is baked into every installed copy (the native-host manifest on
// each computer lists it in allowed_origins), so it must never change by accident. This test holds the literal id;
// every place that embeds or derives the id is compared with it.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PINNED_ID = "mimlajbhpiphbndalphgmkdehgclnglg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const manifest = JSON.parse(read("extension/manifest.json"));

function deriveId(keyB64) {
  const hex = crypto.createHash("sha256").update(Buffer.from(keyB64, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

const WHY = [
  "",
  "THE EXTENSION ID CHANGED. Do not let this through by editing the pin.",
  `The id is derived from the "key" in extension/manifest.json. This repository pins it as ${PINNED_ID}.`,
  "Every installed copy would lose its native-host connection: the file Chrome reads on each computer",
  `(com.ytdl.batch_downloader.json) only allows chrome-extension://${PINNED_ID}/, and the installers hand that id to the host.`,
  "With a different id Chrome refuses the connection (\"Chrome 拒絕連線\"), the extension can no longer reach the host,",
  "and the self-update (which would have to run through that connection) cannot repair it:",
  "every person would have to install again by hand.",
  "If the key was edited by mistake, restore it (git checkout -- extension/manifest.json).",
  "If a new id is truly intended, change PINNED_ID in this file in the same commit, regenerate the installers",
  "(python3 build.py) and plan a manual re-install for every user.",
].join("\n");

test("the extension id derived from manifest.key is the pinned one", () => {
  assert.equal(typeof manifest.key, "string", `extension/manifest.json has no "key": ${WHY}`);
  assert.equal(deriveId(manifest.key), PINNED_ID, WHY);
});

test("the pin has the shape of an extension id and the key is an RSA public key", () => {
  assert.match(PINNED_ID, /^[a-p]{32}$/);
  const key = crypto.createPublicKey({ key: Buffer.from(manifest.key, "base64"), format: "der", type: "spki" });
  assert.equal(key.asymmetricKeyType, "rsa", "manifest.key must be a base64 DER (SPKI) RSA public key");
});

test("build.py derives the id the way Chrome does and passes it to the installers and the host manifest", () => {
  const build = read("build.py");
  const how = "build.py's way of deriving the id changed: it must stay identical to Chrome's. If this is deliberate, update this test with it.";
  assert.ok(build.includes("hashlib.sha256(base64.b64decode(key_b64)).hexdigest()[:32]"), how);
  assert.ok(build.includes('chr(ord("a") + int(c, 16))'), how);
  assert.ok(build.includes('"EXT_ID": extension_id(read_manifest_key())'), "the installers must get the id derived from manifest.key");
  assert.ok(build.includes('"allowed_origins": [f"chrome-extension://{ext_id}/"]'), "build.py's host manifest must allow exactly chrome-extension://<id>/");
});

test("the installer templates take the id from the build; nothing is hard-coded in them", () => {
  for (const template of ["installers/templates/install-windows.cmd.tpl", "installers/templates/install-mac.command.tpl"]) {
    const text = read(template);
    assert.ok(text.includes("@@EXT_ID@@"), `${template} must receive the id through @@EXT_ID@@`);
    assert.ok(!text.includes(PINNED_ID), `${template} must not hard-code the id`);
  }
});

test("the committed installers hand the pinned id to the host installer", () => {
  const hint = "extension/installers is generated: run `python3 build.py` after any change to the manifest key.";
  assert.ok(read("extension/installers/install-windows.cmd").includes(`--ext-id '${PINNED_ID}'`), `install-windows.cmd: ${hint}`);
  assert.ok(read("extension/installers/install-mac.sh").includes(`--ext-id "${PINNED_ID}"`), `install-mac.sh: ${hint}`);
});

test("the host writes and checks allowed_origins as chrome-extension://<id>/ (trailing slash included)", () => {
  const installer = read("host/installer.py");
  assert.ok(installer.includes('"allowed_origins": [f"chrome-extension://{ext_id}/"]'),
    "host/installer.py register() must write allowed_origins with exactly chrome-extension://<id>/");
  assert.ok(installer.includes('parser.add_argument("--ext-id", required=True)'), "the installer takes the id from --ext-id");
  const doctor = read("host/doctor.py");
  assert.ok(doctor.includes('f"chrome-extension://{ext_id}/" not in origins'),
    "host/doctor.py _check_native() must compare against exactly chrome-extension://<id>/");
});

// Any other copy of an extension id written into a source, a document or a page must be the pinned one.
const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", "tests", ".pytest_cache", ".superpowers"]);
const TEXT = /\.(md|py|js|mjs|html|json|tpl|cmd|sh|txt|css)$/;
const FOUND = [/chrome-extension:\/\/([a-p]{32})(?![a-p])/g, /--ext-id\s+['"]([a-p]{32})['"]/g];

function* sources(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* sources(path.join(dir, entry.name));
    } else if (TEXT.test(entry.name)) {
      yield path.join(dir, entry.name);
    }
  }
}

test("no source, document or page embeds a different extension id", () => {
  const strays = [];
  for (const file of sources(root)) {
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of FOUND) {
      for (const match of text.matchAll(pattern)) {
        if (match[1] !== PINNED_ID) strays.push(`${path.relative(root, file)}: ${match[1]}`);
      }
    }
  }
  assert.deepEqual(strays, [], `these places carry an extension id that is not ${PINNED_ID}:\n${strays.join("\n")}`);
});
