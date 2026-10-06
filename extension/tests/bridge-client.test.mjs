import test, { mock } from "node:test";
import assert from "node:assert/strict";

const ORIGIN = "https://example.test";

// The page's side of the bridge talks through window.postMessage; here the window is a stand-in and time is fake.
async function pageWithClient() {
  const handlers = [];
  const win = { addEventListener: (type, fn) => { if (type === "message") handlers.push(fn); }, postMessage() {} };
  globalThis.window = win;
  globalThis.location = { origin: ORIGIN };
  mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  const { createBridgeClient } = await import(`../../web/bridge-client.js?${Math.random()}`);
  const client = createBridgeClient({ pingEveryMs: 2000, lostAfterMs: 6000 });
  const changes = [];
  client.onChange((value) => changes.push(value));
  const hello = () => handlers.forEach((fn) => fn({ source: win, origin: ORIGIN, data: { source: "ytdl-ext", hello: { version: "x" } } }));
  return { client, changes, hello };
}

test("an extension that keeps answering stays detected, and silence of more than 6 seconds means it is gone", async () => {
  const { client, changes, hello } = await pageWithClient();
  try {
    hello();
    assert.equal(client.detected(), true);
    for (let i = 0; i < 5; i += 1) { mock.timers.tick(2000); hello(); }
    assert.equal(client.detected(), true);
    mock.timers.tick(2000); mock.timers.tick(2000); mock.timers.tick(2000); // 6 s without an answer: not yet
    assert.equal(client.detected(), true);
    mock.timers.tick(2000);
    assert.equal(client.detected(), false);
    assert.deepEqual(changes, [true, false]);
  } finally {
    mock.timers.reset();
  }
});

test("a long pause of the page's timers (hidden tab, sleeping computer) is not taken for a lost extension", async () => {
  const { client, changes, hello } = await pageWithClient();
  try {
    hello();
    mock.timers.setTime(Date.now() + 10 * 60 * 1000); // the page was frozen for ten minutes
    mock.timers.tick(2000); // the first ping after waking up; its answer is still on its way
    assert.equal(client.detected(), true, "no verdict before the extension had a chance to answer");
    hello();
    mock.timers.tick(2000);
    assert.deepEqual(changes, [true], "never flipped to lost and back");
    // ...but an extension that really is gone is still noticed
    for (let i = 0; i < 4; i += 1) mock.timers.tick(2000);
    assert.equal(client.detected(), false);
  } finally {
    mock.timers.reset();
  }
});
