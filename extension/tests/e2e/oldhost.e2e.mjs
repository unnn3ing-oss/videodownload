// A host from before the batch queue is connected: both screens say it must be updated, "start" is off, and
// "copy text" explains instead of showing the host's unknown-message error.
// Exit codes: 0 = OK, 1 = assertion failed, 2 = UNVERIFIED (browser/extension could not be launched).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PAGES_URL, launchExtension, registerNativeHost, root, servePages } from "./helpers.mjs";

const { context, extId, work, userData } = await launchExtension({ viewport: { width: 1200, height: 900 } });
try {
  const wrapper = path.join(work, "host.sh");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec python3 "${path.join(root, "extension/tests/e2e/old_host.py")}"\n`);
  fs.chmodSync(wrapper, 0o755);
  registerNativeHost({ userData, wrapperPath: wrapper, extId });
  await servePages(context);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await panel.waitForFunction(() => document.getElementById("status").dataset.state === "running");
  const web = await context.newPage();
  await web.goto(PAGES_URL);
  await web.waitForFunction(() => document.getElementById("outdir").value !== "", null, { timeout: 20000 });
  // The install does not count as working (the host is too old), so the first visit's window stays up: its self-check says why.
  await web.waitForSelector("#setup-dialog[open]");
  await web.click("#tab-check");
  await web.waitForSelector("#check-list li");
  const verdict = await web.$$eval("#check-list li", (items) => items.map((li) => ({ status: li.dataset.status, text: li.textContent })));
  assert.ok(verdict.some((r) => r.status === "error" && /版本太舊/.test(r.text)), "the self-check names the old host");
  await web.click("#setup-close");

  await panel.fill("#add-url", "https://www.youtube.com/watch?v=v1");
  await panel.click("#add-btn");
  for (const view of [panel, web]) await view.waitForSelector('.qrow[data-kind="waiting"]');

  for (const view of [panel, web]) {
    await view.evaluate(() => {
      window.__noteRewrites = 0;
      new MutationObserver((records) => { window.__noteRewrites += records.length; })
        .observe(document.getElementById("host-note"), { childList: true, characterData: true, subtree: true });
    });
  }
  for (const [name, view] of [["panel", panel], ["web", web]]) {
    await view.waitForSelector("#host-note:not([hidden])");
    assert.match(await view.textContent("#host-note"), /本機小程式.*太舊.*重新執行安裝檔/, `${name}: says the host is too old and to run the installer again`);
    assert.equal(await view.isDisabled("#start-all"), true, `${name}: start is off`);
    await view.locator(".qcopy").first().click();
    await view.waitForFunction(() => /請先更新本機小程式/.test(document.querySelector(".qflash")?.textContent ?? ""));
  }
  // Screen readers announce a live region again whenever its text is rewritten: more rows (more pushes) must not do that.
  await panel.fill("#add-url", "https://www.youtube.com/watch?v=v2");
  await panel.click("#add-btn");
  for (const view of [panel, web]) await view.waitForFunction(() => document.querySelectorAll(".qrow").length === 2);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  for (const [name, view] of [["panel", panel], ["web", web]]) {
    assert.equal(await view.evaluate(() => window.__noteRewrites), 0, `${name}: the note (already shown) was not rewritten`);
  }
  console.log("OK");
} catch (error) {
  console.log(`FAIL: ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await context.close();
}
