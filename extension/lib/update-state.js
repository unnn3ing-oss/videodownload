import { shouldCheck } from "./updater.js";

const KEY = "updateInfo";

export function summarizeCheck(info, now = Date.now()) {
  return {
    checkedAt: now,
    sha: info.sha,
    date: info.date,
    message: info.message,
    hasUpdate: info.hasUpdate,
    extChangedCount: info.extChanged.length,
  };
}

// A failed check must not erase the last good result (the toolbar badge keeps it too).
export function failedSummary(previous, message, now = Date.now()) {
  return { ...(previous ?? {}), error: message, errorAt: now };
}

const ERROR_RETRY_MS = 5 * 60 * 1000;

// Whether the panel should check on its own: nothing stored, the result is stale, an update is
// pending (its file list is not stored), or a failed check is old enough to retry.
export function autoCheckDue(summary, now = Date.now()) {
  if (!summary) return true;
  if (summary.error) return now - (summary.errorAt ?? 0) >= ERROR_RETRY_MS;
  return Boolean(summary.hasUpdate) || shouldCheck(summary.checkedAt, now);
}

export async function saveSummary(summary) {
  await chrome.storage.local.set({ [KEY]: summary });
}

export async function loadSummary() {
  const stored = await chrome.storage.local.get(KEY);
  return stored[KEY] ?? null;
}

export async function applyBadge(hasUpdate) {
  await chrome.action.setBadgeText({ text: hasUpdate ? "新" : "" });
  if (hasUpdate) await chrome.action.setBadgeBackgroundColor({ color: "#1f5eff" });
}
