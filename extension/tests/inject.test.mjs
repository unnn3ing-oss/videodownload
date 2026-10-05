import test from "node:test";
import assert from "node:assert/strict";
import { injectBridge } from "../lib/inject.js";

test("injectBridge puts bridge.js into every open tab of the web version", async () => {
  const queries = [];
  const injected = [];
  const deps = {
    tabs: { query: async (q) => { queries.push(q); return [{ id: 3 }, { id: 8 }]; } },
    scripting: { executeScript: async (options) => { injected.push(options); } },
  };
  assert.equal(await injectBridge(deps), 2);
  assert.deepEqual(queries, [{ url: "https://unnn3ing-oss.github.io/videodownload/*" }]);
  assert.deepEqual(injected, [{ target: { tabId: 3 }, files: ["bridge.js"] }, { target: { tabId: 8 }, files: ["bridge.js"] }]);
});

test("injectBridge skips a tab that refuses and survives missing tab access", async () => {
  const tried = [];
  const refusing = {
    tabs: { query: async () => [{ id: 1 }, { id: 2 }] },
    scripting: { executeScript: async ({ target }) => { tried.push(target.tabId); if (target.tabId === 1) throw new Error("no access"); } },
  };
  assert.equal(await injectBridge(refusing), 1);
  assert.deepEqual(tried, [1, 2]);
  assert.equal(await injectBridge({ tabs: { query: async () => { throw new Error("denied"); } }, scripting: {} }), 0);
});
