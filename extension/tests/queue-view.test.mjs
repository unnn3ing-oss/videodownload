import test from "node:test";
import assert from "node:assert/strict";
import { REINSTALL_ACTION } from "../lib/connection.js";
import { HOST_OUTDATED_TEXT, clearConfirmText, coverResultText, clearList, renderAbortNote, renderClearButton, renderHostNote, renderVersionNote } from "../lib/queue-view.js";

// just enough of an element for the note helpers: text and the hidden flag
const note = () => ({ textContent: "", hidden: true });

test("the old-host note names an action that always exists, never a button called 「更新」", () => {
  assert.ok(HOST_OUTDATED_TEXT.includes(REINSTALL_ACTION));
  assert.doesNotMatch(HOST_OUTDATED_TEXT, /按「更新」/);
  assert.doesNotMatch(HOST_OUTDATED_TEXT, /側邊面板/, "the web page has no side panel to point at");
});

test("renderHostNote shows the old-host note only while the host is outdated, with the update button as an extra when there is one", () => {
  const node = note();
  renderHostNote(node, { hostOutdated: false });
  assert.deepEqual([node.textContent, node.hidden], ["", true]);
  renderHostNote(node, { hostOutdated: true });
  assert.deepEqual([node.textContent, node.hidden], [HOST_OUTDATED_TEXT, false]);
  renderHostNote(node, { hostOutdated: true }, { updateAvailable: true });
  assert.ok(node.textContent.startsWith(HOST_OUTDATED_TEXT.replace(/，完成後會自動重新連線。$/, "")));
  assert.match(node.textContent, /「版本與更新」.*「更新到最新版」/);
  renderHostNote(node, null);
  assert.deepEqual([node.textContent, node.hidden], ["", true]);
});

test("renderVersionNote puts the version mismatch where it can be seen, and takes it away when the versions agree", () => {
  const node = note();
  renderVersionNote(node, { extensionVersion: "0.2.7", hostVersion: "0.2.0", updateAvailable: false });
  assert.equal(node.hidden, false);
  assert.match(node.textContent, /本機小程式是 v0\.2\.0，擴充功能是 v0\.2\.7/);
  assert.ok(node.textContent.includes(REINSTALL_ACTION));
  renderVersionNote(node, { extensionVersion: "0.2.7", hostVersion: "0.2.0", updateAvailable: true });
  assert.match(node.textContent, /「更新到最新版」/);
  renderVersionNote(node, { extensionVersion: "0.2.7", hostVersion: "0.2.7", updateAvailable: false });
  assert.deepEqual([node.textContent, node.hidden], ["", true]);
  renderVersionNote(node, { extensionVersion: "0.2.7", hostVersion: null, updateAvailable: false });
  assert.deepEqual([node.textContent, node.hidden], ["", true], "the host's version is not known yet");
});

test("a note that did not change is not rewritten (it is a live region: rewriting repeats the announcement)", () => {
  let writes = 0;
  const node = { hidden: true, _text: "", get textContent() { return this._text; }, set textContent(value) { writes += 1; this._text = value; } };
  renderVersionNote(node, { extensionVersion: "0.2.7", hostVersion: "0.2.0" });
  renderVersionNote(node, { extensionVersion: "0.2.7", hostVersion: "0.2.0" });
  assert.equal(writes, 1);
});

test("renderVersionNote stays quiet while the old-host note already covers it", () => {
  const node = note();
  renderVersionNote(node, { extensionVersion: "0.2.7", hostVersion: "0.1.0", hostOutdated: true });
  assert.deepEqual([node.textContent, node.hidden], ["", true]);
  renderVersionNote(node, { extensionVersion: "0.2.7", hostVersion: "0.1.0", hostOutdated: false });
  assert.equal(node.hidden, false);
});

const waitingRow = (uid, extra = {}) => ({ uid, id: `v${uid}`, status: "waiting", dupOf: null, ...extra });

test("renderAbortNote shows the host's reason and how many videos are still waiting", () => {
  const node = note();
  const aborted = { code: "too_many_failures", message: "連續 3 支影片失敗，已停止下載" };
  renderAbortNote(node, { aborted, items: [{ uid: 1, id: "a", status: "failed", dupOf: null }, waitingRow(2), waitingRow(3), waitingRow(4, { dupOf: 2 })] });
  assert.equal(node.hidden, false);
  assert.equal(node.textContent, "連續 3 支影片失敗，已停止下載。還有 2 支沒下載，仍在清單裡；處理好後再按「開始全部下載」。");
});

test("renderAbortNote has nothing to add about the rows when none are waiting, and hides when the job was not stopped", () => {
  const node = note();
  renderAbortNote(node, { aborted: { code: "disk_full", message: "磁碟已滿。" }, items: [] });
  assert.equal(node.textContent, "磁碟已滿。");
  renderAbortNote(node, { aborted: null, items: [waitingRow(1)] });
  assert.deepEqual([node.textContent, node.hidden], ["", true]);
  renderAbortNote(node, null);
  assert.deepEqual([node.textContent, node.hidden], ["", true]);
});

test("renderAbortNote does not repeat a sentence stop that the host already put at the end", () => {
  const node = note();
  renderAbortNote(node, { aborted: { code: "x", message: "已停止下載！" }, items: [waitingRow(1)] });
  assert.equal(node.textContent, "已停止下載！還有 1 支沒下載，仍在清單裡；處理好後再按「開始全部下載」。");
});

test("coverResultText says where the cover went, and why when it is not next to the video", () => {
  assert.equal(coverResultText({ ok: true, where: "folder" }), "已存到影片資料夾");
  assert.match(coverResultText({ ok: true, where: "downloads" }), /已存到下載資料夾（連線小程式後可存到影片資料夾）/);
  const moved = coverResultText({ ok: true, where: "downloads", folderChanged: true });
  assert.match(moved, /下載資料夾/);
  assert.match(moved, /存放資料夾後來改過/);
  assert.doesNotMatch(moved, /連線小程式/, "the program is connected: that is not why");
});

const row = (status, extra = {}) => ({ uid: 1, status, dupOf: null, ...extra });

test("the clear button shows only when everything is finished, and says so", () => {
  const button = { hidden: true, disabled: true, textContent: "" };
  renderClearButton(button, { items: [row("waiting")], running: false });
  assert.equal(button.hidden, true, "a waiting video keeps the list");
  renderClearButton(button, { items: [row("done"), row("skipped")], running: false });
  assert.deepEqual([button.hidden, button.disabled, button.textContent], [false, false, "清除全部"]);
  renderClearButton(button, { items: [row("done")], running: true });
  assert.equal(button.hidden, true, "never while a job runs");
  renderClearButton(button, { items: [], running: false });
  assert.equal(button.hidden, true, "nothing to clear");
  renderClearButton(button, null);
  assert.equal(button.hidden, true);
});

test("clearing asks first only when failed videos would lose their retry button", () => {
  assert.equal(clearConfirmText({ items: [row("done"), row("skipped")] }), null);
  assert.match(clearConfirmText({ items: [row("done"), row("failed"), row("failed", { uid: 3 })] }), /2 支失敗.*不能重試/);
});

test("clearList sends the request at once when nothing would be lost, and waits for a yes when failed videos would", async () => {
  const sent = [];
  const send = async (m) => { sent.push(m.type); return { ok: true }; };
  await clearList(send, { items: [row("done")] }, () => { throw new Error("no question needed"); });
  assert.deepEqual(sent, ["queue_clear"]);
  const failed = { items: [row("done"), row("failed", { uid: 2 })] };
  const no = await clearList(send, failed, () => false);
  assert.equal(no.cancelled, true);
  assert.equal(sent.length, 1, "a no sends nothing");
  await clearList(send, failed, () => true);
  assert.equal(sent.length, 2);
});
