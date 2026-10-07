import test from "node:test";
import assert from "node:assert/strict";
import { SETTING_RANGES } from "../lib/constants.js";
import { parseBoundedInt } from "../lib/format.js";
import { DEFAULT_SETTINGS, createState, setSettings } from "../lib/queue.js";
import { bindNumberSetting } from "../lib/queue-view.js";

const range = { min: 3, max: 60, fallback: 10 };

test("parseBoundedInt: an empty or invalid box keeps the fallback instead of falling to the minimum", () => {
  for (const raw of ["", " ", "   ", "abc", "12abc", "NaN", "Infinity", "-", ".", null, undefined, NaN, Infinity, true, {}]) {
    assert.equal(parseBoundedInt(raw, range), 10, JSON.stringify(raw));
  }
});

test("parseBoundedInt: numbers are rounded and held between min and max", () => {
  assert.equal(parseBoundedInt("25", range), 25);
  assert.equal(parseBoundedInt(" 25 ", range), 25);
  assert.equal(parseBoundedInt(25, range), 25);
  assert.equal(parseBoundedInt("10.6", range), 11, "decimals are rounded");
  assert.equal(parseBoundedInt("10.4", range), 10);
  assert.equal(parseBoundedInt("1e1", range), 10);
  assert.equal(parseBoundedInt("0", range), 3, "0 is a number, just too small");
  assert.equal(parseBoundedInt("-5", range), 3);
  assert.equal(parseBoundedInt("2", range), 3);
  assert.equal(parseBoundedInt("61", range), 60);
  assert.equal(parseBoundedInt("999999", range), 60);
  assert.equal(parseBoundedInt("3", range), 3);
  assert.equal(parseBoundedInt("60", range), 60);
});

test("setSettings treats an empty or blank number as 'no change', not as 0", () => {
  let state = setSettings(createState(), { cooldownSec: 25, limit: 200 });
  for (const blank of ["", " ", null, "abc"]) {
    state = setSettings(state, { cooldownSec: blank, limit: blank });
    assert.deepEqual([state.settings.cooldownSec, state.settings.limit], [25, 200], JSON.stringify(blank));
  }
  assert.deepEqual(setSettings(state, { cooldownSec: "0", limit: "0" }).settings, { ...state.settings, cooldownSec: 3, limit: 1 });
});

test("the ranges the settings are held to are the ones the page's boxes advertise", () => {
  assert.deepEqual(SETTING_RANGES.cooldownSec, { min: 3, max: 60 });
  assert.deepEqual(SETTING_RANGES.limit, { min: 1, max: 1000 });
  assert.ok(DEFAULT_SETTINGS.cooldownSec >= 3 && DEFAULT_SETTINGS.limit >= 1);
});

// A box that is just enough of an <input> for the binding: a value and a change listener.
function fakeInput(value) {
  const listeners = {};
  return {
    value,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    change(next) { this.value = next; listeners.change(); },
  };
}

test("clearing a number box puts the previous setting back and sends that, never the minimum", () => {
  const sent = [];
  const input = fakeInput("30");
  bindNumberSetting(input, "cooldownSec", { send: (m) => sent.push(m), current: () => 30 });
  input.change("");
  assert.equal(input.value, "30", "the box shows the value that is really in use");
  assert.deepEqual(sent, [{ type: "settings_set", settings: { cooldownSec: 30 } }]);
  input.change("abc");
  assert.equal(input.value, "30");
  input.change("45");
  assert.deepEqual(sent.at(-1), { type: "settings_set", settings: { cooldownSec: 45 } });
  assert.equal(input.value, "45");
  input.change("500");
  assert.equal(input.value, "60", "too big: shown and sent as the maximum");
  assert.deepEqual(sent.at(-1), { type: "settings_set", settings: { cooldownSec: 60 } });
});

test("a number box falls back to the default while the setting is not known yet", () => {
  const sent = [];
  const input = fakeInput("");
  bindNumberSetting(input, "limit", { send: (m) => sent.push(m), current: () => undefined });
  input.change("");
  assert.equal(input.value, String(DEFAULT_SETTINGS.limit));
  assert.deepEqual(sent, [{ type: "settings_set", settings: { limit: DEFAULT_SETTINGS.limit } }]);
});
