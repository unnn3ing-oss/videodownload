// Which messages each kind of sender may send to the background script.
import { WEB_ORIGIN, WEB_PATH } from "./constants.js";

const QUEUE = ["queue_get", "queue_add", "queue_remove", "queue_retry", "queue_start", "queue_stop",
  "queue_copy_text", "queue_download_cover", "settings_set"];

// The side panel is the extension's own page: it may also run updates.
export const PANEL_ALLOWED = new Set([
  "get_status", "start", "resolve", "download", "cancel", "set_output_dir", "deploy_installer",
  "update_engine", "update_check", "update_stage", "update_commit", "update_rollback", ...QUEUE,
]);

// The web page is only a remote control for the queue; updates stay in the side panel.
export const WEB_ALLOWED = new Set(["ping", "get_status", "start", "set_output_dir", "deploy_installer", ...QUEUE]);

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
