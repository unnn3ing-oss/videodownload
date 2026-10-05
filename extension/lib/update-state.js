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
