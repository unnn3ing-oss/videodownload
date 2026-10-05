import { isYouTubeUrl } from "./urls.js";

// What the active tab is showing, so the side panel can offer to add it.
// A watch URL that also carries &list= counts as a video (the host resolves it as one video).
export function classifyTabUrl(url) {
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
