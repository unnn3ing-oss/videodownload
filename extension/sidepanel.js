import { parseUrlLines } from "./lib/urls.js";
import { installerFor } from "./lib/platform.js";
import { applyEvent, emptyProgress } from "./lib/events.js";
import { createRequestIds } from "./lib/ids.js";
import { itemMeta } from "./lib/format.js";
import { classifyTabUrl } from "./lib/page.js";
import { overallProgress, previewItems, seedProgress } from "./lib/progress.js";
import { UpdateError, checkLatest, runUpdate, shouldCheck } from "./lib/updater.js";
import { applyBadge, loadSummary, saveSummary, summarizeCheck } from "./lib/update-state.js";
import { getFolder, hasSavedFolder, pickFolder } from "./lib/folder-store.js";

const $ = (id) => document.getElementById(id);

const PILL_TEXT = { not_installed: "尚未部署", stopped: "尚未啟動", running: "已啟動", forbidden: "連線被拒" };
const SETUP_HINT = {
  not_installed: "找不到本機小程式。請先完成步驟 1：下載安裝檔並執行一次。",
  stopped: "準備好了就按「啟動」。第一次使用請先完成步驟 1。",
  forbidden: "Chrome 拒絕連線（擴充功能識別碼與安裝檔不符）。請重新下載部署並再執行一次安裝檔。",
};
const KIND_TEXT = { video: "影片", playlist: "播放清單", channel: "頻道" };

let status = { state: "stopped", ready: null, progress: emptyProgress(), busy: false };
let resolved = null; // { key, items }
let runKey = null; // key of the resolve that the last download used
let filenameDirty = false;
let currentTab = null; // { url, title, kind }
let pendingItems = []; // items of the download being started, to seed titled rows
const nextId = createRequestIds();
const waiters = new Map();
let resolveTimer = null;

// ---------- self-update state ----------
let updateInfo = null; // full result of the last check made in this panel session
let hostChanged = []; // host files that differ from the installed ones (known only while the host runs)
let hostChecked = false;
let updateWorking = null; // "check" | "apply" while one is in progress
let updateProgress = null; // { text, kind } of the last update attempt
let lastSummary = null; // what was stored by the last check (also by the background alarm)
let folderSaved = false;

const send = (message) => chrome.runtime.sendMessage(message);

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

function selectedQuality() {
  return Number(document.querySelector('input[name="quality"]:checked')?.value ?? 1080);
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

function viewRows() {
  const progressRows = status.progress.items;
  const hasProgress = Object.keys(progressRows).length > 0;
  const stale = !status.busy && resolved && resolved.key !== runKey;
  if (hasProgress && !stale) return { rows: progressRows, mode: "run" };
  if (resolved) return { rows: previewItems(resolved.items), mode: "preview" };
  return { rows: progressRows, mode: hasProgress ? "run" : "empty" };
}

function renderQueue() {
  const { rows, mode } = viewRows();
  const entries = Object.entries(rows);
  $("queue").hidden = entries.length === 0;
  $("queue-title").textContent = mode === "preview" ? "找到的影片" : "下載清單";
  $("queue-count").textContent = `${entries.length} 支`;

  const overall = $("overall");
  overall.hidden = mode !== "run";
  if (mode === "run") {
    const p = overallProgress(rows);
    $("overall-bar").style.width = `${p.percent}%`;
    $("overall-text").textContent = `${p.finished} / ${p.total} 完成`;
    const bar = overall.querySelector(".bar");
    bar.setAttribute("aria-valuenow", String(Math.round(p.percent)));
    bar.classList.toggle("live", status.busy);
  }

  const list = $("items");
  list.replaceChildren();
  for (const [id, item] of entries) {
    const li = document.createElement("li");
    li.className = "item";
    li.dataset.status = item.status ?? "";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = item.title || id;
    li.append(title);
    if (item.status === "downloading" || item.status === "done") {
      const bar = document.createElement("div");
      bar.className = `bar${item.status === "downloading" ? " live" : ""}`;
      bar.setAttribute("role", "progressbar");
      const fill = document.createElement("span");
      fill.style.width = `${Math.round(item.percent ?? 0)}%`;
      bar.append(fill);
      li.append(bar);
    }
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = item.unresolved ? "無法解析（下載時會標示原因）" : itemMeta(item);
    li.append(meta);
    if (item.warnNotH264) {
      const warn = document.createElement("div");
      warn.className = "warn";
      warn.textContent = "非 H.264，部分平台可能需轉檔";
      li.append(warn);
    }
    list.append(li);
  }

  const summary = $("summary");
  const s = status.progress.summary;
  summary.hidden = mode !== "run" || !s;
  if (!summary.hidden) summary.textContent = `完成 ${s.ok}、略過 ${s.skipped}、失敗 ${s.failed}${s.cancelled ? "（已取消）" : ""}`;
}

function renderControls() {
  const running = status.state === "running";
  $("download").hidden = status.busy;
  $("download").disabled = !running;
  $("cancel").hidden = !status.busy;
  $("update").disabled = !running || status.busy;
  $("save-outdir").disabled = !running;
  $("outdir").disabled = !running;
  if (running && status.ready?.outputDir && document.activeElement !== $("outdir")) {
    $("outdir").value = status.ready.outputDir;
  }
  const single = resolved?.items.length === 1 && Boolean(resolved.items[0].id);
  $("filename").disabled = !single;
  if (!single) {
    $("filename").value = "";
    filenameDirty = false;
  }
}

function renderTabCard() {
  const card = $("tab-card");
  card.hidden = !currentTab;
  if (!currentTab) return;
  $("tab-kind").textContent = KIND_TEXT[currentTab.kind];
  $("tab-title").textContent = currentTab.title;
  const added = parseUrlLines($("urls").value).urls.includes(currentTab.url);
  $("tab-add").disabled = added;
  $("tab-add").textContent = added ? "已加入" : "加入";
}

function hasUpdate() {
  return Boolean(updateInfo) && (updateInfo.extChanged.length > 0 || hostChanged.length > 0);
}

function updateReason() {
  if (!hasUpdate()) return null;
  if (status.state !== "running") return "請先按「啟動」才能更新本機小程式";
  if (status.busy) return "下載進行中，完成後再更新";
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
  } else if (lastSummary?.error) {
    latest.textContent = "檢查失敗";
    note = { text: lastSummary.error, kind: "error" };
  } else if (lastSummary?.sha) {
    latest.textContent = [lastSummary.message, lastSummary.sha.slice(0, 7), lastSummary.date?.slice(0, 10)].filter(Boolean).join(" · ");
    note = hasUpdate() || (!updateInfo && lastSummary.hasUpdate)
      ? null : { text: "已是最新版", kind: "ok" };
  } else {
    latest.textContent = "尚未檢查";
  }
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
  renderQueue();
  renderControls();
  renderTabCard();
  renderUpdate();
}

function renderInvalid(invalid) {
  const list = $("invalid");
  list.replaceChildren(...invalid.map((line) => {
    const li = document.createElement("li");
    li.textContent = `不是 YouTube 網址：${line}`;
    return li;
  }));
  list.hidden = invalid.length === 0;
}

// ---------- resolve & download ----------
function currentInput() {
  const { urls, invalid } = parseUrlLines($("urls").value);
  const limit = Number($("limit").value);
  return { urls, invalid, limit: Number.isInteger(limit) && limit > 0 ? limit : undefined };
}

async function resolveNow() {
  const { urls, invalid, limit } = currentInput();
  renderInvalid(invalid);
  if (!urls.length) {
    resolved = null;
    render();
    return null;
  }
  const key = `${urls.join("\n")}|${limit ?? ""}`;
  if (resolved?.key === key) return resolved.items;
  note("解析中…");
  let event;
  try {
    event = await request({ type: "resolve", urls, limit });
  } catch (error) {
    note(error.message, "error");
    return null;
  }
  if (event.type !== "resolved") {
    note(event.type === "error" ? event.message : "收到非預期的回應，請再試一次", "error");
    resolved = null;
    render();
    return null;
  }
  const unresolved = event.items.filter((i) => !i.id).length;
  note(unresolved ? `找到 ${event.items.length - unresolved} 支影片；另有 ${unresolved} 個網址無法解析，下載時會標示原因`
                  : `找到 ${event.items.length} 支影片`, unresolved ? "info" : "ok");
  const previous = resolved?.items.length === 1 ? resolved.items[0].id : null;
  resolved = { key, items: event.items };
  if (event.items.length === 1) {
    if (previous !== event.items[0].id) filenameDirty = false;
    if (!filenameDirty) $("filename").value = event.items[0].title;
  }
  render();
  return event.items;
}

function scheduleResolve() {
  clearTimeout(resolveTimer);
  renderInvalid(currentInput().invalid);
  renderTabCard();
  if (status.state !== "running") return;
  resolveTimer = setTimeout(() => resolveNow(), 600);
}

async function deploy() {
  const info = await chrome.runtime.getPlatformInfo();
  const installer = installerFor(info.os);
  if (!installer) {
    note("目前只支援 Windows 與 Mac", "error");
    return;
  }
  const name = installer.file.split("/").pop();
  try {
    await chrome.downloads.download({ url: chrome.runtime.getURL(installer.file), filename: name });
  } catch {
    const blob = await (await fetch(chrome.runtime.getURL(installer.file))).blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
  }
  note(info.os === "mac"
    ? `已下載「${name}」。請解壓縮後，對 install-mac.command 按右鍵選「打開」執行一次（macOS 15 以上若被擋，請到「系統設定 → 隱私權與安全性」按「強制打開」，或在終端機執行 bash 加上這個檔案），完成後回來按「啟動」。`
    : `已下載「${name}」。請到下載資料夾雙擊執行一次（若出現 SmartScreen，請按「其他資訊」→「仍要執行」），完成後回來按「啟動」。`, "ok");
}

async function startDownload() {
  const items = await resolveNow();
  if (!items?.length) {
    if (items) note("沒有可下載的影片", "error");
    return;
  }
  const typed = items.length === 1 ? $("filename").value.trim() : "";
  const titleOverride = typed && typed !== items[0].title ? typed : undefined;
  pendingItems = items;
  try {
    const event = await request({ type: "download", items, quality: selectedQuality(), titleOverride });
    if (event.type === "started") {
      runKey = resolved?.key ?? null;
      note("下載中…");
      render();
    } else {
      note(event.type === "error" ? event.message : "收到非預期的回應，請再試一次", "error");
    }
  } catch (error) {
    note(error.message, "error");
  }
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
    lastSummary = { checkedAt: Date.now(), error: error.message };
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
    if (shouldCheck(lastSummary?.checkedAt) || lastSummary?.hasUpdate) runCheck();
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
      hostApi: {
        stage: (commit, files) => hostUpdateRequest({ type: "update_stage", commit, files }),
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

function addUrl(url) {
  if (!url) return;
  const box = $("urls");
  if (parseUrlLines(box.value).urls.includes(url)) return;
  box.value = box.value.trim() ? `${box.value.trim()}\n${url}` : url;
  scheduleResolve();
}

// ---------- wiring ----------
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "status") {
    status = { ...status, ...msg };
    render();
    if (status.state === "running") {
      scheduleResolve();
      onHostRunning();
    }
  } else if (msg.type === "host_event") {
    const event = msg.event;
    if (event.reqId !== undefined && waiters.has(event.reqId)) {
      waiters.get(event.reqId)(event);
      waiters.delete(event.reqId);
    }
    if (event.type === "started") {
      status.busy = true;
      status.progress = seedProgress(pendingItems);
    }
    if (event.type === "done") {
      status.busy = false;
      note(event.summary?.cancelled ? "已取消下載" : "下載完成", event.summary?.cancelled ? "info" : "ok");
    }
    if (event.type === "config" && status.ready) status.ready = { ...status.ready, outputDir: event.outputDir };
    status.progress = applyEvent(status.progress, event);
    render();
  }
});

$("deploy").addEventListener("click", deploy);
$("redeploy").addEventListener("click", deploy);
$("start").addEventListener("click", async () => {
  note("");
  await send({ type: "start" });
});
$("download").addEventListener("click", startDownload);
$("cancel").addEventListener("click", () => send({ type: "cancel", reqId: nextId() }));
$("urls").addEventListener("input", scheduleResolve);
$("limit").addEventListener("input", scheduleResolve);
$("filename").addEventListener("input", () => { filenameDirty = true; });
$("quality").addEventListener("change", () => {
  chrome.storage?.local.set({ quality: String(selectedQuality()) }).catch(() => {});
});
$("tab-add").addEventListener("click", () => addUrl(currentTab?.url));
$("save-outdir").addEventListener("click", () => simpleRequest(
  { type: "set_output_dir", path: $("outdir").value }, (e) => note(`已改為：${e.outputDir}`, "ok")));
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
  try {
    const saved = await chrome.storage.local.get("quality");
    const radio = document.querySelector(`input[name="quality"][value="${saved.quality}"]`);
    if (radio) radio.checked = true;
  } catch { /* storage unavailable: defaults are fine */ }
  status = { ...status, ...(await send({ type: "get_status" })) };
  lastSummary = await loadSummary().catch(() => null);
  folderSaved = await hasSavedFolder();
  await refreshCurrentTab();
  render();
  scheduleResolve();
  if (status.state === "running") onHostRunning();
}

init();
