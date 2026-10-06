// Which messages each kind of sender may send to the background script.
import { WEB_ORIGIN, WEB_PATH } from "./constants.js";

const QUEUE = ["queue_get", "queue_add", "queue_remove", "queue_retry", "queue_start", "queue_stop",
  "queue_copy_text", "queue_download_cover", "settings_set"];

// The side panel is the extension's own page: it may also run updates.
export const PANEL_ALLOWED = new Set([
  "get_status", "start", "set_output_dir", "deploy_installer", "doctor",
  "update_engine", "update_check", "update_stage", "update_commit", "update_rollback", "update_info", "update_apply", ...QUEUE,
]);

// The web page is a remote control for the queue. It may ask for the update check and for "update to the latest": the
// extension itself fetches (and verifies) the files from the fixed repository; the page never supplies file contents.
export const WEB_ALLOWED = new Set(["ping", "get_status", "start", "set_output_dir", "deploy_installer", "doctor", "update_info", "update_apply", ...QUEUE]);

export function classifySender(sender, extensionId) {
  if (!sender || sender.id !== extensionId || typeof sender.url !== "string") return null;
  if (sender.url.startsWith(`chrome-extension://${extensionId}/`)) return "panel";
  if (sender.tab && sender.url.startsWith(`${WEB_ORIGIN}${WEB_PATH}`)) return "web";
  return null;
}

export function isAllowed(kind, type) {
  if (typeof type !== "string") return false;
  if (kind === "panel") return PANEL_ALLOWED.has(type);
  if (kind === "web") return WEB_ALLOWED.has(type);
  return false;
}
