// Owns the Native Messaging connection so downloads keep running whether or not the side panel is open.
import { HOST_NAME } from "./lib/constants.js";
import { classifyConnectError } from "./lib/platform.js";
import { applyEvent, emptyProgress } from "./lib/events.js";
import { seedProgress } from "./lib/progress.js";
import { checkLatest } from "./lib/updater.js";
import { applyBadge, failedSummary, loadSummary, saveSummary, summarizeCheck } from "./lib/update-state.js";

let port = null;
let status = { state: "stopped", ready: null, detail: null };
let progress = emptyProgress();
let busy = false;

// side panel message -> host request
const FORWARD = {
  resolve: (m) => ({ type: "resolve", reqId: m.reqId, urls: m.urls, limit: m.limit }),
  download: (m) => ({ type: "download", reqId: m.reqId, items: m.items, quality: m.quality,
                      titleOverride: m.titleOverride }),
  cancel: (m) => ({ type: "cancel", reqId: m.reqId }),
  set_output_dir: (m) => ({ type: "set_config", reqId: m.reqId, outputDir: m.path }),
  update_engine: (m) => ({ type: "update_engine", reqId: m.reqId }),
  update_check: (m) => ({ type: "update_check", reqId: m.reqId, files: m.files }),
  update_stage: (m) => ({ type: "update_stage", reqId: m.reqId, commit: m.commit, files: m.files }),
  update_commit: (m) => ({ type: "update_commit", reqId: m.reqId }),
  update_rollback: (m) => ({ type: "update_rollback", reqId: m.reqId }),
};

function snapshot() {
  return { type: "status", ...status, progress, busy };
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {}); // side panel closed: nobody listens
}

function setStatus(next) {
  status = next;
  broadcast(snapshot());
}

function onHostMessage(msg) {
  if (msg.type === "ready") {
    setStatus({ state: "running", ready: msg, detail: null });
    return;
  }
  if (msg.type === "started") busy = true;
  if (msg.type === "done") busy = false;
  if (["progress", "item_done", "item_failed", "done"].includes(msg.type)) {
    progress = applyEvent(progress, msg);
  }
  if (msg.type === "config" && status.ready) {
    status = { ...status, ready: { ...status.ready, outputDir: msg.outputDir } };
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
    busy = false;
    const state = kind === "not_installed" ? "not_installed" : kind === "forbidden" ? "forbidden" : "stopped";
    setStatus({ state, ready: null, detail: message ?? null });
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "get_status") {
    sendResponse(snapshot());
  } else if (msg.type === "start") {
    connect();
    sendResponse({ ok: true });
  } else if (FORWARD[msg.type]) {
    if (!port) {
      sendResponse({ ok: false, error: "not_running" });
    } else {
      if (msg.type === "download") {
        progress = seedProgress(msg.items);
      }
      port.postMessage(FORWARD[msg.type](msg));
      sendResponse({ ok: true });
    }
  }
  return false;
});

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
