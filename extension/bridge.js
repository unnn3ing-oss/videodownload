// Content script for the web version: relays messages between the page and the extension's background
// script. The page asks with window.postMessage({ source: "ytdl-web", id, request }); the answer comes back
// as { source: "ytdl-ext", id, response }, and the background script pushes state as { source: "ytdl-ext", push }.
// Which requests are allowed is decided by the background script, not here.
(() => {
  const previous = window.__ytdlBridge;
  if (previous) {
    if (previous.alive()) return; // already installed and working
    previous.dispose();
  }
  const FROM_PAGE = "ytdl-web";
  const TO_PAGE = "ytdl-ext";
  const alive = () => {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false; // the extension was reloaded: this copy of the script is orphaned
    }
  };
  const post = (payload) => window.postMessage({ source: TO_PAGE, ...payload }, location.origin);
  let port = null;

  function connect() {
    if (!alive() || port) return;
    try {
      port = chrome.runtime.connect({ name: "web" });
      port.onMessage.addListener((push) => post({ push }));
      port.onDisconnect.addListener(() => { port = null; });
    } catch {
      port = null;
    }
  }

  function hello() {
    if (alive()) post({ hello: { version: chrome.runtime.getManifest().version } });
  }

  async function onMessage(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== FROM_PAGE) return;
    if (data.ping) {
      connect();
      hello();
      return;
    }
    if (data.id === undefined || !data.request || !alive()) return;
    try {
      post({ id: data.id, response: await chrome.runtime.sendMessage(data.request) });
    } catch {
      post({ id: data.id, response: { ok: false, error: "extension_unavailable" } });
    }
  }

  window.addEventListener("message", onMessage);
  window.__ytdlBridge = {
    alive,
    dispose() {
      window.removeEventListener("message", onMessage);
      try { port?.disconnect(); } catch { /* already gone */ }
    },
  };
  connect();
  hello();
})();
