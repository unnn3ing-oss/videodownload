// 「複製診斷資訊」: the host writes a plain-text report (versions, the environment check, recent log lines, with the user name
// hidden); the person copies it and sends it to whoever maintains this. Used by the side panel and the web page.
export const COPIED_TEXT = "已複製，貼給維護的人就好";
export const DIAGNOSTICS_PRIVACY_NOTE = "內容已隱藏使用者名稱，只含版本、檢查結果與近期紀錄";
export const NOT_CONNECTED_TEXT = "下載助手還沒連線，沒辦法產生診斷資訊。請先讓它連線（按「啟動」），連不上就重新執行安裝檔。";
const FAILED_TEXT = "沒有取得診斷資訊，請再試一次";
const MANUAL_TEXT = "沒辦法自動複製。請在下面的方框按全選（Ctrl+A，Mac 是 Cmd+A），再複製（Ctrl+C，Mac 是 Cmd+C），貼給維護的人就好";

// The host's answer to {type:"diagnostics"}, as the background script hands it on: { ok, text } or { ok:false, error }.
export function diagnosticsReply(event) {
  if (event?.type === "diagnostics" && typeof event.text === "string" && event.text !== "") return { ok: true, text: event.text };
  if (event?.type === "error") {
    if (event.code === "unknown_type") return { ok: false, error: "下載助手的版本太舊，還不能產生診斷資訊。請重新執行安裝檔把它更新。" };
    return { ok: false, error: event.message || FAILED_TEXT };
  }
  return { ok: false, error: FAILED_TEXT };
}

// send: asks the background script ({ ok, text } | { ok:false, error }); writeText: the clipboard. Never throws:
// { state: "copied" | "manual" | "error", message, text? } ("manual": the clipboard refused, so `text` is to be selected by hand).
export async function copyDiagnostics({ send, writeText }) {
  let text;
  try {
    const result = await send({ type: "diagnostics" });
    if (!result?.ok || typeof result.text !== "string") return { state: "error", message: result?.error || FAILED_TEXT };
    text = result.text;
  } catch (error) {
    return { state: "error", message: error?.message || FAILED_TEXT };
  }
  try {
    await writeText(text);
    return { state: "copied", message: COPIED_TEXT };
  } catch {
    return { state: "manual", message: MANUAL_TEXT, text };
  }
}
