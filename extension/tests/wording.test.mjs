import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const list = (dir, ext) => readdirSync(join(root, dir)).filter((f) => ext.test(f)).map((f) => join(dir, f));

// One name for each thing a person sees: 擴充功能 (not 插件), 下載助手 (not 本機小程式 or 小程式).
const SOURCES = ["index.html", "build.py", ...list("extension", /\.(html|js)$/), ...list("extension/lib", /\.js$/), ...list("web", /\.js$/),
                 ...list("host", /\.py$/), ...list("installers/templates", /\.tpl$/)];

test("the screens and messages use one word for the extension and one for the local program", () => {
  for (const file of SOURCES) {
    const text = readFileSync(join(root, file), "utf8");
    assert.ok(!/插件/.test(text), `${file}: 擴充功能, not 插件`);
    assert.ok(!/小程式/.test(text), `${file}: 下載助手, not 小程式`);
  }
});
