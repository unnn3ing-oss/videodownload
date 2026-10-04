import { parseUrlLines } from "./lib/urls.js";
import { installerFor } from "./lib/platform.js";
import { applyEvent, emptyProgress } from "./lib/events.js";

const $ = (id) => document.getElementById(id);

const STATE_TEXT = {
  not_installed: "尚未部署：請先按「下載部署」，執行安裝檔後再按「啟動」",
  stopped: "已部署，尚未啟動：請按「啟動」",
  running: "已啟動",
  forbidden: "Chrome 拒絕連線（擴充功能識別碼與安裝檔不符），請重新「下載部署」",
};

let status = { state: "stopped", ready: null, progress: emptyProgress(), busy: false };
let resolved = null; // { key, items }
let filenameDirty = false;
let nextReq = 1;
const waiters = new Map();
let resolveTimer = null;

const send = (message) => chrome.runtime.sendMessage(message);

function request(message, timeoutMs = 180000) {
  const reqId = nextReq++;
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

function note(text) {
  const el = $("note");
  el.textContent = text ?? "";
  el.hidden = !text;
}

function formatSpeed(bytesPerSecond) {
  return bytesPerSecond ? `${(bytesPerSecond / 1048576).toFixed(1)} MB/s` : "";
}

function itemMeta(item) {
  switch (item.status) {
    case "queued": return "排隊中";
    case "downloading": return `${item.percent == null ? "" : `${Math.round(item.percent)}% `}${formatSpeed(item.speed)}`.trim();
    case "done": return `完成${item.height ? ` · ${item.height}p` : ""}`;
    case "skipped": return "已下載過，略過";
    case "failed": return item.reason ?? "失敗";
    default: return "";
  }
}

function renderStatus() {
  const el = $("status");
  el.dataset.state = status.state;
  let text = STATE_TEXT[status.state] ?? status.state;
  if (status.state === "running" && status.ready) {
    const r = status.ready;
    const problems = [];
    if (!r.ytdlpVersion) problems.push("找不到下載引擎，請重新執行安裝檔");
    if (!r.ffmpegOk) problems.push("找不到 ffmpeg");
    if (!r.jsRuntimeOk) problems.push("找不到 JS 執行環境（Deno）");
    text += r.ytdlpVersion ? `（yt-dlp ${r.ytdlpVersion}）` : "";
    if (problems.length) text += `；${problems.join("；")}`;
  }
  el.textContent = text;
}

function renderItems() {
  const list = $("items");
  list.replaceChildren();
  for (const item of Object.values(status.progress.items)) {
    const li = document.createElement("li");
    li.className = item.status ?? "";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = item.title ?? "";
    li.append(title);
    if (item.status === "downloading" || item.status === "done") {
      const bar = document.createElement("progress");
      bar.max = 100;
      bar.value = item.percent ?? 0;
      li.append(bar);
    }
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = itemMeta(item);
    li.append(meta);
    if (item.warnNotH264) {
      const warn = document.createElement("div");
      warn.className = "meta warn";
      warn.textContent = "非 H.264，部分平台可能需轉檔";
      li.append(warn);
    }
    list.append(li);
  }
  const summary = $("summary");
  const s = status.progress.summary;
  summary.hidden = !s;
  if (s) summary.textContent = `完成 ${s.ok}、略過 ${s.skipped}、失敗 ${s.failed}${s.cancelled ? "（已取消）" : ""}`;
}

function renderControls() {
  const running = status.state === "running";
  $("download").disabled = !running || status.busy;
  $("cancel").hidden = !status.busy;
  $("update").disabled = !running || status.busy;
  $("save-outdir").disabled = !running;
  $("outdir").disabled = !running;
  if (running && status.ready?.outputDir && document.activeElement !== $("outdir")) {
    $("outdir").value = status.ready.outputDir;
  }
  const single = resolved?.items.length === 1;
  $("filename").disabled = !single;
  if (!single) {
    $("filename").value = "";
    filenameDirty = false;
  }
}

function render() {
  renderStatus();
  renderItems();
  renderControls();
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
    renderControls();
    return null;
  }
  const key = `${urls.join("\n")}|${limit ?? ""}`;
  if (resolved?.key === key) return resolved.items;
  note("解析中…");
  let event;
  try {
    event = await request({ type: "resolve", urls, limit });
  } catch (error) {
    note(error.message);
    return null;
  }
  if (event.type === "error") {
    note(event.message);
    resolved = null;
    renderControls();
    return null;
  }
  note(`找到 ${event.items.length} 支影片`);
  const previous = resolved?.items.length === 1 ? resolved.items[0].id : null;
  resolved = { key, items: event.items };
  if (event.items.length === 1) {
    if (previous !== event.items[0].id) filenameDirty = false;
    if (!filenameDirty) $("filename").value = event.items[0].title;
  }
  renderControls();
  return event.items;
}

function scheduleResolve() {
  clearTimeout(resolveTimer);
  renderInvalid(currentInput().invalid);
  if (status.state !== "running") return;
  resolveTimer = setTimeout(() => resolveNow(), 600);
}

async function deploy() {
  const info = await chrome.runtime.getPlatformInfo();
  const installer = installerFor(info.os);
  if (!installer) {
    note("目前只支援 Windows 與 Mac");
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
    ? `已下載「${name}」。請解壓縮後，對 install-mac.command 按右鍵選「打開」執行一次，完成後回來按「啟動」。`
    : `已下載「${name}」。請到下載資料夾雙擊執行一次（若出現 SmartScreen，請按「其他資訊」→「仍要執行」），完成後回來按「啟動」。`);
}

async function startDownload() {
  const items = await resolveNow();
  if (!items?.length) {
    if (items) note("沒有可下載的影片");
    return;
  }
  const typed = items.length === 1 ? $("filename").value.trim() : "";
  const titleOverride = typed && typed !== items[0].title ? typed : undefined;
  try {
    const event = await request({ type: "download", items, quality: Number($("quality").value), titleOverride });
    if (event.type === "error") note(event.message);
    else note("下載中…");
  } catch (error) {
    note(error.message);
  }
}

async function simpleRequest(message, onOk) {
  try {
    const event = await request(message);
    if (event.type === "error") note(event.message);
    else onOk(event);
  } catch (error) {
    note(error.message);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "status") {
    status = { ...status, ...msg };
    render();
    if (status.state === "running") scheduleResolve();
  } else if (msg.type === "host_event") {
    const event = msg.event;
    if (event.reqId !== undefined && waiters.has(event.reqId)) {
      waiters.get(event.reqId)(event);
      waiters.delete(event.reqId);
    }
    if (event.type === "started") status.busy = true;
    if (event.type === "done") status.busy = false;
    if (event.type === "config" && status.ready) status.ready = { ...status.ready, outputDir: event.outputDir };
    status.progress = applyEvent(status.progress, event);
    render();
  }
});

$("deploy").addEventListener("click", deploy);
$("start").addEventListener("click", async () => {
  note("");
  await send({ type: "start" });
});
$("download").addEventListener("click", startDownload);
$("cancel").addEventListener("click", () => send({ type: "cancel", reqId: nextReq++ }));
$("urls").addEventListener("input", scheduleResolve);
$("limit").addEventListener("input", scheduleResolve);
$("filename").addEventListener("input", () => { filenameDirty = true; });
$("quality").addEventListener("change", () => chrome.storage?.local.set({ quality: $("quality").value }).catch(() => {}));
$("save-outdir").addEventListener("click", () => simpleRequest(
  { type: "set_output_dir", path: $("outdir").value }, (e) => note(`已改為：${e.outputDir}`)));
$("update").addEventListener("click", () => {
  note("更新中…");
  simpleRequest({ type: "update_engine" }, (e) => note(`下載引擎已更新（${e.ytdlpVersion ?? "未知版本"}）`));
});

async function init() {
  try {
    const saved = await chrome.storage.local.get("quality");
    if (saved.quality) $("quality").value = saved.quality;
  } catch { /* storage unavailable: defaults are fine */ }
  status = { ...status, ...(await send({ type: "get_status" })) };
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && parseUrlLines(tab.url).urls.length && !$("urls").value) $("urls").value = tab.url;
  } catch { /* no tab access: user pastes manually */ }
  render();
  scheduleResolve();
}

init();
