import { classifyTabUrl } from "./lib/page.js";
import { installerPendingText } from "./lib/installer.js";
import { runDoctor } from "./lib/doctor-view.js";
import { macInstallCommand } from "./lib/setup-flow.js";
import { hostVersionNotice } from "./lib/connection.js";
import { createRequestIds } from "./lib/ids.js";
import { summarize } from "./lib/queue.js";
import { copyRowText, downloadRowCover, renderHostNote, renderQueue, startTicker } from "./lib/queue-view.js";
import { UpdateError, checkLatest, proveLoadedFolder, runUpdate } from "./lib/updater.js";
import { applyBadge, autoCheckDue, failedSummary, loadSummary, saveSummary, summarizeCheck } from "./lib/update-state.js";
import { forgetFolder, getFolder, hasSavedFolder, pickFolder } from "./lib/folder-store.js";

const $ = (id) => document.getElementById(id);

const PILL_TEXT = { not_installed: "尚未部署", stopped: "尚未啟動", running: "已啟動", forbidden: "連線被拒" };
const SETUP_HINT = {
  not_installed: "找不到本機小程式。請先完成步驟 1：下載安裝檔並執行一次。",
  stopped: "準備好了就按「啟動」。第一次使用請先完成步驟 1；按了沒反應的話，重新執行安裝檔會自動檢查並修復。",
  forbidden: "Chrome 拒絕連線（擴充功能識別碼與安裝檔不符）。請重新下載部署並再執行一次安裝檔。",
};
const KIND_TEXT = { video: "影片", playlist: "播放清單", channel: "頻道" };

let status = { state: "stopped", ready: null };
let queue = null; // the list, held by the background script
let currentTab = null; // { url, title, kind }
const nextId = createRequestIds();
const waiters = new Map();

// ---------- self-update state ----------
let updateInfo = null; // full result of the last check made in this panel session
let hostChanged = []; // host files that differ from the installed ones (known only while the host runs)
let hostChecked = false;
let updateWorking = null; // "check" | "apply" while one is in progress
let updateProgress = null; // { text, kind } of the last update attempt
let lastSummary = null; // what was stored by the last check (also by the background alarm)
let folderSaved = false;

const send = (message) => chrome.runtime.sendMessage(message);

// Request/reply with the host through the background script (used by engine and self-update commands).
function request(message, timeoutMs = 180000) {
  const reqId = nextId();
  return new Promise((resolveFn, rejectFn) => {
    const timer = setTimeout(() => {
      waiters.delete(reqId);
      rejectFn(new Error("逾時，沒有收到回應"));
    }, timeoutMs);
    waiters.set(reqId, (event) => {
      clearTimeout(timer);
      resolveFn(event);
    });
    send({ ...message, reqId }).then((ack) => {
      if (!ack?.ok) {
        clearTimeout(timer);
        waiters.delete(reqId);
        rejectFn(new Error(ack?.error === "not_running" ? "尚未啟動，請先按「啟動」" : "無法送出要求"));
      }
    }, rejectFn);
  });
}

function note(text, kind = "info") {
  const el = $("note");
  el.textContent = text ?? "";
  el.dataset.kind = kind;
  el.hidden = !text;
}

function addNote(text, kind = "info") {
  const el = $("add-note");
  el.textContent = text ?? "";
  el.dataset.kind = kind;
  el.hidden = !text;
}

// ---------- rendering ----------
function renderStatus() {
  const pill = $("status");
  pill.dataset.state = status.state;
  $("status-text").textContent = PILL_TEXT[status.state] ?? status.state;

  const running = status.state === "running";
  const info = $("engine-info");
  if (running && status.ready) {
    const r = status.ready;
    info.replaceChildren(document.createTextNode(r.ytdlpVersion ? `yt-dlp ${r.ytdlpVersion}` : "找不到下載引擎"));
    const problems = [];
    if (!r.ytdlpVersion) problems.push("請重新執行安裝檔");
    if (!r.ffmpegOk) problems.push("找不到 ffmpeg");
    if (!r.jsRuntimeOk) problems.push("找不到 JS 執行環境（Deno）");
    if (problems.length) {
      const warn = document.createElement("span");
      warn.className = "warn";
      warn.textContent = ` · ${problems.join("、")}`;
      info.append(warn);
    }
  } else {
    info.textContent = "本機下載引擎未連線";
  }

  $("setup").hidden = running;
  if (!running) {
    let hint = SETUP_HINT[status.state] ?? "";
    if (status.state === "stopped" && status.detail) hint += `（上次連線中斷：${status.detail}）`;
    $("setup-hint").textContent = hint;
    $("deploy").classList.toggle("is-next", status.state !== "stopped");
    $("start").classList.toggle("is-next", status.state === "stopped");
  }
}

function renderQueueView() {
  if (!queue) return;
  const info = summarize(queue);
  const now = Date.now();
  renderQueue($("queue-list"), queue, now, {
    remove: (uid) => send({ type: "queue_remove", uid }),
    retry: (uid) => send({ type: "queue_retry", uid }),
    copy: (uid, button) => copyRowText(send, uid, button),
    cover: (uid, button) => downloadRowCover(send, uid, button),
  });
  $("queue-empty").hidden = queue.items.length > 0;
  $("queue-stats").textContent = queue.items.length ? `共 ${info.total} 支 · 完成 ${info.done}` : "";
  const cooling = queue.cooldown && queue.cooldown.until > now;
  $("cooldown-chip").hidden = !cooling;
  if (cooling) $("cooldown-chip").textContent = `${Math.ceil((queue.cooldown.until - now) / 1000)} 秒後開始下一支`;

  const button = $("start-all");
  const connected = status.state === "running";
  button.className = `btn block ${queue.running ? "danger" : "primary"}`;
  button.textContent = queue.running ? "停止" : info.total && info.waiting === 0 && info.done > 0 ? "全部完成" : "開始全部下載";
  button.disabled = !queue.running && (!connected || queue.hostOutdated || info.waiting === 0);
  renderHostNote($("host-note"), queue);

  $("quality").querySelectorAll("input").forEach((radio) => { radio.checked = Number(radio.value) === queue.settings.quality; });
  if (document.activeElement !== $("cooldown")) $("cooldown").value = String(queue.settings.cooldownSec);
  if (document.activeElement !== $("limit")) $("limit").value = String(queue.settings.limit);
  $("auto-cover").checked = queue.settings.autoCover !== false;
}

function renderControls() {
  const running = status.state === "running";
  $("update").disabled = !running || Boolean(queue?.running);
  $("save-outdir").disabled = !running;
  $("doctor-check").disabled = !running;
  $("outdir").disabled = !running;
  if (running && status.ready?.outputDir && document.activeElement !== $("outdir")) {
    $("outdir").value = status.ready.outputDir;
  }
}

function renderTabCard() {
  const card = $("tab-card");
  card.hidden = !currentTab;
  if (!currentTab) return;
  $("tab-kind").textContent = KIND_TEXT[currentTab.kind];
  $("tab-title").textContent = currentTab.title;
}

function hasUpdate() {
  return Boolean(updateInfo) && (updateInfo.extChanged.length > 0 || hostChanged.length > 0);
}

function updateReason() {
  if (!hasUpdate()) return null;
  if (status.state !== "running") return "請先按「啟動」才能更新本機小程式";
  if (queue?.running) return "下載進行中，完成後再更新";
  return null;
}

function renderUpdate() {
  const manifest = chrome.runtime.getManifest();
  const hostVersion = status.state === "running" ? status.ready?.hostVersion : null;
  $("ver-current").textContent = `擴充功能 ${manifest.version}${hostVersion ? ` · 本機小程式 ${hostVersion}` : ""}`;

  const latest = $("ver-latest");
  const noteEl = $("update-note");
  let note = null;
  if (updateWorking === "check") {
    latest.textContent = "檢查中…";
  } else if (lastSummary?.sha) {
    latest.textContent = [lastSummary.message, lastSummary.sha.slice(0, 7), lastSummary.date?.slice(0, 10)].filter(Boolean).join(" · ");
  } else {
    latest.textContent = lastSummary?.error ? "檢查失敗" : "尚未檢查";
  }
  if (updateWorking !== "check") {
    if (lastSummary?.error) note = { text: lastSummary.error, kind: "error" };
    else if (lastSummary?.sha && !(hasUpdate() || (!updateInfo && lastSummary.hasUpdate))) note = { text: "已是最新版", kind: "ok" };
  }
  // never "up to date" while the local program and the extension are different versions
  const mismatch = hostVersionNotice({ extensionVersion: manifest.version, hostVersion });
  if (mismatch && updateWorking !== "check" && note?.kind !== "error") note = { text: mismatch, kind: "error" };
  noteEl.hidden = !note;
  noteEl.textContent = note?.text ?? "";
  noteEl.dataset.kind = note?.kind ?? "info";

  $("update-badge").hidden = !(updateInfo ? hasUpdate() : lastSummary?.hasUpdate);
  $("update-check").disabled = updateWorking !== null;

  const reason = updateReason();
  const apply = $("update-apply");
  apply.disabled = updateWorking !== null || !hasUpdate() || reason !== null;
  apply.textContent = updateWorking === "apply" ? "更新中…"
    : updateInfo?.extChanged.length > 0 && !folderSaved ? "選擇擴充功能資料夾並更新" : "更新到最新版";

  const shown = updateWorking === "apply" ? updateProgress : (reason ? { text: reason, kind: "info" } : updateProgress);
  const progressEl = $("update-progress");
  progressEl.hidden = !shown;
  progressEl.textContent = shown?.text ?? "";
  progressEl.dataset.kind = shown?.kind ?? "info";
}

function render() {
  renderStatus();
  renderQueueView();
  renderControls();
  renderTabCard();
  renderUpdate();
}

// ---------- adding videos ----------
async function addFromBox() {
  const urls = $("add-url").value.split(/\s+/).filter(Boolean);
  if (!urls.length) return;
  let first = null;
  let added = 0;
  for (const url of urls) {
    const result = await send({ type: "queue_add", url });
    if (result?.ok) added += 1;
    else first ??= result?.error ?? "無法加入";
  }
  addNote(first ? `${first}${urls.length > 1 ? `（已加入 ${added} 筆）` : ""}` : "", "error");
  if (added) $("add-url").value = "";
}

async function deploy() {
  const result = await send({ type: "deploy_installer" });
  if (!result?.ok) {
    note(result?.error ?? "無法下載安裝檔", "error");
    return;
  }
  if (result.pending) {
    note(installerPendingText(result.name), "info");
    return;
  }
  note(result.os === "mac"
    ? `已下載「${result.name}」。請解壓縮後，對 install-mac.command 按右鍵選「打開」執行一次（macOS 15 以上若被擋，請到「系統設定 → 隱私權與安全性」按「強制打開」，或在終端機執行 bash 加上這個檔案），完成後回來按「啟動」。`
    : `已下載「${result.name}」。請到下載資料夾雙擊執行一次（若出現 SmartScreen，請按「其他資訊」→「仍要執行」），完成後回來按「啟動」。`, "ok");
}

async function simpleRequest(message, onOk) {
  try {
    const event = await request(message);
    if (event.type === "error") note(event.message, "error");
    else onOk(event);
  } catch (error) {
    note(error.message, "error");
  }
}

// ---------- self-update ----------
async function refreshHostChanged() {
  hostChanged = [];
  hostChecked = false;
  if (!updateInfo || status.state !== "running") return;
  try {
    const event = await request({ type: "update_check", files: updateInfo.hostFiles }, 20000);
    if (event.type === "update_status") {
      const changed = new Set(event.changed);
      hostChanged = updateInfo.hostFiles.filter((file) => changed.has(file.path));
      hostChecked = true;
    }
  } catch { /* host unreachable right now: the extension's own files can still be compared */ }
}

async function storeSummary() {
  lastSummary = { ...summarizeCheck(updateInfo), hasUpdate: hasUpdate() };
  await saveSummary(lastSummary).catch(() => {});
  await applyBadge(lastSummary.hasUpdate).catch(() => {});
}

async function runCheck() {
  if (updateWorking) return;
  updateWorking = "check";
  updateProgress = null;
  render();
  try {
    updateInfo = await checkLatest();
    await refreshHostChanged();
    await storeSummary();
  } catch (error) {
    lastSummary = failedSummary(lastSummary, error.message);
    await saveSummary(lastSummary).catch(() => {});
  } finally {
    updateWorking = null;
    folderSaved = await hasSavedFolder();
    render();
  }
}

// Called when the host is (or becomes) available: finish what a check without the host could not know.
async function onHostRunning() {
  if (updateWorking) return;
  if (!updateInfo) {
    if (autoCheckDue(lastSummary)) runCheck();
  } else if (!hostChecked) {
    updateWorking = "check";
    render();
    await refreshHostChanged();
    await storeSummary();
    updateWorking = null;
    render();
  }
}

async function hostUpdateRequest(message) {
  const event = await request(message);
  if (event.type === "error") throw new UpdateError(event.message);
  return event;
}

const PROGRESS_TEXT = {
  download: ({ done, total }) => `下載更新檔案 ${done} / ${total}`,
  host: () => "更新本機小程式…",
  write: ({ done, total }) => `寫入擴充功能檔案 ${done} / ${total}`,
};

async function applyUpdate() {
  if (updateWorking || !hasUpdate() || updateReason()) return;
  const { name, key } = chrome.runtime.getManifest();
  updateWorking = "apply";
  updateProgress = { text: "準備更新…", kind: "info" };
  render();
  try {
    await runUpdate({
      info: updateInfo,
      hostChanged,
      getFolder: () => getFolder(name),
      pickFolder: () => pickFolder(name),
      proveFolder: proveLoadedFolder,
      forgetFolder,
      hostApi: {
        stage: (commit, files, contents) => hostUpdateRequest({ type: "update_stage", commit, files, contents }),
        commit: () => hostUpdateRequest({ type: "update_commit" }),
        rollback: () => hostUpdateRequest({ type: "update_rollback" }),
      },
      reload: () => {
        updateProgress = { text: "更新完成，正在重新載入擴充功能…", kind: "ok" };
        render();
        chrome.runtime.reload();
      },
      currentKey: key,
      expectedName: name,
      onProgress: (p) => {
        updateProgress = { text: PROGRESS_TEXT[p.step]?.(p) ?? "更新中…", kind: "info" };
        renderUpdate();
      },
    });
  } catch (error) {
    updateProgress = { text: error.message, kind: "error" };
    note(error.message, "error");
  } finally {
    updateWorking = null;
    folderSaved = await hasSavedFolder();
    render();
  }
}

// ---------- current tab ----------
async function refreshCurrentTab() {
  let tab = null;
  try {
    const win = await chrome.windows.getCurrent();
    [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  } catch { /* no access to the tab: nothing to offer */ }
  const kind = classifyTabUrl(tab?.url);
  currentTab = kind ? { url: tab.url, kind, title: (tab.title || tab.url).replace(/ - YouTube$/, "") } : null;
  renderTabCard();
}

// ---------- wiring ----------
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "status") {
    status = { ...status, ...msg };
    render();
    if (status.state === "running") onHostRunning();
  } else if (msg.type === "queue_state") {
    queue = msg.state;
    render();
  } else if (msg.type === "host_event") {
    const event = msg.event;
    if (event.reqId !== undefined && waiters.has(event.reqId)) {
      waiters.get(event.reqId)(event);
      waiters.delete(event.reqId);
    }
  }
});

$("deploy").addEventListener("click", deploy);
$("redeploy").addEventListener("click", deploy);
$("start").addEventListener("click", async () => {
  note("");
  await send({ type: "start" });
});
$("add-btn").addEventListener("click", addFromBox);
$("add-url").addEventListener("keydown", (event) => { if (event.key === "Enter") addFromBox(); });
$("add-url").addEventListener("input", () => addNote(""));
$("tab-add").addEventListener("click", async () => {
  const result = await send({ type: "queue_add", url: currentTab?.url });
  addNote(result?.ok ? "" : result?.error ?? "無法加入", "error");
});
$("start-all").addEventListener("click", async () => {
  const result = await send({ type: queue?.running ? "queue_stop" : "queue_start" });
  note(result?.ok === false ? result.error : "", "error");
});
$("quality").addEventListener("change", (event) => {
  send({ type: "settings_set", settings: { quality: Number(event.target.value) } });
});
$("auto-cover").addEventListener("change", () => {
  send({ type: "settings_set", settings: { autoCover: $("auto-cover").checked } });
});
for (const [id, key] of [["cooldown", "cooldownSec"], ["limit", "limit"]]) {
  $(id).addEventListener("change", () => send({ type: "settings_set", settings: { [key]: Number($(id).value) } }));
}
const doctorUi = () => ({ check: $("doctor-check"), fix: $("doctor-fix"), list: $("doctor-list"), summary: $("doctor-summary"), fixed: $("doctor-fixed") });
$("doctor-check").addEventListener("click", () => runDoctor(send, doctorUi(), false));
$("doctor-fix").addEventListener("click", () => runDoctor(send, doctorUi(), true));
$("save-outdir").addEventListener("click", async () => {
  const result = await send({ type: "set_output_dir", path: $("outdir").value });
  note(result?.ok ? `已改為：${result.outputDir}` : result?.error ?? "無法使用這個資料夾", result?.ok ? "ok" : "error");
});
// Mac: the installer can also be run from one line in Terminal (no download, so macOS's security prompts stay out of it)
chrome.runtime.getPlatformInfo().then((info) => { $("mac-line").hidden = info.os !== "mac"; }, () => {});
$("copy-mac").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(macInstallCommand());
    note("已複製。打開「終端機」貼上，再按 Enter。", "ok");
  } catch {
    note(`無法自動複製，請自己輸入：${macInstallCommand()}`, "error");
  }
});
$("update").addEventListener("click", () => {
  note("更新中…");
  simpleRequest({ type: "update_engine" }, (e) => note(`下載引擎已更新（${e.ytdlpVersion ?? "未知版本"}）`, "ok"));
});

$("update-check").addEventListener("click", runCheck);
$("update-apply").addEventListener("click", applyUpdate);
$("update-badge").addEventListener("click", () => {
  $("settings").open = true;
  $("update-title").scrollIntoView({ behavior: "smooth", block: "center" });
});

for (const event of [chrome.tabs.onActivated, chrome.windows.onFocusChanged]) event.addListener(refreshCurrentTab);
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (tab.active && (change.url || change.title || change.status === "complete")) refreshCurrentTab();
});

async function init() {
  status = { ...status, ...(await send({ type: "get_status" })) };
  queue = (await send({ type: "queue_get" }))?.state ?? null;
  lastSummary = await loadSummary().catch(() => null);
  folderSaved = await hasSavedFolder();
  await refreshCurrentTab();
  render();
  startTicker(() => { if (queue?.cooldown) renderQueueView(); });
  if (status.state === "stopped") send({ type: "start" }); // connect on open; the button stays as a fallback
  if (status.state === "running") onHostRunning();
}

init();
