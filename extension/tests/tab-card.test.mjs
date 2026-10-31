import test from "node:test";
import assert from "node:assert/strict";
import { addButtonLabel, describeTab } from "../lib/page.js";

const REEL = "https://www.instagram.com/reel/Dd8pP9yS3WB/";
const WATCH = "https://www.youtube.com/watch?v=abcdefghijk";

test("a YouTube tab: its kind in words and the title without the site's suffix", () => {
  assert.deepEqual(describeTab(WATCH, "颱風最新 - YouTube"), { url: WATCH, kind: "video", chip: "影片", title: "颱風最新" });
  assert.equal(describeTab("https://www.youtube.com/playlist?list=PLx", "清單 - YouTube").chip, "播放清單");
  assert.equal(describeTab("https://www.youtube.com/@tvbsnews", "TVBS NEWS - YouTube").chip, "頻道");
});

test("an Instagram tab says Instagram on its chip", () => {
  assert.equal(describeTab(REEL, "x").chip, "Instagram 影片");
  assert.equal(describeTab(REEL, "x").kind, "video");
});

test("an Instagram title loses the site's wording, and an unknown shape is shown as it is", () => {
  assert.equal(describeTab(REEL, 'TVBS 新聞 on Instagram: "颱風來襲 請小心"').title, "TVBS 新聞：颱風來襲 請小心");
  assert.equal(describeTab(REEL, "TVBS 新聞 (@tvbsnews) • Instagram reel").title, "TVBS 新聞 (@tvbsnews)");
  assert.equal(describeTab(REEL, "Instagram").title, "Instagram");
  assert.equal(describeTab(REEL, "完全不同的標題").title, "完全不同的標題");
});

test("a tab without a title shows its address; tabs we cannot add give nothing", () => {
  assert.equal(describeTab(REEL, "").title, REEL);
  assert.equal(describeTab(REEL, undefined).title, REEL);
  assert.equal(describeTab("https://www.instagram.com/some.user/", "x"), null);
  assert.equal(describeTab("https://example.com/", "x"), null);
  assert.equal(describeTab(undefined, "x"), null);
});

test("while the card stands in for the address box, the add button says what it adds", () => {
  assert.equal(addButtonLabel({ title: "颱風最新" }), "增加目前分頁：颱風最新");
  assert.equal(addButtonLabel(null), "增加");
});
