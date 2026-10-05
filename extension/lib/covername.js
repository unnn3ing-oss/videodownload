// File name (without extension) for a video's cover. Same rule as host/covers.py cover_name;
// tests/fixtures/cover-names.json keeps the two in step.
const NAME_CHARS = 6;
const MAX_NAME = 200;
const ILLEGAL = /[\\/:*?"<>|\x00-\x1f]/g;
const RESERVED = new Set(["CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]);

function sanitize(name) {
  let cleaned = name.replace(ILLEGAL, "_");
  if (RESERVED.has(cleaned.split(".")[0].trim().toUpperCase())) cleaned = `_${cleaned}`;
  cleaned = Array.from(cleaned).slice(0, MAX_NAME).join("");
  return cleaned.replace(/[ .]+$/, "").replace(/^ +/, "");
}

export function coverName(title, id) {
  const kept = String(title ?? "").replace(/[\p{P}\p{S}\p{Z}\p{C}]/gu, "");
  return sanitize(Array.from(kept).slice(0, NAME_CHARS).join("") || id);
}
