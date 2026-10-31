import { isInstagramUrl, isYouTubeUrl } from "./urls.js";

// What the active tab is showing, so the side panel can offer to add it.
// A watch URL that also carries &list= counts as a video (the host resolves it as one video).
export function classifyTabUrl(url) {
  if (url && isInstagramUrl(url)) return "video";
  if (!url || !isYouTubeUrl(url)) return null;
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, "");
  const parts = path.split("/");
  if (u.hostname.toLowerCase() === "youtu.be") return path ? "video" : null;
  if (path === "/watch") return u.searchParams.has("v") ? "video" : null;
  if (["shorts", "live", "embed"].includes(parts[1]) && parts[2]) return "video";
  if (path === "/playlist") return u.searchParams.has("list") ? "playlist" : null;
  if (/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)(\/videos)?$/.test(path)) return "channel";
  return null;
}

const KIND_TEXT = { video: "影片", playlist: "播放清單", channel: "頻道" };

// "Name on Instagram: "caption"" -> "Name：caption"; "Name (@user) • Instagram reel" -> "Name (@user)"; anything else as it is.
function instagramTitle(title) {
  const said = title.match(/^(.+?) on Instagram: ["“”](.*?)["“”]?$/s);
  if (said) return said[2] ? `${said[1]}：${said[2]}` : said[1];
  return title.replace(/\s*[•|]\s*Instagram\b.*$/i, "").trim() || title;
}

// What the 「目前分頁」 card shows for the active tab, or null when that tab is not something to add.
export function describeTab(url, rawTitle) {
  const kind = classifyTabUrl(url);
  if (!kind) return null;
  const instagram = isInstagramUrl(url);
  const raw = String(rawTitle ?? "").trim() || url;
  const title = instagram ? instagramTitle(raw) : raw.replace(/ - YouTube$/, "");
  return { url, kind, chip: instagram ? "Instagram 影片" : KIND_TEXT[kind], title };
}

// The add button stands for the card while it is shown, so it names what it adds (a screen reader reads only this).
export const addButtonLabel = (tab) => (tab ? `增加目前分頁：${tab.title}` : "增加");
