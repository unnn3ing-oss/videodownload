// Draws the download list. Used by the side panel and by the web page, which style the same classes.
// Everything that comes from outside (titles, error texts) is set with textContent, never as markup.
import { describeItem } from "./queue.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  download: "M12 4v10m0 0-4-4m4 4 4-4M5 19h14",
  copy: "M9 9h10v11H9zM5 15V4h10",
  x: "M6 6l12 12M18 6 6 18",
  retry: "M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5",
};

function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, label, iconName) {
  const node = el("button", className);
  node.type = "button";
  node.setAttribute("aria-label", label);
  node.title = label;
  if (iconName) node.append(icon(iconName));
  return node;
}

const thumbUrl = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const duration = (seconds) => {
  if (!Number.isFinite(seconds)) return "";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

function makeRow(item, handlers) {
  const row = el("li", "qrow");
  const cover = button("qcover", "下載封面圖片", null);
  const placeholder = el("span", "qph");
  placeholder.append(el("span", "qglyph"));
  const thumb = el("img", "qthumb");
  thumb.alt = "";
  thumb.loading = "lazy";
  thumb.decoding = "async";
  thumb.addEventListener("error", () => { thumb.hidden = true; });
  const dl = el("span", "qdl");
  dl.append(icon("download"));
  cover.append(placeholder, thumb, el("span", "qdur"), dl);
  cover.addEventListener("click", () => handlers.cover(item.uid, cover));

  const main = el("div", "qmain");
  const head = el("div", "qhead");
  head.append(el("span", "qno"), el("div", "qtitle"));
  const bar = el("div", "qbar");
  bar.append(document.createElement("i"));
  const line = el("div", "qline");
  line.append(el("span", "qpill"), el("span", "qsub"));
  const flashLine = el("div", "qflash");
  flashLine.hidden = true;
  main.append(head, bar, line, flashLine);

  const acts = el("div", "qacts");
  const copy = button("qcopy", "複製內文", "copy");
  copy.addEventListener("click", () => handlers.copy(item.uid, copy));
  const retry = button("qretry", "重試", "retry");
  retry.addEventListener("click", () => handlers.retry(item.uid));
  const remove = button("qx", "從清單移除", "x");
  remove.addEventListener("click", () => handlers.remove(item.uid));
  acts.append(copy, retry, remove);

  row.append(cover, main, acts);
  return row;
}

function updateRow(row, state, item, index, now) {
  const info = describeItem(state, item, now);
  row.dataset.kind = info.kind;
  row.dataset.uid = String(item.uid);
  row.style.setProperty("--h", String((item.uid * 47 + 190) % 360));
  const q = (selector) => row.querySelector(selector);
  q(".qno").textContent = String(index + 1);
  const title = q(".qtitle");
  title.textContent = item.status === "fetching" ? "" : item.title;
  q(".qbar i").style.width = `${info.percent}%`;
  q(".qpill").textContent = info.label;
  q(".qsub").textContent = info.sub;
  q(".qdur").textContent = item.duration ? duration(item.duration) : "";

  if (row._id !== item.id) {
    row._id = item.id;
    const thumb = q(".qthumb");
    thumb.hidden = !item.id;
    thumb.removeAttribute("src");
    if (item.id) thumb.src = thumbUrl(item.id);
  }
  q(".qglyph").textContent = item.status === "fetching" ? "" : Array.from(item.title.replace(/[\s【】\[\]／/]/g, ""))[0] ?? "";
  q(".qcover").disabled = !item.id;
  q(".qcopy").disabled = !item.id;
  q(".qretry").hidden = !(item.status === "failed" && item.id);
}

// Keeps the rows that already exist (keyed by uid) so hover states and loading images survive progress updates.
export function renderQueue(list, state, now, handlers) {
  const rows = (list._rows ??= new Map());
  const keep = new Set();
  state.items.forEach((item, index) => {
    keep.add(item.uid);
    let row = rows.get(item.uid);
    if (!row) {
      row = makeRow(item, handlers);
      rows.set(item.uid, row);
    }
    updateRow(row, state, item, index, now);
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
  });
  for (const [uid, row] of rows) {
    if (!keep.has(uid)) {
      row.remove();
      rows.delete(uid);
    }
  }
}

// Shown while the connected local host is too old for this extension: downloading is off until it is updated.
export const HOST_OUTDATED_TEXT = "本機小程式的版本太舊，現在無法下載。請在擴充功能側邊面板的「版本與更新」按「更新」，完成後會自動重新連線。";

export function renderHostNote(node, state) {
  const outdated = Boolean(state?.hostOutdated);
  node.textContent = outdated ? HOST_OUTDATED_TEXT : "";
  node.hidden = !outdated;
}

// Cooldown countdowns need a redraw every second even when the state itself does not change.
export function startTicker(fn) {
  const timer = setInterval(fn, 1000);
  return () => clearInterval(timer);
}

// A short message under the row ("已複製"); the button itself carries the state in data-state.
export function flash(target, state, hint) {
  const line = target.closest(".qrow")?.querySelector(".qflash");
  clearTimeout(target._flash);
  target.dataset.state = state;
  if (line) {
    line.textContent = hint;
    line.dataset.state = state;
    line.hidden = false;
  }
  if (state !== "busy") {
    target._flash = setTimeout(() => {
      delete target.dataset.state;
      if (line) line.hidden = true;
    }, 2600);
  }
}

// Copy 【title】 + hashtags. The clipboard write starts inside the click, with the text still on its way,
// so the browser keeps treating it as a user action even when the host needs a few seconds to answer.
export function copyRowText(send, uid, target) {
  flash(target, "busy", "擷取中…");
  const answer = send({ type: "queue_copy_text", uid }).then((result) => {
    if (!result?.ok) throw new Error(result?.error ?? "複製失敗");
    return result;
  });
  let written;
  try {
    written = navigator.clipboard.write([new ClipboardItem({
      "text/plain": answer.then((result) => new Blob([result.text], { type: "text/plain" })),
    })]);
  } catch {
    written = answer.then((result) => navigator.clipboard.writeText(result.text));
  }
  Promise.all([answer, written]).then(
    ([result]) => flash(target, "ok", result.tagCount ? "已複製" : "已複製（說明欄沒有 hashtag）"),
    (error) => flash(target, "err", error.message || "複製失敗"),
  );
}

export function downloadRowCover(send, uid, target) {
  flash(target, "busy", "下載中…");
  send({ type: "queue_download_cover", uid }).then((result) => {
    if (!result?.ok) return flash(target, "err", result?.error ?? "下載失敗");
    return flash(target, "ok", result.where === "folder" ? "已存到影片資料夾" : "已存到下載資料夾（連線小程式後可存到影片資料夾）");
  }, (error) => flash(target, "err", error.message || "下載失敗"));
}
