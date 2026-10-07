// File name (without extension) for a video's cover. Same rule as host/covers.py cover_name;
// tests/fixtures/cover-names.json keeps the two in step.
const NAME_CHARS = 6;
const MAX_NAME = 200;
const ILLEGAL = /[\\/:*?"<>|\x00-\x1f]/g;
const RESERVED = new Set(["CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]);

function sanitize(name) {
  let cleaned = name.replace(ILLEGAL, "_").replace(/^[ .]+/, ""); // no hidden (".name") file
  if (RESERVED.has(cleaned.split(".")[0].trim().toUpperCase())) cleaned = `_${cleaned}`;
  cleaned = Array.from(cleaned).slice(0, MAX_NAME).join("");
  return cleaned.replace(/[ .]+$/, "");
}

export function coverName(title, id) {
  const kept = String(title ?? "").replace(/[\p{P}\p{S}\p{Z}\p{C}]/gu, "");
  return sanitize(Array.from(kept).slice(0, NAME_CHARS).join("") || id);
}

// The cover's name as it is saved: the short name above, but when a video listed before this one (`earlier`: rows with
// id and title) would get the very same name, " [id]" tells them apart, the way the host names colliding video files.
// Names that differ only in letter case count as the same: most disks do not tell them apart.
export function coverBaseName(title, id, earlier = []) {
  const plain = coverName(title, id);
  const key = plain.toLowerCase();
  const clash = earlier.some((other) => other.id && other.id !== id && coverName(other.title, other.id).toLowerCase() === key);
  return clash ? sanitize(`${plain} [${id}]`) : plain;
}
