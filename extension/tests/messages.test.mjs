import test from "node:test";
import assert from "node:assert/strict";
import { PANEL_ALLOWED, WEB_ALLOWED, classifySender, isAllowed, isExtensionPush } from "../lib/messages.js";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const PAGES = "https://unnn3ing-oss.github.io/videodownload/";

test("classifySender recognises the side panel, the web page and nothing else", () => {
  assert.equal(classifySender({ id: ID, url: `chrome-extension://${ID}/sidepanel.html` }, ID), "panel");
  assert.equal(classifySender({ id: ID, url: `chrome-extension://${ID}/sidepanel.html`, tab: { id: 3 } }, ID), "panel");
  assert.equal(classifySender({ id: ID, url: PAGES, tab: { id: 4 } }, ID), "web");
  assert.equal(classifySender({ id: ID, url: `${PAGES}index.html?x=1`, tab: { id: 4 } }, ID), "web");
  assert.equal(classifySender({ id: ID, url: "https://unnn3ing-oss.github.io/videodownload-evil/", tab: { id: 4 } }, ID), null);
  assert.equal(classifySender({ id: ID, url: "https://unnn3ing-oss.github.io/other/", tab: { id: 4 } }, ID), null);
  assert.equal(classifySender({ id: ID, url: "https://evil.example/videodownload/", tab: { id: 4 } }, ID), null);
  assert.equal(classifySender({ id: ID, url: PAGES }, ID), null, "a web url without a tab is not a content script");
  assert.equal(classifySender({ id: "otherextensionidotherextensionid", url: `chrome-extension://${ID}/x.html` }, ID), null);
  assert.equal(classifySender({ id: ID }, ID), null);
  assert.equal(classifySender(undefined, ID), null);
});

test("the web page may use the queue but never the update or engine commands", () => {
  for (const type of ["update_check", "update_stage", "update_commit", "update_rollback", "update_engine",
    "download", "resolve", "cancel", "enqueue", "save_cover", "meta", "mystery"]) {
    assert.equal(isAllowed("web", type), false, type);
  }
  for (const type of ["ping", "queue_get", "queue_add", "queue_start", "settings_set", "start", "deploy_installer", "doctor", "diagnostics"]) {
    assert.equal(isAllowed("web", type), true, type);
  }
});

test("only strings are valid message types and unknown senders get nothing", () => {
  for (const type of [undefined, null, 5, {}, ["queue_get"], "__proto__", "constructor", "hasOwnProperty"]) {
    assert.equal(isAllowed("web", type), false);
    assert.equal(isAllowed("panel", type), false);
  }
  assert.equal(isAllowed(null, "queue_get"), false);
  assert.equal(isAllowed("other", "queue_get"), false);
});

test("the side panel may also run updates", () => {
  for (const type of ["update_check", "update_stage", "update_commit", "update_rollback", "update_engine", "queue_add"]) {
    assert.equal(isAllowed("panel", type), true, type);
  }
});

test("the allowlists are exactly the documented sets", () => {
  assert.deepEqual([...WEB_ALLOWED].sort(), [
    "deploy_installer", "diagnostics", "doctor", "get_status", "ping", "queue_add", "queue_copy_text", "queue_download_cover", "queue_get",
    "queue_remove", "queue_retry", "queue_start", "queue_stop", "set_output_dir", "settings_set", "start", "update_apply", "update_info",
  ]);
  assert.deepEqual([...PANEL_ALLOWED].sort(), [
    "deploy_installer", "diagnostics", "doctor", "get_status", "queue_add", "queue_copy_text", "queue_download_cover",
    "queue_get", "queue_remove", "queue_retry", "queue_start", "queue_stop", "set_output_dir",
    "settings_set", "start", "update_apply", "update_check", "update_commit", "update_engine", "update_info", "update_rollback", "update_stage",
  ]);
});

test("the side panel acts only on what the extension itself pushes, never on a message that came from a tab", () => {
  // the background script's broadcasts (it has no tab); some Chrome versions leave its url out
  assert.equal(isExtensionPush({ id: ID, url: `chrome-extension://${ID}/background.js` }, ID), true);
  assert.equal(isExtensionPush({ id: ID }, ID), true);
  // a content script relays whatever the page asks for through chrome.runtime.sendMessage, and the panel hears it too
  assert.equal(isExtensionPush({ id: ID, url: PAGES, tab: { id: 4 } }, ID), false, "the web page's content script");
  assert.equal(isExtensionPush({ id: ID, url: "https://evil.example/", tab: { id: 4 } }, ID), false);
  assert.equal(isExtensionPush({ id: ID, url: "https://evil.example/" }, ID), false, "an http(s) url is never the extension");
  assert.equal(isExtensionPush({ id: ID, url: PAGES }, ID), false);
  assert.equal(isExtensionPush({ id: ID, url: `chrome-extension://${ID}/sidepanel.html`, tab: { id: 4 } }, ID), false, "even an extension page opened in a tab");
  assert.equal(isExtensionPush({ id: "otherextensionidotherextensionid", url: `chrome-extension://${ID}/background.js` }, ID), false);
  assert.equal(isExtensionPush({ url: `chrome-extension://${ID}/background.js` }, ID), false);
  assert.equal(isExtensionPush(undefined, ID), false);
});
