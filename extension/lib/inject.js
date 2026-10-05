// After an install, reload or update, web pages that were already open have no working bridge to the extension
// (Chrome only injects content scripts into pages loaded afterwards). Give them one.
import { WEB_ORIGIN, WEB_PATH } from "./constants.js";

// deps: { tabs, scripting } (chrome.tabs and chrome.scripting). Returns how many tabs were given the bridge.
export async function injectBridge({ tabs, scripting }) {
  let injected = 0;
  try {
    for (const tab of await tabs.query({ url: `${WEB_ORIGIN}${WEB_PATH}*` })) {
      try {
        await scripting.executeScript({ target: { tabId: tab.id }, files: ["bridge.js"] });
        injected += 1;
      } catch { /* this tab refuses (discarded or closed): the rest still get theirs */ }
    }
  } catch { /* no access to tabs: pages opened later get the content script anyway */ }
  return injected;
}
