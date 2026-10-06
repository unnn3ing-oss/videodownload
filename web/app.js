// The web version of the batch downloader. It is a remote control: the extension holds the list and talks to
// the local host; this page shows the same list as the side panel and walks through the first-time setup.
import { createBridgeClient } from "./bridge-client.js";
import { copyRowText, downloadRowCover, renderHostNote, renderQueue, setHidden, setText, startTicker } from "../extension/lib/queue-view.js";
import { summarize } from "../extension/lib/queue.js";
import { formatEta, formatSpeed } from "../extension/lib/format.js";
import { buildExtensionZip, deployToFolder } from "../extension/lib/deploy.js";
import { createAutoConnect, extensionNotice, hostNotice, versionNotice } from "../extension/lib/connection.js";
import { renderChecks, runDoctor, summarizeChecks } from "../extension/lib/doctor-view.js";
import {
  FOLDER_HINTS, FOLDER_NAME, STEP_LABELS, connectSummary, decideView, detectOs, isDeployed, macInstallCommand, selfCheckItems,
  wizardSteps,
} from "../extension/lib/setup-flow.js";

const $ = (id) => document.getElementById(id);
const client = createBridgeClient();
let status = { state: "stopped", ready: null, detail: null };
let queue = null;
let loadFolder = null; // where the files went, for the "load unpacked" step: { name, inside }
let everDetected = false; // the extension answered at some point in this page session
let hostWasRunning = false; // so is the host
let gaveUp = false; // automatic launching of the host stopped (it keeps closing right away)
let pageVersion = null; // the version of the extension files this page was published with
const autoConnect = createAutoConnect();

const LONG = new Set(["queue_copy_text", "queue_download_cover", "doctor", "update_info", "update_apply"]);
const send = (message) => client.request(message, LONG.has(message.type) ? 180000 : 20000);

function setNote(id, text, kind = "info") {
  const node = $(id);
  node.textContent = text ?? "";
  node.dataset.kind = kind;
  node.hidden = !text;
}

// ---------- rendering ----------
const INSTALLER_SEEN = "ytdl-installer-seen"; // the person has been past the "download / run the installer" steps
const readSeen = () => { try { return localStorage.getItem(INSTALLER_SEEN) === "1"; } catch { return false; } };
const writeSeen = () => { try { localStorage.setItem(INSTALLER_SEEN, "1"); } catch { /* private window */ } };
let passedInstaller = readSeen();
const wizard = () => wizardSteps({ detected: client.detected(), passedInstaller, status, deployed: deployed() });

// The window shows one step at a time. `cursor` is the one shown; it starts at the first step that is not done, and follows
// the install along while the person stays on the front step (the extension showing up moves them on to the next).
let cursor = 1;
let lastSuggested = 1;

function renderWizard() {
  const detected = client.detected();
  const version = detected ? client.version() : null;
  const { states, suggested } = wizard();  // (the extension's version row is drawn below)
  if (suggested > lastSuggested && cursor === lastSuggested) cursor = suggested;
  lastSuggested = suggested;

  const stale = versionNotice({ extensionVersion: version, pageVersion });
  setText($("ext-version-note"), stale ?? "");
  setHidden($("ext-version-note"), !stale);
  setText($("ext-version"), version ? `（v${version}）` : "");
  setHidden($("ext-found"), !detected);
  const summary = connectSummary({ detected, deployed: deployed(), status });
  setText($("connect-status"), `${summary.ok ? "✓ " : ""}${summary.text}`);
  $("connect-status").dataset.ok = String(summary.ok);
  const where = loadFolder ? `檔案放在「${loadFolder.name}」${loadFolder.inside ? `裡面新建的「${loadFolder.inside}」` : ""}。載入時請選${loadFolder.inside ? "那個" : "這個"}資料夾。` : "";
  setText($("load-where"), where);
  setHidden($("load-where"), !where);

  document.querySelectorAll("#steps .sp").forEach((step) => {
    const n = Number(step.dataset.step);
    step.dataset.s = states[n - 1];
    step.classList.toggle("here", n === cursor);
    step.classList.toggle("passed", n < cursor);
    step.querySelector(".sp-btn").setAttribute("aria-current", n === cursor ? "step" : "false");
  });
  document.querySelectorAll(".pane").forEach((pane) => setHidden(pane, Number(pane.dataset.pane) !== cursor));
  $("step-prev").disabled = cursor === 1;
  setText($("step-next"), cursor === STEP_LABELS.length ? "完成" : "下一步");
}

function goToStep(n) {
  cursor = Math.min(STEP_LABELS.length, Math.max(1, n));
  renderWizard();
}

function renderQueueArea() {
  const detected = client.detected();
  const connected = detected && status.state === "running";
  document.body.classList.toggle("is-locked", !detected);
  $("add-card").inert = !detected;
  $("queue-card").inert = !detected;
  const missing = extensionNotice({ detected, everDetected });
  setText($("no-extension"), missing ?? "");
  setHidden($("no-extension"), !missing);
  const hostText = hostNotice({ detected, status, wasRunning: hostWasRunning, gaveUp });
  setText($("conn-note"), hostText?.text ?? "");
  $("conn-note").dataset.kind = hostText?.kind ?? "info";
  setHidden($("conn-note"), !hostText);
  for (const id of ["add-url", "add-btn", "cooldown", "limit", "auto-cover"]) $(id).disabled = !detected;
  document.querySelectorAll('input[name="quality"]').forEach((radio) => { radio.disabled = !detected; });
  $("outdir").disabled = !connected;
  $("save-outdir").disabled = !connected;
  $("doctor-check").disabled = !connected;
  if (connected && status.ready?.outputDir && document.activeElement !== $("outdir")) $("outdir").value = status.ready.outputDir;

  if (!queue) {
    $("queue-empty").hidden = false;
    $("start-all").disabled = true;
    return;
  }
  const info = summarize(queue);
  const now = Date.now();
  renderQueue($("queue-list"), queue, now, {
    remove: (uid) => send({ type: "queue_remove", uid }),
    retry: (uid) => send({ type: "queue_retry", uid }),
    copy: (uid, button) => copyRowText(send, uid, button),
    cover: (uid, button) => downloadRowCover(send, uid, button),
  });
  $("queue-empty").hidden = queue.items.length > 0;
  const parts = queue.items.length ? [`共 ${info.total} 支`, `完成 ${info.done}`] : [];
  if (info.speed) parts.push(`速度 ${formatSpeed(info.speed)}`);
  if (info.etaSec) parts.push(`剩餘 ${formatEta(info.etaSec)}`);
  $("queue-stats").textContent = parts.join(" · ");
  const cooling = queue.cooldown && queue.cooldown.until > now;
  $("cooldown-chip").hidden = !cooling;
  if (cooling) $("cooldown-chip").textContent = `${Math.ceil((queue.cooldown.until - now) / 1000)} 秒後開始下一支`;

  const button = $("start-all");
  button.className = `btn ${queue.running ? "danger" : "primary"}`;
  button.textContent = queue.running ? "停止" : info.total && info.waiting === 0 && info.done > 0 ? "全部完成" : "開始全部下載";
  button.disabled = !queue.running && (!connected || queue.hostOutdated || info.waiting === 0);
  renderHostNote($("host-note"), queue);

  document.querySelectorAll('input[name="quality"]').forEach((radio) => { radio.checked = Number(radio.value) === queue.settings.quality; });
  if (document.activeElement !== $("cooldown")) $("cooldown").value = String(queue.settings.cooldownSec);
  $("cooldown-out").textContent = `${queue.settings.cooldownSec} 秒`;
  if (document.activeElement !== $("limit")) $("limit").value = String(queue.settings.limit);
  $("auto-cover").checked = queue.settings.autoCover !== false;
}

function render() {
  renderWizard();
  renderUpdate();
  renderQueueArea();
  renderSetupWindow();
}

// ---------- the setup window: the steps in the middle of the page, and the self-check ----------
// The first visit opens it. Once the install works it closes by itself and the page remembers that. Later visits leave it
// shut while it works; when it does not, the self-check opens (after a moment to connect), and closes again once it works.
const os = detectOs();
const FLAG = "ytdl-setup-done";
const readFlag = () => { try { return localStorage.getItem(FLAG) === "1"; } catch { return false; } };
const writeFlag = () => { try { localStorage.setItem(FLAG, "1"); } catch { /* private window: it just asks again next time */ } };
const dialog = $("setup-dialog");
const loadedAt = Date.now();
let everWorked = readFlag();
let wasDeployed = false;
let unhealthySince = loadedAt;
let dismissed = false;
let expectClose = false;
let doctorChecks = null; // the host's own report, fetched when the self-check opens

const deployed = () => isDeployed({
  detected: client.detected(), status, hostOutdated: Boolean(queue?.hostOutdated), extensionVersion: client.version(), pageVersion,
});

function showView(name) {
  $("view-steps").hidden = name !== "steps";
  $("view-check").hidden = name !== "check";
  setHidden($("sd-foot"), name !== "steps");
  $("tab-check").setAttribute("aria-pressed", String(name === "check"));
  if (name === "check") renderCheck();
  else renderWizard();
}

function openSetup(name) {
  if (name === "steps") cursor = wizard().suggested; // (the step that is next to do)
  showView(name);
  if (!dialog.open) dialog.showModal();
  if (name === "check") refreshDoctor();
}

function closeSetup() {
  if (!dialog.open) return;
  expectClose = true; // (the close event comes later: told apart from the person pressing Esc or the cross)
  dialog.close();
}

dialog.addEventListener("close", () => {
  if (expectClose) expectClose = false;
  else dismissed = true;
});

function refreshDoctor() {
  if (status.state !== "running") return;
  send({ type: "doctor" }).then((result) => {
    doctorChecks = result?.ok ? result.checks : null;
    renderCheck();
  }, () => {});
}

function renderCheck() {
  const items = selfCheckItems({
    detected: client.detected(), everDetected, extensionVersion: client.version(), pageVersion, status,
    hostOutdated: Boolean(queue?.hostOutdated), gaveUp, doctor: doctorChecks,
  });
  renderChecks($("check-list"), items);
  setText($("check-summary"), summarizeChecks(items).text);
}

function renderSetupWindow() {
  const ok = deployed();
  const now = Date.now();
  if (ok && !wasDeployed) { // it works now: hide the window and remember
    wasDeployed = true;
    everWorked = true;
    dismissed = false;
    writeFlag();
    closeSetup();
  } else if (!ok && wasDeployed) { // it stopped working: start counting
    wasDeployed = false;
    unhealthySince = now;
    dismissed = false;
  }
  setText($("setup-chip-text"), ok ? "已連線 · 設定流程" : "尚未完成設定 · 開啟設定流程");
  $("setup-dot").dataset.s = ok ? "ok" : "todo";
  if (dialog.open && !$("view-check").hidden) renderCheck();
  if (ok) return;
  const view = decideView({ firstVisit: !everWorked, deployed: false, detected: client.detected(), unhealthyMs: now - unhealthySince, dismissed });
  if (view !== "hidden" && !dialog.open) openSetup(view === "check" ? "check" : "steps");
}

$("open-setup").addEventListener("click", () => { dismissed = false; openSetup("steps"); });
$("setup-close").addEventListener("click", () => dialog.close());
$("tab-check").addEventListener("click", () => { showView("check"); refreshDoctor(); });
$("check-to-steps").addEventListener("click", () => { cursor = wizard().suggested; showView("steps"); });
$("step-prev").addEventListener("click", () => goToStep(cursor - 1));
$("step-next").addEventListener("click", () => {
  if (cursor === 2 && !passedInstaller) { passedInstaller = true; writeSeen(); } // ("next" after the installer steps: remembered)
  if (cursor < STEP_LABELS.length) goToStep(cursor + 1);
  else dialog.close(); // "完成": the person is done with the window (it also closes by itself once everything works)
});
document.querySelectorAll("#steps .sp").forEach((step) => step.querySelector(".sp-btn").addEventListener("click", () => goToStep(Number(step.dataset.step))));
$("check-again").addEventListener("click", () => {
  autoConnect.reset();
  gaveUp = false;
  doctorChecks = null;
  send({ type: "start" }).catch(() => {});
  refresh();
  refreshDoctor();
  render();
});
setInterval(renderSetupWindow, 500); // time passing alone can be what opens the window

async function refresh() {
  try {
    const [nextStatus, nextQueue] = await Promise.all([send({ type: "get_status" }), send({ type: "queue_get" })]);
    if (nextStatus?.type === "status") setStatus(nextStatus);
    if (nextQueue?.ok) queue = nextQueue.state;
  } catch { /* the extension went away again: the next change event handles it */ }
  render();
}

// ---------- connection ----------
let notRunningAt = 0; // the last time the host was seen not running (a reload and restart shows up as that)
function setStatus(next) {
  status = next;
  if (next.state !== "running") notRunningAt = Date.now();
  if (next.state === "running") hostWasRunning = true;
}

client.onChange((detected) => {
  if (detected) {
    everDetected = true;
    autoConnect.reset();
    gaveUp = false;
    refresh();
  } else {
    render();
  }
});
client.onState((state) => { queue = state; renderQueueArea(); });
client.onVersion(() => renderWizard());
fetch("extension/manifest.json", { cache: "no-cache" })
  .then((response) => (response.ok ? response.json() : null))
  .then((manifest) => { pageVersion = manifest?.version ?? null; renderWizard(); })
  .catch(() => {}); // without it the page just cannot compare versions
client.onStatus((next) => { setStatus(next); render(); });

// Once the extension is there, keep trying to reach the local host until it answers (it may still be installing).
// A host that closes right after it starts is only retried a few times (see createAutoConnect).
function connectHost() {
  const next = autoConnect.next(client.detected(), status);
  if (next.gaveUp !== gaveUp) {
    gaveUp = next.gaveUp;
    render();
  }
  if (next.send) send({ type: "start" }).catch(() => {});
}
setInterval(connectHost, 3000);
client.onChange((detected) => { if (detected) connectHost(); });
$("start").addEventListener("click", () => {
  autoConnect.reset();
  gaveUp = false;
  render();
  send({ type: "start" }).catch(() => {});
});

// ---------- adding and running ----------
async function addFromBox() {
  const urls = $("add-url").value.split(/\s+/).filter(Boolean);
  if (!urls.length) return;
  let firstError = null;
  let added = 0;
  for (const url of urls) {
    try {
      const result = await send({ type: "queue_add", url });
      if (result?.ok) added += 1;
      else firstError ??= result?.error ?? "無法加入";
    } catch (error) {
      firstError ??= error.message;
    }
  }
  setNote("add-note", firstError ? `${firstError}${urls.length > 1 ? `（已加入 ${added} 筆）` : ""}` : "", "error");
  if (added) $("add-url").value = "";
}
$("add-btn").addEventListener("click", addFromBox);
$("add-url").addEventListener("keydown", (event) => { if (event.key === "Enter") addFromBox(); });
$("add-url").addEventListener("input", () => setNote("add-note", ""));

$("start-all").addEventListener("click", async () => {
  try {
    const result = await send({ type: queue?.running ? "queue_stop" : "queue_start" });
    setNote("note", result?.ok === false ? result.error : "", "error");
  } catch (error) {
    setNote("note", error.message, "error");
  }
});

$("quality").addEventListener("change", (event) => send({ type: "settings_set", settings: { quality: Number(event.target.value) } }));
$("cooldown").addEventListener("input", () => { $("cooldown-out").textContent = `${$("cooldown").value} 秒`; });
$("cooldown").addEventListener("change", () => send({ type: "settings_set", settings: { cooldownSec: Number($("cooldown").value) } }));
$("limit").addEventListener("change", () => send({ type: "settings_set", settings: { limit: Number($("limit").value) } }));
$("auto-cover").addEventListener("change", () => send({ type: "settings_set", settings: { autoCover: $("auto-cover").checked } }));
const doctorUi = () => ({ check: $("doctor-check"), fix: $("doctor-fix"), list: $("doctor-list"), summary: $("doctor-summary"), fixed: $("doctor-fixed") });
$("doctor-check").addEventListener("click", () => runDoctor(send, doctorUi(), false));
$("doctor-fix").addEventListener("click", () => runDoctor(send, doctorUi(), true));
$("save-outdir").addEventListener("click", async () => {
  try {
    const result = await send({ type: "set_output_dir", path: $("outdir").value });
    setNote("settings-note", result?.ok ? `已改為：${result.outputDir}` : result?.error ?? "無法使用這個資料夾", result?.ok ? "ok" : "error");
  } catch (error) {
    setNote("settings-note", error.message, "error");
  }
});

// ---------- versions and updates ----------
// "Check for updates" compares with the repository's latest version; "update" has the extension download and verify the
// new files, replace the local program's files, and write its own files into the folder the installer made. Then it reloads.
let updateInfo = null;
let updateBusy = false;
let upNote = { text: "", kind: "info" };
let autoChecked = false;

function setUpNote(text, kind = "info") {
  upNote = { text, kind };
  renderUpdate();
}

const updateProgressText = ({ step, done, total }) => ({
  download: `下載更新檔案 ${done} / ${total}`, host: "更新本機小程式…", write: "寫入擴充功能的檔案…",
})[step] ?? "更新中…";

function updateAdvice(info, connected) {
  if (!info.canUpdateHere && !info.hostChecked) return "本機小程式還沒連線，所以不知道插件的資料夾在哪裡。請先讓它連線（設定流程最後一步的「啟動」），再更新。";
  if (!info.canUpdateHere) return "這份擴充功能不是用安裝檔放的，網頁不知道它的資料夾在哪裡。請到側邊面板「設定與工具」按「更新到最新版」（第一次要選一次資料夾），或重新執行安裝檔。";
  if (!connected) return "請先讓本機小程式連線（設定流程最後一步的「啟動」），再更新。";
  return "有新版本可以更新。";
}

function renderUpdate() {
  const detected = client.detected();
  const connected = detected && status.state === "running";
  const version = detected ? client.version() : null;
  const hostVersion = connected ? status.ready?.hostVersion : null;
  setText($("up-current"), version ? `擴充功能 v${version}${hostVersion ? ` · 小程式 v${hostVersion}` : ""}` : "尚未連線");
  let latest = "尚未檢查";
  if (updateInfo) {
    if (updateInfo.hasUpdate) latest = `${updateInfo.latestVersion ? `v${updateInfo.latestVersion}` : "有新版本"}（${updateInfo.message}）`;
    else latest = updateInfo.hostChecked ? "已是最新版" : "擴充功能已是最新（小程式尚未連線，沒有比對）";
  }
  setText($("up-latest"), latest);
  $("up-check").disabled = !detected || updateBusy;
  setHidden($("up-apply"), !updateInfo?.hasUpdate);
  $("up-apply").disabled = !(updateInfo?.hasUpdate && updateInfo.canUpdateHere && connected) || updateBusy;
  const note = !upNote.text && updateInfo?.hasUpdate ? { kind: "info", text: updateAdvice(updateInfo, connected) } : upNote;
  setNote("up-note", note.text, note.kind);
  if (connected && !autoChecked && !updateBusy) { // once per visit, quietly
    autoChecked = true;
    checkUpdate({ quiet: true });
  }
}

async function checkUpdate({ quiet = false, inside = false } = {}) {
  if (updateBusy && !inside) return;
  updateBusy = true;
  if (!quiet) setUpNote("檢查中…");
  try {
    const result = await send({ type: "update_info" });
    if (result?.ok) {
      updateInfo = result.info;
      if (!quiet) {
        const none = result.info.hostChecked ? "已是最新版。" : "擴充功能已是最新；小程式還沒連線，沒有比對它。";
        upNote = { text: result.info.hasUpdate ? updateAdvice(result.info, status.state === "running") : none, kind: result.info.hasUpdate ? "info" : "ok" };
      }
    } else if (!quiet) {
      upNote = { text: result?.error ?? "檢查失敗", kind: "error" };
    }
  } catch (error) {
    if (!quiet) upNote = { text: error.message, kind: "error" };
  } finally {
    updateBusy = false;
    renderUpdate();
  }
}

// After the reload the extension is gone for a moment. It is back when its host has been seen restarting (or its version is the
// new one) and runs again. A page that sees nothing happen for a while concludes that no reload happened.
async function waitUntilBack(expected, before, maxMs = 45000, noRestartAfterMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!(client.detected() && status.state === "running")) continue;
    const restarted = notRunningAt >= started;
    if (restarted || (expected && expected !== before && client.version() === expected)) return { back: true, restarted: true };
    if (Date.now() - started >= noRestartAfterMs) return { back: true, restarted: false };
  }
  return { back: false, restarted: false };
}

async function applyUpdate() {
  if (updateBusy || !updateInfo?.hasUpdate) return;
  updateBusy = true;
  setUpNote("準備更新…");
  const expected = updateInfo.latestVersion;
  const before = client.version();
  const hadExtensionFiles = updateInfo.extCount > 0;
  try {
    const result = await send({ type: "update_apply", sha: updateInfo.sha });
    if (!result?.ok) throw new Error(result?.error ?? "更新失敗");
    if (result.nothing) {
      updateInfo = null;
      upNote = { text: "已是最新版。", kind: "ok" };
      return;
    }
    setUpNote("更新完成，擴充功能正在重新載入…", "ok");
    const { back } = await waitUntilBack(expected, before);
    const now = client.version();
    if (!back) upNote = { text: "已更新，但擴充功能或本機小程式還沒回應。請到 chrome://extensions 確認擴充功能已啟用，再重新整理本頁。", kind: "error" };
    else if (expected && now !== expected) upNote = { text: `已重新載入，但擴充功能的版本仍是 v${now}（預期 v${expected}）。載入的可能不是更新的那個資料夾，請到 chrome://extensions 確認它的載入路徑。`, kind: "error" };
    else upNote = { text: expected ? `已更新到 v${expected}。` : "已更新。", kind: "ok" };
    updateInfo = null;
    if (upNote.kind === "ok") { // compare again: files that still differ mean the loaded extension is not the folder that was written
      await checkUpdate({ quiet: true, inside: true });
      if (hadExtensionFiles && updateInfo?.extCount > 0) {
        upNote = { text: `更新後比對，擴充功能仍有 ${updateInfo.extCount} 個檔案和最新版不同。載入的可能不是更新的那個資料夾，請到 chrome://extensions 確認它的載入路徑。`, kind: "error" };
      }
    }
  } catch (error) {
    upNote = { text: error.message, kind: "error" };
  } finally {
    updateBusy = false;
    renderUpdate();
  }
}

client.onProgress((progress) => { if (updateBusy) setUpNote(updateProgressText(progress)); });
$("up-check").addEventListener("click", () => checkUpdate());
$("up-apply").addEventListener("click", applyUpdate);

// ---------- first-time setup ----------
const progressText = ({ step, done, total }) => ({ download: `下載更新檔案 ${done} / ${total}`, write: `寫入檔案 ${done} / ${total}` })[step] ?? "處理中…";

$("deploy-pick").addEventListener("click", async () => {
  if (!window.showDirectoryPicker) {
    setNote("deploy-status", "這個瀏覽器不支援選擇資料夾，請改用 Chrome，或按「改下載 ZIP」。", "error");
    return;
  }
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: "ytdl-extension", mode: "readwrite" });
  } catch (error) {
    if (error?.name !== "AbortError") setNote("deploy-status", `無法選擇資料夾：${error?.message ?? error}`, "error");
    return;
  }
  setNote("deploy-status", "準備中…");
  try {
    const { count, inside } = await deployToFolder(dir, { onProgress: (p) => setNote("deploy-status", progressText(p)) });
    loadFolder = { name: dir.name, inside };
    setNote("deploy-status", `已寫入 ${count} 個檔案${inside ? `（「${dir.name}」裡已經有其他東西，所以我在裡面新建了「${inside}」資料夾）` : ""}。接著到 chrome://extensions 載入未封裝項目。`, "ok");
    render();
  } catch (error) {
    setNote("deploy-status", error.message, "error");
  }
});

$("deploy-zip").addEventListener("click", async () => {
  setNote("deploy-status", "準備中…");
  try {
    const { blob, count } = await buildExtensionZip({ onProgress: (p) => setNote("deploy-status", progressText(p)) });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "YouTube-batch-downloader-extension.zip";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    loadFolder = null;
    setNote("deploy-status", `已下載 ZIP（${count} 個檔案）。請先解壓縮，載入時選解壓縮後的資料夾。`, "ok");
    render();
  } catch (error) {
    setNote("deploy-status", error.message, "error");
  }
});

// Every "copy" button: the text goes to the clipboard and the button says so for a moment; when it cannot, `noteId` says what to type.
function copyButton(id, text, noteId, failure) {
  const button = $(id);
  const label = button.textContent;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(typeof text === "function" ? text() : text);
      setNote(noteId, "");
      button.textContent = "已複製";
      clearTimeout(button._copied);
      button._copied = setTimeout(() => { button.textContent = label; }, 2000);
    } catch {
      setNote(noteId, failure, "error");
    }
  });
}
const typeFolder = `無法自動複製，請自己輸入資料夾名稱：${FOLDER_NAME}`;
copyButton("deploy-copy", "chrome://extensions", "copy-note-3", "無法自動複製，請自己在網址列輸入 chrome://extensions");
copyButton("copy-folder", FOLDER_NAME, "copy-note-1", typeFolder);
copyButton("copy-mac-command", () => macInstallCommand(), "installer-status", `無法自動複製，請自己輸入：${macInstallCommand()}`);

// what this computer is shown (an unknown system sees every system's instructions)
$("default-folder").textContent = FOLDER_NAME;
$("folder-hint").textContent = FOLDER_HINTS[0];
$("folder-hint-2").textContent = FOLDER_HINTS[1];
$("mac-command").textContent = macInstallCommand();
document.querySelectorAll("[data-os]").forEach((node) => setHidden(node, os !== "other" && node.dataset.os !== os));

startTicker(() => { if (queue?.cooldown) renderQueueArea(); });
render();
