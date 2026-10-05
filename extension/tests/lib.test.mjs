import test from "node:test";
import assert from "node:assert/strict";
import { HOST_NAME } from "../lib/constants.js";
import { parseUrlLines } from "../lib/urls.js";
import { installerFor, classifyConnectError } from "../lib/platform.js";
import { emptyProgress, applyEvent } from "../lib/events.js";
import { createRequestIds } from "../lib/ids.js";
import { formatEta, itemMeta } from "../lib/format.js";
import { classifyTabUrl } from "../lib/page.js";
import { overallProgress, previewItems, seedProgress } from "../lib/progress.js";

test("HOST_NAME is the registered native host name", () => {
  assert.equal(HOST_NAME, "com.ytdl.batch_downloader");
});

test("parseUrlLines trims, dedupes, separates invalid", () => {
  const { urls, invalid } = parseUrlLines(
    "  https://youtu.be/a \n\nhttps://youtu.be/a\nhttp://evil.com/x\nhello");
  assert.deepEqual(urls, ["https://youtu.be/a"]);
  assert.deepEqual(invalid, ["http://evil.com/x", "hello"]);
});

test("parseUrlLines handles CRLF and lookalike hosts", () => {
  const { urls, invalid } = parseUrlLines(
    "https://www.youtube.com/watch?v=a\r\nhttps://youtube.com.evil.com/x\r\nhttps://youtube.com@evil.com/");
  assert.deepEqual(urls, ["https://www.youtube.com/watch?v=a"]);
  assert.equal(invalid.length, 2);
});

test("installerFor maps platforms", () => {
  assert.equal(installerFor("win").file, "installers/install-windows.cmd");
  assert.equal(installerFor("mac").file, "installers/install-mac.zip");
  assert.equal(installerFor("linux"), null);
  assert.equal(installerFor("cros"), null);
});

test("classifyConnectError", () => {
  assert.equal(classifyConnectError("Specified native messaging host not found."), "not_installed");
  assert.equal(classifyConnectError("Access to the specified native messaging host is forbidden."), "forbidden");
  assert.equal(classifyConnectError("Native host has exited."), "exited");
  assert.equal(classifyConnectError("boom"), "other");
  assert.equal(classifyConnectError(undefined), "other");
});

test("applyEvent progress then done keeps seeded fields", () => {
  const seeded = { items: { v1: { title: "T" } }, summary: null };
  const s1 = applyEvent(seeded, { type: "progress", itemId: "v1", percent: 50, speed: 100, eta: 3 });
  assert.equal(s1.items.v1.percent, 50);
  assert.equal(s1.items.v1.title, "T");
  assert.equal(s1.items.v1.status, "downloading");
  const s2 = applyEvent(s1, { type: "item_done", itemId: "v1", file: "/o/a.mp4", height: 1080,
    codec: "avc1.640028", skipped: false });
  assert.equal(s2.items.v1.status, "done");
  assert.equal(s2.items.v1.file, "/o/a.mp4");
  assert.equal(s2.items.v1.height, 1080);
  assert.equal(s2.items.v1.percent, 100);
  assert.equal(s2.items.v1.warnNotH264, false);
});

test("applyEvent failed keeps reason and code", () => {
  const s = applyEvent(emptyProgress(), { type: "item_failed", itemId: "v2", reason: "私人影片", code: "private" });
  assert.deepEqual([s.items.v2.status, s.items.v2.reason, s.items.v2.code], ["failed", "私人影片", "private"]);
});

test("applyEvent skipped and non-h264 warning", () => {
  const skipped = applyEvent(emptyProgress(), { type: "item_done", itemId: "a", file: "/o/a.mp4",
    height: null, codec: null, skipped: true });
  assert.equal(skipped.items.a.status, "skipped");
  const vp9 = applyEvent(emptyProgress(), { type: "item_done", itemId: "b", file: "/o/b.mp4",
    height: 720, codec: "vp09.00.40.08", skipped: false });
  assert.equal(vp9.items.b.warnNotH264, true);
  const unknown = applyEvent(emptyProgress(), { type: "item_done", itemId: "c", file: "/o/c.mp4",
    height: 720, codec: null, skipped: false });
  assert.equal(unknown.items.c.warnNotH264, false);
});

test("applyEvent done sets summary, ignores unknown events, never mutates", () => {
  const before = emptyProgress();
  const snapshot = JSON.stringify(before);
  const summary = { ok: 1, skipped: 0, failed: 0, cancelled: false };
  const after = applyEvent(before, { type: "done", jobId: "j", summary });
  assert.deepEqual(after.summary, summary);
  assert.equal(JSON.stringify(before), snapshot);
  assert.equal(applyEvent(before, { type: "mystery" }), before);
});

test("createRequestIds never collides across popup instances", () => {
  const a = createRequestIds();
  const b = createRequestIds();
  const ids = [a(), a(), b(), b()];
  assert.equal(new Set(ids).size, 4);
  assert.ok(ids.every((id) => typeof id === "string"));
});

test("formatEta", () => {
  assert.equal(formatEta(75), "1:15");
  assert.equal(formatEta(3725), "1:02:05");
  assert.equal(formatEta(0), "0:00");
  assert.equal(formatEta(null), "");
});

test("itemMeta shows percent, speed and eta while downloading", () => {
  assert.equal(itemMeta({ status: "downloading", percent: 50, speed: 1048576, eta: 75 }), "50% 1.0 MB/s · 剩餘 1:15");
  assert.equal(itemMeta({ status: "done", height: 1080 }), "完成 · 1080p");
  assert.equal(itemMeta({ status: "skipped" }), "已下載過，略過");
  assert.equal(itemMeta({ status: "failed", reason: "私人影片" }), "私人影片");
  assert.equal(itemMeta({ status: "queued" }), "排隊中");
});

test("classifyTabUrl tells videos, playlists and channels apart", () => {
  const cases = [
    ["https://www.youtube.com/watch?v=abc", "video"],
    ["https://www.youtube.com/watch?v=abc&list=PL1", "video"],
    ["https://youtu.be/abc", "video"],
    ["https://www.youtube.com/shorts/abc", "video"],
    ["https://www.youtube.com/playlist?list=PL1", "playlist"],
    ["https://www.youtube.com/@abc", "channel"],
    ["https://www.youtube.com/@abc/videos", "channel"],
    ["https://www.youtube.com/channel/UC123", "channel"],
    ["https://www.youtube.com/", null],
    ["https://www.youtube.com/feed/subscriptions", null],
    ["https://example.com/watch?v=abc", null],
    ["https://youtube.com.evil.com/watch?v=abc", null],
    ["chrome://extensions", null],
    ["", null],
    [undefined, null],
  ];
  for (const [url, kind] of cases) assert.equal(classifyTabUrl(url), kind, String(url));
});

test("overallProgress counts finished items plus partial progress", () => {
  assert.deepEqual(overallProgress({}), { total: 0, finished: 0, done: 0, skipped: 0, failed: 0, percent: 0 });
  const p = overallProgress({
    a: { status: "done" }, b: { status: "skipped" }, c: { status: "failed" },
    d: { status: "downloading", percent: 50 }, e: { status: "queued" },
  });
  assert.deepEqual([p.total, p.finished, p.done, p.skipped, p.failed, p.percent], [5, 3, 1, 1, 1, 70]);
});

test("overallProgress tolerates missing percent and never exceeds 100", () => {
  assert.equal(overallProgress({ a: { status: "downloading", percent: null }, b: { status: "queued" } }).percent, 0);
  assert.equal(overallProgress({ a: { status: "downloading", percent: 250 } }).percent, 100);
});

test("previewItems keys resolved items by id, falling back to url for unresolved ones", () => {
  const rows = previewItems([
    { id: "a", title: "T", url: "https://youtu.be/a" },
    { id: "", title: "", url: "https://youtu.be/bad" },
  ]);
  assert.deepEqual(Object.keys(rows), ["a", "https://youtu.be/bad"]);
  assert.equal(rows.a.status, "preview");
  assert.equal(rows.a.title, "T");
  assert.equal(rows["https://youtu.be/bad"].unresolved, true);
});

test("itemMeta labels preview rows as waiting to download", () => {
  assert.equal(itemMeta({ status: "preview" }), "待下載");
});

test("seedProgress queues titled rows so progress events keep showing titles", () => {
  const state = seedProgress([
    { id: "a", title: "標題 A", url: "https://youtu.be/a" },
    { id: "", title: "", url: "https://youtu.be/bad" },
  ]);
  assert.deepEqual(Object.keys(state.items), ["a"]);
  assert.deepEqual(state.items.a, { title: "標題 A", status: "queued" });
  assert.equal(state.summary, null);
  const next = applyEvent(state, { type: "progress", itemId: "a", percent: 10, speed: 1, eta: 2 });
  assert.equal(next.items.a.title, "標題 A");
});
