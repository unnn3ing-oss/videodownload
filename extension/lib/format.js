export function formatEta(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return "";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function formatSpeed(bytesPerSecond) {
  return bytesPerSecond ? `${(bytesPerSecond / 1048576).toFixed(1)} MB/s` : "";
}

export function itemMeta(item) {
  switch (item.status) {
    case "preview": return "待下載";
    case "queued": return "排隊中";
    case "downloading": {
      const head = [item.percent == null ? "" : `${Math.round(item.percent)}%`, formatSpeed(item.speed)]
        .filter(Boolean).join(" ");
      const eta = formatEta(item.eta);
      return [head, eta && `剩餘 ${eta}`].filter(Boolean).join(" · ");
    }
    case "done": return `完成${item.height ? ` · ${item.height}p` : ""}`;
    case "skipped": return "已下載過，略過";
    case "failed": return item.reason ?? "失敗";
    default: return "";
  }
}
