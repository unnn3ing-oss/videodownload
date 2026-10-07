import test from "node:test";
import assert from "node:assert/strict";
import { RELOAD_WAIT_MS, UPDATING_TEXT, createReloadWait, describeOutcome } from "../lib/update-wait.js";

// A clock that only moves when the waiting code sleeps, and a page whose state is a function of that time.
function setup(stateAt, over = {}) {
  const clock = { t: 1_000_000 };
  const start = clock.t;
  let wait;
  const seenRunning = [];
  const probe = () => {
    seenRunning.push(wait.running());
    return stateAt(clock.t - start);
  };
  wait = createReloadWait({ probe, now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, ...over });
  return { wait, clock, start, seenRunning };
}
const gone = { detected: false, running: false, notRunningAt: 0, version: null };
const backAt = (ms, start, version, restartedAt = ms - 1000) => (t) => (t < ms ? gone : { detected: true, running: true, notRunningAt: start + restartedAt, version });

test("the extension comes back in time: the wait ends then, with the new version", async () => {
  const s = setup((t) => backAt(12000, 1_000_000, "2.0.0")(t));
  const outcome = await s.wait.start({ expected: "2.0.0", before: "1.0.0" });
  assert.deepEqual(outcome, { back: true, restarted: true, version: "2.0.0", expected: "2.0.0" });
  assert.ok(s.clock.t - s.start >= 12000 && s.clock.t - s.start < 13000, "it did not wait longer than needed");
  assert.equal(s.seenRunning.every(Boolean), true, "it counts as updating for the whole wait");
  assert.equal(s.wait.running(), false, "and not afterwards");
  assert.deepEqual(describeOutcome(outcome), { kind: "ok", text: "已更新到 v2.0.0。" });
});

test("an extension that never comes back: the wait has a hard end, then the normal messages return with an explanation", async () => {
  const s = setup(() => gone);
  const outcome = await s.wait.start({ expected: "2.0.0", before: "1.0.0" });
  assert.equal(outcome.back, false);
  const waited = s.clock.t - s.start;
  assert.ok(waited >= RELOAD_WAIT_MS && waited <= RELOAD_WAIT_MS + 1000, `waited ${waited} ms`);
  assert.equal(RELOAD_WAIT_MS, 90000);
  assert.equal(s.wait.running(), false);
  const note = describeOutcome(outcome);
  assert.equal(note.kind, "error");
  assert.match(note.text, /更新後一直連不上/);
  assert.match(note.text, /chrome:\/\/extensions/);
  assert.match(note.text, /重新執行安裝檔/);
});

test("it comes back, but with another version than the update has: it says which one is loaded", async () => {
  const s = setup(backAt(10000, 1_000_000, "1.0.0"));
  const outcome = await s.wait.start({ expected: "2.0.0", before: "1.0.0" });
  assert.equal(outcome.back, true);
  const note = describeOutcome(outcome);
  assert.equal(note.kind, "error");
  assert.match(note.text, /版本仍是 v1\.0\.0（預期 v2\.0\.0）/);
});

test("a second click while it waits starts nothing new", async () => {
  const probesOf = async (clicks) => {
    let probes = 0;
    const s = setup((t) => { probes += 1; return backAt(5000, 1_000_000, "2.0.0")(t); });
    const first = s.wait.start({ expected: "2.0.0", before: "1.0.0" });
    const extra = Array.from({ length: clicks }, () => s.wait.start({ expected: "2.0.0", before: "1.0.0" }));
    assert.deepEqual(extra, Array(clicks).fill(null), "refused while one runs");
    assert.equal((await first).back, true);
    const later = await s.wait.start({ expected: "2.0.0", before: "1.0.0" });
    assert.equal(later.back, true, "once it ended, a new wait is possible");
    return probes;
  };
  assert.equal(await probesOf(3), await probesOf(0), "no second loop was polling");
});

test("an update that restarted nothing is reported after a short look instead of waiting for the hard end", async () => {
  const s = setup(() => ({ detected: true, running: true, notRunningAt: 0, version: "1.0.0" }));
  const outcome = await s.wait.start({ expected: null, before: "1.0.0" });
  assert.deepEqual([outcome.back, outcome.restarted], [true, false]);
  assert.ok(s.clock.t - s.start < 10000);
  assert.deepEqual(describeOutcome(outcome), { kind: "ok", text: "已更新。" });
});

test("the new version showing up counts as back at once, even before the local program is seen restarting", async () => {
  const s = setup((t) => (t < 3000 ? gone : { detected: true, running: true, notRunningAt: 0, version: "2.0.0" }));
  const outcome = await s.wait.start({ expected: "2.0.0", before: "1.0.0" });
  assert.deepEqual([outcome.back, outcome.restarted], [true, true]);
  assert.ok(s.clock.t - s.start < 4000);
});

test("the sentence shown while it waits", () => {
  assert.equal(UPDATING_TEXT, "更新中，擴充功能正在重新載入，請稍候…");
});
