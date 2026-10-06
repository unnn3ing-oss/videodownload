// The web version of the batch downloader. It is a remote control: the extension holds the list and talks to
// the local host; this page shows the same list as the side panel and walks through the first-time setup.
import { createBridgeClient } from "./bridge-client.js";
import { copyRowText, downloadRowCover, renderHostNote, renderQueue, setHidden, setText, startTicker } from "../extension/lib/queue-view.js";
import { summarize } from "../extension/lib/queue.js";
import { formatEta, formatSpeed } from "../extension/lib/format.js";
import { buildExtensionZip, deployToFolder } from "../extension/lib/deploy.js";
import { createAutoConnect, extensionNotice, hostNotice, versionNotice } from "../extension/lib/connection.js";
import { installerPendingText } from "../extension/lib/installer.js";

const $ = (id) => document.getElementById(id);
const client = createBridgeClient();
let status = { state: "stopped", ready: null, detail: null };
let queue = null;
let wroteFiles = false;
let everDetected = false; // the extension answered at some point in this page session
let hostWasRunning = false; // so is the host
let gaveUp = false; // automatic launching of the host stopped (it keeps closing right away)
let pageVersion = null; // the version of the extension files this page was published with
const autoConnect = createAutoConnect();

const LONG = new Set(["queue_copy_text", "queue_download_cover"]);
const send = (message) => client.request(message, LONG.has(message.type) ? 120000 : 20000);

function setNote(id, text, kind = "info") {
  const node = $(id);
  node.textContent = text ?? "";
  node.dataset.kind = kind;
  node.hidden = !text;
}

// ---------- rendering ----------
function renderSteps() {
  const detected = client.detected();
  const version = detected ? client.version() : null;
  setText($("ext-version"), version ? `（v${version}）` : "");
  const stale = versionNotice({ extensionVersion: version, pageVersion });
  setText($("ext-version-note"), stale ?? "");
  setHidden($("ext-version-note"), !stale);
  const running = status.state === "running";
  const installed = running || status.state === "forbidden" || (status.state === "stopped" && Boolean(status.detail));
  const done = [detected || wroteFiles, detected, detected && installed, detected && running];
  const current = done.indexOf(false);
  document.querySelectorAll("#steps .st").forEach((step, index) => {
    step.dataset.s = done[index] ? "done" : index === current ? "now" : "todo";
  });
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
  for (const id of ["add-url", "add-btn", "cooldown", "limit"]) $(id).disabled = !detected;
  document.querySelectorAll('input[name="quality"]').forEach((radio) => { radio.disabled = !detected; });
  $("outdir").disabled = !connected;
  $("save-outdir").disabled = !connected;
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
}

function render() {
  renderSteps();
  renderQueueArea();
}

async function refresh() {
  try {
    const [nextStatus, nextQueue] = await Promise.all([send({ type: "get_status" }), send({ type: "queue_get" })]);
    if (nextStatus?.type === "status") setStatus(nextStatus);
    if (nextQueue?.ok) queue = nextQueue.state;
  } catch { /* the extension went away again: the next change event handles it */ }
  render();
}

// ---------- connection ----------
function setStatus(next) {
  status = next;
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
client.onVersion(() => renderSteps());
fetch("extension/manifest.json", { cache: "no-cache" })
  .then((response) => (response.ok ? response.json() : null))
  .then((manifest) => { pageVersion = manifest?.version ?? null; renderSteps(); })
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
$("save-outdir").addEventListener("click", async () => {
  try {
    const result = await send({ type: "set_output_dir", path: $("outdir").value });
    setNote("settings-note", result?.ok ? `已改為：${result.outputDir}` : result?.error ?? "無法使用這個資料夾", result?.ok ? "ok" : "error");
  } catch (error) {
    setNote("settings-note", error.message, "error");
  }
});

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
    const count = await deployToFolder(dir, { onProgress: (p) => setNote("deploy-status", progressText(p)) });
    wroteFiles = true;
    setNote("deploy-status", `已寫入 ${count} 個檔案。下一步：到 Chrome 載入未封裝項目，選這個資料夾。`, "ok");
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
    wroteFiles = true;
    setNote("deploy-status", `已下載 ZIP（${count} 個檔案）。請先解壓縮，載入時選解壓縮後的資料夾。`, "ok");
    render();
  } catch (error) {
    setNote("deploy-status", error.message, "error");
  }
});

$("deploy-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText("chrome://extensions");
    $("deploy-copy").textContent = "已複製";
  } catch {
    setNote("deploy-status", "無法自動複製，請自己在網址列輸入 chrome://extensions", "error");
  }
});

$("deploy-installer").addEventListener("click", async () => {
  try {
    const result = await send({ type: "deploy_installer" });
    if (result?.ok && result.pending) setNote("deploy-status", installerPendingText(result.name), "info");
    else setNote("deploy-status", result?.ok ? `已下載「${result.name}」。請執行一次，完成後這裡會自動連線。` : result?.error ?? "無法下載安裝檔", result?.ok ? "ok" : "error");
  } catch (error) {
    setNote("deploy-status", `需要先完成步驟 1、2：${error.message}`, "error");
  }
});

startTicker(() => { if (queue?.cooldown) renderQueueArea(); });
render();
