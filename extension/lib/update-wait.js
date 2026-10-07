// After "update to the latest" the extension reloads itself: its connection to the page goes away for ten to fifteen seconds
// and comes back with the local program restarted. This is the waiting for that, with the clock and the page's state handed in
// so it can be tested. While it runs the page shows one calm message instead of "connection lost" (see UPDATING_TEXT).
export const RELOAD_WAIT_MS = 90000; // the hard end: after this the normal messages return
export const NO_RESTART_MS = 8000; // still connected and nothing restarted after this long: no reload happened
export const POLL_MS = 500;
export const UPDATING_TEXT = "更新中，擴充功能正在重新載入，請稍候…";
export const UPDATING_HINT = "通常要 10～15 秒，請不要關閉這個分頁";

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// probe() -> { detected, running, notRunningAt, version }: is the extension answering, does its local program run, when was the
// program last seen not running, and which extension version answered. Returns { running(), start({ expected, before }) }:
// start() resolves to { back, restarted, version, expected }, or is refused (null) while a wait is already running (a second click).
export function createReloadWait({ probe, now = Date.now, sleep = sleepFor, maxMs = RELOAD_WAIT_MS, noRestartAfterMs = NO_RESTART_MS, pollMs = POLL_MS }) {
  let active = false;
  async function waitUntilBack(expected, before) {
    const started = now();
    while (now() - started < maxMs) {
      await sleep(pollMs);
      const seen = probe();
      if (!(seen.detected && seen.running)) continue;
      const restarted = seen.notRunningAt >= started;
      if (restarted || (expected && expected !== before && seen.version === expected)) return { back: true, restarted: true, version: seen.version, expected };
      if (now() - started >= noRestartAfterMs) return { back: true, restarted: false, version: seen.version, expected };
    }
    return { back: false, restarted: false, version: null, expected };
  }
  return {
    running: () => active,
    start({ expected = null, before = null } = {}) {
      if (active) return null;
      active = true;
      return waitUntilBack(expected, before).finally(() => { active = false; });
    },
  };
}

// What to tell the person once the wait is over: { kind: "ok" | "error", text }.
export function describeOutcome({ back, version, expected }) {
  if (!back) {
    return {
      kind: "error",
      text: `更新後一直連不上擴充功能或下載助手（等了 ${RELOAD_WAIT_MS / 1000} 秒）。請到 chrome://extensions 確認擴充功能已啟用（或按它的重新載入），再重新整理本頁；還是不行，就重新執行安裝檔，它會自動檢查並修復。`,
    };
  }
  if (expected && version !== expected) {
    return { kind: "error", text: `已重新載入，但擴充功能的版本仍是 v${version}（預期 v${expected}）。載入的可能不是更新的那個資料夾，請到 chrome://extensions 確認它的載入路徑。` };
  }
  return { kind: "ok", text: expected ? `已更新到 v${expected}。` : "已更新。" };
}
