import test from "node:test";
import assert from "node:assert/strict";
import { HOST_NAME } from "../lib/constants.js";
import { parseUrlLines } from "../lib/urls.js";
import { installerFor, classifyConnectError } from "../lib/platform.js";
import { createRequestIds } from "../lib/ids.js";
import { formatEta, formatSpeed, formatWait } from "../lib/format.js";
import { classifyTabUrl } from "../lib/page.js";

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

test("formatSpeed", () => {
  assert.equal(formatSpeed(1048576), "1.0 MB/s");
  assert.equal(formatSpeed(0), "");
});

test("formatWait says a wait in seconds, and in minutes once it is long (the host may ask for up to two minutes)", () => {
  assert.equal(formatWait(4), "4 秒");
  assert.equal(formatWait(3.2), "4 秒", "rounded up: never says 0 while still waiting");
  assert.equal(formatWait(59), "59 秒");
  assert.equal(formatWait(60), "1 分鐘");
  assert.equal(formatWait(90), "1 分 30 秒");
  assert.equal(formatWait(120), "2 分鐘");
  assert.equal(formatWait(0), "0 秒");
  assert.equal(formatWait(-5), "0 秒");
  assert.equal(formatWait(NaN), "");
  assert.equal(formatWait(undefined), "");
});

test("isYouTubeUrl accepts only the listed hosts, with no credentials, odd ports or hidden extra text", async () => {
  const { isYouTubeUrl } = await import("../lib/urls.js");
  for (const ok of ["https://youtu.be/a", "http://m.youtube.com/@x", "https://music.youtube.com/playlist?list=1", "https://youtube.com/@x", "https://WWW.YOUTUBE.COM:443/watch?v=a", " https://youtu.be/a "]) {
    assert.equal(isYouTubeUrl(ok), true, ok);
  }
  for (const bad of ["https://evil.youtube.com/x", "https://studio.youtube.com/", "https://www.youtube.com:8443/x", "https://u:p@www.youtube.com/", "https://www.youtube.com/x --exec y", "https://www.youtube.com/x\nhttps://evil.com/", "https://www.youtube.com\\@evil.com/", "https://www.youtube.com./x", `https://www.youtube.com/${"a".repeat(2100)}`, "", null]) {
    assert.equal(isYouTubeUrl(bad), false, String(bad));
  }
});

test("Instagram: only the address of one post is supported, YouTube stays YouTube-only", async () => {
  const { isInstagramUrl, isSupportedUrl, isYouTubeUrl, parseUrlLines } = await import("../lib/urls.js");
  const ok = ["https://www.instagram.com/reel/Dd8pP9yS3WB/", "https://instagram.com/reel/Dd8pP9yS3WB", "https://www.instagram.com/reel/Dd8pP9yS3WB/?igsh=abc&utm_source=x", "https://www.instagram.com/reels/Dd8pP9yS3WB/", "https://www.instagram.com/p/Dd8pP9yS3WB/", "https://www.instagram.com/some.user_1/reel/Dd8pP9yS3WB/", " https://www.instagram.com/reel/Dd8pP9yS3WB/ "];
  const bad = ["https://www.instagram.com/", "https://www.instagram.com/some.user/", "https://www.instagram.com/accounts/login/", "https://www.instagram.com/stories/some.user/123/", "https://www.instagram.com/reel/", "https://help.instagram.com/reel/Dd8pP9yS3WB/", "https://instagram.com.evil.com/reel/Dd8pP9yS3WB/", "https://l.instagram.com/?u=https://evil.com", "https://www.instagram.com/reel/Dd8pP9yS3WB/extra/segments/", "https://www.instagram.com:8443/reel/Dd8pP9yS3WB/", "https://u:p@www.instagram.com/reel/Dd8pP9yS3WB/", "https://www.instagram.com/reel/Dd8pP9yS3WB/ --exec x", "https://www.instagram.com/reel/../accounts/login/", "", null];
  for (const url of ok) {
    assert.equal(isInstagramUrl(url), true, url);
    assert.equal(isSupportedUrl(url), true, url);
    assert.equal(isYouTubeUrl(url), false, url);
  }
  for (const url of bad) {
    assert.equal(isInstagramUrl(url), false, String(url));
    assert.equal(isSupportedUrl(url), false, String(url));
  }
  assert.equal(isInstagramUrl("https://youtu.be/abc"), false);
  assert.equal(isSupportedUrl("https://youtu.be/abc"), true);
  const { urls, invalid } = parseUrlLines("https://youtu.be/abc\nhttps://www.instagram.com/reel/Dd8pP9yS3WB/\nhttps://www.instagram.com/some.user/");
  assert.deepEqual(urls, ["https://youtu.be/abc", "https://www.instagram.com/reel/Dd8pP9yS3WB/"]);
  assert.deepEqual(invalid, ["https://www.instagram.com/some.user/"]);
});

test("classifyTabUrl sees an Instagram post as one video", async () => {
  const { classifyTabUrl } = await import("../lib/page.js");
  assert.equal(classifyTabUrl("https://www.instagram.com/reel/Dd8pP9yS3WB/"), "video");
  assert.equal(classifyTabUrl("https://www.instagram.com/some.user/"), null);
});
