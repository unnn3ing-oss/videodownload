// After an install, reload, update, re-enabling or browser start, web pages that were already open have no working bridge to
// the extension (Chrome only injects content scripts into pages loaded afterwards). Give them one.
import { WEB_ORIGIN, WEB_PATH } from "./constants.js";

// Runs inside the page, in the content scripts' world: is there a bridge there that still has its extension?
// (bridge.js leaves this object behind; an orphaned copy answers false.)
const bridgeAlive = () => Boolean(window.__ytdlBridge?.alive?.());

// deps: { tabs, scripting } (chrome.tabs and chrome.scripting). Safe to run as often as wanted (the service worker runs it at
// every start): a tab whose bridge works is left alone, and bridge.js itself replaces an orphaned copy instead of adding a
// second listener. Returns how many tabs were given the bridge.
export async function injectBridge({ tabs, scripting }) {
  let injected = 0;
  try {
    for (const tab of await tabs.query({ url: `${WEB_ORIGIN}${WEB_PATH}*` })) {
      try {
        const [probe] = (await scripting.executeScript({ target: { tabId: tab.id }, func: bridgeAlive })) ?? [];
        if (probe?.result === true) continue;
        await scripting.executeScript({ target: { tabId: tab.id }, files: ["bridge.js"] });
        injected += 1;
      } catch { /* this tab refuses (discarded or closed): the rest still get theirs */ }
    }
  } catch { /* no access to tabs: pages opened later get the content script anyway */ }
  return injected;
}
