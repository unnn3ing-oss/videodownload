import test from "node:test";
import assert from "node:assert/strict";
import { createAutoConnect, extensionNotice, hostNotice, versionNotice } from "../lib/connection.js";

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
  assert.match(text, /更新到最新版/);
  assert.match(text, /重新載入/);
});
