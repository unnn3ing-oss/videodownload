export function isYouTubeUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
}

export function parseUrlLines(text) {
  const urls = [];
  const invalid = [];
  const seen = new Set();
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    (isYouTubeUrl(line) ? urls : invalid).push(line);
  }
  return { urls, invalid };
}
