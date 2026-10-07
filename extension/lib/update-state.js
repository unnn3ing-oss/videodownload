import { shouldCheck } from "./updater.js";

const KEY = "updateInfo";

// Which parts differ from the repository: "extension" (the extension's own files), "host" (the local program's files),
// "both", or null. Works on a stored summary too (one stored by an older version has no host count).
export function changedParts({ extChangedCount = 0, hostChangedCount = 0 }) {
  const ext = extChangedCount > 0;
  const host = hostChangedCount > 0;
  return ext && host ? "both" : ext ? "extension" : host ? "host" : null;
}

const PARTS_TEXT = { extension: "擴充功能有新版本", host: "下載助手有新版本", both: "擴充功能和下載助手都有新版本" };
export const partsText = (summary) => PARTS_TEXT[changedParts(summary ?? {})] ?? "";

// `info`: collectUpdateInfo's answer (the same one the manual check uses), or checkLatest's with `hostChanged` and `hostChecked` added.
// `previous`: the stored summary. The local program can only be compared while it runs: a check that could not ask it keeps
// what the last check knew about its files (only a check that really asked can clear that difference). The extension's own
// files are always compared fresh, so an update that was applied does not linger.
export function summarizeCheck(info, now = Date.now(), previous = null) {
  const hostChecked = Boolean(info.hostChecked);
  const extChangedCount = info.extChanged.length;
  const hostChangedCount = hostChecked ? (info.hostChanged?.length ?? 0) : (previous?.hostChangedCount ?? 0);
  return {
    checkedAt: now,
    sha: info.sha,
    date: info.date,
    message: info.message,
    hasUpdate: extChangedCount > 0 || hostChangedCount > 0,
    extChangedCount,
    hostChangedCount,
    hostChecked,
    parts: changedParts({ extChangedCount, hostChangedCount }),
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

// One finished check, stored and shown by the toolbar badge. Every check (the 6-hour alarm, browser start, the first
// connection of the local program, the manual one) goes through here, so they cannot disagree about the badge.
export async function recordCheck(info, { load = loadSummary, save = saveSummary, badge = applyBadge, now = Date.now() } = {}) {
  const summary = summarizeCheck(info, now, await load().catch(() => null));
  await save(summary).catch(() => {});
  await badge(summary.hasUpdate).catch(() => {});
  return summary;
}

// A check that failed: the last known result and the badge stay as they are.
export async function recordFailure(message, { load = loadSummary, save = saveSummary, now = Date.now() } = {}) {
  const summary = failedSummary(await load().catch(() => null), message, now);
  await save(summary).catch(() => {});
  return summary;
}

// Runs `run` one at a time. Asking while it runs does not start a second one at once: it asks for exactly one more run
// afterwards (e.g. the local program connected while the check was already looking, so that check could not compare its files).
export function createCheckRunner(run) {
  let running = null;
  let again = false;
  return {
    trigger() {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        try {
          do {
            again = false;
            await run();
          } while (again);
        } finally {
          running = null;
        }
      })();
      return running;
    },
  };
}
