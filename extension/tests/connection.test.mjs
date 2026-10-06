import test from "node:test";
import assert from "node:assert/strict";
import { createAutoConnect, extensionNotice, hostNotice } from "../lib/connection.js";

const stopped = { state: "stopped", ready: null, detail: "Native host has exited." };

test("auto connect keeps trying to launch the host a few times, then gives up with a note", () => {
  const auto = createAutoConnect({ maxTries: 3 });
  const outcomes = [1, 2, 3, 4, 5].map(() => auto.next(true, stopped));
  assert.deepEqual(outcomes.map((o) => o.send), [true, true, true, false, false]);
  assert.deepEqual(outcomes.map((o) => o.gaveUp), [false, false, false, true, true]);
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
  auto.next(true, stopped); auto.next(true, stopped);
  assert.equal(auto.next(true, stopped).gaveUp, true);
  auto.reset();
  assert.deepEqual(auto.next(true, stopped), { send: true, gaveUp: false });
  auto.next(true, stopped);
  auto.next(true, { state: "running", ready: {}, detail: null }); // connected: the count starts over
  assert.deepEqual(auto.next(true, stopped), { send: true, gaveUp: false });
  assert.deepEqual(auto.next(true, stopped), { send: true, gaveUp: false });
  assert.equal(auto.next(true, stopped).gaveUp, true);
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
