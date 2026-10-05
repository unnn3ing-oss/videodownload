// Must match HOST_NAME in build.py (a test enforces this).
export const HOST_NAME = "com.ytdl.batch_downloader";

// The web version is served from GitHub Pages; only this origin may talk to the extension.
export const WEB_ORIGIN = "https://unnn3ing-oss.github.io";
export const WEB_PATH = "/videodownload/";
// Must match "name" in manifest.json (a test enforces this).
export const EXTENSION_NAME = "YouTube 批量下載器";
// Oldest local host that understands cooldown, enqueue, remove, meta and save_cover.
export const MIN_HOST_VERSION = "0.2.0";
