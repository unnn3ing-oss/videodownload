// "Copy text" for a video: 【title】 and the first hashtags of its description.
const HASHTAG = /(?<=^|[\s\u0085(（【\[「『])#([\p{L}\p{N}_]+)/gmu;

// Hashtags (without the #) in order of appearance, distinct ignoring case. A # inside a url does not count.
export function extractHashtags(description, max = 3) {
  const tags = [];
  const seen = new Set();
  for (const match of String(description ?? "").matchAll(HASHTAG)) {
    const key = match[1].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(match[1]);
    if (tags.length >= max) break;
  }
  return tags;
}

// The channel's own tags are on every video: they say nothing about this one, so they are left out of the copy text.
export const EXCLUDED_TAGS = ["TVBS新聞", "TVBS直播", "TVBS新聞網"];
export const MAX_TAGS = 3; // tags in the copy text
export const KEEP_TAGS = 12; // tags kept per video: enough to still find three after the channel's own are left out

// The first `max` tags that are not the channel's own.
export function pickTags(tags, max = MAX_TAGS) {
  const skip = new Set(EXCLUDED_TAGS.map((tag) => tag.toLowerCase()));
  return (Array.isArray(tags) ? tags : []).filter((tag) => !skip.has(String(tag).toLowerCase())).slice(0, max);
}

// "標題｜TVBS新聞 @TVBSNEWS01" -> "標題": the part after the last ｜ (or |) goes when it is the channel name (it has TVBS or an
// @handle in it). A ｜ inside the title stays, and a title is never emptied.
export function cleanTitle(title) {
  let text = String(title ?? "").replace(/[\s\u0085]+/g, " ").trim();
  const cut = text.replace(/\s*[｜|][^｜|]*(?:TVBS|@)[^｜|]*$/i, "").replace(/\s+@\S+$/, "").trim();
  return cut || text;
}

// (JavaScript's \s leaves out U+0085, a line break in Unicode)
export function buildCopyText(title, tags) {
  const line = `【${cleanTitle(title)}】`;
  return tags.length ? `${line}\n\n${tags.map((tag) => `#${tag}`).join(" ")}` : line;
}
