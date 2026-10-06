import test from "node:test";
import assert from "node:assert/strict";
import { needsAttention, summarizeChecks } from "../lib/doctor-view.js";

const check = (id, status) => ({ id, status, title: id, detail: "", fix: "" });

test("a report with nothing wrong says so", () => {
  const summary = summarizeChecks([check("a", "ok"), check("b", "ok")]);
  assert.deepEqual([summary.errors, summary.warns, summary.text], [0, 0, "全部正常"]);
  assert.equal(needsAttention([check("a", "ok")]), false);
});

test("problems are counted, and an error points at the installer as the fix that always works", () => {
  const summary = summarizeChecks([check("a", "error"), check("b", "warn"), check("c", "error"), check("d", "ok")]);
  assert.deepEqual([summary.errors, summary.warns], [2, 1]);
  assert.match(summary.text, /2 項需要處理/);
  assert.match(summary.text, /1 項提醒/);
  assert.match(summary.text, /重新執行安裝檔/);
  assert.equal(needsAttention([check("a", "ok"), check("b", "error")]), true);
});

test("warnings alone are only reminders, and an empty or broken report is handled", () => {
  const summary = summarizeChecks([check("a", "warn")]);
  assert.equal(summary.errors, 0);
  assert.match(summary.text, /1 項提醒/);
  assert.doesNotMatch(summary.text, /需要處理/);
  assert.equal(needsAttention([check("a", "warn")]), true, "the repair button is offered for reminders too");
  assert.deepEqual(summarizeChecks([]).text, "沒有檢查結果");
  assert.deepEqual(summarizeChecks(undefined).text, "沒有檢查結果");
  assert.equal(needsAttention(undefined), false);
});
