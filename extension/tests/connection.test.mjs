import test from "node:test";
import assert from "node:assert/strict";
import {
  PANEL_UPDATE_BUTTON, REINSTALL_ACTION, createAutoConnect, extensionNotice, hostNotice, hostVersionNotice, updateAdvice, versionNotice,
} from "../lib/connection.js";

const stopped = { state: "stopped", ready: null, detail: "Native host has exited." };
const closed = () => ({ ...stopped }); // every launch that ends makes the extension send a new report

test("auto connect keeps trying to launch the host a few times, then gives up with a note", () => {
  const auto = createAutoConnect({ maxTries: 3 });
  const outcomes = [1, 2, 3, 4, 5].map(() => auto.next(true, closed()));
  assert.deepEqual(outcomes.map((o) => o.send), [true, true, true, false, false]);
  assert.deepEqual(outcomes.map((o) => o.gaveUp), [false, false, false, true, true]);
});

test("a host that is slow to start (no new report yet) is not counted as closing", () => {
  const auto = createAutoConnect({ maxTries: 2 });
  const same = closed();
  for (let i = 0; i < 20; i += 1) assert.equal(auto.next(true, same).gaveUp, false);
  assert.deepEqual(auto.next(true, closed()), { send: true, gaveUp: false }, "its first failure: one more launch");
  assert.deepEqual(auto.next(true, closed()), { send: false, gaveUp: true }, "its second failure: that was the last launch");
});

test("a host that is simply not installed yet is waited for without limit", () => {
  const auto = createAutoConnect({ maxTries: 2 });
  auto.next(true, { state: "stopped", ready: null, detail: null }); // the very first try, before anything is known
  for (let i = 0; i < 20; i += 1) assert.deepEqual(auto.next(true, { state: "not_installed", ready: null, detail: "not found" }), { send: true, gaveUp: false });
});

test("nothing is sent while the extension is missing, the host runs, or Chrome forbids the connection", () => {
  const auto = createAutoConnect();
  assert.deepEqual(auto.next(false, stopped), { send: false, gaveUp: false });
  assert.deepEqual(auto.next(true, { state: "running", ready: {}, detail: null }), { send: false, gaveUp: false });
  assert.deepEqual(auto.next(true, { state: "forbidden", ready: null, detail: "Access to the specified native messaging host is forbidden." }), { send: false, gaveUp: false });
});

test("reset (the start button, the host running, the extension coming back) gives the tries back", () => {
  const auto = createAutoConnect({ maxTries: 2 });
  auto.next(true, closed()); auto.next(true, closed());
  assert.equal(auto.next(true, closed()).gaveUp, true);
  auto.reset();
  assert.deepEqual(auto.next(true, closed()), { send: true, gaveUp: false });
  auto.next(true, closed());
  auto.next(true, { state: "running", ready: {}, detail: null }); // connected: the count starts over
  assert.deepEqual(auto.next(true, closed()), { send: true, gaveUp: false });
  assert.deepEqual(auto.next(true, closed()), { send: true, gaveUp: false });
  assert.equal(auto.next(true, closed()).gaveUp, true);
});

test("extensionNotice tells apart 'not found yet' from 'connection lost'", () => {
  assert.equal(extensionNotice({ detected: true, everDetected: true }), null);
  assert.match(extensionNotice({ detected: false, everDetected: false }), /還沒偵測到擴充功能/);
  const lost = extensionNotice({ detected: false, everDetected: true });
  assert.match(lost, /連線中斷/);
  assert.match(lost, /重新整理/);
});

test("hostNotice explains a lost host, a refused connection and a host that will not start", () => {
  const running = { state: "running", ready: {}, detail: null };
  assert.equal(hostNotice({ detected: true, status: running, wasRunning: true, gaveUp: false }), null);
  assert.equal(hostNotice({ detected: false, status: stopped, wasRunning: true, gaveUp: false }), null, "the extension notice covers that");
  assert.equal(hostNotice({ detected: true, status: stopped, wasRunning: false, gaveUp: false }), null, "still starting up for the first time");
  const lost = hostNotice({ detected: true, status: stopped, wasRunning: true, gaveUp: false });
  assert.equal(lost.kind, "info");
  assert.match(lost.text, /連線中斷/);
  const gaveUp = hostNotice({ detected: true, status: stopped, wasRunning: false, gaveUp: true });
  assert.equal(gaveUp.kind, "error");
  assert.match(gaveUp.text, /啟動/);
  assert.match(hostNotice({ detected: true, status: { state: "forbidden", ready: null, detail: "x" }, wasRunning: false, gaveUp: false }).text, /拒絕/);
});

test("versionNotice warns only when the extension is older than this page, and says what to do", () => {
  assert.equal(versionNotice({ extensionVersion: "0.2.1", pageVersion: "0.2.1" }), null);
  assert.equal(versionNotice({ extensionVersion: "0.3.0", pageVersion: "0.2.1" }), null, "a newer extension is fine");
  assert.equal(versionNotice({ extensionVersion: "0.2.1", pageVersion: null }), null, "page version unknown");
  assert.equal(versionNotice({ extensionVersion: null, pageVersion: "0.2.1" }), null, "extension not there");
  assert.equal(versionNotice({ extensionVersion: "abc", pageVersion: "0.2.1" }), null, "not a version number");
  const text = versionNotice({ extensionVersion: "0.2.0", pageVersion: "0.2.1" });
  assert.match(text, /0\.2\.0/);
  assert.match(text, /0\.2\.1/);
  assert.ok(text.includes(REINSTALL_ACTION), "the action that always exists");
  assert.doesNotMatch(text, /更新到最新版/, "the update button is hidden until an update was found: not promised then");
  const withButton = versionNotice({ extensionVersion: "0.2.0", pageVersion: "0.2.1", updateAvailable: true });
  assert.ok(withButton.includes(REINSTALL_ACTION));
  assert.match(withButton, /版本與更新/);
  assert.match(withButton, /更新到最新版/);
  assert.match(withButton, /重新載入/);
});

test("the reinstall action says what to do on each system", () => {
  assert.equal(REINSTALL_ACTION, "重新執行安裝檔（Mac 貼上那一行指令，Windows 重新下載後雙擊）");
});

test("hostVersionNotice warns when the local program and the extension are not the same version, either way round", () => {
  assert.equal(hostVersionNotice({ extensionVersion: "0.2.9", hostVersion: "0.2.9" }), null);
  const older = hostVersionNotice({ extensionVersion: "0.2.7", hostVersion: "0.2.0" });
  assert.match(older, /下載助手是 v0\.2\.0/);
  assert.match(older, /擴充功能是 v0\.2\.7/);
  assert.match(hostVersionNotice({ extensionVersion: "0.2.7", hostVersion: "0.3.0" }), /不一致/);
});

test("hostVersionNotice names an action that always exists, and the update button only when it is there to press", () => {
  const plain = hostVersionNotice({ extensionVersion: "0.2.7", hostVersion: "0.2.0" });
  assert.ok(plain.includes(REINSTALL_ACTION));
  assert.doesNotMatch(plain, /更新到最新版/, "files already match: that button is hidden or disabled, so it is not mentioned");
  assert.equal(hostVersionNotice({ extensionVersion: "0.2.7", hostVersion: "0.2.0", updateAvailable: false }), plain);
  const extra = hostVersionNotice({ extensionVersion: "0.2.7", hostVersion: "0.2.0", updateAvailable: true });
  assert.ok(extra.includes(REINSTALL_ACTION), "the installer stays the first thing to do");
  assert.match(extra, /「版本與更新」/);
  assert.match(extra, /「更新到最新版」/);
  assert.ok(extra.indexOf("重新執行安裝檔") < extra.indexOf("更新到最新版"));
});

test("hostVersionNotice says nothing while either version is not known", () => {
  assert.equal(hostVersionNotice({ extensionVersion: null, hostVersion: "0.2.0" }), null);
  assert.equal(hostVersionNotice({ extensionVersion: "0.2.7", hostVersion: undefined }), null);
  assert.equal(hostVersionNotice({ extensionVersion: "abc", hostVersion: "0.2.0" }), null, "not a version number");
});

test("updateAdvice tells where the update can be applied, naming the panel's button as it is really labelled", () => {
  const found = { hasUpdate: true, canUpdateHere: true, hostChecked: true };
  assert.equal(updateAdvice(found, true), "有新版本可以更新。");
  assert.match(updateAdvice(found, false), /先讓下載助手連線/);
  const elsewhere = updateAdvice({ ...found, canUpdateHere: false }, true);
  assert.ok(elsewhere.includes(`「${PANEL_UPDATE_BUTTON.pickFolder}」`), "the button as it is labelled the first time (no folder chosen yet)");
  assert.ok(elsewhere.includes(REINSTALL_ACTION), "the action that always exists");
  assert.doesNotMatch(elsewhere, /插件/, "擴充功能, not 插件");
  const unknown = updateAdvice({ ...found, canUpdateHere: false, hostChecked: false }, false);
  assert.match(unknown, /下載助手還沒連線/);
  assert.match(unknown, /先讓它連線/);
  assert.doesNotMatch(unknown, /插件|本機小程式/, "the agreed words: 擴充功能 and 下載助手");
  assert.equal(PANEL_UPDATE_BUTTON.apply, "更新到最新版");
});

test("while an update reloads the extension, neither the lost extension nor the lost host is announced", () => {
  const stopped = { state: "stopped", ready: null, detail: null };
  assert.equal(extensionNotice({ detected: false, everDetected: true, updating: true }), null);
  assert.equal(extensionNotice({ detected: false, everDetected: false, updating: true }), null);
  assert.equal(hostNotice({ detected: true, status: stopped, wasRunning: true, gaveUp: false, updating: true }), null);
  assert.equal(hostNotice({ detected: true, status: stopped, wasRunning: false, gaveUp: true, updating: true }), null);
  assert.match(extensionNotice({ detected: false, everDetected: true, updating: false }), /連線中斷/, "and they return afterwards");
});
