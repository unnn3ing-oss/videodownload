import test from "node:test";
import assert from "node:assert/strict";
import { autoCheckDue, changedParts, createCheckRunner, failedSummary, partsText, recordCheck, recordFailure, summarizeCheck } from "../lib/update-state.js";

const HOUR = 3_600_000;
const good = { checkedAt: 1000, sha: "a".repeat(40), date: "d", message: "m", hasUpdate: true, extChangedCount: 2 };

test("a failed check keeps the last good result and does not count as a check", () => {
  assert.deepEqual(failedSummary(good, "斷線", 5000), { ...good, error: "斷線", errorAt: 5000 });
  assert.deepEqual(failedSummary(null, "斷線", 5000), { error: "斷線", errorAt: 5000 });
});

test("autoCheckDue: first run, stale result, pending update, and retry after an error", () => {
  const now = 100 * HOUR;
  assert.equal(autoCheckDue(null, now), true);
  assert.equal(autoCheckDue({ ...good, checkedAt: now - HOUR, hasUpdate: false }, now), false);
  assert.equal(autoCheckDue({ ...good, checkedAt: now - 7 * HOUR, hasUpdate: false }, now), true);
  assert.equal(autoCheckDue({ ...good, checkedAt: now - HOUR }, now), true, "a pending update needs its details again");
  const failed = failedSummary({ ...good, checkedAt: now - HOUR }, "斷線", now - 60_000);
  assert.equal(autoCheckDue(failed, now), false, "one minute after an error: wait");
  assert.equal(autoCheckDue(failed, now + 5 * 60_000), true, "five minutes after an error: retry");
});

// ---- the periodic check and the manual check share one summary: which parts differ, and what an unreachable host could not say ----
const file = (path) => ({ path, sha: "s", size: 1 });
const found = (over = {}) => ({ sha: "b".repeat(40), date: "d", message: "m", extChanged: [], hostChanged: [], hostChecked: true, hasUpdate: false, ...over });

test("the summary says which parts differ: the extension's files, the local program's files, or both", () => {
  const ext = summarizeCheck(found({ extChanged: [file("background.js")], hasUpdate: true }), 1);
  assert.deepEqual([ext.parts, ext.hasUpdate, ext.extChangedCount, ext.hostChangedCount], ["extension", true, 1, 0]);
  const host = summarizeCheck(found({ hostChanged: [file("host.py"), file("version.py")], hasUpdate: true }), 1);
  assert.deepEqual([host.parts, host.hasUpdate, host.extChangedCount, host.hostChangedCount], ["host", true, 0, 2]);
  const both = summarizeCheck(found({ extChanged: [file("a.js")], hostChanged: [file("host.py")], hasUpdate: true }), 1);
  assert.deepEqual([both.parts, both.hasUpdate], ["both", true]);
  const none = summarizeCheck(found(), 1);
  assert.deepEqual([none.parts, none.hasUpdate], [null, false]);
});

test("a change that only concerns the local program counts as an update even when the check result says otherwise", () => {
  // (checkLatest alone only looks at the extension's files; the host's are added by the caller)
  assert.equal(summarizeCheck(found({ hostChanged: [file("host.py")], hasUpdate: false }), 1).hasUpdate, true);
});

test("a check that could not ask the local program keeps what the last check knew about its files", () => {
  const before = summarizeCheck(found({ hostChanged: [file("host.py")], hasUpdate: true }), 1);
  const unreachable = summarizeCheck(found({ hostChecked: false }), 2, before);
  assert.deepEqual([unreachable.parts, unreachable.hasUpdate, unreachable.hostChangedCount, unreachable.hostChecked], ["host", true, 1, false]);
  assert.equal(unreachable.checkedAt, 2, "the extension's own files were still compared now");
  assert.equal(summarizeCheck(found({ hostChecked: false }), 2, null).hasUpdate, false, "nothing known, nothing to keep");
  assert.equal(summarizeCheck(found({ hostChecked: false }), 2, summarizeCheck(found(), 1)).hasUpdate, false, "a clean host stays clean");
});

test("only a local program that was really asked can clear its difference", () => {
  const before = summarizeCheck(found({ hostChanged: [file("host.py")], hasUpdate: true }), 1);
  const asked = summarizeCheck(found({ hostChecked: true, hostChanged: [] }), 2, before);
  assert.deepEqual([asked.parts, asked.hasUpdate, asked.hostChangedCount], [null, false, 0]);
});

test("the extension's own files are always compared fresh: an update that was applied is not carried over", () => {
  const before = summarizeCheck(found({ extChanged: [file("a.js")], hasUpdate: true }), 1);
  assert.equal(summarizeCheck(found({ hostChecked: false }), 2, before).hasUpdate, false);
});

test("partsText names the parts in the words the person sees", () => {
  assert.equal(partsText({ extChangedCount: 2, hostChangedCount: 0 }), "擴充功能有新版本");
  assert.equal(partsText({ extChangedCount: 0, hostChangedCount: 1 }), "下載助手有新版本");
  assert.equal(partsText({ extChangedCount: 1, hostChangedCount: 1 }), "擴充功能和下載助手都有新版本");
  assert.equal(partsText({ extChangedCount: 0, hostChangedCount: 0 }), "");
  assert.equal(changedParts({ extChangedCount: 3 }), "extension", "a summary stored by an older version has no host count");
  assert.equal(partsText(null), "");
});

function memory() {
  let stored = null;
  const badge = [];
  return { badge, stored: () => stored, deps: { load: async () => stored, save: async (summary) => { stored = summary; }, badge: async (on) => { badge.push(on); } } };
}

test("the badge follows the stored summary: a later check never clears an update that was found, only a clean one does", async () => {
  const m = memory();
  await recordCheck(found({ hostChanged: [file("host.py")], hasUpdate: true }), { ...m.deps, now: 1 });
  assert.deepEqual(m.badge, [true], "an update that only concerns the local program shows the badge");
  await recordCheck(found({ hostChecked: false }), { ...m.deps, now: 2 });
  assert.deepEqual(m.badge, [true, true], "the next check could not reach the local program: the badge stays");
  assert.equal(m.stored().parts, "host");
  await recordFailure("連不上 GitHub", { ...m.deps, now: 3 });
  assert.deepEqual(m.badge, [true, true], "a failed check does not touch the badge");
  assert.deepEqual([m.stored().hasUpdate, m.stored().parts, m.stored().error, m.stored().errorAt], [true, "host", "連不上 GitHub", 3]);
  await recordCheck(found({ hostChecked: false }), { ...m.deps, now: 4 });
  assert.deepEqual([m.badge.at(-1), m.stored().error], [true, undefined], "a good check replaces the failed one, the difference is still known");
  await recordCheck(found(), { ...m.deps, now: 5 });
  assert.deepEqual(m.badge, [true, true, true, false], "the local program was asked and matches: the badge goes");
});

test("recording survives a store that refuses", async () => {
  const deps = { load: async () => { throw new Error("no storage"); }, save: async () => { throw new Error("no storage"); }, badge: async () => { throw new Error("no badge"); } };
  assert.equal((await recordCheck(found({ extChanged: [file("a.js")], hasUpdate: true }), { ...deps, now: 1 })).hasUpdate, true);
  assert.equal((await recordFailure("x", { ...deps, now: 1 })).error, "x");
});

test("checks that are asked for while one runs are folded into one more run, so the local program's files are not missed", async () => {
  const gates = [];
  let runs = 0;
  const runner = createCheckRunner(() => new Promise((resolve) => { runs += 1; gates.push(resolve); }));
  const first = runner.trigger();
  runner.trigger(); // (the local program connected a moment after the check started: that check could not ask it)
  runner.trigger();
  assert.equal(runs, 1, "never two at once");
  gates[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 2, "exactly one more run, however many asked");
  gates[1]();
  await first;
  assert.equal(runs, 2);
  const again = runner.trigger();
  assert.equal(runs, 3, "idle again: runs at once");
  gates[2]();
  await again;
});

test("a check that throws does not stop later checks", async () => {
  let runs = 0;
  const runner = createCheckRunner(async () => { runs += 1; if (runs === 1) throw new Error("boom"); });
  await runner.trigger().catch(() => {});
  await runner.trigger();
  assert.equal(runs, 2);
});
