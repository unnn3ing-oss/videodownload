export const ALLOWED_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"];
export const INSTAGRAM_HOSTS = ["instagram.com", "www.instagram.com"];
export const MAX_URL_LENGTH = 2048;
// (host/security.py keeps the same lists; tests keep them equal)
// On Instagram only the address of one post: [user/]reel|reels|p|tv/<shortcode>, never a profile or the login page.
const INSTAGRAM_POST_PATH = /^\/(?:[A-Za-z0-9._]{1,30}\/)?(?:reel|reels|p|tv)\/[A-Za-z0-9_-]{5,64}\/?$/;

// The address as a URL when it is plain http(s) on its own port with no credentials and no hidden extra text; else null.
function plainUrl(text) {
  const value = String(text ?? "").trim();
  if (!value || value.length > MAX_URL_LENGTH || /[\s\u0000-\u001f\u007f\\]/.test(value)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== (url.protocol === "https:" ? "443" : "80")) return null; // (the URL class drops a default port)
  return url;
}

export function isYouTubeUrl(text) {
  const url = plainUrl(text);
  return !!url && ALLOWED_HOSTS.includes(url.hostname.toLowerCase());
}

export function isInstagramUrl(text) {
  const url = plainUrl(text);
  return !!url && INSTAGRAM_HOSTS.includes(url.hostname.toLowerCase()) && INSTAGRAM_POST_PATH.test(url.pathname);
}

export const isSupportedUrl = (text) => isYouTubeUrl(text) || isInstagramUrl(text);

export function parseUrlLines(text) {
  const urls = [];
  const invalid = [];
  const seen = new Set();
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    (isSupportedUrl(line) ? urls : invalid).push(line);
  }
  return { urls, invalid };
}
