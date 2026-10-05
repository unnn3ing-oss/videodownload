import test from "node:test";
import assert from "node:assert/strict";
import { autoCheckDue, failedSummary } from "../lib/update-state.js";

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
