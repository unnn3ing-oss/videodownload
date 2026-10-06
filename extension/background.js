// Owns the Native Messaging connection and the download list, so downloads keep running whether or not the
// side panel or the web page is open. Both are only views of the list held here.
import { HOST_NAME } from "./lib/constants.js";
import { classifyConnectError } from "./lib/platform.js";
import { downloadInstaller } from "./lib/installer.js";
import { checkLatest } from "./lib/updater.js";
import { applyUpdate, collectUpdateInfo } from "./lib/update-pipeline.js";
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

const deployInstaller = () => downloadInstaller({ runtime: chrome.runtime, downloads: chrome.downloads });

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

// "Check the environment": the host looks at what is installed and what runs; with fix it first repairs what is safe to repair.
async function runDoctor(msg) {
  if (!host.connected()) return { ok: false, error: "尚未連線本機小程式。連不上的時候，重新執行安裝檔就會自動檢查並修復。" };
  try {
    const event = await host.request({ type: "doctor", extensionId: chrome.runtime.id, fix: msg.fix === true }, 120000);
    if (event.type !== "doctor") return { ok: false, error: event.message ?? "檢查失敗" };
    return { ok: true, checks: event.checks, fixed: event.fixed };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// ---- "check for updates" and "update to the latest", for the web page and the side panel ----
let updating = false;

const hostRequestIfConnected = () => (host.connected() ? (message, timeout) => host.request(message, timeout) : null);

async function currentUpdateInfo() {
  const { version, key } = chrome.runtime.getManifest();
  return collectUpdateInfo({ hostRequest: hostRequestIfConnected(), version, key });
}

async function checkForUpdate() {
  try {
    const info = await currentUpdateInfo();
    await saveSummary(summarizeCheck(info)).catch(() => {});
    await applyBadge(info.hasUpdate).catch(() => {});
    return {
      ok: true,
      info: {
        current: info.current, latestVersion: info.latestVersion, sha: info.sha, date: info.date, message: info.message,
        extCount: info.extChanged.length, hostCount: info.hostChanged.length, hostChecked: info.hostChecked,
        canUpdateHere: info.extChanged.length === 0 || Boolean(info.extensionFolder), hasUpdate: info.hasUpdate,
      },
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function runUpdateNow(msg) {
  if (updating) return { ok: false, error: "正在更新中" };
  if (!host.connected()) return { ok: false, error: "請先讓本機小程式連線（按「啟動」），再更新" };
  updating = true;
  const progress = (p) => { const m = { type: "update_progress", ...p }; chrome.runtime.sendMessage(m).catch(() => {}); postToWeb(m); };
  try {
    const info = await currentUpdateInfo();
    if (typeof msg.sha === "string" && msg.sha !== info.sha) return { ok: false, error: "GitHub 上又有更新的版本了，請再按一次「檢查更新」" };
    if (!info.hasUpdate) return { ok: true, nothing: true };
    const result = await applyUpdate({ info, hostRequest: (message, timeout) => host.request(message, timeout), key: info.key, onProgress: progress });
    setTimeout(() => chrome.runtime.reload(), 800); // (after the answer below has gone out; it also restarts the host on its new files)
    return { ok: true, ...result, latestVersion: info.latestVersion, reloading: true };
  } catch (error) {
    return { ok: false, error: error.message, code: error.code ?? null };
  } finally {
    updating = false;
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
    case "doctor": return runDoctor(msg);
    case "update_info": return checkForUpdate();
    case "update_apply": return runUpdateNow(msg);
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
