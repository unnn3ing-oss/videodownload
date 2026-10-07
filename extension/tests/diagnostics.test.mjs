import test from "node:test";
import assert from "node:assert/strict";
import { COPIED_TEXT, DIAGNOSTICS_PRIVACY_NOTE, copyDiagnostics, diagnosticsReply } from "../lib/diagnostics.js";

test("the host's answer becomes the text to copy", () => {
  assert.deepEqual(diagnosticsReply({ type: "diagnostics", text: "版本 0.3.0\n檢查結果" }), { ok: true, text: "版本 0.3.0\n檢查結果" });
});

test("an error from the host, a wrong answer and an empty text are reported honestly", () => {
  assert.deepEqual(diagnosticsReply({ type: "error", code: "internal", message: "內部錯誤：x" }), { ok: false, error: "內部錯誤：x" });
  assert.match(diagnosticsReply({ type: "error", code: "unknown_type", message: "未知的訊息類型：diagnostics" }).error, /版本太舊.*安裝檔/);
  assert.match(diagnosticsReply({ type: "pong" }).error, /診斷資訊/);
  assert.match(diagnosticsReply({ type: "diagnostics", text: "" }).error, /診斷資訊/);
  assert.match(diagnosticsReply({ type: "diagnostics", text: 5 }).error, /診斷資訊/);
  assert.match(diagnosticsReply(undefined).error, /診斷資訊/);
});

test("the text is copied to the clipboard and the person is told so", async () => {
  const written = [];
  const result = await copyDiagnostics({ send: async () => ({ ok: true, text: "abc" }), writeText: async (text) => { written.push(text); } });
  assert.deepEqual(written, ["abc"]);
  assert.deepEqual(result, { state: "copied", message: COPIED_TEXT });
  assert.equal(COPIED_TEXT, "已複製，貼給維護的人就好");
});

test("when the clipboard refuses, the text is handed back to be selected and copied by hand", async () => {
  const result = await copyDiagnostics({
    send: async () => ({ ok: true, text: "abc" }),
    writeText: async () => { throw new DOMException("denied", "NotAllowedError"); },
  });
  assert.equal(result.state, "manual");
  assert.equal(result.text, "abc");
  assert.match(result.message, /沒辦法自動複製.*Ctrl\+A.*Cmd\+A/);
});

test("a host that is not connected, or that fails, says so and nothing is copied", async () => {
  let wrote = false;
  const writeText = async () => { wrote = true; };
  const notConnected = await copyDiagnostics({ send: async () => ({ ok: false, error: "尚未連線下載助手" }), writeText });
  assert.deepEqual(notConnected, { state: "error", message: "尚未連線下載助手" });
  const noAnswer = await copyDiagnostics({ send: async () => undefined, writeText });
  assert.equal(noAnswer.state, "error");
  const lost = await copyDiagnostics({ send: async () => { throw new Error("與擴充功能的連線中斷"); }, writeText });
  assert.deepEqual(lost, { state: "error", message: "與擴充功能的連線中斷" });
  assert.equal(wrote, false);
});

test("the sentence under the button says what is in the text", () => {
  assert.equal(DIAGNOSTICS_PRIVACY_NOTE, "內容已隱藏使用者名稱，只含版本、檢查結果與近期紀錄");
});

// The button and its sentence are plain HTML in both places (the side panel, and the web page's self-check dialog and sidebar).
import { readFileSync } from "node:fs";
const page = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

for (const [name, path, buttons] of [["side panel", "../sidepanel.html", ["diag-copy"]], ["web page", "../../index.html", ["diag-copy", "diag-copy-check"]]]) {
  test(`the ${name} has the copy button with a label that stands alone, the privacy sentence, and a hand-copy box`, () => {
    const html = page(path);
    for (const id of buttons) {
      assert.match(html, new RegExp(`<button id="${id}"[^>]*aria-label="複製診斷資訊[^"]*"[^>]*>複製診斷資訊</button>`), id);
      assert.match(html, new RegExp(`id="${id}-status"[^>]*role="status"`), `${id} status line`);
      assert.match(html, new RegExp(`<textarea id="${id}-text"[^>]*readonly[^>]*hidden`), `${id} fallback box`);
    }
    assert.equal(html.split(DIAGNOSTICS_PRIVACY_NOTE).length - 1, buttons.length, "one sentence under each button");
  });
}
