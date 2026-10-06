// The web page's side of the bridge to the extension (see extension/bridge.js): ask with postMessage, get
// answers and state pushes back. The extension may be missing, installed later, or reloaded at any time, so the
// page pings until it hears back and treats long silence as "gone".
const TO_EXTENSION = "ytdl-web";
const FROM_EXTENSION = "ytdl-ext";

export function createBridgeClient({ pingEveryMs = 2000, lostAfterMs = 6000 } = {}) {
  let detected = false;
  let lastSeen = 0;
  let nextId = 1;
  const pending = new Map();
  let version = null; // the extension's version, from its hello
  const listeners = { change: [], state: [], status: [], version: [] };
  const emit = (kind, value) => listeners[kind].forEach((callback) => callback(value));

  function setDetected(value) {
    if (detected === value) return;
    detected = value;
    if (!value) {
      version = null;
      for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error("與擴充功能的連線中斷")); }
      pending.clear();
    }
    emit("change", value);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== FROM_EXTENSION) return;
    lastSeen = Date.now();
    if (data.hello) {
      const next = data.hello.version ?? null;
      if (next !== version) {
        version = next;
        emit("version", next);
      }
      setDetected(true);
    }
    if (data.push?.type === "queue_state") emit("state", data.push.state);
    if (data.push?.type === "status") emit("status", data.push);
    if (data.id !== undefined && pending.has(data.id)) {
      const { resolve, timer } = pending.get(data.id);
      clearTimeout(timer);
      pending.delete(data.id);
      resolve(data.response);
    }
  });

  let lastPingAt = Date.now();
  function ping() {
    const now = Date.now();
    // A hidden tab or a sleeping computer slows or stops the page's timers. After such a pause the extension has not
    // had a chance to answer yet, so silence only counts from this moment on (otherwise it flips to "lost" and back).
    if (now - lastPingAt > lostAfterMs) lastSeen = now;
    lastPingAt = now;
    window.postMessage({ source: TO_EXTENSION, ping: true }, location.origin);
    if (detected && now - lastSeen > lostAfterMs) setDetected(false);
  }
  setInterval(ping, pingEveryMs);
  ping();

  return {
    detected: () => detected,
    version: () => version,
    onVersion: (callback) => listeners.version.push(callback),
    onChange: (callback) => listeners.change.push(callback),
    onState: (callback) => listeners.state.push(callback),
    onStatus: (callback) => listeners.status.push(callback),
    request(message, timeoutMs = 20000) {
      if (!detected) return Promise.reject(new Error("尚未偵測到擴充功能"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("逾時，沒有收到回應")); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        window.postMessage({ source: TO_EXTENSION, id, request: message }, location.origin);
      });
    },
  };
}
