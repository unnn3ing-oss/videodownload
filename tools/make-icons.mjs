#!/usr/bin/env node
// Draws extension/icons/icon-<size>.png from extension/icons/icon.svg, the one drawing that the web page's tab icon
// and the extension share. Chrome's manifest needs PNG files, so this is run whenever the drawing changes:
//   node tools/make-icons.mjs        (needs playwright-core and a Chromium: PW_CHROMIUM or /opt/pw-browsers/chromium)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extension", "icons");
const svg = fs.readFileSync(path.join(dir, "icon.svg"));
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
try {
  for (const size of [16, 32, 48, 128]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<body style="margin:0;background:transparent"><img width="${size}" height="${size}" src="data:image/svg+xml;base64,${svg.toString("base64")}"></body>`);
    await page.screenshot({ path: path.join(dir, `icon-${size}.png`), omitBackground: true });
    await page.close();
    console.log(`icon-${size}.png`);
  }
} finally {
  await browser.close();
}
