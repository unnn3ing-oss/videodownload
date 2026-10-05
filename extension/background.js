// Owns the Native Messaging connection and the download list, so downloads keep running whether or not the
// side panel or the web page is open. Both are only views of the list held here.
import { HOST_NAME } from "./lib/constants.js";
import { classifyConnectError, installerFor } from "./lib/platform.js";
import { checkLatest } from "./lib/updater.js";
import { applyBadge, failedSummary, loadSummary, saveSummary, summarizeCheck } from "./lib/update-state.js";
import { createController } from "./lib/queue-controller.js";
import { classifySender, isAllowed } from "./lib/messages.js";
import { injectBridge } from "./lib/inject.js";

let port = null;
let status = { state: "stopped", ready: null, detail: null };
const webPorts = new Set(); // long-lived connections from the web page's content script

// Panel commands that are answered by the host: the answer is broadcast as a host_event carrying the panel's reqId.
const FORWARD = {
  update_engine: (m) => ({ type: "update_engine", reqId: m.reqId }),
  update_check: (m) => ({ type: "update_check", reqId: m.reqId, files: m.files }),
  update_stage: (m) => ({ type: "update_stage", reqId: m.reqId, commit: m.commit, files: m.files, contents: m.contents }),
  update_commit: (m) => ({ type: "update_commit", reqId: m.reqId }),
  update_rollback: (m) => ({ type: "update_rollback", reqId: m.reqId }),
};

function snapshot() {
  return { type: "status", ...status };
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {}); // nobody listening: panel closed
  if (message.type === "status") postToWeb(message);
}

function postToWeb(message) {
  for (const webPort of webPorts) {
    try {
      webPort.postMessage(message);
    } catch {
      webPorts.delete(webPort);
    }
  }
}

function setStatus(next) {
  status = next;
  broadcast(snapshot());
}

// ---- requests the controller makes to the host (reqId prefix "bg:" keeps them apart from the panel's) ----
const waiting = new Map();
let requestSeq = 0;

const host = {
  connected: () => Boolean(port) && status.state === "running",
  version: () => status.ready?.hostVersion ?? null,
  send(message) {
    if (!port) throw new Error("尚未連線本機小程式");
    port.postMessage(message);
  },
  request(message, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!port) {
        reject(new Error("尚未連線本機小程式"));
        return;
      }
      const reqId = `bg:${++requestSeq}`;
      const timer = setTimeout(() => {
        waiting.delete(reqId);
        reject(new Error("逾時，沒有收到回應"));
      }, timeoutMs);
      waiting.set(reqId, { resolve, reject, timer });
      port.postMessage({ ...message, reqId });
    });
  },
};

function failWaiting(error) {
  for (const { reject, timer } of waiting.values()) {
    clearTimeout(timer);
    reject(error);
  }
  waiting.clear();
}

// ---- the queue: restored from storage, saved at most every 500 ms, pushed to the views at most every 200 ms ----
let saveTimer = null;
let latestQueue = null;
function saveQueue(state) {
  latestQueue = state;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    chrome.storage.local.set({ queue: latestQueue }).catch(() => {});
  }, 500);
}

let pushTimer = null;
let lastPush = 0;
function pushQueue() {
  const wait = 200 - (Date.now() - lastPush);
  if (wait > 0) {
    pushTimer ??= setTimeout(() => { pushTimer = null; pushQueue(); }, wait);
    return;
  }
  lastPush = Date.now();
  controllerReady.then((controller) => {
    const message = { type: "queue_state", state: controller.getState() };
    chrome.runtime.sendMessage(message).catch(() => {});
    postToWeb(message);
  });
}

const controllerReady = chrome.storage.local.get("queue").catch(() => ({})).then(({ queue }) => createController({
  host,
  save: saveQueue,
  notify: pushQueue,
  fetchFn: (url, options) => fetch(url, options),
  downloads: chrome.downloads,
  initial: queue ?? null,
}));

function onHostMessage(msg) {
  if (msg.type === "ready") {
    setStatus({ state: "running", ready: msg, detail: null });
    controllerReady.then((controller) => controller.onHostConnected(msg));
    return;
  }
  const waiter = typeof msg.reqId === "string" && msg.reqId.startsWith("bg:") ? waiting.get(msg.reqId) : null;
  controllerReady.then((controller) => controller.onHostEvent(msg));
  if (waiter) {
    clearTimeout(waiter.timer);
    waiting.delete(msg.reqId);
    waiter.resolve(msg);
    return;
  }
  broadcast({ type: "host_event", event: msg });
}

function connect() {
  if (port) return;
  const p = chrome.runtime.connectNative(HOST_NAME);
  port = p;
  p.onMessage.addListener(onHostMessage);
  p.onDisconnect.addListener(() => {
    const message = chrome.runtime.lastError?.message;
    const kind = classifyConnectError(message);
    port = null;
    failWaiting(new Error("與本機小程式的連線中斷"));
    controllerReady.then((controller) => controller.onHostDisconnected());
    const state = kind === "not_installed" ? "not_installed" : kind === "forbidden" ? "forbidden" : "stopped";
    setStatus({ state, ready: null, detail: message ?? null });
  });
}

async function deployInstaller() {
  const info = await chrome.runtime.getPlatformInfo();
  const installer = installerFor(info.os);
  if (!installer) return { ok: false, error: "目前只支援 Windows 與 Mac" };
  const name = installer.file.split("/").pop();
  try {
    await chrome.downloads.download({ url: chrome.runtime.getURL(installer.file), filename: name });
    return { ok: true, os: info.os, name };
  } catch (error) {
    return { ok: false, error: `無法下載安裝檔：${error.message}` };
  }
}

async function setOutputDir(path) {
  if (!host.connected()) return { ok: false, error: "請先連線本機小程式" };
  try {
    const event = await host.request({ type: "set_config", outputDir: path });
    if (event.type !== "config") return { ok: false, error: event.message ?? "無法使用這個資料夾" };
    status = { ...status, ready: { ...status.ready, outputDir: event.outputDir } };
    broadcast(snapshot());
    return { ok: true, outputDir: event.outputDir };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function handle(msg) {
  const controller = await controllerReady;
  switch (msg.type) {
    case "ping": return { ok: true, pong: true };
    case "get_status": return snapshot();
    case "start": connect(); return { ok: true };
    case "queue_get": return { ok: true, state: controller.getState() };
    case "queue_add": return controller.add(msg.url);
    case "queue_remove": controller.remove(msg.uid); return { ok: true };
    case "queue_retry": controller.retry(msg.uid); return { ok: true };
    case "queue_start": return controller.start();
    case "queue_stop": controller.stop(); return { ok: true };
    case "queue_copy_text": return controller.copyText(msg.uid);
    case "queue_download_cover": return controller.downloadCover(msg.uid);
    case "settings_set": controller.setSettings(msg.settings); return { ok: true };
    case "deploy_installer": return deployInstaller();
    default: break;
  }
  if (msg.type === "set_output_dir") return setOutputDir(msg.path);
  const build = FORWARD[msg.type];
  if (!build) return { ok: false, error: "unknown" };
  if (!port) return { ok: false, error: "not_running" };
  port.postMessage(build(msg));
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isAllowed(classifySender(sender, chrome.runtime.id), msg?.type)) {
    sendResponse({ ok: false, error: "forbidden" });
    return false;
  }
  handle(msg).then(sendResponse, (error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

// The web page's content script keeps a connection open to receive state pushes.
chrome.runtime.onConnect.addListener((connection) => {
  if (connection.name !== "web" || classifySender(connection.sender, chrome.runtime.id) !== "web") {
    connection.disconnect();
    return;
  }
  webPorts.add(connection);
  connection.onDisconnect.addListener(() => webPorts.delete(connection));
  connection.postMessage(snapshot());
  controllerReady.then((controller) => connection.postMessage({ type: "queue_state", state: controller.getState() }));
});

// After an install, reload or update, give web pages that are already open a working bridge.
chrome.runtime.onInstalled.addListener(() => { injectBridge(chrome); });

// Clicking the toolbar icon opens the side panel (there is no popup).
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Look for a new release every 6 hours; a failed check keeps the previous badge.
const UPDATE_ALARM = "check-update";

async function backgroundCheck() {
  try {
    const info = await checkLatest();
    await saveSummary(summarizeCheck(info));
    await applyBadge(info.hasUpdate);
  } catch (error) {
    await saveSummary(failedSummary(await loadSummary().catch(() => null), error.message));
  }
}

async function ensureUpdateAlarm() {
  if (!(await chrome.alarms.get(UPDATE_ALARM))) {
    await chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: 360 });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) backgroundCheck();
});
ensureUpdateAlarm().catch(() => {});
