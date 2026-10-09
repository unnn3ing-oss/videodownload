export const ALLOWED_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"];
export const MAX_URL_LENGTH = 2048;
// (host/security.py keeps the same list; a test keeps them equal)

export function isYouTubeUrl(text) {
  const value = String(text ?? "").trim();
  if (!value || value.length > MAX_URL_LENGTH || /[\s\u0000-\u001f\u007f\\]/.test(value)) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== (url.protocol === "https:" ? "443" : "80")) return false; // (the URL class drops a default port)
  return ALLOWED_HOSTS.includes(url.hostname.toLowerCase());
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
