// Draws the download list. Used by the side panel and by the web page, which style the same classes.
// Everything that comes from outside (titles, error texts) is set with textContent, never as markup.
import { DEFAULT_SETTINGS, describeItem } from "./queue.js";
import { parseBoundedInt } from "./format.js";
import { REINSTALL_ACTION, hostVersionNotice, updateButtonExtra } from "./connection.js";
import { summarizeAdd } from "./add-flow.js";
import { SETTING_RANGES } from "./constants.js";

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
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.append(document.createElement("i"));
  const line = el("div", "qline");
  line.append(el("span", "qpill"), el("span", "qsub"));
  const hint = el("div", "qhint"); // "same title as row N, but another video": only a hint, the row downloads like any other
  const flashLine = el("div", "qflash");
  flashLine.setAttribute("role", "status"); // announced when it gets text, so it is in the page from the start
  flashLine.setAttribute("aria-live", "polite");
  main.append(head, bar, line, hint, flashLine);

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
  const bar = q(".qbar");
  bar.setAttribute("aria-valuenow", String(Math.round(info.percent)));
  bar.setAttribute("aria-valuetext", [info.label, info.sub].filter(Boolean).join("，"));
  const named = item.status === "fetching" || !item.title;
  bar.setAttribute("aria-label", named ? "下載進度" : `${item.title} 的下載進度`);
  // the same buttons repeat in every row, so each one names its video
  for (const [selector, base] of [[".qcover", "下載封面圖片"], [".qcopy", "複製內文"], [".qretry", "重試"], [".qx", "從清單移除"]]) {
    q(selector).setAttribute("aria-label", named ? base : `${base}：${item.title}`);
  }
  q(".qpill").textContent = info.label;
  q(".qsub").textContent = info.sub;
  q(".qhint").textContent = info.hint;
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
export const HOST_OUTDATED_TEXT = `本機小程式的版本太舊，現在無法下載。請${REINSTALL_ACTION}，完成後會自動重新連線。`;

// A live region is announced again whenever its text is rewritten, even with the same words (the list is drawn
// on every progress push), so notes in live regions are only written when something changed.
export function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

export function setHidden(node, hidden) {
  if (node.hidden !== hidden) node.hidden = hidden;
}

// `updateAvailable`: the 「更新到最新版」 button can be pressed right now, so it is offered too.
export function renderHostNote(node, state, { updateAvailable = false } = {}) {
  const outdated = Boolean(state?.hostOutdated);
  setText(node, outdated ? `${HOST_OUTDATED_TEXT}${updateButtonExtra(updateAvailable)}` : "");
  setHidden(node, !outdated);
}

// The host stopped the whole job on purpose (failures in a row, disk full): its reason, said where it is seen, and what is
// left. The rows it never tried are still waiting, so pressing the start button again goes on with them.
export function renderAbortNote(node, state) {
  const aborted = state?.aborted;
  let text = "";
  if (aborted) {
    const waiting = state.items.filter((i) => i.status === "waiting" && !i.dupOf).length;
    text = /[。！？.!?]$/.test(aborted.message) ? aborted.message : `${aborted.message}。`;
    if (waiting) text += `還有 ${waiting} 支沒下載，仍在清單裡；處理好後再按「開始全部下載」。`;
  }
  setText(node, text);
  setHidden(node, !text);
}

// The local program and the extension are different versions: said where it is seen (top of the panel / of the page), not
// only inside the collapsed update section. A host that is too old has its own note (renderHostNote), so this one waits.
export function renderVersionNote(node, { extensionVersion, hostVersion, updateAvailable = false, hostOutdated = false }) {
  const text = hostOutdated ? null : hostVersionNotice({ extensionVersion, hostVersion, updateAvailable });
  setText(node, text ?? "");
  setHidden(node, !text);
}

// 「加入」: every pasted url goes to the extension; the ones it rejected stay in the box and the returned note says why
// (empty when all were added). `box` is the input element, `send` the message call of the page.
export async function addPastedUrls(box, send) {
  const typed = box.value;
  const urls = typed.split(/\s+/).filter(Boolean);
  if (!urls.length) return "";
  const outcomes = [];
  for (const url of urls) {
    try {
      const result = await send({ type: "queue_add", url });
      outcomes.push({ url, ok: Boolean(result?.ok), error: result?.error ?? "無法加入" });
    } catch (error) {
      outcomes.push({ url, ok: false, error: error.message || "無法加入" });
    }
  }
  const { remaining, note } = summarizeAdd(outcomes);
  // someone typing while this ran keeps their new text (the urls sent above are not new); what was rejected goes after it
  const sent = new Set(urls);
  const typedMeanwhile = box.value === typed ? "" : box.value.split(/\s+/).filter((token) => token && !sent.has(token)).join("\n");
  box.value = [typedMeanwhile, remaining].filter(Boolean).join("\n");
  return note;
}

// A number box for a setting (`key` in SETTING_RANGES). A box that was cleared or filled with something that is not a
// number goes back to the value in use (`current()`), and the box shows what was really kept, not what was typed.
export function bindNumberSetting(input, key, { send, current }) {
  input.addEventListener("change", () => {
    const value = parseBoundedInt(input.value, { ...SETTING_RANGES[key], fallback: current() ?? DEFAULT_SETTINGS[key] });
    input.value = String(value);
    send({ type: "settings_set", settings: { [key]: value } });
  });
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
  }
  if (state !== "busy") {
    target._flash = setTimeout(() => {
      delete target.dataset.state;
      if (line) {
        line.textContent = "";
        delete line.dataset.state;
      }
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

// Where a saved cover went. Not next to the video when the host is away, or when the output folder was changed after
// the video was written (the host would put the cover into the new folder, away from it).
export function coverResultText(result) {
  if (result.where === "folder") return "已存到影片資料夾";
  if (result.folderChanged) return "影片在原來的資料夾，封面先存到下載資料夾（存放資料夾後來改過；改回去再按一次，就會存到影片旁）";
  return "已存到下載資料夾（連線小程式後可存到影片資料夾）";
}

export function downloadRowCover(send, uid, target) {
  flash(target, "busy", "下載中…");
  send({ type: "queue_download_cover", uid }).then((result) => {
    if (!result?.ok) return flash(target, "err", result?.error ?? "下載失敗");
    return flash(target, "ok", coverResultText(result));
  }, (error) => flash(target, "err", error.message || "下載失敗"));
}
