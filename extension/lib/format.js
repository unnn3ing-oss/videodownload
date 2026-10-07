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

// A wait ("4 秒", "1 分 30 秒"): the host may ask for up to two minutes between videos.
export function formatWait(seconds) {
  if (!Number.isFinite(seconds)) return "";
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return `${s} 秒`;
  const rest = s % 60;
  return rest ? `${Math.floor(s / 60)} 分 ${rest} 秒` : `${s / 60} 分鐘`;
}

// A number typed into a settings box. Nothing usable (empty, blank, letters) keeps `fallback`, the value in use, so a
// cleared box is not read as 0 and dropped to the minimum; a real number is rounded and held between min and max.
export function parseBoundedInt(raw, { min, max, fallback }) {
  const text = typeof raw === "string" ? raw.trim() : raw;
  const value = (typeof text === "number" || (typeof text === "string" && text !== "")) ? Number(text) : NaN;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}
