// "Copy text" for a video: 【title】 and the first hashtags of its description.
const HASHTAG = /(?<=^|[\s(（【\[「『])#([\p{L}\p{N}_]+)/gmu;

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

// (JavaScript's \s leaves out U+0085, a line break in Unicode)
export function buildCopyText(title, tags) {
  const line = `【${String(title ?? "").replace(/[\s\u0085]+/g, " ").trim()}】`;
  return tags.length ? `${line}\n${tags.map((tag) => `#${tag}`).join(" ")}` : line;
}
