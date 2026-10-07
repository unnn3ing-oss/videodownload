import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { injectBridge } from "../lib/inject.js";

const ORIGIN = "https://unnn3ing-oss.github.io";
const BRIDGE = readFileSync(new URL("../bridge.js", import.meta.url), "utf8");

// A stand-in for the browser: each tab is a page with its own listener list (shared by every script world of that page) and
// a script world for the extension. The real bridge.js runs in it, so what a second injection does is the real thing.
function newWorld(page, previous = null) {
  const instance = { alive: true }; // false once the extension was disabled or reloaded: the scripts of that instance are orphaned
  const sandbox = {
    location: { origin: ORIGIN },
    chrome: {
      runtime: {
        get id() { return instance.alive ? "ext" : undefined; },
        getManifest: () => ({ version: "1.0.0" }),
        connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, disconnect() {} }),
        sendMessage: async () => ({}),
      },
    },
    addEventListener: (type, fn) => { if (type === "message") page.listeners.push(fn); },
    removeEventListener: (type, fn) => { const at = page.listeners.indexOf(fn); if (at >= 0) page.listeners.splice(at, 1); },
    postMessage: (data) => page.posted.push(data),
  };
  sandbox.window = sandbox;
  if (previous) sandbox.__ytdlBridge = previous.sandbox.__ytdlBridge; // (what the old script left behind in the page's shared world)
  vm.createContext(sandbox);
  return { sandbox, instance };
}

function browser(tabCount) {
  const pages = new Map();
  for (let id = 1; id <= tabCount; id += 1) {
    const page = { listeners: [], posted: [], refuses: false };
    page.world = newWorld(page);
    pages.set(id, page);
  }
  const queries = [];
  const deps = {
    tabs: { query: async (q) => { queries.push(q); return [...pages.keys()].map((id) => ({ id })); } },
    scripting: {
      executeScript: async ({ target, files, func }) => {
        const page = pages.get(target.tabId);
        if (page.refuses) throw new Error("Cannot access contents of the page");
        if (files) {
          assert.deepEqual(files, ["bridge.js"]);
          vm.runInContext(BRIDGE, page.world.sandbox);
          return [{ result: null }];
        }
        return [{ result: vm.runInContext(`(${func})()`, page.world.sandbox) }];
      },
    },
  };
  return { pages, deps, queries, install: (id) => vm.runInContext(BRIDGE, pages.get(id).world.sandbox) };
}

test("injectBridge asks for the tabs of the web version only", async () => {
  const b = browser(2);
  await injectBridge(b.deps);
  assert.deepEqual(b.queries, [{ url: "https://unnn3ing-oss.github.io/videodownload/*" }]);
});

test("a page without a bridge gets one; a page whose bridge works is left alone", async () => {
  const b = browser(2);
  b.install(2);
  assert.equal(await injectBridge(b.deps), 1, "only the page that needed it");
  assert.deepEqual([b.pages.get(1).listeners.length, b.pages.get(2).listeners.length], [1, 1]);
  assert.equal(b.pages.get(1).posted.some((m) => m.hello), true, "the new bridge tells the page it is there");
});

test("injecting again never stacks a second listener", async () => {
  const b = browser(1);
  assert.equal(await injectBridge(b.deps), 1);
  assert.equal(await injectBridge(b.deps), 0);
  assert.equal(await injectBridge(b.deps), 0);
  b.install(1); // (even running the script itself again, as the browser does for a page that loads later)
  assert.equal(b.pages.get(1).listeners.length, 1);
});

test("after the extension was disabled and enabled again, the open page gets a working bridge and the dead one's listener goes", async () => {
  const b = browser(1);
  const page = b.pages.get(1);
  b.install(1);
  page.world.instance.alive = false; // disabled: the old script is orphaned but its listener is still on the page
  page.world = newWorld(page, page.world); // enabled again: a new instance, the old script's object still in the page
  page.posted.length = 0;
  assert.equal(await injectBridge(b.deps), 1);
  assert.equal(page.listeners.length, 1, "one listener: the new one");
  assert.equal(page.posted.some((m) => m.hello), true);
  assert.equal(await injectBridge(b.deps), 0, "and now it counts as working");
});

test("injectBridge skips a tab that refuses and survives missing tab access", async () => {
  const b = browser(3);
  b.pages.get(1).refuses = true;
  assert.equal(await injectBridge(b.deps), 2);
  assert.deepEqual([1, 2, 3].map((id) => b.pages.get(id).listeners.length), [0, 1, 1]);
  assert.equal(await injectBridge({ tabs: { query: async () => { throw new Error("denied"); } }, scripting: {} }), 0);
});
