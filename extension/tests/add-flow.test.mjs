import test from "node:test";
import assert from "node:assert/strict";
import { summarizeAdd } from "../lib/add-flow.js";
import { addPastedUrls } from "../lib/queue-view.js";

const ok = (url) => ({ url, ok: true });
const no = (url, error) => ({ url, ok: false, error });
const NOT_YT = "不是 YouTube 網址";

test("summarizeAdd: everything added leaves an empty box and says nothing", () => {
  assert.deepEqual(summarizeAdd([ok("a"), ok("b")]), { remaining: "", note: "" });
  assert.deepEqual(summarizeAdd([]), { remaining: "", note: "" });
});

test("summarizeAdd keeps only the rejected urls, in their order, one per line, and says how many and why", () => {
  const out = summarizeAdd([ok("https://youtu.be/a"), no("https://evil.example/x", NOT_YT), ok("https://youtu.be/b"), no("not a url", NOT_YT)]);
  assert.equal(out.remaining, "https://evil.example/x\nnot a url");
  assert.equal(out.note, `已加入 2 個網址；2 個沒有加入，已留在輸入框（${NOT_YT}：2 個）。`);
});

test("summarizeAdd with nothing added, and with several different reasons", () => {
  const none = summarizeAdd([no("x", NOT_YT)]);
  assert.equal(none.remaining, "x");
  assert.equal(none.note, `1 個網址沒有加入，已留在輸入框（${NOT_YT}：1 個）。`);
  const mixed = summarizeAdd([no("x", NOT_YT), no("y", "清單已滿（上限 500 筆）"), no("z", NOT_YT)]);
  assert.equal(mixed.remaining, "x\ny\nz");
  assert.equal(mixed.note, `3 個網址沒有加入，已留在輸入框（${NOT_YT}：2 個；清單已滿（上限 500 筆）：1 個）。`);
});

// just enough of an <input>: a value
const box = (value) => ({ value });

test("addPastedUrls adds the good urls, leaves the rejected ones in the box and returns the note", async () => {
  const input = box("https://youtu.be/a  https://evil.example/x\nhttps://youtu.be/b not-a-url");
  const sent = [];
  const send = async (m) => {
    sent.push(m.url);
    return m.url.includes("youtu.be") ? { ok: true } : { ok: false, error: NOT_YT };
  };
  const note = await addPastedUrls(input, send);
  assert.deepEqual(sent, ["https://youtu.be/a", "https://evil.example/x", "https://youtu.be/b", "not-a-url"]);
  assert.equal(input.value, "https://evil.example/x\nnot-a-url");
  assert.equal(note, `已加入 2 個網址；2 個沒有加入，已留在輸入框（${NOT_YT}：2 個）。`);
});

test("addPastedUrls empties the box when everything was added, and ignores an empty box", async () => {
  const input = box("https://youtu.be/a");
  assert.equal(await addPastedUrls(input, async () => ({ ok: true })), "");
  assert.equal(input.value, "");
  let called = false;
  assert.equal(await addPastedUrls(box("   "), async () => { called = true; return { ok: true }; }), "");
  assert.equal(called, false);
});

test("addPastedUrls keeps a url whose request failed (the page could not reach the extension) so it can be tried again", async () => {
  const input = box("https://youtu.be/a https://youtu.be/b");
  const note = await addPastedUrls(input, async (m) => { if (m.url.endsWith("/b")) throw new Error("逾時，沒有收到回應"); return { ok: true }; });
  assert.equal(input.value, "https://youtu.be/b");
  assert.match(note, /已加入 1 個網址；1 個沒有加入/);
  assert.match(note, /逾時，沒有收到回應/);
});

test("addPastedUrls does not throw away what the person typed while the urls were being added", async () => {
  const input = box("https://evil.example/x");
  const note = await addPastedUrls(input, async () => { input.value = "https://youtu.be/new\n"; return { ok: false, error: NOT_YT }; });
  assert.equal(input.value, "https://youtu.be/new\nhttps://evil.example/x", "the new text stays, the rejected url is put after it");
  assert.match(note, /1 個網址沒有加入/);
  const typedOver = box("https://youtu.be/a");
  await addPastedUrls(typedOver, async () => { typedOver.value = "https://youtu.be/new"; return { ok: true }; });
  assert.equal(typedOver.value, "https://youtu.be/new", "everything was added: only the new text is left");
});
