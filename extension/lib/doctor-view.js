// The environment check ("check the environment" / "try to repair"): what runs, what does not, and what to do about it.
// Used by the side panel and by the web page. Everything that comes from the host is set with textContent.
import { copyDiagnostics } from "./diagnostics.js";

const MARKS = { ok: "✔", warn: "⚠", error: "✘" };

export function summarizeChecks(checks) {
  if (!Array.isArray(checks) || !checks.length) return { errors: 0, warns: 0, text: "沒有檢查結果" };
  const errors = checks.filter((c) => c.status === "error").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  if (!errors && !warns) return { errors, warns, text: "全部正常" };
  const parts = [];
  if (errors) parts.push(`有 ${errors} 項需要處理`);
  if (warns) parts.push(`${errors ? "另有" : "有"} ${warns} 項提醒`);
  const tail = errors ? "。照每項下面的建議做；仍無法解決時，重新執行安裝檔會自動檢查並修復。" : "（不影響使用）";
  return { errors, warns, text: parts.join("，") + tail };
}

export const needsAttention = (checks) => Array.isArray(checks) && checks.some((c) => c.status !== "ok");

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function line(check) {
  const item = element("li");
  item.dataset.status = check.status;
  const body = element("div", "dr-body");
  body.append(element("b", "", String(check.title ?? "")));
  if (check.status !== "ok" && check.detail) body.append(element("small", "", String(check.detail)));
  if (check.status !== "ok" && check.fix) body.append(element("em", "", `→ ${check.fix}`));
  item.append(element("span", "dr-mark", MARKS[check.status] ?? "?"), body);
  return item;
}

export function renderChecks(list, checks) {
  list.replaceChildren(...checks.map(line));
}

// ui: { check, fix, list, summary, fixed } (the buttons and the three places the answer is written to)
export async function runDoctor(send, ui, fix = false) {
  ui.check.disabled = true;
  ui.fix.disabled = true;
  ui.summary.textContent = fix ? "修復並重新檢查中…" : "檢查中…";
  ui.fixed.textContent = "";
  try {
    const result = await send({ type: "doctor", fix });
    if (!result?.ok) throw new Error(result?.error ?? "檢查失敗");
    const checks = Array.isArray(result.checks) ? result.checks : [];
    renderChecks(ui.list, checks);
    ui.summary.textContent = summarizeChecks(checks).text;
    ui.fix.hidden = !needsAttention(checks);
    if (fix) ui.fixed.textContent = result.fixed?.length ? `已執行：${result.fixed.join("；")}` : "沒有可以自動修復的項目";
  } catch (error) {
    ui.list.replaceChildren();
    ui.fix.hidden = true;
    ui.summary.textContent = error.message || "檢查失敗";
  } finally {
    ui.check.disabled = false;
    ui.fix.disabled = false;
  }
}

// 「複製診斷資訊」. ui: { button, status, fallback } (the button, the line that says what happened, and a read-only text box
// that only appears when the clipboard refused, so the person can select the text and copy it by hand)
export async function runCopyDiagnostics(send, ui) {
  ui.button.disabled = true;
  ui.fallback.hidden = true;
  ui.status.dataset.kind = "info";
  ui.status.textContent = "產生中…";
  ui.status.hidden = false;
  const result = await copyDiagnostics({ send, writeText: (text) => navigator.clipboard.writeText(text) });
  ui.status.dataset.kind = result.state === "copied" ? "ok" : "error";
  ui.status.textContent = result.message;
  if (result.state === "manual") {
    ui.fallback.value = result.text;
    ui.fallback.hidden = false;
    ui.fallback.focus();
    ui.fallback.select();
  }
  ui.button.disabled = false;
}
